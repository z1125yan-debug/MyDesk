"use client";
// P7-⑤① 的浏览器侧流式客户端：POST + fetch 流读取（EventSource 只能 GET，带不上密钥头，所以不用它）。
//
// 凭据口径不变：Key 只出现在这一次请求头里，服务端转发给所选服务商，不写库、不打印、不进事件流。
// 降级口径：拿不到 event-stream（Anthropic/Gemini 原生、或上游/路由整体返回 JSON）时，
// 结果仍然是真的，只是没有逐字节奏 —— 这里如实返回 usedStream:false，由界面改成本机节奏并写明原因。
import type { AiSettings } from "./types";
import type { StepInfo } from "./chat-core";
import { aiRequestHeaders, ensureServerLlm } from "./ai";
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
  /** P8-⑥：已收进的最大帧序号水位（无 run 的普通轮帧不带 seq，恒为 0） */
  lastSeq?: number;
}

function aiHeaders(ai: AiSettings): Record<string, string> {
  // P7-⑩：与 aiChatPlain 同一份口径 —— 浏览器凭据没填全时一个 x-ai-* 都不发，
  // 只带 x-ai-server:1 让路由去读 .env；填全了则维持原样（设置页配置优先）。
  return aiRequestHeaders(ai, { Accept: "text/event-stream" });
}

// ---------- 共享的逐帧消费（首轮流与 P8-⑥ 续传流同一条路，两份循环迟早漂两份） ----------

interface FeedState {
  fullText: string;
  error: string | null;
  events: number;
  /** 已收进的最大帧序号水位：续传重放时「seq ≤ 水位」的帧在传输层直接丢，不进 applyEvent、正文不二次 append */
  lastSeq: number;
}

function createFeeder(state: FeedState, onEvent: (ev: StreamEvent) => void) {
  return (rawData: string) => {
    const ev = decodeStreamEvent(rawData);
    if (!ev) return;
    if (typeof ev.seq === "number") {
      if (ev.seq <= state.lastSeq) return; // 重复送达的旧帧：丢掉，不让它第二次改动消息
      state.lastSeq = ev.seq;
    }
    state.events++;
    if (ev.type === "delta") state.fullText += ev.data.content;
    if (ev.type === "done" && ev.data.fullText) state.fullText = ev.data.fullText;
    if (ev.type === "error") state.error = ev.data.message;
    onEvent(ev);
  };
}

/** 读干一条 SSE 响应体：帧以空行分隔、只认 data: 行、尾部残帧照旧交出（协议口径见 chat-stream-core.createSseScanner） */
async function pumpEventStream(body: ReadableStream<Uint8Array>, feed: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const take = (raw: string) => {
    const dataLines = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    if (dataLines.length) feed(dataLines.join("\n"));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      take(raw);
    }
  }
  if (buf.trim()) take(buf);
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
  ensureServerLlm();
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
  // P8-⑥：seq 水位与去重都在 createFeeder 里——首轮流帧帧递增不会触发去重，行为与 A/B 轮一致；
  // 只有续传重放才会碰到「seq ≤ 水位」的重复帧。
  const state: FeedState = { fullText: "", error: null, events: 0, lastSeq: 0 };
  await pumpEventStream(res.body, createFeeder(state, opts.onEvent));
  if (!state.error && state.events === 0) state.error = "流式连接没有送达任何事件（可能是网络中断或代理不支持长连接）";
  return { usedStream: true, fullText: state.fullText, error: state.error, events: state.events, lastSeq: state.lastSeq };
}

/**
 * P8-⑥ 断点续传：向 /api/ai/run 要「since 之后的帧」，轮次还活着就接着收实发，直到封卷。
 * 三种结局都得说清是什么：
 *  - ok    —— 续传流正常走完（done 帧在不在由调用方看事件判定：done 是正文一致性的锚）；
 *  - gone  —— 服务端没这个 run（重启/超 5 分钟窗口）：调用方给草稿留 warning 就地收口，**不自动重问**
 *             （细则 §5-1 拍板项：重问会二次打模型与行情接口，同一问题可能出现两份互相矛盾的结论）；
 *  - error —— 其他失败（网络/非法请求）：调用方按既有三档降级继续，续传只占一档、不顶掉兜底。
 */
export interface ResumeChatResult extends StreamChatResult {
  status: "ok" | "gone" | "error";
  /** true = 断点起点前的留底已被逐出（服务端已如实补发一条 warning，这里只是把事实带给调用方） */
  gap?: boolean;
}

export async function resumeChat(opts: {
  run: string;
  since: number;
  onEvent: (ev: StreamEvent) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResumeChatResult> {
  const since = Math.max(0, Math.trunc(opts.since) || 0);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await fetch("/api/ai/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ action: "resume", run: opts.run, since }),
      signal: opts.signal ? mergeSignals(opts.signal, timeout) : timeout,
    });
  } catch (e) {
    return { usedStream: false, fullText: "", error: (e as Error).message || "续传请求失败", events: 0, status: "error" };
  }
  if (!isEventStream(res.headers.get("content-type"))) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    const message = json.error || `续传请求失败（${res.status}）`;
    return { usedStream: false, fullText: "", error: message, events: 0, status: res.status === 404 ? "gone" : "error" };
  }
  if (!res.ok || !res.body) {
    return { usedStream: false, fullText: "", error: `续传流不可用（${res.status}）`, events: 0, status: "error" };
  }
  // 水位从 since 起算：重放帧的 seq 必然 > since，而断连前已画过的帧（本会话存档里的）不会再进 applyEvent
  const state: FeedState = { fullText: "", error: null, events: 0, lastSeq: since };
  await pumpEventStream(res.body, createFeeder(state, opts.onEvent));
  return {
    usedStream: true,
    fullText: state.fullText,
    error: state.error,
    events: state.events,
    lastSeq: state.lastSeq,
    status: "ok",
    gap: res.headers.get("x-kairo-resume-gap") === "1" || undefined,
  };
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
