// Quant Screener — 历史条件概率引擎（纯逻辑）
// 输入：单只股票的日K序列 + 条件列表（kline 口径字段）
// 输出：1/5/20 日上涨概率 + 样本数 + 实际统计区间 + 收益分布（均值/中位/最好/最差）
// 硬规则（需求文档 二十/二十一）：
//  - 统计区间必须显示「实际可用数据起止」，不得写死年份；
//  - 样本 < 30 → sample_ok=false，前端显示「样本不足，仅供参考」；
//  - snapshot 口径条件不参与历史匹配（无历史时点数据），必须显式提示；
//  - 前向收益是「标签」，绝不进入条件判断本身。

import { buildFieldPanel, FACTOR_FIELD_MAP, type BarsLike, type MetaLike } from "./fields.ts";

export type CondOp = "=" | ">=" | ">" | "<=" | "<" | "!=" | "like" | "in" | "not in";

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
    // §二/§六 补齐：命中样本按时间复利的净值最大回撤（≤0，%）；样本<2 时为 null
    max_drawdown: number | null;
    // P7-⑦：盈亏比的两个组成部分，**与 win_rate 同一次遍历、同一批样本**（另起窗口就成了两个口径）。
    // 只按 r>0 / r<0 分组，r=0 的持平样本两边都不进 —— 它既不算一次盈利也不算一次亏损，
    // 所以 avg_win 与 avg_loss 的样本数之和可以小于 sample_size。某一侧一个样本都没有 ⇒ null（不是 0）。
    avg_win: number | null;
    /** 平均亏损，保留负号（如 -3.21 表示平均亏 3.21%）；无亏损样本 ⇒ null */
    avg_loss: number | null;
    /** avg_win / |avg_loss|；任一侧无样本 ⇒ null：没有亏损就没有比值，用 0 或 ∞ 冒充都是假数 */
    payoff_ratio: number | null;
    win_samples: number;
    loss_samples: number;
    // 同期基准（沪深300，按相同「命中日→t+h」区间）平均收益（%）与超额；无基准K线 → null（数据缺失，不填0）
    benchmark_return: number | null;
    benchmark_sample_size: number;
    excess_return: number | null;
  }[];
  period: { start: string; end: string } | null; // 实际样本起止
  sample_ok: boolean;
  warnings: string[];
}

/** 多值操作符的取值列表：数组或分隔字符串（, ， / ; ｜ 空格）；数值字段按数值比较，否则按字符串比较 */
export function listOf(value: number | string | (number | string)[]): (number | string)[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "number") return [value];
  return String(value)
    .split(/[,，/;、|]+|\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    // in / not in：列表由调用方（condMetAt）解析后传入，这里保留数值语义兜底
    default: return false;
  }
}

function cmpIn(v: number | null, list: (number | string)[], negate: boolean): boolean {
  if (v === null || !isFinite(v)) return false;
  const hit = list.some((x) => {
    const nx = typeof x === "number" ? x : Number(x);
    return isFinite(nx) ? Math.abs((v as number) - nx) < 1e-9 : String(v) === String(x);
  });
  return negate ? !hit : hit;
}

/**
 * §四 操作符契约的唯一实现（选股引擎与概率引擎共用）：
 * = >= > <= < != like + in / not in（多值：数组或 "a,b / c; d"、空格/顿号分隔串）。
 * in/not in：列表元素可数值则按数值比较，否则按字符串相等；空列表=false（缺数据不猜）。
 * 其余操作符仍要求数值可比；v 为 null/NaN → false（UNKNOWN 不当真）。
 */
export function cmpWithOp(
  v: number | null | undefined,
  op: string,
  raw: number | string | (number | string)[],
): boolean {
  if (v === null || v === undefined || !isFinite(v)) return false;
  if (op === "in" || op === "not in") {
    const list = listOf(raw);
    if (!list.length) return false;
    return cmpIn(v, list, op === "not in");
  }
  const value = typeof raw === "number" ? raw : Number(Array.isArray(raw) ? raw[0] : raw);
  return cmp(v, op as CondOp, value) || (op === "like" && String(v).includes(String(value)));
}

// 条件在「t 日」是否成立（基于逐日序列）
// 导出供策略池化回测复用（P33）：判定语义只有这一份，回测不许手搓第二套
export function condMetAt(
  cond: ScreenerCond,
  seriesOf: (key: string) => (number | null)[] | undefined,
  t: number,
): boolean {
  const type = cond.type ?? "single";
  const op = cond.op;
  // §四：操作符判定统一走 cmpWithOp（in/not in 多值 + 数值操作符），与选股引擎同一份实现
  const test = (v: number | null): boolean => cmpWithOp(v, op, cond.value);
  const series = seriesOf(cond.field);
  if (!series) return false;
  if (type === "single") return test(series[t] ?? null);
  const w = Math.max(1, Math.min(250, cond.window ?? 0));
  if (type === "rolling_return") {
    if (t < w) return false;
    const now = series[t], then = series[t - w];
    if (now === null || then === null || then <= 0) return false;
    return test((now / then - 1) * 100);
  }
  if (type === "rolling_sum") {
    if (t < w - 1) return false;
    let s = 0, ok = true;
    for (let i = t - w + 1; i <= t; i++) { const v = series[i]; if (v === null) { ok = false; break; } s += v; }
    return ok ? test(s) : false;
  }
  if (type === "rolling_any") {
    if (t < w - 1) return false;
    let hits = 0;
    for (let i = t - w + 1; i <= t; i++) if (test(series[i] ?? null)) hits++;
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
  /** 基准日K（需求：沪深300 同期对比）；不传 → benchmark_return=null 并提示数据缺失 */
  benchmarkBars?: BarsLike[];
  benchmarkName?: string; // 基准名称，用于提示文案（默认「沪深300」）
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
  // 基准收盘价按日期对齐（同一交易日历下用日期匹配，避免索引错位）
  const benchClose = new Map<string, number>();
  for (const b of input.benchmarkBars ?? []) {
    if (b && typeof b.c === "number" && b.c > 0) benchClose.set(b.date, b.c);
  }
  if (!benchClose.size) {
    warnings.push(`基准指数K线缺失（${input.benchmarkName ?? "沪深300"}），同期基准收益/超额无法计算（显示为「—」，不以0代替）`);
  }
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
    const benchRets: number[] = [];
    for (const t of matched) {
      if (t + h >= n) continue;
      const entry = closes[t], exit = closes[t + h];
      if (entry === null || exit === null || entry <= 0) continue;
      rets.push((exit / entry - 1) * 100);
      // 基准同期：同一「命中日 → t+h」区间的沪深300收益（按日期对齐，缺一天即该样本不计）
      const b0 = benchClose.get(dates[t]), b1 = benchClose.get(dates[t + h]);
      if (b0 !== undefined && b1 !== undefined && b0 > 0) benchRets.push((b1 / b0 - 1) * 100);
    }
    if (!rets.length) {
      return {
        h, win_rate: null, sample_size: 0, avg_return: null, median_return: null,
        max_return: null, worst_return: null, max_drawdown: null,
        avg_win: null, avg_loss: null, payoff_ratio: null, win_samples: 0, loss_samples: 0,
        benchmark_return: null, benchmark_sample_size: 0, excess_return: null,
      };
    }
    const sorted = [...rets].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const wins = rets.filter((r) => r > 0).length;
    // 净值曲线最大回撤：命中样本按时间顺序复利（非重叠口径下为近似连续持有）
    let eq = 1, peak = 1, dd = 0;
    for (const r of rets) {
      eq *= 1 + r / 100;
      if (eq > peak) peak = eq;
      const cur = (eq / peak - 1) * 100;
      if (cur < dd) dd = cur;
    }
    const avg = rets.reduce((s, v) => s + v, 0) / rets.length;
    // 盈亏比的两侧各自取均值：盈利侧 = 所有 r>0 的均值；亏损侧 = 所有 r<0 的均值（带负号）。
    // 某侧为 0 个样本时给 null 而不是 0 —— 「一次都没亏过」不等于「亏损幅度为 0%」。
    const winRets = rets.filter((r) => r > 0);
    const lossRets = rets.filter((r) => r < 0);
    const avgWin = winRets.length ? winRets.reduce((s, v) => s + v, 0) / winRets.length : null;
    const avgLoss = lossRets.length ? lossRets.reduce((s, v) => s + v, 0) / lossRets.length : null;
    const payoff = avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null;
    const benchAvg = benchRets.length ? benchRets.reduce((s, v) => s + v, 0) / benchRets.length : null;
    return {
      h,
      win_rate: (wins / rets.length) * 100,
      sample_size: rets.length,
      avg_return: avg,
      median_return: median,
      max_return: sorted[sorted.length - 1],
      worst_return: sorted[0],
      max_drawdown: rets.length >= 2 ? dd : null,
      avg_win: avgWin,
      avg_loss: avgLoss,
      payoff_ratio: payoff,
      win_samples: winRets.length,
      loss_samples: lossRets.length,
      benchmark_return: benchAvg,
      benchmark_sample_size: benchRets.length,
      excess_return: benchAvg === null ? null : avg - benchAvg,
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
