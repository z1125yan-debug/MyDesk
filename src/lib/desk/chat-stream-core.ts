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

export type StepStatus = "running" | "ok" | "error" | "missing";

export interface StreamStep {
  step: number;
  label: string;
  status: StepStatus;
  tool?: string;
  detail?: string;
  ms?: number | null;
}

export type StreamEvent =
  | { type: "step"; data: StreamStep }
  | { type: "delta"; data: { content: string } }
  | { type: "warning"; data: { text: string } }
  | { type: "done"; data: { fullText: string; steps?: StreamStep[] } }
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
      const status: StepStatus = (["running", "ok", "error", "missing"] as const).includes(d.status) ? d.status : "ok";
      const data: StreamStep = { step: d.step, label: d.label, status, ms: d.ms ?? null };
      // 只带真的存在的字段：留下 detail: undefined 会让「原样往返」多出无意义的键
      if (typeof d.tool === "string") data.tool = d.tool;
      if (typeof d.detail === "string") data.detail = d.detail;
      return { type: "step", data };
    }
    case "delta":
      return typeof o.data.content === "string" ? { type: "delta", data: { content: o.data.content } } : null;
    case "warning":
      return typeof o.data.text === "string" ? { type: "warning", data: { text: o.data.text } } : null;
    case "done":
      return { type: "done", data: { fullText: typeof o.data.fullText === "string" ? o.data.fullText : "" } };
    case "error":
      return { type: "error", data: { message: typeof o.data.message === "string" ? o.data.message : "未知错误" } };
    default:
      return null;
  }
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
  factor_screener: "跑全 A 条件选股",
  historical_probability: "统计历史条件概率",
  model_answer: "模型生成回答",
};

export function stepLabelFor(tool: string, args?: Record<string, unknown> | null): string {
  const base = TOOL_STEP_LABELS[tool] ?? `调用 ${tool}`;
  if (!args) return base;
  const symbol = typeof args.symbol === "string" ? args.symbol : "";
  const cond = Array.isArray(args.conditions) ? `（${args.conditions.length} 个条件）` : "";
  const kind = typeof args.kind === "string" ? `（${args.kind === "concept" ? "概念" : "行业"}）` : "";
  return `${base}${symbol ? ` · ${symbol}` : ""}${cond}${kind}`;
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
