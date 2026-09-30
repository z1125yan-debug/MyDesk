// P36-C 战绩回填纯核（2026-10-01）
//
// 为什么要有这一层：台账此前只记「推荐了哪条策略」，次日只回填大盘方向，
// 于是「跟着推荐到底赚没赚」永远答不上来（实测库里 8 行、nextDayMktChg 全 null）。
// 具体票必须落到票级，而且回填口径必须与回测口径是同一套——否则
// 「历史说 +2.86%、实盘记 −0.4%」会在同一块屏上打架，谁都不信。
//
// 口径（与 backtest/event-core.ts 逐字一致，不许在这里另起一套）：
//   T 日收盘后推荐 → T+1 开盘价买入 → T+2 开盘价卖出 → 扣往返手续费（0.41%）
//   T+1 开盘一字涨停 / 停牌无价 → 这笔根本买不进，**剔除**，绝不记成「收益 0」
//   （记 0 = 把「没买」当成「买了没赚」，会把胜率整体拉低，是另一种假）
//
// 基准：同期「全A中位个股」用同一套口径算出来的净收益。
// 为什么不是沪深300：推荐的是个股，及格线就该是「随便买只票」；拿指数对比是在挑软柿子。
//
// 本核零 IO、零时钟，可被 node:test 直跑。

import { eventOutcomeOf, type EventOutcome } from "../backtest/event-core.ts";
import { limitRatio } from "../factors/fields.ts";

/** 台账里的一只票（记录当天写死，回填时不再依赖任何历史行情） */
export interface PickSym {
  symbol: string;
  name?: string;
  /** T 日收盘价：判「T+1 是否一字涨停」要用；没有就判不了，按可成交处理并在 reason 里写明 */
  close?: number | null;
}

export function parseSymbols(json: string | null | undefined): PickSym[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
      .filter((x): x is Record<string, unknown> => !!x)
      .map((x) => ({
        symbol: String(x.symbol ?? "").trim(),
        name: typeof x.name === "string" ? x.name : "",
        close: typeof x.close === "number" && isFinite(x.close) ? x.close : null,
      }))
      .filter((x) => x.symbol.length > 0);
  } catch {
    return [];
  }
}

export function symJsonOf(syms: readonly PickSym[]): string {
  return JSON.stringify(syms.map((s) => ({ symbol: s.symbol, name: s.name ?? "", close: s.close ?? null })));
}

/** 一只票在 T+1 / T+2 两个交易日的开盘价（回填时从库里读出来喂进来） */
export interface SymQuoteRow {
  symbol: string;
  /** T+1 开盘（买入价）；null=停牌/无价 */
  t1Open: number | null;
  /** T+2 开盘（卖出价）；null=还没到或停牌 */
  t2Open: number | null;
}

export interface SymFill {
  symbol: string;
  name: string;
  tradable: boolean;
  /** 不可成交/缺数的原因，说人话，直接给页面用 */
  reason: string | null;
  /** 扣费后净收益 %；买不进或没数 → null */
  net: number | null;
  /** 毛收益 %（只作对照，页面不展示） */
  gross: number | null;
}

/** 单只票的回填结果。缺行情写 reason，绝不静默记 0 */
export function symFillOf(sym: PickSym, q: SymQuoteRow | undefined): SymFill {
  const name = sym.name ?? "";
  if (!q) {
    return { symbol: sym.symbol, name, tradable: false, reason: "库里没有这两天的行情", net: null, gross: null };
  }
  const o: EventOutcome = eventOutcomeOf({
    entryOpen: q.t1Open,
    signalClose: sym.close ?? null,
    limitRatio: limitRatio(sym.symbol, name),
    exitOpen1: q.t2Open,
  });
  return {
    symbol: sym.symbol,
    name,
    tradable: o.tradable,
    reason: o.tradable ? null : (o.blockedReason ?? "买不进"),
    net: o.net1,
    gross: o.gross1,
  };
}

export interface FillStat {
  /** 参与统计只数（真买得进且算得出收益） */
  n: number;
  /** 净收益为正的只数 */
  up: number;
  /** 等权平均净收益 %（扣费后） */
  avgNet: number;
  /** 因一字涨停/停牌被剔除的只数 */
  skipped: number;
  /** 库里缺行情的只数 */
  missing: number;
}

/** 一批票的汇总。一只都算不出来 → 返回 null（不许拿 0 冒充成绩） */
export function fillStatOf(fills: readonly SymFill[]): FillStat | null {
  let n = 0, up = 0, sum = 0, skipped = 0, missing = 0;
  for (const f of fills) {
    if (f.reason === "库里没有这两天的行情") { missing++; continue; }
    if (!f.tradable) { skipped++; continue; }
    if (f.net == null || !Number.isFinite(f.net)) continue;
    n++;
    if (f.net > 0) up++;
    sum += f.net;
  }
  if (!n) return null;
  return { n, up, avgNet: sum / n, skipped, missing };
}

export function medianOf(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? (a[m] as number) : ((a[m - 1] as number) + (a[m] as number)) / 2;
}

/**
 * 全A基准：同一天、同一套成交口径下「随便买只票」的中位净收益。
 * 输入是每只票的净收益（已按同样的剔除规则处理过），取中位数——抗极端值，
 * 不用均值（A 股少数票一天拉 20% 会把均值带跑）。
 */
export function benchNetOf(nets: readonly number[]): number | null {
  return medianOf(nets.filter((x) => Number.isFinite(x)));
}

// ---- 净值曲线 ----

export interface DayNet {
  tradeDate: string;
  /** 当日跟单组合的平均净收益 %（当日所有推荐行等权） */
  net: number | null;
  /** 当日全A中位个股净收益 % */
  bench: number | null;
}

export interface NavPoint {
  tradeDate: string;
  /** 跟单净值（起点 1） */
  nav: number;
  /** 全A中位净值（起点 1） */
  benchNav: number;
  /** 当天有没有真样本（没样本的那天净值原地不动，但不许假装参与了） */
  hasSample: boolean;
}

/**
 * 逐日累乘成净值。缺样本的那天净值不变（不是「收益 0」——那是没买，不是买了不赚）。
 * 两条线都从 1 出发，页面一眼能看出「跟单」有没有跑赢「随便买」。
 */
export function navSeriesOf(days: readonly DayNet[]): NavPoint[] {
  let nav = 1;
  let benchNav = 1;
  const out: NavPoint[] = [];
  for (const d of days) {
    const hasSample = d.net != null && Number.isFinite(d.net as number);
    if (hasSample) nav *= 1 + (d.net as number) / 100;
    if (d.bench != null && Number.isFinite(d.bench)) benchNav *= 1 + d.bench / 100;
    out.push({
      tradeDate: d.tradeDate,
      nav: Math.round(nav * 1e6) / 1e6,
      benchNav: Math.round(benchNav * 1e6) / 1e6,
      hasSample,
    });
  }
  return out;
}

/**
 * 这一行该不该回填（幂等的唯一闸门）。
 * 三条不回填，每条都要给得出理由（页面要显示「为什么这一行是空的」）：
 *   1. 没记具体票（symbols 空）——旧口径的行，补不出来也不许拿策略名冒充；
 *   2. 已经回填过（symBackfilledAt 有值）——重复运行绝不重写，否则「重跑一次涨一次」；
 *   3. T+1 或 T+2 还没走完（休市/当天）——没到就是没到，不拿上一天的数据顶替。
 */
export function fillDecisionOf(
  row: { symbols?: string | null; symBackfilledAt?: Date | string | null },
  t1: string | null,
  t2: string | null,
): { fill: boolean; reason: string | null } {
  if (row.symBackfilledAt) return { fill: false, reason: "这一行已经回填过，重跑不再改写" };
  if (!parseSymbols(row.symbols).length) return { fill: false, reason: "当时没记具体票（旧口径只记了策略名），补不出来" };
  if (!t1 || !t2) return { fill: false, reason: "后面两个交易日还没走完，等走完自动补" };
  if (t2 <= t1) return { fill: false, reason: "没找到推荐日之后的第二个交易日" };
  return { fill: true, reason: null };
}

/** 口径说明（写进 nextDayBasis，页面直接显示；说人话，不写黑话） */
export function basisTextOf(opts: {
  t1: string;
  t2: string;
  source: string;
  skipped: number;
  benchN: number;
}): string {
  const parts = [
    `第二天（${opts.t1}）开盘价买入，第三天（${opts.t2}）开盘价卖出`,
    `已扣掉手续费印花税滑点（来回约 0.41%）`,
    `行情来源：${opts.source}`,
  ];
  if (opts.skipped > 0) parts.push(`有 ${opts.skipped} 只第二天一字涨停或停牌买不进，已剔除不算`);
  parts.push(`及格线是同一天全A ${opts.benchN} 只票的中位收益`);
  return parts.join("；");
}
