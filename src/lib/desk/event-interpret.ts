"use client";
// P6-B 客户端编排：把「服务端备好的真实事件 → 模型 → 服务端复校验落库」串成一次点击。
//
// 为什么模型调用只能在客户端：AI 凭据按设计只存在浏览器（localStorage → /api/ai/proxy 的请求头），
// Key 不落盘、不进 .env、不打日志，服务端 `.env` 里只有 model key（AMD 通道）。
// 所以本文件只做三件事：取提示词、调模型、把**原文**交给落库接口——
// 它不解析模型输出、不判断哪条解释可用，所有校验都在服务端做（见 event-interpret.ts 服务层）。
//
// P6-B 分批（2026-09-25）：AMD 免费档约 8~10s/条事件，一次性 20 条要 ~3 分钟且中途看不到进度。
// 改成客户端按 chunkSize（默认 6）分批调模型，逐批回传进度，最后把各批 JSON 数组在**字符串层面**
// 拼成一份交服务端复校验——客户端依旧不解释模型输出，只是把分批结果并起来。
//
// REAL_DATA_ONLY：AI 未配置时这里返回 AI_NOT_CONFIGURED 并带上原因，页面显示 DEGRADED；
// 绝不因为「想让用户看到东西」而本地编一段解释出来。
import { aiChat, aiReady } from "./ai";
import type { AiSettings } from "./types";
import { fetchInterpretPrompt, storeInterpretationsApi, type InterpretPromptClient, type InterpretStoreClient } from "./quant-api";
import { NOT_RUN_STATUSES, mergeRawArrays } from "@/lib/quant/screener/event-interpret-core";

// 分批结果合并的纯函数住内核（零依赖、可直跑单测）；这里 re-export 保持原有引用面不变。
export { mergeRawArrays };

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

/** 分批进度（客户端分批调模型时逐批回传，页面据此显示「第 x/y 批」） */
export interface InterpretProgress {
  done: number;       // 已跑完的批数
  total: number;      // 总批数
  eventsDone: number; // 已覆盖的事件数（按批上限估，不是「已成功条数」）
  eventsTotal: number;
  failed: number;     // 已失败的批数
}

/** 每批事件数：AMD 免费档约 8~10s/条，6 条一批 ≈ 1 分钟，出结果前能看见进度 */
export const DEFAULT_INTERPRET_CHUNK = 6;
/** 单批生成预算（20 条一次约 1.1 万字符；分批后单批仍需留足，默认 2048 会把 JSON 截断） */
export const INTERPRET_MAX_TOKENS = 8192;
/** 单批上游超时（经 aiChat → aiChatPlain 透传为请求体 timeout_ms；默认 45s / 120s 都不够） */
export const INTERPRET_TIMEOUT_MS = 300_000;

/**
 * @param ai 客户端设置里的 AI 配置（含 Key，只用于本次请求头）
 * @param opts.ids 只解释选中的事件（自然键或行 id）；不传 = 当日全部（服务端另有 limit 上限）
 * @param opts.chunkSize 每批事件数（默认 6）；1 = 逐条
 * @param opts.onProgress 每批跑完回调一次，页面用它显示进度
 */
export async function runEventInterpretation(
  ai: AiSettings,
  opts: { date?: string; ids?: string[]; limit?: number; chunkSize?: number; onProgress?: (p: InterpretProgress) => void; market?: "A" | "HK" | "US" | null } = {},
): Promise<RunResult> {
  const base: RunResult = {
    ok: false, status: NOT_RUN_STATUSES.ai_unconfigured, message: "", model: ai.model || "未配置",
    prompt_version: "", facts_count: 0, raw_chars: 0, store: null, missing: [],
  };
  if (!aiReady(ai)) {
    return {
      ...base,
      message: "尚未配置 AI 服务商（Base URL / 模型 / Key）：这一步只能由本机浏览器带着凭据去调模型，服务端没有 Key 也不会替你编解释。",
      missing: ["事件理解层本次未运行：模型未配置（AI 通道没接好）。事件事实仍然完整可读（全球事件留档行），缺的只是解释层"],
    };
  }

  // 1) 先取一次：拿到本批真实事件清单 + system + date（服务端组装，客户端不挑数据）
  // LLM 分流：market 随取提示词与调模型两处一起带——服务端按它在提示词里声明当前市场，
  // 解释时只按该市场归属解读事件（A 股事件不得说成美股/港股事件；本批无该市场相关事件时如实说明）。
  let head: InterpretPromptClient;
  try {
    head = await fetchInterpretPrompt({ date: opts.date, ids: opts.ids, limit: opts.limit, market: opts.market ?? undefined });
  } catch (e) {
    return { ...base, status: NOT_RUN_STATUSES.no_events, message: String((e as Error).message || e) };
  }
  if (!head.ok || !head.facts.length) {
    return {
      ...base, status: NOT_RUN_STATUSES.no_events, message: head.error || "服务端没有取到可理解的真实事件",
      prompt_version: head.prompt_version, missing: head.missing,
    };
  }

  const allIds = head.facts.map((f) => f.event_id);
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? DEFAULT_INTERPRET_CHUNK));
  const chunks: string[][] = [];
  for (let i = 0; i < allIds.length; i += chunkSize) chunks.push(allIds.slice(i, i + chunkSize));

  const raws: string[] = [];
  const batchErrors: string[] = [];
  let done = 0;
  let failed = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkIds = chunks[ci];
    try {
      // 单批时复用首次取回的提示词；多批时按该批 id 现取（提示词仍由服务端组装）。
      // 只有显式指定了日期（历史归档）才带 date；「今天」这条不带 → 服务端用「最近事件窗口」（跨日补足）。
      const p = chunks.length === 1 ? head : await fetchInterpretPrompt({ ...(opts.date ? { date: opts.date } : {}), ids: chunkIds, market: opts.market ?? undefined });
      if (!p.ok || !p.prompt) {
        failed++;
        batchErrors.push(`第 ${ci + 1}/${chunks.length} 批没有可理解的真实事件`);
      } else {
        const raw = await aiChat(ai, [
          { role: "system", content: p.system },
          { role: "user", content: p.prompt },
        ], { timeoutMs: INTERPRET_TIMEOUT_MS, maxTokens: INTERPRET_MAX_TOKENS, market: opts.market ?? null });
        if (raw.trim()) raws.push(raw);
        else { failed++; batchErrors.push(`第 ${ci + 1}/${chunks.length} 批模型返回空内容`); }
      }
    } catch (e) {
      failed++;
      batchErrors.push(`第 ${ci + 1}/${chunks.length} 批：${String((e as Error).message || e)}`);
    }
    done++;
    opts.onProgress?.({ done, total: chunks.length, eventsDone: Math.min(done * chunkSize, allIds.length), eventsTotal: allIds.length, failed });
  }

  if (!raws.length) {
    return {
      ...base, status: NOT_RUN_STATUSES.ai_failed, prompt_version: head.prompt_version,
      facts_count: head.facts.length,
      message: `模型调用失败（${chunks.length} 批全失败）：${batchErrors.join("；")}。本次未落库（不会把失败显示成「0 条解释」）。`,
      missing: [...head.missing, ...batchErrors],
    };
  }

  const merged = mergeRawArrays(raws);
  if (!merged || merged === "[]") {
    return {
      ...base, status: NOT_RUN_STATUSES.ai_failed, prompt_version: head.prompt_version,
      facts_count: head.facts.length,
      message: "各批模型回复里都没有可解析的 JSON 数组：无法校验，也就没有可落库的解释（服务端不会把空回复写成成功）。",
      missing: [...head.missing, ...batchErrors],
    };
  }

  const store = await storeInterpretationsApi({ raw: merged, model: ai.model, ...(opts.date ? { date: opts.date } : {}), ids: allIds });
  const status = (store.interpretation_status as RunStatus)
    ?? (store.persisted > 0 ? "PARTIAL" : NOT_RUN_STATUSES.ai_failed);
  const chunkNote = chunks.length > 1 ? `（分 ${chunks.length} 批${failed ? `，失败 ${failed} 批` : ""}）` : "";
  return {
    ok: store.ok,
    status,
    model: ai.model,
    prompt_version: store.items[0]?.prompt_version ?? head.prompt_version,
    facts_count: head.facts.length,
    raw_chars: merged.length,
    store,
    message: store.error
      ?? `服务端按 ${head.facts.length} 行真实事件复校验后落库 ${store.persisted} 条${chunkNote}（新增 ${store.inserted} / 覆盖 ${store.updated}）`,
    missing: [
      ...head.missing,
      ...batchErrors,
      ...store.missing.map((m) => `${m.event_id}｜${m.title}：${m.reason}`),
      ...store.unknown_ids.map((id) => `模型给出了库里不存在的事件标识 ${id}：整条拒收（AI 不得新增事件）`),
    ],
  };
}
