/**
 * Wilson score 置信区间（纯核，无 IO）。
 *
 * 为什么要有它（P1）：分档回测推荐的「次日胜率 69%」这类数字，样本只有 323 次时
 * 真实值可能在 63%~74% 之间——不给区间就是把点估计当真值卖。类型 B 放行口径也要求
 * 「收跌概率 62% [95%CI 44–78]（N=34）」这种格式，裸概率不许出门（禁区红线的前置纪律）。
 *
 * 口径：
 * - 95% 置信（z=1.96）为默认；n≤0 或 wins 越界 → null（算不出 ≠ 0%，不许冒充）；
 * - 返回 [0,1] 概率域；展示层用 pctWithCI 转百分比文本。
 */

export interface WilsonCI {
  lo: number | null;
  hi: number | null;
}

export function wilsonCI(wins: number, n: number, z = 1.96): WilsonCI {
  if (
    !Number.isFinite(wins) || !Number.isFinite(n) || !Number.isFinite(z) ||
    !Number.isInteger(n) || n <= 0 || wins < 0 || wins > n
  ) {
    return { lo: null, hi: null };
  }
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, Math.round((center - half) * 1000) / 1000),
    hi: Math.min(1, Math.round((center + half) * 1000) / 1000),
  };
}

/**
 * 胜率文本 + 区间：「69% [95%CI 63–74]（N=323）」。
 * n 不足或区间算不出 → 只回「69%（N=n）」并带「CI算不出」，不编区间。
 * 输入 pct 为百分数值（0-100），n 为样本数。
 */
export function pctWithCI(pct: number | null, n: number | null | undefined, z = 1.96): string {
  if (pct == null || !Number.isFinite(pct)) return "CI算不出（无胜率读数）";
  const nInt = n != null && Number.isFinite(n) && Number.isInteger(n) && (n as number) > 0 ? (n as number) : null;
  if (nInt == null) return `${pct}%（N未知，CI算不出）`;
  const ci = wilsonCI(Math.round((pct / 100) * nInt), nInt, z);
  if (ci.lo == null || ci.hi == null) return `${pct}%（N=${nInt}，CI算不出）`;
  const lo = Math.round(ci.lo * 100);
  const hi = Math.round(ci.hi * 100);
  return `${pct}% [95%CI ${lo}–${hi}]（N=${nInt}）`;
}
