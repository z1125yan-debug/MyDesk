// P7-⑤ 基础对话升级的纯内核（不 fetch、不碰 DOM、不碰库，node --test 可直跑）。
//
// 为什么单独一层：会话结构（id/标题/关联标的）、上下文窗口裁剪、旧对话压缩、打字机切片
// 这些都是「判断」而不是「取数」。放在这里才能用测试钉住口径，页面只负责画。
//
// 数据纪律在这里的体现：
//  - 压缩摘要只做「原样截断 + 标明是谁说的」，绝不改写成结论，也不虚构内容；
//  - 摘要抬头写死「非实时数据」，避免模型把上周的聊天内容当成今天的行情；
//  - 本地打字机切片必须能被识别成本地节奏（调用方要发 warning），不谎称上游在流式。
import type { ChatMsg } from "./types";

export type ChatRole = "user" | "assistant";

/** 一次工具/步骤调用的展示信息（由 chat-stream-core 的 step 事件喂进来） */
export interface StepInfo {
  step: number;
  label: string;
  status: "running" | "ok" | "error" | "missing";
  tool?: string;
  detail?: string;
  ms?: number | null;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** 回答附带的工作步骤（真实调用过哪些工具、耗时、状态） */
  steps?: StepInfo[];
  /** 这条消息生成时快照到的标的/价位/时刻：只作展示与追溯，不是行情事实来源 */
  context?: { stock?: string; price?: number | null; time?: string };
  /** 生成中：用于画光标 */
  streaming?: boolean;
  /** 流式/降级过程中如实登记的提示（例如「上游未流式，本机节奏展示」） */
  warning?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  /** 会话关联标的（有则追问时沿用，不重复识别） */
  stock?: string;
  costPrice?: number | null;
  holdPeriod?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 上下文窗口：保留最近 N 轮（一轮 = 一条用户消息 + 其后的助手消息） */
export const DEFAULT_MAX_TURNS = 12;

// ---------- id / 标题 ----------

export function newId(prefix: string, now: number = Date.now(), rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 1e8).toString(36);
  return `${prefix}_${now.toString(36)}${r}`;
}

/** 会话标题：取第一条用户消息的前若干字；空会话用占位标题 */
export function titleFromMessages(messages: Pick<ChatMessage, "role" | "content">[], fallback = "新会话", max = 18): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return fallback;
  const cleaned = first.content.replace(/\s+/g, " ").replace(/^["'\u2018\u2019\u201c\u201d「『]+|["'\u2018\u2019\u201c\u201d」』]+$/g, "").trim();
  if (!cleaned) return fallback;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function emptySession(now?: number): ChatSession {
  const ts = now ?? Date.now();
  return { id: newId("s", ts), title: "新会话", messages: [], createdAt: ts, updatedAt: ts };
}

/**
 * 旧存档（chats: ChatMsg[][] + activeChat 下标）→ 带 id/标题的会话列表。
 * 迁移必须无损：原来的消息一条不少地搬过来，缺的 id 补上，标题按首条提问生成。
 */
export function migrateLegacyChats(chats: ChatMsg[][] | undefined | null, now: number = Date.now()): ChatSession[] {
  const list = Array.isArray(chats) ? chats : [];
  const out: ChatSession[] = list.map((msgs, i) => {
    const messages = (msgs ?? []).map((m, j) => normalizeMessage(m, `${i}-${j}`, now));
    return {
      id: newId(`mig${i}`, now, () => i + 1),
      title: titleFromMessages(messages),
      messages,
      createdAt: messages[0]?.ts ?? now,
      updatedAt: messages.at(-1)?.ts ?? now,
    };
  });
  return out.length ? out : [emptySession(now)];
}

/** 宽松读入：任何缺 id/ts 的历史消息都补齐，非法角色按 user 处理（旧数据只可能是 user/assistant） */
export function normalizeMessage(m: Partial<ChatMessage> & { content?: string; role?: string }, seed: string, now: number = Date.now()): ChatMessage {
  const role: ChatRole = m.role === "assistant" ? "assistant" : "user";
  return {
    id: m.id || `m_${seed}`,
    role,
    content: typeof m.content === "string" ? m.content : "",
    ts: typeof m.ts === "number" && isFinite(m.ts) ? m.ts : now,
    ...(m.steps?.length ? { steps: m.steps } : {}),
    ...(m.context ? { context: m.context } : {}),
  };
}

// ---------- 上下文窗口与压缩 ----------

export interface WindowSplit {
  /** 本轮真正发给模型的消息（窗口内） */
  sent: ChatMessage[];
  /** 被窗口挤出去的消息（用于压缩摘要） */
  dropped: ChatMessage[];
}

/**
 * 按「轮」裁窗口，而不是按条数裁：原来各处 slice(-12) 会把半句对话切开——
 * 极端情况下窗口以助手消息开头，模型会把上文当成用户在说话。
 */
export function splitWindow(messages: ChatMessage[], maxTurns: number = DEFAULT_MAX_TURNS): WindowSplit {
  const turns: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === "user" || !turns.length) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  const keep = Math.max(1, Math.floor(maxTurns));
  const keptTurns = turns.slice(-keep);
  const droppedTurns = turns.slice(0, Math.max(0, turns.length - keep));
  const dropped = droppedTurns.flat();
  const sent = keptTurns.flat();
  // 窗口开头若是助手消息（旧存档可能以 assistant 起头），丢掉，避免模型续写别人的话
  while (sent.length && sent[0].role !== "user") sent.shift();
  return { sent, dropped };
}

export interface CompressOpts {
  /** 每条摘要行的原文上限（含省略号） */
  perMessageChars?: number;
  /** 最多列几条，超出的只报条数，不逐条展开 */
  maxLines?: number;
}

/**
 * 旧对话压缩：忠实截断 + 标注说话人 + 抬头声明「非实时数据」。
 * 这里不叫「总结」也不做任何改写——真要摘要就得再调模型，那是另一件事，不能拿截断冒充理解。
 */
export function summarizeDropped(dropped: ChatMessage[], opts: CompressOpts = {}): string {
  if (!dropped.length) return "";
  const per = Math.max(12, opts.perMessageChars ?? 60);
  const maxLines = Math.max(1, opts.maxLines ?? 8);
  const shown = dropped.slice(-maxLines);
  const omitted = dropped.length - shown.length;
  const head = [
    `【本次会话的更早对话（本机存档摘要，共 ${dropped.length} 条，非实时数据）】`,
    "以下原文按字符截断，仅作话题与上下文线索；其中的价格、结论都属于当时，不得当作当前行情引用。",
  ];
  const lines = shown.map((m) => {
    const text = m.content.replace(/\s+/g, " ").trim();
    const clipped = text.length > per ? `${text.slice(0, per - 1)}…` : text;
    return `- ${m.role === "user" ? "用户" : "助手"}：${clipped || "（空）"}`;
  });
  return [...head, ...lines, ...(omitted > 0 ? [`- （更早还有 ${omitted} 条未列出）`] : [])].join("\n");
}

export interface PromptPiece { role: "user" | "assistant" | "system"; content: string }

/**
 * 发给对话端点（/api/ai/chat、/api/ai/proxy）的一条消息。
 * 形状与 PromptPiece 相同，单独立个名字是因为它是**跨端契约**：system 件装的是压缩摘要与来源分层说明，
 * 服务端按 §2.2 兜底裁窗时不得静默丢弃（见 route 的 trimDialog）。
 */
export type ChatRequestMessage = PromptPiece;

/**
 * 组装发给模型的对话数组：窗口内原样 + 窗口外压缩摘要（system）+ 实时快照（贴本轮新提问那条用户消息）。
 * 快照贴用户消息而不是 system：轻量模型对靠后的用户消息遵循度更高（沿用 P6 的实测结论）。
 */
export function buildPromptMessages(session: Pick<ChatSession, "messages">, opts: {
  maxTurns?: number;
  summary?: string | null;
  snapshot?: string | null;
  withSummary?: boolean;
} = {}): PromptPiece[] {
  const { sent, dropped } = splitWindow(session.messages.filter((m) => m.content.trim()), opts.maxTurns);
  const pieces: PromptPiece[] = [];
  const summary = opts.withSummary === false ? "" : (opts.summary ?? summarizeDropped(dropped));
  if (summary) pieces.push({ role: "system", content: summary });
  const window = sent.map((m) => ({ role: m.role, content: m.content }) as PromptPiece);
  if (opts.snapshot) {
    // 快照只贴「本轮的新提问」，也就是窗口结尾那条用户消息。
    // 结尾是上一轮回答时（历史回看/补答场景）不能往旧提问或助手发言里塞行情，只能作为 system 附带。
    const last = window[window.length - 1];
    if (last && last.role === "user") window[window.length - 1] = { ...last, content: `${last.content}\n\n${opts.snapshot}` };
    else pieces.push({ role: "system", content: opts.snapshot });
  }
  return [...pieces, ...window];
}

/**
 * 服务端兜底裁窗：只从最早的「用户 / 助手」消息开始丢，system 件（压缩摘要、快照说明）一律保留。
 * 为什么不是 slice(-n)：那样先被挤掉的正是开头那条摘要，等于把上面的上下文压缩白做一遍。
 */
export function trimDialog<T extends { role: string }>(messages: T[], maxDialogMessages: number): T[] {
  const keep = Math.max(1, Math.floor(maxDialogMessages));
  const dialogIdx: number[] = [];
  messages.forEach((m, i) => { if (m.role !== "system") dialogIdx.push(i); });
  const drop = new Set(dialogIdx.slice(0, Math.max(0, dialogIdx.length - keep)));
  return messages.filter((_, i) => !drop.has(i));
}

// ---------- 追问识别 ----------

const FOLLOWUP_WORDS = [
  "那", "它", "这只", "这支", "该", "上面", "刚才", "刚刚", "前面", "继续", "再", "还有", "其次",
  "为什么", "怎么会", "详细", "展开", "举例", "等等", "然后", "所以呢", "对吗", "呢",
];

/**
 * 是否追问（省略了主语的那种）。追问时沿用会话已关联的标的，不必重新识别；
 * 认出 6 位代码或明确的品种名则算换了对象，需要重新取数。
 */
export function isFollowUp(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (/\d{6}/.test(t)) return false;
  const startsWithPronoun = /^(那|它|这|该|上面|刚才|刚刚|继续|再|还有|其次|所以|然后)/.test(t);
  const hit = FOLLOWUP_WORDS.some((w) => t.includes(w));
  return startsWithPronoun || (hit && t.length <= 12);
}

// ---------- 流式事件 → 消息状态（前端 reducer，纯函数） ----------

export type AppliedEvent =
  | { type: "step"; data: StepInfo }
  | { type: "delta"; data: { content: string } }
  | { type: "warning"; data: { text: string } }
  | { type: "done"; data?: { fullText?: string } }
  | { type: "error"; data: { message: string } };

/** 把一条流事件并入助手消息草稿；同一 step 序号的重复事件按「后到的覆盖状态」处理 */
export function applyEvent(msg: ChatMessage, ev: AppliedEvent): ChatMessage {
  switch (ev.type) {
    case "delta":
      return { ...msg, content: msg.content + (ev.data?.content ?? "") };
    case "step": {
      const steps = [...(msg.steps ?? [])];
      const i = steps.findIndex((s) => s.step === ev.data.step);
      if (i === -1) steps.push(ev.data);
      else steps[i] = { ...steps[i], ...ev.data };
      return { ...msg, steps };
    }
    case "warning":
      return { ...msg, warning: [msg.warning, ev.data?.text].filter(Boolean).join("；") };
    case "done":
      return { ...msg, streaming: false, ...(ev.data?.fullText ? { content: ev.data.fullText } : {}) };
    case "error":
      return {
        ...msg,
        streaming: false,
        content: msg.content || `请求出错：${ev.data?.message ?? "未知错误"}`,
        warning: [msg.warning, ev.data?.message ? `已中断：${ev.data.message}` : ""].filter(Boolean).join("；") || msg.warning,
      };
    default:
      return msg;
  }
}

/** 收尾：清掉还在 running 的步骤（上游中断时不能留个永远转圈的步骤） */
export function settleRunningSteps(msg: ChatMessage, note = "未收到该步骤的结束事件（连接提前结束）"): ChatMessage {
  if (!msg.steps?.some((s) => s.status === "running")) return msg;
  return {
    ...msg,
    steps: msg.steps.map((s) => (s.status === "running" ? { ...s, status: "error", detail: s.detail || note } : s)),
  };
}

// ---------- 本地打字机节奏（降级展示用，不是流式） ----------

/**
 * 上游整体返回时，用本机节奏分段画出来。
 * 切的是「展示用的前缀序列」，原文一个字不改；sliceCount 返回实际段数，调用方据此发 warning 说明这是本机节奏。
 */
export function typewriterSlices(text: string, opts: { sliceChars?: number; maxSlices?: number } = {}): string[] {
  if (!text) return [];
  const size = Math.max(1, opts.sliceChars ?? 6);
  const maxSlices = Math.max(1, opts.maxSlices ?? 400);
  const step = Math.max(size, Math.ceil(text.length / maxSlices));
  const out: string[] = [];
  for (let i = step; i < text.length; i += step) out.push(text.slice(0, i));
  out.push(text);
  return out;
}

// ---------- 会话列表操作（不可变更新，store 直接用） ----------

export function upsertSession(sessions: ChatSession[], next: ChatSession): ChatSession[] {
  const i = sessions.findIndex((s) => s.id === next.id);
  if (i === -1) return [next, ...sessions];
  const copy = [...sessions];
  copy[i] = next;
  return copy;
}

export function appendMessage(session: ChatSession, msg: ChatMessage, now: number = Date.now()): ChatSession {
  const messages = [...session.messages, msg];
  return {
    ...session,
    messages,
    updatedAt: now,
    title: session.title === "新会话" || !session.title ? titleFromMessages(messages) : session.title,
  };
}

export function updateMessage(session: ChatSession, id: string, patch: Partial<ChatMessage>, now: number = Date.now()): ChatSession {
  const messages = session.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
  return { ...session, messages, updatedAt: now };
}

export function removeSession(sessions: ChatSession[], id: string): ChatSession[] {
  const out = sessions.filter((s) => s.id !== id);
  return out.length ? out : [emptySession()];
}
