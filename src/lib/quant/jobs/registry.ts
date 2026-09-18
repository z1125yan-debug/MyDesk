// Quant Research Lab — 长任务注册表（进度/暂停/恢复/失败归因）
// 纯内存实现 + 可选持久化钩子（服务端启动时 bindJobPersistence 注入 Prisma 快照），
// 模式沿用 mcp-manager.ts 的 globalThis 单例。
import type { JobRecord, JobStatus } from "../types.ts";

export interface JobCtx {
  jobId: string;
  payload: Record<string, unknown>; // startJob 时传入的任务参数
  progress: (percent: number, stage?: string, message?: string) => void;
  paused: () => boolean;
  cancelled: () => boolean;
  saveCheckpoint: (cp: Record<string, unknown>) => void;
  loadCheckpoint: () => Record<string, unknown> | null;
}

export type JobFn = (ctx: JobCtx) => Promise<unknown>;

// 任务函数在分片边界检测到暂停/取消时应保存断点并返回该哨兵
export const JOB_PAUSED = Symbol("quant-job-paused");
export const JOB_CANCELLED = Symbol("quant-job-cancelled");

type PersistHook = (record: JobRecord) => void;

interface RegistryState {
  jobs: Map<string, JobRecord>;
  runners: Map<string, JobFn>;
  persist?: PersistHook;
  seq: number;
}

interface G {
  __quantJobs?: RegistryState;
}
const g = globalThis as unknown as G;
if (!g.__quantJobs) g.__quantJobs = { jobs: new Map(), runners: new Map(), seq: 0 };
const state = g.__quantJobs;

function now(): string {
  return new Date().toISOString();
}

function touch(job: JobRecord): void {
  job.updatedAt = now();
  try {
    state.persist?.(job);
  } catch {
    // 持久化失败不影响运行（内存为准）
  }
}

export function bindJobPersistence(hook: PersistHook): void {
  state.persist = hook;
}

export function registerRunner(kind: string, fn: JobFn): void {
  state.runners.set(kind, fn);
}

export interface StartJobOptions {
  kind: string;
  fingerprint?: string;
  payload?: Record<string, unknown>;
}

export function startJob(opts: StartJobOptions): { job: JobRecord; duplicate: boolean } {
  if (opts.fingerprint) {
    for (const job of state.jobs.values()) {
      if (job.fingerprint === opts.fingerprint && job.kind === opts.kind &&
          (job.status === "queued" || job.status === "running" || job.status === "paused")) {
        return { job, duplicate: true }; // 同指纹任务已在队列/运行/暂停中：不重复执行
      }
    }
  }
  const id = `qj_${Date.now().toString(36)}_${(++state.seq).toString(36)}`;
  const job: JobRecord = {
    id,
    kind: opts.kind,
    fingerprint: opts.fingerprint ?? "",
    status: "queued",
    progress: 0,
    stage: "",
    message: "",
    error: "",
    payload: opts.payload ?? {},
    checkpoint: {},
    result: {},
    createdAt: now(),
    updatedAt: now(),
  };
  state.jobs.set(id, job);
  touch(job);
  void runJob(id); // 异步启动，调用方轮询进度
  return { job, duplicate: false };
}

async function runJob(id: string): Promise<void> {
  const job = state.jobs.get(id);
  if (!job) return;
  const fn = state.runners.get(job.kind);
  if (!fn) {
    job.status = "failed";
    job.error = `任务类型 ${job.kind} 未注册执行器`;
    touch(job);
    return;
  }
  job.status = "running";
  job.error = "";
  touch(job);

  const lastPersist = { at: 0, pct: -1 };
  const ctx: JobCtx = {
    jobId: id,
    payload: job.payload,
    progress: (pct, stage, message) => {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      job.progress = p;
      if (stage !== undefined) job.stage = stage;
      if (message !== undefined) job.message = message;
      // 持久化节流：≥1s 且进度变化 ≥1%
      if (Date.now() - lastPersist.at > 1000 && p !== lastPersist.pct) {
        lastPersist.at = Date.now();
        lastPersist.pct = p;
        touch(job);
      }
    },
    paused: () => job.status === "paused",
    cancelled: () => job.status === "cancelled",
    saveCheckpoint: (cp) => { job.checkpoint = cp; },
    loadCheckpoint: () => (Object.keys(job.checkpoint).length ? job.checkpoint : null),
  };

  try {
    const result = await fn(ctx);
    const statusNow = job.status as JobStatus; // 可能在任务执行中被 pause/cancel API 改写
    if (result === JOB_PAUSED) {
      job.status = statusNow === "cancelled" ? "cancelled" : "paused";
      job.message = job.message || "已保存断点，等待恢复";
    } else if (result === JOB_CANCELLED) {
      job.status = "cancelled";
    } else if (ctx.paused() || ctx.cancelled()) {
      job.status = ctx.cancelled() ? "cancelled" : "paused";
    } else {
      job.status = "done";
      job.progress = 100;
      job.result = (result ?? {}) as Record<string, unknown>;
    }
  } catch (e) {
    job.status = "failed";
    job.error = (e as Error)?.message || String(e);
  }
  touch(job);
}

export async function resumeJob(id: string): Promise<boolean> {
  const job = state.jobs.get(id);
  if (!job || job.status !== "paused") return false;
  await runJob(id);
  return true;
}

export function pauseJob(id: string): boolean {
  const job = state.jobs.get(id);
  if (!job || (job.status !== "running" && job.status !== "queued")) return false;
  job.status = "paused";
  job.message = "暂停请求已发出，等待任务在分片边界停下";
  touch(job);
  return true;
}

export function cancelJob(id: string): boolean {
  const job = state.jobs.get(id);
  if (!job || job.status === "done" || job.status === "failed" || job.status === "cancelled") return false;
  job.status = "cancelled";
  touch(job);
  return true;
}

export function getJob(id: string): JobRecord | undefined {
  return state.jobs.get(id);
}

export function listJobs(filter?: { kind?: string; status?: JobStatus }): JobRecord[] {
  return [...state.jobs.values()]
    .filter((j) => (!filter?.kind || j.kind === filter.kind) && (!filter?.status || j.status === filter.status))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findByFingerprint(kind: string, fingerprint: string, statuses?: JobStatus[]): JobRecord | undefined {
  for (const job of state.jobs.values()) {
    if (job.kind === kind && job.fingerprint === fingerprint) {
      if (!statuses || statuses.includes(job.status)) return job;
    }
  }
  return undefined;
}

export function jobsStats(): { total: number; running: number; paused: number; failed: number; done: number } {
  const stats = { total: state.jobs.size, running: 0, paused: 0, failed: 0, done: 0 };
  for (const j of state.jobs.values()) {
    if (j.status === "running" || j.status === "queued") stats.running++;
    else if (j.status === "paused") stats.paused++;
    else if (j.status === "failed") stats.failed++;
    else if (j.status === "done") stats.done++;
  }
  return stats;
}
