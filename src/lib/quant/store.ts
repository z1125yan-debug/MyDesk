// Quant Research Lab — 存储层（服务端专用；基于既有 Prisma/SQLite，仅使用追加的新表）
// 因子/策略均为 insert-only 版本化：保存即新增 (key, version)，旧版本永不覆盖。
import { db } from "@/lib/db";
import type {
  ExperimentRecord, FactorCategory, FactorMetrics, FactorRecord, FactorStatus,
  JobRecord, JobStatus, KnowledgeEntry, KnowledgeKind, StrategyRecord, StrategyStatus,
} from "./types.ts";
import type { QuantExperiment, QuantFactor, QuantJob, QuantKnowledge, QuantStrategy } from "@prisma/client";

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function iso(d: Date | string | null | undefined): string {
  if (!d) return "";
  return typeof d === "string" ? d : d.toISOString();
}

// ---------- 因子 ----------

function factorRowToRecord(r: QuantFactor): FactorRecord {
  return {
    id: r.id,
    factorKey: r.factorKey,
    version: r.version,
    name: r.name,
    category: r.category as FactorCategory,
    expression: r.expression,
    params: parseJson(r.params, {}),
    dataSource: r.dataSource,
    dataRange: r.dataRange,
    metrics: parseJson<FactorMetrics>(r.metrics, {}),
    status: r.status as FactorStatus,
    note: r.note,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export async function saveFactorVersion(input: {
  factorKey: string;
  name: string;
  category: FactorCategory;
  expression: string;
  params?: Record<string, unknown>;
  dataSource?: string;
  dataRange?: string;
  metrics?: FactorMetrics;
  status?: FactorStatus;
  note?: string;
}): Promise<FactorRecord> {
  const last = await db.quantFactor.findFirst({
    where: { factorKey: input.factorKey },
    orderBy: { version: "desc" },
  });
  const row = await db.quantFactor.create({
    data: {
      factorKey: input.factorKey,
      version: (last?.version ?? 0) + 1,
      name: input.name,
      category: input.category,
      expression: input.expression,
      params: JSON.stringify(input.params ?? {}),
      dataSource: input.dataSource ?? "em",
      dataRange: input.dataRange ?? "",
      metrics: JSON.stringify(input.metrics ?? {}),
      status: input.status ?? "Candidate",
      note: input.note ?? "",
    },
  });
  return factorRowToRecord(row);
}

// 更新生命周期状态与指标：仅允许改 status/metrics/note/dataRange（表达式与参数不可变）
export async function updateFactorState(
  id: string,
  patch: { status?: FactorStatus; metrics?: FactorMetrics; note?: string; dataRange?: string },
): Promise<FactorRecord | null> {
  const row = await db.quantFactor.update({
    where: { id },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.metrics ? { metrics: JSON.stringify(patch.metrics) } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.dataRange !== undefined ? { dataRange: patch.dataRange } : {}),
    },
  });
  return factorRowToRecord(row);
}

export async function listFactors(filter?: { status?: FactorStatus; category?: FactorCategory; factorKey?: string }): Promise<FactorRecord[]> {
  const rows = await db.quantFactor.findMany({
    where: {
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.category ? { category: filter.category } : {}),
      ...(filter?.factorKey ? { factorKey: filter.factorKey } : {}),
    },
    orderBy: [{ factorKey: "asc" }, { version: "desc" }],
  });
  return rows.map(factorRowToRecord);
}

// 每个因子键取最新版本
export async function listLatestFactors(filter?: { status?: FactorStatus[]; category?: FactorCategory }): Promise<FactorRecord[]> {
  const keys = await db.quantFactor.findMany({ distinct: ["factorKey"], select: { factorKey: true } });
  const out: FactorRecord[] = [];
  for (const { factorKey } of keys) {
    const rows = await db.quantFactor.findMany({
      where: {
        factorKey,
        ...(filter?.status?.length ? { status: { in: filter.status } } : {}),
        ...(filter?.category ? { category: filter.category } : {}),
      },
      orderBy: { version: "desc" },
      take: 1,
    });
    if (rows[0]) out.push(factorRowToRecord(rows[0]));
  }
  return out;
}

export async function getFactor(factorKey: string, version?: number): Promise<FactorRecord | null> {
  const row = await db.quantFactor.findFirst({
    where: { factorKey, ...(version ? { version } : {}) },
    orderBy: { version: "desc" },
  });
  return row ? factorRowToRecord(row) : null;
}

// ---------- 策略 ----------

function strategyRowToRecord(r: QuantStrategy): StrategyRecord {
  return {
    id: r.id,
    strategyKey: r.strategyKey,
    version: r.version,
    name: r.name,
    kind: r.kind as StrategyRecord["kind"],
    factorRefs: parseJson(r.factorRefs, []),
    selection: parseJson(r.selection, {}),
    backtest: parseJson(r.backtest, {}),
    metrics: parseJson(r.metrics, {}),
    status: r.status as StrategyStatus,
    note: r.note,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export async function saveStrategyVersion(input: {
  strategyKey: string;
  name: string;
  kind?: StrategyRecord["kind"];
  factorRefs?: StrategyRecord["factorRefs"];
  selection?: Record<string, unknown>;
  backtest?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  status?: StrategyStatus;
  note?: string;
}): Promise<StrategyRecord> {
  const last = await db.quantStrategy.findFirst({
    where: { strategyKey: input.strategyKey },
    orderBy: { version: "desc" },
  });
  const row = await db.quantStrategy.create({
    data: {
      strategyKey: input.strategyKey,
      version: (last?.version ?? 0) + 1,
      name: input.name,
      kind: input.kind ?? "multi_factor",
      factorRefs: JSON.stringify(input.factorRefs ?? []),
      selection: JSON.stringify(input.selection ?? {}),
      backtest: JSON.stringify(input.backtest ?? {}),
      metrics: JSON.stringify(input.metrics ?? {}),
      status: input.status ?? "Candidate",
      note: input.note ?? "",
    },
  });
  return strategyRowToRecord(row);
}

export async function updateStrategyState(
  id: string,
  patch: { status?: StrategyStatus; metrics?: Record<string, unknown>; note?: string; backtest?: Record<string, unknown> },
): Promise<StrategyRecord | null> {
  const row = await db.quantStrategy.update({
    where: { id },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.metrics ? { metrics: JSON.stringify(patch.metrics) } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.backtest ? { backtest: JSON.stringify(patch.backtest) } : {}),
    },
  });
  return strategyRowToRecord(row);
}

export async function listStrategies(filter?: { status?: StrategyStatus; strategyKey?: string }): Promise<StrategyRecord[]> {
  const rows = await db.quantStrategy.findMany({
    where: {
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.strategyKey ? { strategyKey: filter.strategyKey } : {}),
    },
    orderBy: [{ strategyKey: "asc" }, { version: "desc" }],
  });
  return rows.map(strategyRowToRecord);
}

export async function getStrategy(strategyKey: string, version?: number): Promise<StrategyRecord | null> {
  const row = await db.quantStrategy.findFirst({
    where: { strategyKey, ...(version ? { version } : {}) },
    orderBy: { version: "desc" },
  });
  return row ? strategyRowToRecord(row) : null;
}

// ---------- 实验跟踪 ----------

function experimentRowToRecord(r: QuantExperiment): ExperimentRecord {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    kind: r.kind as ExperimentRecord["kind"],
    startedAt: iso(r.startedAt),
    dataRange: r.dataRange,
    stockPool: parseJson(r.stockPool, {}),
    factorVersions: r.factorVersions,
    strategyVersion: r.strategyVersion,
    parameters: parseJson(r.parameters, {}),
    backtestParameters: parseJson(r.backtestParameters, {}),
    transactionCost: parseJson(r.transactionCost, {}),
    status: r.status as ExperimentRecord["status"],
    result: parseJson(r.result, {}),
    failureReason: r.failureReason,
    agentConclusion: r.agentConclusion,
    jobId: r.jobId,
  };
}

export async function findExperimentByFingerprint(fingerprint: string): Promise<ExperimentRecord | null> {
  const row = await db.quantExperiment.findUnique({ where: { fingerprint } });
  return row ? experimentRowToRecord(row) : null;
}

export async function createExperiment(input: ExperimentRecord): Promise<ExperimentRecord> {
  const row = await db.quantExperiment.create({
    data: {
      id: input.id,
      fingerprint: input.fingerprint,
      kind: input.kind,
      startedAt: new Date(input.startedAt || Date.now()),
      dataRange: input.dataRange,
      stockPool: JSON.stringify(input.stockPool ?? {}),
      factorVersions: input.factorVersions,
      strategyVersion: input.strategyVersion,
      parameters: JSON.stringify(input.parameters ?? {}),
      backtestParameters: JSON.stringify(input.backtestParameters ?? {}),
      transactionCost: JSON.stringify(input.transactionCost ?? {}),
      status: input.status,
      result: JSON.stringify(input.result ?? {}),
      failureReason: input.failureReason,
      agentConclusion: input.agentConclusion,
      jobId: input.jobId,
    },
  });
  return experimentRowToRecord(row);
}

export async function finishExperiment(
  id: string,
  patch: { status: "done" | "failed" | "running"; result?: Record<string, unknown>; failureReason?: string; agentConclusion?: string },
): Promise<void> {
  await db.quantExperiment.update({
    where: { id },
    data: {
      status: patch.status,
      ...(patch.result ? { result: JSON.stringify(patch.result) } : {}),
      ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
      ...(patch.agentConclusion !== undefined ? { agentConclusion: patch.agentConclusion } : {}),
    },
  });
}

export async function listExperiments(limit = 100): Promise<ExperimentRecord[]> {
  const rows = await db.quantExperiment.findMany({ orderBy: { startedAt: "desc" }, take: limit });
  return rows.map(experimentRowToRecord);
}

// ---------- 知识库 ----------

function knowledgeRowToRecord(r: QuantKnowledge): KnowledgeEntry {
  return {
    id: r.id,
    kind: r.kind as KnowledgeKind,
    title: r.title,
    content: r.content,
    refs: parseJson(r.refs, []),
    tags: parseJson(r.tags, []),
    active: r.active,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export async function addKnowledge(input: {
  kind: KnowledgeKind;
  title: string;
  content?: string;
  refs?: string[];
  tags?: string[];
}): Promise<KnowledgeEntry> {
  const row = await db.quantKnowledge.create({
    data: {
      kind: input.kind,
      title: input.title,
      content: input.content ?? "",
      refs: JSON.stringify(input.refs ?? []),
      tags: JSON.stringify(input.tags ?? []),
    },
  });
  return knowledgeRowToRecord(row);
}

export async function listKnowledge(filter?: { kind?: KnowledgeKind; activeOnly?: boolean; q?: string }): Promise<KnowledgeEntry[]> {
  const rows = await db.quantKnowledge.findMany({
    where: {
      ...(filter?.kind ? { kind: filter.kind } : {}),
      ...(filter?.activeOnly ? { active: true } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  const out = rows.map(knowledgeRowToRecord);
  if (filter?.q) {
    const q = filter.q.toLowerCase();
    return out.filter((k) => k.title.toLowerCase().includes(q) || k.content.toLowerCase().includes(q));
  }
  return out;
}

export async function deactivateKnowledge(id: string): Promise<void> {
  await db.quantKnowledge.update({ where: { id }, data: { active: false } });
}

// ---------- 任务快照 ----------

function jobRowToRecord(r: QuantJob): JobRecord {
  return {
    id: r.id,
    kind: r.kind,
    fingerprint: r.fingerprint,
    status: r.status as JobStatus,
    progress: r.progress,
    stage: r.stage,
    message: r.message,
    error: r.error,
    payload: parseJson(r.payload, {}),
    checkpoint: parseJson(r.checkpoint, {}),
    result: parseJson(r.result, {}),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function makeJobPersistHook(): (record: JobRecord) => void {
  return (record) => {
    // 最佳努力的异步快照；失败静默（内存为准）
    void db.quantJob
      .upsert({
        where: { id: record.id },
        create: {
          id: record.id,
          kind: record.kind,
          fingerprint: record.fingerprint,
          status: record.status,
          progress: record.progress,
          stage: record.stage,
          message: record.message,
          error: record.error,
          payload: JSON.stringify(record.payload ?? {}),
          checkpoint: JSON.stringify(record.checkpoint ?? {}),
          result: JSON.stringify(record.result ?? {}),
        },
        update: {
          status: record.status,
          progress: record.progress,
          stage: record.stage,
          message: record.message,
          error: record.error,
          checkpoint: JSON.stringify(record.checkpoint ?? {}),
          result: JSON.stringify(record.result ?? {}),
        },
      })
      .catch(() => undefined);
  };
}

export async function counts(): Promise<{ factors: number; strategies: number; experiments: number; knowledge: number }> {
  const [factors, strategies, experiments, knowledge] = await Promise.all([
    db.quantFactor.count(),
    db.quantStrategy.count(),
    db.quantExperiment.count(),
    db.quantKnowledge.count(),
  ]);
  return { factors, strategies, experiments, knowledge };
}
