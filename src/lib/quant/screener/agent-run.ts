// P6-D Agent 循环的服务层：准入 → 执行 → 记账 → 落库 → 下一轮提示词，一次 HTTP 请求走一格。
//
// 为什么循环不在服务端一口气跑完（而是一格一请求）：
// AI 凭据只在客户端，/api/ai/proxy 只做「文本进文本出」，服务端没有模型可调（P6-D 前置审计结论）。
// 所以「下一步做什么」在模型那边，「这一步算不算数」在这里：
// - 准入、预算、重试上限、同参数缓存、日志、台账、复校验全由内核（agent-loop-core.ts）判；
// - 取数由 agent-tools.ts 执行；本层只做两者之间的装配 + 把每一条写进库；
// - 模型说「我已经调用过某工具」不产生任何记录：只有本层写过 agent_tool_call 的行才算调用过。
//
// 本文件的写法约束（与 P4 history.ts 同一条理由）：不 import 任何带 @/ 别名的运行时模块，
// 时钟与 db 由调用方注入，执行器用**动态 import**（只有真打上游时才加载 agent-tools.ts）。
// 这样 node --test 才能用「隔离库副本 + 假执行器」对状态重建、预算、幂等写入做真实断言，
// 而不是把这些判定在测试里抄一遍。假执行器产出的行只用于验证机制，测试与页面都必须写明它不是行情。
import type { PrismaClient } from "@prisma/client";
import {
  AGENT_PROTOCOL_VERSION, LOG_STATUSES, admitCall, budgetRemaining, buildAgentSystemPrompt, buildAgentTurnPrompt,
  classifyDeadEnd, evidenceLayerOf, logStatusOf, nextAction, normalizeBudget, parseAgentDirective,
  recordCall, startRun, summarizeRun, verifyAgentAnswer,
  type AgentAnswerCheck, type AgentDirective, type AgentState, type AgentStopReason, type DeadEnd,
  type LogStatus, type ToolCallLogEntry,
} from "./agent-loop-core.ts";
import { agentToolBasis, findTool, obsNotes, SUMMARY_MAX_LEN } from "./agent-tools-core.ts";
import type { ToolObservation } from "./agent-tools-core.ts";
import { DATA_STATUSES, type DataStatus, type ObservationKind } from "./datastatus-core.ts";
// 类型引用（编译期擦除）：运行时依赖走下面的动态 import，避免 node --test 解析不到 @/ 别名链。
import type { AgentToolRun, runAgentTool } from "./agent-tools.ts";

export type AgentRunDb = Pick<PrismaClient, "agentRun" | "agentToolCall">;
export type RunToolFn = typeof runAgentTool;

/** 每次请求都给定时间口径：调用方传 shanghaiStamp() 与 Date.now()，本层不读时钟（否则单测不可重现） */
export interface AgentClock {
  /** 北京时间墙钟原文，写进日志与 as_of */
  now: string;
  /** 毫秒基准（预算里的时长维度用它算） */
  now_ms: number;
}

const RUN_ID_MAX = 64;
const LOG_STATUS_SET = new Set<string>(LOG_STATUSES as readonly string[]);
const DATA_STATUS_SET = new Set<string>(DATA_STATUSES as readonly string[]);

/**
 * HTTP 状态码由服务层给，不留给路由用正则猜中文（那等于把「参数错」「找不到」「已收尾」压成同一个 400）。
 * 200 = 这一步照常记账（哪怕取数失败：失败本身是这次运行的真实结果，不是接口出错）；
 * 400 = 请求本身不合法（没建账、没记账）；404 = run_id 不存在；
 * 409 = 这次运行已经不能再收（已收尾 / 收尾时模型给的是工具请求 / 本次结论不可用但库里那条更站得住）；
 * 422 = 服务端读了库也记了账，但复校验判定这份结论不可回溯（REJECTED，原文照存）；
 * 502 = 库里读写异常（由路由的 catch 分支给，本层不会返回它）。
 */
export type AgentHttp = 200 | 400 | 404 | 409 | 422 | 502;

const s = (v: unknown): string => String(v ?? "");
const num = (v: unknown): number => (v === null || v === undefined || !isFinite(Number(v)) ? 0 : Number(v));

function jarr(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function jcol<T>(raw: unknown, fallback: T): T {
  try {
    const v = JSON.parse(String(raw ?? ""));
    return v === null || v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/** run_id 口径：客户端生成（uuid 或等长以内的短串），服务端只按它整批读调用行 */
export function runIdError(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return "缺少 run_id：Agent 的每一步都要挂在同一次运行上，没有它无法回答「刚才调用了什么」";
  if (v.length > RUN_ID_MAX) return `run_id 过长（${v.length} > ${RUN_ID_MAX}）：请用 uuid 或等长以内的短串`;
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return "run_id 只能含字母数字与 -_：库里要按它整批读调用行，不接受带路径或空格的串";
  return null;
}

// ---------- 行 ↔ 内核日志的双向映射（§十八 的字段一个都不能在落库时丢掉） ----------

/** agent_tool_call 的本层读取切片：测试里可以直接给纯对象，不必先连库 */
export interface ToolCallRow {
  runId: string; step: number; tool: string; capability: string; executor: string;
  inputJson: string; outputStatus: string; kind: string; dataStatus: string; source: string; asOf: string;
  latencyMs: number | null; error: string; fallbackOf: string; degradedFrom: string; attempt: number;
  callKey: string; cachedFrom: string; evidenceId: string; thought: string; summary: string;
  notesJson: string; refsJson: string; timestamp: string;
}

/** 日志 → 库行：ToolCallLogEntry 的 19 个字段全部成列，任何一列缺失都会让事后重建丢东西 */
export function entryToRow(
  runId: string, e: ToolCallLogEntry,
  extra: { capability?: string | null; executor?: string | null; summary?: string; notes?: string[]; refs?: string[] } = {},
): ToolCallRow {
  const tool = findTool(e.tool);
  return {
    runId, step: e.step, tool: e.tool,
    capability: extra.capability ?? tool?.capability ?? "",
    executor: extra.executor ?? tool?.executor ?? "",
    inputJson: JSON.stringify(e.input ?? {}),
    outputStatus: e.output_status,
    kind: e.kind ?? "",
    dataStatus: e.data_status ?? "",
    source: e.source ?? "",
    asOf: e.as_of ?? "",
    latencyMs: e.latency_ms ?? null,
    error: e.error ?? "",
    fallbackOf: e.fallback_of ?? "",
    degradedFrom: e.degraded_from ?? "",
    attempt: e.attempt,
    callKey: e.call_key ?? "",
    cachedFrom: e.cached_from ?? "",
    evidenceId: e.evidence_id ?? "",
    thought: e.thought ?? "",
    summary: extra.summary ?? "",
    notesJson: JSON.stringify(extra.notes ?? []),
    refsJson: JSON.stringify(extra.refs ?? []),
    timestamp: e.timestamp,
  };
}

/** 库行 → 日志：admitCall / 提示词 / summarizeRun 全都吃 ToolCallLogEntry，所以这里必须无损 */
export function rowToEntry(r: ToolCallRow): ToolCallLogEntry {
  const status = s(r.outputStatus);
  const kind = s(r.kind);
  const ds = s(r.dataStatus);
  return {
    run_id: s(r.runId), step: num(r.step), tool: s(r.tool),
    input: jcol<Record<string, unknown>>(r.inputJson, {}),
    output_status: (LOG_STATUS_SET.has(status) ? status : "failed") as LogStatus,
    kind: (kind || null) as ObservationKind | null,
    latency_ms: r.latencyMs === null || r.latencyMs === undefined ? null : num(r.latencyMs),
    source: s(r.source) || null,
    as_of: s(r.asOf) || null,
    data_status: (ds || null) as DataStatus | null,
    error: s(r.error) || null,
    fallback_of: s(r.fallbackOf) || null,
    attempt: num(r.attempt) || 1,
    call_key: s(r.callKey),
    cached_from: s(r.cachedFrom) || null,
    evidence_id: s(r.evidenceId) || null,
    thought: s(r.thought),
    degraded_from: s(r.degradedFrom) || null,
    timestamp: s(r.timestamp),
  };
}

/**
 * 一次运行的状态重建：run 行（预算 + 问题 + 停止原因）+ 调用行 ⇒ AgentState。
 * 这是「进程重启后仍能接着跑、仍能回看」的依据，也是 §十八 那四个问题能事后回答的前提。
 * step / tool_calls / attempts / cache / consecutive 全从调用行推，不另存一份「真相」：
 * 两处各存一份迟早会不一样，那时页面显示的计数就不是任何一次真实跑出来的数了。
 */
export function replayAgentState(input: {
  runId: string; question: string; budgetJson: unknown; startedAt: string; startedMs: number;
  stop: { reason: AgentStopReason; detail: string } | null; rows: ToolCallRow[];
}): { state: AgentState; skipped: string[] } {
  const { budget } = normalizeBudget(jcol<unknown>(input.budgetJson, {}));
  const log: ToolCallLogEntry[] = [];
  const evidence: AgentState["evidence"] = [];
  const cache: Record<string, string> = {};
  const attempts: Record<string, number> = {};
  const skipped: string[] = [];
  let toolCalls = 0;
  let consecutive = 0;
  for (const r of [...input.rows].sort((a, b) => num(a.step) - num(b.step))) {
    const e = rowToEntry(r);
    log.push(e);
    if (e.output_status !== "cached") {
      toolCalls += 1;
      attempts[e.tool] = Math.max(attempts[e.tool] ?? 0, e.attempt);
    }
    consecutive = e.output_status === "ok" ? 0 : consecutive + 1;
    if (!e.evidence_id) continue;
    if (e.output_status === "cached") {
      // cached 行的 evidence_id 指向的是**原始那一条**台账：这里只恢复缓存索引，绝不再插一份。
      // 再插会让同一行台账在重建后的 state 里出现两次，台账上限、引用数、血缘全都被灌水。
      if (e.call_key && !cache[e.call_key]) cache[e.call_key] = e.evidence_id;
      continue;
    }
    const ds = s(r.dataStatus);
    const layer = DATA_STATUS_SET.has(ds) ? evidenceLayerOf(ds as DataStatus) : null;
    if (!layer) {
      // 正常路径不会出现（recordCall 只会用可分层的状态编台账）。真出现了就是库里的行不认识，
      // 宁可不引用它并把这条写进缺口，也不按 FACTS 顶替（那等于把未知当事实）。
      skipped.push(`步 ${e.step} 的 ${e.tool}：台账行 ${e.evidence_id} 的分层值「${ds || "空"}」不在 DATA_STATUSES 内，本层不把它当证据`);
      continue;
    }
    evidence.push({
      line: {
        id: e.evidence_id, layer, text: s(r.summary), capability: s(r.tool),
        source: s(r.source) || "未记录", as_of: s(r.asOf) || "未记录", data_status: ds,
      },
      tool: s(r.tool), executor: s(r.executor) || null, call_key: s(r.callKey),
      step: e.step, run_id: s(r.runId), refs: jarr(r.refsJson),
    });
    if (e.call_key) cache[e.call_key] = e.evidence_id;
  }
  return {
    state: {
      run_id: input.runId, question: input.question, budget, started_at: input.startedAt, started_ms: input.startedMs,
      step: log.length, tool_calls: toolCalls, attempts_by_tool: attempts, cache,
      log, evidence, missing: [], consecutive_no_progress: consecutive, stop: input.stop,
    },
    skipped,
  };
}

/** run 行的本层字段切片（Prisma 行 → 纯对象：缺列一律给空值，不让 undefined 漏进响应） */
interface RunMeta {
  runId: string; question: string; status: string; model: string; promptVersion: string; protocolVersion: string;
  budgetJson: string; budgetNotes: string; stateJson: string;
  steps: number; toolCalls: number; evidenceLines: number; missingLines: number;
  cachedHits: number; fallbackUsed: number; latencyTotalMs: number; logStatusCounts: string;
  evidenceJson: string; answerText: string; answerCites: string; answerGaps: string; answerStatus: string;
  violations: string; lineageJson: string; missingJson: string;
  stopReason: string; stopDetail: string; basis: string; startedAt: string; finishedAt: string; elapsedMs: number;
}

type AnyRow = Record<string, unknown>;
const meta = (r: AnyRow): RunMeta => ({
  runId: s(r.runId), question: s(r.question), status: s(r.status), model: s(r.model),
  promptVersion: s(r.promptVersion), protocolVersion: s(r.protocolVersion),
  budgetJson: s(r.budgetJson), budgetNotes: s(r.budgetNotes), stateJson: s(r.stateJson),
  steps: num(r.steps), toolCalls: num(r.toolCalls), evidenceLines: num(r.evidenceLines), missingLines: num(r.missingLines),
  cachedHits: num(r.cachedHits), fallbackUsed: num(r.fallbackUsed), latencyTotalMs: num(r.latencyTotalMs),
  logStatusCounts: s(r.logStatusCounts), evidenceJson: s(r.evidenceJson),
  answerText: s(r.answerText), answerCites: s(r.answerCites), answerGaps: s(r.answerGaps), answerStatus: s(r.answerStatus),
  violations: s(r.violations), lineageJson: s(r.lineageJson), missingJson: s(r.missingJson),
  stopReason: s(r.stopReason), stopDetail: s(r.stopDetail), basis: s(r.basis),
  startedAt: s(r.startedAt), finishedAt: s(r.finishedAt), elapsedMs: num(r.elapsedMs),
});

const callRow = (r: AnyRow): ToolCallRow => ({
  runId: s(r.runId), step: num(r.step), tool: s(r.tool), capability: s(r.capability), executor: s(r.executor),
  inputJson: s(r.inputJson), outputStatus: s(r.outputStatus), kind: s(r.kind), dataStatus: s(r.dataStatus),
  source: s(r.source), asOf: s(r.asOf),
  latencyMs: r.latencyMs === null || r.latencyMs === undefined ? null : num(r.latencyMs),
  error: s(r.error), fallbackOf: s(r.fallbackOf), degradedFrom: s(r.degradedFrom),
  attempt: num(r.attempt) || 1, callKey: s(r.callKey), cachedFrom: s(r.cachedFrom), evidenceId: s(r.evidenceId),
  thought: s(r.thought), summary: s(r.summary), notesJson: s(r.notesJson), refsJson: s(r.refsJson), timestamp: s(r.timestamp),
});

function stopOf(m: RunMeta): { reason: AgentStopReason; detail: string } | null {
  return m.stopReason ? { reason: m.stopReason as AgentStopReason, detail: m.stopDetail } : null;
}

/** 每次调用后刷新的 run 行派生列：页面任何时候读到的都是当前真实值，不是收尾时才补 */
function counters(state: AgentState, clock: AgentClock) {
  const sum = summarizeRun(state, null, clock.now_ms);
  return {
    steps: num(sum.steps), toolCalls: num(sum.tool_calls), evidenceLines: state.evidence.length,
    missingLines: state.missing.length, cachedHits: num(sum.cached_hits), fallbackUsed: num(sum.fallback_used),
    latencyTotalMs: num(sum.latency_total_ms), logStatusCounts: s(sum.log_status_counts),
    evidenceJson: JSON.stringify(state.evidence.map((r) => r.line)),
    missingJson: JSON.stringify(state.missing),
    budgetJson: JSON.stringify(state.budget),
    // stateJson 只存「推不出来的」那几项（起算时刻 + 停止原因 + 缺口原文）；计数一律从调用行重建
    stateJson: JSON.stringify({ started_at: state.started_at, started_ms: state.started_ms, missing: state.missing, stop: state.stop }),
    stopReason: state.stop?.reason ?? "", stopDetail: state.stop?.detail ?? "",
  };
}

/**
 * 库行 → §十八 的日志形状（蛇形字段名，与 LOG_FIELDS 同名）。
 * 走一步的响应（POST /api/agent/tool 的 call）与整次运行的时间线（GET /api/agent/run 的 timeline）
 * 共用这一份映射：同一条调用行在两个接口上必须同形，否则页面要为「刚跑的那一步」和「回看的那一步」
 * 各写一套渲染，而 §三十一 要的正是错误/结果结构稳定。
 */
export function rowToLog(r: ToolCallRow): AnyRow {
  return {
    run_id: r.runId, step: r.step, tool: r.tool, capability: r.capability, executor: r.executor,
    input: jcol<Record<string, unknown>>(r.inputJson, {}),
    output_status: r.outputStatus, kind: r.kind || null, data_status: r.dataStatus || null,
    source: r.source, as_of: r.asOf,
    // null = 没计时（准入阶段被挡下的调用就是 null）：写成 0 会冒充「打过快回来的请求」
    latency_ms: r.latencyMs === null || r.latencyMs === undefined ? null : num(r.latencyMs),
    error: r.error, fallback_of: r.fallbackOf, degraded_from: r.degradedFrom, attempt: r.attempt,
    call_key: r.callKey, cached_from: r.cachedFrom, evidence_id: r.evidenceId,
    thought: r.thought, summary: r.summary,
    notes: jarr(r.notesJson), refs: jarr(r.refsJson), timestamp: r.timestamp,
  };
}

async function upsertCall(db: AgentRunDb, row: ToolCallRow): Promise<void> {
  const data = {
    tool: row.tool, capability: row.capability, executor: row.executor, inputJson: row.inputJson,
    outputStatus: row.outputStatus, kind: row.kind, dataStatus: row.dataStatus, source: row.source, asOf: row.asOf,
    latencyMs: row.latencyMs, error: row.error, fallbackOf: row.fallbackOf, degradedFrom: row.degradedFrom,
    attempt: row.attempt, callKey: row.callKey, cachedFrom: row.cachedFrom, evidenceId: row.evidenceId,
    thought: row.thought, summary: row.summary.slice(0, SUMMARY_MAX_LEN + 10),
    notesJson: row.notesJson, refsJson: row.refsJson, timestamp: row.timestamp,
  };
  // 自然键 (runId, step)：客户端把同一步重发一次（网络重试、刷新后重连）是覆盖而不是多出一步。
  // 「跑了几次」由内核计数决定，不由 HTTP 重试次数决定 —— 与 P2 task_run 的幂等口径同源。
  await db.agentToolCall.upsert({
    where: { runId_step: { runId: row.runId, step: row.step } },
    update: data,
    create: { runId: row.runId, step: row.step, ...data },
  });
}

// ---------- 读一次运行 ----------

export interface LoadedRun {
  meta: RunMeta;
  state: AgentState;
  rows: ToolCallRow[];
  /** 重建时发现的不认识行（正常应为空；非空必须显示在缺口里） */
  skipped: string[];
}

/**
 * 读一次运行的全部状态：run 行 + 调用行 → AgentState。
 * 找不到 run 行返回 null：路由据此回 404，而不是回一条「空运行」——空运行会被读成「Agent 什么都没调」，
 * 而真实情况是「这个 run_id 从没开过」，两件事不能混（§十六）。
 */
export async function loadAgentRun(runId: string, db: AgentRunDb): Promise<LoadedRun | null> {
  const run = await db.agentRun.findUnique({ where: { runId } });
  if (!run) return null;
  const m = meta(run as unknown as AnyRow);
  const rows = (await db.agentToolCall.findMany({ where: { runId }, orderBy: { step: "asc" } }))
    .map((r) => callRow(r as unknown as AnyRow));
  const st = jcol<Record<string, unknown>>(m.stateJson, {});
  const { state, skipped } = replayAgentState({
    runId: m.runId, question: m.question, budgetJson: m.budgetJson,
    startedAt: m.startedAt || s(st.started_at), startedMs: num(st.started_ms), stop: stopOf(m), rows,
  });
  state.missing = [...jarr(m.missingJson), ...skipped];
  return { meta: m, state, rows, skipped };
}

// ---------- 三个入口：开跑 / 走一步 / 收尾 ----------

export interface AgentStartResult {
  ok: boolean;
  error: string | null;
  /** HTTP 状态码由本层定（见 AgentHttp 注释）：路由直接照它回，不再自己判中文 */
  http: AgentHttp;
  run_id: string;
  /** true = 这个 run_id 库里已有：本次是接着跑/回看，没有清空已有调用 */
  resumed: boolean;
  status: string;
  question: string;
  budget: unknown;
  budget_notes: string[];
  missing: string[];
  prompt: { system: string; turn: string; protocol: string };
  next_turn: { action: "continue" | "stop"; reason: AgentStopReason | null; detail: string };
  summary: Record<string, string | number | boolean | null>;
  basis: string;
}

/**
 * 开一次研究运行（幂等）：同一个 run_id 再提交不会清空已成立的调用记录，也不会重打上游。
 * 问题为空 ⇒ 内核写明「没有研究问题」并进 notes：本层不替模型编一个「当前市场如何」。
 */
export async function startAgentRun(input: {
  run_id: unknown; question: unknown; budget?: unknown; model?: string; prompt_version?: string;
}, db: AgentRunDb, clock: AgentClock): Promise<AgentStartResult> {
  const rid = String(input.run_id ?? "").trim();
  const noRun: AgentStartResult = {
    ok: false, error: "", http: 400, run_id: rid, resumed: false, status: "", question: "", budget: null,
    budget_notes: [], missing: [], prompt: { system: "", turn: "", protocol: AGENT_PROTOCOL_VERSION },
    next_turn: { action: "stop", reason: "not_run", detail: "" }, summary: {}, basis: "",
  };
  const err = runIdError(rid);
  if (err) return { ...noRun, error: err, missing: [err], next_turn: { action: "stop", reason: "not_run", detail: err }, basis: "参数校验未通过：没有写库" };

  const existed = await loadAgentRun(rid, db);
  if (existed) {
    const { state } = existed;
    return {
      ...noRun, ok: true, error: null, http: 200, resumed: true, status: existed.meta.status, question: state.question,
      budget: state.budget, budget_notes: jarr(existed.meta.budgetNotes), missing: state.missing,
      prompt: { system: buildAgentSystemPrompt(), turn: buildAgentTurnPrompt(state, { now_ms: clock.now_ms, now: clock.now }), protocol: AGENT_PROTOCOL_VERSION },
      next_turn: nextAction(state, clock.now_ms),
      summary: summarizeRun(state, null, clock.now_ms),
      basis:
        `库里已有这次运行（${state.log.length} 条调用记录、台账 ${state.evidence.length} 行）：本次是接着跑/回看，` +
        `没有清空已有记录，也没有重打上游（重复提交同一 run_id 就是这个效果）。`,
    };
  }

  const { state, notes } = startRun({ run_id: rid, question: String(input.question ?? ""), budget: input.budget, started_at: clock.now, started_ms: clock.now_ms });
  const data = {
    question: state.question, status: "running", model: s(input.model).slice(0, 80),
    promptVersion: s(input.prompt_version || AGENT_PROTOCOL_VERSION).slice(0, 40),
    protocolVersion: AGENT_PROTOCOL_VERSION, budgetNotes: JSON.stringify(notes),
    startedAt: clock.now, basis: agentToolBasis(), ...counters(state, clock),
  };
  await db.agentRun.upsert({ where: { runId: rid }, update: data, create: { runId: rid, ...data } });
  return {
    ...noRun, ok: true, error: null, http: 200, status: "running", question: state.question, budget: state.budget,
    budget_notes: notes, missing: notes,
    prompt: { system: buildAgentSystemPrompt(), turn: buildAgentTurnPrompt(state, { now_ms: clock.now_ms, now: clock.now }), protocol: AGENT_PROTOCOL_VERSION },
    next_turn: nextAction(state, clock.now_ms),
    summary: summarizeRun(state, null, clock.now_ms),
    basis:
      `本次运行已建账（预算：步 ${state.budget.max_steps}／调用 ${state.budget.max_tool_calls}／时长 ${Math.round(state.budget.max_total_ms / 1000)}s，` +
      `都是 §十七 的推荐值或用户收紧值）。协议 ${AGENT_PROTOCOL_VERSION}：模型只输出文本里的一个 JSON，取数与判定都在服务端。`,
  };
}

export interface AgentStepResult {
  ok: boolean;
  error: string | null;
  http: AgentHttp;
  run_id: string;
  admitted: boolean;
  /**
   * 这一步的日志原文（含被拒绝的请求：§十八 要连「为什么没跑」一起答）。
   * 字段名用 §十八 的蛇形（rowToLog），与 GET /api/agent/run 的 timeline 行同形。
   */
  call: AnyRow;
  /** 实际生效的入参（校验后）；被拒绝时是 {}。库里 inputJson 存的是模型请求原文，两份都给页面 */
  params_effective: Record<string, unknown>;
  observation: {
    kind: string | null; data_status: string | null; source: string | null; as_of: string | null;
    summary: string; reason: string | null; notes: string[]; degraded_from: string | null; timed_out: boolean;
    payload: unknown;
  };
  dead_end: DeadEnd | null;
  budget_left: ReturnType<typeof budgetRemaining>;
  evidence_lines: number;
  missing: string[];
  next_turn: { action: "continue" | "stop"; reason: AgentStopReason | null; detail: string };
  prompt: { turn: string } | null;
  summary: Record<string, string | number | boolean | null>;
  basis: string;
}

const NO_OBS = { kind: null, data_status: null, source: null, as_of: null, summary: "", reason: null, notes: [], degraded_from: null, timed_out: false, payload: null };

function obsView(obs: ToolObservation) {
  return {
    kind: obs.kind as string | null, data_status: obs.data_status as string | null, source: obs.source, as_of: obs.as_of,
    summary: obs.summary, reason: obs.reason ?? null, notes: obsNotes(obs), degraded_from: obs.degraded_from ?? null,
    timed_out: !!obs.timed_out, payload: obs.payload ?? null,
  };
}

/** 上一次碰壁的工具 → 本次是不是它登记表里的兜底（Tool A failed → Tool B success；不是本层猜的链） */
function fallbackOfLastFailure(state: AgentState, toolName: string): string | null {
  const last = [...state.log].reverse()
    .find((e) => e.output_status === "failed" || e.output_status === "timeout" || e.output_status === "empty" || e.output_status === "not_supported");
  if (!last || last.tool === toolName) return null;
  return (findTool(last.tool)?.fallbacks ?? []).includes(toolName) ? last.tool : null;
}

const rawArgs = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/**
 * 走一步：准入 → （必要时）执行 → 记账 → 落库 → 回下一轮提示词。
 * 被挡下的四种原因（不支持 / 参数错 / 预算 / 已停止）同样各写一条 agent_tool_call 行：
 * 「模型请求过但没执行」是 §十八 要答得出的事实，静默丢弃就等于掩盖它。
 */
export async function runAgentStep(input: {
  run_id: unknown; tool: unknown; args?: unknown; thought?: string; timeout_ms?: number;
}, db: AgentRunDb, clock: AgentClock, runTool?: RunToolFn): Promise<AgentStepResult> {
  const rid = String(input.run_id ?? "").trim();
  const toolName = String(input.tool ?? "");
  const base: AgentStepResult = {
    ok: false, error: "", http: 400, run_id: rid, admitted: false, call: {}, params_effective: {}, observation: NO_OBS,
    dead_end: null, budget_left: budgetRemaining(startRun({ run_id: rid, question: "", started_at: "", started_ms: clock.now_ms }).state, clock.now_ms),
    evidence_lines: 0, missing: [], next_turn: { action: "stop", reason: "not_run", detail: "" },
    prompt: null, summary: {}, basis: "本次没有执行：见 error",
  };
  const err = runIdError(rid);
  if (err) return { ...base, error: err, missing: [err], next_turn: { action: "stop", reason: "not_run", detail: err }, basis: "run_id 不合法：没有建账也没有记账（本层不会替一个不认识的 id 写行，那等于凭空造一次研究）" };
  const loaded = await loadAgentRun(rid, db);
  if (!loaded) {
    return {
      ...base, http: 404, error: `找不到 run_id「${rid}」：请先用 /api/agent/run 开一次运行再请求工具（本层不会替一个没开过的 run 建账）`,
      missing: [`run_id「${rid}」不存在`],
      basis: "库里没有这次运行：没有记账。「没开过」与「开过但一条读数没取到」是两件事，后者会有行并带停止原因（§十六）",
    };
  }
  if (loaded.meta.status === "finished") {
    const why = `这次运行已经收尾（answer_status=${loaded.meta.answerStatus || "未记录"}）：不再接受新的工具调用，请开新的 run_id`;
    return {
      ...base, http: 409, error: why, admitted: false, missing: [why],
      next_turn: { action: "stop", reason: "answered", detail: "本次运行已收尾" },
      summary: summarizeRun(loaded.state, null, clock.now_ms), budget_left: budgetRemaining(loaded.state, clock.now_ms, toolName),
      // 为什么这一次不记账：收尾后的请求不属于那次的步骤序列，写进去会改动已成立结论的血缘（§十九）
      basis: "这次运行已收尾：这一步没有记账（写了就会给已成立的结论多出一条不属于它的血缘）。要继续查请开新的 run_id，旧的那次回看仍然完整可读",
    };
  }

  const args = rawArgs(input.args);
  const thought = s(input.thought);
  const admission = admitCall(loaded.state, toolName, args, clock.now_ms);
  let state = loaded.state;
  let entry: ToolCallLogEntry;
  let obs: ToolObservation | null = null;
  let params: Record<string, unknown> = {};
  let extra: Parameters<typeof entryToRow>[2] = {};

  if (admission.cached_from) {
    // 同参数本次运行已取过：不再打上游，复用那条台账行（§三十二）
    const src = loaded.rows.find((r) => s(r.evidenceId) === admission.cached_from);
    const rec = recordCall(state, {
      tool: admission.tool ?? toolName, input: args, call_key: admission.call_key, output_status: "cached",
      cached_from: admission.cached_from, thought, timestamp: clock.now, latency_ms: 0,
      kind: (s(src?.kind) || null) as ObservationKind | null,
      source: s(src?.source) || null, as_of: s(src?.asOf) || null,
      data_status: (s(src?.dataStatus) || null) as DataStatus | null,
      summary: s(src?.summary),
    });
    state = rec.state; entry = rec.entry; params = admission.value;
    extra = {
      summary: s(src?.summary), refs: jarr(src?.refsJson),
      notes: ["命中本次运行的同参数缓存：本次没有打上游，读数是原始那一次取到的"],
    };
  } else if (!admission.allowed) {
    const status: LogStatus = admission.failure === "bad_params" ? "bad_params"
      : admission.failure === "not_supported" ? "not_supported"
      : admission.failure === "timeout" ? "timeout" : "budget";
    const rec = recordCall(state, {
      tool: admission.tool ?? toolName, input: args, call_key: admission.call_key,
      output_status: status, error: admission.reason, thought, timestamp: clock.now, latency_ms: null,
    });
    state = rec.state; entry = rec.entry;
    extra = { notes: ["本次未执行任何取数（在准入阶段被挡下）"] };
  } else {
    const exec: RunToolFn = runTool ?? (await import("./agent-tools.ts")).runAgentTool;
    const ran: AgentToolRun = await exec(admission.tool ?? toolName, admission.value, { timeout_ms: input.timeout_ms });
    obs = ran.obs;
    const status = logStatusOf(obs.kind, !!obs.timed_out);
    const rec = recordCall(state, {
      tool: admission.tool ?? toolName, input: args, call_key: admission.call_key, output_status: status,
      kind: obs.kind, summary: obs.summary, payload: obs.payload,
      source: obs.source, as_of: obs.as_of, data_status: obs.data_status,
      error: status === "ok" ? null : (obs.reason ?? "未给出原因"),
      latency_ms: ran.latency_ms, thought,
      fallback_of: fallbackOfLastFailure(state, admission.tool ?? toolName),
      degraded_from: obs.degraded_from ?? null, timestamp: clock.now,
    });
    state = rec.state; entry = rec.entry; params = ran.params;
    extra = {
      capability: ran.capability, executor: ran.executor, summary: obs.summary,
      notes: obsNotes(obs).concat(ran.param_errors.length ? [`执行器复判的入参错误：${ran.param_errors.join("；")}`] : []),
      refs: state.evidence.find((e) => e.line.id === entry.evidence_id)?.refs ?? [],
    };
  }

  // 记完这一步再看预算：撞墙就把停止原因写进 state（下一轮提示词与页面都要答得出「为什么停」）
  const na = nextAction(state, clock.now_ms);
  if (na.action === "stop" && !state.stop) state = { ...state, stop: { reason: na.reason ?? "max_steps", detail: na.detail } };
  const row = entryToRow(rid, entry, extra);
  await upsertCall(db, row);
  await db.agentRun.update({ where: { runId: rid }, data: counters(state, clock) });

  const left = budgetRemaining(state, clock.now_ms, entry.tool);
  // 碰壁分类只在「真的没拿到读数」时给；缓存命中不算碰壁（它拿到了，只是复用同一行台账）。
  // budget / 已停止 这两类内核不产 failure，就照内核给的 reason 与 next_action=stop 呈现，不在服务层另编一套。
  const dead: DeadEnd | null = obs
    ? (obs.kind === "value" || obs.kind === "real_zero"
      ? null
      : classifyDeadEnd({ tool: entry.tool, kind: obs.kind, error: obs.reason ?? null, timed_out: !!obs.timed_out, budget_left: left }))
    : admission.allowed || admission.cached_from
      ? null
      : classifyDeadEnd({
        tool: entry.tool,
        params_invalid: admission.failure === "bad_params" ? admission.errors : null,
        not_supported: admission.failure === "not_supported" ? admission.reason : null,
        error: admission.reason, budget_left: left,
      });
  const finalNa = state.stop ? { action: "stop" as const, reason: state.stop.reason, detail: state.stop.detail } : na;

  return {
    ...base, ok: true, error: null, http: 200, admitted: admission.allowed,
    call: rowToLog(row),
    params_effective: params,
    observation: obs ? obsView(obs) : {
      ...NO_OBS, kind: row.kind || null, data_status: row.dataStatus || null, source: row.source || null,
      as_of: row.asOf || null, summary: row.summary, reason: row.error || null, notes: jarr(row.notesJson),
    },
    dead_end: dead,
    budget_left: left,
    evidence_lines: state.evidence.length,
    missing: state.missing,
    next_turn: finalNa,
    prompt: finalNa.action === "continue" ? { turn: buildAgentTurnPrompt(state, { now_ms: clock.now_ms, now: clock.now }) } : null,
    summary: summarizeRun(state, null, clock.now_ms),
    basis: admission.allowed
      ? `已执行 ${entry.tool} 并记账 1 条（观测=${s(obs?.kind)}／分层 ${s(obs?.data_status)}／出处 ${s(obs?.source)}／时刻 ${s(obs?.as_of) || "未记录"}）。这是服务端记录，模型自称调用过不算数。`
      : admission.cached_from
        ? `相同参数的 ${entry.tool} 本次运行已取过：复用台账 ${admission.cached_from}，没有打上游（§三十二）`
        : `本次没有执行 ${entry.tool || "（无工具名）"}：${admission.reason}（这一条照样写进日志，用于回答「刚才请求了什么、为什么没跑」）`,
  };
}

export interface AgentFinalizeResult {
  ok: boolean;
  error: string | null;
  http: AgentHttp;
  persisted: boolean;
  run_id: string;
  directive: { kind: AgentDirective["kind"]; thought: string } | null;
  check: AgentAnswerCheck | null;
  summary: Record<string, string | number | boolean | null>;
  missing: string[];
  basis: string;
}

/**
 * 收尾：把模型给出的 final 交给内核复校验（引用命中、无出处数字、历史≠当前、概率口径），
 * 判定结论与答案原文一起落库。本层不改写答案、不补结论：判 REJECTED 就照实留档 REJECTED。
 */
export async function finalizeAgentRun(input: { run_id: unknown; raw: unknown; model?: string }, db: AgentRunDb, clock: AgentClock): Promise<AgentFinalizeResult> {
  const rid = String(input.run_id ?? "").trim();
  const bad = (error: string, http: AgentHttp = 400, extra: Partial<AgentFinalizeResult> = {}): AgentFinalizeResult => ({
    ok: false, error, http, persisted: false, run_id: rid, directive: null, check: null, summary: {},
    missing: [error], basis: "本次没有落库：见 error", ...extra,
  });
  const err = runIdError(rid);
  if (err) return bad(err);
  const loaded = await loadAgentRun(rid, db);
  if (!loaded) return bad(`找不到 run_id「${rid}」：没有开过的运行无法收尾（不替你新建一条空运行凑答案）`, 404);

  const directive = parseAgentDirective(String(input.raw ?? ""));
  let state = loaded.state;
  let check: AgentAnswerCheck;

  if (directive.kind === "tool") {
    // 409 = 这次运行还没到能收尾的状态（模型要的是工具）：客户端照它继续走 /api/agent/tool，而不是当成参数错
    return bad(`这一步模型要的是工具「${directive.tool}」，不是结论：请走 /api/agent/tool 执行它，或用带 final 的回复收尾（本层不会把工具请求当成最终答案）`, 409, {
      directive: { kind: directive.kind, thought: directive.thought },
      summary: summarizeRun(state, null, clock.now_ms),
    });
  }

  if (directive.kind === "invalid") {
    const rec = recordCall(state, {
      // 协议外的回复没有工具名：tool 留空串，output_status=invalid_directive 就是它的身份（§十八 要能统计这类次数）
      tool: "", input: { raw_head: String(input.raw ?? "").slice(0, 200) }, call_key: "",
      output_status: "invalid_directive", error: directive.error, thought: "", timestamp: clock.now, latency_ms: null,
    });
    state = { ...rec.state, stop: { reason: "invalid_directive", detail: directive.error.slice(0, 200) } };
    await upsertCall(db, entryToRow(rid, rec.entry, { notes: ["协议外的回复：没有执行任何取数"] }));
    await db.agentRun.update({ where: { runId: rid }, data: counters(state, clock) });
    check = verifyAgentAnswer({ answer: "", cites: [], gaps: [], state });
  } else {
    state = { ...state, stop: { reason: "answered", detail: directive.thought ? `模型自报结束理由：${directive.thought}` : "模型给出 final（未附理由）" } };
    check = verifyAgentAnswer({ answer: directive.answer, cites: directive.cites, gaps: directive.gaps, state });
  }

  // 与 P6-C 同一条护栏：一次失败的回复不覆盖这次运行已经成立的结论
  if (check.status === "REJECTED" && (loaded.meta.answerStatus === "ACCEPTED" || loaded.meta.answerStatus === "PARTIAL")) {
    return bad(
      `本次收尾被判 REJECTED，而库里这次运行已有 ${loaded.meta.answerStatus} 的结论：保留已有那条，没有覆盖（页面会同时显示两边状态）`,
      409,
      {
        directive: { kind: directive.kind, thought: directive.kind === "final" ? directive.thought : "" },
        check, summary: summarizeRun(state, check, clock.now_ms),
        missing: [...state.missing, ...check.violations],
      },
    );
  }

  const data = {
    ...counters(state, clock),
    status: "finished",
    answerStatus: check.status,
    answerText: check.answer,
    answerCites: JSON.stringify([...check.cites_valid, ...check.cites_invalid]),
    answerGaps: JSON.stringify(check.gaps),
    violations: JSON.stringify(check.violations),
    lineageJson: JSON.stringify(check.lineage),
    finishedAt: clock.now,
    elapsedMs: Math.max(0, clock.now_ms - state.started_ms),
    model: s(input.model || loaded.meta.model).slice(0, 80),
  };
  await db.agentRun.update({ where: { runId: rid }, data });
  return {
    ok: check.status !== "REJECTED",
    error: check.status === "REJECTED" ? `结论不可回溯：${check.violations.join("；")}` : null,
    // REJECTED 已经落库（结论原文与违规项都在库里，页面要显示），但这次收尾没有产出可用结论 ⇒ 422，不是 500
    http: check.status === "REJECTED" ? 422 : 200,
    persisted: true, run_id: rid,
    directive: { kind: directive.kind, thought: directive.kind === "final" ? directive.thought : "" },
    check, summary: summarizeRun(state, check, clock.now_ms), missing: state.missing,
    basis:
      `服务端按库内 ${state.log.length} 条调用记录复校验：答案引用 ${check.cites_valid.length} 行台账，血缘逐条回到工具与出处。` +
      `判定=${check.status}，结论原文照存不改写。协议 ${AGENT_PROTOCOL_VERSION}；停止原因=${s(state.stop?.reason) || "未记录"}。`,
  };
}

// ---------- 回看（GET /api/agent/run）----------

export interface AgentRunListItem {
  run_id: string; question: string; status: string; answer_status: string; stop_reason: string;
  steps: number; tool_calls: number; evidence_lines: number; missing_lines: number;
  started_at: string; elapsed_ms: number;
}

/** 最近跑过哪些：按 startedAt 倒序，只给摘要列，明细要按 run_id 再查一次 */
export async function listAgentRuns(db: AgentRunDb, take = 20): Promise<AgentRunListItem[]> {
  const rows = await db.agentRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.max(1, Math.min(100, num(take) || 20)) });
  return rows.map((r) => {
    const row = r as unknown as AnyRow;
    const m = meta(row);
    return {
      run_id: m.runId, question: m.question, status: m.status, answer_status: m.answerStatus, stop_reason: m.stopReason,
      steps: m.steps, tool_calls: m.toolCalls, evidence_lines: m.evidenceLines, missing_lines: m.missingLines,
      started_at: m.startedAt, elapsed_ms: m.elapsedMs,
    };
  });
}

/**
 * 一次运行的完整回看：步骤时间线 + 血缘 + 预算余量 + 缺口 + 答案与违规项。
 * 这里的 answer/violations/lineage 读的是**落库时那份判定**，不是重新算一遍：
 * 重算要用当前的台账，而台账可能已被后续扫描刷新——那已经不是当时那个结论的出处了。
 * 三个必备键显式列进类型（其余字段保持宽对象）：路由要照 http 回状态码，不能靠 ok 猜。
 */
export type AgentViewResult = { ok: boolean; error: string | null; http: AgentHttp; run_id: string } & Record<string, unknown>;

export async function agentRunView(runId: string, db: AgentRunDb, clock: AgentClock): Promise<AgentViewResult> {
  const err = runIdError(runId);
  const rid = String(runId ?? "").trim();
  if (err) return { ok: false, error: err, http: 400, run_id: rid, missing: [err] };
  const loaded = await loadAgentRun(rid, db);
  if (!loaded) {
    return {
      ok: false, http: 404,
      error: `找不到 run_id「${rid}」：库里没有这次运行（这不等于「跑过但没结果」，后者会有行并带停止原因）`,
      run_id: rid, missing: [`run_id「${rid}」不存在`],
    };
  }
  const { meta: m, state, rows } = loaded;
  // 落库时那份判定原样读回（不重新 verify）；血缘行也读存储的那份，保证「当时的出处」不随后续扫描漂移。
  const lineage = jcol<AnyRow[]>(m.lineageJson, []).map((l) => ({
    evidence_id: s(l.evidence_id), tool: s(l.tool), executor: s(l.executor) || null, source: s(l.source),
    as_of: s(l.as_of), data_status: (s(l.data_status) || null) as DataStatus | null, data_status_raw: s(l.data_status_raw),
    step: num(l.step), call_key: s(l.call_key), refs: Array.isArray(l.refs) ? l.refs.map((x) => String(x)) : [],
  }));
  const cites = jarr(m.answerCites);
  const ledgerIds = state.evidence.map((e) => e.line.id);
  const unused = ledgerIds.filter((id) => !lineage.some((l) => l.evidence_id === id));
  return {
    ok: true, error: null, http: 200, run_id: rid,
    question: m.question, status: m.status, model: m.model,
    protocol: m.protocolVersion, prompt_version: m.promptVersion,
    budget: state.budget, budget_notes: jarr(m.budgetNotes), budget_left: budgetRemaining(state, clock.now_ms),
    timeline: rows.map(rowToLog),
    ledger: state.evidence.map((e) => ({ ...e.line, tool: e.tool, step: e.step, refs: e.refs })),
    evidence_snapshot: jcol<unknown[]>(m.evidenceJson, []),
    missing: state.missing,
    answer_status: m.answerStatus, answer_text: m.answerText,
    answer_cites: cites, answer_cites_missing: cites.filter((c) => !ledgerIds.includes(c)),
    answer_gaps: jarr(m.answerGaps), violations: jarr(m.violations),
    unused_evidence: unused,
    lineage,
    stop_reason: m.stopReason, stop_detail: m.stopDetail,
    // 自检：库里存的计数与「从调用行重建」的计数必须一致。不一致说明有一边在编数，页面要显示差异而不是信其中一个。
    rebuild_check: {
      stored: { steps: m.steps, tool_calls: m.toolCalls, evidence_lines: m.evidenceLines },
      rebuilt: { steps: state.step, tool_calls: state.tool_calls, evidence_lines: state.evidence.length },
      rows: rows.length, consistent: m.steps === state.step && m.toolCalls === state.tool_calls,
      unknown_layer_rows: loaded.skipped,
    },
    summary: { ...summarizeRun(state, null, clock.now_ms), answer_status: m.answerStatus || null },
    started_at: m.startedAt, finished_at: m.finishedAt, elapsed_ms: m.elapsedMs,
    basis: m.basis,
  };
}
