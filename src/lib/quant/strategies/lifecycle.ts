// Quant Research Lab — 生命周期状态机（Phase 8，纯逻辑）
// 策略：Candidate → Research → Validated → Paper → Live → Monitoring → Degraded → Retired
// 铁律：
//   - Degraded 必须重新进入 Research（禁止直接回到 Live/Paper）
//   - Retired 是终态，不能产生正式 Live Signal
//   - Candidate/Research 只能研究和模拟（不得进入正式选股流程）
//   - 只有 Validated/Paper/Live 可进入正式选股流程
import type { StrategyStatus, FactorStatus } from "../types.ts";

export const STRATEGY_TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  Candidate: ["Research", "Retired"],
  Research: ["Validated", "Retired"],
  Validated: ["Paper", "Research", "Retired"],
  Paper: ["Live", "Research", "Retired"],
  Live: ["Monitoring", "Degraded", "Retired"],
  Monitoring: ["Live", "Degraded", "Retired"],
  Degraded: ["Research", "Retired"],
  Retired: [],
};

export const FACTOR_TRANSITIONS: Record<FactorStatus, FactorStatus[]> = {
  Candidate: ["Validated", "Retired"],
  Validated: ["Paper", "Degraded", "Retired"],
  Paper: ["Live", "Degraded", "Retired"],
  Live: ["Degraded", "Retired"],
  Degraded: ["Validated", "Retired"],
  Retired: [],
};

export class LifecycleError extends Error {}

export function assertStrategyTransition(from: StrategyStatus, to: StrategyStatus): void {
  if (from === to) return;
  const allowed = STRATEGY_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new LifecycleError(`非法策略状态迁移：${from} → ${to}（允许：${allowed.join("、") || "无（终态）"}）`);
  }
  if (from === "Degraded" && to !== "Research" && to !== "Retired") {
    throw new LifecycleError("Degraded 策略必须重新进入 Research（或退役）");
  }
}

export function assertFactorTransition(from: FactorStatus, to: FactorStatus): void {
  if (from === to) return;
  const allowed = FACTOR_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new LifecycleError(`非法因子状态迁移：${from} → ${to}（允许：${allowed.join("、") || "无（终态）"}）`);
  }
}

// 正式选股流程准入：只有 Validated/Paper/Live
export function canEnterOfficialSelection(strategyStatus: StrategyStatus): boolean {
  return strategyStatus === "Validated" || strategyStatus === "Paper" || strategyStatus === "Live";
}

// Retired 永远不能产生正式 Live Signal
export function canProduceLiveSignal(strategyStatus: StrategyStatus): boolean {
  return strategyStatus !== "Retired" && canEnterOfficialSelection(strategyStatus);
}

// 状态迁移是否需要附证据（验证报告/绩效/监控数据）
export function transitionEvidence(
  from: StrategyStatus,
  to: StrategyStatus,
): "validation_report" | "performance_metrics" | "monitoring_report" | "none" {
  switch (`${from}->${to}`) {
    case "Research->Validated": return "validation_report"; // 必须附 Walk-forward/OOS 报告
    case "Validated->Paper": return "performance_metrics";
    case "Paper->Live": return "performance_metrics";
    case "Live->Monitoring": return "none";
    case "Monitoring->Live": return "monitoring_report";
    default: return "none";
  }
}
