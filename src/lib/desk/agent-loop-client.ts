"use client";
// P6-D 客户端循环驱动器：把「开一次运行 → 问模型 → 执行模型要的那一步 → 喂回观测 → 收尾」串起来。
//
// 为什么这一步在客户端：AI 凭据按设计只存在浏览器（localStorage → /api/ai/proxy 的请求头），
// 服务端 .env 里只有 DATABASE_URL，所以服务端拿不到 Key，也就没法自己调模型（见 src/lib/desk/ai.ts）。
// 因此本文件只是一个「逐格搬运工」：它不实现预算、不判断该不该停、不校验结论——
// 那些判据全在 agent-loop-core.ts（服务端用同一份），本文件只做三件事：
//   1) 把服务端给的 prompt.turn 原样交给模型；
//   2) 把模型原文（一字不改）交给 /api/agent/tool 或 /api/agent/finalize；
//   3) 按服务端给的 next_turn.action 与 HTTP 状态码决定继续还是停。
//
// 本地解析（parseAgentDirective）只用于「这一步该 POST 哪个接口」这个路由决定。
// 判定与记账一律以服务端重新解析的结果为准：模型（或本页）自称调用过什么不算数，只有 agent_tool_call 里的行算数（§十八/§十九）。
//
// REAL_DATA_ONLY：
// - AI 未配置 ⇒ AI_NOT_CONFIGURED：不会本地编一轮「看起来跑过了」的时间线；
// - 模型失败 ⇒ AI_FAILED：已经记账的步不会消失（库里那几行是真的），只是这次没走到收尾；
// - 本机停止/保险触发 ⇒ ABORTED / CLIENT_GUARD：如实说是客户端这边的原因，与内核的 8 种停止原因是两套东西；
// - 没走到 finalize 的运行在库里仍是 running——页面照实显示 running，不写成「已完成」。
import { aiChat, aiReady } from "./ai";
import type { AiSettings } from "./types";
import {
  agentFinalizeApi, agentRunApi, agentToolApi, type AgentApi,
  type AgentBudgetClient, type AgentBudgetLeftClient, type AgentCallRowClient,
  type AgentDeadEndClient, type AgentFinalizeResultClient, type AgentNextTurnClient,
  type AgentObservationClient, type AgentStartResultClient, type AgentStepResultClient,
} from "./quant-api";
import {
  BUDGET_HARD_CAPS, buildAgentFinalTurnText, parseAgentDirective,
} from "@/lib/quant/screener/agent-loop-core";

/** 本页这一轮跑成什么样（与内核的 AgentStopReason 两套：那是「为什么不再调工具」，这是「这次客户端驱动的循环走到哪一步」） */
export const AGENT_LOOP_STATUSES = [
  "DONE", "UNFINISHED", "RUN_CLOSED", "RUN_NOT_STARTED",
  "AI_NOT_CONFIGURED", "AI_FAILED", "CLIENT_GUARD", "ABORTED", "REQUEST_FAILED",
] as const;
export type AgentLoopStatus = (typeof AGENT_LOOP_STATUSES)[number];

export const AGENT_LOOP_STATUS_TEXT: Record<AgentLoopStatus, string> = {
  DONE: "循环走到收尾并已提交服务端复校验（结论可不可用看 answer_status：REJECTED 也是「跑过了但结论不可回溯」）",
  UNFINISHED: "循环停了但没有成立结论：这次运行在库里仍是 running，可带同一 run_id 续跑或收尾（本页不替模型编一个结论来收尾）",
  RUN_CLOSED: "服务端说这次运行已经收尾（409）：不再接受新的工具调用，也不让后一次回复覆盖已成立的结论；回看仍然完整",
  RUN_NOT_STARTED: "没有开成这次运行（run_id 或问题没过参数校验）：库里不会有它的任何行",
  AI_NOT_CONFIGURED: "AI 未配置：本机没有可用的模型凭据，这一步只能由浏览器带着 Key 去调模型，服务端不会替模型选工具",
  AI_FAILED: "模型调用失败或返回空内容：这一步没走到服务端，库里不会有凭空多出的调用行",
  CLIENT_GUARD: "本机保险触发：客户端自己停住了（不是服务端的预算停止原因），已记账的调用行留在库里",
  ABORTED: "本机点了停止：从这里起没有再问模型（已记账的调用行留在库里，运行状态仍是 running，可续跑）",
  REQUEST_FAILED: "接口没有返回 JSON（网关/错误页）：本页不猜它算不算成功，也不把错误页当成「跑过了」",
};

/** 客户端保险：内核硬上限的步数再多加 3（收尾那一轮 + 两次容错），超过就自己停住——不指望模型自觉 */
export const CLIENT_TURN_GUARD = BUDGET_HARD_CAPS.max_steps + 3;

/** 一轮：喂出去什么、模型回了什么原文、本地按哪个接口路由、服务端回的是什么 */
export interface AgentLoopTurn {
  index: number;
  /** 本轮发给模型的用户消息原文（服务端 prompt.turn，或 §十七 受控停止后的收尾轮） */
  prompt: string;
  prompt_from: "start" | "step" | "final_turn";
  /** 模型回复原文，一字未改（收尾判定由服务端重算，本页面只负责把原文交上去） */
  raw: string;
  /** 本页 parseAgentDirective 的结果：只决定 POST 哪个接口；history = 从库里读回来的行，本页没驱动它 */
  local_kind: "tool" | "final" | "invalid" | "history";
  local_tool: string;
  local_note: string;
  /** 这一步服务端的 HTTP：200=照常记账；409=已收尾/不被覆盖；422=判 REJECTED 但已落库；404=没有这个 run */
  http: number | null;
  call: AgentCallRowClient | null;
  observation: AgentObservationClient | null;
  dead_end: AgentDeadEndClient | null;
  budget_left: AgentBudgetLeftClient | null;
  next_turn: AgentNextTurnClient | null;
  params_effective: Record<string, unknown> | null;
  basis: string;
  error: string | null;
}

export interface AgentLoopResult {
  ok: boolean;
  status: AgentLoopStatus;
  message: string;
  run_id: string;
  model: string;
  question: string;
  turns: AgentLoopTurn[];
  start: AgentStartResultClient | null;
  finalize: AgentFinalizeResultClient | null;
  /** 内核给的停止原因（8 项之一）；未到停止条件时是 null */
  stop_reason: string | null;
  stop_detail: string;
  missing: string[];
  /** 只属于本机这一层的事实（保险、停止按钮、凭据缺失） */
  notes: string[];
}

export interface AgentLoopOptions {
  run_id: string;
  question: string;
  budget?: Partial<AgentBudgetClient>;
  /** 每完成一轮回调一次：页面据此逐格显示，不等整轮跑完才出结果 */
  onTurn?: (turn: AgentLoopTurn, done: number) => void;
  /** 本机「停止」按钮：每轮开问前检查一次 */
  shouldStop?: () => boolean;
}

function empty(over: Partial<AgentLoopResult>): AgentLoopResult {
  return {
    ok: false, status: "REQUEST_FAILED", message: "", run_id: "", model: "未配置", question: "",
    turns: [], start: null, finalize: null, stop_reason: null, stop_detail: "", missing: [], notes: [], ...over,
  };
}

/**
 * 跑一次自主研究循环。
 *
 * 停止条件（不看模型心情）：
 * - 服务端 next_turn.action === "stop" ⇒ 先给它一轮「只能收尾」的机会（§十七 受控停止要把未验证部分写进缺口）；
 * - 任意一步 HTTP 409 ⇒ RUN_CLOSED（已收尾 / 不允许覆盖已成立结论）；
 * - 模型回复里有 final ⇒ 收尾，循环结束；回复在协议外 ⇒ 也交给 finalize，由服务端记 invalid_directive 并停止；
 * - 轮到第 CLIENT_TURN_GUARD 格还没结束 ⇒ CLIENT_GUARD（本机保险）。
 */
export async function runAgentLoop(ai: AiSettings, opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const base = empty({ run_id: opts.run_id, model: ai.model || "未配置", question: opts.question });
  if (!aiReady(ai)) {
    return {
      ...base, status: "AI_NOT_CONFIGURED",
      message: "尚未配置 AI 服务商（Base URL / 模型 / Key）：工具选择这一步只能由本机浏览器带着凭据去问模型，服务端没有 Key，也不会替你跑一轮假的。",
      notes: ["AI_NOT_CONFIGURED：本轮没有产生任何工具调用，库里不会多出行"],
      missing: ["解释层与循环控制层本次未运行：AI_NOT_CONFIGURED（读数层照常可查）"],
    };
  }

  let start: AgentApi<AgentStartResultClient>;
  try {
    start = await agentRunApi({ run_id: opts.run_id, question: opts.question, budget: opts.budget, model: ai.model });
  } catch (e) {
    return { ...base, status: "REQUEST_FAILED", message: String((e as Error).message || e) };
  }
  const turns: AgentLoopTurn[] = [];
  if (!start.ok || start.__status !== 200) {
    return {
      ...base, status: "RUN_NOT_STARTED", start,
      message: start.error || "服务端没有开出这次运行",
      missing: start.missing, notes: [start.basis].filter(Boolean),
    };
  }
  if (start.status === "finished") {
    return {
      ...base, status: "RUN_CLOSED", start,
      message: `run_id「${start.run_id}」在库里已经是收尾状态（${start.summary?.answer_status ?? "未记录"}）：这次没有再问模型，也不接受新的工具调用。要看步骤与血缘，直接用左边的回看列表。`,
      stop_reason: typeof start.summary?.stop_reason === "string" ? start.summary.stop_reason : null,
      notes: [start.basis],
    };
  }

  // messages 只是浏览器这一轮的会话壳：每一轮的 prompt.turn 由服务端按库里的行重编（含完整 log 与台账），
  // 所以刷新页面/换一次驱动都能续上，不靠本页内存里的历史。
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: start.prompt.system },
  ];
  let nextTurn = start.prompt.turn;
  let promptFrom: AgentLoopTurn["prompt_from"] = "start";
  let stop: AgentNextTurnClient = start.next_turn;
  const missing = [...start.missing];
  const notes = [start.basis].filter(Boolean);
  if (start.resumed) notes.push(`续开：库里已有 ${start.summary?.tool_calls ?? 0} 次调用记录，本次接着跑（没有清空、没有重打上游）`);

  let finalize: AgentApi<AgentFinalizeResultClient> | null = null;
  let askedFinalTurn = false;

  for (let index = 1; index <= CLIENT_TURN_GUARD; index += 1) {
    if (opts.shouldStop?.()) {
      return {
        ...base, status: "ABORTED", start, turns, finalize, missing, notes,
        message: `本机在第 ${index} 格按了停止：从这里起没有再问模型。库里已记账的 ${turns.filter((t) => t.call).length} 步保留（这次运行状态仍是 running，可带同一 run_id 续跑）。`,
        stop_reason: stop.action === "stop" ? stop.reason : null, stop_detail: stop.detail,
      };
    }

    let raw: string;
    try {
      raw = await aiChat(ai, [...messages, { role: "user", content: nextTurn }], { timeoutMs: 120_000 });
    } catch (e) {
      return {
        ...base, status: "AI_FAILED", start, turns, missing, notes,
        message: `模型调用失败（第 ${index} 格）：${String((e as Error).message || e)}。这一步没有走到服务端，所以库里不会多出行；前面已记账的 ${turns.filter((t) => t.call).length} 步是真的，可稍后续跑或收尾。`,
        stop_reason: stop.action === "stop" ? stop.reason : null, stop_detail: stop.detail,
      };
    }
    if (!raw.trim()) {
      return {
        ...base, status: "AI_FAILED", start, turns, missing, notes,
        message: `模型第 ${index} 格返回空内容：没有原文就没有可校验的结论（本页不会把空回复当成「这一步跑完了」）。已记账的 ${turns.filter((t) => t.call).length} 步留在库里，运行状态仍是 running。`,
      };
    }
    messages.push({ role: "user", content: nextTurn }, { role: "assistant", content: raw });

    const d = parseAgentDirective(raw);
    const collect = (t: AgentLoopTurn) => { t.index = index; t.prompt = nextTurn; t.prompt_from = promptFrom; turns.push(t); opts.onTurn?.(t, index); };
    const turnHead: AgentLoopTurn = {
      index, prompt: nextTurn, prompt_from: promptFrom, raw,
      local_kind: d.kind,
      local_tool: d.kind === "tool" ? d.tool : "",
      local_note: d.kind === "tool" ? `本页解析：请求工具「${d.tool}」→ POST /api/agent/tool（服务端会自己再解析一次原文）`
        : d.kind === "final" ? "本页解析：final 结论 → POST /api/agent/finalize（判定权在服务端）"
          : `本页解析失败：${d.error} → 原文交给 /api/agent/finalize，由服务端记 invalid_directive`,
      http: null, call: null, observation: null, dead_end: null, budget_left: null, next_turn: null,
      params_effective: null, basis: "", error: null,
    };

    if (d.kind === "tool") {
      let step: AgentApi<AgentStepResultClient>;
      try {
        step = await agentToolApi({
          run_id: opts.run_id, tool: d.tool,
          args: (d.args ?? {}) as Record<string, unknown>, thought: d.thought,
        });
      } catch (e) {
        turnHead.error = String((e as Error).message || e);
        collect(turnHead);
        return { ...base, status: "REQUEST_FAILED", start, turns, missing, notes, message: turnHead.error };
      }
      turnHead.http = step.__status;
      turnHead.call = step.call ?? null;
      turnHead.observation = step.observation ?? null;
      turnHead.dead_end = step.dead_end ?? null;
      turnHead.budget_left = step.budget_left ?? null;
      turnHead.next_turn = step.next_turn ?? null;
      turnHead.params_effective = step.params_effective ?? null;
      turnHead.basis = step.basis;
      turnHead.error = step.error;
      collect(turnHead);
      missing.push(...(step.missing ?? []).filter((m) => !missing.includes(m)));

      if (step.__status === 404) {
        return { ...base, status: "RUN_NOT_STARTED", start, turns, missing, notes, message: step.error ?? "服务端找不到这次运行", stop_detail: step.basis };
      }
      if (step.__status === 409) {
        return { ...base, status: "RUN_CLOSED", start, turns, missing, notes, message: step.error ?? "这次运行已收尾", stop_detail: step.basis };
      }
      stop = step.next_turn ?? stop;
      if (stop.action === "stop") {
        // §十七：撞预算/停摆是「受控停止」，不是就地散场——给它一轮只出结论的机会。
        if (askedFinalTurn) {
          return {
            ...base, status: "UNFINISHED", start, turns, missing, notes,
            stop_reason: stop.reason ?? null, stop_detail: stop.detail,
            message: `已停止接受工具调用（${stop.reason ?? "未记录"}），但收尾那一轮模型仍在要工具：这次运行没有成立结论，库里状态仍是 running。`,
          };
        }
        askedFinalTurn = true;
        nextTurn = buildAgentFinalTurnText(stop.detail, step.budget_left ?? { steps: 0, tool_calls: 0, ms: 0, retries_left: 0, evidence_lines: 0 });
        promptFrom = "final_turn";
        notes.push(`第 ${index} 格后内核判定停止（${stop.reason}）：已按 §十七 再问一轮「只给结论」`);
        continue;
      }
      if (!step.prompt?.turn) {
        // 服务端说继续却没给提示词：本层不自己编一份（那会变成第二套协议），如实停下。
        return {
          ...base, status: "UNFINISHED", start, turns, missing, notes,
          message: `内核要求继续，但服务端没有返回下一轮提示词：本页不自己拼提示词（那等于另起一套协议）。库里已记账的步不受影响。`,
        };
      }
      nextTurn = step.prompt.turn;
      promptFrom = "step";
      continue;
    }

    // final 与协议外回复都走收尾：判定权全在服务端（invalid 会被记 invalid_directive 并停止）
    let res: AgentApi<AgentFinalizeResultClient>;
    try {
      res = await agentFinalizeApi({ run_id: opts.run_id, raw, model: ai.model });
    } catch (e) {
      turnHead.error = String((e as Error).message || e);
      collect(turnHead);
      return { ...base, status: "REQUEST_FAILED", start, turns, missing, notes, message: turnHead.error };
    }
    turnHead.http = res.__status;
    turnHead.basis = res.basis;
    turnHead.error = res.error;
    if (d.kind === "invalid") {
      turnHead.local_note += "（协议外的回复：服务端会记一条 output_status=invalid_directive 的调用行并停止，本轮不再问模型）";
    }
    collect(turnHead);
    finalize = res;
    if (finalize.__status === 409) {
      return {
        ...base, status: "RUN_CLOSED", start, turns, finalize, missing, notes,
        message: finalize.error || "服务端没有接受这次收尾", stop_detail: finalize.basis,
      };
    }
    if (!finalize.persisted) {
      return {
        ...base, status: "UNFINISHED", start, turns, finalize, missing, notes,
        message: finalize.error || "本次收尾没有落库：见 error", stop_detail: finalize.basis,
      };
    }
    return {
      ...base, status: "DONE", ok: finalize.ok, start, turns, finalize,
      question: start.question,
      message: finalize.error ?? finalize.basis,
      stop_reason: finalize.summary?.stop_reason ? String(finalize.summary.stop_reason) : "answered",
      stop_detail: String(finalize.summary?.stop_detail ?? ""),
      missing: [...missing, ...(finalize.missing ?? []).filter((m) => !missing.includes(m))],
    };
  }

  return {
    ...base, status: "CLIENT_GUARD", start, turns, finalize, missing, notes,
    message: `本机保险在第 ${CLIENT_TURN_GUARD} 格触发：循环没有正常结束。这是客户端自己的停法，不是内核的停止原因（内核那 8 项见运行详情）。库里已记账的 ${turns.filter((t) => t.call).length} 步保留，运行状态仍是 running，可续跑。`,
    stop_reason: stop.action === "stop" ? stop.reason : null, stop_detail: stop.detail,
  };
}
