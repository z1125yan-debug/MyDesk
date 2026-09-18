// Quant Research Lab — 因子挖掘漏斗（资源控制：Candidate → 初筛 → 精筛 → 保存，逐级收敛）
// 纯逻辑：候选逐个评估，支持断点（已完成候选的结果可跳过），由任务执行器驱动。
import { parseExpression, auditExpression, serializeExpression, type Node } from "./expression.ts";
import { evaluateFactorMetrics, isRedundant, type FullMetrics } from "./metrics.ts";
import { evaluateAst } from "./expression.ts";
import type { Panel } from "./panel.ts";
import type { CandidateFactor } from "./templates.ts";
import type { FactorMetrics } from "../types.ts";

export interface MiningConfig {
  horizon: number; // 前向收益天数
  preliminary: { minAbsRankIc: number; minIcIr: number; keep: number };
  fine: { minStability: number; maxTurnover: number; keep: number; redundancyThreshold: number };
  save: number; // 最终入库数量
}

export const DEFAULT_MINING_CONFIG: MiningConfig = {
  horizon: 5,
  preliminary: { minAbsRankIc: 0.02, minIcIr: 0.3, keep: 24 },
  fine: { minStability: 0.5, maxTurnover: 0.6, keep: 10, redundancyThreshold: 0.85 },
  save: 5,
};

export type CandidateStatus =
  | "accepted" | "rejected_audit" | "rejected_preliminary" | "rejected_fine" | "rejected_redundant";

export interface CandidateResult {
  candidate: CandidateFactor;
  status: CandidateStatus;
  reason: string;
  normalizedExpression: string;
  metrics?: {
    ic: number; rankIc: number; icIr: number; icPositiveRatio: number;
    groupReturn: number[]; longShortReturn: number; monotonicity: number;
    turnover: number; stability: number; decay: number | null;
    correlation: { factorKey: string; corr: number }[];
    redundancyWith: string | null;
    sample: { dates: number; stocks: number; validPairs: number };
  };
}

export interface MiningOutcome {
  results: CandidateResult[];
  accepted: CandidateResult[];
  funnel: { generated: number; preliminaryPassed: number; finePassed: number; saved: number };
}

// 精简指标（入库/展示用；丢弃 icSeries 等大数组）
export function trimMetrics(m: FullMetrics): CandidateResult["metrics"] & Record<string, unknown> {
  return {
    ic: m.ic ?? 0, rankIc: m.rankIc ?? 0, icIr: m.icIr ?? 0, icPositiveRatio: m.icPositiveRatio ?? 0.5,
    groupReturn: m.groupReturn ?? [], longShortReturn: m.longShortReturn ?? 0, monotonicity: m.monotonicity ?? 0,
    turnover: m.turnover ?? 1, stability: m.stability ?? 0, decay: m.decay ?? null,
    correlation: m.correlation ?? [], redundancyWith: m.redundancyWith ?? null, sample: m.sample,
  };
}

interface AcceptedTracker {
  chosen: { factorKey: string; mat: (number | null)[][] }[];
  preliminaryPassed: CandidateResult[];
}

export function makeAcceptedTracker(): AcceptedTracker {
  return { chosen: [], preliminaryPassed: [] };
}

// 评估单个候选：审计 → 初筛（IC/ICIR）→ 精筛（稳定性/换手/冗余）
// 返回结果与（若通过）因子矩阵，供后续相关性基准使用。
export function evaluateCandidate(
  candidate: CandidateFactor,
  panel: Panel,
  config: MiningConfig,
  tracker: AcceptedTracker,
  extraBaseline: { factorKey: string; mat: (number | null)[][] }[] = [],
): { result: CandidateResult; mat?: (number | null)[][] } {
  // 1) 静态审计（未来函数/白名单）
  let ast: Node;
  try {
    ast = parseExpression(candidate.expression);
  } catch (e) {
    return { result: { candidate, status: "rejected_audit", reason: (e as Error).message, normalizedExpression: candidate.expression } };
  }
  const audit = auditExpression(ast);
  if (!audit.ok) {
    return {
      result: {
        candidate, status: "rejected_audit",
        reason: `审计未通过：${audit.problems.join("；")}`,
        normalizedExpression: serializeExpression(ast),
      },
    };
  }

  // 2) 求值 + 全指标
  let mat: (number | null)[][];
  try {
    mat = evaluateAst(ast, panel);
  } catch (e) {
    return { result: { candidate, status: "rejected_audit", reason: `求值失败：${(e as Error).message}`, normalizedExpression: serializeExpression(ast) } };
  }
  const full = evaluateFactorMetrics(mat, panel, {
    horizon: config.horizon,
    existingFactorMats: [...tracker.chosen, ...extraBaseline],
    redundancyThreshold: config.fine.redundancyThreshold,
  });

  const normalized = serializeExpression(ast);
  const metrics = trimMetrics(full);
  const rankIc = full.rankIc ?? 0;
  const icIr = full.icIr ?? 0;
  const stability = full.stability ?? 0;
  const turnover = full.turnover ?? 1;
  const longShort = full.longShortReturn ?? 0;

  // 3) 初筛：预测力不足
  if (Math.abs(rankIc) < config.preliminary.minAbsRankIc || icIr < config.preliminary.minIcIr) {
    return {
      result: {
        candidate, status: "rejected_preliminary", normalizedExpression: normalized, metrics,
        reason: `初筛未过：|RankIC|=${Math.abs(rankIc).toFixed(4)}（需≥${config.preliminary.minAbsRankIc}），ICIR=${icIr.toFixed(3)}（需≥${config.preliminary.minIcIr}）`,
      },
    };
  }

  // 4) 冗余：与已选/已有因子高度相关
  const redundancy = full.redundancyWith ?? isRedundant(mat, tracker.chosen, config.fine.redundancyThreshold);
  if (redundancy) {
    return {
      result: {
        candidate, status: "rejected_redundant", normalizedExpression: normalized, metrics,
        reason: `与 ${redundancy} 相关性过高（≥${config.fine.redundancyThreshold}），判为冗余`,
      },
    };
  }

  // 5) 精筛：稳定性 / 换手
  if (stability < config.fine.minStability) {
    return {
      result: {
        candidate, status: "rejected_fine", normalizedExpression: normalized, metrics,
        reason: `精筛未过：稳定性=${stability.toFixed(2)}（需≥${config.fine.minStability}）`,
      },
    };
  }
  if (turnover > config.fine.maxTurnover) {
    return {
      result: {
        candidate, status: "rejected_fine", normalizedExpression: normalized, metrics,
        reason: `精筛未过：换手率=${turnover.toFixed(2)}（需≤${config.fine.maxTurnover}）`,
      },
    };
  }

  tracker.chosen.push({ factorKey: candidate.factorKey, mat });
  return {
    mat,
    result: {
      candidate, status: "accepted", normalizedExpression: normalized, metrics,
      reason: `通过：|RankIC|=${Math.abs(rankIc).toFixed(4)} ICIR=${icIr.toFixed(2)} 稳定性=${stability.toFixed(2)} 多空年化=${(longShort * 100).toFixed(1)}%`,
    },
  };
}

// 完整漏斗（一次性跑完；任务执行器请改用 evaluateCandidate 逐个驱动以便断点）
export function runMiningFunnel(
  candidates: CandidateFactor[],
  panel: Panel,
  config: MiningConfig = DEFAULT_MINING_CONFIG,
  extraBaseline: { factorKey: string; mat: (number | null)[][] }[] = [],
): MiningOutcome {
  const tracker = makeAcceptedTracker();
  const results: CandidateResult[] = [];
  for (const cand of candidates) {
    const { result } = evaluateCandidate(cand, panel, config, tracker, extraBaseline);
    results.push(result);
    tracker.preliminaryPassed.push(result);
  }
  // 初筛通过数（rejected_preliminary 之外的"有指标"即过初筛）
  const preliminaryPassed = results.filter((r) => r.status !== "rejected_audit" && r.status !== "rejected_preliminary").length;
  // 精筛通过 = accepted（冗余计入精筛淘汰）
  const finePassed = results.filter((r) => r.status === "accepted").length;
  const accepted = results.filter((r) => r.status === "accepted").slice(0, config.save);
  return {
    results,
    accepted,
    funnel: { generated: candidates.length, preliminaryPassed, finePassed, saved: accepted.length },
  };
}

// 指标转 FactorMetrics（入库）
export function toFactorMetrics(m: CandidateResult["metrics"]): FactorMetrics {
  if (!m) return {};
  return {
    ic: m.ic, rankIc: m.rankIc, icIr: m.icIr, icPositiveRatio: m.icPositiveRatio,
    groupReturn: m.groupReturn, longShortReturn: m.longShortReturn,
    turnover: m.turnover, stability: m.stability, decay: m.decay ?? undefined,
    correlation: m.correlation,
  };
}
