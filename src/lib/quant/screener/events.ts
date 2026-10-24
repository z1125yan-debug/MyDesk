import { readFileSync } from "fs";
import { join } from "path";
import { fetchNewsWindowForDate, type BoardRow } from "@/lib/desk/em";
import { fetchBoardRowsRescued } from "@/lib/desk/board-rescue";
import { fetchThsStockFunds, thsCodeFromSymbol, type ThsStockFund } from "@/lib/desk/ths-fund";
import { fetchChinaStockFundFlow } from "@/lib/desk/china-stock-mcp";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import {
  classifyNewsTitle, fundStage, type ThemeMapItem, type EventMatch,
} from "./events-rules.ts";
import { contentHash } from "./incremental-core.ts";

export interface ThsLeaderFund {
  /** 龙头股名（板块榜 leader 原值） */
  name: string;
  /** 6 位代码 */
  code: string;
  /** 同花顺主力净额(亿) = (223+225)−(224+226) */
  mainNetYi: number;
  /** 超大单净额(亿) */
  superNetYi: number;
  /** 大单净额(亿) */
  bigNetYi: number;
}

export interface EventScanItem extends EventMatch {
  fund: {
    stage: string;
    note: string;
    boards: { name: string; changePct: number; mainYi: number; rank: number; leader: string }[];
    /** 同花顺个股主力（板块龙头逐只拉，P15-R9；为空 = 未取到/未验证） */
    stockFunds?: ThsLeaderFund[];
  };
  relatedLeaders: string[];
  source: string;
}

/** 股名 → 代码：sector-constituents + rps-seed 两份名单合并，惰性加载并缓存。
 *  归一化：去空格、全角Ａ-Ｚ转半角、全角括号转半角，防「万科Ａ」vs「万科A」这类错配。 */
let nameToCodeCache: Map<string, string> | null = null;
function normName(n: string): string {
  return n.replace(/\s+/g, "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  ).replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"));
}
function nameToCodeMap(): Map<string, string> {
  if (nameToCodeCache) return nameToCodeCache;
  const m = new Map<string, string>();
  const put = (name: string, code: string) => {
    if (!name || !code) return;
    const k = normName(name);
    if (k && !m.has(k)) m.set(k, String(code).split(".")[0]);
  };
  try {
    const sec = JSON.parse(readFileSync(join(process.cwd(), "data", "sector-constituents.json"), "utf8")) as {
      industries?: Record<string, { members?: { code?: string; name?: string }[] }>;
    };
    for (const ind of Object.values(sec.industries ?? {})) {
      for (const mem of ind.members ?? []) put(mem.name ?? "", mem.code ?? "");
    }
  } catch { /* 名单缺失则只用 rps */ }
  try {
    const rps = JSON.parse(readFileSync(join(process.cwd(), "data", "rps-seed-latest.json"), "utf8")) as {
      rows?: { symbol?: string; name?: string }[] };
    for (const r of rps.rows ?? []) put(r.name ?? "", r.symbol ?? "");
  } catch { /* 忽略 */ }
  nameToCodeCache = m;
  return m;
}

function loadMap(): ThemeMapItem[] {
  return loadThemeMapFile().themes;
}

/** P3 增量链路要复用同一份映射表与文件指纹，故把读取动作单点暴露（不改任何判定逻辑） */
export function loadThemeMapFile(): { path: string; raw: string; themes: ThemeMapItem[] } {
  const p = join(process.cwd(), "data", "theme-chain-map.json");
  const raw = readFileSync(p, "utf8");
  const themes = (JSON.parse(raw) as { themes?: ThemeMapItem[] }).themes ?? [];
  return { path: p, raw, themes };
}

/** 映射表内容指纹：游标里的「未命中」记录只在映射表没变时才允许永久跳过 */
export function themeMapFingerprint(): string {
  return contentHash(loadThemeMapFile().raw);
}

function mergeBoards(a: BoardRow[] | null, b: BoardRow[] | null): BoardRow[] {
  const m = new Map<string, BoardRow>();
  for (const r of [...(a ?? []), ...(b ?? [])]) if (r.code && !m.has(r.code)) m.set(r.code, r);
  return [...m.values()].sort((x, y) => y.changePct - x.changePct);
}

function matchBoards(names: string[], boards: BoardRow[]): { name: string; changePct: number; mainYi: number; rank: number; leader: string }[] {
  const hits: { name: string; changePct: number; mainYi: number; rank: number; leader: string }[] = [];
  boards.forEach((b, i) => {
    if (names.some((n) => n && (b.name.includes(n) || n.includes(b.name)))) {
      hits.push({ name: b.name, changePct: b.changePct, mainYi: b.main, rank: i + 1, leader: b.leader ?? "" });
    }
  });
  return hits.slice(0, 5);
}

/** P15-R9 同花顺个股主力验证：对每条事件的映射板块龙头（板块榜 leader，去重 ≤3 只）
 *  逐只拉同花顺 realhead 主力净额，写进 fund.stockFunds，并按净额改写 stage/note。
 *  板块榜净额为负时旧逻辑记「无资金验证」（易误读为无数据）；新逻辑以个股同花顺真数为准：
 *  任一龙头主力净流入 >0 → 「资金验证通过」；全部 ≤0 → 「资金未验证」并写明各龙头净额。
 *  THS 拉取失败/无龙头/名→码查不到时保持原 stage/note，不谎称验证，绝不阻塞扫描。 */
export async function enrichWithThsStockFunds(items: EventScanItem[]): Promise<void> {
  const map = nameToCodeMap();
  for (const it of items) {
    const leaders = [...new Set(it.fund.boards.map((b) => b.leader).filter(Boolean))].slice(0, 3);
    if (!leaders.length) continue;
    const codes = leaders
      .map((n) => ({ name: n, code: map.get(normName(n)) ?? "" }))
      .filter((x) => x.code)
      .map((x) => ({ ...x, ths: thsCodeFromSymbol(x.code) }))
      .filter((x) => x.ths);
    if (!codes.length) continue;
    let funds: ThsStockFund[] = [];
    try {
      funds = await fetchThsStockFunds(codes.map((c) => c.ths));
    } catch {
      continue;
    }
    if (!funds.length) continue;
    const byCode = new Map(funds.map((f) => [f.code, f]));
    const stockFunds: ThsLeaderFund[] = [];
    for (const c of codes) {
      const f = byCode.get(c.code);
      if (f) stockFunds.push({ name: c.name, code: c.code, mainNetYi: f.mainNetYi, superNetYi: f.superNetYi, bigNetYi: f.bigNetYi });
    }
    if (!stockFunds.length) continue;
    it.fund.stockFunds = stockFunds;
    const inflow = stockFunds.filter((s) => s.mainNetYi > 0);
    const desc = stockFunds.map((s) => `${s.name}主力${s.mainNetYi >= 0 ? "净流入" : "净流出"} ${s.mainNetYi >= 0 ? "+" : ""}${s.mainNetYi.toFixed(2)}亿`).join("；");
    if (inflow.length) {
      it.fund.stage = "资金验证通过";
      it.fund.note = `同花顺个股验证：${desc}`;
    } else {
      it.fund.stage = "资金未验证";
      it.fund.note = `同花顺个股验证：${desc}（龙头主力均未净流入）`;
    }
  }
}

/** P15-R10 china-stock-mcp 资金流优先 + 同花顺回退：对每条事件的映射板块龙头（≤3 只）
 *  先试 MCP get_fund_flow（近 100 交易日口径，比同花顺当日更全）；MCP 未配/断线/shape 未知
 *  时该条返回空，交由同花顺兜底。实测 2026-10-16：MCP get_fund_flow 上游 RemoteDisconnected
 *  （600519、000001 均失败），故当前实际走同花顺；MCP 恢复后自动优先，无需改代码。
 *  MCP 成功时 stage/note 文案标注「MCP资金验证」，THS 成功时标注「同花顺个股验证」，互不覆盖。 */
export async function enrichWithMcpOrThsStockFunds(items: EventScanItem[]): Promise<void> {
  const map = nameToCodeMap();
  const mcpMissed: EventScanItem[] = [];
  for (const it of items) {
    const leaders = [...new Set(it.fund.boards.map((b) => b.leader).filter(Boolean))].slice(0, 3);
    if (!leaders.length) {
      mcpMissed.push(it);
      continue;
    }
    const codes = leaders
      .map((n) => ({ name: n, code: map.get(normName(n)) ?? "" }))
      .filter((x) => x.code);
    if (!codes.length) {
      mcpMissed.push(it);
      continue;
    }
    const stockFunds: ThsLeaderFund[] = [];
    for (const c of codes) {
      try {
        const ff = await fetchChinaStockFundFlow(`${c.code}.SH`);
        if (ff) stockFunds.push({ name: c.name, code: c.code, mainNetYi: ff.mainNetYi, superNetYi: ff.superNetYi ?? 0, bigNetYi: ff.bigNetYi ?? 0 });
      } catch {
        // 单只 MCP 失败跳过，交回退
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!stockFunds.length) {
      mcpMissed.push(it);
      continue;
    }
    it.fund.stockFunds = stockFunds;
    const inflow = stockFunds.filter((s) => s.mainNetYi > 0);
    const desc = stockFunds.map((s) => `${s.name}主力${s.mainNetYi >= 0 ? "净流入" : "净流出"} ${s.mainNetYi >= 0 ? "+" : ""}${s.mainNetYi.toFixed(2)}亿`).join("；");
    if (inflow.length) {
      it.fund.stage = "资金验证通过";
      it.fund.note = `MCP资金验证：${desc}`;
    } else {
      it.fund.stage = "资金未验证";
      it.fund.note = `MCP资金验证：${desc}（龙头主力均未净流入）`;
    }
  }
  // MCP 未覆盖的条目回退同花顺（保持原 enrichWithThsStockFunds 语义，不覆盖 MCP 已验证的条目）
  if (mcpMissed.length) {
    try {
      await enrichWithThsStockFunds(mcpMissed);
    } catch {
      // 保持原 fund，不谎称验证
    }
  }
}

/** 板块资金榜（4 次请求合并去重）；全量与增量两条链路共用同一份实现 */
export async function fetchBoardContext(): Promise<{ boards: BoardRow[]; missing: string[] }> {
  // R8：走带同花顺整榜兜底的单点入口。过去断源日这里整榜为空（概念/地域连腾讯备胎都没有），
  // 每条事件的资金验证都记「无资金验证」；同花顺净额榜接上后验证有真数可用。
  const [indIn, indOut, cptIn, cptOut] = await Promise.all([
    fetchBoardRowsRescued("industry", "in", 60),
    fetchBoardRowsRescued("industry", "out", 40),
    fetchBoardRowsRescued("concept", "in", 60),
    fetchBoardRowsRescued("concept", "out", 40),
  ]);
  const fromThs = [indIn, indOut, cptIn, cptOut].some((r) => r.fromThs);
  const boards = mergeBoards(
    mergeBoards(indIn.rows, indOut.rows),
    mergeBoards(cptIn.rows, cptOut.rows),
  );
  const missing: string[] = [];
  if (!boards.length) missing.push("板块榜无返回，资金验证全部为「无资金验证」");
  else if (fromThs) missing.push("板块资金为同花顺净额榜（流入−流出）：非东财主力拆分口径，净占比/超大单/大单无对等读数");
  return { boards, missing };
}

/**
 * 关键词映射 + 资金验证（逐条）。
 * 与重构前 scanGlobalEvents 的循环体逐字一致：同样的 classifyNewsTitle、同样的 themeId 判空即 unmatched、
 * 同样的 matchBoards/fundStage、同样的 relatedLeaders 取前 3、同样的 source 文案 —— 增量链路复用此函数，
 * 所以「只处理新增快讯」不会带来第二份映射实现，也就不会漂移。
 */
export function verifyNewsItems(
  news: { time: string; title: string }[],
  themes: ThemeMapItem[],
  boards: BoardRow[],
  newsSource?: string,
): { items: EventScanItem[]; unmatched: number } {
  const sourceText = newsSource === "财联社电报"
    ? "财联社电报 + 手工映射表 + 板块资金榜（财联社电报口径；断源时换东财 7x24/新浪直播）"
    : "东财7x24/新浪快讯 + 手工映射表 + 板块资金榜（东财口径；断源日为同花顺净额榜，见 fetchBoardContext 自报）";
  const items: EventScanItem[] = [];
  let unmatched = 0;
  for (const n of news) {
    const m = classifyNewsTitle(n.title, n.time, themes);
    if (!m.themeId) { unmatched++; continue; }
    const names = [...m.mappedSectors, ...m.mappedConcepts];
    const boardHits = matchBoards(names, boards);
    const fs = fundStage({ boardHits });
    items.push({
      ...m,
      fund: { stage: fs.stage, note: fs.note, boards: boardHits },
      relatedLeaders: boardHits.map((b) => b.name).slice(0, 3),
      source: sourceText,
    });
  }
  return { items, unmatched };
}

/**
 * 上游快讯窗口口径（P15-R18 改）：不再是「最新 24 条」，而是「按游标翻到跨出目标交易日为止」。
 * 旧值是 24 —— 东财 7x24 一小时就发几十条，一次日内扫描只看得见约 20 分钟的跨度，
 * 一天下来库里只剩一两条事件。翻页判定与同日去重收在 news-window-core（纯核），这里只取数与抛错。
 */

/** 快讯的最小字段形状（上游只给这两个字段，没有 id） */
export interface NewsLite { time: string; title: string }

export interface NewsWindowBundle {
  news: NewsLite[];
  /** 实际翻了源并收成当日窗口后：是否撞到翻页上限还没跨日（当日窗口可能不完整，必须如实报） */
  capped: boolean;
  /** 源自报（财联社电报 / 东财7x24 / 新浪直播），窗口覆盖的时分跨度与原始行数：写进口径说明，不靠猜 */
  detail: string;
  /** 本窗口的快讯来源（与 NewsWindow.source 一致，供逐条 source 与扫描口径如实标注） */
  source: string;
}

/** 取当日快讯窗口；取不到就抛错，不允许静默当成「今天没有事件」 */
export async function collectNewsWindow(tradeDate: string): Promise<NewsWindowBundle> {
  const win = await fetchNewsWindowForDate(tradeDate);
  if (!win || !win.items.length) throw new Error("新闻源暂不可用（财联社电报/东财7x24/新浪均无返回）");
  return {
    news: win.items,
    capped: win.capped,
    detail: `${win.source} ${win.items.length} 条（${win.spanFrom}~${win.spanTo}，翻了 ${win.fetchedRows} 条原始快讯，跨日剔除 ${win.offDay}、同键合并 ${win.duplicated}、认不出丢弃 ${win.dropped}）`,
    source: win.source,
  };
}

/** 兼容旧签名：只要快讯数组。取不到仍抛错，不静默。 */
export async function collectNews(tradeDate = shanghaiDate()): Promise<NewsLite[]> {
  return (await collectNewsWindow(tradeDate)).news;
}

export interface BoardContext { boards: BoardRow[]; missing: string[] }

export async function scanGlobalEvents(opts?: { news?: NewsLite[]; boards?: BoardContext; newsSource?: string }): Promise<{
  as_of: string;
  trade_date: string;
  items: EventScanItem[];
  unmatched: number;
  missing: string[];
  source: string;
}> {
  const themes = loadMap();
  // 增量链路会传入「只有新增的那部分快讯」和「已经取过的板块榜」，其余口径与本函数完全一致；
  // 传入 news 时来源由调用方经 newsSource 一并传入（与 collectNewsWindow 同一窗口），不猜。
  // 未传入 news 时本函数自己拉窗口，来源随窗口一起取到。
  let news: NewsLite[];
  let newsSource: string;
  if (opts?.news) {
    news = opts.news;
    newsSource = opts.newsSource ?? "";
  } else {
    const win = await collectNewsWindow(shanghaiDate());
    news = win.news;
    newsSource = win.source;
  }
  const { boards, missing } = opts?.boards ?? await fetchBoardContext();
  const { items, unmatched } = verifyNewsItems(news, themes, boards, newsSource);
  // P15-R9/R10：个股主力验证——MCP 资金流优先（100 日口径），失败回退同花顺。失败/无数据时保持板块级结论，不阻塞扫描。
  try {
    await enrichWithMcpOrThsStockFunds(items);
  } catch { /* 保持原 fund，不谎称验证 */ }

  return {
    as_of: shanghaiStamp(),
    trade_date: shanghaiDate(),
    items,
    unmatched,
    missing: [
      ...missing,
      "事件分级为关键词规则（未配置 AI 时不走 LLM）",
      "产业链映射来自 data/theme-chain-map.json 起步表，未覆盖的新闻不入库",
    ],
    source: newsSource === "财联社电报"
      ? "当日快讯窗口（财联社电报优先，决策日全天分页；断源时换东财 7x24/新浪直播）+ 手工映射表 + 板块资金榜"
      : "当日快讯全量窗口（东财7x24 优先，翻页到跨出目标交易日为止；断源时换新浪直播）+ 手工映射表 + 板块资金榜",
  };
}
