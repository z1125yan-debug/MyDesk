/**
 * 上涨概率模型：逻辑回归推断（纯函数，零 IO）。
 *
 * 概率定义：P(次日收盘涨跌跑赢上证)。与胜率口径（跑赢上证）一致。
 * 系数 FITTED_COEFFICIENTS 来自离线全样本重拟合（见 README），回测数字来自
 * 滚动回测（walk-forward），不是全样本拟合的样本内数字。
 */

import type { UpFeatureName } from "./features";
import { UP_FEATURE_NAMES } from "./features";

export interface UpProbabilityCoefficients {
  intercept: number;
  /** 与 UP_FEATURE_NAMES 一一对应的系数 */
  features: Record<UpFeatureName, number>;
  /** 拟合用训练样本数 */
  nTrain: number;
  /** 训练集正样本率（跑赢上证占比） */
  baseRate: number;
  /** 拟合数据范围说明 */
  fittedOn: string;
}

/**
 * 全样本重拟合系数（拟合于 2025-12~2026-10-15 全部个股日，标签用次日收盘到 2026-10-16）。
 * 回测（滚动回测）用的是每折各自拟合的系数，不是这一组——这一组只供实盘推断形状使用，
 * 上线前必须重新拟合与验证。
 */
export const FITTED_COEFFICIENTS: UpProbabilityCoefficients = {
  intercept: -0.1735,
  features: {
    relVolume: -0.0374,
    amplitude: -0.073,
    atrPct: 0.0148,
    ma20Bias: 0.0656,
    ma60Bias: -0.004,
    limitUp20d: -0.0057,
    gap: 0.0698,
    vwapBias: -0.1058,
    sectorPrior: -0.016,
  },
  nTrain: 767279,
  baseRate: 0.4569,
  fittedOn: "全样本重拟合：2025-12~2026-10-15 全部个股日，标签用次日收盘到 2026-10-16；L2=1.0。完整精度见 goal hidden_files/up-probability/fitted_coefficients.json。",
};

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

/**
 * 预测上涨（跑赢上证）概率。zFeatures 须为 rank 标准化后的 [-1, 1] 特征，
 * 缺失值调用方填 0（中性），不要传 null。
 */
export function predictUpProbability(
  zFeatures: Record<UpFeatureName, number>,
  coef: UpProbabilityCoefficients = FITTED_COEFFICIENTS,
): number {
  let z = coef.intercept;
  for (const name of UP_FEATURE_NAMES) {
    z += coef.features[name] * (zFeatures[name] ?? 0);
  }
  return sigmoid(z);
}
