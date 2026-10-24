// P39 / #75 AI优选战绩层 · 服务端生成与落库（db + 服务端模型通道）
//
// 复用 StrategyPick 一张表：本层只负责「把 AI优选那几只票 + T 日收盘 写进 source=ai_pick 的行」，
// 之后的回填（pickfill）/ 净值（战绩页）全部走现有管线，不另写。
//
// 两种进入方式（都落同一张表、同一层）：
//   ① 服务端自动优选：不传 picks，从当日 layer1 候选（gate/regime 已记具体票的行）里，
//      用 getServerLlm() 拿到的服务端模型通道收窄到 ≤N 只 → 解决「用户不手动用 AI优选也不会触发」。
//   ② 手动结构化结果：前端把已经收窄好的 picks 传进来（用户在对话里让 AI优选挑完、或点「计入战绩」），
//      直接落库，不让模型二次加工。
//
// 诚实边界（与全仓同一条纪律）：
//   - 服务端通道没配 → 如实说「未配置」，绝不造一份假优选；
//   - 当天没候选 → 如实说「无候选可优选」，不落空行；
//   - 模型没返回可解析清单 → 如实说「未解析出」，不拿默认顶替；
//   - 已回填过的行绝不重写（重跑不涨 = 不能造假）。
//
// 数据源：候选的 T 日收盘来自 layer1 行自带的 symbols.close；缺了再查本地粮仓 stock_daily_bar 补。

import "server-only";
import { db } from "../../db.ts";
import { shanghaiDate, shanghaiStamp } from "../../desk/session.ts";
import { parseSymbols, symJsonOf, type PickSym } from "./pick-fill-core.ts";
import {
  AI_PICK_SOURCE, AI_PICK_STRATEGY_ID, AI_PICK_MAX,
  applyHardFilter, buildAiPickSinglePrompt, parseAiPickVerdict, narrowChoices, type AiPickCandidate, type AiPickChoice, type AiPickVerdict,
} from "./ai-pick-core.ts";
import { appendAiPickVersion, type AiPickVersion } from "./ai-pick-versions.ts";
import type { ArchiveResult, ScanMode } from "../screener/persist.ts";
import { getServerLlm } from "../../llm/model-config.ts";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { fetchChinaStockValuation } from "../../desk/china-stock-mcp.ts";
import { fetchThsStockFunds, thsCodeFromSymbol } from "../../desk/ths-fund.ts";
import { fetchClsDayItems, type ClsDayItem } from "../../desk/cls-telegraph.ts";
import { fetchCninfoStockAnnouncements, reductionPlainLine, reductionRiskOf } from "../../desk/cninfo.ts";
import { fetchSectorMedianChangePct } from "../screener/main-vs-retail-divergence.ts";
import { buildMainVsRetailSection, type MainVsRetailInput } from "../screener/main-vs-retail-divergence-core.ts";
import { buildRiskTagSection, type RiskStamp, type RiskTagResult } from "./pick-risk-tags-core.ts";
import { appendRiskTagLedger, computePickRiskTags } from "./pick-risk-tags.ts";
import { buildStampSection, computePickStamps, type PickStampInfo } from "./pick-stamp.ts";
import { rpsSeedOf } from "../data/rps-seed.ts";

const ADJUST = "qfq";

/** 与 proxy 路由口径一致：base 填不填 /v1 都等价 */
function apiBase(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface ChatMsg { role: "system" | "user" | "assistant"; content: string }

/** 服务端非流式对话（复用模型通道的 baseUrl + key + model，不依赖 proxy 路由的 SSE 路径） */
async function callServerChat(
  channel: { baseUrl: string; apiKey: string; model: string },
  messages: ChatMsg[],
  ms: number,
): Promise<string> {
  const url = apiBase(channel.baseUrl) + "/v1/chat/completions";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const proxyUrl = (process.env.AI_PROXY_URL || "").trim();
  const isLan = /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(channel.baseUrl);
  const dispatcher: Dispatcher | undefined = proxyUrl && !isLan ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify({ model: channel.model, messages, temperature: 0.1, max_tokens: 6000 }),
      signal: ctrl.signal,
      dispatcher,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
    if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
    return json?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/** 某票某日收盘（qfq）：候选自带的 close 缺失时补查 */
async function closeOf(symbol: string, tradeDate: string): Promise<number | null> {
  try {
    const rows = await db.$queryRawUnsafe<{ close: number | null }[]>(
      `SELECT close FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = ? LIMIT 1`,
      symbol, tradeDate, ADJUST,
    );
    const c = rows[0]?.close;
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

/** 当日 layer1 候选（gate/regime 且已记具体票），去重成候选池，带 T 日收盘 + 入选策略 */
export async function gatherLayer1Candidates(tradeDate: string): Promise<AiPickCandidate[]> {
  const rows = await db.strategyPick.findMany({
    where: { tradeDate, source: { in: ["gate", "regime"] }, symbols: { not: null } },
    select: { symbols: true, strategyName: true },
  });
  const map = new Map<string, AiPickCandidate>();
  for (const r of rows) {
    for (const s of parseSymbols(r.symbols)) {
      const key = s.symbol.toUpperCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, { symbol: s.symbol, name: s.name || "", close: s.close ?? null, strategy: r.strategyName || null });
    }
  }
  return [...map.values()];
}

/**
 * 候选富化（2026-10-16：换手 + 新闻调试的根因修复）。
 * 根因：此前 gatherLayer1Candidates 只给 symbol/name/close/strategy，generateAiPickForDate
 * 直接把这份“裸候选”喂给 prompt——PE/PB/市值/主力/换手/新闻没有任何一步去取，
 * prompt 里写“没给就说未取到”只是把缺失合法化了，并没有真的喂。之前的“喂了 PE”是
 * 临时调试路由手写富化的，不在生产链路里。
 * 本函数是生产链路的唯一富化点（generateAiPickForDate 调用），来源全部真实：
 *   - 名称/板块：data/rps-seed-latest.json（rpsSeedOf；无记录留空，不编）
 *   - 涨跌/成交额/成交量：DB stock_daily_bar 当日行 + 前一交易日收盘
 *   - PE/PB/市值/流通股本：china-stock-mcp get_stock_value（日级真实缓存；缺失阻塞拉一次）
 *   - 换手率：当日成交量(股)/流通股本(股)×100；任一缺失 → null（不编 0）
 *   - 主力净额：仅当 tradeDate == 今天（上海日期）时拉同花顺 realhead（当日值即今天的值）；
 *     历史日不用 THS——THS 只给当前值，拿它当历史日的值是穿越，不冒充。
 *   - 新闻：财联社分页拉回 tradeDate 当天全天电报，按个股名/板块·概念关键词匹配原标题；
 *     拉取失败 → null（未取到）；拉到但无匹配 → ""（当日无相关新闻）。
 *     绝不拿其它日期的新闻当该日的（那是未来数据 / 穿越）。
 *   - 巨潮公告：CNINFO 按 tradeDate 当天拉回全天公告，按代码过滤 + 按类型分类
 *     （财报 / 业绩预告 / 回购 / 增持 / 减持 / 分红 / 合同 / 股东大会 / 股权激励 / 担保 / 质押 / 其他），
 *     按板块分类（sector-constituents.json，与日报板块分类一致）；
 *     拉取失败 → null（未取到）；拉到但无匹配 → ""（当日无相关公告）。
 *     绝不拿其它日期的公告当该日的（那是未来数据 / 穿越）。
 *     AI 优选可引用公告作为选股理由的证据，如“XX 发布回购公告 / 业绩预告”。
 */
export async function enrichAiPickCandidates(tradeDate: string, cands: AiPickCandidate[]): Promise<AiPickCandidate[]> {
  if (!cands.length) return cands;

  // --- DB：当日行 + 前一日收盘 ---
  let barMap = new Map<string, { close: number; volume: number; amount: number }>();
  let prevMap = new Map<string, number>();
  try {
    const inList = cands.map(() => "?").join(",");
    const rows = await db.$queryRawUnsafe<{ symbol: string; close: number; volume: number; amount: number }[]>(
      `SELECT symbol, close, volume, amount FROM stock_daily_bar WHERE tradeDate = ? AND adjust = ? AND symbol IN (${inList})`,
      tradeDate, ADJUST, ...cands.map((c) => c.symbol),
    );
    for (const r of rows) barMap.set(String(r.symbol).toUpperCase(), { close: Number(r.close), volume: Number(r.volume), amount: Number(r.amount) });
    const prevRows = await db.$queryRawUnsafe<{ symbol: string; close: number }[]>(
      `SELECT symbol, close FROM stock_daily_bar WHERE tradeDate = (SELECT MAX(tradeDate) FROM stock_daily_bar WHERE tradeDate < ?) AND adjust = ? AND symbol IN (${inList})`,
      tradeDate, ADJUST, ...cands.map((c) => c.symbol),
    );
    for (const r of prevRows) prevMap.set(String(r.symbol).toUpperCase(), Number(r.close));
  } catch {
    // DB 失败：barMap 为空，后续各字段保持 null，不编
  }

  // --- 估值：MCP（并发 5，避免 6.5s/只串行拖垮） ---
  const valMap = new Map<string, { pe: number; pb: number; mktCapYi: number; floatShares: number }>();
  {
    const queue = [...cands];
    const workers: Promise<void>[] = [];
    const CONC = 5;
    for (let w = 0; w < CONC; w++) {
      workers.push((async () => {
        while (queue.length) {
          const c = queue.shift();
          if (!c) break;
          try {
            const v = await fetchChinaStockValuation(c.symbol);
            if (v && v.floatShares != null && v.floatShares > 0) {
              valMap.set(c.symbol.toUpperCase(), { pe: v.pe, pb: v.pb, mktCapYi: v.marketCap / 1e8, floatShares: v.floatShares });
            }
          } catch {
            // 单只失败跳过，该只保持 null
          }
        }
      })());
    }
    await Promise.all(workers);
  }

  // --- 主力/大户/散户：仅当决策日 == 今天（上海日期）。
  // THS realhead 只给“当前”值，不是历史值。旧口径用“决策日 == DB 最新交易日”判——
  // 当日收盘价还没入库时 DB 最新日还是昨天，于是生成昨天 AI 优选时会拿今天的主力冒充
  // 昨天的主力（金徽酒 10-15 主力 -0.10亿 被今天的 +0.05亿冒充，背离规则永远触发不了）。
  // 修成“决策日 == 今天”才取 THS；历史日主力一律 null（未取到），不冒充。
  // 三边一起取（第 5 种分歧用）：主力 = 超大 + 大单，大户 = 中单，散户 = 小单。
  const fundMap = new Map<string, { main: number; sup: number; mid: number; small: number }>();
  if (tradeDate === shanghaiDate()) {
    try {
      const codes = cands.map((c) => thsCodeFromSymbol(c.symbol)).filter((x): x is string => !!x);
      const funds = await fetchThsStockFunds(codes);
      // fetchThsStockFund 返回的 code 已去掉 hs_ 前缀（如 "600276"），映射键也要去前缀
      const codeToSym = new Map(cands.map((c) => [(thsCodeFromSymbol(c.symbol) ?? "").replace(/^hs_/, ""), c.symbol.toUpperCase()]));
      for (const f of funds) {
        const sym = codeToSym.get(String(f.code ?? ""));
        if (sym && typeof f.mainNetYi === "number" && Number.isFinite(f.mainNetYi)) {
          fundMap.set(sym, {
            main: f.mainNetYi,
            sup: f.superNetYi,
            mid: (f.midInRaw - f.midOutRaw) / 1e8,
            small: f.smallNetYi,
          });
        }
      }
    } catch {
      // THS 失败：保持 null
    }
  }

  // --- 板块中位涨跌：同第一级板块所有票当日涨跌幅的中位（第 5 种分歧用） ---
  const sectorMedMap = await fetchSectorMedianChangePct(
    tradeDate,
    cands.map((c) => (c.sector || rpsSeedOf(c.symbol)?.sector || null)),
  );

  // --- 新闻：财联社分页拉回 tradeDate 当天 ---
  let dayNews: ClsDayItem[] | null = null;
  try {
    dayNews = await fetchClsDayItems(tradeDate);
  } catch {
    dayNews = null; // 拉取失败 → 每只 news = null（未取到），不拿空数组冒充“无新闻”
  }

  // --- 巨潮公告：CNINFO 按 tradeDate 当天拉回，按代码过滤 ---
  // 失败 → 每只 announcements = null（未取到）；成功但无匹配 → ""（当日无相关公告）
  // 减持风险：同批公告里 type=减持 的，按标题口径解析（谁在减 / 计划还是结果 / 标题带比例），
  // 失败 → 每只 reductionRisk = null（未取到）；成功但无减持 → ""（当日无减持公告）。
  let annMap: Map<string, { lines: string }> | null = null;
  let redMap: Map<string, string> | null = null;
  try {
    const raw = await fetchCninfoStockAnnouncements(cands.map((c) => c.symbol), tradeDate);
    annMap = new Map();
    redMap = new Map();
    for (const [code, anns] of raw) {
      const lines = anns.map((a) => `${a.type}：${a.title}`).join("；");
      annMap.set(code, { lines });
      const reds = anns.map((a) => reductionRiskOf(a)).filter((r): r is NonNullable<typeof r> => !!r);
      redMap.set(code, reds.map((r) => reductionPlainLine(r)).join("；"));
    }
  } catch {
    annMap = null;
    redMap = null;
  }

  return cands.map((c) => {
    const key = c.symbol.toUpperCase();
    const seed = rpsSeedOf(c.symbol);
    const name = c.name || seed?.name || "";
    const sector = c.sector || seed?.sector || null;
    const bar = barMap.get(key);
    const prevClose = prevMap.get(key);
    const close = typeof c.close === "number" && Number.isFinite(c.close) ? c.close : bar?.close ?? null;
    const changePct = close != null && prevClose != null && prevClose !== 0 ? ((close - prevClose) / Math.abs(prevClose)) * 100 : null;
    const amountYi = bar ? bar.amount / 1e8 : null;
    const val = valMap.get(key);
    const turnoverPct = bar && val && bar.volume > 0 ? (bar.volume / val.floatShares) * 100 : null;
    const news = dayNews == null ? null : matchNewsFor(name, sector, seed?.concept, dayNews);
    const fund = fundMap.get(key);
    const sectorFull = c.sector || seed?.sector || null;
    const sectorName = sectorFull ? sectorFull.split(/[-|]/)[0]?.trim() || null : null;
    const annKey = key.replace(/\.(SH|SZ|BJ)$/i, "");
    const announcements = annMap == null ? null : (annMap.get(annKey)?.lines ?? "");
    const reductionRisk = redMap == null ? null : (redMap.get(annKey) ?? "");
    return {
      ...c,
      name,
      sector,
      sectorName,
      sectorMedianChangePct: sectorName ? (sectorMedMap.get(sectorName) ?? null) : null,
      close,
      changePct,
      amountYi,
      pe: val?.pe ?? null,
      pb: val?.pb ?? null,
      mktCapYi: val?.mktCapYi ?? null,
      fundNetYi: fund ? fund.main : null,
      superNetYi: fund ? fund.sup : null,
      midNetYi: fund ? fund.mid : null,
      smallNetYi: fund ? fund.small : null,
      turnoverPct,
      news,
      announcements,
      reductionRisk,
    };
  });
}

/** 按个股名 / 板块·概念关键词匹配当日财联社电报原标题。无匹配返回 ""（当日无相关新闻）。
 * 只匹配标题，不匹配正文：正文是长文/公告汇总，里面提一句关键词（如“公告全知道”汇总、
 * “竞价看龙头”栏目）就会误判成该股/该板块的新闻。标题命中才是真的相关。
 * 关键词口径（防误判，不用两字简称截取）：
 *   - 板块段用全称（动力煤/化学制药/基础化工），不截前两字——截“动力”会命中“核动力潜艇”，
 *     截“基础”会命中“基础设施”，截“化学”会命中“华峰化学”；
 *   - 仅申万一级有公认两字简称的才加别名：医药生物→医药、基础化工→化工、建筑材料→建材；
 *   - 裸“电子”太泛（电子商务/电子签名都含它），跳过，用 元件/印制电路板/PCB概念/汽车电子；
 *   - 概念词去掉泛词（国企改革/创投/老字号/数字经济/互联网金融/人工智能/华为概念等），
 *     泛词命中≠相关。 */
function matchNewsFor(name: string, sector: string | null | undefined, concept: string | null | undefined, items: ClsDayItem[]): string {
  const stockHits: string[] = [];
  const sectorHits: string[] = [];
  const keywords = new Set<string>();
  const SECTOR_ALIAS: Record<string, string> = { "医药生物": "医药", "基础化工": "化工", "建筑材料": "建材" };
  const GENERIC_CONCEPT = new Set([
    "高股息精选", "超级品牌", "证金持股", "MSCI中国", "富时罗素",
    "国企改革", "创投", "老字号", "数字经济", "互联网金融", "消费金融",
    "绿色电力", "养老概念", "海峡两岸", "人工智能", "华为概念", "鸿蒙概念",
    "DeepSeek概念", "AIGC概念", "虚拟数字人", "抖音小店", "共同富裕示范区",
    "长三角一体化", "西部大开发", "三胎概念", "网红经济", "无线耳机",
    "人民币贬值受益", "参股民营银行", "小额贷款", "医药电商", "猴痘概念",
    "保健品", "快递", "智能医疗", "足球概念", "拼多多概念",
  ]);
  if (sector) {
    for (const segRaw of sector.split(/[-|]/)) {
      const seg = segRaw.trim().replace(/[ⅠⅡⅢⅣ]+$/g, "");
      if (seg.length < 2 || seg === "电子") continue;
      keywords.add(seg);
      const alias = SECTOR_ALIAS[seg];
      if (alias) keywords.add(alias);
    }
  }
  if (concept) {
    for (const term of concept.split(/[,，、]/)) {
      const t = term.trim().replace(/概念$/, "");
      if (t.length >= 2 && !GENERIC_CONCEPT.has(term.trim()) && !GENERIC_CONCEPT.has(t)) keywords.add(t);
    }
  }
  for (const it of items) {
    const title = it.title;
    if (name && name.length >= 2 && title.includes(name)) {
      if (stockHits.length < 2) stockHits.push(`个股新闻：${title}（${it.time}）`);
      continue;
    }
    if (sectorHits.length < 1) {
      for (const kw of keywords) {
        if (title.includes(kw)) {
          sectorHits.push(`板块新闻：${title}（${it.time}）`);
          break;
        }
      }
    }
    if (stockHits.length >= 2 && sectorHits.length >= 1) break;
  }
  return [...stockHits, ...sectorHits].join("；");
}

function emptyResult(tradeDate: string, missing: string[], source: string, mode: ScanMode = "full"): ArchiveResult<never> {
  return {
    as_of: shanghaiDate(),
    trade_date: tradeDate,
    missing,
    scanned: 0,
    results: 0,
    items: [],
    unmatched: null,
    source,
    mode,
    delta: { scanned: 0, inserted: 0, updated: 0, unchanged: 0, skippedByCursor: 0, superseded: 0, kept: 0, collapsed: 0 },
  };
}

/** 解析 / 落库共用的写库：已回填过的行不重写；否则按 (tradeDate,strategyId,source) 唯一键 upsert */
async function persistAiPick(tradeDate: string, syms: PickSym[], note: string, basis: string): Promise<{ inserted: number; updated: boolean; keptBackfilled: boolean }> {
  const existing = await db.strategyPick.findFirst({
    where: { tradeDate, strategyId: AI_PICK_STRATEGY_ID, source: AI_PICK_SOURCE },
    select: { id: true, symBackfilledAt: true, symbolsNote: true },
  });
  if (existing?.symBackfilledAt) {
    // 已经回填过：重跑会改动「已经走完的成绩」= 可以造假，直接保留
    return { inserted: 0, updated: false, keptBackfilled: true };
  }
  // 保留旧行的【当日情绪】（重跑不丢情绪标注；2026-10-16 修复）。
  // 注意：【优选来源】不从旧行沿用——旧来源对应旧一批票，重跑换票后沿用就是 stale
  // （10-16 曾出现旧 3 只卡 + 新 5 只卡同时堆在 note 里的重复）；新来源由调用方在 note 里带。
  // 旧【参考模板版】卡也不沿用（新 note 带新卡）。提取只到【优选来源】/【参考模板版】为止，不吞到文末。
  let mergedNote = note;
  const oldNote = existing?.symbolsNote || "";
  const emotionMatch = oldNote.match(/【当日情绪】[\s\S]*?(?=【优选来源】|【参考模板版】|$)/);
  const prefix = emotionMatch?.[0]?.trim() ?? "";
  if (prefix && !mergedNote.includes("【当日情绪】")) mergedNote = `${prefix} ${mergedNote}`;
  const data = {
    tradeDate,
    strategyId: AI_PICK_STRATEGY_ID,
    strategyName: "AI优选",
    source: AI_PICK_SOURCE,
    symbols: symJsonOf(syms),
    symbolsNote: mergedNote,
    nextDaySymWin: null,
    symBackfilledAt: null,
  };
  if (existing) {
    await db.strategyPick.update({ where: { id: existing.id }, data });
    return { inserted: 0, updated: true, keptBackfilled: false };
  }
  await db.strategyPick.create({ data: { ...data, pickedAt: new Date() } });
  return { inserted: syms.length, updated: false, keptBackfilled: false };
}

async function resolveSyms(cands: AiPickCandidate[], tradeDate: string): Promise<PickSym[]> {
  return Promise.all(cands.map(async (c) => ({
    symbol: c.symbol,
    name: c.name || "",
    close: typeof c.close === "number" && Number.isFinite(c.close) ? c.close : (await closeOf(c.symbol, tradeDate)),
  })));
}

export interface GenerateAiPickOptions {
  /** 显式候选池（不传 = 取当日 layer1）；用于「把某份冻结池交给 AI优选战绩」 */
  candidates?: AiPickCandidate[];
  /** 已经收窄好的结果（手动计入战绩），直接落库，不让模型二次加工 */
  picks?: PickSym[];
  /** 收窄上限（默认 AI_PICK_MAX） */
  topN?: number;
  /** 上游超时（默认 120s） */
  timeoutMs?: number;
  /** 当日大盘情绪上下文（喂给模型，不用再猜；如“弱势，压力分 55.2…”） */
  marketCtx?: string;
}

/** 版本追加包装：版本文件写失败不阻塞主流程（版本是账本，主流程是战绩落库）。
 * riskTags 透传（风险观察标签，只标注；手动计入不传 → 不写这个字段）。
 * stamp/stampReasons 透传（排雷盖章，只标注不拦截；没算出 → 不写字段）。 */
async function appendVersionSafe(
  tradeDate: string,
  picks: { symbol: string; name: string; changePct: number | null; riskTags?: string[]; stamp?: RiskStamp; stampReasons?: string[] }[],
  source: string,
): Promise<void> {
  const version: AiPickVersion = {
    tradeDate,
    runAt: shanghaiStamp(new Date()),
    picks: picks.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      changePct: p.changePct,
      ...(p.riskTags && p.riskTags.length ? { riskTags: p.riskTags } : {}),
      ...(p.stamp ? { stamp: p.stamp, stampReasons: p.stampReasons ?? [] } : {}),
    })),
    source,
  };
  await appendAiPickVersion(version);
}

/** 某票某日之前的最近一个交易日收盘价（DB 日K）；找不到 → null */
async function prevCloseOf(symbol: string, tradeDate: string): Promise<number | null> {
  try {
    const rows = await db.$queryRawUnsafe<{ close: number | null }[]>(
      `SELECT close FROM stock_daily_bar WHERE symbol = ? AND tradeDate < ? AND adjust = ? ORDER BY tradeDate DESC LIMIT 1`,
      symbol, tradeDate, ADJUST,
    );
    const c = rows[0]?.close;
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

/** 手动计入的版本票：涨跌幅 = (close - 前一交易日收盘) / 前一交易日收盘；算不出为 null */
async function manualVersionPicks(
  tradeDate: string,
  picks: PickSym[],
): Promise<{ symbol: string; name: string; changePct: number | null }[]> {
  return Promise.all(picks.map(async (p) => {
    const prev = await prevCloseOf(p.symbol, tradeDate);
    const changePct = typeof p.close === "number" && Number.isFinite(p.close) && prev != null && prev !== 0
      ? ((p.close - prev) / Math.abs(prev)) * 100
      : null;
    return { symbol: p.symbol, name: p.name || "", changePct };
  }));
}

/** 有限并发 map（逐只评估用：网关在用户电脑上，并发压太高反而互相拖慢，3 路实测稳妥） */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 逐只评估全部候选（2026-10-23）：一只一调 callServerChat，单调超时沿用 opts.timeoutMs（默认 120s，
 * 单只 prompt + 单张决策卡远低于此线）。任何一只失败/没解析出 → 该只记 evalError，不连累整批。
 */
async function evaluateCandidatesIndividually(
  channel: { baseUrl: string; apiKey: string; model: string },
  cands: readonly AiPickCandidate[],
  tradeDate: string,
  opts: GenerateAiPickOptions,
): Promise<AiPickVerdict[]> {
  return mapWithConcurrency(cands, 3, async (c): Promise<AiPickVerdict> => {
    try {
      const text = await callServerChat(
        channel,
        [{ role: "system", content: "你是 A 股量化工作台的 AI优选环节，只输出 JSON，绝不解释。" }, { role: "user", content: buildAiPickSinglePrompt(c, tradeDate, opts.marketCtx) }],
        opts.timeoutMs ?? 120_000,
      );
      const v = parseAiPickVerdict(text);
      if (!v) return { symbol: c.symbol, selected: false, evalError: "模型返回未解析出裁决 JSON" };
      return { ...v, symbol: c.symbol };
    } catch (e) {
      return { symbol: c.symbol, selected: false, evalError: `调用服务端模型通道失败：${(e as Error).message}` };
    }
  });
}

/**
 * 生成某日的 AI优选战绩层并落库。返回 ArchiveResult 供接口 / 调度器记账（成功/跳过都如实写 missing）。
 * 不抛异常：任何一步走不通都收成「跑了但没落库」的 ArchiveResult，调度器据此记 success + 原因，不谎称失败。
 */
export async function generateAiPickForDate(
  tradeDate: string,
  opts: GenerateAiPickOptions = {},
): Promise<ArchiveResult<never>> {
  const topN = Math.max(1, Math.min(opts.topN ?? AI_PICK_MAX, AI_PICK_MAX));

  // ② 手动结构化结果：直接落库
  if (opts.picks && opts.picks.length) {
    const r = await persistAiPick(tradeDate, opts.picks.slice(0, topN), `手动计入的 AI 优选（${opts.picks.length} 只）`, "前端传入的已收窄清单");
    if (r.keptBackfilled) return emptyResult(tradeDate, ["该日 AI优选已回填过，不重算（重跑会改动已走完的成绩）"], "手动计入");
    // 版本化：每次运行追加一版（绝不覆盖旧版）；手动计入的涨跌幅从 DB 日K现算
    await appendVersionSafe(tradeDate, await manualVersionPicks(tradeDate, opts.picks.slice(0, topN)), "manual").catch(() => {});
    return {
      ...emptyResult(tradeDate, [], r.updated ? "手动计入（覆盖未回填的旧行）" : "手动计入", "full"),
      results: opts.picks.length,
      delta: { ...emptyResult(tradeDate, [], "").delta, inserted: r.inserted, updated: r.updated ? 1 : 0 },
    };
  }

  // ① 服务端自动优选：先凑候选池，再富化（PE/换手/主力/新闻等证据必须在调模型前取到，
  // 否则 prompt 里只有代码+收盘价，模型只能编定性理由——这就是上次换手/新闻“未取到”的根因）
  const rawCands = opts.candidates && opts.candidates.length
    ? opts.candidates
    : await gatherLayer1Candidates(tradeDate);
  if (!rawCands.length) {
    return emptyResult(tradeDate, [`${tradeDate} 当日没有 layer1 候选（gate/regime 都没记具体票），无从优选`], "服务端自动优选");
  }
  const cands = await enrichAiPickCandidates(tradeDate, rawCands);

  // 确定性硬过滤（代码层，第一道）：调模型前先拦掉派发嫌疑 / 背离票，不进模型；
  // narrowChoices 里还有第二道（防模型无视提示词硬选）。被拦的进 note 的【硬过滤弃选】。
  const { kept: filteredCands, rejected: hardRejected } = applyHardFilter(cands);
  if (!filteredCands.length) {
    return emptyResult(tradeDate, [
      `硬过滤后无候选（${cands.length} 只全被拦）：${hardRejected.map((x) => `${x.symbol}${x.reason}`).join("；")}`,
    ], "服务端自动优选（硬过滤）");
  }

  const llm = getServerLlm();
  if (!llm.available) {
    return emptyResult(tradeDate, [`未配置服务端模型通道（${llm.reason}），无法自动跑 AI优选；在「设置 → AI 接口」或 .env 配好 LLM_* 后重启即自动生成`], "服务端自动优选（未配置通道）");
  }

  // ③ 逐只评估（2026-10-23 用户拍板）：整池一次喂的 prompt 太长，flash 经网关生成必撞
  // 调用侧 120s 硬超时（10-23 批 cron 2 次 + 补跑 1 次三连败，均为 This operation was aborted）。
  // 改为一只一调：每调只装一只的证据 + 输出一张决策卡，单调远低于超时线；模型按统一标尺
  // 给分 + 入选判定，代码按分从高到低排序后走 narrowChoices 收窄（硬过滤第二道仍在）。
  // 单只失败只丢那一只并记 evalError；全部失败才按通道异常收尾，绝不拿默认值冒充成绩。
  const verdicts = await evaluateCandidatesIndividually(llm.channel, filteredCands, tradeDate, opts);
  const evalFailed = verdicts.filter((v) => v.evalError);
  if (evalFailed.length === filteredCands.length) {
    return emptyResult(tradeDate, [`调用服务端模型通道失败：${evalFailed[0]?.evalError ?? "全部候选评估失败"}`], "服务端自动优选（模型通道异常）");
  }
  const verdictBySymbol = new Map(verdicts.map((v) => [v.symbol.toUpperCase(), v]));
  const choices: AiPickChoice[] = verdicts
    .filter((v) => v.selected && v.choice)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((v, i) => ({
      ...v.choice!,
      symbol: v.symbol,
      rank: i + 1,
      rankReason: v.score != null ? `逐只评估 ${v.score} 分（统一标尺，60 分入选线）` : "逐只评估入选（未给分）",
    }));
  const picked = narrowChoices(choices, filteredCands, topN);
  if (!picked.length) {
    const judged = verdicts.length - evalFailed.length;
    return emptyResult(tradeDate, [
      `逐只评估后无入选：${filteredCands.length} 只候选里 ${judged} 只完成评估、无一只达入选线（score>=60）${evalFailed.length ? `，另 ${evalFailed.length} 只评估失败` : ""}，不落空行`,
    ], "服务端自动优选（逐只评估无入选）", "full");
  }

  const syms = await resolveSyms(picked, tradeDate);
  // 2026-10-16：模型给的逐只理由此前在 persist 时丢了（symJsonOf 只存 symbol/name/close），
  // 台账里看不到“为什么选它”。改成把理由拼进 note 一起落库（symbols JSON 形状不动，不影响 pickfill）。
  // 没理由的只写代码（模型没给就不编）。
  // 优选来源用本次新票新鲜生成（persist 不再沿用旧来源，避免重跑换票后来源 stale）。
  const sourceLine = `【优选来源】${picked.map((p) => `${p.symbol} ${p.name || ""}←${p.strategy || "?"}`).join("；")}`;
  const reasonLines = picked
    .map((p) => `${p.symbol}${p.reason ? `：${p.reason}` : ""}`)
    .join("；");
  // 第 5 种分歧：AI 优选之后，按每只优选票算（主力 vs 大户散户 + 板块对比），附在 note 最后。
  // 资金三边来自本次富化（决策日 == 最新交易日时才有 THS 值；历史日为 null，段里如实说没取到）。
  const divInputs: MainVsRetailInput[] = picked.map((p) => ({
    symbol: p.symbol,
    name: p.name || "",
    changePct: p.changePct ?? null,
    mainNetYi: p.fundNetYi ?? null,
    superNetYi: p.superNetYi ?? null,
    midNetYi: p.midNetYi ?? null,
    smallNetYi: p.smallNetYi ?? null,
    sectorName: p.sectorName ?? null,
    sectorMedianChangePct: p.sectorMedianChangePct ?? null,
  }));
  const divSection = buildMainVsRetailSection(divInputs);
  // 风险观察标签（2026-10-21 用户批准）：picked 定稿后逐只算，只标注、攒样本，
  // 绝不拦截 / 降权 / 改落库语义。整体取数失败 → 空段跳过，不阻塞主流程。
  let riskResults: RiskTagResult[] = [];
  try {
    riskResults = await computePickRiskTags(tradeDate, picked);
  } catch {
    riskResults = [];
  }
  const riskSection = riskResults.length ? buildRiskTagSection(riskResults) : "";
  // 排雷盖章（2026-10-24 用户指示：正式版从现在起加上排雷）：温度 + 位置 + 上面的风险标签
  // 逐只组装出章，只落版（版本文件 stamp 字段 + note【排雷盖章】段），绝不剔除 / 重排 /
  // 降权任何一只入选股。取数失败 → 空 Map 跳过，不阻塞主流程。
  let stampMap = new Map<string, PickStampInfo>();
  try {
    stampMap = await computePickStamps(tradeDate, picked, riskResults);
  } catch {
    stampMap = new Map();
  }
  const stampSection = stampMap.size ? buildStampSection(picked, stampMap) : "";
  // 逐只评估的分数与弃选原因一并进 note（20 天评审时能对账：入选的是不是分最高的、弃选理由站不站得住）
  const scoreLine = picked
    .map((p) => {
      const v = verdictBySymbol.get(p.symbol.toUpperCase());
      return v?.score != null ? `${p.symbol} ${v.score}分` : `${p.symbol} 入选（未给分）`;
    })
    .join("、");
  const modelRejected = verdicts.filter((v) => !v.selected && !v.evalError);
  const evalFailLine = evalFailed.length ? `【评估失败】${evalFailed.map((v) => `${v.symbol}：${v.evalError}`).join("；")}。` : "";
  const note = `${sourceLine} 【参考模板版·逐只评估】AI 逐只评估 ${filteredCands.length} 只候选（服务端模型 ${llm.channel.model} 一只一调、统一标尺打分、60 分入选线、按分排序收窄），优选出 ${picked.length} 只：${scoreLine}。按 docs/参考平台能力清单.md：5 字段入选理由/入场条件/仓位节奏/失效条件/主要风险 + 11 字段研究卡 + 七维框架。${hardRejected.length ? `【硬过滤弃选】${hardRejected.map((x) => `${x.symbol}${x.name ? `（${x.name}）` : ""}：${x.reason}`).join("；")}。` : ""}${modelRejected.length ? `【逐只评估弃选】${modelRejected.map((v) => `${v.symbol}：${v.rejectReason ?? "未达入选线"}`).join("；")}。` : ""}${evalFailLine}逐只决策卡：${reasonLines} ${divSection}${riskSection ? ` ${riskSection}` : ""}${stampSection ? ` ${stampSection}` : ""}`;
  const r = await persistAiPick(tradeDate, syms, note, `服务端模型通道 ${llm.channel.model} 逐只评估从 layer1 候选收窄`);
  if (r.keptBackfilled) return emptyResult(tradeDate, ["该日 AI优选已回填过，不重算"], "服务端自动优选");
  // 版本化：每次运行追加一版（绝不覆盖旧版）；riskTags 只写确认命中的标签名，没命中不写字段；
  // stamp/stampReasons 写盖章结果（pick 集合与顺序与接线前逐字一致，盖章不改选股）
  const tagBySymbol = new Map(riskResults.map((x) => [x.symbol.toUpperCase(), x.tags]));
  await appendVersionSafe(tradeDate, picked.map((p) => {
    const st = stampMap.get(p.symbol.toUpperCase());
    return { symbol: p.symbol, name: p.name || "", changePct: p.changePct ?? null, riskTags: tagBySymbol.get(p.symbol.toUpperCase()), stamp: st?.stamp, stampReasons: st?.reasons };
  }), "auto").catch(() => {});
  // 观察台账：命中逐条追加到 goal hidden_files 的 jsonl（写失败不阻塞主流程）
  if (riskResults.length) {
    await appendRiskTagLedger(tradeDate, riskResults, shanghaiStamp(new Date())).catch(() => {});
  }
  return {
    ...emptyResult(tradeDate, [], r.updated ? "服务端自动优选（覆盖未回填的旧行）" : "服务端自动优选", "full"),
    results: syms.length,
    delta: { ...emptyResult(tradeDate, [], "").delta, inserted: r.inserted, updated: r.updated ? 1 : 0 },
  };
}
