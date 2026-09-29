// P0 类型B预测数据底座：纯函数层（不依赖 DB / 数据源），供 daily-snapshot-collect 与单测共用。
// 风险等级为本地推导占位（P1 将用量价回标重校），次日涨跌为纯数学——这两段不涉及任何概率预测，也不触碰禁区代码。
export type RiskLevel = "正常" | "注意" | "偏高" | "高风险" | "";

/**
 * 本地风险等级推导（P0 占位）：以「站上5日线占比」为主轴，叠加涨跌停比与下跌家数做粗分档。
 * 设计边界：P1 会用留档数据回标后替换此函数，当前只求「每日一行有可读的风险档」，不做精确判读。
 * 任何入参缺失 → 返回 ""（不猜档），与全仓「取不到写 null」的口径一致。
 */
export function deriveRiskLevel(
  aboveMa5Pct: number | null,
  decliners: number | null,
  limitUp: number | null,
  limitDown: number | null,
): RiskLevel {
  if (aboveMa5Pct == null || !isFinite(aboveMa5Pct)) return "";
  const ld = limitDown ?? 0;
  const lu = limitUp ?? 0;
  const plunge = ld >= 50 || (lu > 0 && ld / lu >= 5) || (decliners ?? 0) >= 4000;
  if (plunge) return "高风险";
  if (aboveMa5Pct < 35) return "偏高";
  if (aboveMa5Pct < 50) return "注意";
  if (aboveMa5Pct >= 60 && ld <= 15) return "正常";
  return "注意";
}

/**
 * 单只个股「T→T+1 收盘涨跌幅 %」（纯数学）：c0 = T 收盘，c1 = T+1 收盘。
 * 入参非法（缺价 / 非有限 / 分母为 0 或负）返回 NaN，由调用方决定是否落 null，不静默给 0。
 */
export function computeNextDayChg(c0: number, c1: number): number {
  if (!(isFinite(c0) && isFinite(c1) && c0 > 0)) return NaN;
  return ((c1 - c0) / c0) * 100;
}

/** 中位数（纯数学）；空或全非有限 → NaN */
export function medianOf(nums: number[]): number {
  const v = nums.filter((n) => isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
