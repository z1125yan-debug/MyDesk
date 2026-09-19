"use client";
// P6-C 客户端编排：一次点击串起「服务端备台账 → 本机凭据调模型 → 服务端复校验落库」。
//
// 为什么模型调用只能发生在客户端：AI 凭据按设计只存在浏览器（localStorage → /api/ai/proxy 的请求头），
// Key 不落盘、不进 .env、不打日志，服务端 `.env` 里只有 DATABASE_URL。
// 所以本文件只做三件事：取提示词、调模型、把**原文**交给落库接口——
// 它不解析模型输出、不判断哪条解释站得住，所有复校验都在服务端做（见 screener/research.ts 的 storeResearchReport）。
//
// REAL_DATA_ONLY：
// - AI 未配置 ⇒ AI_NOT_CONFIGURED，页面显示 DEGRADED，绝不本地编一份「市场环境报告」；
// - 服务端台账为空 ⇒ NO_EVIDENCE，不去猜读数，也不向模型提问；
// - 模型失败/回复为空 ⇒ AI_FAILED，不写库、不把失败显示成「0 条结论所以一切正常」。
import { aiChat, aiConfigured } from "./ai";
import type { AiSettings } from "./types";
import { fetchResearchPrompt, storeResearchApi, type ResearchPromptClient, type ResearchStoreClient } from "./quant-api";
import { RESEARCH_NOT_RUN_STATUSES } from "@/lib/quant/screener/research-core";

/** INTERPRETED/PARTIAL/REJECTED 来自服务端落库结果，其余三种是「这次没跑成」 */
export type ResearchRunStatus = "INTERPRETED" | "PARTIAL" | "REJECTED" |
  (typeof RESEARCH_NOT_RUN_STATUSES)[keyof typeof RESEARCH_NOT_RUN_STATUSES];

export const RESEARCH_RUN_STATUS_TEXT: Record<ResearchRunStatus, string> = {
  INTERPRETED: "已完成解释：每条判断都能指到台账行（属于 AI_INTERPRETATION，不是市场事实）",
  PARTIAL: "部分完成：有引用缺失、无出处数字或越界表述被剔除/降级，引用时必须带上这条限制",
  REJECTED: "不可用：模型没有给出任何可核对的解释，本层不产出默认结论",
  AI_NOT_CONFIGURED: "AI 未配置：本机没有可用的模型凭据，本次没有产生任何解释（服务端不会替模型编一份报告）",
  AI_FAILED: "AI 调用失败或回复无法解析：未落库，也不会用假数据填空",
  NO_EVIDENCE: "服务端没有取到真实读数：没有台账就没有可解释的东西，本次不产出市场环境报告",
};

export interface ResearchRunResult {
  ok: boolean;
  status: ResearchRunStatus;
  message: string;
  model: string;
  prompt_version: string;
  evidence_total: number;
  raw_chars: number;
  /** 服务端备好的这一次台账与采集器观测（页面 Tool Calls 侧栏显示的就是它，不是模型的工具调用） */
  prompt: ResearchPromptClient | null;
  store: ResearchStoreClient | null;
  missing: string[];
}

/**
 * @param ai 客户端设置里的 AI 配置（含 Key，只用于本次请求头）
 * @param opts.question 研究问题；留空则由服务端按默认问题组装，并如实记进 missing
 */
export async function runMarketResearch(
  ai: AiSettings,
  opts: { question?: string } = {},
): Promise<ResearchRunResult> {
  const base: ResearchRunResult = {
    ok: false, status: RESEARCH_NOT_RUN_STATUSES.ai_unconfigured, message: "", model: ai.model || "未配置",
    prompt_version: "", evidence_total: 0, raw_chars: 0, prompt: null, store: null, missing: [],
  };
  if (!aiConfigured(ai)) {
    return {
      ...base,
      message: "尚未配置 AI 服务商（Base URL / 模型 / Key）：这一步只能由本机浏览器带着凭据去调模型，服务端没有 Key，也不会替你编一份市场环境报告。",
      missing: ["研究解释层本次未运行：AI_NOT_CONFIGURED。服务端读数本身照常可查（风险/主线/板块/雷达/事件都是真的），缺的只是解释层"],
    };
  }

  let prompt: ResearchPromptClient;
  try {
    prompt = await fetchResearchPrompt({ question: opts.question });
  } catch (e) {
    // 台账为空的 422/ok=false 也走这里：把服务端给的原因原话留给页面，不换成「网络错误」
    return { ...base, status: RESEARCH_NOT_RUN_STATUSES.no_evidence, message: String((e as Error).message || e) };
  }
  if (!prompt.ok || !prompt.prompt) {
    return {
      ...base, status: RESEARCH_NOT_RUN_STATUSES.no_evidence, prompt,
      message: prompt.error || "服务端没有取到可解释的真实读数",
      prompt_version: prompt.prompt_version, evidence_total: prompt.lines.length,
      missing: prompt.missing,
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
      ...base, status: RESEARCH_NOT_RUN_STATUSES.ai_failed, prompt,
      prompt_version: prompt.prompt_version, evidence_total: prompt.lines.length,
      message: `模型调用失败：${String((e as Error).message || e)}。本次未落库（不会把失败显示成「0 条解释」）。`,
      missing: prompt.missing,
    };
  }
  if (!raw.trim()) {
    return {
      ...base, status: RESEARCH_NOT_RUN_STATUSES.ai_failed, prompt,
      prompt_version: prompt.prompt_version, evidence_total: prompt.lines.length,
      message: "模型返回空内容：没有可校验的原文，也就没有可落库的报告（服务端不会把空回复写成成功）。",
      missing: prompt.missing,
    };
  }

  const store = await storeResearchApi({ raw, question: prompt.question, model: ai.model, scope: prompt.scope });
  const status = (store.report?.interpretation_status as ResearchRunStatus)
    ?? (store.report_status as ResearchRunStatus)
    ?? RESEARCH_NOT_RUN_STATUSES.ai_failed;
  return {
    ok: store.ok,
    status,
    model: ai.model,
    prompt_version: store.report?.prompt_version ?? prompt.prompt_version,
    evidence_total: store.evidence_total,
    raw_chars: raw.length,
    prompt,
    store,
    message: store.error ?? `服务端按现取的 ${store.evidence_total} 行台账复校验${store.persisted ? "后落库 1 条" : "后未落库"}`,
    missing: [...(prompt.missing ?? []), ...(store.missing ?? []).filter((m) => !(prompt.missing ?? []).includes(m))],
  };
}
