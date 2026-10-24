// 定时价格快照 · 拉取层（带 IO）。
//
// 快照口径（见 price-snapshots-core.ts 的钉死口径，2026-10-17 修正卖出日）：
//   · 完整生命周期：D 选股（收盘后，决策日）→ D+1 开盘买 → D+2 卖。
//     三个快照是卖出日 D+2 的三个候选卖点：10:30 / 11:30 休盘 / 15:00 收盘。
//     买入日（D+1）/ 选股日（D）的价格不是卖点，不抓。没有任何版本在今天卖出时
//     写“今日无卖出快照”，不要抓买入日/选股日的价格。
//   · 10:30 / 11:30 休盘：必须当时现抓——用 TDX 实时快照（tdxQuotes），
//     事后拿日K还原不了当时的盘中价。错过之后再补抓，抓到的是“现在”的价，
//     不是当时的价，本层会在 capturedAt 里照实写抓取时刻，调用方不要把晚抓的
//     当当时的价。
//   · 15:00 收盘：优先 DB 日K沉淀价（StockDailyBar，当日收盘定稿）；DB 没有才用
//     TDX 现抓（收盘后 TDX 价 = 收盘价，已冻结）。
//   · 成本（卖出日之前最近一个交易日收盘价，D+1 收盘）：日报生成时直接从 DB 日K取，
//     不用等、不抓快照。DB 读不到 → 成本 null，涨跌幅算不出，但价格对比仍可比。
//     注意：此口径 ≠ T+1 收益（D+2 卖价 vs D+1 开盘买入价再扣 0.41%），两者差 D+1
//     开盘→收盘那段。本任务不擅自改成本基数，只把关系写明，供用户确认。
//
// 落档：data/price-snapshots/<date>-<slot>.json；同日同份重复抓取直接覆盖
// （快照以最后一次抓取为准，capturedAt 照实写，不假装第一次）。
// 缺数据就说“没取到”，不编、不拿别的时间的价顶替。

import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { tdxDayBars, tdxQuotes } from "@/lib/desk/tdx";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { tradingDaysAfter } from "@/lib/desk/trade-calendar";
import {
  listAllAiPickVersions,
  type AiPickVersion,
} from "@/lib/quant/strategy/ai-pick-versions";
import {
  changePctOf,
  compareSellPair,
  compareSellWindows,
  isSnapshotSlot,
  sellDayOfDecision,
  versionsSellingOnDate,
  sellWindowSectionPlain,
  snapshotDefOf,
  type PriceSnapshot,
  type PriceSnapshotRow,
  type SellWindowComparison,
  type SnapshotSlot,
} from "@/lib/desk/price-snapshots-core";

export type { PriceSnapshot, PriceSnapshotRow, SellWindowComparison, SnapshotSlot };
export { isSnapshotSlot, snapshotDefOf };

const SNAPSHOTS_DIR = path.join(process.cwd(), "data", "price-snapshots");

function fileOf(date: string, slot: SnapshotSlot): string {
  return path.join(SNAPSHOTS_DIR, `${date}-${slot}.json`);
}

export async function readPriceSnapshot(
  date: string,
  slot: SnapshotSlot,
): Promise<PriceSnapshot | null> {
  try {
    const raw = await fs.readFile(fileOf(date, slot), "utf-8");
    const parsed = JSON.parse(raw) as PriceSnapshot;
    if (parsed?.date === date && parsed?.slot === slot) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function persistSnapshot(snap: PriceSnapshot): Promise<void> {
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
  await fs.writeFile(fileOf(snap.date, snap.slot), JSON.stringify(snap, null, 2), "utf-8");
}

/** 默认快照票池：最新 AI 优选的票 + 大盘指数（上证 / 深证 / 创业板 / 沪深300）。只读 DB，不重跑模型。 */
export const SNAPSHOT_INDEX_SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "000001.SH", name: "上证指数" },
  { symbol: "399001.SZ", name: "深证成指" },
  { symbol: "399006.SZ", name: "创业板指" },
  { symbol: "000300.SH", name: "沪深300" },
];

/** 统一符号格式：sh000001 / 000001.SH → 000001.SH；600519.SH → 600519.SH */
function normalizeSymbol(symbol: string): string {
  const m = /^(sh|sz|bj)(\d{6})$/i.exec(symbol.trim());
  if (m) return `${m[2]}.${m[1].toUpperCase()}`;
  return symbol.trim().toUpperCase();
}

/** 统一符号格式：sh000001 / 000001.SH → 000001.SH；600519.SH → 600519.SH（API 层共用） */
export function normalizeSnapshotSymbol(symbol: string): string {
  return normalizeSymbol(symbol);
}

/** 指数的 DB 日K可能缺（上证 000001.SH 在 stock_daily_bar 里就没有），缺时回退 TDX 日K。 */
const INDEX_SYMBOLS = new Set([
  "000001.SH", "000300.SH", "000016.SH", "000905.SH",
  "399001.SZ", "399006.SZ", "399005.SZ",
]);
function isIndexSymbol(symbol: string): boolean {
  return INDEX_SYMBOLS.has(normalizeSymbol(symbol));
}

/**
 * 某日卖出日的版本票池：卖出日 = 决策日 D 之后的第 2 个交易日（D+2）。
 * 只返回“卖出日 = date”的那些版本的票并集。买入日（D+1）/ 选股日（D）的版本不在这里。
 * 没有任何版本在 date 卖出时 picks 为 []——调用方不要拿买入日/选股日的价格顶替。
 */
export async function sellDaySnapshotPool(
  date: string,
  dir?: string,
): Promise<{ decisionDate: string | null; versions: AiPickVersion[]; picks: { symbol: string; name: string }[] }> {
  const all = await listAllAiPickVersions(dir);
  const decisions = [...new Set(all.map((v) => v.tradeDate))].sort();
  const sellDayByDecision = new Map<string, string | null>(
    decisions.map((d) => [d, sellDayOfDecision(d, tradingDaysAfter(d, 2))]),
  );
  const found = versionsSellingOnDate(all, date, sellDayByDecision);
  return { decisionDate: found.decisionDate, versions: found.versions as AiPickVersion[], picks: found.picks };
}

/**
 * 默认快照票池：指数 + “卖出日 = date”的 AI 优选版本票并集。只读，不重跑模型。
 * date 不传时取今天（上海日期）。
 * 没有任何版本在 date 卖出时只返回指数——调用方（API 抓取）必须据此跳过抓取、
 * 写“今日无卖出快照”，不要抓买入日/选股日的价格。
 * 注意：旧口径（取今天之前最近一个决策日 = 买入日 D+1 的票）是错的，已废弃；
 * StrategyPick 最新行回退也一并废弃（它同样是买入日口径）。
 */
export async function defaultSnapshotSymbols(
  date: string = shanghaiDate(new Date()),
  dir?: string,
): Promise<{ symbol: string; name: string }[]> {
  const out: { symbol: string; name: string }[] = [...SNAPSHOT_INDEX_SYMBOLS];
  const push = (symbol: string, name: string) => {
    const sym = normalizeSymbol(symbol);
    if (!out.some((o) => o.symbol === sym)) out.push({ symbol: sym, name: name || sym });
  };
  const pool = await sellDaySnapshotPool(date, dir);
  for (const s of pool.picks) push(s.symbol, s.name);
  return out;
}

/** 某日是否有 AI 优选版本到卖出日（快照/日报用：没有时写“今日无卖出快照”，不要抓买入日/选股日的价格） */
export async function hasSellDayVersions(date: string, dir?: string): Promise<boolean> {
  const pool = await sellDaySnapshotPool(date, dir);
  return pool.picks.length > 0;
}

/** 某票某日之前的最近一个交易日收盘价（DB 日K）= 该日的成本（昨天收盘价）；指数 DB 缺时回退 TDX 日K；找不到 → null */
async function prevCloseFromBars(symbol: string, beforeDate: string): Promise<number | null> {
  const sym = normalizeSymbol(symbol);
  try {
    const bar = await db.stockDailyBar.findFirst({
      where: { symbol: sym, tradeDate: { lt: beforeDate } },
      orderBy: { tradeDate: "desc" },
      select: { close: true },
    });
    if (bar && Number.isFinite(bar.close)) return bar.close;
  } catch {
    // DB 读失败时继续回退 TDX（指数）或返回 null
  }
  if (isIndexSymbol(sym)) {
    try {
      const bars = await tdxDayBars(sym, 10);
      const prev = (bars ?? []).filter((b) => b.date < beforeDate).sort((a, b) => b.date.localeCompare(a.date))[0];
      if (prev && Number.isFinite(prev.c)) return prev.c;
    } catch {
      // TDX 也拿不到 → null
    }
  }
  return null;
}

/** 某票某日的收盘价（DB 日K沉淀价）；指数 DB 缺时回退 TDX 日K；找不到 → null */
async function closeFromBars(symbol: string, date: string): Promise<number | null> {
  const sym = normalizeSymbol(symbol);
  try {
    const bar = await db.stockDailyBar.findFirst({
      where: { symbol: sym, tradeDate: date },
      orderBy: { tradeDate: "desc" },
      select: { close: true },
    });
    if (bar && Number.isFinite(bar.close)) return bar.close;
  } catch {
    // DB 读失败时继续回退 TDX（指数）或返回 null
  }
  if (isIndexSymbol(sym)) {
    try {
      const bars = await tdxDayBars(sym, 5);
      const hit = (bars ?? []).find((b) => b.date === date);
      if (hit && Number.isFinite(hit.c)) return hit.c;
    } catch {
      // TDX 也拿不到 → null
    }
  }
  return null;
}

/**
 * 抓一张快照并落档。
 * symbols 为空时用默认票池（卖出日 = 今天的 AI 优选版本票 + 指数）。
 * 注意：API 层已做卖出日门禁（无版本在今天卖出时不调用本函数，直接返回“今日无卖出快照”）。
 * 直接调用本函数时请先自行确认今天有版本卖出，否则会落一张只有指数的快照。
 * 返回的 capturedAt 照实写抓取时刻；10:30 / 11:30 快照若在对应时刻之后才抓，
 * 抓到的是抓取时刻的价，调用方不要把它当对应时刻的价（capturedAt 可查）。
 * 成本（卖出日之前最近一个交易日收盘价）不随快照落档：日报生成时从 DB 现取，保证成本口径统一。
 */
export async function capturePriceSnapshot(
  slot: SnapshotSlot,
  symbols?: { symbol: string; name: string }[],
  now = new Date(),
): Promise<PriceSnapshot> {
  const date = shanghaiDate(now);
  const capturedAt = shanghaiStamp(now);
  const rawList = symbols?.length ? symbols : await defaultSnapshotSymbols();
  // 统一符号格式（sh000001 → 000001.SH），保证 DB / TDX 两边查的是同一只
  const list = rawList.map((s) => ({ symbol: normalizeSymbol(s.symbol), name: s.name }));
  const rows: PriceSnapshotRow[] = [];
  const missingSymbols: string[] = [];

  if (slot === "1030" || slot === "1130") {
    // 必须现抓：TDX 实时快照。prevClose 取 TDX 给的前收（即卖出日之前最近一个交易日收盘价，成本）。
    const quotes = await tdxQuotes(list.map((s) => s.symbol)).catch(() => null);
    for (const s of list) {
      const q = quotes?.get(s.symbol);
      if (!q) {
        rows.push({ symbol: s.symbol, name: s.name, price: null, prevClose: null, changePct: null });
        missingSymbols.push(s.symbol);
        continue;
      }
      rows.push({
        symbol: s.symbol,
        name: s.name,
        price: q.price,
        prevClose: q.prevClose,
        changePct: changePctOf(q.price, q.prevClose),
      });
    }
  } else {
    // close：优先 DB 日K沉淀价（收盘定稿）。
    // DB 还没有当日收盘价时：15:00 之后才可用 TDX 现抓（收盘后已冻结 = 收盘价）；
    // 15:00 之前收盘价根本不存在，绝不用盘中价冒充收盘价（缺就是缺）。
    const beijingMin =
      new Date(now.getTime() + 8 * 60 * 60 * 1000).getUTCHours() * 60 +
      new Date(now.getTime() + 8 * 60 * 60 * 1000).getUTCMinutes();
    const quotes = beijingMin >= 15 * 60
      ? await tdxQuotes(list.map((s) => s.symbol)).catch(() => null)
      : null;
    for (const s of list) {
      const barClose = await closeFromBars(s.symbol, date);
      const prev = await prevCloseFromBars(s.symbol, date);
      const price = barClose ?? quotes?.get(s.symbol)?.price ?? null;
      if (price == null) {
        rows.push({ symbol: s.symbol, name: s.name, price: null, prevClose: prev, changePct: null });
        missingSymbols.push(s.symbol);
        continue;
      }
      rows.push({ symbol: s.symbol, name: s.name, price, prevClose: prev, changePct: changePctOf(price, prev) });
    }
  }

  const snap: PriceSnapshot = {
    date,
    slot,
    label: snapshotDefOf(slot).label,
    capturedAt,
    rows,
    missingSymbols,
  };
  await persistSnapshot(snap);
  return snap;
}

/**
 * 读某日卖点对比（供日报用）：成本（卖出日之前最近一个交易日收盘价，DB 现取）+ 三个卖点（10:30 / 11:30 休盘 / 15:00 收盘）。
 * 三个卖点没有落档就是没有，不拿“现在”的价顶替。
 * 涨跌幅统一以成本（卖出日之前最近一个交易日收盘价）为基数重算，不沿用快照行里各自的 prevClose，
 * 保证三个卖点的涨跌幅基数相同、可以直接比。
 */
export async function readSellComparisons(
  date: string,
  symbols?: { symbol: string; name: string }[],
): Promise<{
  comparisons: SellWindowComparison[];
  snapshotsFound: SnapshotSlot[];
  /** 该日卖出日的决策日；null = 没有任何版本在该日卖出（不要拿买入日/选股日的价格顶替） */
  sellDecisionDate: string | null;
}> {
  const explicit = symbols?.length ? symbols : undefined;
  const list = explicit ?? (await defaultSnapshotSymbols(date));
  const pool = explicit ? null : await sellDaySnapshotPool(date);
  const sellDecisionDate = explicit ? null : pool?.decisionDate ?? null;
  const [s1030, s1130, close] = await Promise.all([
    readPriceSnapshot(date, "1030"),
    readPriceSnapshot(date, "1130"),
    readPriceSnapshot(date, "close"),
  ]);
  const found: SnapshotSlot[] = [];
  if (s1030?.rows.some((r) => r.price != null)) found.push("1030");
  if (s1130?.rows.some((r) => r.price != null)) found.push("1130");
  if (close?.rows.some((r) => r.price != null)) found.push("close");

  const by1030 = new Map((s1030?.rows ?? []).map((r) => [r.symbol, r.price]));
  const by1130 = new Map((s1130?.rows ?? []).map((r) => [r.symbol, r.price]));
  const byClose = new Map((close?.rows ?? []).map((r) => [r.symbol, r.price]));

  const comparisons = await Promise.all(list.map(async (s) => {
    // 成本 = 卖出日之前最近一个交易日收盘价（DB 现取）
    const cost = await prevCloseFromBars(s.symbol, date);
    const p1030 = by1030.get(s.symbol) ?? null;
    const p1130 = by1130.get(s.symbol) ?? null;
    const pClose = byClose.get(s.symbol) ?? null;
    return compareSellWindows(s.symbol, s.name, cost, {
      "1030": { price: p1030, changePct: changePctOf(p1030, cost) },
      "1130": { price: p1130, changePct: changePctOf(p1130, cost) },
      close: { price: pClose, changePct: changePctOf(pClose, cost) },
    });
  }));
  return { comparisons, snapshotsFound: found, sellDecisionDate };
}

/** 三个卖点对比 → 日报一节的文案（小白语言，每句带当时时间） */
export async function sellWindowSection(
  date: string,
  symbols?: { symbol: string; name: string }[],
): Promise<string> {
  const { comparisons, snapshotsFound, sellDecisionDate } = await readSellComparisons(date, symbols);
  // 没有版本在该日卖出 → 不是“快照没取到”，是本来就没有卖点要对比
  if (!symbols?.length && sellDecisionDate == null) {
    return "什么时候卖最合适（10:30 / 11:30 休盘 / 15:00 收盘对比）：今天没有 AI 优选版本到卖出日（卖出日 = 决策日之后第 2 个交易日），没有卖点要对比。买入日/选股日的价格不是卖点，不抓、不拿来比。";
  }
  if (!snapshotsFound.length) {
    return "什么时候卖最合适（10:30 / 11:30 休盘 / 15:00 收盘对比）：三张快照（10:30 / 11:30 休盘 / 15:00 收盘）都没取到，算不出什么时候卖最合适。快照需在对应时刻触发抓取（10:30、11:30 现抓、收盘后记收盘价），事后补不出来当时的盘中价。";
  }
  const labels = (["1030", "1130", "close"] as const)
    .filter((s) => snapshotsFound.includes(s))
    .map((s) => snapshotDefOf(s).label);
  const note = `（已取到的快照：${labels.join("、")}；缺的时刻写“没取到”，不拿别的时间的价顶替。成本是卖出日之前最近一个交易日收盘价。）`;
  return `${sellWindowSectionPlain(comparisons)}${note}`;
}

/**
 * 午报卖点对比（两点：10:30 vs 11:30 休盘）。午报 12:00 时收盘价还没出，
 * 比不了收盘，只比“10:30 卖”和“11:30 休盘卖”。成本 = 卖出日之前最近一个交易日收盘价（DB 现取）。
 */
export async function sellPairSectionNoon(
  date: string,
  symbols?: { symbol: string; name: string }[],
): Promise<string> {
  // 没有版本在该日卖出 → 不是“快照没取到”，是本来就没有卖点要对比
  if (!symbols?.length && !(await hasSellDayVersions(date))) {
    return "什么时候卖最合适（午报两点对比：10:30 vs 11:30 休盘，收盘还没发生，比不了收盘）：今天没有 AI 优选版本到卖出日（卖出日 = 决策日之后第 2 个交易日），没有卖点要对比。买入日/选股日的价格不是卖点，不抓、不拿来比。";
  }
  const list = symbols?.length ? symbols : await defaultSnapshotSymbols(date);
  const [s1030, s1130] = await Promise.all([
    readPriceSnapshot(date, "1030"),
    readPriceSnapshot(date, "1130"),
  ]);
  if (!s1030 && !s1130) {
    return "什么时候卖最合适（午报两点对比：10:30 vs 11:30 休盘，收盘还没发生，比不了收盘）：10:30 和 11:30 休盘的快照都没取到，比不出哪个时间卖最合适。10:30、11:30 快照需在当时现抓，事后补不出来。";
  }
  const lines: string[] = [];
  for (const s of list) {
    const cost = await prevCloseFromBars(s.symbol, date);
    const p1030 = s1030?.rows.find((r) => r.symbol === s.symbol)?.price ?? null;
    const p1130 = s1130?.rows.find((r) => r.symbol === s.symbol)?.price ?? null;
    lines.push(compareSellPair(s.symbol, s.name, cost,
      { label: "10:30", price: p1030, changePct: changePctOf(p1030, cost) },
      { label: "11:30 休盘", price: p1130, changePct: changePctOf(p1130, cost) },
    ));
  }
  return `什么时候卖最合适（午报两点对比：10:30 vs 11:30 休盘，收盘还没发生，比不了收盘）：${lines.join(" ")}`;
}
