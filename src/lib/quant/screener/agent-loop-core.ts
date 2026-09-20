// P6-D Agent 自主研究循环的控制内核（纯函数：不调模型、不取数、不写库）。
//
// 为什么循环控制放在纯内核里：任务书 §十七 要求「必须受控（max_steps / max_tool_calls / timeout /
// 重复调用检测 / 相同参数缓存 / 失败重试上限）」，§十八 要求调用日志能回答「刚才调用了什么、为什么、
// 结果如何、有没有 fallback」，§十九 要求答案能回到血缘（Answer→Evidence→Tool→Data Source）。
// 这三条都是**判据**，判据只有能被单测钉住才算存在；放在服务层就只能靠人肉看页面。
//
// 协议口径（必须写清，别以为服务商支持 function-calling）：
// 本项目的 AI 凭据只在客户端，/api/ai/proxy 只做 messages→content 转发，**没有原生 tools 通道**
// （见 src/lib/desk/ai.ts 与 src/app/api/ai/proxy/route.ts）。因此 Agent 的「工具调用」是
// 模型在回复文本里给出的结构化 JSON（复用 P6-C 的 extractJsonObject 解析），由服务端执行器真的去取数，
// 再把观测结果喂回下一轮。模型说调用过什么不算数 —— 只有本内核记录的 log 算数。
//
// 与 P6-C 的分工：台账行形状、编号（F/S/H 前缀）、无出处数字检测、历史当当前检测、JSON 抽取，
// 全部复用 research-core，不在这里再造第二套（同 §二十六「不要重新造一套相同工具」的口径）。
import {
  AI_FORBIDDEN, assignEvidenceIds, evidenceLedgerText, extractJsonObject, findHistoricalAsCurrentClaims,
  findUnsourcedNumbers, type EvidenceLine, type ServerLayer, type UnsourcedNumber,
} from "./research-core.ts";
import { DATA_STATUS_TEXT, isDataStatus, type DataStatus, type ObservationKind } from "./datastatus-core.ts";
import {
  agentToolCatalogText, canonicalCallKey, enabledTools, fallbackTools, findTool, shortlistTools, TOOL_DEFS,
  unsupportedToolReason, validateToolParams, type ToolDefinition,
} from "./agent-tools-core.ts";

export const AGENT_PROTOCOL_VERSION = "p6d.agent.v1";

// ---------- §十七 预算：默认值 + 硬上限（「必须有明确上限」，不接受 unlimited） ----------

export interface AgentBudget {
  max_steps: number;
  max_tool_calls: number;
  max_retries_per_tool: number;
  max_total_ms: number;
  max_evidence_lines: number;
}

/** 任务书 §十七 推荐值：max_tool_calls=12、max_retries_per_tool=2；步数与总时长按现有引擎耗时定的 */
export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  max_steps: 6,
  max_tool_calls: 12,
  max_retries_per_tool: 2,
  max_total_ms: 120_000,
  max_evidence_lines: 40,
};

/** 硬上限：调用方（页面/URL 参数）只能在下限与这里之间收紧，不能被改成「跑无限次」 */
export const BUDGET_HARD_CAPS: AgentBudget = {
  max_steps: 12, max_tool_calls: 24, max_retries_per_tool: 3, max_total_ms: 300_000, max_evidence_lines: 60,
};

const BUDGET_KEYS = Object.keys(DEFAULT_AGENT_BUDGET) as (keyof AgentBudget)[];
const BUDGET_LABEL: Record<keyof AgentBudget, string> = {
  max_steps: "步数", max_tool_calls: "工具调用数", max_retries_per_tool: "同一工具重试次数",
  max_total_ms: "总耗时(ms)", max_evidence_lines: "台账行数",
};

/** 预算入参归一：非法值回落默认并说明，超上限的钳到上限并说明 —— 静默接受「0/无限」等于没有预算 */
export function normalizeBudget(raw: unknown): { budget: AgentBudget; notes: string[] } {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const budget = { ...DEFAULT_AGENT_BUDGET };
  const notes: string[] = [];
  for (const k of BUDGET_KEYS) {
    const v = src[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!isFinite(n) || !Number.isInteger(n) || n <= 0) {
      notes.push(`${BUDGET_LABEL[k]}「${String(v)}」不是正整数，已回落到默认 ${DEFAULT_AGENT_BUDGET[k]}：预算不接受 0、负数或无限`);
      continue;
    }
    if (n > BUDGET_HARD_CAPS[k]) {
      notes.push(`${BUDGET_LABEL[k]} ${n} 超过硬上限 ${BUDGET_HARD_CAPS[k]}，已按上限执行（自主循环必须有明确上限，§十七）`);
      budget[k] = BUDGET_HARD_CAPS[k];
      continue;
    }
    budget[k] = n;
  }
  return { budget, notes };
}

// ---------- §十六 碰壁分类：六种判断各归各的措辞，不许互相冒充 ----------

export const AGENT_FAILURE_KINDS = ["bad_params", "no_data", "source_failed", "not_supported", "timeout", "budget"] as const;
export type AgentFailureKind = (typeof AGENT_FAILURE_KINDS)[number];

export const AGENT_STOP_REASONS = [
  "answered", "max_steps", "max_tool_calls", "max_total_ms", "retry_limit", "no_progress", "invalid_directive", "not_run",
] as const;
export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

export const FAILURE_TEXT: Record<AgentFailureKind, string> = {
  bad_params: "参数错误（该工具没被调用；请按 inputSchema 改参数再问一次）",
  no_data: "数据不存在（请求成功但本次没有内容，不等于 0，也不等于取数失败）",
  source_failed: "数据源失败（本次没拿到，不显示为 0、不沿用上一次结果）",
  not_supported: "capability 不支持（这条路本身不存在或不由 Agent 走，换工具或如实说缺）",
  timeout: "超时（超过本工具的超时上限，按取数失败处理，不猜结果）",
  budget: "预算用尽（受控停止；剩下的是未验证部分，必须写进缺口而不是省略）",
};

/**
 * 停止原因的页面措辞（与 FAILURE_TEXT 同一立场：文案只有一份，页面不许自己编）。
 * 特别注意 timeout 不在这里：它是**单次调用**的碰壁分类（FAILURE_TEXT.timeout），
 * 整轮因时长停下来的原因是 max_total_ms —— 两者混用会让读者以为「那次请求超时所以停了」。
 */
export const AGENT_STOP_REASON_TEXT: Record<AgentStopReason, string> = {
  answered: "模型给出结论并收尾（结论可不可用看 answer_status，不看这条）",
  max_steps: "步数上限到了：受控停止，未验证部分写进缺口",
  max_tool_calls: "工具调用数上限到了：受控停止，未验证部分写进缺口",
  max_total_ms: "整次运行的总时长上限到了：停止而不是继续挂着请求（这 ≠ 某一次调用超时）",
  retry_limit: "同一工具的重试上限到了：该换兜底工具或如实说缺，不要在同一条死路上打转",
  no_progress: "连续多次调用没有产生新读数：判定为原地打转，受控停止",
  invalid_directive: "模型回复不在协议内（既没有 tool 也没有 final）：本层不替它猜要做什么",
  not_run: "这次运行没有真正开始（没有建账或参数就没过）：库里不会有它的调用行",
};

export const OBS_TO_FAILURE: Record<ObservationKind, AgentFailureKind | null> = {
  value: null, real_zero: null, not_covered: "not_supported", no_data: "no_data", request_failed: "source_failed",
};

export interface DeadEnd {
  failure: AgentFailureKind | null;
  reason: string;
  /** 同参数重试有没有意义：数据源失败可以换一次；不支持/参数错要改做法 */
  retryable: boolean;
  has_fallback: boolean;
  fallback_tools: string[];
  next_action: "retry_same_tool" | "try_fallback" | "fix_params" | "answer_with_gap" | "stop";
  /** 对用户怎么说（§十六 最后一条：全都不行时必须明确「当前缺少 XXX 数据，因此无法验证 YYY」） */
  user_note: string;
}

function fallbackNames(tool: string | null | undefined): string[] {
  if (!tool) return [];
  return fallbackTools(tool).map((t) => t.name);
}

/** 一次碰壁该怎么判：入参是「观测 + 错误原文 + 是否超时 + 还剩多少预算」，输出是分类与下一步 */
export function classifyDeadEnd(input: {
  tool?: string | null;
  kind?: ObservationKind | null;
  error?: string | null;
  timed_out?: boolean;
  params_invalid?: string[] | null;
  not_supported?: string | null;
  budget_left?: { steps: number; tool_calls: number; ms: number; retries_left: number } | null;
  evidence_ok?: boolean;
}): DeadEnd {
  const tool = input.tool ?? null;
  const fb = fallbackNames(tool);
  const left = input.budget_left ?? null;
  const base: DeadEnd = {
    failure: null, reason: "", retryable: false, has_fallback: fb.length > 0, fallback_tools: fb,
    next_action: "answer_with_gap", user_note: "",
  };
  if (input.params_invalid?.length) {
    return { ...base, failure: "bad_params", reason: input.params_invalid.join("；"), next_action: "fix_params", retryable: true, user_note: "参数不合规，本次未调用该工具" };
  }
  if (input.not_supported) {
    return { ...base, failure: "not_supported", reason: input.not_supported, next_action: fb.length ? "try_fallback" : "answer_with_gap", user_note: gapNote(tool, input.not_supported, fb) };
  }
  if (input.timed_out) {
    return { ...base, failure: "timeout", reason: "本次调用超过该工具的超时上限，按取数失败处理（不猜值、不显示为 0）", retryable: !!left && left.retries_left > 0, next_action: (left && left.retries_left > 0) ? "retry_same_tool" : (fb.length ? "try_fallback" : "answer_with_gap"), user_note: gapNote(tool, "取数超时", fb) };
  }
  const kind = input.kind ?? null;
  const failure = kind ? OBS_TO_FAILURE[kind] : null;
  if (!failure) {
    return { ...base, reason: (input.error ?? "").trim(), next_action: "stop", user_note: "" };
  }
  const reason = (input.error ?? "").trim() || FAILURE_TEXT[failure];
  const canRetry = failure === "source_failed" && !!left && left.retries_left > 0;
  return {
    ...base, failure, reason,
    retryable: canRetry,
    next_action: canRetry ? "retry_same_tool" : (fb.length ? "try_fallback" : "answer_with_gap"),
    user_note: gapNote(tool, reason, fb),
  };
}

/** 「缺少 XXX 数据，因此无法验证 YYY」的标准句式（没有兜底源时才允许说「无法验证」） */
function gapNote(tool: string | null, why: string, fb: string[]): string {
  const t = tool ?? "该能力";
  if (fb.length) return `${t} 本次未取得数据（${why}），还有兜底工具：${fb.join("、")}；在改用兜底之前不能说「无法验证」。`;
  return `当前缺少 ${t} 的数据（${why}），且登记表里没有可用的兜底源，因此与之相关的结论无法验证——按缺失处理，不用别的数字顶替。`;
}

// ---------- §十八 工具调用日志：字段就按任务书列的那 11 个来（外加本层要的口径） ----------

export const LOG_STATUSES = [
  "ok", "empty", "failed", "timeout", "not_supported", "bad_params", "budget", "cached", "rejected", "invalid_directive",
] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

/**
 * 一次观测 → §十八 的 output_status。放在这里是因为 LOG_STATUSES 与 ObservationKind 的口径都由本层持有，
 * 执行器（agent-tools.ts）与落库层（agent-run.ts）只能引用这一份，避免两处各写一套映射把
 * 「超时」和「请求成功但没内容」压成同一个 failed。
 */
export function logStatusOf(kind: ObservationKind | null, timed_out = false): LogStatus {
  if (timed_out) return "timeout";
  if (kind === "value" || kind === "real_zero") return "ok";
  if (kind === "no_data") return "empty";
  if (kind === "request_failed") return "failed";
  if (kind === "not_covered") return "not_supported";
  return "failed";
}

/**
 * §十八 十种 output_status 的页面措辞（唯一一份，Agent 页只引用这里）。
 * 三条不许合并的口径写死在文本里：empty（请求成功但本次没有内容）≠ failed（没拿到）≠ not_supported（这条路不存在）；
 * cached 是「拿到了、但这次没打上游」，不是失败也不是新读数；budget/timeout 分别是整轮预算与单次超时。
 */
export const LOG_STATUS_TEXT: Record<LogStatus, string> = {
  ok: "取到了：这一步真的执行了并拿到读数",
  empty: "请求成功但本次没有内容：真实为空，不是 0，也不是取数失败",
  failed: "取数失败：本次没拿到，不显示为 0、不沿用上一次结果",
  timeout: "这一次调用超时：按取数失败处理，不猜结果",
  not_supported: "该能力不支持由 Agent 走（登记表里写明了原因）",
  bad_params: "参数不合规：该工具没有被调用",
  budget: "被预算挡下：本次没有执行，原因写在 error 原文里",
  cached: "命中同参数缓存：拿到了数，但本次没有打上游（复用原始那条台账）",
  rejected: "被拒绝：见 error（例如收尾时已有成立结论，坏回复不覆盖）",
  invalid_directive: "模型回复不在协议内：没有执行任何取数",
};

/**
 * 观测口径（+ 未覆盖）的页面措辞。与 output_status 正交：一个是「这一步算不算数」，一个是「取到的东西是什么」。
 * 三条口径写在这里而不是页面组件里：① no_data 与 request_failed 分属两种状态（空 ≠ 失败，§六）；
 * ② 0 是一个值（real_zero），不是一句「没有数据」，措辞里必须能看出涨跌；
 * ③ 只有五个互斥取值（ObservationKind），所以这里刻意不用「有读数：…」那种带冒号的解释句式——
 *    解释性的长句由 LOG_STATUS_TEXT 承担，避免同一件事在两张表里各说一遍、说法还不一致。
 */
export const OBS_KIND_TEXT: Record<ObservationKind, string> = {
  value: "有读数",
  real_zero: "真实算出的 0（不是没取到）",
  no_data: "本次没有这类行：请求是成功的，空就是空",
  request_failed: "上游请求失败：按取数失败处理，不写成 0",
  not_covered: "本系统没有覆盖这个口径：这条路不存在，不是今天没数据",
};

export interface ToolCallLogEntry {
  run_id: string;
  step: number;
  tool: string;
  /** 模型请求的入参原文（校验前的），这样「为什么失败」可核 */
  input: Record<string, unknown>;
  /** §十八 的 output_status：这一次到底成没成（成功/空/失败/超时/不支持/参数错/预算/命中缓存） */
  output_status: LogStatus;
  /** 观测口径（成功时才有）；与 output_status 正交，避免把「空」和「失败」压成一个值 */
  kind: ObservationKind | null;
  latency_ms: number | null;
  source: string | null;
  as_of: string | null;
  data_status: DataStatus | null;
  error: string | null;
  /** 有兜底时：null=本次就是主源；字符串=因为哪个工具失败才换到本工具（Tool A failed → Tool B success） */
  fallback_of: string | null;
  /** 本工具第几次尝试（含首次）：重试上限的计数就在这里 */
  attempt: number;
  /** 同参数缓存键（§三十二 的重复调用检测靠它） */
  call_key: string;
  /** 命中缓存时指向已有台账行 id */
  cached_from: string | null;
  /** 这条读数进了哪个台账行（成功才有） */
  evidence_id: string | null;
  /** 为什么调用（模型给出的理由，原文；空=没给） */
  thought: string;
  /** 主源失败降级到本工具时的来源工具（与 degraded_from 同一语义，按登记表口径） */
  degraded_from: string | null;
  /** 服务端北京时间墙钟原文（由调用方传 shanghaiStamp()，本层不调时钟以免变成不可测） */
  timestamp: string;
}

/** §十八 的字段清单：漏一个都能被这条测试抓出来 */
export const LOG_FIELDS = [
  "run_id", "step", "tool", "input", "output_status", "latency_ms", "source", "as_of", "error", "fallback_of", "timestamp",
] as const;

// ---------- 台账（§十九 的中间层：Answer→Evidence→Tool→Data Source） ----------

export interface AgentEvidenceRecord {
  /** 台账行本体（复用 P6-C 形状，页面与复校验同一份） */
  line: EvidenceLine;
  tool: string;
  executor: string | null;
  call_key: string;
  step: number;
  run_id: string;
  /** 可回溯的业务主键（§十九 举例的 theme_id / finding_id / event_id / factor_key / trade_date+sample+horizon） */
  refs: string[];
}

const LAYER_BY_STATUS: Record<DataStatus, ServerLayer | null> = {
  REAL: "FACTS", DEGRADED: "FACTS",
  DERIVED: "SIGNALS", AI_INTERPRETATION: "SIGNALS", AI_HYPOTHESIS: "SIGNALS",
  HISTORICAL: "HISTORICAL_EVIDENCE", SNAPSHOT: "HISTORICAL_EVIDENCE",
  MISSING: null,
};

/** MISSING 不进台账：它进缺口清单。台账里出现「没有数据」的行会把缺口伪装成证据。 */
export function evidenceLayerOf(status: DataStatus): ServerLayer | null {
  return LAYER_BY_STATUS[status];
}

// P7-②：period_start/period_end 是「这批历史样本来自哪一段」的口径。§十九 的必需三项仍是 trade_date/sample/horizon
//（probabilityCheck 只查那三项），这里多收两项只为让事后能重建窗口——同一台机器 5 分钟内样本数变化不再无从解释。
const REF_KEYS = ["theme_id", "finding_id", "event_id", "factor_key", "trade_date", "sample", "horizon", "period_start", "period_end", "board_code", "symbol", "report_key", "id"];

/** 从观测原文里抽业务主键（只抽白名单字段，不整包塞进血缘，否则台账会胀成不可读的一坨） */
export function extractRefs(payload: unknown, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (out.length >= max || node == null || depth > 2) return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 5)) walk(x, depth + 1); return; }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (REF_KEYS.includes(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) {
        const item = `${k}=${String(v)}`;
        if (!seen.has(item)) { seen.add(item); out.push(item); }
        continue;
      }
      // 白名单键之外还要往下一层：真实载荷普遍是 {items:[{finding_id}]}，只扫顶层等于抽不到主键（§十九 点不回业务行）
      walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  return out;
}

// ---------- 循环状态机 ----------

export interface AgentState {
  run_id: string;
  question: string;
  budget: AgentBudget;
  started_at: string;
  /** 起算毫秒（由调用方传：内核不读时钟，否则单测不可重现） */
  started_ms: number;
  step: number;
  tool_calls: number;
  attempts_by_tool: Record<string, number>;
  /** call_key → 台账行 id：相同参数的第二次请求直接复用（§三十二） */
  cache: Record<string, string>;
  log: ToolCallLogEntry[];
  evidence: AgentEvidenceRecord[];
  /** 取数失败/空/不支持的原文清单：最终必须进 UNKNOWN（不能悄悄丢掉） */
  missing: string[];
  consecutive_no_progress: number;
  stop: { reason: AgentStopReason; detail: string } | null;
}

export function startRun(input: { run_id: string; question: string; budget?: unknown; started_at: string; started_ms: number }): { state: AgentState; notes: string[] } {
  const { budget, notes } = normalizeBudget(input.budget);
  const question = String(input.question ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!question) notes.push("没有研究问题：自主循环没有目标，请先补问题（本层不会替模型编一个「当前市场如何」）");
  return {
    state: {
      run_id: String(input.run_id ?? ""), question, budget, started_at: input.started_at, started_ms: input.started_ms,
      step: 0, tool_calls: 0, attempts_by_tool: {}, cache: {}, log: [], evidence: [], missing: [],
      consecutive_no_progress: 0, stop: null,
    },
    notes,
  };
}

export interface BudgetLeft { steps: number; tool_calls: number; ms: number; retries_left: number; evidence_lines: number }

export function budgetRemaining(state: AgentState, now_ms: number, tool?: string): BudgetLeft {
  const retries = tool ? Math.max(0, 1 + state.budget.max_retries_per_tool - (state.attempts_by_tool[tool] ?? 0)) : state.budget.max_retries_per_tool;
  return {
    steps: Math.max(0, state.budget.max_steps - state.step),
    tool_calls: Math.max(0, state.budget.max_tool_calls - state.tool_calls),
    ms: Math.max(0, state.budget.max_total_ms - (now_ms - state.started_ms)),
    retries_left: retries,
    evidence_lines: Math.max(0, state.budget.max_evidence_lines - state.evidence.length),
  };
}

export interface Admission {
  allowed: boolean;
  /** 允许执行时才是这一条 */
  value: Record<string, string | number | boolean | string[]>;
  failure: AgentFailureKind | null;
  reason: string;
  /** 相同参数已取过：复用台账行，不再打上游 */
  cached_from: string | null;
  call_key: string;
  tool: string | null;
  errors: string[];
}

/** 能不能调这一条：注册表 → 参数 → 重复检测 → 预算，顺序即口径（前面的判定不该被后面的绕过） */
export function admitCall(state: AgentState, toolName: string, rawParams: unknown, now_ms: number): Admission {
  const none: Admission = { allowed: false, value: {}, failure: null, reason: "", cached_from: null, call_key: "", tool: null, errors: [] };
  const tool = findTool(toolName);
  if (!tool) {
    const reason = unsupportedToolReason(toolName);
    return { ...none, failure: "not_supported", reason, errors: [reason], tool: String(toolName ?? "") };
  }
  if (!tool.enabled) {
    const reason = unsupportedToolReason(tool.name);
    return { ...none, failure: "not_supported", reason, errors: [reason], tool: tool.name };
  }
  if (state.stop) {
    return { ...none, failure: "budget", reason: `本次运行已停止（${state.stop.reason}：${state.stop.detail}），不再打上游`, errors: [], tool: tool.name };
  }
  const check = validateToolParams(tool.name, rawParams);
  if (!check.ok) {
    return { ...none, failure: "bad_params", reason: check.errors.join("；"), errors: check.errors, tool: tool.name };
  }
  const key = canonicalCallKey(tool.name, check.value);
  const cached = state.cache[key];
  if (cached) {
    return { ...none, reason: `相同参数的 ${tool.name} 本次运行已取过，复用台账行 ${cached}（§三十二 不重复打上游）`, cached_from: cached, call_key: key, tool: tool.name };
  }
  const left = budgetRemaining(state, now_ms, tool.name);
  if (left.steps <= 0) return { ...none, failure: "budget", reason: `步数预算已用满（${state.budget.max_steps} 步）。停止并输出已成立部分，未验证的写进缺口`, call_key: key, tool: tool.name, errors: [] };
  if (left.tool_calls <= 0) return { ...none, failure: "budget", reason: `工具调用预算已用满（${state.budget.max_tool_calls} 次，§十七）。停止并输出已成立部分`, call_key: key, tool: tool.name, errors: [] };
  if (left.ms <= 0) return { ...none, failure: "budget", reason: `本次运行的总时长预算 ${state.budget.max_total_ms}ms 已用尽，停止而不是继续挂着请求（整轮时长，不是某一次调用超时）`, call_key: key, tool: tool.name, errors: [] };
  if (left.evidence_lines <= 0) return { ...none, failure: "budget", reason: `台账行数已达上限 ${state.budget.max_evidence_lines}，先收敛已有读数而不是继续扩表`, call_key: key, tool: tool.name, errors: [] };
  if ((state.attempts_by_tool[tool.name] ?? 0) >= 1 + state.budget.max_retries_per_tool) {
    const fb = fallbackNames(tool.name);
    return {
      ...none, failure: "budget",
      reason: `${tool.name} 已尝试 ${state.attempts_by_tool[tool.name]} 次，达到重试上限（max_retries_per_tool=${state.budget.max_retries_per_tool}）。` +
        (fb.length ? `请改走兜底：${fb.join("、")}` : "该能力没有兜底源，请把相关结论写进缺口"),
      call_key: key, tool: tool.name, errors: [],
    };
  }
  return { allowed: true, value: check.value, failure: null, reason: "", cached_from: null, call_key: key, tool: tool.name, errors: [] };
}

export interface RecordInput {
  tool: string;
  input: Record<string, unknown>;
  output_status: LogStatus;
  kind?: ObservationKind | null;
  latency_ms?: number | null;
  source?: string | null;
  as_of?: string | null;
  data_status?: DataStatus | null;
  error?: string | null;
  fallback_of?: string | null;
  call_key: string;
  cached_from?: string | null;
  thought?: string;
  degraded_from?: string | null;
  timestamp: string;
  /** 成功读数：本层负责编台账行（id 由 assignEvidenceIds 统一分配） */
  payload?: unknown;
  summary?: string;
}

/**
 * 记一条调用并把成功读数并进台账。返回新状态（不改原对象）+ 这一条的日志原文。
 * 「模型说它调用过」不算调用：只有这里进 log 的才算。
 */
export function recordCall(state: AgentState, raw: RecordInput): { state: AgentState; entry: ToolCallLogEntry; evidence_id: string | null } {
  const tool = findTool(raw.tool);
  const step = state.step + 1;
  const attempt = (state.attempts_by_tool[raw.tool] ?? 0) + (raw.output_status === "cached" ? 0 : 1);
  const entry: ToolCallLogEntry = {
    run_id: state.run_id, step, tool: raw.tool, input: raw.input ?? {},
    output_status: raw.output_status, kind: raw.kind ?? null,
    latency_ms: raw.latency_ms ?? null, source: raw.source ?? tool?.source ?? null,
    as_of: raw.as_of ?? null, data_status: raw.data_status ?? null,
    error: raw.error ?? null, fallback_of: raw.fallback_of ?? null, attempt,
    call_key: raw.call_key, cached_from: raw.cached_from ?? null, evidence_id: null,
    thought: String(raw.thought ?? "").trim(), degraded_from: raw.degraded_from ?? null,
    timestamp: raw.timestamp,
  };

  const evidence = [...state.evidence];
  const cache = { ...state.cache };
  let evidenceId: string | null = null;
  const progressed = raw.output_status === "ok";
  const missing = [...state.missing];

  if (raw.output_status === "cached") {
    evidenceId = raw.cached_from ?? null;
    entry.evidence_id = evidenceId;
  } else if (progressed) {
    const status = raw.data_status ?? tool?.data_status ?? "REAL";
    const layer = evidenceLayerOf(status);
    const summary = String(raw.summary ?? "").replace(/\s+/g, " ").trim();
    if (!layer) {
      // MISSING 不可能「成功」：出现这种组合说明口径错了，直接进缺口而不是编一行台账
      missing.push(`${raw.tool}：返回被标成成功但分层是 ${status}（${DATA_STATUS_TEXT[status]}），本层不把它写成证据`);
    } else if (!summary) {
      missing.push(`${raw.tool}：本次成功但没有可引用的一行摘要，无法进台账（不编造句子凑数）`);
    } else if (evidence.length >= state.budget.max_evidence_lines) {
      missing.push(`${raw.tool}：台账已达 ${state.budget.max_evidence_lines} 行上限，这条读数没有进表（不扩表以免提示词胀到不可读）`);
    } else {
      const lines = assignEvidenceIds([...evidence.map((e) => e.line), {
        layer, text: summary, capability: raw.tool, source: entry.source ?? "未记录",
        as_of: entry.as_of ?? "未记录", data_status: status,
      }]);
      const created = lines[lines.length - 1];
      evidence.push({
        line: created, tool: raw.tool, executor: tool?.executor ?? null, call_key: raw.call_key,
        step, run_id: state.run_id, refs: extractRefs(raw.payload),
      });
      evidenceId = created.id;
      entry.evidence_id = created.id;
      if (raw.call_key) cache[raw.call_key] = created.id;
    }
  } else {
    const note = raw.error ?? `output_status=${raw.output_status}`;
    if (raw.output_status !== "rejected" && raw.output_status !== "invalid_directive") {
      missing.push(`${raw.tool}：${note}${fallbackNames(raw.tool).length ? `（兜底可试：${fallbackNames(raw.tool).join("、")}）` : "（登记表中无兜底源）"}`);
    }
  }

  const attempts = { ...state.attempts_by_tool };
  if (raw.output_status !== "cached") attempts[raw.tool] = attempt;
  const next: AgentState = {
    ...state,
    step,
    tool_calls: state.tool_calls + (raw.output_status === "cached" ? 0 : 1),
    attempts_by_tool: attempts,
    cache,
    log: [...state.log, entry],
    evidence,
    missing,
    consecutive_no_progress: progressed ? 0 : state.consecutive_no_progress + 1,
  };
  return { state: next, entry, evidence_id: evidenceId };
}

/** 该不该停：预算/停摆（连续 3 次没有新读数）在这里判，不靠模型自觉 */
export function nextAction(state: AgentState, now_ms: number): { action: "continue" | "stop"; reason: AgentStopReason | null; detail: string } {
  if (state.stop) return { action: "stop", reason: state.stop.reason, detail: state.stop.detail };
  const left = budgetRemaining(state, now_ms);
  if (left.steps <= 0) return { action: "stop", reason: "max_steps", detail: `已达 ${state.budget.max_steps} 步上限` };
  if (left.tool_calls <= 0) return { action: "stop", reason: "max_tool_calls", detail: `已达 ${state.budget.max_tool_calls} 次调用上限` };
  if (left.ms <= 0) return { action: "stop", reason: "max_total_ms", detail: `已达 ${state.budget.max_total_ms}ms 总时长上限` };
  if (state.consecutive_no_progress >= 3) {
    return { action: "stop", reason: "no_progress", detail: "连续 3 次调用没有产生新读数：继续只会重复打上游，先用已成立部分作答" };
  }
  return { action: "continue", reason: null, detail: "" };
}

// ---------- 提示词：模型只负责「选哪条工具 / 结论」，取数与判定都在服务端 ----------

export const AGENT_SYSTEM_PROMPT = [
  `你是 ${AGENT_PROTOCOL_VERSION} 的研究助手：只读、不取数、不写库、不下单、不改账户（§二十八 这是研究系统不是交易系统）。`,
  "你每一步只能做一件事：从给定工具目录里挑一条最合适的工具去请求，或者宣布研究结束并给出结论。",
  "只能输出一个 JSON 对象，不要输出多余文字、不要输出代码块以外的说明。",
  "工具目录里没有的工具不存在；请求它会被判为 capability 不支持，不要试第二次，也不要把「不支持」说成「市场没有数据」。",
  "引用数据必须带台账行 id；台账里没有的数字不能出现在结论里。数字缺失就写缺失，不用 0 或印象值补。",
  `禁止事项（与 P6-C 同一份清单）：${AI_FORBIDDEN.join("、")}。`,
].join("\n");

export function buildAgentSystemPrompt(catalog = agentToolCatalogText()): string {
  return [AGENT_SYSTEM_PROMPT, "", catalog].join("\n");
}

function budgetLine(state: AgentState, now_ms: number): string {
  const l = budgetRemaining(state, now_ms);
  return `剩余预算：步 ${l.steps}/${state.budget.max_steps}｜工具调用 ${l.tool_calls}/${state.budget.max_tool_calls}｜时长 ${Math.round(l.ms / 1000)}s｜台账 ${l.evidence_lines}/${state.budget.max_evidence_lines}`;
}

function logLine(e: ToolCallLogEntry): string {
  const why = e.thought ? `理由：${e.thought}` : "理由：（模型未给出）";
  const out = e.output_status === "ok"
    ? `结果：${e.output_status}${e.evidence_id ? `（台账 ${e.evidence_id}）` : ""}｜出处 ${e.source ?? "未记录"}｜asOf ${e.as_of ?? "未记录"}`
    : `结果：${e.output_status}｜${e.error ?? "未给出原因"}`;
  const fb = e.fallback_of ? `｜这是 ${e.fallback_of} 失败后的兜底` : "";
  return `[步 ${e.step}] ${e.tool} 第 ${e.attempt} 次｜入参 ${JSON.stringify(e.input)}｜${why}｜${out}${fb}｜耗时 ${e.latency_ms ?? "未记录"}ms`;
}

/** 已成立台账：与 P6-C 的 evidenceLedgerText 同一份实现，避免两套引用格式 */
export function agentLedgerText(state: AgentState): string {
  return evidenceLedgerText(state.evidence.map((e) => e.line));
}

/** 每一轮喂回模型的文本：问题 + 预算 + 已调用记录 + 台账 + 缺口 + 输出协议 */
export function buildAgentTurnPrompt(state: AgentState, opts: { now_ms: number; catalog?: string; now: string }): string {
  const hits = shortlistTools(state.question, 8).map((t) => t.name);
  const log = state.log.length ? state.log.map(logLine).join("\n") : "（还没有调用过任何工具）";
  return [
    `研究问题：${state.question}`,
    `服务端基准时刻：${opts.now}（时间口径由服务端给定，不要自己判断今天几号）`,
    budgetLine(state, opts.now_ms),
    "",
    "【已经调用过的工具（服务端记录，模型不能凭记忆改写）】",
    log,
    "",
    "【当前台账（服务端从工具真实取到的读数，逐行带出处）】",
    agentLedgerText(state),
    "",
    "【已知缺口（本次没取到的，必须写进结论的 gaps，不能凭印象补）】",
    state.missing.length ? state.missing.map((m, i) => `${i + 1}. ${m}`).join("\n") : "（服务端本次没有报告缺口）",
    hits.length ? `\n【按问题关键词初筛的工具（只是提示，最终选哪条你看全目录）】${hits.join("、")}` : "",
    "",
    "【输出协议（二选一，只输出 JSON）】",
    "调用工具：{\"thought\":\"为什么要这条\",\"tool\":\"工具名\",\"args\":{...}}",
    "结束研究：{\"thought\":\"为什么够了\",\"final\":{\"answer\":\"结论原文\",\"cites\":[\"F01\",\"S02\"],\"gaps\":[\"还缺什么\"]}}",
    "要求：一次只给一个 tool；args 必须符合该工具的 inputSchema（代码里带*的是必填）；",
    "台账已能回答的部分不要重复取数（§三十二）；确实无法回答时给 final，并在 gaps 里写明「缺少 X 数据，因此无法验证 Y」。",
  ].filter(Boolean).join("\n");
}

/**
 * 预算/停摆条件已经触发时喂回模型的「收尾那一轮」（§十七 受控停止）：
 * 服务端此时不再接受新的工具调用（prompt 返回 null），但运行并没有完成——
 * 还差一份带引用的结论。这一轮只允许 final，并把「未验证的部分写进 gaps」挑明，
 * 让客户端不必在页面上自己拼提示词（页面拼出来的口径没人测过，就是第二套协议）。
 */
export function buildAgentFinalTurnText(detail: string, left: BudgetLeft): string {
  return [
    `服务端本轮起不再接受工具调用（原因：${detail || "预算已到"}）。`,
    `剩余预算：步 ${left.steps}｜工具调用 ${left.tool_calls}｜时长 ${Math.round(left.ms / 1000)}s｜台账 ${left.evidence_lines} 行可引用。`,
    "这一步不要再请求工具：只输出一个 final JSON，把上面台账能支撑的部分写成结论，其余照实写进 gaps。",
    "输出：{\"thought\":\"为什么到此为止\",\"final\":{\"answer\":\"结论原文\",\"cites\":[\"台账行 id\"],\"gaps\":[\"还缺什么、因此无法验证什么\"]}}",
    "上一轮列出的调用记录与台账仍然有效：能答多少答多少，缺口不要用 0 或印象值补（引用台账里没有的数字会被判不可回溯）。",
  ].join("\n");
}

export type AgentDirective =
  | { kind: "tool"; thought: string; tool: string; args: unknown }
  | { kind: "final"; thought: string; answer: string; cites: string[]; gaps: string[] }
  | { kind: "invalid"; error: string; raw: string };

/** 解析模型回复。协议外的东西（多个工具、无 tool 名、final 缺 answer）一律 invalid，不做「猜它想干嘛」 */
export function parseAgentDirective(text: string): AgentDirective {
  const raw = String(text ?? "");
  const obj = extractJsonObject(raw);
  if (!obj) return { kind: "invalid", error: `回复里没有可解析的 JSON 对象（协议要求只输出一个 JSON；收到原文前 120 字：${raw.slice(0, 120) || "（空）"}）`, raw };
  const thought = String(obj.thought ?? "").replace(/\s+/g, " ").trim();
  const final = obj.final;
  if (final !== undefined && final !== null) {
    const f = (typeof final === "object" && !Array.isArray(final) ? final : { answer: String(final) }) as Record<string, unknown>;
    const answer = String(f.answer ?? "").trim();
    if (!answer) return { kind: "invalid", error: "final 里没有 answer 文本：结束研究必须给出结论，不能只说「研究完了」", raw };
    const cites = Array.isArray(f.cites) ? f.cites.map((c) => String(c).trim()).filter(Boolean) : [];
    const gaps = Array.isArray(f.gaps) ? f.gaps.map((c) => String(c).trim()).filter(Boolean) : [];
    return { kind: "final", thought, answer, cites, gaps };
  }
  const toolName = obj.tool;
  if (typeof toolName !== "string" || !toolName.trim()) {
    return { kind: "invalid", error: "既没有 final 也没有 tool 字段：无法判断这一步要做什么（不替你猜）", raw };
  }
  const args = obj.args ?? obj.params ?? obj.input ?? {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return { kind: "invalid", error: `args 必须是 JSON 对象（收到 ${Array.isArray(args) ? "数组" : typeof args}）`, raw };
  }
  return { kind: "tool", thought, tool: toolName.trim(), args };
}

// ---------- §十九 血缘与最终答案复校验 ----------

export interface LineageRow {
  evidence_id: string;
  tool: string;
  executor: string | null;
  source: string;
  as_of: string;
  /** null = 台账里那行的分层值不在 DATA_STATUSES 内：标出来，不猜它算事实还是派生 */
  data_status: DataStatus | null;
  data_status_raw: string;
  step: number;
  call_key: string;
  refs: string[];
}

/** 答案引用的每条台账 → 工具 → 出处（页面直接列「这条结论来自哪次调用」） */
export function lineageOf(cites: string[], records: AgentEvidenceRecord[]): { used: LineageRow[]; invalid: string[] } {
  const byId = new Map(records.map((r) => [r.line.id, r]));
  const used: LineageRow[] = [];
  const invalid: string[] = [];
  for (const id of new Set(cites)) {
    const r = byId.get(id);
    if (!r) { invalid.push(id); continue; }
    const raw = String(r.line.data_status ?? "");
    used.push({
      evidence_id: r.line.id, tool: r.tool, executor: r.executor, source: r.line.source, as_of: r.line.as_of,
      data_status: isDataStatus(raw) ? raw : null, data_status_raw: raw || "（空）",
      step: r.step, call_key: r.call_key, refs: r.refs,
    });
  }
  return { used, invalid };
}

export interface AgentAnswerCheck {
  /** ACCEPTED=全部可回溯；PARTIAL=能引用但有标注问题；REJECTED=一句都没引用上 */
  status: "ACCEPTED" | "PARTIAL" | "REJECTED";
  answer: string;
  cites_valid: string[];
  cites_invalid: string[];
  unsourced_numbers: UnsourcedNumber[];
  historical_as_current: string[];
  /** 概率类引用必须带 trade_date/sample/horizon（§十九），缺一项就点名 */
  probability_gaps: string[];
  /** 未被任何引用覆盖的台账行（提示：取到了却没引用，可能是白跑的调用） */
  unused_evidence: string[];
  violations: string[];
  gaps: string[];
  lineage: LineageRow[];
}

const PROBABILITY_TOOLS = new Set(["probability", "snapshot_probability", "factor_test"]);

/**
 * 台账引用标记：[F01]/[S02]/[H01] 是引用语法，不是市场数字。
 * 不先摘掉会出假阳性：P6-C 的 MARKET_NUMBER_PATTERNS 第三条把「样本」这类词后面紧跟的数字当读数，
 * 于是「…（过去样本）[H01]」被扫出一个凭空数字「样本）[H01」=1，答案被误判 PARTIAL。
 * 这里只在 P6-D 的扫描前预处理，不改 P6-C 已提交的判据本身。
 */
const CITATION_MARK = /\[[A-Z]{1,2}\d{1,3}\]/g;

/**
 * 结论里出现「胜率/概率」但没有概率口径 ⇒ 点名（不删原文，只判它不成立）
 *
 * 哪些引用行算「概率的出处」：① 工具在概率类白名单里；② 这一行的出处文字里写着概率/胜率；
 * ③ 这一行的台账原文里就写着概率/胜率。
 * 第 ③ 条是真实模型跑出来的（run_id `ui-mu8xng0k-7uxyft`，2026-09-20）：`risk` 工具的摘要本身就带
 * 「上证相似环境后续统计：样本 113 个，1日胜率 46.9%（HISTORICAL…）」，模型照抄这句却被判成
 * 「凭空给概率」——那个数字明明在台账里，判它「没有出处」是判据错了，不是模型错了。
 * 这里放宽的只是「哪一行算有出处」的识别，没有放宽标准：一旦认它做出处，
 * 下面 trade_date/sample/horizon 三项口径照样要齐，缺任一项仍然判不成立。
 * 真正凭空编的概率（台账里没有任何一行提到概率/胜率）走的还是第一条消息，不受这条影响。
 */
function probabilityCheck(answer: string, cites: LineageRow[], textById: Map<string, string>): string[] {
  if (!/胜率|概率|可能性/.test(answer)) return [];
  const withProb = cites.filter((c) =>
    PROBABILITY_TOOLS.has(c.tool) || /概率|胜率/.test(c.source) || /概率|胜率/.test(textById.get(c.evidence_id) ?? ""));
  if (!withProb.length) return ["结论里提到概率/胜率，但引用的台账没有一条来自概率类工具：这属于凭空给概率，按不可回溯处理（概率只能由历史样本算出，也不能拿历史概率当今天的答案）"];
  const out: string[] = [];
  for (const c of withProb) {
    const have = new Set(c.refs.map((r) => r.split("=")[0]));
    const miss = ["trade_date", "sample", "horizon"].filter((k) => !have.has(k));
    if (miss.length) out.push(`${c.evidence_id}（${c.tool}）的概率引用缺口径字段：${miss.join("、")}。没有区间/样本数/期限的概率数字不成立`);
  }
  return out;
}

/**
 * 最终答案复校验：与 P6-C 同一套判据（引用命中、无出处数字、历史≠当前、概率口径），
 * 只是这里多了一件事——不重算也不改写，只判定；结论原文照抄，页面把违规项显示在旁边。
 */
export function verifyAgentAnswer(input: {
  answer: string; cites?: string[]; gaps?: string[];
  state: AgentState;
}): AgentAnswerCheck {
  const answer = String(input.answer ?? "").trim();
  const records = input.state.evidence;
  const cites = (input.cites ?? []).map((c) => String(c).trim()).filter(Boolean);
  const { used, invalid } = lineageOf(cites, records);
  const lines = records.map((r) => r.line);
  const violations: string[] = [];
  if (!answer) violations.push("空结论：模型没有给出答案文本，本层不会替它写一份");
  const unsourced = answer ? findUnsourcedNumbers(answer.replace(CITATION_MARK, " "), lines) : [];
  const hist = answer ? findHistoricalAsCurrentClaims(answer) : [];
  if (invalid.length) violations.push(`引用了台账里不存在的行：${invalid.join("、")}（编造引用不会被算成有效出处）`);
  const badLayer = used.filter((u) => u.data_status === null);
  if (badLayer.length) violations.push(`台账行的分层值无法识别（${badLayer.map((b) => `${b.evidence_id}=${b.data_status_raw}`).join("、")}）：不知道它是事实还是派生，就不能据此下结论`);
  if (unsourced.length) violations.push(`结论里有 ${unsourced.length} 个带单位的市场化数字在台账里找不到出处：${unsourced.map((u) => u.claim).join("、")}`);
  if (hist.length) violations.push(`把历史样本写成当前事实的措辞：${hist.join("、")}（本层不改写你的原文，只标注它不成立）`);
  const prob = probabilityCheck(answer, used, new Map(records.map((r) => [r.line.id, String(r.line.text ?? "")])));
  for (const p of prob) violations.push(p);
  const gaps = (input.gaps ?? []).filter(Boolean);
  // 服务端已知缺口必须被承认：一条都没提，就把它们并进 gaps（不是替模型编，是标注它没答）
  const unacknowledged = input.state.missing.filter((m) => !gaps.some((g) => g.includes(m.slice(0, 12))));
  if (!used.length) violations.push("结论没有引用任何台账行：无法回溯到工具与出处，按 REJECTED 处理（不覆盖已成立结果，页面保留原文与原因）");
  const unused = records.map((r) => r.line.id).filter((id) => !used.some((u) => u.evidence_id === id));
  const status: AgentAnswerCheck["status"] = !used.length || !answer ? "REJECTED" : violations.length ? "PARTIAL" : "ACCEPTED";
  return {
    status, answer, cites_valid: used.map((u) => u.evidence_id), cites_invalid: invalid,
    unsourced_numbers: unsourced, historical_as_current: hist, probability_gaps: prob,
    unused_evidence: unused, violations,
    gaps: [...gaps, ...unacknowledged.map((m) => `（服务端标注、模型未回应）${m}`)],
    lineage: used,
  };
}

/** 运行结束时给页面/落库用的一行摘要：状态 + 计数，不掺任何「看起来像数据」的东西 */
export function summarizeRun(state: AgentState, check: AgentAnswerCheck | null, now_ms: number): Record<string, string | number | boolean | null> {
  const stop = state.stop ?? nextAction(state, now_ms);
  const byStatus = state.log.reduce<Record<string, number>>((acc, e) => {
    acc[e.output_status] = (acc[e.output_status] ?? 0) + 1;
    return acc;
  }, {});
  return {
    run_id: state.run_id,
    question: state.question,
    steps: state.step,
    tool_calls: state.tool_calls,
    distinct_tools: Object.keys(state.attempts_by_tool).length,
    evidence_lines: state.evidence.length,
    missing_lines: state.missing.length,
    fallback_used: state.log.filter((e) => e.fallback_of).length,
    cached_hits: state.log.filter((e) => e.output_status === "cached").length,
    latency_total_ms: state.log.reduce((s, e) => s + (e.latency_ms ?? 0), 0),
    stop_reason: "reason" in stop ? stop.reason : null,
    stop_detail: "detail" in stop ? stop.detail : "",
    answer_status: check?.status ?? null,
    log_status_counts: Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(","),
    protocol: AGENT_PROTOCOL_VERSION,
  };
}

/** 预算内的工具清单（供页面显示「Agent 能做什么」，与提示词目录同一份实现，不各写一套） */
export function agentToolSummary(): { total: number; enabled: number; disabled: string[]; names: string[]; text: string } {
  const on = enabledTools();
  return {
    total: TOOL_DEFS.length,
    enabled: on.length,
    names: on.map((t) => t.name),
    disabled: TOOL_DEFS.filter((t) => !t.enabled).map((t) => t.name),
    text: agentToolCatalogText(),
  };
}

export type { ToolDefinition };
