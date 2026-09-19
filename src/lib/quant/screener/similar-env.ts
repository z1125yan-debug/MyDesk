// 指数相似环境：用「当日涨跌幅落在带宽内」的历史交易日，统计 1/5/20 日前向收益。
// 纯价格序列，禁止编造样本。
export interface SimilarEnvStats {
  today_return: number | null;
  band: number;
  sample_size: number;
  sample_ok: boolean;
  period: { start: string; end: string } | null;
  horizons: {
    h: number;
    win_rate: number | null;
    sample_size: number;
    avg_return: number | null;
    median_return: number | null;
    worst_return: number | null;
  }[];
  warnings: string[];
}

export function similarReturnForward(
  bars: { date: string; c: number }[],
  band = 0.8,
  horizons = [1, 5, 20],
): SimilarEnvStats {
  const warnings: string[] = [];
  const closes = bars.filter((b) => b.c > 0);
  if (closes.length < 40) {
    return {
      today_return: null, band, sample_size: 0, sample_ok: false, period: null,
      horizons: horizons.map((h) => ({ h, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null })),
      warnings: ["K线不足 40 根，无法做相似环境统计"],
    };
  }
  const rets: number[] = [NaN];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i].c / closes[i - 1].c - 1) * 100);
  const today = rets[rets.length - 1];
  if (!isFinite(today)) {
    return {
      today_return: null, band, sample_size: 0, sample_ok: false, period: null,
      horizons: horizons.map((h) => ({ h, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null })),
      warnings: ["无法计算当日涨跌幅"],
    };
  }
  const matched: number[] = [];
  for (let i = 1; i < rets.length - 1; i++) {
    if (!isFinite(rets[i])) continue;
    if (Math.abs(rets[i] - today) <= band) matched.push(i);
  }
  const maxH = Math.max(...horizons);
  const usable = matched.filter((i) => i + maxH < closes.length);
  const horizonStats = horizons.map((h) => {
    const fwd: number[] = [];
    for (const i of matched) {
      if (i + h >= closes.length) continue;
      const a = closes[i].c, b = closes[i + h].c;
      if (a > 0 && b > 0) fwd.push((b / a - 1) * 100);
    }
    if (!fwd.length) return { h, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null };
    const sorted = [...fwd].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return {
      h,
      win_rate: (fwd.filter((x) => x > 0).length / fwd.length) * 100,
      sample_size: fwd.length,
      avg_return: fwd.reduce((s, v) => s + v, 0) / fwd.length,
      median_return: median,
      worst_return: sorted[0],
    };
  });
  const sampleSize = Math.max(...horizonStats.map((s) => s.sample_size), 0);
  if (sampleSize < 30) warnings.push(`样本不足（${sampleSize} < 30），仅供参考`);
  const period = usable.length
    ? { start: closes[usable[0]].date, end: closes[usable[usable.length - 1]].date }
    : matched.length
      ? { start: closes[matched[0]].date, end: closes[matched[matched.length - 1]].date }
      : null;
  return {
    today_return: today,
    band,
    sample_size: sampleSize,
    sample_ok: sampleSize >= 30,
    period,
    horizons: horizonStats,
    warnings,
  };
}
