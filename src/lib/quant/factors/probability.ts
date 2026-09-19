// Quant Screener — 历史条件概率引擎（纯逻辑）
// 输入：单只股票的日K序列 + 条件列表（kline 口径字段）
// 输出：1/5/20 日上涨概率 + 样本数 + 实际统计区间 + 收益分布（均值/中位/最好/最差）
// 硬规则（需求文档 二十/二十一）：
//  - 统计区间必须显示「实际可用数据起止」，不得写死年份；
//  - 样本 < 30 → sample_ok=false，前端显示「样本不足，仅供参考」；
//  - snapshot 口径条件不参与历史匹配（无历史时点数据），必须显式提示；
//  - 前向收益是「标签」，绝不进入条件判断本身。

import { buildFieldPanel, FACTOR_FIELD_MAP, type BarsLike, type MetaLike } from "./fields.ts";

export type CondOp = "=" | ">=" | ">" | "<=" | "<" | "!=" | "like";

export interface ScreenerCond {
  type?: "single" | "rolling_return" | "rolling_sum" | "rolling_any";
  field: string;
  op: CondOp;
  value: number | string;
  window?: number;       // rolling_*
  min_match_days?: number; // rolling_any
}

export interface WinProbStats {
  hit_today: boolean | null;   // 当前交易日是否命中条件
  horizons: {
    h: number;
    win_rate: number | null;   // 0-100
    sample_size: number;
    avg_return: number | null; // %
    median_return: number | null;
    max_return: number | null;
    worst_return: number | null; // 持有期最差单次收益（近似回撤参考）
  }[];
  period: { start: string; end: string } | null; // 实际样本起止
  sample_ok: boolean;
  warnings: string[];
}

function cmp(v: number | null, op: CondOp, value: number): boolean {
  if (v === null || !isFinite(v)) return false;
  switch (op) {
    case "=": return Math.abs(v - value) < 1e-9;
    case ">=": return v >= value;
    case ">": return v > value;
    case "<=": return v <= value;
    case "<": return v < value;
    case "!=": return Math.abs(v - value) >= 1e-9;
    default: return false;
  }
}

// 条件在「t 日」是否成立（基于逐日序列）
function condMetAt(
  cond: ScreenerCond,
  seriesOf: (key: string) => (number | null)[] | undefined,
  t: number,
): boolean {
  const type = cond.type ?? "single";
  const op = cond.op;
  const value = typeof cond.value === "string" ? Number(cond.value) : cond.value;
  if (!isFinite(value)) return false;
  const series = seriesOf(cond.field);
  if (!series) return false;
  if (type === "single") return cmp(series[t] ?? null, op, value);
  const w = Math.max(1, Math.min(250, cond.window ?? 0));
  if (type === "rolling_return") {
    if (t < w) return false;
    const now = series[t], then = series[t - w];
    if (now === null || then === null || then <= 0) return false;
    return cmp((now / then - 1) * 100, op, value);
  }
  if (type === "rolling_sum") {
    if (t < w - 1) return false;
    let s = 0, ok = true;
    for (let i = t - w + 1; i <= t; i++) { const v = series[i]; if (v === null) { ok = false; break; } s += v; }
    return ok ? cmp(s, op, value) : false;
  }
  if (type === "rolling_any") {
    if (t < w - 1) return false;
    let hits = 0;
    for (let i = t - w + 1; i <= t; i++) if (cmp(series[i] ?? null, op, value)) hits++;
    return hits >= Math.max(1, cond.min_match_days ?? 1);
  }
  return false;
}

export interface ProbabilityInput {
  symbol: string;
  bars: BarsLike[];
  meta?: MetaLike;
  conditions: ScreenerCond[];
  horizons?: number[]; // 默认 [1,5,20]
}

export function historicalWinProbability(input: ProbabilityInput): WinProbStats | null {
  const horizons = (input.horizons ?? [1, 5, 20]).map((h) => Math.max(1, Math.min(60, h)));
  const warnings: string[] = [];
  const conds = input.conditions.filter(
    (c) => FACTOR_FIELD_MAP.has(c.field) && FACTOR_FIELD_MAP.get(c.field)!.implemented !== false
  );
  if (!conds.length) return null;

  const unknown = input.conditions.filter((c) => !FACTOR_FIELD_MAP.has(c.field)).map((c) => c.field);
  if (unknown.length) warnings.push(`未知字段已忽略：${unknown.join("、")}`);
  const pending = [
    ...new Set(
      input.conditions
        .filter((c) => FACTOR_FIELD_MAP.has(c.field) && FACTOR_FIELD_MAP.get(c.field)!.implemented === false)
        .map((c) => c.field)
    ),
  ];
  if (pending.length) warnings.push(`已登记未实现因子已忽略（不参与历史概率统计）：${pending.join("、")}`);

  // snapshot 口径条件不能参与历史匹配（无历史时点数据）
  const snapConds = conds.filter((c) => FACTOR_FIELD_MAP.get(c.field)!.source === "snapshot");
  const klineConds = conds.filter((c) => FACTOR_FIELD_MAP.get(c.field)!.source === "kline");
  if (snapConds.length) {
    warnings.push(
      `条件「${snapConds.map((c) => FACTOR_FIELD_MAP.get(c.field)!.zh).join("、")}」为当日快照口径` +
      `（无历史时点数据），历史匹配仅按K线口径条件进行，结果存在口径偏差`,
    );
  }
  if (!klineConds.length) {
    return { hit_today: null, horizons: [], period: null, sample_ok: false, warnings };
  }

  const panel = buildFieldPanel([input.symbol], [input.bars], [input.meta]);
  const seriesOf = (key: string) => panel.fields.get(key)?.[0];
  const closes = panel.fields.get("c")![0];
  const dates = panel.dates;
  const n = dates.length;
  const maxH = Math.max(...horizons);
  const warmup = Math.min(
    Math.max(...klineConds.map((c) => {
      const w = (c.type ?? "single") === "single" ? 0 : Math.max(1, c.window ?? 1);
      const extra = c.field.startsWith("above_ma_") ? Number(c.field.slice(9)) : 0;
      return w + extra + 5;
    })),
    200,
  );

  const matched: number[] = [];
  for (let t = warmup; t < n; t++) {
    if (closes[t] === null) continue;
    if (klineConds.every((c) => condMetAt(c, seriesOf, t))) matched.push(t);
  }
  if (!matched.length) {
    return { hit_today: false, horizons: [], period: null, sample_ok: false, warnings };
  }

  // 当前是否命中（最后一个有效交易日）
  const lastT = (() => { for (let t = n - 1; t >= 0; t--) if (closes[t] !== null) return t; return -1; })();
  const hitToday = lastT >= warmup && klineConds.every((c) => condMetAt(c, seriesOf, lastT));

  const horizonStats = horizons.map((h) => {
    const rets: number[] = [];
    for (const t of matched) {
      if (t + h >= n) continue;
      const entry = closes[t], exit = closes[t + h];
      if (entry === null || exit === null || entry <= 0) continue;
      rets.push((exit / entry - 1) * 100);
    }
    if (!rets.length) return { h, win_rate: null, sample_size: 0, avg_return: null, median_return: null, max_return: null, worst_return: null };
    const sorted = [...rets].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const wins = rets.filter((r) => r > 0).length;
    return {
      h,
      win_rate: (wins / rets.length) * 100,
      sample_size: rets.length,
      avg_return: rets.reduce((s, v) => s + v, 0) / rets.length,
      median_return: median,
      max_return: sorted[sorted.length - 1],
      worst_return: sorted[0],
    };
  });

  const sampleSize = Math.max(...horizonStats.map((s) => s.sample_size), 0);
  if (sampleSize < 30) warnings.push(`样本不足（${sampleSize} < 30），统计仅供参考`);

  return {
    hit_today: hitToday,
    horizons: horizonStats,
    period: { start: dates[matched[0]], end: dates[matched[matched.length - 1]] },
    sample_ok: sampleSize >= 30,
    warnings,
  };
}
