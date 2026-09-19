"use client";
// P6-B 客户端编排：把「服务端备好的真实事件 → 模型 → 服务端复校验落库」串成一次点击。
//
// 为什么模型调用只能在客户端：AI 凭据按设计只存在浏览器（localStorage → /api/ai/proxy 的请求头），
// Key 不落盘、不进 .env、不打日志，服务端 `.env` 里只有 DATABASE_URL。
// 所以本文件只做三件事：取提示词、调模型、把**原文**交给落库接口——
// 它不解析模型输出、不判断哪条解释可用，所有校验都在服务端做（见 event-interpret.ts 服务层）。
//
// REAL_DATA_ONLY：AI 未配置时这里返回 AI_NOT_CONFIGURED 并带上原因，页面显示 DEGRADED；
// 绝不因为「想让用户看到东西」而本地编一段解释出来。
import { aiChat, aiConfigured } from "./ai";
import type { AiSettings } from "./types";
import { fetchInterpretPrompt, storeInterpretationsApi, type InterpretStoreClient } from "./quant-api";
import { NOT_RUN_STATUSES } from "@/lib/quant/screener/event-interpret-core";

/** 一次点击的整体状态：INTERPRETED/PARTIAL/REJECTED 来自服务端落库结果，其余三种是「这次没做成」 */
export type RunStatus = "INTERPRETED" | "PARTIAL" | "REJECTED" |
  (typeof NOT_RUN_STATUSES)[keyof typeof NOT_RUN_STATUSES];

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  INTERPRETED: "已完成：服务端按库内事实复校验后落库",
  PARTIAL: "部分完成：有解释被降级或剔除，详见每条的校验留痕",
  REJECTED: "被拒收：模型给的内容没有通过事实核对，未采信",
  AI_NOT_CONFIGURED: "AI 未配置：本机没有可用的模型凭据，本次没有产生任何解释",
  AI_FAILED: "AI 调用失败或回复无法解析：未落库，也不会用假数据填空",
  NO_EVENTS: "没有真实事件可理解：当日库里没有事件行，本层不会去猜一条新闻",
};

export interface RunResult {
  ok: boolean;
  status: RunStatus;
  message: string;
  model: string;
  prompt_version: string;
  facts_count: number;
  raw_chars: number;
  store: InterpretStoreClient | null;
  /** 缺失口径（提示词侧的「为什么没有原料」+ 落库侧的「哪些事件没被解释」合并，页面原样显示） */
  missing: string[];
}

/**
 * @param ai 客户端设置里的 AI 配置（含 Key，只用于本次请求头）
 * @param opts.ids 只解释选中的事件（自然键或行 id）；不传 = 当日全部（服务端另有 limit 上限）
 */
export async function runEventInterpretation(
  ai: AiSettings,
  opts: { date?: string; ids?: string[]; limit?: number } = {},
): Promise<RunResult> {
  const base: RunResult = {
    ok: false, status: NOT_RUN_STATUSES.ai_unconfigured, message: "", model: ai.model || "未配置",
    prompt_version: "", facts_count: 0, raw_chars: 0, store: null, missing: [],
  };
  if (!aiConfigured(ai)) {
    return {
      ...base,
      message: "尚未配置 AI 服务商（Base URL / 模型 / Key）：这一步只能由本机浏览器带着凭据去调模型，服务端没有 Key 也不会替你编解释。",
      missing: ["事件理解层本次未运行：AI_NOT_CONFIGURED。事件事实仍然完整可读（global_event 库行），缺的只是解释层"],
    };
  }

  let prompt;
  try {
    prompt = await fetchInterpretPrompt(opts);
  } catch (e) {
    return { ...base, status: NOT_RUN_STATUSES.no_events, message: String((e as Error).message || e) };
  }
  if (!prompt.ok || !prompt.prompt) {
    return {
      ...base, status: NOT_RUN_STATUSES.no_events, message: prompt.error || "服务端没有取到可理解的真实事件",
      prompt_version: prompt.prompt_version, missing: prompt.missing,
    };
  }

  let raw = "";
  try {
    raw = await aiChat(ai, [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.prompt },
    ], { timeoutMs: 120000 });
  } catch (e) {
    return {
      ...base, status: NOT_RUN_STATUSES.ai_failed, prompt_version: prompt.prompt_version,
      facts_count: prompt.facts.length,
      message: `模型调用失败：${String((e as Error).message || e)}。本次未落库（不会把失败显示成「0 条解释」）。`,
      missing: prompt.missing,
    };
  }
  if (!raw.trim()) {
    return {
      ...base, status: NOT_RUN_STATUSES.ai_failed, prompt_version: prompt.prompt_version,
      facts_count: prompt.facts.length,
      message: "模型返回空内容：无法校验，也就没有可落库的解释（服务端不会把空回复写成成功）。",
      missing: prompt.missing,
    };
  }

  const store = await storeInterpretationsApi({ raw, model: ai.model, date: prompt.date, ids: opts.ids });
  const status = (store.interpretation_status as RunStatus)
    ?? (store.persisted > 0 ? "PARTIAL" : NOT_RUN_STATUSES.ai_failed);
  return {
    ok: store.ok,
    status,
    model: ai.model,
    prompt_version: store.items[0]?.prompt_version ?? prompt.prompt_version,
    facts_count: prompt.facts.length,
    raw_chars: raw.length,
    store,
    message: store.error
      ?? `服务端按 ${prompt.facts.length} 行真实事件复校验后落库 ${store.persisted} 条（新增 ${store.inserted} / 覆盖 ${store.updated}）`,
    missing: [
      ...prompt.missing,
      ...store.missing.map((m) => `${m.event_id}｜${m.title}：${m.reason}`),
      ...store.unknown_ids.map((id) => `模型给出了库里不存在的事件标识 ${id}：整条拒收（AI 不得新增事件）`),
    ],
  };
}
