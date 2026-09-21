// P7-⑤ SSE 流式契约的纯内核（开发文档 §2.3：step / delta / warning / done / error 五类事件）。
//
// 这里只做「帧的编解码 + 上游增量的归并 + 步骤文案」，不 fetch、不 new Response、不碰 DOM，
// 所以服务端路由、浏览器客户端、node --test 三边都能共用同一套口径。
//
// 数据纪律的体现：流式与否必须如实上报。
//  - 上游没给 SSE（返回 application/json）时，isEventStream() 判 false，调用方必须发 warning，
//    再按本机节奏展示；绝不能把「一次拿全」画成「上游在逐字吐」。
//  - 上游中途断开：scanner.flush() 交出残帧，调用方登记「已中断」，不得补字。

// ---------- 事件契约 ----------

// 只 import 类型：node --strip-types 会擦掉这一行，纯内核之间因此不会形成运行时依赖，
// 但字段口径只有一份（改 chat-core 的徽章字段，这里编译期就跟着变，不会出现「服务端发了、前端解不出」）。
import type { IntentBadge } from "./chat-core.ts";

export type StepStatus = "running" | "ok" | "error" | "missing" | "stale";

export interface StreamStep {
  step: number;
  label: string;
  status: StepStatus;
  tool?: string;
  detail?: string;
  ms?: number | null;
  /** P7-⑥④：prefetch＝系统按场景预先取的，model＝模型自己调的。界面上必须分开，不能都算成模型的能力 */
  source?: "prefetch" | "model";
  /** 为什么要取这一步（自动调度给的理由） */
  reason?: string;
  /**
   * P7-⑧④：这一步在任务系统里的 jobId（目前只有 run_backtest 会带）。
   * 只带 id、不带结果：结果由前端按 id 走现成的 GET /api/quant/backtest?jobId= 取，
   * 于是不用在 SSE 契约里再抄一份回测结果结构（抄一份就会和量化页那套慢慢对不上），
   * 而且超过 60 秒没跑完的任务，前端照样能继续看到进度。
   */
  jobId?: string;
}

/**
 * P7-⑥⑤：done 事件带回来的场景判定 —— 直接沿用 chat-core 的展示件类型，不再各写一份字段表：
 * 两边字段对不上的时候，界面上就是一个假徽章或一个空徽章，而这正是最不容易被发现的那种错。
 * 校验仍在 asStreamEvent 里按白名单做：上游/代理可能整段不回，缺了就当没判场景，
 * 不能让一个坏掉的徽章把已经收到的回答一起带崩。
 */
export type StreamIntent = IntentBadge;

export type StreamEvent =
  | { type: "step"; data: StreamStep }
  | { type: "delta"; data: { content: string } }
  | { type: "warning"; data: { text: string } }
  | { type: "done"; data: { fullText: string; steps?: StreamStep[]; intent?: StreamIntent } }
  | { type: "error"; data: { message: string } };

export const STREAM_EVENT_TYPES = ["step", "delta", "warning", "done", "error"] as const;

export function encodeStreamEvent(ev: StreamEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/** 帧注释：用于服务端定期保活，前端解析器会原样忽略 */
export function sseComment(text: string): string {
  return `: ${text.replace(/\n/g, " ")}\n\n`;
}

const EVENT_TYPES = new Set<string>(STREAM_EVENT_TYPES);

/** 宽松解码：形状不对一律返回 null，调用方选择忽略，不让半截帧污染回答 */
export function decodeStreamEvent(raw: string): StreamEvent | null {
  const s = raw.trim();
  if (!s) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  return asStreamEvent(obj);
}

export function asStreamEvent(obj: unknown): StreamEvent | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { type?: unknown; data?: any };
  if (typeof o.type !== "string" || !EVENT_TYPES.has(o.type) || !o.data || typeof o.data !== "object") return null;
  switch (o.type) {
    case "step": {
      const d = o.data;
      if (typeof d.step !== "number" || typeof d.label !== "string") return null;
      const status: StepStatus = (["running", "ok", "error", "missing", "stale"] as const).includes(d.status) ? d.status : "ok";
      const data: StreamStep = { step: d.step, label: d.label, status, ms: d.ms ?? null };
      // 只带真的存在的字段：留下 detail: undefined 会让「原样往返」多出无意义的键
      if (typeof d.tool === "string") data.tool = d.tool;
      if (typeof d.detail === "string") data.detail = d.detail;
      // 预取/模型自取必须穿得过这层解码：丢了前端的步骤时间线就没法说明「这步是系统替你取的」
      if (d.source === "prefetch" || d.source === "model") data.source = d.source;
      if (typeof d.reason === "string") data.reason = d.reason;
      // jobId 过一遍类型：前端拿到不认识的形状就当没带，不会画出「任务 undefined」这种假卡
      if (typeof d.jobId === "string" && d.jobId) data.jobId = d.jobId;
      return { type: "step", data };
    }
    case "delta":
      return typeof o.data.content === "string" ? { type: "delta", data: { content: o.data.content } } : null;
    case "warning":
      return typeof o.data.text === "string" ? { type: "warning", data: { text: o.data.text } } : null;
    case "done": {
      const ev: StreamEvent = { type: "done", data: { fullText: typeof o.data.fullText === "string" ? o.data.fullText : "" } };
      const intent = asStreamIntent(o.data.intent);
      if (intent) ev.data.intent = intent;
      return ev;
    }
    case "error":
      return { type: "error", data: { message: typeof o.data.message === "string" ? o.data.message : "未知错误" } };
    default:
      return null;
  }
}

// ---------- done 事件的场景徽章（同样按白名单宽松解码） ----------

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * 解码 done 事件里的场景徽章。
 * 判不出来（缺字段、类型不对、上游根本没回）就整体返回 null，而不是拼一个半成品：
 * 半个徽章会画出「场景：undefined」这种看着像真话的界面，比不画更糟。
 */
export function asStreamIntent(v: unknown): StreamIntent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.scene !== "string" || !o.scene) return null;
  const label = typeof o.label === "string" && o.label ? o.label : o.scene;
  const out: StreamIntent = {
    scene: o.scene,
    label,
    hits: stringArray(o.hits),
    symbol: typeof o.symbol === "string" && o.symbol ? o.symbol : null,
    symbolSource: typeof o.symbolSource === "string" ? o.symbolSource : "none",
    inherited: o.inherited === true,
    followUp: o.followUp === true,
    skipped: stringArray(o.skipped),
  };
  const alternates = stringArray(o.alternates);
  if (alternates.length) out.alternates = alternates;
  if (typeof o.prefetchChars === "number" && isFinite(o.prefetchChars)) out.prefetchChars = Math.max(0, Math.trunc(o.prefetchChars));
  return out;
}

// ---------- 请求体契约（两个端点对「这一轮是不是对话」的说法必须一致） ----------

/**
 * 有工具调用环的服务商（OpenAI 兼容协议族）。
 * 这份名单只放在纯层一处：服务端路由拿它判「这个服务商能不能自己取数」，
 * 浏览器拿它选端点，两边各写一份就会出现「前端发到 /api/ai/chat、后端回一句请换接口」。
 */
export const OPENAI_COMPAT_PROVIDERS: readonly string[] = ["openai", "deepseek", "moonshot", "openrouter", "ollama", "custom"];

export function supportsToolCalling(provider: string | null | undefined): boolean {
  // 服务商 id 正常来自设置里的下拉（小写），但存档是本机可改的：大小写/空格差一下就判成「没有工具环」，
  // 会让 DeepSeek 用户白白拿不到自动取数。认得宽一点，能力是真有的。
  return OPENAI_COMPAT_PROVIDERS.includes((provider ?? "").trim().toLowerCase());
}

/**
 * 选端点：
 *  - tools = AI 交易员（服务端有工具调用环，模型可以自己补取数据）；
 *  - plain = 智能助手（没有工具环，但场景识别与系统按场景预取照样有）。
 * auto 按服务商能力走：Anthropic / Gemini 原生协议没有这条路，硬发过去只会得到一句报错，
 * 所以对这类服务商自动退回 plain —— 两条路的场景口径是同一份，用户看到的徽章与数据来源不会因为退回而变。
 */
export function pickChatEndpoint(
  provider: string | null | undefined,
  want: "auto" | "plain" | "tools" = "auto",
): "plain" | "tools" {
  if (want === "plain") return "plain";
  if (want === "tools") return "tools";
  return supportsToolCalling(provider) ? "tools" : "plain";
}

/** 会发给模型的最小消息形状：与 chat-core 的 ChatRequestMessage 同形，这里不重复引类型以免形成依赖 */
export interface BodyMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * 场景识别要用的三个字段（放在 body.scene 里，而不是平铺在顶层）。
 * 顺序与含义都由这份常量定：客户端多传一个键、少搬一个键，就会出现「首页有徽章、小窗没徽章」这种两边不一致。
 */
export const SCENE_KEYS = ["focusSymbol", "sessionSymbol", "prevScene"] as const;

/**
 * 组装聊天请求体。
 *  - tools 端点（/api/ai/chat）本身就是对话端点，字段平铺即可；
 *  - plain 端点（/api/ai/proxy）同时服务研究页、事件理解、Agent 循环、连通性自检，
 *    它靠 body.scene 判断「这是对话轮，要做意图识别 + 场景自动取数」。
 * 即使三个字段都为空也照样写 scene（写的是 {}）：这条声明本身才是「这一轮是对话」的凭据，
 * 不声明就退化成一次普通转发，一句多余的提示词都不加 —— 反过来也不能让非对话请求被误判成对话。
 */
export function chatRequestBody(
  endpoint: "plain" | "tools",
  messages: BodyMessage[],
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { messages, stream: true, ...(extra ?? {}) };
  if (endpoint === "plain") {
    const scene: Record<string, unknown> = {};
    for (const k of SCENE_KEYS) if (extra?.[k] !== undefined) scene[k] = extra[k];
    for (const k of SCENE_KEYS) delete body[k];
    body.scene = scene;
  }
  return body;
}

// ---------- SSE 帧扫描（增量，服务端读上游 / 前端读本地路由都要用） ----------

export interface RawFrame {
  event?: string;
  data: string;
}

export interface SseScanner {
  push(chunk: string): RawFrame[];
  /** 流结束时把缓冲区里没遇到空行的残帧交出来（有些上游最后一个 data 帧不补空行） */
  flush(): RawFrame[];
}

export function createSseScanner(): SseScanner {
  let buf = "";
  let pending: { event?: string; data: string[] } = { data: [] };
  const take = (): RawFrame[] => {
    if (!pending.data.length && !pending.event) return [];
    const frame: RawFrame = { event: pending.event, data: pending.data.join("\n") };
    pending = { data: [] };
    return [frame];
  };
  return {
    push(chunk: string): RawFrame[] {
      if (!chunk) return [];
      buf += chunk;
      const out: RawFrame[] = [];
      let idx: number;
      // 逐行消费；行尾 \r\n / \n 都支持（上游实现不一）
      while ((idx = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) { out.push(...take()); continue; }
        if (line.startsWith(":")) continue; // 注释 / 保活
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") pending.data.push(value);
        else if (field === "event") pending.event = value;
        // id/retry 等其他字段本项目协议不用，忽略
      }
      return out;
    },
    flush(): RawFrame[] {
      const out: RawFrame[] = [];
      if (buf) {
        const line = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
        buf = "";
        if (line && !line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") pending.data.push(value);
          else if (field === "event") pending.event = value;
        }
      }
      out.push(...take());
      return out;
    },
  };
}

/** 一次性解析（测试与降级路径用） */
export function scanSse(text: string): RawFrame[] {
  const sc = createSseScanner();
  const out = sc.push(text);
  return [...out, ...sc.flush()];
}

// ---------- 上游 OpenAI 兼容流的增量归并 ----------

export interface UpstreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsFragment?: string;
}

export interface UpstreamDelta {
  /** 本轮新增正文（可能为空） */
  text: string;
  toolCalls: UpstreamToolCallDelta[];
  finishReason: string | null;
  /** data: [DONE] */
  done: boolean;
  /** 这一帧是不是合法的 JSON chunk；非 JSON、非 [DONE] 的空帧为 false */
  recognized: boolean;
}

export function parseUpstreamFrame(frame: RawFrame): UpstreamDelta {
  const raw = frame.data.trim();
  if (!raw) return { text: "", toolCalls: [], finishReason: null, done: false, recognized: false };
  if (raw === "[DONE]") return { text: "", toolCalls: [], finishReason: null, done: true, recognized: true };
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { text: "", toolCalls: [], finishReason: null, done: false, recognized: false };
  }
  const choice = Array.isArray(obj?.choices) ? obj.choices[0] : undefined;
  const delta = choice?.delta ?? choice?.message ?? {};
  const text = typeof delta?.content === "string" ? delta.content : "";
  const toolCalls: UpstreamToolCallDelta[] = (delta?.tool_calls ?? []).map((tc: any, i: number) => ({
    index: typeof tc?.index === "number" ? tc.index : i,
    ...(tc?.id ? { id: String(tc.id) } : {}),
    ...(tc?.function?.name ? { name: String(tc.function.name) } : {}),
    ...(typeof tc?.function?.arguments === "string" ? { argsFragment: tc.function.arguments } : {}),
  }));
  return { text, toolCalls, finishReason: choice?.finish_reason ?? null, done: false, recognized: true };
}

export interface AssembledToolCall {
  id: string;
  name: string;
  argsText: string;
}

/** 按 index 归并 tool_calls 增量：参数是分片吐的，缺这一步就没法在流式下执行工具 */
export function createToolCallAssembler() {
  const byIndex = new Map<number, AssembledToolCall>();
  return {
    push(deltas: UpstreamToolCallDelta[]) {
      for (const d of deltas) {
        const cur = byIndex.get(d.index) ?? { id: "", name: "", argsText: "" };
        if (d.id) cur.id = d.id;
        if (d.name) cur.name += d.name;
        if (d.argsFragment) cur.argsText += d.argsFragment;
        byIndex.set(d.index, cur);
      }
    },
    /** 上游常不给 id：补一个稳定的占位，供回填 tool 消息时对齐 */
    result(): AssembledToolCall[] {
      return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }));
    },
    size(): number {
      return byIndex.size;
    },
  };
}

// ---------- 内容类型 / 降级判定 ----------

export function isEventStream(contentType: string | null | undefined): boolean {
  return /text\/event-stream/i.test(contentType ?? "");
}

/** 整体返回时的如实文案：调用方必须原样发给前端，不得静默画成逐字流 */
export function notStreamedWarning(contentType: string | null | undefined): string {
  return `上游未以 SSE 返回（content-type: ${contentType || "未知"}），本机按整体结果展示，不是逐字流。`;
}

export function streamBrokenWarning(detail?: string): string {
  return `流式连接提前结束${detail ? `：${detail}` : ""}，已展示的内容到此处为止，未补全。`;
}

// ---------- 步骤文案（工具名 → 给人看的一句话） ----------

export const TOOL_STEP_LABELS: Record<string, string> = {
  market_sentiment: "取大盘情绪（涨跌家数/涨停/成交额/风险等级）",
  sector_rank: "取板块资金榜",
  stock_snapshot: "取个股实时快照",
  stock_depth: "取五档盘口",
  stock_trades: "取主动买卖（内外盘口径）",
  stock_kline_summary: "取日 K 并计算技术状态",
  stock_fund_flow: "取近 14 日主力资金流",
  market_news: "取最新快讯",
  watchlist_overview: "取自选股实时总览（清单来自本机存档）",
  factor_screener: "跑全 A 条件选股",
  historical_probability: "统计历史条件概率",
  // P7-⑧④：回测要等引擎，耗时和其他工具不是一个量级，界面上必须让人看见这一步在等什么
  run_backtest: "跑因子回测（白名单校验 → 引擎计算，最多等 60 秒）",
  model_answer: "模型生成回答",
};

export function stepLabelFor(tool: string, args?: Record<string, unknown> | null): string {
  const base = TOOL_STEP_LABELS[tool] ?? `调用 ${tool}`;
  if (!args) return base;
  const symbol = typeof args.symbol === "string" ? args.symbol : "";
  const cond = Array.isArray(args.conditions) ? `（${args.conditions.length} 个条件）` : "";
  const kind = typeof args.kind === "string" ? `（${args.kind === "concept" ? "概念" : "行业"}）` : "";
  // 回测的因子个数单独标一份：白名单校验是按因子做的，界面要说清「跑的是哪几个因子请求」
  const facs = Array.isArray(args.factors) && args.factors.length
    ? `（${args.factors.map((f) => String((f as { factorKey?: unknown })?.factorKey ?? "?")).join("、")}）`
    : "";
  return `${base}${symbol ? ` · ${symbol}` : ""}${cond}${kind}${facs}`;
}

/** 工具结果摘要：缺数据必须一眼看出是「缺」，不是 0 */
export function stepDetailOf(result: unknown): { status: StepStatus; detail: string } {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
  if (text === null || text === "undefined" || text === "null") return { status: "missing", detail: "无返回" };
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && typeof parsed.missing === "string") {
    return { status: "missing", detail: `缺失：${parsed.missing}` };
  }
  const flat = text.replace(/\s+/g, " ");
  return { status: "ok", detail: flat.length > 120 ? `${flat.slice(0, 120)}…` : flat };
}

/**
 * 非流式兜底拿回来的 trace → 同一套步骤口径。
 * 流式（step 事件）与降级（trace 数组）必须画出一样的时间线，否则用户会以为两条链路判定不同。
 */
export function stepsFromTrace(
  trace: { name: string; args: Record<string, unknown>; ms: number; status: "ok" | "error"; summary: string }[],
): StreamStep[] {
  return (trace ?? []).map((t, i) => {
    const judged = stepDetailOf(t.summary);
    return {
      step: i + 1,
      label: stepLabelFor(t.name, t.args),
      tool: t.name,
      ms: t.ms,
      status: t.status === "error" ? "error" : judged.status,
      detail: judged.detail,
    };
  });
}
