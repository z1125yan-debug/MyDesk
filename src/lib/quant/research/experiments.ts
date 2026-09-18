// Quant Research Lab — 实验跟踪（Phase 9，纯逻辑）
// 指纹 = 对实验全部输入的规范化哈希；同指纹 done/running 的实验不重复执行。
import type { ExperimentRecord } from "../types.ts";

// 稳定 JSON：键递归排序
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return isFinite(value) ? String(Math.round(value * 1e9) / 1e9) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return "null";
}

function hash32(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36) + "_" + s.length.toString(36);
}

export interface ExperimentParts {
  kind: ExperimentRecord["kind"];
  dataRange: string;
  stockPool: Record<string, unknown>;
  factorVersions: string;
  strategyVersion?: string;
  parameters?: Record<string, unknown>;
  backtestParameters?: Record<string, unknown>;
  transactionCost?: Record<string, unknown>;
}

export function experimentFingerprint(parts: ExperimentParts): string {
  const canonical = canonicalJson({
    kind: parts.kind,
    dataRange: parts.dataRange,
    stockPool: parts.stockPool,
    factorVersions: parts.factorVersions,
    strategyVersion: parts.strategyVersion ?? "",
    parameters: parts.parameters ?? {},
    backtestParameters: parts.backtestParameters ?? {},
    transactionCost: parts.transactionCost ?? {},
  });
  return hash32(canonical);
}

export function newExperimentRecord(parts: ExperimentParts): ExperimentRecord {
  return {
    id: `qe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    fingerprint: experimentFingerprint(parts),
    kind: parts.kind,
    startedAt: new Date().toISOString(),
    dataRange: parts.dataRange,
    stockPool: parts.stockPool,
    factorVersions: parts.factorVersions,
    strategyVersion: parts.strategyVersion ?? "",
    parameters: parts.parameters ?? {},
    backtestParameters: parts.backtestParameters ?? {},
    transactionCost: parts.transactionCost ?? {},
    status: "running",
    result: {},
    failureReason: "",
    agentConclusion: "",
    jobId: "",
  };
}
