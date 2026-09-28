// P15-R19 逐票收盘价回填的纯核：把「已取到的日K行」变成 stock_daily_close 待写行。
// 零 IO、零时钟、零网络 —— 取数在路由里，判定全在这里（可被 node --test 直接钉）。
//
// 为什么要回填这一张表（口径变更，写清楚别当偷偷改了）：
//   breadth-collect 的「收盘后自产」只会从今天起攒行——它拿不到昨天的快照价。
//   而见顶预警/市场环境分位要的是**历史序列**：晋级率、龙头滞涨、站上5日线占比自校验，
//   没有历史就只能是「样本 1 天」。种子里有 110 天的市场级读数，但没有逐票价，
//   所以这一段只能从真实日线源接：新浪日K（**不复权原始价**，与本表「收盘价=当日价格读数」同口径；
//   腾讯那路是 qfq 前复权，除权日会把历史价改小，混进来就等于一列两种口径）。
//
// 三条不许绕的纪律：
//   1) 只写真实读到的格子：非 finite / ≤0 的收盘价不写行（缺就是缺，宽度分母只数真有行的票）；
//   2) 只认已收盘的日期：调用方给的 from/to 之外一律丢弃；to 的上限由路由夹到「昨日」，
//      盘中价永远不进这张表（与 breadth-collect 的 15:05 闸同一目的）；
//   3) 已有键不重写：与自产行撞日时自产说了算（自产是收盘后快照，回填是事后日线，
//      两者本应相等，不等时不做静默覆盖，只把差异报出来让人去看）。

import type { BarsLike } from "../factors/fields.ts";

export type BackfillRow = { symbol: string; tradeDate: string; close: number; name: string };

export type BarEntry = {
  symbol: string;
  name?: string;
  /** null = 这一只没取到（网络失败或源无返回）；[] = 取到了但一行不落在窗口内 */
  bars: BarsLike[] | null;
};

export type SliceOutcome = {
  symbols: number;
  hadBars: number;   // 取到 K 线的只数
  noBars: number;    // 取数失败/无返回的只数
  rows: BackfillRow[];
  dirty: number;     // 被丢掉的坏价格子数
  outOfRange: number; // 落在窗口外的格子数（正常是首尾两根）
  duplicate: number;  // 同票同日重复格子数（取首条）
  dates: string[];    // 本批真实覆盖到的交易日（升序）
};

/** 位置无关的窗口判定：YYYY-MM-DD 同格式可以直接比大小 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function rowsFromBars(entries: readonly BarEntry[], from: string, to: string): SliceOutcome {
  const out: SliceOutcome = {
    symbols: entries.length, hadBars: 0, noBars: 0,
    rows: [], dirty: 0, outOfRange: 0, duplicate: 0, dates: [],
  };
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return out; // 脏窗口：一条都不写
  const seen = new Set<string>();
  const dateSet = new Set<string>();

  for (const e of entries) {
    if (!e.bars || !e.bars.length) { out.noBars++; continue; }
    out.hadBars++;
    let wrote = 0;
    for (const b of e.bars) {
      const date = String(b.date ?? "").slice(0, 10); // 新浪给 "2026-06-01"，个别源带时刻也只取日
      if (!DATE_RE.test(date)) { out.dirty++; continue; }
      if (date < from || date > to) { out.outOfRange++; continue; }
      const close = b.c;
      if (typeof close !== "number" || !isFinite(close) || close <= 0) { out.dirty++; continue; }
      const key = `${e.symbol}|${date}`;
      if (seen.has(key)) { out.duplicate++; continue; } // 同票同日取首条，不重复写
      seen.add(key);
      out.rows.push({ symbol: e.symbol, tradeDate: date, close, name: e.name ?? "" });
      dateSet.add(date);
      wrote++;
    }
    if (!wrote) out.noBars++; // 取到了但窗口内一根没有（新上市/长期停牌）——按「没数」计，不冒充覆盖
  }

  out.rows.sort((a, b) => (a.symbol === b.symbol ? (a.tradeDate < b.tradeDate ? -1 : 1) : a.symbol < b.symbol ? -1 : 1));
  out.dates = [...dateSet].sort();
  return out;
}

/**
 * 与已有行（含收盘自产行）的撞键判定：已有的键一律不写，只把「同键不同价」的差异数报出来。
 * 差异不静默修——自产价与事后日线价本该相等，不等就说明某一侧口径有问题，得让人去查。
 */
export function splitFreshRows(
  rows: readonly BackfillRow[],
  existing: readonly { symbol: string; tradeDate: string; close: number }[],
): { fresh: BackfillRow[]; existingKeys: number; priceMismatch: { symbol: string; tradeDate: string; stored: number; incoming: number }[] } {
  const map = new Map(existing.map((r) => [`${r.symbol}|${r.tradeDate}`, r.close]));
  const fresh: BackfillRow[] = [];
  const priceMismatch: { symbol: string; tradeDate: string; stored: number; incoming: number }[] = [];
  let existingKeys = 0;
  for (const r of rows) {
    const key = `${r.symbol}|${r.tradeDate}`;
    if (!map.has(key)) { fresh.push(r); continue; }
    existingKeys++;
    const stored = map.get(key) as number;
    // 价格源有小数位差（快照两位、日线三位等）不算打架；差到 0.5 分钱以上才报
    if (Math.abs(stored - r.close) > 0.005) priceMismatch.push({ symbol: r.symbol, tradeDate: r.tradeDate, stored, incoming: r.close });
  }
  return { fresh, existingKeys, priceMismatch };
}

/** 回填这一路的固定口径句（页面/接口/验收同一份措辞，不散落各写各的） */
export const BACKFILL_CALIBER =
  "历史逐票收盘价由新浪日K（不复权原始价）按真实交易日回填，只补库里没有的键；当日收盘行仍由收盘后调度器自产，回填不覆盖它";
