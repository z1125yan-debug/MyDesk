/**
 * 上涨概率模型：特征计算（纯函数，零 IO）。
 *
 * 与离线验证脚本（goal hidden_files/up-probability/backtest_up_probability.py）同口径：
 * 全部特征只用决策日收盘前的数据；涨停阈值与 factors/fields.ts 的 limitRatio 一致。
 *
 * 特征（9 个）：
 *   避开类：relVolume（量比代理，float-free）、amplitude、atrPct、
 *           ma20Bias（截断 ±0.3）、ma60Bias（截断 ±0.3）、limitUp20d
 *   正向类：gap（开盘跳空）、vwapBias（VWAP 乖离）
 *   板块先验：sectorPrior（板块资金流向代理；实盘可混入政策/美联储输入）
 *
 * 注意：换手率这里用“量比代理”volume / mean(volume,60)，不是 tickflow 的
 * volume / 时点流通股本——DB 没有时点流通股本，用最新流通股本算历史换手会引入
 * 未来信息（lookahead），所以用 float-free 代理，并明确标注。
 */

export interface UpBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export interface RawUpFeatures {
  /** log1p(当日成交量 / 近 60 日平均成交量)，换手率代理 */
  relVolume: number | null;
  /** (high - low) / 昨收 */
  amplitude: number | null;
  /** 20 日平均真实波幅 / 收盘价 */
  atrPct: number | null;
  /** 收盘 / MA20 - 1，截断到 [-0.3, 0.3] */
  ma20Bias: number | null;
  /** 收盘 / MA60 - 1，截断到 [-0.3, 0.3] */
  ma60Bias: number | null;
  /** 近 20 日涨停次数（含当日） */
  limitUp20d: number | null;
  /** (开盘 - 昨收) / 昨收 */
  gap: number | null;
  /** (收盘 - 当日 VWAP) / 当日 VWAP，VWAP = amount / volume */
  vwapBias: number | null;
  /** 未截断的 MA20 乖离（供排除法用：> +0.30 视为极端远离） */
  ma20BiasRaw: number | null;
}

export const UP_FEATURE_NAMES = [
  "relVolume",
  "amplitude",
  "atrPct",
  "ma20Bias",
  "ma60Bias",
  "limitUp20d",
  "gap",
  "vwapBias",
  "sectorPrior",
] as const;

export type UpFeatureName = (typeof UP_FEATURE_NAMES)[number];

/** 与 factors/fields.ts limitRatio 完全一致的涨停阈值。 */
export function upLimitRatio(symbol: string, name: string): number {
  const head = symbol.slice(0, 6);
  if (/^(300|301|688|689)/.test(head)) return 0.2;
  if (symbol.endsWith(".BJ")) return 0.3;
  if (/ST/i.test(name)) return 0.05;
  return 0.1;
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * 计算单只票在 bars 最后一根（决策日）的原始特征。
 * bars 必须按日期升序；不足 61 根时需要 60 日均线的特征返回 null（不编）。
 */
export function computeRawUpFeatures(
  bars: UpBar[],
  symbol: string,
  name: string,
): RawUpFeatures | null {
  const n = bars.length;
  if (n < 2) return null;
  const last = bars[n - 1];
  const prev = bars[n - 2];
  if (!(prev.close > 0) || !(last.close > 0)) return null;

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const ma = (window: number): number | null => {
    if (n < window) return null;
    return mean(closes.slice(n - window));
  };
  const ma20 = ma(20);
  const ma60 = ma(60);
  const vol60 = n >= 60 ? mean(volumes.slice(n - 60)) : null;

  // 真实波幅（需要昨收）
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const pc = bars[i - 1].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  const atr20 = trs.length >= 20 ? mean(trs.slice(trs.length - 20)) : null;

  // 近 20 日涨停次数（含当日）
  const lim = upLimitRatio(symbol, name);
  let limitUp20d: number | null = null;
  if (n >= 21) {
    let cnt = 0;
    for (let i = n - 20; i < n; i++) {
      const pc = bars[i - 1].close;
      if (pc > 0 && bars[i].close / pc - 1 >= lim - 1e-9) cnt += 1;
    }
    limitUp20d = cnt;
  }

  const vwap = last.volume > 0 ? last.amount / last.volume : null;
  const clip = (x: number | null): number | null =>
    x == null ? null : Math.max(-0.3, Math.min(0.3, x));
  const ma20BiasRaw = ma20 != null && ma20 > 0 ? last.close / ma20 - 1 : null;
  const ma60BiasRaw = ma60 != null && ma60 > 0 ? last.close / ma60 - 1 : null;

  return {
    relVolume: vol60 != null && vol60 > 0 ? Math.log1p(last.volume / vol60) : null,
    amplitude: (last.high - last.low) / prev.close,
    atrPct: atr20 != null ? atr20 / last.close : null,
    ma20Bias: clip(ma20BiasRaw),
    ma60Bias: clip(ma60BiasRaw),
    limitUp20d,
    gap: (last.open - prev.close) / prev.close,
    vwapBias: vwap != null && vwap > 0 ? (last.close - vwap) / vwap : null,
    ma20BiasRaw,
  };
}

/**
 * 截面 rank 标准化：把某一天全市场某特征的原始值转成 [-1, 1]。
 * pct = (平均秩 - 1) / (n - 1)，z = (pct - 0.5) * 2。缺失值保持 null。
 */
export function rankStandardize(values: (number | null)[]): (number | null)[] {
  const idx = values
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v != null && Number.isFinite(x.v as number));
  const n = idx.length;
  if (n === 0) return values.map(() => null);
  const sorted = [...idx].sort((a, b) => (a.v as number) - (b.v as number));
  const rankOf = new Map<number, number>();
  let j = 0;
  while (j < sorted.length) {
    let k = j;
    while (k + 1 < sorted.length && sorted[k + 1].v === sorted[j].v) k += 1;
    const avgRank = (j + k) / 2 + 1; // 1-based 平均秩
    for (let t = j; t <= k; t++) rankOf.set(sorted[t].i, avgRank);
    j = k + 1;
  }
  return values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return null;
    if (n <= 1) return 0;
    const pct = (rankOf.get(i)! - 1) / (n - 1);
    return (pct - 0.5) * 2;
  });
}

export interface UpExclusionInput {
  /** 量比截面分位（0-1，越高换手相对越极端） */
  relVolumePct: number | null;
  /** 振幅截面分位（0-1） */
  amplitudePct: number | null;
  /** 未截断的 MA20 乖离 */
  ma20BiasRaw: number | null;
}

/**
 * 排除法：换手分位前 20% / 振幅分位前 20% / MA20 乖离 > +0.30，任一命中即排除。
 * 返回排除原因（空数组 = 不排除）。
 */
export function upExclusionReasons(inp: UpExclusionInput): string[] {
  const reasons: string[] = [];
  if (inp.relVolumePct != null && inp.relVolumePct >= 0.8) reasons.push("换手分位前20%");
  if (inp.amplitudePct != null && inp.amplitudePct >= 0.8) reasons.push("振幅分位前20%");
  if (inp.ma20BiasRaw != null && inp.ma20BiasRaw > 0.3) reasons.push("MA20乖离>0.30");
  return reasons;
}

/**
 * 板块先验合成：资金流向代理为主；实盘有真实政策/美联储输入时混入。
 * 回测期政策/美联储无历史标签，policyHit=0、fedEase=0.5（中性），先验 = 资金流向代理。
 * 混合权重是先验设定，不是拟合出来的（回测里后两项恒为中性，拟合不到权重）。
 */
export function blendSectorPrior(
  flowRank: number,
  policyHit: number = 0,
  fedEase: number = 0.5,
): number {
  const flow = Math.max(0, Math.min(1, flowRank));
  const pol = Math.max(0, Math.min(1, policyHit));
  const fed = Math.max(0, Math.min(1, fedEase));
  return 0.7 * flow + 0.2 * pol + 0.1 * fed;
}
