// P7-⑥① 对话工具层（服务层：只取数，不判定）。
//
// 为什么从 /api/ai/chat 的路由里搬出来：这一层要做的事情（拿真实行情、算指标、跑选股）
// 与「谁来问」无关。搬出来之后，工具调用环（/api/ai/chat）和自动调度（scene-dispatch）
// 用的是同一份实现——否则同一个「今天大盘情绪」在两条链路上可能算出两个数，那才是真事故。
//
// 数据纪律（沿用 P6-A/P7-④ 的口径，本层一条不放松）：
//  - 全部走真实接口（eltdx / 东财 / 腾讯 / 本机指标计算），没有任何演示值兜底；
//  - 取不到一律返回 {missing: 原因}，**不返回 0、不返回空数组冒充「没有符合的」**；
//  - 「取数失败」与「确实没这么长的历史」必须分开写，否则模型会把限流说成历史不足；
//  - 每个返回值自带 数据源 字段，前端与模型都能看到这条数据是从哪儿来的。
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { runScreener } from "@/lib/quant/screener/run";
// P10 择优轮：默认活跃池条件、条件中文读法、出身文案与五条择优纪律（一份定义多处消费，纯核零 IO）
// R11：池子行/条件读出人话化（poolRowZh/poolCondZh 只换读法，冻结原数据一字不动）
import { DEFAULT_PICK_CONDS, pickCondText, poolOriginText, PICK_DISCIPLINE, poolRowZh, poolCondZh } from "@/lib/quant/screener/pick-pool-core";
import { buildFieldPanel, lastValues, type BarsLike } from "@/lib/quant/factors/fields";
import { historicalWinProbability, type ScreenerCond } from "@/lib/quant/factors/probability";
import { getProvider } from "@/lib/quant/data/index";
// P13 门户轮：candidate_pool 工具直读冻结池（与本层其余工具同在服务端，不经 HTTP 自环）
import { db } from "@/lib/db";
import { fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import { tdxQuotes, tdxDepth, tdxTradesMoney } from "./tdx";
// R10 通达信开放给对话：走工作台 MCP 层的 stdio 通道（tdx-mcp 已在 data/mcp-config.json 登记、trusted），
// 本层只做「惰性拉起 + 解包成人话字段」，不自建第二个行情客户端。
import { callTool as mcpCallTool, listServers, startServer } from "./mcp-manager";
import { suffixOf } from "./intent-core";
import { fetchQuotesReal, fetchDetailReal, fetchNewsReal, symbolToSecid } from "./em";
// R20 主力净额第三档备胎（通达信逐笔自算）：东财/新浪都没通时顶上
import { mainNetSelfNote, tdxMainNetOf } from "./fund-flow";
// R10 扩容：个股新闻/公告 + 公司名解析（em.ts 在不动清单里，本模块内部复用它的 searchReal，不改它一行）
import { resolveStockName, fetchStockNews, fetchStockAnnouncements } from "./stock-news";
import { fetchBoardRowsRescued } from "./board-rescue";
import { shanghaiDate } from "./session";
import {
  BACKTEST_MIN_TRADING_DAYS, BACKTEST_POLL_INTERVAL_MS, TEXT_NOT_IN_WHITELIST, TEXT_POLL_TIMEOUT,
  TEXT_RANGE_TOO_SHORT, metricObject, pollAction, rangeVerdict, backtestReadout,
  resolveWhitelistFactors, whitelistOf, type RequestedFactor, type ResolvedFactor, type WhitelistRow,
} from "./backtest-core";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { listLatestFactors } from "@/lib/quant/store";
import { registerStrategyRunners, type BacktestPayload } from "@/lib/quant/jobs/runners/strategy-jobs";
import { getJob, startJob } from "@/lib/quant/jobs/registry";
import { experimentFingerprint } from "@/lib/quant/research/experiments";
// P35 稳智对齐：工具 → Agent Loop 阶段（phase_key）的真实归属。只引类型，不引运行时代码，
// 不新增依赖环（agent-phases-core 只 type-import chat-core）。
import type { PhaseKey } from "./agent-phases-core";

/** 一次工具调用能看到的请求级上下文（只有本机存档才有的东西走这里传，不查库） */
export interface ToolCtx {
  /** 用户本机自选清单（浏览器存档随请求带上；本层只负责给这些代码取真实行情） */
  watchlist?: { symbol: string; name?: string | null }[];
}

/**
 * 一次自选概览最多取多少只：清单来自浏览器存档，条数由用户自己堆。
 * 上限是为了不在一轮对话里并发打爆行情接口；超出部分不静默丢，结果里写明「只看了前 N 只」。
 */
export const WATCHLIST_MAX = 200;

/**
 * 工具入参的代码归一：只认 6 位（可带后缀），补后缀交回 intent-core 的唯一一份号段口径。
 * 原来这里自己抄了一份 `^(60|68|9)→SH` 先判，于是 92xxxx（北交所新代码段）被判成沪市，
 * 与 em-provider 的 BJ 判定对不上——同一个代码在两层各说一个交易所。
 */
export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) return `${s}.${suffixOf(s)}`;
  return null;
}

/**
 * R10 扩容：工具入参「代码或公司名」的统一入口。normalizeSymbol 只认代码形状，
 * 而用户说话用的是名字（「中国电影卖的怎么样」）——名字到这里、只有东财搜索精确命中才算代码，
 * 不中回 null 由工具体回 missing，绝不凭印象猜代码（纯层只猜形状，这层查了才算事实）。
 * 解析成功带回名字，调用方必须在返回值里自报「按公司简称解析」（出身如实）。
 */
async function resolveSymbolArg(raw: string): Promise<{ symbol: string; resolvedName: string | null; resolvedFrom: string; matchKind: "exact" | "prefix" | "suffix" } | null> {
  const s = (raw ?? "").trim();
  const direct = normalizeSymbol(s);
  if (direct) return { symbol: direct, resolvedName: null, resolvedFrom: s, matchKind: "exact" };
  const hit = await resolveStockName(s);
  return hit ? { symbol: hit.symbol, resolvedName: hit.name, resolvedFrom: s, matchKind: hit.matchKind } : null;
}

/** 名称解析自报行：只有真按名字解析过才出现，代码直查的返回不多余挂一行；前缀/砍尾缀命中要自报是怎么命中的（R10c） */
function resolvedNote(r: { resolvedName: string | null; resolvedFrom: string; matchKind: "exact" | "prefix" | "suffix" }): Record<string, string> {
  if (!r.resolvedName) return {};
  const text = r.matchKind === "exact"
    ? `按公司简称「${r.resolvedName}」经东财搜索解析（不是用户直接给的代码）`
    : r.matchKind === "prefix"
      ? `按简称「${r.resolvedFrom}」经东财搜索唯一命中全称「${r.resolvedName}」（不是用户直接给的代码；全称是搜索接口给的，不是联想的）`
      : `按「${r.resolvedFrom}」砍掉组织形式词尾缀后经东财搜索唯一命中「${r.resolvedName}」（不是用户直接给的代码；全称是搜索接口给的，不是联想的）`;
  return { 代码解析: text };
}

// P11 情绪温度：0-100 综合分（缺读数缩权、绝不把缺失当 0 分），工具与仪表盘消费同一份纯核
import { computeTemperature, temperatureSummary } from "@/lib/quant/screener/sentiment-temperature-core";

async function toolMarketSentiment(): Promise<unknown> {
  const s = await computeSentiment();
  // 温度按震荡行情（默认口径）算——页面三态切换是表达层的事，模型拿默认档就够说人话。
  // 分量明细带上：缺哪项、缩了谁的权，模型转述时才不至于把「缩权温度」讲成满分口径。
  const temp = computeTemperature({
    advancers: s.advancers, decliners: s.decliners, median_pct: s.median_pct,
    limit_up: s.limit_up, limit_down: s.limit_down, break_rate: s.break_rate,
    main_net_sum_yi: s.main_net_sum_yi, main_net_known: s.main_net_known,
  }, "range");
  return {
    trade_date: s.trade_date, live: s.live,
    情绪温度: temperatureSummary(temp),
    ...(temp.temperature !== null ? {
      温度分量: temp.components.map((c) => ({ 分量: c.label, 得分: c.score, 权重: c.effective_weight || `未计入（${c.missing_note}）` })),
    } : { 温度未计入原因: temp.missing }),
    涨跌: { 上涨: s.advancers, 下跌: s.decliners, 平盘: s.flat, 总数: s.total },
    涨停: s.limit_up, 跌停: s.limit_down,
    成交额亿: Math.round(s.amount_total_yi), 全A主力净额亿: Math.round(s.main_net_sum_yi),
    中位涨跌幅: s.median_pct,
    指数: s.indices,
    风险等级: s.risk.level, 风险触发: s.risk.triggers,
    missing: s.missing,
  };
}

async function toolSectorRank(args: { kind?: string; size?: number }): Promise<unknown> {
  const kind = args.kind === "concept" ? "concept" : "industry";
  // R8：断源日不再整块「暂无数据」——东财/腾讯拿不到资金读数时换同花顺净额榜，数据源行跟着换口径
  const { rows, fromThs } = await fetchBoardRowsRescued(kind, "in", Math.min(30, Math.max(5, args.size ?? 15)));
  if (!rows || !rows.length) return { missing: `${kind}板块资金榜暂无数据（东财接口失败，同花顺兜底亦无返回）` };
  return {
    数据源: fromThs
      ? "同花顺板块资金流榜（净额=流入−流出口径，非主力拆分口径）"
      : "东财板块资金榜（主力净流入排序）",
    板块: rows.map((r, i) => ({
      排名: i + 1, 名称: r.name, 涨跌幅: r.changePct,
      // 腾讯兜底榜行 main 是占位 0：报 null（缺读数），不拿 0.00 亿冒充「主力持平」；同花顺行是真净额，照常报
      主力净额亿: r.fundsMissing ? null : r.main,
      领涨股: r.leader,
    })),
  };
}

async function toolStockSnapshot(args: { symbol: string }): Promise<unknown> {
  const r = await resolveSymbolArg(args.symbol ?? "");
  if (!r) return { missing: `认不出这只股票：${args.symbol}（应为 688256 / 688256.SH 形态，或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate();
  const meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  const q = (await tdxQuotes([symbol]).catch(() => null))?.get(symbol)
    ?? ((await fetchQuotesReal([symbol]).catch(() => []))[0] ?? null);
  if (!q && !meta) return { missing: `${symbol} 快照暂无数据` };
  // R20：全 A 快照（腾讯批量）不带 mainNet，这一栏常年是 null。快照里没有就去通达信逐笔自算，
  // 算不出仍留 null——「净额为 0」和「没读到」是两件事，不补 0。
  const selfNet = meta?.mainNet == null
    ? await tdxMainNetOf(symbol, meta?.amount ?? null).catch(() => null)
    : null;
  return {
    symbol,
    ...resolvedNote(r),
    名称: meta?.name ?? null,
    现价: q?.price ?? meta?.price ?? null,
    涨跌幅: q?.changePct ?? meta?.changePct ?? null,
    成交额亿: q?.amountYi ?? (meta?.amount != null ? meta.amount / 1e8 : null),
    换手率: meta?.turnover ?? null, 量比: meta?.volumeRatio ?? null,
    市盈率TTM: meta?.pe ?? null, 市净率: meta?.pb ?? null,
    总市值亿: meta?.marketCap != null ? meta.marketCap / 1e8 : null,
    // R20：全 A 快照里 mainNet 常年为空（腾讯批量快照不带这个字段），这一栏就一直显示 null。
    // 现在兜一条通达信逐笔自算：能算出就给数并标注「自算」，算不出仍留 null（不补 0）。
    主力净额亿: meta?.mainNet != null ? meta.mainNet / 1e8 : selfNet?.mainNetYi ?? null,
    主力净额口径: meta?.mainNet != null ? "东财全A快照 f62" : selfNet ? mainNetSelfNote(selfNet) : null,
    行业: meta?.industry ?? null,
    数据源: "通达信网关/腾讯快照 + 东财榜单接口",
  };
}

async function toolStockDepth(args: { symbol: string }): Promise<unknown> {
  const r = await resolveSymbolArg(args.symbol ?? "");
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const d = (await tdxDepth([symbol]).catch(() => null))?.get(symbol);
  if (!d) return { missing: "五档盘口暂无数据（本机通达信行情网关未开启）" };
  const sum = (arr: { volume: number }[]) => arr.reduce((s, l) => s + l.volume, 0);
  return {
    symbol, ...resolvedNote(r), 数据源: "通达信网关 · 五档盘口",
    买五档: d.bids, 卖五档: d.asks,
    委买总量手: sum(d.bids), 委卖总量手: sum(d.asks),
    委买卖比: sum(d.asks) > 0 ? +(sum(d.bids) / sum(d.asks)).toFixed(2) : null,
    内盘手: d.insideHand, 外盘手: d.outerHand,
  };
}

async function toolStockTrades(args: { symbol: string }): Promise<unknown> {
  const r = await resolveSymbolArg(args.symbol ?? "");
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const t = await tdxTradesMoney(symbol).catch(() => null);
  if (!t) return { missing: "主动买卖数据暂无（本机通达信行情网关未开启）" };
  return {
    symbol, ...resolvedNote(r), 数据源: "通达信网关快照内外盘（全日累计，代理指标）",
    口径: t.basis,
    主动买入亿: +t.buyAmountYi.toFixed(2), 主动卖出亿: +t.sellAmountYi.toFixed(2),
    主动净额亿: +t.netYi.toFixed(2),
    外盘手: t.outerHand, 内盘手: t.insideHand, 成交均价: +t.avgPrice.toFixed(2),
  };
}

async function toolStockKline(args: { symbol: string }): Promise<unknown> {
  const r = await resolveSymbolArg(args.symbol ?? "");
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate();
  const meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  const barsRes = await fetchBarsHybridTracked([symbol], tradeDate, 480);
  const bars = (barsRes.bars.get(symbol) ?? []) as BarsLike[];
  if (!bars.length) {
    // 取数失败与「这只票确实没这么长历史」是两件事，工具返回值必须分开，否则模型会把限流说成「历史不足」
    const oc = barsRes.outcomes[0];
    return { missing: oc?.kind === "request_failed" ? `日K取数失败：${oc.reason}` : "日K无返回（这只股票没取到任何K线）" };
  }
  if (bars.length < 60) return { missing: `日K历史不足（仅 ${bars.length} 根，需 ≥60），无法计算技术状态` };
  const panel = buildFieldPanel([symbol], [bars], [meta]);
  const vals = lastValues(panel).get(symbol) ?? new Map();
  const pick = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, vals.get(k) ?? null]));
  const winProb = historicalWinProbability({
    symbol, bars, meta,
    conditions: [{ field: "above_ma_20", op: "=", value: 1 }, { field: "vwap20_filter", op: "=", value: 1 }],
  });
  return {
    symbol,
    ...resolvedNote(r),
    数据源: barsRes.outcomes[0]?.channel === "tdx"
      ? "通达信网关日K（本机直连）+ 本机指标计算（未验证因子）"
      : "腾讯日K（通达信网关未取到，本条为兜底口径）+ 本机指标计算（未验证因子）",
    最近5日: bars.slice(-5).map((b) => ({ 日期: b.date, 开: b.o, 高: b.h, 低: b.l, 收: b.c })),
    技术状态: pick("above_ma_5", "above_ma_10", "above_ma_20", "above_ma_60", "above_ma_144", "ma_struct",
      "macd", "macd_cross", "kdj_cross", "rsi_14", "vwap20_filter", "vwap_pos", "rps_50", "rps_120", "is_limit_up"),
    历史条件概率: winProb ? {
      条件: "站上MA20且站上20日成本线",
      统计: winProb.horizons.map((h) => ({ 持有日: h.h, 胜率: h.win_rate?.toFixed(0) + "%", 样本: h.sample_size })),
      统计区间: winProb.period, 样本是否充足: winProb.sample_ok, 提示: winProb.warnings,
    } : null,
  };
}

async function toolStockFundFlow(args: { symbol: string }): Promise<unknown> {
  const r = await resolveSymbolArg(args.symbol ?? "");
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const secid = symbolToSecid(symbol);
  const detail = secid ? await fetchDetailReal(secid).catch(() => null) : null;
  // R20 第三档：东财 + 新浪都没通时，用通达信当日逐笔自算一个主力净额顶上。
  // 自算只有当日、没有历史序列，所以「近 14 日」那一栏如实留空，不拿当日值去填历史。
  if (!detail) {
    const self = await tdxMainNetOf(symbol).catch(() => null);
    if (!self) return { missing: "主力资金流暂无数据（东财主力资金明细、新浪备胎、通达信逐笔自算三条源都没通）" };
    return {
      symbol,
      ...resolvedNote(r),
      数据源: "通达信当日逐笔自算（东财/新浪两条源都没通时的第三档）",
      口径说明: mainNetSelfNote(self),
      今日主力净额亿: self.mainNetYi,
      超大单净额亿: self.superBigYi,
      大单净额亿: self.bigYi,
      净占比: self.ratioPct,
      近14日: null,
      近14日说明: "自算只覆盖当日逐笔，历史序列无法自造（东财/新浪那两条源都没通）",
    };
  }
  return {
    symbol,
    ...resolvedNote(r),
    数据源: detail.source === "sina"
      ? "新浪资金流向日度净额（口径≈主力净流入，与通达信逐笔自算的主力净额不完全等价，转述时须注明是新浪口径）"
      : "东财主力资金日明细",
    今日主力净额亿: detail.days.at(-1)?.value ?? null,
    近14日: detail.days.map((d) => ({ 日期: d.date, 主力净额亿: d.value })),
  };
}

async function toolMarketNews(args: { limit?: number }): Promise<unknown> {
  const rows = await fetchNewsReal(Math.min(15, Math.max(5, args.limit ?? 10))).catch(() => null);
  if (!rows) return { missing: "宏观快讯暂无数据" };
  return { 数据源: "东财7x24/新浪快讯", 快讯: rows };
}

/**
 * R10 扩容（用户口径）：「除了技术还要结合新闻回答我」——谈个股必须有这只票自己的
 * 新闻（东财站内搜索按时间倒序）与公告（披露列表），宏观快讯替代不了。
 * 两条源全失败才回 missing；只挂一条另一条照出，失败与没消息在返回里分开写，
 * 模型不许把「断源」转述成「这只票没新闻」，也不许反过来。
 */
async function toolStockNews(args: { symbol?: string; limit?: number }): Promise<unknown> {
  const r = await resolveSymbolArg(String(args.symbol ?? ""));
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态，或东财搜索可命中的公司简称；不命中不猜代码）` };
  const code6 = r.symbol.slice(0, 6);
  const n = Math.min(10, Math.max(3, args.limit ?? 6));
  const [news, ann] = await Promise.all([
    fetchStockNews(r.resolvedName ?? code6, n),
    fetchStockAnnouncements(code6, n),
  ]);
  if (!news && !ann) {
    return { missing: `${r.symbol} 新闻与公告都没取到（东财搜索/披露接口均无响应）——这是取数失败，不是「这只票没有消息」` };
  }
  return {
    symbol: r.symbol,
    ...resolvedNote(r),
    数据源: "东财个股新闻搜索（按时间倒序）+ 东财公告披露列表",
    取数时刻: shanghaiDate(),
    ...(news
      ? {
          新闻: news.map((x) => ({ 标题: x.title, 时间: x.date, 媒体: x.media, 链接: x.url })),
          ...(news.length ? {} : { 新闻说明: "时间窗内没搜到相关报道（是没搜到，不是取数失败）" }),
        }
      : { 新闻: { missing: "个股新闻取数失败（搜索接口无响应），不代表这只票没有消息" } }),
    ...(ann
      ? {
          公告: ann.map((x) => ({ 标题: x.title, 时间: x.time, 栏目: x.column })),
          ...(ann.length ? {} : { 公告说明: "近期无披露记录（是没公告，不是取数失败）" }),
        }
      : { 公告: { missing: "公告取数失败（披露接口无响应），不代表这只票没公告" } }),
  };
}

// ---------- R10 通达信 MCP 工具（tdx-mcp：交易所直连的行情服务器快照口径） ----------
// 为什么单独一家：东财(push2)断源时腾讯/同花顺兜的是板块资金，个股盘口/五档这条
// eltdx 网关之外没有第二家；tdx-mcp 走的通达信行情服务器就是这一家。快照字段（server_time/盘口/现量）
// 都是服务器实时推送形态，盘后拿到的就是收盘定格——所以话术是「快照」，不吹「逐笔实时」。
// 边界（诚实口径）：symbol_zjlx（个股资金流向）上游有 bug（返回 dict 但输出声明 list，校验必炸），
// 不登记不冒充——资金口径仍然只认东财/同花顺那套。

/** 6 位代码 → 通达信市场号（1=沪 0=深 2=北）。先过 normalizeSymbol，认不出不回 market。 */
function tdxMarketOf(symbol: string): number {
  const code = symbol.slice(0, 6);
  if (/^(6|9|5)/.test(code)) return 1;
  if (/^(4|8)/.test(code)) return 2;
  return 0;
}

/** stdio 返回是 content:[{type:"text",text:"<json或错误串>"}...]——解包成对象数组 */
function unwrapMcpContent(res: unknown): Record<string, unknown>[] {
  const content = (res as { content?: { type?: string; text?: string }[] })?.content ?? [];
  const out: Record<string, unknown>[] = [];
  for (const c of content) {
    if (c?.type !== "text" || !c.text) continue;
    if (c.text.startsWith("Error executing tool")) { out.push({ _error: c.text.slice(0, 200) }); continue; }
    try {
      const p = JSON.parse(c.text);
      if (p && typeof p === "object") out.push(p as Record<string, unknown>);
    } catch { /* 非 JSON 文本块忽略 */ }
  }
  return out;
}

// 惰性拉起：模型第一次调 tdx_* 时若服务器还没起，就用登记配置现场 start（一次只放一个启动在途，
// 并行工具调用撞进来也不能互相 kill）。起不来就如实回 missing，不拿空数组冒充「没有数据」。
let tdxBooting: Promise<string | null> | null = null;
async function ensureTdxMcp(): Promise<string | null> {
  const probe = async (): Promise<string | null> => {
    const srv = listServers().find((s) => s.id === "tdx-mcp");
    if (!srv) return "通达信 MCP 未登记（设置 → MCP 服务器里没有 tdx-mcp）";
    if (srv.status === "ready") return null;
    if (!srv.config) return "通达信 MCP 缺配置，无法启动";
    try {
      await startServer(srv.config);
      return null;
    } catch (e) {
      return `通达信 MCP 启动失败：${(e as Error).message}`;
    }
  };
  tdxBooting ??= probe().finally(() => { tdxBooting = null; });
  return tdxBooting;
}

const INDEX_NAMES: Record<string, string> = {
  "999999": "上证指数", "399001": "深证成指", "399006": "创业板指", "000688": "科创50", "899050": "北证50",
};

async function toolTdxMarketOverview(): Promise<unknown> {
  const err = await ensureTdxMcp();
  if (err) return { missing: err };
  try {
    const res = await mcpCallTool("tdx-mcp", "get_index_overview", {});
    const rows = unwrapMcpContent(res);
    if (!rows.length) return { missing: "通达信指数概况无返回（行情服务器未响应）" };
    const pct = (n: number) => Math.round(n * 10000) / 100;
    return {
      数据源: "通达信行情服务器（tdx-mcp，快照口径；盘后为收盘定格）",
      指数: rows.map((r) => {
        const close = Number(r.close ?? 0);
        const pre = Number(r.pre_close ?? 0);
        return {
          指数: INDEX_NAMES[String(r.code ?? "")] ?? String(r.code ?? "?"),
          最新: close,
          昨收: pre,
          涨跌幅: pre ? `${pct((close - pre) / pre)}%` : "—",
          成交额亿: Math.round(Number(r.amount ?? 0) / 1e7) / 10,
          涨家数: r.up_count ?? null,
          跌家数: r.down_count ?? null,
        };
      }),
    };
  } catch (e) {
    return { missing: `通达信指数概况取数失败：${(e as Error).message}` };
  }
}

async function toolTdxQuotes(args: { symbols?: string[] }): Promise<unknown> {
  const raw = (args.symbols ?? []).slice(0, 20);
  const resolved = await Promise.all(raw.map((x) => resolveSymbolArg(String(x))));
  const symbols = resolved.map((x) => x?.symbol).filter((x): x is string => !!x);
  const dropped = raw.filter((_, i) => !resolved[i]);
  if (!symbols.length) return { missing: `没有可用的股票（收到 ${JSON.stringify(raw)}）：应为代码形态，或东财搜索可命中的公司简称` };
  const err = await ensureTdxMcp();
  if (err) return { missing: err };
  try {
    const res = await mcpCallTool("tdx-mcp", "stock_quotes", {
      code_list: symbols.map((s) => [tdxMarketOf(s), s.slice(0, 6)]),
    });
    const rows = unwrapMcpContent(res);
    const bad = rows.find((r) => r._error);
    if (bad) return { missing: `通达信行情取数失败（上游工具报错）：${String(bad._error).slice(0, 120)}` };
    if (!rows.length) return { missing: "通达信行情无返回（行情服务器未响应）" };
    const pct = (n: number) => Math.round(n * 10000) / 100;
    return {
      数据源: "通达信行情服务器（tdx-mcp，快照口径，含盘口；与东财快照并报时各报各的出身，不混算）",
      ...(dropped.length ? { 未识别提示: `${dropped.length} 只既不是代码也没被东财搜索命中，本轮未取数：${dropped.join("、")}` } : {}),
      行情: rows.map((r) => {
        const close = Number(r.close ?? 0);
        const pre = Number(r.pre_close ?? 0);
        const hc = (r.handicap ?? {}) as { bid?: { price: number; vol: number }[]; ask?: { price: number; vol: number }[] };
        return {
          代码: String(r.code ?? ""),
          现价: close,
          昨收: pre,
          今开: r.open ?? null,
          最高: r.high ?? null,
          最低: r.low ?? null,
          涨跌幅: pre ? `${pct((close - pre) / pre)}%` : "—",
          成交额亿: Math.round(Number(r.amount ?? 0) / 1e7) / 10,
          成交量万手: Math.round(Number(r.vol ?? 0) / 1e4),
          买一: hc.bid?.[0] ? `${hc.bid[0].price}×${hc.bid[0].vol}手` : null,
          卖一: hc.ask?.[0] ? `${hc.ask[0].price}×${hc.ask[0].vol}手` : null,
          内盘万手: Math.round(Number(r.in_vol ?? 0) / 1e6 * 100) / 100,
          外盘万手: Math.round(Number(r.out_vol ?? 0) / 1e6 * 100) / 100,
          服务器时间: r.server_time ?? null,
        };
      }),
    };
  } catch (e) {
    return { missing: `通达信行情取数失败：${(e as Error).message}` };
  }
}

async function toolTdxKline(args: { symbol?: string; days?: number }): Promise<unknown> {
  const r = await resolveSymbolArg(String(args.symbol ?? ""));
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const days = Math.min(60, Math.max(5, args.days ?? 20));
  const err = await ensureTdxMcp();
  if (err) return { missing: err };
  try {
    const res = await mcpCallTool("tdx-mcp", "stock_kline", {
      market: tdxMarketOf(symbol), code: symbol.slice(0, 6), period: 4, count: days,
    });
    const rows = unwrapMcpContent(res);
    const bad = rows.find((r) => r._error);
    if (bad) return { missing: `通达信日K取数失败（上游工具报错）：${String(bad._error).slice(0, 120)}` };
    if (!rows.length) return { missing: "通达信日K无返回（行情服务器未响应）" };
    const bars = rows.map((r) => ({
      日期: String(r.datetime ?? "").slice(0, 10),
      开: r.open ?? null, 高: r.high ?? null, 低: r.low ?? null, 收: r.close ?? null,
      成交量万手: Math.round(Number(r.vol ?? 0) / 1e4 * 10) / 10,
      成交额亿: Math.round(Number(r.amount ?? 0) / 1e7) / 10,
    }));
    const first = bars[0]?.收 != null ? Number(bars[0].收) : null;
    const last = bars[bars.length - 1]?.收 != null ? Number(bars[bars.length - 1].收) : null;
    return {
      数据源: "通达信行情服务器（tdx-mcp，日线，不复权）",
      标的: symbol,
      ...resolvedNote(r),
      区间: `${bars[0]?.日期 ?? "?"} ~ ${bars[bars.length - 1]?.日期 ?? "?"}（${bars.length} 根）`,
      ...(first != null && last != null ? { 区间涨跌幅: `${Math.round((last / first - 1) * 10000) / 100}%` } : {}),
      K线: bars,
    };
  } catch (e) {
    return { missing: `通达信日K取数失败：${(e as Error).message}` };
  }
}

/**
 * P13 门户轮：读已冻结候选池（「存池 + 交 AI 择优」链路的取素材口，不是新引擎）。
 * 口径三条与 P10 同源：池序是冻结时点的页面排序不是推荐；出身（source/条件）如实带出；
 * 名单超长截断必须写明「其余未读」——不许把「只看了前 40 只」说成「整池都研究过」。
 * 不带 pool_id 不猜池：列出最近几个池号让用户/模型选，指认错池等于择优选错了素材。
 */
async function toolCandidatePool(args: { pool_id?: string }): Promise<unknown> {
  const id = typeof args.pool_id === "string" ? args.pool_id.trim() : "";
  if (!id) {
    const recent = await db.candidatePool.findMany({
      orderBy: { createdAt: "desc" }, take: 5,
      select: { poolId: true, asOf: true, universe: true, source: true },
    });
    return {
      missing: "未指定池号 pool_id（一次只交一个池，拿错池等于择优选错素材）",
      最近的候选池: recent.map((r) => `${r.poolId}（${r.asOf} · ${r.universe} · 来源 ${r.source || "未标注"}）`),
    };
  }
  const pool = await db.candidatePool.findUnique({ where: { poolId: id } });
  if (!pool) return { missing: `候选池不存在：${id}（池号取自「AI 实时选股」冻结后的提示）` };
  let rows: unknown[] = [];
  try { rows = JSON.parse(pool.rows); } catch { /* 坏行只报空不炸整池 */ }
  let conditions: unknown = [];
  try { conditions = JSON.parse(pool.conditions); } catch { /* 同上 */ }
  const CAP = 40;
  return {
    池号: pool.poolId, 交易日: pool.asOf, 股票池: pool.universe,
    // R11：条件与名单读出侧人话化（P13 因子中文化只改了页面，工具侧曾原样吐
    // field:"amount_yi"/symbol 这类英文键）。只换读法：conditions/rows 的库内原文不改，
    // 认不出的形状（坏条件、自定义列）经 poolCondZh/poolRowZh 原样透传。
    条件: Array.isArray(conditions) ? conditions.map(poolCondZh) : poolCondZh(conditions),
    来源: pool.source || "未标注", 数据源: pool.dataSource || "未记录（旧池）",
    排序提示: "池内行序是冻结时点的页面排序，不是推荐结果；评价维度与权重由你自主决定",
    择优纪律: PICK_DISCIPLINE,
    名单: rows.slice(0, CAP).map(poolRowZh),
    ...(rows.length > CAP ? { 截断说明: `池内共 ${rows.length} 只，这里只给前 ${CAP} 只——其余未读，别当成整池都看过` } : {}),
    次日验证: pool.verify ? "已回填（逐只 signal→next_close 见候选池页）" : "尚未验证（下一交易日可核对）",
  };
}

async function toolFactorScreener(args: {
  conditions?: ScreenerCond[]; limit?: number;
  /** P10 择优轮：候选池出身（预取侧由 planDispatch 给；模型自调不带就按 model 口径说） */
  pool_origin?: "extracted" | "default" | "model"; pool_matched?: string[];
}): Promise<unknown> {
  const raw = Array.isArray(args.conditions) ? args.conditions : [];
  // P10 口径（用户裁定，参考 aiwuchuan「候选池→择优」）：空条件不再拒绝开工，
  // 而是按系统默认活跃池跑，并把「这是默认口径」如实写进返回——含糊的「帮我选股」
  // 从此有真池可择优，不再逼用户先报条件。
  const conds = raw.length ? raw : DEFAULT_PICK_CONDS;
  const origin = raw.length ? (args.pool_origin === "extracted" ? "extracted" : "model") : "default";
  const matched = Array.isArray(args.pool_matched) && args.pool_matched.length
    ? args.pool_matched : conds.map(pickCondText);
  const result = await runScreener({
    universe: "all_a",
    conditions: conds,
    fields: ["change_pct", "turnover_rate", "amount_yi", "main_net_yi", "rps_50"],
    sort: { order_by: "amount_yi", order_dir: "desc" },
    pagination: { limit: Math.min(20, Math.max(3, args.limit ?? 10)) },
    maxKlineSymbols: 120,
  });
  return {
    funnel: result.funnel, trade_date: result.as_of_trade_date,
    数据源: result.source.provider, 口径提示: result.warnings,
    // P10 择优轮：池子出身必须摆在结果前面——默认池不是用户条件，模型不许混为一谈；
    // 五条择优纪律随返回下发（与场景提示词同源一份定义），纯对话端没有工具环也照吃注入块。
    条件口径: poolOriginText(origin, matched),
    择优纪律: PICK_DISCIPLINE,
    // P9-经验轮：字段全缺被忽略的条件单独摆到模型眼前——「筛不出」与「数据缺口」
    // 是两个事实，模型只看到空 funnel 时会把缺口转述成「没有符合的股票」。
    ...(result.unavailable_fields.length
      ? {
          本轮被忽略的条件字段: result.unavailable_fields.map((g) => `${g.zh}(${g.field})`),
          忽略原因: `当前数据源里这些字段没有一条真实读数（断源/缺失，不是值为 0），本轮结果未按它们筛选`,
          转述要求: "必须如实告诉用户哪些条件因数据缺口被忽略，并建议改用可得的口径（如涨跌幅/成交额/换手率）重试；禁止把这说成「没有股票符合该条件」。",
        }
      : {}),
    结果: result.list.map((r) => ({
      代码: r.symbol, 名称: r.name, 现价: r.close, 涨跌幅: r.change_pct, ...r.values,
    })),
  };
}

async function toolHistoricalProbability(args: { symbol: string; conditions: ScreenerCond[] }): Promise<unknown> {
  const r = await resolveSymbolArg(args.symbol ?? "");
  if (!r) return { missing: `认不出这只股票：${args.symbol}（代码形态或东财搜索可命中的公司简称）` };
  const symbol = r.symbol;
  const conds = Array.isArray(args.conditions) ? args.conditions : [];
  if (!conds.length) return { missing: "conditions 为空" };
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate();
  const meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  const barsRes = await fetchBarsHybridTracked([symbol], tradeDate, 480);
  const bars = (barsRes.bars.get(symbol) ?? []) as BarsLike[];
  if (!bars.length) {
    const oc = barsRes.outcomes[0];
    return { missing: oc?.kind === "request_failed" ? `日K取数失败：${oc.reason}` : "日K无返回（这只股票没取到任何K线）" };
  }
  if (bars.length < 120) return { missing: `日K历史不足（仅 ${bars.length} 根，需 ≥120），无法统计` };
  const stats = historicalWinProbability({ symbol, bars, meta, conditions: conds });
  if (!stats) return { missing: "条件无法识别（字段不在因子目录内）" };
  return {
    symbol, ...resolvedNote(r), 条件: conds, 统计: stats.horizons.map((h) => ({
      持有日: h.h, 胜率: h.win_rate?.toFixed(1) + "%", 样本: h.sample_size,
      平均收益: h.avg_return?.toFixed(2) + "%", 最差收益: h.worst_return?.toFixed(2) + "%",
    })),
    统计区间: stats.period, 样本是否充足: stats.sample_ok, 口径提示: stats.warnings,
  };
}

/**
 * 自选股总览（P7-⑥④ 新增）。
 * 口径要说清楚两件事：**清单**来自用户本机浏览器存档（不是交易所或东财给的），
 * **行情**是这一步现取的真实报价。清单为空时返回 missing，而不是回一个空列表冒充「你的自选都没动」。
 */
async function toolWatchlistOverview(args: { symbols?: string[] }, ctx: ToolCtx = {}): Promise<unknown> {
  const fromArgs = Array.isArray(args.symbols) ? args.symbols.map((s) => String(s)) : [];
  const stored = (ctx.watchlist ?? []).map((w) => w.symbol);
  const raw = fromArgs.length ? fromArgs : stored;
  if (!raw.length) return { missing: "自选清单为空（本机存档里没有自选，或本次请求未带清单）" };
  // 去重 + 上限：清单是浏览器带来的，重复项和一次塞几千条都可能发生。
  // 截断必须在结果里写明（否则模型会把「只看了前 200 只」说成「你的自选都看了」）。
  const unique: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const s of raw) {
    const sym = normalizeSymbol(s);
    if (!sym) continue;
    if (seen.has(sym)) { duplicates++; continue; }
    seen.add(sym);
    unique.push(sym);
  }
  const symbols = unique.slice(0, WATCHLIST_MAX);
  const truncated = unique.length - symbols.length;
  const unrecognized = raw.length - unique.length - duplicates;
  if (!symbols.length) return { missing: `自选清单里的代码都无法识别：${raw.slice(0, 5).join(", ")}` };
  const nameOf = new Map<string, string | null>((ctx.watchlist ?? []).map((w) => [w.symbol, w.name ?? null] as const));
  const [quotes, metaRows] = await Promise.all([
    tdxQuotes(symbols).catch(() => null),
    getProvider("em").then((p) => p.listUniverse({ kind: "custom", symbols }, shanghaiDate()).catch(() => [])),
  ]);
  const metas = new Map<string, (typeof metaRows)[number]>((metaRows ?? []).map((m) => [m.symbol, m] as const));
  const rows = symbols.map((sym) => {
    const q = quotes?.get(sym) ?? null;
    const meta = metas.get(sym);
    return {
      symbol: sym,
      名称: meta?.name ?? nameOf.get(sym) ?? null,
      现价: q?.price ?? meta?.price ?? null,
      涨跌幅: q?.changePct ?? meta?.changePct ?? null,
      主力净额亿: meta?.mainNet != null ? Number(meta.mainNet) / 1e8 : null,
      成交额亿: q?.amountYi ?? (meta?.amount != null ? Number(meta.amount) / 1e8 : null),
      换手率: meta?.turnover ?? null,
    };
  });
  return {
    清单来源: "用户本机自选存档（浏览器 localStorage，随请求带上，非交易所数据）",
    数据源: "通达信网关/腾讯实时快照 + 东财榜单接口",
    取数时刻: shanghaiDate(),
    自选: rows,
    家数: rows.length,
    // 三种「少了几只」原因分开写：把识别失败说成去重、或把截断说成没数据，都会让模型的结论对不上事实
    ...(raw.length - symbols.length > 0
      ? {
          未计入: [
            duplicates > 0 ? `${duplicates} 条重复代码已合并` : "",
            truncated > 0 ? `${truncated} 条超出单次上限（${WATCHLIST_MAX} 只）未取数，只看了前 ${WATCHLIST_MAX} 只` : "",
            unrecognized > 0 ? `${unrecognized} 个代码无法识别` : "",
          ].filter(Boolean).join("；"),
        }
      : {}),
  };
}

// ---------- 回测工具（P7-⑧④：对话链路 → 现有回测引擎，白名单在前、引擎在中、只读在后） ----------

/**
 * 可回测因子白名单：库里已入库、且 expression 非空的因子（每个键取最新版本）。
 * 每次工具调用现查一次，不做进程内缓存——因子表是会被研究流程改写的，
 * 缓存等于让「刚入库的因子要等一会儿才能回测」「刚下架的因子还能被跑到」这两件事同时成立。
 */
export async function backtestWhitelist(): Promise<WhitelistRow[]> {
  quantBootstrap();
  const rows = await listLatestFactors();
  return whitelistOf(rows)
    .map((r) => ({ factorKey: r.factorKey, version: r.version, expression: r.expression, name: r.name, status: r.status }))
    .sort((a, b) => a.factorKey.localeCompare(b.factorKey));
}

/** 引擎侧的区间上限（strategy-jobs：`Math.min(500, periodDays)`）。这里先夹住，免得「要 600 日实跑 500 日」 */
const BACKTEST_MAX_PERIOD_DAYS = 500;
/** 对话里的回测样本上限：比量化页的 300 只小得多，一次对话等不起那么久的取数 */
const BACKTEST_MAX_SYMBOLS = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && isFinite(v) ? Math.trunc(v) : NaN;
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * run_backtest：让模型用**已入库的白名单因子**跑一次真实回测。
 *
 * 三条边界（顺序不能调，每条都是「先挡住、再干活」）：
 *  1. 因子必须先过白名单（backtest-core.resolveWhitelistFactors）——本层不接受模型现写的表达式，
 *     表达式只从 quant_factors 里带出来，所以跑的一定是入库那份；
 *  2. 区间先预检：可交易日不足就直接返回「回测区间太短」，不进引擎（引擎自己的下限是 80 日，
 *     比任务书要求的 240 松得多，靠它兜就是把 100 日的样本发出去）；
 *  3. 等结果按固定 1 秒节拍、最多 60 秒（任务书口径），到点就把任务留在后台如实说超时。
 *
 * 为什么不自己 HTTP 调 /api/quant/backtest：那是自指一次网络往返，还多一套超时口径。
 * 直接走 registry（同进程 startJob/getJob）＝量化页点「开始回测」走的同一个入口，
 * 指纹算法也复用 experimentFingerprint，所以对话里跑过的组合，量化页不会重复跑第二遍。
 */
async function toolRunBacktest(args: {
  factors?: RequestedFactor[];
  asOf?: string;
  periodDays?: number;
  topN?: number;
  rebalanceEvery?: number;
  maxSymbols?: number;
  symbols?: string[];
}): Promise<unknown> {
  quantBootstrap();
  registerStrategyRunners();

  const rows = await backtestWhitelist();
  const requested = Array.isArray(args?.factors) ? args.factors : [];
  const { resolved, rejected, empty } = resolveWhitelistFactors(requested, rows);
  if (empty) {
    return { missing: "未指定因子：factors 至少给一个 {factorKey, version?}，且必须来自可回测因子白名单" };
  }
  if (rejected.length) {
    // 整轮拒绝：把能跑的先跑一半，报出来的收益就不是用户要的那组因子
    return {
      missing: TEXT_NOT_IN_WHITELIST,
      被拒因子: rejected,
      可回测因子: rows.slice(0, 40).map((r) => `${r.factorKey}@${r.version}`),
      提示: "请按可回测因子清单重问；不要替换成「差不多」的因子，也不要自己写表达式。",
    };
  }

  const asGiven = typeof args.asOf === "string" ? args.asOf.trim() : "";
  // 日期只认 YYYY-MM-DD，其余（含「昨天」「上周五」这种）一律按今天算：
  // 服务端今天必须是 shanghaiDate()，跨时区机器上 new Date() 会把今天算错一天
  const asOf = DATE_RE.test(asGiven) ? asGiven : shanghaiDate();
  const periodDays = clampInt(args.periodDays, BACKTEST_MIN_TRADING_DAYS, BACKTEST_MIN_TRADING_DAYS, BACKTEST_MAX_PERIOD_DAYS);
  const topN = clampInt(args.topN, 10, 1, 50);
  const rebalanceEvery = clampInt(args.rebalanceEvery, 5, 1, 20);
  const maxSymbols = clampInt(args.maxSymbols, 60, 20, BACKTEST_MAX_SYMBOLS);
  // 指定标的池：代码走 normalizeSymbol 的唯一号段口径，认不出的一律丢掉并写明丢了几只
  const wanted = Array.isArray(args.symbols) ? args.symbols.map((s) => normalizeSymbol(String(s))).filter((s): s is string => !!s) : [];
  const pool = [...new Set(wanted)].slice(0, BACKTEST_MAX_SYMBOLS);
  const poolDropped = Array.isArray(args.symbols) ? args.symbols.length - pool.length : 0;

  // ---- 区间预检：数指数日K的真实交易日条数（与 /api/quant/screener/trade-dates 同一口径）----
  const barsRes = await fetchBarsHybridTracked(["000001.SH"], asOf, Math.ceil(periodDays * 1.6));
  const bars = (barsRes.bars.get("000001.SH") ?? []) as BarsLike[];
  if (!bars.length) {
    const oc = barsRes.outcomes[0];
    // 「取数失败」和「历史不足」是两件事：混说会把网关限流报成「这只票没那么长历史」
    return { missing: oc?.kind === "request_failed" ? `日K取数失败：${oc.reason}` : "日K无返回（未取到任何交易日）" };
  }
  const verdict = rangeVerdict(bars.length, periodDays);
  if (!verdict.ok) return { missing: `${TEXT_RANGE_TOO_SHORT}：${verdict.text}（区间交易日按 000001.SH 日K计数）` };

  // 切分口径与量化页 BacktestTab 发出的那份默认值一致（那里是写死在请求体里的 {0.6,0.2,0.2}）。
  // 为什么要在对话里也带上它：runner 的 segments = splitRanges(dates, p.split)，不传就是空数组 ——
  // 同一次回测在量化页有 train/validation/test 三段、在对话里只剩一段，那就不是「复用同一个组件」，
  // 而是「同一个引擎两种口径」。指纹里也带这一份，才能和量化页的记录对上。
  const split = { train: 0.6, validation: 0.2, test: 0.2 };
  const payload: BacktestPayload = {
    asOf, periodDays, topN, rebalanceEvery, source: "em", maxSymbols, split, validate: true,
    factors: resolved.map((f) => ({ factorKey: f.factorKey, version: f.version, weight: f.weight, direction: f.direction })),
    ...(pool.length ? { kind: "custom", symbols: pool } : {}),
  };
  // 指纹与 /api/quant/backtest 那条路上 runner 自己算的那一份逐字段对齐（strategy-jobs.ts 的 parts）：
  // 于是对话里跑过的组合，量化页看得见、参数一致时也不会重跑第二遍（去重发生在实验表，不在这里）
  const fp = experimentFingerprint({
    kind: "backtest",
    dataRange: `${asOf} 前 ${periodDays} 交易日`,
    // stockPool 用 payload 里那份 maxSymbols（引擎读的就是这个字段），不是指定标的的只数
    stockPool: { kind: pool.length ? "custom" : "all", boardCode: "", maxSymbols },
    factorVersions: resolved.map((f) => `${f.factorKey}@${f.version}`).join(","),
    strategyVersion: "",
    parameters: { topN, rebalanceEvery, scoring: "rank" },
    backtestParameters: { periodDays, split },
    transactionCost: {},
  });
  const { job: started, duplicate } = startJob({ kind: "quant_backtest", fingerprint: fp, payload: payload as Record<string, unknown> });

  // ---- 等结果：固定 1 秒一次，最多 60 秒（任务书口径）。节拍判定在 backtest-core，本层只管睡和读 ----
  const startedAt = Date.now();
  let job = started;
  for (;;) {
    await sleep(BACKTEST_POLL_INTERVAL_MS);
    job = getJob(started.id) ?? job;
    const action = pollAction(Date.now(), startedAt, getJob(started.id)?.status ?? null);
    if (action === "waiting") continue;
    if (action === "timed_out") {
      // 任务没被取消，还在本进程里跑：所以话术是「稍后在策略历史查看」，同时把 jobId 带回去让前端继续看进度
      return {
        missing: TEXT_POLL_TIMEOUT,
        jobId: started.id,
        状态: job.status,
        进度: job.progress,
        阶段: job.stage || job.message,
        说明: "任务已交给回测引擎且未取消，稍后可在量化研究页的回测任务列表或本条回答下方的结果卡看到结果；本轮不得给出任何回测收益数字。",
      };
    }
    break;
  }

  if (job.status === "failed") return { missing: `回测失败：${job.error || "引擎未给出原因"}`, jobId: job.id };
  if (job.status === "cancelled") return { missing: "回测任务已取消", jobId: job.id };

  const r = (job.result ?? {}) as Record<string, unknown>;
  if (r.skipped) {
    // 引擎侧的实验去重：同样的组合此前已经跑完，本轮没有重算，自然也没有新数字可报。
    // 这里故意不带 jobId：下面的结果卡是「按 jobId 现查引擎」画的，而去重任务的 result 只有
    // {skipped, reason, experiment} 三个键，画出来会是一张标着 done 却什么都没有的空卡，
    // 比不画更容易让人以为「回测跑完了但系统没给结果」。要回看那次真算的，按指引里的任务号去量化页。
    const prev = (r.experiment ?? null) as { jobId?: unknown } | null;
    return {
      摘要: "相同因子的回测此前已完成过，本轮未重跑",
      说明: String((r.reason as string) ?? "实验指纹与已完成记录相同"),
      ...(typeof prev?.jobId === "string" && prev.jobId
        ? { 指引: `同参数的上一次实验是任务 ${prev.jobId}，可在量化研究页的回测任务列表里查看它当时的结果` }
        : {}),
      提示: "需要新结果请改变区间、样本只数或因子版本后重问；本轮没有新的回测数字，不要把历史实验的数字当成本轮算出来的。",
    };
  }
  const metrics = (r.metrics ?? null) as Record<string, unknown> | null;
  const panel = (r.panel ?? {}) as { symbols?: number; dates?: number; coverageNotes?: string[] };
  const dataSource = typeof r.dataSource === "string" ? r.dataSource : "em";
  const readout = backtestReadout({
    asOf: typeof r.asOf === "string" ? r.asOf : asOf,
    periodDays,
    dataSource: `回测引擎（数据源 ${dataSource === "em" ? "东财" : dataSource}，K线走通达信网关/腾讯日K）`,
    symbols: typeof panel.symbols === "number" ? panel.symbols : 0,
    dates: typeof panel.dates === "number" ? panel.dates : 0,
    factors: resolved as ResolvedFactor[],
    topN,
    rebalanceEvery,
    metrics,
    jobId: job.id,
    coverageNotes: Array.isArray(panel.coverageNotes) ? panel.coverageNotes : [],
  });
  return {
    // 摘要放第一个键：步骤时间线里 detail 取的就是这份 JSON 的前 120 字符，
    // 让它先说清「跑完了 · 样本多少 · 五项读数」，而不是让界面切出一段半截的因子列表
    摘要: `回测完成 ${panel.dates ?? 0} 交易日 × ${panel.symbols ?? 0} 只 · ${Object.entries(metricObject(metrics)).map(([k, v]) => `${k}${v}`).join(" ")}`,
    jobId: job.id,
    ...(duplicate ? { 去重: "相同参数的回测任务此前已在执行或排队，本轮沿用该任务结果" } : {}),
    ...(pool.length && poolDropped > 0 ? { 样本提示: `${poolDropped} 个代码无法识别或超出上限，未纳入样本` } : {}),
    指标: metricObject(metrics),
    读数: readout,
    口径约束: "以上数字来自本轮引擎计算。引用时必须连同区间、样本只数与数据源一起说；历史回测不代表未来收益，不得据此给出买卖建议。",
  };
}

export interface ChatTool {
  name: string;
  desc: string;
  /**
   * 工具入参形状不同，运行时传的就是模型/调度层给的那份 JSON，所以这里只能是 any：
   * 工具体内自己判空并回 missing。（项目没开 no-explicit-any 规则，不需要 disable 注释。）
   */
  fn: (args: any, ctx?: ToolCtx) => Promise<unknown>;
  params: Record<string, any>;
  /**
   * P35 稳智对齐：这个工具**真实归属**的 Agent Loop 阶段（对齐稳智 agentStepTimeline 的
   * phase_key 常量——稳智也是按工具本身归属标 phase_key，不是按文案猜）。
   *
   *   - local_data   获取行情与市场数据（快照/盘口/资金/K线/情绪/板块）
   *   - external_data 核查新闻与公开信息（新闻/公告）
   *   - research     综合分析（因子筛选/回测/历史概率/候选池）
   *
   * 只可能是这三值：工具不会归到 intent/skills/answer（那三阶段分别靠意图徽章、
   * 步骤存在、消息流判定，不是"某一步骤行"）。路由（模型自取）与自动调度（系统预取）
   * 两条链路都读它填 step.phase_key，同一工具只归一个阶段，不会一边说"行情"一边说"分析"。
   *
   * 可选：动态注册的第三方工具允许不声明（没标就回落到 label 语义映射，不硬编）。
   * 内置工具一律显式标注（p35-wz-phase-key 钉测卡住"漏标"）。
   */
  phase?: PhaseKey;
}

export const TOOLS: ChatTool[] = [
  { name: "market_sentiment", desc: "大盘情绪：情绪温度(0-100)/涨跌家数/涨停/跌停/成交额/主力净额/风险等级", fn: toolMarketSentiment, params: { type: "object", properties: {} }, phase: "local_data" },
  { name: "sector_rank", desc: "行业/概念板块资金榜（按主力净流入排序）", fn: toolSectorRank, params: { type: "object", properties: { kind: { type: "string", enum: ["industry", "concept"] }, size: { type: "number" } } }, phase: "local_data" },
  { name: "stock_snapshot", desc: "个股实时快照：价格/涨跌幅/换手/量比/估值/主力净额/行业；symbol 可传代码或公司简称（简称经东财搜索解析，解析结果如实标注）", fn: toolStockSnapshot, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, phase: "local_data" },
  { name: "stock_depth", desc: "个股五档盘口（通达信网关）", fn: toolStockDepth, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, phase: "local_data" },
  { name: "stock_trades", desc: "个股主动买卖金额（内外盘全日口径，代理指标）", fn: toolStockTrades, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, phase: "local_data" },
  { name: "stock_kline_summary", desc: "个股技术状态：均线/MACD/KDJ/RSI/VWAP/RPS + 历史条件概率", fn: toolStockKline, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, phase: "local_data" },
  { name: "stock_fund_flow", desc: "个股近14日主力资金净额（东财）", fn: toolStockFundFlow, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] }, phase: "local_data" },
  { name: "market_news", desc: "最新宏观/市场快讯", fn: toolMarketNews, params: { type: "object", properties: { limit: { type: "number" } } }, phase: "external_data" },
  // R10 扩容：个股自己的消息面。谈个股结论必须引它，宏观快讯（market_news）替代不了——
  // 3014 实测「问中国海油答美国地产商」就是拿宏观快讯冒充个股消息面的事故现场。
  { name: "stock_news", desc: "个股新闻+公告（这只票自己的消息面）：symbol 可传代码或公司简称（简称自动经东财搜索解析并如实标注）；新闻按时间倒序、公告含栏目标签", fn: toolStockNews, params: { type: "object", properties: { symbol: { type: "string" }, limit: { type: "number" } }, required: ["symbol"] }, phase: "external_data" },
  // R10 通达信三件：只进模型自取清单，不进自动调度预取表（同 P13 candidate_pool 先例）——
  // tdx-mcp 冷启动要拉起 Python 进程（首调 ~4s），预取环里每轮都等它不值；模型要核对盘口/量能再调。
  { name: "tdx_market_overview", desc: "通达信指数概况：上证/深证/创业板/科创50/北证50 最新点位+成交额+涨跌家数（交易所直连快照，与东财口径互为交叉核对；无资金流读数）", fn: toolTdxMarketOverview, params: { type: "object", properties: {} }, phase: "local_data" },
  { name: "tdx_quotes", desc: "通达信个股实时快照（最多20只）：现价/涨跌幅/成交额/内外盘/买一卖一盘口/服务器时间；看盘口挂单与量能用它，资金流向仍用 stock_fund_flow", fn: toolTdxQuotes, params: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] }, phase: "local_data" },
  { name: "tdx_kline", desc: "通达信日K（不复权，5~60根）：开高低收+量额+区间涨跌幅，用于核对东财K线或看近期走势", fn: toolTdxKline, params: { type: "object", properties: { symbol: { type: "string" }, days: { type: "number" } }, required: ["symbol"] }, phase: "local_data" },
  { name: "factor_screener", desc: "全A条件选股：conditions=[{field,op,value}]，field 必须来自因子目录；不给 conditions 时按系统默认活跃池跑（返回里会如实标注是默认口径）", fn: toolFactorScreener, params: { type: "object", properties: { conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string", enum: ["=", ">=", ">", "<=", "<", "!="] }, value: { type: ["number", "string"] } }, required: ["field", "op", "value"] } }, limit: { type: "number" } } }, phase: "research" },
  { name: "candidate_pool", desc: "读取已冻结候选池（择优素材，池序不是推荐）：pool_id 形如 2026-09-22-全A-001（AI 选股页冻结后给的池号）；不带 pool_id 会列出最近的池", fn: toolCandidatePool, params: { type: "object", properties: { pool_id: { type: "string" } } }, phase: "research" },
  { name: "historical_probability", desc: "个股历史条件概率：conditions 中的 field 必须来自因子目录", fn: toolHistoricalProbability, params: { type: "object", properties: { symbol: { type: "string" }, conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: ["number", "string"] } }, required: ["field", "op", "value"] } } }, required: ["symbol", "conditions"] }, phase: "research" },
  { name: "watchlist_overview", desc: "自选股实时总览（清单取自用户本机存档，行情现取）", fn: toolWatchlistOverview, params: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } } }, phase: "local_data" },
  {
    name: "run_backtest",
    desc: "因子组合历史回测（真实引擎计算）：factors 只能取提示词里「可回测因子白名单」的 factorKey，禁止自写表达式；区间不足 240 交易日或因子不在白名单会被拒绝",
    fn: toolRunBacktest,
    phase: "research",
    params: {
      type: "object",
      properties: {
        factors: { type: "array", items: { type: "object", properties: { factorKey: { type: "string" }, version: { type: "number" }, weight: { type: "number" }, direction: { type: "number", enum: [1, -1] } }, required: ["factorKey"] } },
        periodDays: { type: "number", description: "回测交易日数，240~500" },
        asOf: { type: "string", description: "截至日 YYYY-MM-DD，省略即今天（上海口径）" },
        topN: { type: "number", description: "每期持仓只数 1~50" },
        rebalanceEvery: { type: "number", description: "调仓周期（交易日）1~20" },
        maxSymbols: { type: "number", description: "样本只数 20~120，默认 60" },
        symbols: { type: "array", items: { type: "string" }, description: "指定标的池（6 位代码），省略则按全市场流动性抽样" },
      },
      required: ["factors"],
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * P8-③ 可注册体系的实现层入口：把新工具（含技能插件的执行本体）追加进注册表。
 *  - 只登记执行本体；它要不要进自动调度、在哪个场景进，由 skills-core 的 plan 声明，两边不互相抄；
 *  - 重名/缺字段如实拒绝，不静默覆盖内置实现——覆盖内置工具是最不容易被发现的那类事故；
 *  - TOOL_NAMES / BACKTEST_READY 是模块加载时对内置项的一次性快照，注册项不进这两份：
 *    它们只服务「内置清单漂移」的判定，把动态项混进来反而会让人误以为内置表被改过。
 * 运行时消费者（findTool、chat 路由的 tools 清单）每次都重读 TOOLS，所以注册即刻生效。
 */
export function registerChatTool(tool: ChatTool): { ok: boolean; error?: string } {
  if (!tool?.name || typeof tool.name !== "string") return { ok: false, error: "工具名必须是非空字符串" };
  if (!tool.desc) return { ok: false, error: `工具 ${tool.name} 缺 desc：模型看的就是这份说明` };
  if (typeof tool.fn !== "function") return { ok: false, error: `工具 ${tool.name} 缺执行本体 fn` };
  if (!tool.params?.type) return { ok: false, error: `工具 ${tool.name} 缺 params（JSON schema）：没有入参形状就没人能调对` };
  if (findTool(tool.name)) return { ok: false, error: `工具 ${tool.name} 已注册，不静默覆盖（要换实现请先摘旧的）` };
  TOOLS.push(tool);
  return { ok: true };
}

/**
 * 回测是否真的接进了对话链路。
 * 不写成 true 的字面量：这条开关跟着 TOOLS 走，将来谁把 run_backtest 摘掉，
 * 提示词那句「不得声称已回测」会自动回到原位，而不是留着一句假话让模型以为自己会回测。
 */
export const BACKTEST_READY = TOOL_NAMES.includes("run_backtest");

export function findTool(name: string): ChatTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * P35 稳智对齐：工具名 → Agent Loop 阶段（phase_key）的真实映射，单一出处。
 *
 * 路由（模型自取的 step）与自动调度（系统预取的 step）都调它填 phase_key——
 * 同一个工具在两条链路上只会归到同一个阶段。未登记或未标注的工具返回 null，
 * 前端回落到 label 语义映射（classifyStep），**不硬编一个阶段冒充事实**。
 */
export function phaseOfTool(name: string): PhaseKey | null {
  return findTool(name)?.phase ?? null;
}

/** 因子目录一行（提示词与自动调度都要用同一份，写两遍迟早对不上） */
export const FACTOR_KEYS = "pe_ttm,pb,market_cap_yi,floatcap_yi,change_pct,turnover_rate,volume_ratio,amplitude,amount_yi,is_limit_up,double_volume_signal,volume_signal,above_ma_5/10/20/60/90/144,ma_struct,rps_50,rps_120,rps_composite,macd_dif/macd_dea/macd/macd_cross,kdj_k/kdj_d/kdj_j/kdj_cross,rsi_7/14/24,main_net_yi,above_cost_20,break_cost_20,vwap20_filter,vwap_pos,vwap20_up3,breakout_high_20,breakout_high_60";
