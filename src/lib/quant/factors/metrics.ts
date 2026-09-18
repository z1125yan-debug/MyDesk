// Quant Research Lab — 因子评价指标
// 全部基于截面面板：因子值（[股票][日期]）与前向收益（[股票][日期]）。
// 评测口径：t 日因子值 ↔ t→t+h 前向收益（因子只用 ≤t 数据，标签在 t 之后，标准做法）。
import { pearson, csRank } from "./expression.ts";
import type { FactorMetrics } from "../types.ts";

type Mat = (number | null)[][];

export interface MetricOptions {
  horizon?: number; // 前向收益天数，默认 5
  groups?: number; // 分组数，默认 5
  minStocks?: number; // 截面最少有效股票数，默认 8
  existingFactorMats?: { factorKey: string; mat: Mat }[]; // 相关性/冗余检测基准
  redundancyThreshold?: number; // 默认 0.85
}

export interface FullMetrics extends FactorMetrics {
  icSeries: { date: string; ic: number; rankIc: number }[];
  groupAnnual: number[]; // 各分组年化收益
  decayProfile: { horizon: number; rankIc: number }[];
  subPeriodIc: { range: string; rankIc: number }[];
  monotonicity?: number; // 分组单调性（组序 vs 组收益相关）
  redundancyWith: string | null; // 与哪个已有因子冗余
  sample: { dates: number; stocks: number; validPairs: number };
}

function crossSectionPairs(factorCol: (number | null)[], labelCol: (number | null)[]): { x: number[]; y: number[] } {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < factorCol.length; i++) {
    if (factorCol[i] !== null && labelCol[i] !== null) { x.push(factorCol[i]!); y.push(labelCol[i]!); }
  }
  return { x, y };
}

function rankArray(xs: number[]): number[] {
  return csRank(xs).map((v) => (v === null ? 0 : v));
}

// 单 horizon 的 IC / RankIC 序列
function icSeries(factorMat: Mat, labelMat: Mat, dates: string[], minStocks: number): { date: string; ic: number; rankIc: number }[] {
  const out: { date: string; ic: number; rankIc: number }[] = [];
  for (let t = 0; t < dates.length; t++) {
    const factorCol = factorMat.map((row) => row[t]);
    const labelCol = labelMat.map((row) => row[t]);
    const { x, y } = crossSectionPairs(factorCol, labelCol);
    if (x.length < minStocks) continue;
    const ic = pearson(x, y);
    const ric = pearson(rankArray(x), rankArray(y));
    if (isFinite(ic) && isFinite(ric)) out.push({ date: dates[t], ic, rankIc: ric });
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1));
}

export function summarizeIc(series: { ic: number; rankIc: number }[]): { ic: number; rankIc: number; icIr: number; icPositiveRatio: number } {
  const ics = series.map((s) => s.ic);
  const rics = series.map((s) => s.rankIc);
  const ricStd = std(rics);
  return {
    ic: mean(ics),
    rankIc: mean(rics),
    icIr: ricStd > 0 ? mean(rics) / ricStd : 0,
    icPositiveRatio: rics.length ? rics.filter((v) => v > 0).length / rics.length : 0.5,
  };
}

// 分组收益与多空（按因子 rank 每日分组，等权持有 h 日，年化）
function groupAnalysis(
  factorMat: Mat,
  labelMat: Mat,
  dates: string[],
  groups: number,
  horizon: number,
  minStocks: number,
): { groupAnnual: number[]; longShortAnnual: number; monotonicity: number; longAnnual: number } {
  const nGroups = groups;
  const groupSums = new Array(nGroups).fill(0);
  const groupCounts = new Array(nGroups).fill(0);
  let longSum = 0, longCount = 0, shortSum = 0, shortCount = 0;

  for (let t = 0; t < dates.length; t++) {
    const pairs = factorMat
      .map((row, si) => ({ f: row[t], r: labelMat[si]?.[t] ?? null }))
      .filter((p): p is { f: number; r: number } => p.f !== null && p.r !== null);
    if (pairs.length < minStocks) continue;
    pairs.sort((a, b) => a.f - b.f);
    const per = Math.max(1, Math.floor(pairs.length / nGroups));
    for (let g = 0; g < nGroups; g++) {
      const slice = pairs.slice(g * per, g === nGroups - 1 ? undefined : (g + 1) * per);
      if (!slice.length) continue;
      const avg = mean(slice.map((p) => p.r));
      groupSums[g] += avg;
      groupCounts[g]++;
      if (g === nGroups - 1) { longSum += avg; longCount++; } // 因子值最大组
      if (g === 0) { shortSum += avg; shortCount++; }
    }
  }

  const periodsPerYear = 252 / horizon;
  const groupAnnual = groupSums.map((s, g) => {
    const cnt = groupCounts[g] || 1;
    const perPeriod = s / cnt;
    return Math.pow(1 + perPeriod, periodsPerYear) - 1;
  });
  const longAnnual = longCount ? Math.pow(1 + longSum / longCount, periodsPerYear) - 1 : 0;
  const shortAnnual = shortCount ? Math.pow(1 + shortSum / shortCount, periodsPerYear) - 1 : 0;

  // 单调性：分组序号与分组年化收益的秩相关
  const gx = groupAnnual.map((_, i) => i);
  const valid = groupAnnual.map((v, i) => (groupCounts[i] > 0 ? v : null));
  const vi: number[] = [], vv: number[] = [];
  valid.forEach((v, i) => { if (v !== null) { vi.push(i); vv.push(v); } });
  const monotonicity = vi.length >= 3 ? pearson(vi, vv) : 0;

  return { groupAnnual, longShortAnnual: longAnnual - shortAnnual, monotonicity, longAnnual };
}

// 因子换手率：相邻调仓日 rank 变化的平均绝对值
function factorTurnover(factorMat: Mat, dates: string[]): number {
  let sum = 0, count = 0;
  let prevRanks: (number | null)[] | null = null;
  for (let t = 0; t < dates.length; t++) {
    const col = factorMat.map((row) => row[t]);
    const hasData = col.some((v) => v !== null);
    if (!hasData) continue;
    const ranks = csRank(col);
    if (prevRanks) {
      let s = 0, n = 0;
      for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] !== null && prevRanks[i] !== null) {
          s += Math.abs(ranks[i]! - prevRanks[i]!);
          n++;
        }
      }
      if (n > 0) { sum += s / n; count++; }
    }
    prevRanks = ranks;
  }
  return count ? sum / count : 1;
}

// 跨 horizon IC → 衰减曲线
function decayProfile(factorMat: Mat, panelC: Mat, dates: string[], horizons: number[], minStocks: number): { horizon: number; rankIc: number }[] {
  const out: { horizon: number; rankIc: number }[] = [];
  for (const h of horizons) {
    const labelMat = panelC.map((series) =>
      series.map((v, t) => {
        const future = t + h < series.length ? series[t + h] : null;
        return v !== null && future !== null && v > 0 ? future / v - 1 : null;
      }),
    );
    const s = icSeries(factorMat, labelMat as Mat, dates, minStocks);
    out.push({ horizon: h, rankIc: mean(s.map((x) => x.rankIc)) });
  }
  return out;
}

// 子期稳定性：三等分时间的各段 RankIC
function subPeriodIc(series: { date: string; rankIc: number }[]): { range: string; rankIc: number }[] {
  if (series.length < 30) return [];
  const k = 3;
  const per = Math.floor(series.length / k);
  const out: { range: string; rankIc: number }[] = [];
  for (let i = 0; i < k; i++) {
    const slice = series.slice(i * per, i === k - 1 ? undefined : (i + 1) * per);
    out.push({
      range: `${slice[0].date}~${slice[slice.length - 1].date}`,
      rankIc: mean(slice.map((s) => s.rankIc)),
    });
  }
  return out;
}

// 与已有因子的截面相关（值相关，合并全部日期股票对）+ 冗余判定
export function factorCorrelation(a: Mat, b: Mat): number {
  const xs: number[] = [], ys: number[] = [];
  for (let si = 0; si < Math.min(a.length, b.length); si++) {
    for (let t = 0; t < Math.min(a[si].length, b[si].length); t++) {
      if (a[si][t] !== null && b[si][t] !== null) { xs.push(a[si][t]!); ys.push(b[si][t]!); }
    }
  }
  return xs.length >= 30 ? pearson(xs, ys) : 0;
}

export function evaluateFactorMetrics(
  factorMat: Mat,
  panel: { dates: string[]; fields: Map<string, Mat> },
  opts: MetricOptions = {},
): FullMetrics {
  const horizon = opts.horizon ?? 5;
  const groups = opts.groups ?? 5;
  const minStocks = opts.minStocks ?? 8;

  const c = panel.fields.get("c")!;
  const labelMat = c.map((series) =>
    series.map((v, t) => {
      const future = t + horizon < series.length ? series[t + horizon] : null;
      return v !== null && future !== null && v > 0 ? future / v - 1 : null;
    }),
  ) as Mat;

  const series = icSeries(factorMat, labelMat, panel.dates, minStocks);
  const summary = summarizeIc(series);
  const ga = groupAnalysis(factorMat, labelMat, panel.dates, groups, horizon, minStocks);
  const turnover = factorTurnover(factorMat, panel.dates);
  const decay = decayProfile(factorMat, c as Mat, panel.dates, [1, 3, 5, 10, 20], minStocks);
  const subIc = subPeriodIc(series);

  // 稳定性：子期 RankIC 与总体同号的比例（1=每段都同向）
  const overallSign = Math.sign(summary.rankIc) || 1;
  const sameSign = subIc.filter((s) => Math.sign(s.rankIc) === overallSign).length;
  const stability = subIc.length ? sameSign / subIc.length : 0;

  // 半衰期：第一个 |RankIC| < |RankIC(h=1)|/2 的 horizon
  const ic1 = Math.abs(decay[0]?.rankIc ?? 0);
  const halfLife = ic1 > 0 ? (decay.find((d) => Math.abs(d.rankIc) < ic1 / 2)?.horizon ?? null) : null;

  // 相关性与冗余
  const correlations: { factorKey: string; corr: number }[] = [];
  let redundancyWith: string | null = null;
  const threshold = opts.redundancyThreshold ?? 0.85;
  for (const ref of opts.existingFactorMats ?? []) {
    const corr = factorCorrelation(factorMat, ref.mat);
    correlations.push({ factorKey: ref.factorKey, corr });
    if (!redundancyWith && Math.abs(corr) >= threshold) redundancyWith = ref.factorKey;
  }

  const validPairs = series.length;
  return {
    ic: summary.ic,
    rankIc: summary.rankIc,
    icIr: summary.icIr,
    icPositiveRatio: summary.icPositiveRatio,
    groupReturn: ga.groupAnnual,
    longShortReturn: ga.longShortAnnual,
    turnover,
    stability,
    decay: halfLife,
    correlation: correlations,
    icSeries: series,
    groupAnnual: ga.groupAnnual,
    decayProfile: decay,
    subPeriodIc: subIc,
    redundancyWith,
    monotonicity: ga.monotonicity,
    sample: { dates: panel.dates.length, stocks: factorMat.length, validPairs },
  } as FullMetrics;
}

// 冗余筛选：与集合内已选因子相关性 ≥ 阈值 → 冗余
export function isRedundant(candidate: Mat, chosen: { factorKey: string; mat: Mat }[], threshold = 0.85): string | null {
  for (const ref of chosen) {
    if (Math.abs(factorCorrelation(candidate, ref.mat)) >= threshold) return ref.factorKey;
  }
  return null;
}
