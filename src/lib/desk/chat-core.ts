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
  /**
   * P8-① 新增 stale：接口正常返回了值、但比真实交易日历滞后（或新鲜度无法判定）——
   * 它跟 missing 是两件事：missing 是「没取到」，stale 是「取到了但不是新的」。
   */
  status: "running" | "ok" | "error" | "missing" | "stale";
  tool?: string;
  detail?: string;
  ms?: number | null;
  /**
   * P7-⑥④：这一步是「谁」要来的。
   * prefetch＝系统按场景在提问前就替你取的（自动调度），model＝模型自己发起的工具调用。
   * 必须分开：不说的话，用户会以为模型真的会自己取数，而某些服务商根本没有工具环。
   */
  source?: "prefetch" | "model";
  /** 为什么要取这一步（自动调度带的理由原文，界面上要能看出「因为判成个股分析所以取快照」） */
  reason?: string;
  /**
   * P7-⑧④：这一步对应的回测任务 id（只有 run_backtest 会带）。
   * 存的是 id 而不是结果：结果由前端按 id 走现成的回测查询接口取，界面复用量化页那张卡，
   * 会话存档也因此不会把整条净值曲线塞进 localStorage。
   */
  jobId?: string;
  /**
   * P8-⑤（debug=true 才发）：这一步的入参（值超 80 字已截断）。
   * 由路由在轮末重发同序号终帧富化进来（applyEvent 按步骤号合并），预取/调度层零改动。
   */
  args?: Record<string, unknown>;
  /** P8-⑤（debug=true 才发）：返回数据摘要（≤120 字口径）。detail 是判词、summary 是摘要，两个字段不混用 */
  summary?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** 回答附带的工作步骤（真实调用过哪些工具、耗时、状态） */
  steps?: StepInfo[];
  /** P7-⑥⑤：本轮判到的场景（展示用，来自 done 事件；不是行情事实来源） */
  intent?: IntentBadge;
  /** 这条消息生成时快照到的标的/价位/时刻：只作展示与追溯，不是行情事实来源 */
  context?: { stock?: string; price?: number | null; time?: string };
  /** 生成中：用于画光标 */
  streaming?: boolean;
  /** 流式/降级过程中如实登记的提示（例如「上游未流式，本机节奏展示」） */
  warning?: string;
  /**
   * P8-⑥：本轮「运行留底」的断点锚——客户端生成的 run id + 已收到的最大帧序号。
   * 刷新后靠它认出未收口的轮次并从 lastSeq 精确续接；只随消息进存档，不参与发给模型的任何口径。
   */
  runRef?: { id: string; lastSeq: number };
  /**
   * P8-⑤：done 帧带回来的结论留底（模型耗时 + 传输档位），供 debug 面板的结论小节。
   * 细则 §1.6 原话是「ChatMessage 不加新字段」，但 done.debug 若不落进消息就永远只在流里一闪，
   * 结论小节会全程「未留底」、§1.3 的字段成了摆设——两个小键随消息持久化，偏差在变更报告里如实记。
   */
  debug?: { modelMs?: number; transport?: string };
}

/**
 * 意图判定的展示件（不是 intent-core 的 Intent 本体）。
 * 为什么不直接把 Intent 塞进消息：Intent 带着 question、symbols 等一堆过程字段，
 * 存进 localStorage 会让会话存档越来越大，而且界面只需要「判成什么、凭什么、没取什么」。
 * scene/symbolSource 用 string 而不是联合类型：纯展示层反向依赖判定层是多余的耦合。
 */
export interface IntentBadge {
  scene: string;
  label: string;
  /** 命中的场景词：徽章要能说出「为什么判成这个场景」，判不出来就是空数组 */
  hits: string[];
  /** 同一句里还问到别的场景（模型需要自己补取数据时点名用） */
  alternates?: string[];
  symbol: string | null;
  symbolSource: string;
  /** 本轮是否沿用上一轮场景（追问） */
  inherited: boolean;
  followUp: boolean;
  /** 本轮没预取的项与原因：界面上必须能看到「没取」而不是以为「取到了空」 */
  skipped: string[];
  /** 场景自动调度取到的真实数据块字数（0 = 本轮没注入数据） */
  prefetchChars?: number;
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

/**
 * 上下文窗口：保留最近 N 轮（一轮 = 一条用户消息 + 其后的助手消息）。
 * P7-⑥③ 从 12 提到 30：要支持「那这个股明天怎么看」「帮我回测一下刚才说的策略」这种连续追问，
 * 12 轮在真实问答里三五分钟就见底，追问一多就变成「系统忘了前面问过什么」。
 * 上限不是免费的：窗口越大越可能撞上游的上下文长度，所以超过字数预算时由 applyCharBudget 从最早一轮开始收缩，
 * 并另起一条 system 件如实写明「本轮为控制长度少发了几轮」（见 buildPromptMessages）。
 */
export const DEFAULT_MAX_TURNS = 30;
/** 窗口能设的最大值（服务端兜底裁窗用的是同一个数，两边不能各写一套） */
export const MAX_TURNS_LIMIT = 30;

/** 把外部传来的轮数收进 [1, MAX_TURNS_LIMIT]；非法值退回默认而不是 0（0 会让模型完全看不到上文） */
export function clampTurns(n: unknown, fallback: number = DEFAULT_MAX_TURNS): number {
  const v = typeof n === "number" ? Math.trunc(n) : Number(n);
  if (!Number.isFinite(v) || v <= 0) return Math.min(fallback, MAX_TURNS_LIMIT);
  return Math.min(MAX_TURNS_LIMIT, v);
}

/**
 * 发给模型的一轮对话的字数预算（含压缩摘要、行情快照，以及调用方那份固定 system 提示词）。
 *
 * 说清楚这是什么、不是什么：这是**字符数**的粗护栏，不是 token 账。
 * 本项目不能新增依赖，装不了各家的 tokenizer，而中文大致 1 字 ≈ 1 token，
 * 所以按字符数收一个保守上限，宁可少带几轮历史，也不要让上游直接报上下文超长
 * （超长是整问失败，用户只会看到「AI 调用失败」，比少带几轮更糟）。
 * 收缩是整轮收缩并留痕（见 applyCharBudget），不是静默截断。
 */
export const DEFAULT_PROMPT_BUDGET_CHARS = 20_000;

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
    ...(m.intent ? { intent: m.intent } : {}),
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
  const keep = clampTurns(maxTurns);
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
 * P7-⑥③：助手消息带上「那一轮取过哪些数」的记录（renderStepsLine）——连续追问要看得到上文的数据口径，
 * 但必须标明是当时的记录，否则模型会把上一轮的快照当今天的行情引用。
 */
export function buildPromptMessages(session: Pick<ChatSession, "messages">, opts: {
  maxTurns?: number;
  summary?: string | null;
  snapshot?: string | null;
  withSummary?: boolean;
  /** 字数预算：超了就从最早一轮开始收缩（见 applyCharBudget），并如实告知模型少发了几轮 */
  budgetChars?: number;
  /**
   * 调用方自己那份固定 system 提示词已经占掉的字数（各入口的 sysPrompt、服务端目录之类）。
   * 预算必须把它算进去：只按对话部分算，等于以为留了余量其实没有，超长照样会被上游拒。
   */
  reservedChars?: number;
} = {}): PromptPiece[] {
  const { sent, dropped } = splitWindow(session.messages.filter((m) => m.content.trim()), opts.maxTurns);
  const summaryText = opts.withSummary === false ? "" : (opts.summary ?? summarizeDropped(dropped));
  const pieces: PromptPiece[] = [];
  if (summaryText) pieces.push({ role: "system", content: summaryText });
  const window = sent.map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? `${m.content}${renderStepsLine(m.steps)}` : m.content,
  }) as PromptPiece);
  if (opts.snapshot) {
    // 快照只贴「本轮的新提问」，也就是窗口结尾那条用户消息。
    // 结尾是上一轮回答时（历史回看/补答场景）不能往旧提问或助手发言里塞行情，只能作为 system 附带。
    const last = window[window.length - 1];
    if (last && last.role === "user") window[window.length - 1] = { ...last, content: `${last.content}\n\n${markSnapshot(opts.snapshot)}` };
    else pieces.push({ role: "system", content: markSnapshot(opts.snapshot) });
  }
  const merged = [...pieces, ...window];
  if (!opts.budgetChars) return merged;
  // 固定提示词先占掉一部分额度：剩下的才是对话能用的（至少留 1 字，别算成 0 把上文全砍光）
  const reserved = Math.max(0, Math.trunc(opts.reservedChars ?? 0) || 0);
  const room = Math.max(1, Math.trunc(opts.budgetChars) - reserved);
  const budget = applyCharBudget(merged, room);
  if (!budget.droppedTurns) return budget.pieces;
  // 收缩必须留痕：不说的话，模型会以为自己看到的是完整上文，进而把「没提过」当成「没有这回事」。
  // 这条留痕本身不再参与预算核算（它是几句固定说明）：为一句解释再多砍一轮，等于用省略来承认省略。
  const note = `【上下文长度受限】整轮请求限 ${opts.budgetChars} 字（本入口固定提示词已占 ${reserved} 字），为满足预算，本会话最早的 ${budget.droppedTurns} 轮未发送（不是不存在）。回答涉及「之前说过什么」时，如摘要里没有就直说看不到，不要推断。`;
  return [{ role: "system", content: note }, ...budget.pieces];
}

/**
 * 把判定结果收成展示件（服务端在 done 事件与 JSON 响应里发的是这一份）。
 * 参数写成结构而不是 import intent-core 的 Intent：chat-core 是更底下的一层，
 * 反向依赖判定层就会形成循环（intent-core 本来就 import 这里）。
 */
export function intentBadgeOf(
  i: {
    scene: string; label: string; hits: string[]; alternates?: string[]; symbol: string | null;
    symbolSource: string; inherited: boolean; followUp: boolean;
  },
  opts: { skipped?: string[]; prefetchChars?: number } = {}
): IntentBadge {
  return {
    scene: i.scene,
    label: i.label,
    hits: [...(i.hits ?? [])],
    ...(i.alternates?.length ? { alternates: [...i.alternates] } : {}),
    symbol: i.symbol,
    symbolSource: i.symbolSource,
    inherited: i.inherited,
    followUp: i.followUp,
    skipped: [...(opts.skipped ?? [])],
    ...(opts.prefetchChars ? { prefetchChars: opts.prefetchChars } : {}),
  };
}

// ---------- 快照注入标记 ----------

/**
 * 客户端把实时行情贴在提问后面的标记。
 * 为什么要写进字符串而不是只在字段里传：快照必须贴着用户消息才有遵循度（见上），
 * 而服务端做意图识别时要把「用户自己打的那句话」摘出来，没有标记就只能猜哪段是行情。
 */
export const SNAPSHOT_MARK = "<<系统注入·实时行情快照>>";

export function markSnapshot(snapshot: string): string {
  return `${SNAPSHOT_MARK}\n${(snapshot ?? "").trim()}`;
}

/** 从一条用户消息里拆出「用户原话」与注入的快照（服务端意图识别用；没有标记时整条都是原话） */
export function splitSnapshotMessage(content: string): { question: string; snapshot: string } {
  const text = content ?? "";
  const i = text.indexOf(SNAPSHOT_MARK);
  if (i === -1) return { question: text.trim(), snapshot: "" };
  return { question: text.slice(0, i).trim(), snapshot: text.slice(i + SNAPSHOT_MARK.length).trim() };
}

// ---------- 场景件注入（两个聊天端点共用一套插入位置） ----------

/** 消息件的最小形状：chat-core 与 chat-stream-core 都按这个形状读写，不引第三方类型 */
export interface ContextMsg {
  role: string;
  content: string;
}

/**
 * 把「场景提示词 + 本轮自动取到的真实数据」插进要发给模型的消息数组。
 *
 * 位置是这条函数的全部意义，所以两个端点必须共用它：
 *  - 场景提示词放在最前面（紧跟入口自己的那份 system），它管整轮口径，不该被后面的历史淹掉；
 *  - 数据块放在最后一条用户提问**之前**。放在数组末尾等于「先看到回答任务、再补数据」，
 *    某些上游会把尾巴上的 system 件当成无关说明忽略掉，那这笔预取就白做了。
 * 空内容一律不插：一个空 system 件会把轻量模型的整轮口径带偏（这条在 use-chat 里已经吃过一次）。
 * mk 由调用方给：两个端点的消息类型不同（一个带 tool_calls），这里不替它们造壳。
 */
export function injectSceneContext<T extends ContextMsg>(
  messages: T[],
  turn: { prompt?: string; block?: string },
  mk: (role: "system", content: string) => T,
): T[] {
  const prompt = (turn.prompt ?? "").trim();
  const block = (turn.block ?? "").trim();
  const list = messages ?? [];
  if (!prompt && !block) return list;
  let at = list.length;          // 最后一条用户提问的下标（没有用户提问时插到末尾）
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") { at = i; break; }
  }
  let sysEnd = 0;                // 开头那串 system 件的末尾：场景提示词接在它们后面
  while (sysEnd < at && list[sysEnd]?.role === "system") sysEnd++;
  const out = [...list];
  // 先插靠后的那个，前面的下标才不会因为插入而错位
  if (block) out.splice(at, 0, mk("system", block));
  if (prompt) out.splice(sysEnd, 0, mk("system", prompt));
  return out;
}

// ---------- 工具调用历史 → 上文 ----------

/** 状态词的唯一出处：发给模型的取数记录行（renderStepsLine）与 P7-⑧③ 的上下文面板都用它，两处不会各写一套说法 */
export const STEP_STATUS_WORD: Record<StepInfo["status"], string> = {
  ok: "已取到", running: "未结束", missing: "缺数据", error: "取数失败", stale: "数据滞后",
};

/** 最多列几步：追问时模型需要知道上文取过什么，不需要一份完整调用日志 */
const STEPS_LINE_MAX = 8;

/**
 * 把一轮的取数步骤并成一行，拼在当时的助手回答后面发给模型。
 * 两个措辞是硬要求：标明「当时的记录」，并且缺数据要说缺 ——
 * 不然模型会拿上一轮的快照当今天行情引用，或者把 missing 那步当成取到了 0。
 */
export function renderStepsLine(steps?: StepInfo[]): string {
  const done = (steps ?? []).filter((s) => s && s.status !== "running");
  if (!done.length) return "";
  const parts = done.slice(0, STEPS_LINE_MAX).map((s) => `${s.tool ?? s.label}=${STEP_STATUS_WORD[s.status] ?? s.status}`);
  const more = done.length > STEPS_LINE_MAX ? `；另有 ${done.length - STEPS_LINE_MAX} 步未列出` : "";
  return `\n\n〔上一轮系统取数记录（当时的真实调用，非实时，不得当今日行情引用）：${parts.join("、")}${more}〕`;
}

// ---------- 字数预算 ----------

export interface BudgetResult {
  pieces: PromptPiece[];
  /** 因预算被收缩掉的轮数（0 = 没收缩） */
  droppedTurns: number;
  /** 收缩后的总字数 */
  chars: number;
}

function pieceChars(pieces: PromptPiece[]): number {
  return pieces.reduce((n, p) => n + p.content.length, 0);
}

/**
 * 字数预算：从最早一轮开始整轮收缩，至少保留最后一轮。
 * 规则说清楚三件事：
 *  - system 件（压缩摘要、快照说明、收缩留痕）永不丢 —— 丢了就等于「压缩白做 + 模型不知道少发了」；
 *  - 按轮丢而不是按条丢：只丢用户消息会留下一条没有提问的回答，模型会当成用户在继续说别人的话；
 *  - 最后一轮一定保留，哪怕它自己就超预算（那说明该收缩的是单条长度，不是砍掉用户当前问题）。
 */
export function applyCharBudget(pieces: PromptPiece[], budgetChars: number): BudgetResult {
  const budget = Math.max(1, Math.trunc(budgetChars) || 1);
  const head: PromptPiece[] = [];
  const dialog: PromptPiece[] = [];
  for (const p of pieces) (p.role === "system" ? head : dialog).push(p);

  // 对话件按「用户消息起头」分组 = 一轮
  const turns: PromptPiece[][] = [];
  for (const p of dialog) {
    if (p.role === "user" || !turns.length) turns.push([p]);
    else turns[turns.length - 1].push(p);
  }
  let droppedTurns = 0;
  const flat = () => [...head, ...turns.flat()];
  while (turns.length > 1 && pieceChars(flat()) > budget) { turns.shift(); droppedTurns++; }
  const out = flat();
  return { pieces: out, droppedTurns, chars: pieceChars(out) };
}

/**
 * 服务端兜底裁窗：只从最早的「用户 / 助手」消息开始丢，system 件（压缩摘要、快照说明）一律保留。
 * 为什么不是 slice(-n)：那样先被挤掉的正是开头那条摘要，等于把上面的上下文压缩白做一遍。
 *
 * 裁完还要把开头的非 user 件再丢一轮（和 splitWindow 同一口径）：服务端按「轮数 ×2」兜底时，
 * 条数对齐只是近似——本轮新提问是多出来的那一条，边界会正好落在某一问与某一答之间，
 * 于是窗口可能以助手消息起头，模型会把上文当成自己在说话、接着往下编。
 * 生产实测里这一条是真出现过的：40 轮 + contextWindow=30 打 /api/ai/chat，
 * 上游收到的第一条对话消息是「第11答」（助手）。
 * 只剩一条时不再丢：宁可窗口开头是助手，也不能把上文清空（清空等于这轮没有上下文）。
 */
export function trimDialog<T extends { role: string }>(messages: T[], maxDialogMessages: number): T[] {
  const keep = Math.max(1, Math.floor(maxDialogMessages));
  const dialogIdx: number[] = [];
  messages.forEach((m, i) => { if (m.role !== "system") dialogIdx.push(i); });
  let kept = dialogIdx.slice(Math.max(0, dialogIdx.length - keep));
  const firstUser = kept.findIndex((i) => messages[i].role === "user");
  // 一个 user 都没有（整窗都是助手/tool 回执）时不动：宁可开头别扭，也不能把上文清空
  if (firstUser > 0) kept = kept.slice(firstUser);
  const keepSet = new Set(kept);
  return messages.filter((m, i) => m.role === "system" || keepSet.has(i));
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
  | { type: "done"; data?: { fullText?: string; intent?: IntentBadge; debug?: { modelMs?: number; transport?: string } } }
  | { type: "error"; data: { message: string } };

/** 把多条警告拼成一句：每段先去掉结尾的「。」/「；」，再用「；」连接，避免出现「。；」这种断句 */
export function joinWarnings(parts: (string | undefined | null)[]): string {
  return parts
    .map((p) => (p ?? "").replace(/[。；;]+$/, "").trim())
    .filter(Boolean)
    .join("；");
}

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
      return { ...msg, warning: joinWarnings([msg.warning, ev.data?.text]) };
    case "done":
      return {
        ...msg,
        streaming: false,
        ...(ev.data?.fullText ? { content: ev.data.fullText } : {}),
        // 场景徽章只在服务端真的回了的时候记；没有就不留空壳，否则界面会画一个「按通用问答处理」的假徽章
        ...(ev.data?.intent ? { intent: ev.data.intent } : {}),
        // P8-⑤：结论留底同理——done 没带 debug 就不留空壳（旧服务端/无 debug 轮次画「未留底」）
        ...(ev.data?.debug ? { debug: ev.data.debug } : {}),
      };
    case "error":
      return {
        ...msg,
        streaming: false,
        content: msg.content || `请求出错：${ev.data?.message ?? "未知错误"}`,
        warning: joinWarnings([msg.warning, ev.data?.message ? `已中断：${ev.data.message}` : ""]) || msg.warning,
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

/**
 * R13（用户拍板）：一条对话整 7 天没再动过就自动清出存档——「不然太长了挤死了」。
 * 与 MAX_SESSIONS（按条数挤最旧）互补：条数闸管「别太多」，这管「别躺太久」。
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 去掉超过 TTL 没动过的会话（判定看「最后活跃」updatedAt，不看创建日——
 * 一周前开、今天还在用的对话不该被删）。
 * updatedAt 坏了退回 createdAt；两个都读不出就留着：判不了不删，错删比漏删伤害大。
 * 全被清时留一条新空会话（与 removeSession 同一条不变量：会话列表永不空）。
 */
export function pruneStaleSessions(sessions: ChatSession[], now: number = Date.now(), ttlMs: number = SESSION_TTL_MS): ChatSession[] {
  const kept = (sessions ?? []).filter((s) => {
    const touched = Number.isFinite(s?.updatedAt) ? s.updatedAt : Number.isFinite(s?.createdAt) ? s.createdAt : null;
    return touched === null || now - touched <= ttlMs;
  });
  return kept.length ? kept : [emptySession(now)];
}
