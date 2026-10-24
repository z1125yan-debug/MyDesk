// 日报新增两节：今日板块资金 + 美股（带 IO 的拉取层）。
//
// 板块资金：同花顺行业资金流榜（fetchThsBoards，与东财独立的上游）。
// 美股：长桥 MCP quote（SPY/QQQ/VOO/DIA/NVDA），未配置/失败返回 null，
// 调用方按“没取到”处理，不抛错、不阻塞日报。
// 美联储 / 预测市场：公开接口，无 Key——Polymarket Gamma public-search +
// Kalshi trade-api v2 markets；任一失败返回 null，不编数据。
// 动态相关（股票）：读本机 Feed 生成的研究快照（FEED_RESEARCH_DIR，
// 缺省为仓库同级的 workspace/feed/research），按股票关键词过滤，
// 来源标明“动态”；目录不存在/读不到 → “没取到”。

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fetchThsBoards } from "@/lib/desk/ths";
import { fetchBoardDayFlow, fetchIndustryBoardUniverse } from "@/lib/desk/em";
import { SECTOR_DRILLDOWNS } from "@/lib/desk/daily-report-sections-core";
import { fetchLongbridgeQuote } from "@/lib/desk/longbridge-mcp";
import { fetchCninfoDayAnnouncements, filterReductionRisks, reductionPlainLine } from "@/lib/desk/cninfo";
import {
  buildFedPredictionSection,
  buildFeedRelatedSection,
  buildReductionRiskSection,
  buildSectorBranchSection,
  buildSectorFlowSection,
  buildUsMarketSection,
  matchStockKeywords,
  type BranchFlowRow,
  type FedMeetingProb,
  type FedPredictionSection,
  type FeedRelatedItem,
  type FeedRelatedSection,
  type ReductionRiskSection,
  type SectorBranchSection,
  type SectorFlowSection,
  type UsMarketSection,
} from "@/lib/desk/daily-report-sections-core";

export type { BranchFlowRow, FedMeetingProb, FedPredictionSection, FeedRelatedItem, FeedRelatedSection, ReductionRiskSection, SectorBranchSection, SectorFlowSection, UsMarketSection };

/** 拉当日板块资金（同花顺行业榜）→ Top5 流入 / Top5 流出 */
export async function fetchDailySectorFlow(): Promise<SectorFlowSection> {
  try {
    const rows = await fetchThsBoards("industry");
    return buildSectorFlowSection(rows.map((r) => ({
      name: r.name,
      changePct: r.changePct,
      netYi: r.netYi,
    })));
  } catch {
    return buildSectorFlowSection([]);
  }
}

// ── 板块资金分支细分（用户 2026-10-20 定：要知道钱到底去哪了、从哪跑了）──
//
// 数据走东财：全榜极值（em.ts 的 fetchIndustryBoardUniverse）算分支 Top5，
// 下钻映射代码再走 fflow 日线（fetchBoardDayFlow）兜底——同花顺榜没有东财
// BK 代码做不了父→子下钻，而 clist 榜被限流时日线接口通常还活着。
// 时段口径与板块资金节一致：盘中取实时值、收盘后取全天值、早报盘前取上一
// 交易日收盘值。全失败 → 空行，buildSectorBranchSection 如实报“没取到”，不编。

/** 拉当日板块分支细分（东财板块全榜极值 → BK13xx 分支 Top5 + 父板块下钻） */
export async function fetchDailySectorBranches(): Promise<SectorBranchSection> {
  try {
    // 两路并行：全榜极值算分支 Top5；下钻映射代码逐个走 fflow 日线兜底
    // （clist 榜被限流 502 时日线接口通常还活着，且收盘口径一致）。
    // 日线末行 = 最近交易日：盘中是当日累计、收盘后是全天、早报盘前是上一交易日。
    const [universe, drillRows] = await Promise.all([
      fetchIndustryBoardUniverse().catch(() => []),
      (async (): Promise<BranchFlowRow[]> => {
        const defs = SECTOR_DRILLDOWNS.flatMap((d) => [
          { code: d.parentCode, name: d.parentName },
          ...d.children,
        ]);
        const got = await Promise.all(defs.map(async (def): Promise<BranchFlowRow | null> => {
          const flow = await fetchBoardDayFlow(`90.${def.code}`).catch(() => null);
          const last = flow?.days[flow.days.length - 1];
          if (!flow || !last) return null;
          return {
            code: def.code,
            // 名字优先用数据源返回的（与代码同源）；数据源没给才用映射里的已核对名
            name: flow.name || def.name,
            changePct: last.changePct,
            netYi: last.mainYi,
          };
        }));
        return got.filter((r): r is BranchFlowRow => r != null);
      })(),
    ]);
    return buildSectorBranchSection(
      universe.map((r) => ({
        code: r.code,
        name: r.name,
        changePct: r.changePct,
        netYi: r.main,
      })),
      drillRows,
    );
  } catch {
    return buildSectorBranchSection([]);
  }
}

const US_SYMBOLS: { symbol: string; label: string }[] = [
  { symbol: "SPY", label: "标普 500 ETF" },
  { symbol: "QQQ", label: "纳指 100 ETF" },
  { symbol: "VOO", label: "标普 500 ETF（VOO）" },
  { symbol: "DIA", label: "道指 ETF" },
  { symbol: "NVDA", label: "英伟达" },
];

/** 拉美股昨晚收盘（长桥 MCP）→ 小白段落 + 对 A 股的影响。openDayLabel 默认“今天”；瘦身版传下一交易日标签。 */
export async function fetchDailyUsMarket(opts?: { openDayLabel?: string }): Promise<UsMarketSection> {
  const quotes: { symbol: string; label: string; changePct: number | null; price: number | null; date: string | null }[] = [];
  for (const s of US_SYMBOLS) {
    try {
      const q = await fetchLongbridgeQuote(s.symbol);
      quotes.push({
        symbol: s.symbol,
        label: s.label,
        changePct: q?.changePct ?? null,
        price: q?.price ?? null,
        date: q?.date ?? null,
      });
    } catch {
      quotes.push({ symbol: s.symbol, label: s.label, changePct: null, price: null, date: null });
    }
  }
  return buildUsMarketSection(quotes, opts);
}

/** 日报各节一起拉（板块资金 + 分支细分 + 美股 + 美联储 + 动态），供日报页面/任务调用。usOpenDayLabel 默认“今天”；瘦身版传下一交易日标签。 */
export async function fetchDailyReportSections(opts?: { usOpenDayLabel?: string }): Promise<{
  sectorFlow: SectorFlowSection;
  sectorBranches: SectorBranchSection;
  usMarket: UsMarketSection;
  fed: FedPredictionSection;
  feedRelated: FeedRelatedSection;
}> {
  const [sectorFlow, sectorBranches, usMarket, fed, feedRelated] = await Promise.all([
    fetchDailySectorFlow(),
    fetchDailySectorBranches(),
    fetchDailyUsMarket({ openDayLabel: opts?.usOpenDayLabel }),
    fetchFedPrediction(),
    fetchFeedRelated(),
  ]);
  return { sectorFlow, sectorBranches, usMarket, fed, feedRelated };
}

/** 拉当日减持风险（巨潮公告全天 → 筛减持 → 小白段落）。拉取失败 → hasData=false，调用方按“没取到”处理。 */
export async function fetchDailyReductionRisk(tradeDate: string): Promise<ReductionRiskSection> {
  try {
    const anns = await fetchCninfoDayAnnouncements(tradeDate);
    const risks = filterReductionRisks(anns);
    return buildReductionRiskSection(risks.map((r) => ({
      code: r.ann.code,
      name: r.ann.name,
      holder: r.holder,
      stage: r.stage,
      pctInTitle: r.pctInTitle,
      riskLevel: r.riskLevel,
      plainLine: reductionPlainLine(r),
    })));
  } catch {
    return { hasData: false, total: 0, bigHolderCount: 0, rows: [], plain: "减持风险：巨潮公告没取到，算不出今天谁在减持。" };
  }
}

// ── 美联储 / 预测市场：Polymarket + Kalshi 公开接口，无 Key ──
//
// 口径统一为“加息概率 %”：
// - Polymarket：事件内“increase interest rates by …”各腿的 Yes 价之和
//   （如 25bps 腿 + 50+ bps 腿），即“本次会议加息”的总概率。
// - Kalshi：KXFEDDECISION-26OCT / -26DEC 事件内 H25 + H26 两腿的
//   买卖中间价之和（(bid+ask)/2，缺买卖价时用 last_price）。
// - 平均：两家都通取平均；只通一家用那家并在文案中注明；都不通 → “没取到”。
// 10月会议 = 10月28日（FOMC 10月27–28日，28日公布决定）；12月会议只称“12月会议”，不编具体日期。

async function fetchJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** "['Yes','No']" 或 ["Yes","No"] → 字符串数组 */
function parseStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Polymarket：某月 FOMC 事件的加息概率 %，没取到 → null */
async function fetchPolymarketHikePct(month: "October" | "December"): Promise<number | null> {
  const data = await fetchJson(
    `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(`Fed Decision in ${month}`)}`,
  );
  const events = (data as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    const e = ev as { title?: unknown; markets?: unknown };
    if (typeof e.title !== "string" || !e.title.toLowerCase().includes(`fed decision in ${month.toLowerCase()}`)) continue;
    if (!Array.isArray(e.markets)) continue;
    // 只认 2026 年的会议（public-search 也会返回 2025 年同名事件）
    const markets = e.markets.filter(
      (m) => typeof (m as { question?: unknown }).question === "string"
        && ((m as { question: string }).question.includes("2026")),
    );
    if (!markets.length) continue;
    let hike = 0;
    let legs = 0;
    for (const m of markets) {
      const mm = m as { question?: unknown; outcomes?: unknown; outcomePrices?: unknown };
      if (typeof mm.question !== "string" || !/increase interest rates by/i.test(mm.question)) continue;
      const outcomes = parseStrArray(mm.outcomes);
      const prices = parseStrArray(mm.outcomePrices);
      const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      const yesPrice = yesIdx >= 0 ? toNum(prices[yesIdx]) : null;
      if (yesPrice == null) continue;
      hike += yesPrice;
      legs += 1;
    }
    if (legs > 0) return hike * 100;
  }
  return null;
}

/** Kalshi：某次 FOMC 事件（KXFEDDECISION-26OCT / -26DEC）的加息概率 %，没取到 → null */
async function fetchKalshiHikePct(eventTicker: string): Promise<number | null> {
  const data = await fetchJson(
    `https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=50`,
  );
  const markets = (data as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(markets)) return null;
  let hike = 0;
  let legs = 0;
  for (const m of markets) {
    const mm = m as { ticker?: unknown; title?: unknown; yes_bid_dollars?: unknown; yes_ask_dollars?: unknown; last_price_dollars?: unknown };
    const isHikeLeg = (typeof mm.ticker === "string" && /-H[1-9]\d*$/.test(mm.ticker))
      // 标题兜底：必须排除 H0（“Hike rates by 0bps” = 按兵不动，不是加息）
      || (typeof mm.title === "string" && /hike rates by (?!0bps)/i.test(mm.title));
    if (!isHikeLeg) continue;
    const bid = toNum(mm.yes_bid_dollars);
    const ask = toNum(mm.yes_ask_dollars);
    const mid = bid != null && ask != null ? (bid + ask) / 2 : toNum(mm.last_price_dollars);
    if (mid == null) continue;
    hike += mid;
    legs += 1;
  }
  if (legs === 0) return null;
  return hike * 100;
}

async function fetchOneFedMeeting(
  meeting: string,
  polyMonth: "October" | "December",
  kalshiEvent: string,
): Promise<FedMeetingProb> {
  const [kalshi, poly] = await Promise.all([
    fetchKalshiHikePct(kalshiEvent),
    fetchPolymarketHikePct(polyMonth),
  ]);
  const sources: string[] = [];
  if (kalshi != null) sources.push("Kalshi");
  if (poly != null) sources.push("Polymarket");
  const available = [kalshi, poly].filter((v): v is number => v != null);
  return {
    meeting,
    kalshiHikePct: kalshi,
    polymarketHikePct: poly,
    avgHikePct: available.length ? available.reduce((a, b) => a + b, 0) / available.length : null,
    sources,
  };
}

/** 拉美联储 / 预测市场：10月28日 + 12月会议的加息概率（Kalshi + Polymarket 平均） */
export async function fetchFedPrediction(): Promise<FedPredictionSection> {
  try {
    const [oct, dec] = await Promise.all([
      fetchOneFedMeeting("10月28日", "October", "KXFEDDECISION-26OCT"),
      fetchOneFedMeeting("12月", "December", "KXFEDDECISION-26DEC"),
    ]);
    return buildFedPredictionSection([oct, dec]);
  } catch {
    return buildFedPredictionSection([
      { meeting: "10月28日", kalshiHikePct: null, polymarketHikePct: null, avgHikePct: null, sources: [] },
      { meeting: "12月", kalshiHikePct: null, polymarketHikePct: null, avgHikePct: null, sources: [] },
    ]);
  }
}

// ── 动态相关（股票）：读本机 Feed 生成的研究快照，按股票关键词过滤 ──

const FEED_RESEARCH_DIR = resolveFeedResearchDir();

/**
 * Feed 研究快照目录解析（2026-10-17 修通：之前只认 process.cwd() 相对路径，
 * cwd 一变就读不到，误报“本地 Feed 目录为空”）。
 * 候选顺序：环境变量 FEED_RESEARCH_DIR → cwd 同级 ../feed/research →
 * $HOME/workspace/feed/research → cwd 下 feed/research。取第一个存在的目录。
 */
function resolveFeedResearchDir(): string {
  const candidates = [
    process.env.FEED_RESEARCH_DIR,
    path.join(process.cwd(), "..", "feed", "research"),
    process.env.HOME ? path.join(process.env.HOME, "workspace", "feed", "research") : "",
    path.join(process.cwd(), "feed", "research"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // 不存在 → 下一个
    }
  }
  return candidates[0] ?? path.join(process.cwd(), "..", "feed", "research");
}

/** 解析一篇 Feed 研究 md：每个 "## 标题" 为一条，取正文 + 首个链接 + published 日期 */
function parseFeedResearchMd(text: string): { title: string; summary: string; sourceUrl: string | null; published: string | null }[] {
  const lines = text.split("\n");
  const items: { title: string; summary: string; sourceUrl: string | null; published: string | null }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const urlMatch = body.match(/https?:\/\/[^\s)\]]+/);
    const pubMatch = body.match(/published\s+(\d{4}-\d{2}-\d{2})/);
    const summary = cur.body
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("- http") && !/published\s+\d{4}-\d{2}-\d{2}/.test(l))
      .join(" ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .slice(0, 300);
    items.push({
      title: cur.title,
      summary,
      sourceUrl: urlMatch ? urlMatch[0] : null,
      published: pubMatch ? pubMatch[1] : null,
    });
    cur = null;
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      cur = { title: line.slice(3).trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  flush();
  return items.filter((it) => it.title);
}

/** 拉动态相关（股票）：最近 5 次 Feed 生成的研究快照 → 股票关键词过滤，来源标“动态”。
 * opts.afterDate：只取目录名日期前缀 >= afterDate 的生成目录（瘦身版传 issueDate 前一天，
 * 即“最近 24 小时内”）；不传则不限。opts.windowLabel：时间窗口文案，传给 buildFeedRelatedSection。 */
export async function fetchFeedRelated(opts?: { afterDate?: string; windowLabel?: string }): Promise<FeedRelatedSection> {
  try {
    const promptDirs = await fs.readdir(FEED_RESEARCH_DIR, { withFileTypes: true });
    // 收集各 prompt 下的生成目录，按目录名（日期开头）倒序，取最近 5 次
    const runDirs: string[] = [];
    for (const d of promptDirs) {
      if (!d.isDirectory()) continue;
      const sub = await fs.readdir(path.join(FEED_RESEARCH_DIR, d.name), { withFileTypes: true });
      for (const s of sub) {
        if (!s.isDirectory()) continue;
        // 24 小时窗口：目录名以 YYYY-MM-DD 开头，早于 afterDate 的生成目录跳过
        if (opts?.afterDate && s.name.slice(0, 10) < opts.afterDate) continue;
        runDirs.push(path.join(FEED_RESEARCH_DIR, d.name, s.name));
      }
    }
    runDirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    const latest = runDirs.slice(0, 5);
    if (!latest.length) return buildFeedRelatedSection([], null, opts?.windowLabel);
    const seen = new Set<string>();
    const related: FeedRelatedItem[] = [];
    let checkedCount = 0;
    for (const dir of latest) {
      const files = await fs.readdir(dir);
      for (const f of files.filter((x) => x.endsWith(".md")).sort().reverse()) {
        const text = await fs.readFile(path.join(dir, f), "utf-8");
        for (const it of parseFeedResearchMd(text)) {
          checkedCount += 1;
          if (seen.has(it.title)) continue;
          seen.add(it.title);
          const matched = matchStockKeywords(it.title, it.summary);
          if (!matched.length) continue;
          related.push({ ...it, matchedKeywords: matched, source: "动态" });
        }
      }
    }
    return buildFeedRelatedSection(related.slice(0, 10), checkedCount, opts?.windowLabel);
  } catch {
    return buildFeedRelatedSection([], null, opts?.windowLabel);
  }
}
