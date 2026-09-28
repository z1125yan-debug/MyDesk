// P7-⑥④ 自动调度的执行编排（纯内核：不 fetch、不 import 服务层，取数动作由调用方注入）。
//
// 为什么还要单独一层：planDispatch 只回答「该取什么」，而「怎么取、取到怎么说、取不到怎么留痕」
// 同样是不能留在路由里的判断——写在路由里就没法测，而这一段恰恰是最容易说谎的地方：
// 一个工具抛错就把整轮标成失败？取不到的项悄悄不进上下文？客户端断开了还照发 done？
// 这三条都在这里钉死，服务层（scene-dispatch.ts）只负责把 execute 换成真实工具。
//
// 数据纪律：
//  - 单个工具抛错只影响那一步（status=error），其余照常被模型使用；
//  - status=missing 的项必须进「本轮未取到」清单，让模型知道它没有这份数据，而不是凭印象补；
//  - 断开后没执行的调用记在 notRun 里，不谎称取过，也不谎称失败。
import type { DispatchCall } from "./intent-core.ts";
import type { StepInfo } from "./chat-core.ts";
import type { PhaseKey } from "./agent-phases-core.ts";
import { stepDetailOf, stepLabelFor } from "./chat-stream-core.ts";

/** 注入给模型的一段取数结果（ok=false 的不进正文，只进「未取到」清单） */
export interface DispatchRow {
  tool: string;
  ok: boolean;
  text: string;
}

/** 与工具调用环同形的执行记录：降级路径（非流式 JSON）要用同一套步骤口径 */
export interface DispatchTrace {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  status: "ok" | "error";
  summary: string;
}

export interface RunPlanResult {
  /** 完整步骤序列（running 与终态都在里面，界面按 step 号覆盖） */
  steps: StepInfo[];
  rows: DispatchRow[];
  /** 取了但没取到：工具名 + 原因，会写进注入块的「本轮未取到」 */
  missing: { tool: string; why: string }[];
  trace: DispatchTrace[];
  /** 断开后根本没执行的调用 */
  notRun: string[];
}

/** 单个工具结果进上下文的字数上限：与工具调用环同口径，一份数据撑爆整轮没有意义 */
export const DISPATCH_RESULT_MAX_CHARS = 4_000;

export interface RunPlanOpts {
  calls: DispatchCall[];
  /** 真正的取数动作（服务层给的是 chat-tools 的注册表实现）；抛错＝这一步失败 */
  execute: (call: DispatchCall) => Promise<unknown>;
  /**
   * R10 扩容：步骤标签的服务层覆写。chat-stream-core 的 TOOL_STEP_LABELS 在不动清单里，
   * 新工具（stock_news）的人话标签进不去，就在注入侧补——返回 null 仍走 stepLabelFor 兜底，
   * 旧工具一字不变。
   */
  labelFor?: (call: DispatchCall) => string | null;
  /**
   * P35 稳智对齐：步骤的真实 Agent Loop 阶段（服务层给的 chat-tools.phaseOfTool）。
   * 返回 null/不传 → 不带 phase_key，前端回落语义映射。纯核不 import 工具注册表，
   * 映射由调用方注入（与 labelFor 同一手法）。
   */
  phaseFor?: (call: DispatchCall) => PhaseKey | null;
  /** 逐步吐给前端的步骤事件（SSE 下接 emit，非流式下传同一个函数收集，两边判定一致） */
  onStep?: (step: StepInfo) => void;
  /** 步骤起始序号：预取占了前几号，模型自己的工具调用要接着编号，不能两边都从 1 开始 */
  stepStart?: number;
  isCancelled?: () => boolean;
  now?: () => number;
  resultMaxChars?: number;
}

/**
 * 执行一份取数计划。
 * 并发跑（和工具调用环一样，一轮问答不该串行等五个接口），但步骤号按计划顺序预先分配，
 * 所以界面上看到的先后与「为什么取它」的理由始终对得上，不会因为谁先返回而错位。
 */
export async function runDispatchPlan(opts: RunPlanOpts): Promise<RunPlanResult> {
  const { calls, execute } = opts;
  const now = opts.now ?? Date.now;
  const maxChars = Math.max(200, Math.trunc(opts.resultMaxChars ?? DISPATCH_RESULT_MAX_CHARS) || DISPATCH_RESULT_MAX_CHARS);
  const start = Math.max(0, Math.trunc(opts.stepStart ?? 0) || 0);
  const cancelled = opts.isCancelled ?? (() => false);
  const steps: StepInfo[] = [];
  const rows: DispatchRow[] = [];
  const missing: { tool: string; why: string }[] = [];
  const trace: DispatchTrace[] = [];
  const notRun: string[] = [];

  const todo: { call: DispatchCall; step: StepInfo }[] = [];
  (calls ?? []).forEach((call, i) => {
    const label = opts.labelFor?.(call) ?? stepLabelFor(call.tool, call.args);
    // P35：这一步真实归属的阶段（服务层注入）——没标就不带，前端回落语义映射，不臆造阶段
    const phaseKey = opts.phaseFor?.(call) ?? null;
    const step: StepInfo = { step: start + i + 1, label, status: "running", tool: call.tool, source: "prefetch", reason: call.reason, ...(phaseKey ? { phase_key: phaseKey } : {}) };
    todo.push({ call, step });
  });
  // 已经取消就别再取数：留痕是「没执行」，不是「失败」，更不是「取到了」
  const runnable = cancelled() ? [] : todo;
  if (cancelled()) todo.forEach(({ call }) => notRun.push(call.tool));
  runnable.forEach(({ step }) => {
    steps.push(step);
    opts.onStep?.(step);
  });

  const results = await Promise.all(runnable.map(async ({ call, step }) => {
    const started = now();
    let out: unknown;
    let errored: string | null = null;
    try {
      out = await execute(call);
    } catch (e) {
      errored = (e as Error).message || "工具执行异常";
    }
    const ms = Math.max(0, now() - started);
    const text = serialize(out);
    const judged = stepDetailOf(text);
    const status: StepInfo["status"] = errored ? "error" : judged.status;
    const done: StepInfo = {
      ...step,
      status,
      ms,
      // 抛错与「接口正常返回但没给值」是两件事：前者写「调用失败」，后者写工具自己给的缺失原因
      detail: errored ? `调用失败：${errored}` : judged.detail,
    };
    // 注入块 / 未取到清单 / trace 都按计划顺序落（下面统一装配），不能按谁先返回排：
    // 用户看时间线、模型看数据块，两处顺序错位就会以为取的是不同的东西。
    const row: DispatchRow = errored || status === "missing"
      ? { tool: call.tool, ok: false, text: "" }
      : { tool: call.tool, ok: true, text: text.length > maxChars ? `${text.slice(0, maxChars)}…（已截断，共 ${text.length} 字）` : text };
    const gap = errored
      ? { tool: call.tool, why: `调用失败：${errored}` }
      : status === "missing" ? { tool: call.tool, why: judged.detail || "接口未返回该数据" } : null;
    const item: DispatchTrace = {
      name: call.tool,
      args: call.args,
      ms,
      status: errored ? "error" : "ok",
      summary: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    };
    return { done, row, gap, item };
  }));

  // 按计划顺序落终态（Promise.all 谁先回来不固定，步骤序列不能跟着网络节奏走）
  results.forEach(({ done, row, gap, item }) => {
    const i = steps.findIndex((s) => s.step === done.step);
    if (i === -1) steps.push(done);
    else steps[i] = done;
    opts.onStep?.(done);
    rows.push(row);
    if (gap) missing.push(gap);
    trace.push(item);
  });

  return { steps, rows, missing, trace, notRun };
}

/** 结果序列化成注入给模型的文本；序列化不了的（循环引用等代码问题）按无数据处理，不谎称取到 */
function serialize(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return JSON.stringify({ missing: "工具返回值无法序列化为 JSON（代码问题），本轮该块无数据" });
  }
}
