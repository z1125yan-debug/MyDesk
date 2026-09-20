"use client";
// P7-⑤① 的浏览器侧流式客户端：POST + fetch 流读取（EventSource 只能 GET，带不上密钥头，所以不用它）。
//
// 凭据口径不变：Key 只出现在这一次请求头里，服务端转发给所选服务商，不写库、不打印、不进事件流。
// 降级口径：拿不到 event-stream（Anthropic/Gemini 原生、或上游/路由整体返回 JSON）时，
// 结果仍然是真的，只是没有逐字节奏 —— 这里如实返回 usedStream:false，由界面改成本机节奏并写明原因。
import type { AiSettings } from "./types";
import type { StepInfo } from "./chat-core";
import { asStreamIntent, chatRequestBody, decodeStreamEvent, isEventStream, type StreamEvent, type StreamStep } from "./chat-stream-core";

export const CHAT_ENDPOINTS = {
  /** AI 交易员：带真实数据工具调用，因此有 step 事件 */
  tools: "/api/ai/chat",
  /** 智能助手：纯对话（OpenAI 兼容 / Anthropic / Gemini） */
  plain: "/api/ai/proxy",
} as const;

export interface StreamChatResult {
  /** 本次是否真的按 SSE 逐帧到达 */
  usedStream: boolean;
  /** 已累计的正文（含降级时一次性到达的全文） */
  fullText: string;
  /** 流内 error 事件的原文；没有则 null */
  error: string | null;
  /** 收到的事件总数（0 表示连一帧都没进来，调用方应按「流式失败」处理） */
  events: number;
}

function aiHeaders(ai: AiSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-ai-provider": ai.provider,
    "x-ai-base-url": ai.baseUrl,
    "x-ai-api-key": ai.apiKey,
    "x-ai-model": ai.model,
    ...(ai.proxy?.trim() ? { "x-ai-proxy": ai.proxy.trim() } : {}),
  };
}

export async function streamChat(opts: {
  ai: AiSettings;
  endpoint?: keyof typeof CHAT_ENDPOINTS;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** 端点专属参数：mode / focusSymbol / contextWindow / sessionSymbol / prevScene / watchlist */
  extra?: Record<string, unknown>;
  timeoutMs?: number;
  onEvent: (ev: StreamEvent) => void;
  signal?: AbortSignal;
}): Promise<StreamChatResult> {
  const url = CHAT_ENDPOINTS[opts.endpoint ?? "plain"];
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const res = await fetch(url, {
    method: "POST",
    headers: aiHeaders(opts.ai),
    body: JSON.stringify(chatRequestBody(opts.endpoint ?? "plain", opts.messages, opts.extra)),
    signal: opts.signal ? mergeSignals(opts.signal, timeout) : timeout,
  });
  const ct = res.headers.get("content-type");

  if (!isEventStream(ct)) {
    const json = (await res.json().catch(() => ({}))) as {
      content?: string; error?: string; warning?: string; steps?: StepInfo[]; intent?: unknown;
    };
    if (!res.ok || json.error) throw new Error(json.error || `请求失败（${res.status}）`);
    const content = json.content ?? "";
    opts.onEvent({ type: "warning", data: { text: "该服务商本次整体返回（未走 SSE），界面按本机节奏逐段画出，不是上游逐字流。" } });
    if (json.warning) opts.onEvent({ type: "warning", data: { text: json.warning } });
    // 非 SSE 时自动调度的步骤与场景徽章随 JSON 一起回来：不并进来的话，时间线和徽章会在降级路上凭空消失
    for (const s of Array.isArray(json.steps) ? json.steps : []) opts.onEvent({ type: "step", data: s });
    if (content) opts.onEvent({ type: "delta", data: { content } });
    const intent = asStreamIntent(json.intent);
    opts.onEvent({ type: "done", data: { fullText: content, ...(intent ? { intent } : {}) } });
    return { usedStream: false, fullText: content, error: null, events: content ? 3 : 2 };
  }

  if (!res.ok || !res.body) throw new Error(`流式响应不可用（${res.status}）`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullText = "";
  let error: string | null = null;
  let events = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 帧之间以空行分隔（协议口径见 chat-stream-core.createSseScanner）
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
      if (!dataLines.length) continue;
      const ev = decodeStreamEvent(dataLines.join("\n"));
      if (!ev) continue;
      events++;
      if (ev.type === "delta") fullText += ev.data.content;
      if (ev.type === "done" && ev.data.fullText) fullText = ev.data.fullText;
      if (ev.type === "error") error = ev.data.message;
      opts.onEvent(ev);
    }
  }
  if (buf.trim()) {
    const dataLines = buf.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    const ev = decodeStreamEvent(dataLines.join("\n"));
    if (ev) {
      events++;
      if (ev.type === "delta") fullText += ev.data.content;
      if (ev.type === "done" && ev.data.fullText) fullText = ev.data.fullText;
      if (ev.type === "error") error = ev.data.message;
      opts.onEvent(ev);
    }
  }
  if (!error && events === 0) error = "流式连接没有送达任何事件（可能是网络中断或代理不支持长连接）";
  return { usedStream: true, fullText, error, events };
}

/** AbortSignal.any 在部分 Node/浏览器版本上没有，手搓一个够用的 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = (s: AbortSignal) => ctrl.abort(s.reason);
  if (a.aborted) onAbort(a);
  else a.addEventListener("abort", () => onAbort(a), { once: true });
  if (b.aborted) onAbort(b);
  else b.addEventListener("abort", () => onAbort(b), { once: true });
  return ctrl.signal;
}

/**
 * 本机节奏：把整体返回的全文按帧画出，用于「上游没流式」时的展示。
 * 调用方必须先收到 warning 事件再用它 —— 节奏是本机的，这句话得说在前面。
 */
export async function playTypewriter(
  text: string,
  put: (partial: string) => void,
  opts: { sliceChars?: number; tickMs?: number; maxFrames?: number; shouldStop?: () => boolean } = {},
): Promise<void> {
  const size = Math.max(1, opts.sliceChars ?? 4);
  const tick = Math.max(0, opts.tickMs ?? 18);
  const maxFrames = Math.max(1, opts.maxFrames ?? 240);
  const step = Math.max(size, Math.ceil(text.length / maxFrames));
  for (let i = step; i < text.length; i += step) {
    if (opts.shouldStop?.()) return;
    put(text.slice(0, i));
    if (tick) await new Promise((r) => setTimeout(r, tick));
  }
  put(text);
}
