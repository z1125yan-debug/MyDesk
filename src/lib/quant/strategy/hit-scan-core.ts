// 「某一天哪些票命中了这组条件」的扫描核（P36-C，2026-10-01）
//
// 为什么抽出来：B 的分档回测与 C 的战绩补算都要回答同一个问题——
// 「这组条件在 X 日命中了哪几只票」。两处各写一遍，口径迟早分叉（一处改了 warmup、另一处没改），
// 于是「回测说命中 300 只、战绩页说那天一只没有」这种自相矛盾就没人查得出来。
//
// 数据源固定本地粮仓（前复权日K），不发外部请求：命中名单必须可复核。
// 拿不到历史值的字段（当日快照类：换手率/市盈率/板块RPS）由调用方在**入口**判掉，
// 本核不静默降级——宁可回「算不出来」，也不许拿今天的读数冒充历史。

import { buildFieldPanel, type BarsLike, type MetaLike } from "../factors/fields.ts";
import type { MatCond } from "./cond-matrix-core.ts";
import { hitMatrixOf } from "./cond-matrix-core.ts";

export interface HitRow {
  symbol: string;
  /** 当日收盘价（回填判「次日是否一字涨停」要用，写进台账就不再依赖历史库） */
  close: number;
  /** 当日成交额（元）：排序取「当天最活跃的 N 只」，理由见 topByAmountOf */
  amount: number;
}

/**
 * 扫出 targetDate 当天命中全部条件的票。
 * 返回空数组 = 当天一只都没命中（不是失败）；失败由调用方在入口判（快照字段/未实现字段）。
 */
export function scanHitsOnDate(opts: {
  syms: readonly string[];
  barsList: readonly BarsLike[][];
  conds: readonly MatCond[];
  targetDate: string;
}): HitRow[] {
  const { syms, barsList, conds, targetDate } = opts;
  if (!conds.length || !syms.length) return [];
  const metas = syms.map(() => undefined as MetaLike | undefined);
  const panel = buildFieldPanel(syms as string[], barsList as BarsLike[][], metas);
  const t = panel.dates.indexOf(targetDate);
  if (t < 0) return [];

  // 一条条件算一张位图（票 × 日），多条件按位与；与 B 回测同一份实现
  const mats = conds.map((c) => {
    const field = panel.fields.get(c.field);
    return field ? syms.map((_, si) => hitMatrixOf(c, field[si])) : null;
  });
  if (mats.some((m) => m === null)) return [];

  const out: HitRow[] = [];
  for (let si = 0; si < syms.length; si++) {
    let hit = true;
    for (const m of mats) {
      if (!m![si][t]) { hit = false; break; }
    }
    if (!hit) continue;
    const bar = barsList[si]?.find((b) => b.date === targetDate);
    if (!bar) continue;
    out.push({ symbol: syms[si] as string, close: bar.c ?? 0, amount: bar.amount ?? 0 });
  }
  return out;
}

/**
 * 命中票太多时取哪 N 只：按当日成交额降序。
 * 为什么是成交额：①成交活跃的票才真的买得进（A 闸的教训——冷门票一字板/买不到量等于没推荐）；
 * ②口径唯一、可复核，不掺任何「我看好」的主观排序。
 * 必须把这个规则写进页面，否则用户会以为是「最好的 10 只」。
 */
export function topByAmountOf(hits: readonly HitRow[], n = 10): HitRow[] {
  return [...hits].sort((a, b) => b.amount - a.amount).slice(0, n);
}
