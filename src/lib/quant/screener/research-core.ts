// P6-C「AI Market Research」纯内核：只做「台账组装 + 提示词 + 模型输出复校验 + 分层呈现」，
// 不碰网络、不碰数据库、不调模型、不重算任何指标（任务书 §十一：MA/MACD/RSI/IC/回测/概率一律走已有 Quant Engine）。
//
// 三条来自任务书的硬约束在这里变成可核对的代码，而不是提示词里的愿望：
// 1. §十三 七层分区：FACTS / SIGNALS / HISTORICAL_EVIDENCE 三层由服务端从已有能力组装（本层只认台账，AI 不得复述成新事实）；
//    INTERPRETATION / RISKS / UNKNOWN / NEXT_CHECKS 才是模型产出。六类内容不得混在一段话里 ⇒ 解析时按四个数组分别收。
// 2. §十四 AI 不得做的事：不改公式/参数/回测结果/历史数据/verified 状态，不删异常数据，不补缺失数据，
//    不伪造概率/新闻/资金流/北向/实时行情。可核对的那部分落成三条复校验：
//    ① 概率与涨幅预测在落库前剥掉并留档（复用 P6-B 内核，两层同一口径）；
//    ② 解释里的「市场化数字」（带 %、亿、万、涨/跌/净流入 等）必须在台账里找得到出处，找不到就打牌「无出处数字」；
//    3. 引用（cites）只能指向台账里真实存在的行 id，编造的 id 逐条留档剔除。
// 3. §二十二 历史统计 ≠ 当前预测：把「过去 713 个样本胜率 51.75%」写成「所以今天上涨概率 51.75%」这一类措辞要被抓出来。
//    注意这里**只标注不改写**：概率数字本身已被 ① 剥离，而「历史上样本充足」这类句子被整段删掉会伤及正确正文。

import { findProbabilityClaims, stripProbabilityClaims } from "./event-interpret-core.ts";

/** 提示词与校验共用一个版本号：改了提示词就必须升版本，回看时能知道报告是哪一版口径产出的。 */
export const RESEARCH_PROMPT_VERSION = "p6c-1";

/** 模型原文长度上限（字符）：超过即拒，不解析垃圾。与 P6-B 同口径。 */
export const MAX_RAW_CHARS = 200_000;

// ---------- §十三 七层 ----------

export const RESEARCH_LAYERS = [
  "FACTS", "SIGNALS", "HISTORICAL_EVIDENCE", "INTERPRETATION", "RISKS", "UNKNOWN", "NEXT_CHECKS",
] as const;
export type ResearchLayer = (typeof RESEARCH_LAYERS)[number];

/** 服务端组装的三层：AI 只能引用行 id，不得把它们当自己的产出。 */
export const SERVER_LAYERS = ["FACTS", "SIGNALS", "HISTORICAL_EVIDENCE"] as const;
export type ServerLayer = (typeof SERVER_LAYERS)[number];

/** 模型产出的四层：每层各成一段，互不混排。 */
export const AI_LAYERS = ["INTERPRETATION", "RISKS", "UNKNOWN", "NEXT_CHECKS"] as const;
export type AiLayer = (typeof AI_LAYERS)[number];

export const LAYER_TEXT: Record<ResearchLayer, string> = {
  FACTS: "事实（服务端从已注册能力取到的真实读数，AI 不得改写）",
  SIGNALS: "信号（已有引擎/库行的产出，含雷达与主题判定，AI 不得改写）",
  HISTORICAL_EVIDENCE: "历史证据（回测/条件概率/IC 的过去样本结论，属 historical/statistical）",
  INTERPRETATION: "解释（AI 对台账的跨源综合，必须逐条标注引用了哪几行台账）",
  RISKS: "风险与反向证据（AI 指出与主叙述相反的证据，同样必须带引用）",
  UNKNOWN: "未知与缺口（本批台账里没有的数据，写成缺失原因，不用别的数字顶替）",
  NEXT_CHECKS: "下一步该查什么（给 Agent 的具体查询，不是投资建议）",
};

/** 台账层 ⇒ 行 id 前缀：F/S/H 一眼分得清是哪一层。 */
const LAYER_PREFIX: Record<ServerLayer, string> = { FACTS: "F", SIGNALS: "S", HISTORICAL_EVIDENCE: "H" };

// ---------- 采集器观测（服务层逐能力记录，页面顶部与「Tool Calls」侧栏显示的就是它） ----------
// 放在内核里，是为了让客户端类型与服务端落库的 sourcesJson 同一份定义（避免前后端各写一套字段而漂移）。

/** 与 P6-A 探测层同口径的四态：ok=取到值 / empty=真的没有内容 / failed=这次失败 / not_covered=本来就没这个源 */
export type CollectorStatus = "ok" | "empty" | "failed" | "not_covered";

export const COLLECTOR_STATUS_TEXT: Record<CollectorStatus, string> = {
  ok: "本次取到读数",
  empty: "真实为空（不是失败，也不会补数据）",
  failed: "本次取数失败（按缺失处理，不沿用上次结果）",
  not_covered: "无可靠来源（登记为缺失，路径是明的）",
};

export interface SourceProbe {
  capability: string;
  title: string;
  status: CollectorStatus;
  as_of: string;
  source: string;
  data_status: string;
  lines: number;
  note: string;
}

/** §十四「AI 可以做的事」：写进提示词，也用作测试锚点（能力清单不得被悄悄扩大）。 */
export const AI_RESEARCH_JOBS = [
  "选择已有工具（本层已登记能力）",
  "组合已有结果（跨源综合）",
  "解释已有结果",
  "指出矛盾",
  "发现缺口",
  "提出下一步查询",
] as const;

/** §十四「AI 不得做的事」原文逐条（12 条）。落库前能机检的三条已在文件头注明。 */
export const AI_FORBIDDEN = [
  "修改因子公式",
  "修改参数",
  "修改回测结果",
  "修改历史数据",
  "修改 verified 状态",
  "删除异常数据",
  "把缺失数据补齐",
  "伪造概率",
  "伪造新闻",
  "伪造资金流",
  "伪造北向数据",
  "伪造实时行情",
] as const;

// ---------- 台账 ----------

export interface EvidenceLine {
  /** 台账行 id：F01 / S02 / H03，由服务端编号，AI 只能引用这些 id。 */
  id: string;
  layer: ServerLayer;
  /** 一句话一行，数字必须留在句子里（读者要能核到原文）。 */
  text: string;
  /** capability-core 登记表里的能力名。 */
  capability: string;
  /** 出处原文：provider / 表名 / 引擎函数，不写「系统」这类含糊主语。 */
  source: string;
  /** 时刻或日期；取不到可核对的时刻就写「未记录」，不猜。 */
  as_of: string;
  /** DATA_STATUSES 取值（REAL/DERIVED/HISTORICAL/SNAPSHOT/MISSING/DEGRADED…）。 */
  data_status: string;
}

/** 台账行的数字（含百分号与常见单位）：AI 侧的市场化数字必须能对上这里的某一个。 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of String(text ?? "").matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number.parseFloat(m[0]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** 带单位/方向词的市场化数字：只查这些，避免把「两个板块」这类计数词判成伪造。 */
const MARKET_NUMBER_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*%/g,
  /\d+(?:\.\d+)?\s*(?:亿|万元|万|元|倍|个点|个百分点|家|只|条|个交易日)/g,
  /(?:涨|跌|净流入|净流出|成交额|成交金额|换手率|市值|样本|胜率|回撤|RankIC|IC)[^0-9\-]{0,3}-?\d+(?:\.\d+)?/g,
];

export interface UnsourcedNumber {
  /** 命中的原文片段（留档用，读者能看到 AI 到底说了什么数字）。 */
  claim: string;
  value: number;
}

/** 「它自己声明的精度」下的取值一致才算有出处：3% 可以代表 3.07%，20% 不能代表 3.07%。 */
function decimalsOf(token: string): number {
  const dot = token.indexOf(".");
  return dot < 0 ? 0 : token.slice(dot + 1).replace(/\D/g, "").length;
}

/**
 * 片段是否作为「独立数字」出现在台账文本里：前后都不能再贴着数字或小数点。
 * 这条边界判断是必需的：早期版本用 `includes(token)`，结果 as_of 里的「2026-09-19」
 * 让「20%」「19%」这类凭空数字全部被判成有出处（子串命中），核查等于没做。
 */
function appearsAsOwnNumber(hay: string, token: string): boolean {
  if (!token) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9.])${esc}(?![0-9.])`).test(hay);
}

/**
 * 市场化数字是否有台账出处。两条判据（任一成立即算有出处）：
 * ① 数值在 AI 自己声明的精度上等于某个台账数字（台账 3.07% ⇒ 允许「3%」「3.1%」，不允许「20%」）；
 * ② 该片段作为独立数字出现在台账正文里（被截断的写法、正文里的日期走这条）。
 * 出处/时刻字段不参与判据：as_of「2026-09-19 20:14」里有 2026/09/19/20/14 这一堆片段，
 * 拿它们当出处会让「涨 20%」这类凭空数字被判成有出处；而 MARKET_NUMBER_PATTERNS 只扫带
 * 百分号/市场单位/行情动词的数字，AI 引用日期本来就不会被扫出来，不需要靠 as_of 放行。
 * 取「宁可漏报不误删」：误删正确正文比漏报一个数字更伤可读性，而漏报仍会显示在「引用行」里由人核对。
 */
export function findUnsourcedNumbers(text: string, ledger: EvidenceLine[]): UnsourcedNumber[] {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  const ledgerText = ledger.map((l) => l.text).join("\n");
  const ledgerNumbers = ledger.flatMap((l) => numbersIn(l.text));
  const hits: Array<UnsourcedNumber & { at: number }> = [];
  const seen = new Set<string>();
  for (const re of MARKET_NUMBER_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const claim = m[0].trim();
      if (!claim || seen.has(claim)) continue;
      seen.add(claim);
      const token = (claim.match(/\d+(?:\.\d+)?/) ?? [""])[0];
      const value = Number.parseFloat(token);
      if (!Number.isFinite(value)) continue;
      const dp = decimalsOf(token);
      const byValue = ledgerNumbers.some((v) => Number(v.toFixed(dp)) === value);
      const byText = appearsAsOwnNumber(ledgerText, token);
      if (!byValue && !byText) hits.push({ claim, value, at: m.index ?? 0 });
    }
  }
  // 按在原文里出现的位置排：页面逐条标注时要和读者读到的顺序一致，不能按匹配模式分组。
  return hits.sort((a, b) => a.at - b.at).map(({ claim, value }) => ({ claim, value }));
}

/** §二十二 把历史统计写成当前预测的措辞（含被 §十四 禁止的「今天上涨概率 X%」）。 */
const HISTORICAL_AS_CURRENT_PATTERNS: RegExp[] = [
  /(?:所以|因此|可见|说明|意味着|预示着)[^。，；\n]{0,16}(?:今天|今日|明天|明日|当前|现在|本周|下周|后市)/g,
  /(?:今天|今日|明天|明日|当前|现在|后市)[^。，；\n]{0,10}(?:胜率|样本|回测|历史|统计)/g,
  /(?:胜率|样本|回测|历史|统计)[^。，；\n]{0,10}(?:所以|因此|意味着)[^。，；\n]{0,10}(?:会涨|会跌|要涨|要跌|上涨|下跌)/g,
];

/** 命中原文（句子级）。只用于标注与降级，不改写模型原文。 */
export function findHistoricalAsCurrentClaims(text: string): string[] {
  const src = String(text ?? "");
  const out = new Set<string>();
  for (const re of HISTORICAL_AS_CURRENT_PATTERNS) {
    for (const m of src.matchAll(re)) if (m[0].trim()) out.add(m[0].trim());
  }
  return [...out];
}

/** 台账文本：每行都带 [id｜层｜数据状态｜出处｜asOf]，AI 引用时抄 id，读者核对时看得到出处。 */
export function evidenceLedgerText(lines: EvidenceLine[]): string {
  if (!lines.length) return "（本批没有可用台账行）";
  return lines
    .map((l) => `[${l.id}]（${LAYER_TEXT[l.layer]}｜${l.data_status}｜出处：${l.source}｜asOf：${l.as_of}｜能力：${l.capability}）${l.text}`)
    .join("\n");
}

/** 服务端统一编号：调用方只给 layer，id 由内核分配，避免各采集器自己编号撞车。 */
export function assignEvidenceIds(input: Omit<EvidenceLine, "id">[]): EvidenceLine[] {
  const counters: Record<ServerLayer, number> = { FACTS: 0, SIGNALS: 0, HISTORICAL_EVIDENCE: 0 };
  return input.map((l) => {
    counters[l.layer] += 1;
    return { ...l, id: `${LAYER_PREFIX[l.layer]}${String(counters[l.layer]).padStart(2, "0")}` };
  });
}

// ---------- 提示词 ----------

export const RESEARCH_SYSTEM_PROMPT =
  "你是研究层的解释器，不是取数器：只能引用给定台账行，不得取数、不得计算、不得改写事实、不得输出概率与预测。只输出 JSON。";

export interface ResearchPromptInput {
  question: string;
  as_of: string;
  lines: EvidenceLine[];
  /** 服务端已知缺口（采集失败/库里没有），必须原样进提示词，让模型写进 UNKNOWN 而不是绕过它。 */
  missing: string[];
}

export function buildResearchPrompt(input: ResearchPromptInput): string {
  const lines = input.lines ?? [];
  const ids = lines.map((l) => l.id).join(" ");
  const missing = (input.missing ?? []).length
    ? input.missing.map((m, i) => `${i + 1}. ${m}`).join("\n")
    : "（服务端本次没有报告缺口）";
  return [
    `研究问题：${input.question}`,
    `研究基准时刻（服务端 shanghaiDate 口径）：${input.as_of}`,
    "",
    "【台账（服务端从已注册能力现取，逐行带出处；本层是唯一的事实来源）】",
    evidenceLedgerText(lines),
    "",
    "【服务端已报告的缺口（照实写进 unknowns，不得用别的数字顶替）】",
    missing,
    "",
    "【你只能做这些】",
    AI_RESEARCH_JOBS.map((j, i) => `${i + 1}. ${j}`).join("\n"),
    "",
    "【你不得做这些（任务书 §十四 原文）】",
    AI_FORBIDDEN.map((j, i) => `${i + 1}. 不得${j}`).join("\n"),
    "",
    "【七层结构（§十三：这七类内容必须分开，不得混在一段话里）】",
    "FACTS 事实 / SIGNALS 信号 / HISTORICAL_EVIDENCE 历史证据：由服务端台账产出，你只能引用行 id，不得复述成自己的结论。",
    "INTERPRETATION 解释 → interpretation ｜ RISKS 风险 → risks ｜ UNKNOWN 未知 → unknowns ｜ NEXT_CHECKS 下一步核查 → next_checks：这四层才是你要写的。",
    "",
    "【输出规则】",
    "1. FACTS / SIGNALS / HISTORICAL_EVIDENCE 三层由服务端产出，你不得复述成自己的结论，只能用行 id 引用。",
    "2. 只输出一个 JSON 对象，结构固定为：",
    `{"headline":"一句话结论（不得含概率与预测）","market_posture":"偏进攻|均衡|偏防守|观察（四选一，必须说明依据哪些台账行）",`,
    `"interpretation":[{"text":"","cites":["F01","S02"]}],"risks":[{"text":"","cites":["H01"]}],`,
    `"unknowns":[""],"next_checks":[""]}`,
    `3. cites 里的每个 id 都必须来自这份台账（可用 id：${ids || "无"}）；没有可引用的台账行就把该条留空，不要为了填满结构硬凑引用。`,
    "4. 禁止输出任何概率数字与涨幅/跌幅预测：不许写「上涨概率 80%」「明天涨停概率」「短期涨幅 3%」这类表述。",
    "5. 历史统计不等于当前预测：可以说「过去样本 N 胜率 X%（historical/statistical）」，不可以说「所以今天上涨概率 X%」。",
    "6. 台账里没有的数字、标的、新闻、资金流、北向数据，一律不要写；要写就写进 unknowns 说明缺什么。",
    "7. interpretation 与 risks 每条都必须带 cites；risks 专门放与主叙述相反的证据，没有就写空数组（空就是空，不编风险）。",
  ].join("\n");
}

// ---------- 状态 ----------

export const RESEARCH_STATUSES = ["INTERPRETED", "PARTIAL", "REJECTED"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const RESEARCH_STATUS_TEXT: Record<ResearchStatus, string> = {
  INTERPRETED: "已完成解释：每条判断都能指到台账行",
  PARTIAL: "部分完成：有引用缺失、无出处数字或越界表述被剔除（见核对结果），引用时必须带这句限制",
  REJECTED: "不可用：模型没有给出任何可核对的解释（不产出默认结论）",
};

/** 解释层「没跑成」的三种原因：与 P6-B 同一套写法，页面不得把任何一种显示成空结论。 */
export const RESEARCH_NOT_RUN_STATUSES = {
  ai_unconfigured: "AI_NOT_CONFIGURED",
  ai_failed: "AI_FAILED",
  no_evidence: "NO_EVIDENCE",
} as const;

export function statusDataLayer(_status: ResearchStatus): "AI_INTERPRETATION" {
  return "AI_INTERPRETATION";
}

// ---------- 范围与自然键（落库用，纯字符串逻辑） ----------

/**
 * 本阶段只做「整体市场环境」：个股/板块范围需要另一套台账（per-symbol 行情与因子），
 * 没有实现就明确 NOT IMPLEMENTED，不接受参数后被悄悄按 market 处理。
 */
export const RESEARCH_SCOPES = ["market"] as const;
export type ResearchScope = (typeof RESEARCH_SCOPES)[number];

export const RESEARCH_SCOPE_NOT_IMPLEMENTED =
  "scope 只支持 market（当前市场环境研究报告，§十二）：个股/板块范围的研究层尚未实现（NOT IMPLEMENTED），不会把别的范围偷偷按全市场产出";

export function researchScopeOf(raw: string | null | undefined): ResearchScope | null {
  // 空串/纯空白 = 「没传」（?scope= 与省略同等对待），未知非空值一律 null 交调用方判 400。
  const v = String(raw ?? "").trim().toLowerCase() || "market";
  return (RESEARCH_SCOPES as readonly string[]).includes(v) ? (v as ResearchScope) : null;
}

/** 400 文案：把收到的原值写进消息，读者才知道被拒的是哪个值，而不是以为「market 也没跑成功」。 */
export function researchScopeErrorText(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  return v ? `${RESEARCH_SCOPE_NOT_IMPLEMENTED}（收到的值：「${v}」）` : RESEARCH_SCOPE_NOT_IMPLEMENTED;
}

/**
 * 日期口径校验（§三十一「非法参数 → 合理 4xx」）。
 * 为什么必须单独拦：不校验时 `?date=2026-13-99` 会走到「按这个键查库、查不到」，
 * 于是返回 200 + 「那天还没有报告」—— 把参数错误说成空数据，正是本层禁止的 silent failure。
 * 空串 = 没传（交调用方回落到当天），不是非法。
 */
export function researchDateError(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return `date 必须是 YYYY-MM-DD（收到「${v}」）：非法日期不会被当成「那天没有报告」，也不会偷偷回落到今天再读一次`;
  }
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return `date「${v}」不是真实存在的日历日：这种日子没有归档可读，也不会被当成「那天是空的」`;
  }
  return null;
}

/** 自然键 = scope|date：同一天同范围只留最新一条 ⇒ 这张表天然有界（§三十四 不允许偷偷无限增长）。 */
export function researchReportKey(scope: ResearchScope, date: string): string {
  return `${scope}|${date}`;
}

/** 台账条数上限：一次提问要装得下，超出就按采集顺序截断，并把截断事实写进 missing。 */
export const MAX_LEDGER_LINES = 45;

export function capLedger(input: Omit<EvidenceLine, "id">[], max = MAX_LEDGER_LINES): { kept: Omit<EvidenceLine, "id">[]; dropped: number } {
  const arr = Array.isArray(input) ? input : [];
  if (arr.length <= max) return { kept: arr, dropped: 0 };
  return { kept: arr.slice(0, max), dropped: arr.length - max };
}

// ---------- 解析与复校验 ----------

export interface ResearchSectionItem {
  text: string;
  cites: string[];
  /** 引用的台账行原文（服务端按 id 回填，页面直接显示出处）。 */
  cited_text: string[];
  /** 台账里找不到出处的市场化数字（原文片段）。 */
  unsourced_numbers: string[];
  /** 把历史统计写成当前预测的片段。 */
  historical_as_current: string[];
  /** 该行是否每条引用都站得住：cites 非空且全部命中台账。 */
  fully_grounded: boolean;
}

export interface ResearchReport {
  question: string;
  as_of: string;
  headline: string;
  market_posture: string;
  posture_cites: string[];
  interpretation: ResearchSectionItem[];
  risks: ResearchSectionItem[];
  unknowns: string[];
  next_checks: string[];
  interpretation_status: ResearchStatus;
  data_layer: "AI_INTERPRETATION";
  evidence_total: number;
  evidence_by_layer: Record<ServerLayer, number>;
  /** 被剔除的编造引用（原文留档）。 */
  dropped: { invalid_cites: string[]; probability_claims: string[]; fields: string[] };
  violations: string[];
  model: string;
  prompt_version: string;
  generated_at: string;
}

export interface ParseResearchResult {
  ok: boolean;
  report: ResearchReport | null;
  error: string;
  /** 台账里没有任何可解释的行（与「模型失败」区分开）。 */
  no_evidence: boolean;
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const s = String(raw ?? "");
  const attempt = (t: string) => {
    try {
      const v = JSON.parse(t) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(s);
  if (direct) return direct;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const v = attempt(fenced[1].trim());
    if (v) return v;
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return attempt(s.slice(start, end + 1));
  return null;
}

const clampPosture = (raw: unknown): { value: string; clamped: boolean } => {
  const allowed = ["偏进攻", "均衡", "偏防守", "观察"];
  const v = String(raw ?? "").trim();
  const hit = allowed.find((a) => a === v);
  return hit ? { value: hit, clamped: false } : { value: v ? `未登记取值：${v.slice(0, 20)}` : "未记录", clamped: !!v };
};

interface SectionInput {
  raw: unknown;
  layerLabel: string;
  ledger: EvidenceLine[];
  idSet: Set<string>;
  violations: string[];
  dropped: { invalid_cites: string[]; probability_claims: string[]; fields: string[] };
  byId: Map<string, EvidenceLine>;
}

function parseSectionItems({ raw, layerLabel, idSet, violations, dropped, byId }: SectionInput): ResearchSectionItem[] {
  if (!Array.isArray(raw)) {
    if (raw != null && String(raw).trim()) violations.push(`${layerLabel} 不是数组（按缺失处理，不拆字符串凑数）`);
    return [];
  }
  const out: ResearchSectionItem[] = [];
  for (const entry of raw.slice(0, 20)) {
    const obj = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const text = String(obj.text ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!text) continue;
    const stripped = stripProbabilityClaims(text);
    if (stripped.claims.length) dropped.probability_claims.push(...stripped.claims);
    const rawCites = Array.isArray(obj.cites) ? obj.cites.map((c) => String(c).trim()).filter(Boolean) : [];
    const cites: string[] = [];
    for (const c of rawCites) {
      if (idSet.has(c)) {
        if (!cites.includes(c)) cites.push(c);
      } else if (!dropped.invalid_cites.includes(c)) {
        dropped.invalid_cites.push(c);
      }
    }
    const unsourced = findUnsourcedNumbers(stripped.text, [...byId.values()]).map((u) => u.claim);
    const hist = findHistoricalAsCurrentClaims(stripped.text);
    out.push({
      text: stripped.text,
      cites,
      cited_text: cites.map((c) => `[${c}] ${byId.get(c)?.text ?? ""}`.trim()),
      unsourced_numbers: [...new Set(unsourced)],
      historical_as_current: hist,
      fully_grounded: cites.length > 0 && cites.length === rawCites.length,
    });
  }
  return out;
}

export interface ParseResearchOptions {
  question?: string;
  as_of?: string;
  model?: string;
  generated_at?: string;
}

/**
 * 复校验主入口。台账由服务端重新取一次（不接受客户端传来的事实字段），
 * 所以模型即使回传一份改过的 FACTS 也进不了报告：报告只存引用 id 与服务端回填的原文。
 */
export function parseResearchOutput(raw: string, ledger: EvidenceLine[], opts: ParseResearchOptions = {}): ParseResearchResult {
  const lines = ledger ?? [];
  const idSet = new Set(lines.map((l) => l.id));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const violations: string[] = [];
  const dropped = { invalid_cites: [] as string[], probability_claims: [] as string[], fields: [] as string[] };
  const base = {
    question: String(opts.question ?? "").trim(),
    as_of: String(opts.as_of ?? "").trim() || "未记录",
    evidence_total: lines.length,
    evidence_by_layer: {
      FACTS: lines.filter((l) => l.layer === "FACTS").length,
      SIGNALS: lines.filter((l) => l.layer === "SIGNALS").length,
      HISTORICAL_EVIDENCE: lines.filter((l) => l.layer === "HISTORICAL_EVIDENCE").length,
    } as Record<ServerLayer, number>,
    model: String(opts.model ?? "未记录"),
    prompt_version: RESEARCH_PROMPT_VERSION,
    generated_at: String(opts.generated_at ?? "").trim() || "未记录",
  };

  const obj = extractJsonObject(String(raw ?? ""));
  if (!obj) {
    // 解析不出对象：整批判失败。不产出「一份空报告」冒充研究结果，也不补默认结论。
    return {
      ok: false,
      no_evidence: !lines.length,
      error: "模型输出解析失败：没有取到 JSON 对象（本次不产出任何研究结论，不用默认值凑）",
      report: {
        ...base,
        headline: "",
        market_posture: "未记录",
        posture_cites: [],
        interpretation: [],
        risks: [],
        unknowns: [],
        next_checks: [],
        interpretation_status: "REJECTED",
        data_layer: "AI_INTERPRETATION",
        dropped,
        violations: ["模型回复里没有可解析的 JSON 对象"],
      },
    };
  }

  const interpretation = parseSectionItems({ raw: obj.interpretation, layerLabel: "interpretation", ledger: lines, idSet, violations, dropped, byId });
  const risks = parseSectionItems({ raw: obj.risks, layerLabel: "risks", ledger: lines, idSet, violations, dropped, byId });
  const unknowns = (Array.isArray(obj.unknowns) ? obj.unknowns : [])
    .map((u) => String(u ?? "").replace(/\s+/g, " ").trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 20);
  const nextChecks = (Array.isArray(obj.next_checks) ? obj.next_checks : [])
    .map((u) => String(u ?? "").replace(/\s+/g, " ").trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 20);
  const posture = clampPosture(obj.market_posture);
  const postureSrc = String(obj.market_posture ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const postureCitesRaw = Array.isArray((obj as Record<string, unknown>).posture_cites) ? (obj.posture_cites as unknown[]).map((c) => String(c).trim()) : [];
  const posture_cites = postureCitesRaw.filter((c) => idSet.has(c));
  for (const c of postureCitesRaw) if (!idSet.has(c) && c && !dropped.invalid_cites.includes(c)) dropped.invalid_cites.push(c);
  if (posture.clamped) violations.push(`market_posture 取值不在登记表里（只认 偏进攻/均衡/偏防守/观察），已按「未登记取值」保留原文，不猜成四态之一`);

  const headlineSrc = String(obj.headline ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const headlineStripped = stripProbabilityClaims(headlineSrc);
  if (headlineStripped.claims.length) dropped.probability_claims.push(...headlineStripped.claims);

  if (dropped.probability_claims.length) {
    violations.push(`模型输出了概率/涨幅预测（§九/§十四 禁止），原文已剔除并留档：${[...new Set(dropped.probability_claims)].join("；")}`);
  }
  if (dropped.invalid_cites.length) {
    violations.push(`${dropped.invalid_cites.length} 个引用 id 不在本批台账里（AI 不得发明证据），已剔除并留档：${dropped.invalid_cites.join("、")}`);
  }
  const noCite = [...interpretation, ...risks].filter((i) => !i.cites.length).length;
  if (noCite) violations.push(`${noCite} 条判断没有任何台账引用（§十三 要求每条解释可回溯），已保留原文并标记为不可回溯`);
  const unsourced = [...interpretation, ...risks].flatMap((i) => i.unsourced_numbers);
  if (unsourced.length) violations.push(`${unsourced.length} 处数字在本批台账里找不到出处（未删除，逐条标注供人核对）：${[...new Set(unsourced)].join("、")}`);
  const hist = [...interpretation, ...risks].flatMap((i) => i.historical_as_current);
  if (hist.length) violations.push(`${hist.length} 处把历史统计写成了当前预测（§二十二 历史 ≠ 当前），原文保留并标注：${[...new Set(hist)].join("、")}`);
  if (!lines.length) violations.push("本批没有任何台账行：没有真实读数就没有可解释的东西，研究层不会去猜一份市场环境报告");

  // 台账为空 = 本批没有任何真实读数（§十二 要求研究层建在已有引擎结果上）。
  // 这时模型说得再完整也不是「市场环境研究」，所以四个 AI 层与结论一律不采纳；
  // 但也不静默丢弃：原文按条留档进 dropped.fields，页面上照样能看到「AI 说了什么、为什么没采纳」。
  let aiLayers = { interpretation, risks, unknowns, next_checks: nextChecks };
  let headlineOut = headlineStripped.text;
  let postureOut = posture.value;
  if (!lines.length) {
    const kept = [
      ...interpretation.map((i) => `interpretation：${i.text}`),
      ...risks.map((i) => `risks：${i.text}`),
      ...unknowns.map((u) => `unknowns：${u}`),
      ...nextChecks.map((c) => `next_checks：${c}`),
    ];
    if (headlineSrc) kept.unshift(`headline：${headlineSrc}`);
    if (postureSrc) kept.unshift(`market_posture：${postureSrc}`);
    dropped.fields.push(`本批无台账行，AI 侧 ${kept.length} 项内容未采纳（判为 REJECTED），原文留档：${kept.join(" ｜ ").slice(0, 4000)}`);
    aiLayers = { interpretation: [], risks: [], unknowns: [], next_checks: [] };
    headlineOut = "";
    postureOut = "未记录";
  }

  const status = researchStatusOf({ lines, interpretation: aiLayers.interpretation, risks: aiLayers.risks, violations, dropped });
  const report: ResearchReport = {
    ...base,
    headline: headlineOut,
    market_posture: postureOut,
    posture_cites,
    interpretation: aiLayers.interpretation,
    risks: aiLayers.risks,
    unknowns: aiLayers.unknowns,
    next_checks: aiLayers.next_checks,
    interpretation_status: status,
    data_layer: "AI_INTERPRETATION",
    dropped: {
      invalid_cites: [...new Set(dropped.invalid_cites)],
      probability_claims: [...new Set(dropped.probability_claims)],
      fields: dropped.fields,
    },
    violations,
  };
  const rejectReason = !lines.length
    ? "本批没有台账行（服务端没取到真实读数），AI 侧内容一律未采纳：没有真实读数就没有市场环境报告"
    : "模型没有给出任何可核对的解释（不产出默认报告）";
  return { ok: status !== "REJECTED", no_evidence: !lines.length, error: status === "REJECTED" ? rejectReason : "", report };
}

/**
 * 三态判据（与 P6-B 同形，但判据按研究层自己的口径）：
 * 没有任何 interpretation ⇒ REJECTED（不是「空报告」）；
 * 有违规/有剔除/有缺口没写全 ⇒ PARTIAL；
 * 每条判断都带有效引用、且没有越界留档 ⇒ INTERPRETED。
 */
export function researchStatusOf(input: {
  lines: EvidenceLine[];
  interpretation: ResearchSectionItem[];
  risks: ResearchSectionItem[];
  violations: string[];
  dropped: { invalid_cites: string[]; probability_claims: string[]; fields: string[] };
}): ResearchStatus {
  if (!input.lines.length || !input.interpretation.length) return "REJECTED";
  const clean =
    !input.violations.length &&
    !input.dropped.invalid_cites.length &&
    !input.dropped.probability_claims.length &&
    input.interpretation.every((i) => i.fully_grounded) &&
    input.risks.every((i) => i.fully_grounded);
  return clean ? "INTERPRETED" : "PARTIAL";
}

// ---------- 呈现（UI 与报告共用同一份文本，避免两处措辞分叉） ----------

export function renderResearchTrace(report: ResearchReport, ledger: EvidenceLine[]): string {
  const byId = new Map(ledger.map((l) => [l.id, l]));
  const rows: string[] = [];
  rows.push(`【问题】${report.question || "未记录"}`);
  rows.push(`【台账（服务端现取）】共 ${report.evidence_total} 行：FACTS ${report.evidence_by_layer.FACTS} / SIGNALS ${report.evidence_by_layer.SIGNALS} / HISTORICAL_EVIDENCE ${report.evidence_by_layer.HISTORICAL_EVIDENCE}`);
  for (const l of ledger) rows.push(`  [${l.id}]（${l.layer}｜${l.data_status}｜${l.source}｜${l.as_of}｜${l.capability}）${l.text}`);
  rows.push(`【AI 结论】${report.headline || "（模型未给结论）"}｜市场姿态 ${report.market_posture}${report.posture_cites.length ? `（引用 ${report.posture_cites.join("、")}）` : "（无引用）"}`);
  for (const it of report.interpretation) {
    rows.push(`【AI 解释】${it.text}`);
    rows.push(`  引用：${it.cited_text.join(" ｜ ") || "（没有有效引用，不可回溯）"}`);
    if (it.unsourced_numbers.length) rows.push(`  无出处数字：${it.unsourced_numbers.join("、")}`);
    if (it.historical_as_current.length) rows.push(`  历史被写成当前预测：${it.historical_as_current.join("、")}`);
  }
  for (const it of report.risks) {
    rows.push(`【反向证据】${it.text}`);
    rows.push(`  引用：${it.cited_text.join(" ｜ ") || "（没有有效引用，不可回溯）"}`);
  }
  rows.push(`【未知与缺口（AI 侧）】${report.unknowns.length ? report.unknowns.map((u, i) => `${i + 1}. ${u}`).join(" ") : "（模型没写未知：服务端缺口见下）"}`);
  rows.push(`【服务端已知缺口】${ledger.filter((l) => l.data_status === "MISSING" || l.data_status === "DEGRADED").map((l) => l.text).join(" ") || "（本次台账里没有缺失标记行）"}`);
  rows.push(`【下一步该查】${report.next_checks.length ? report.next_checks.map((u, i) => `${i + 1}. ${u}`).join(" ") : "（无）"}`);
  if (report.dropped.invalid_cites.length || report.dropped.probability_claims.length) {
    rows.push(
      `【被剔除的内容（原文留档）】${[
        report.dropped.invalid_cites.length ? `编造引用 ${report.dropped.invalid_cites.join("、")}` : "",
        report.dropped.probability_claims.length ? `概率/涨幅表述 ${report.dropped.probability_claims.join("、")}` : "",
      ].filter(Boolean).join("｜")}`,
    );
  }
  rows.push(`【校验违规 ${report.violations.length} 条】${report.violations.join("；") || "无"}`);
  rows.push(`【状态分层】${report.interpretation_status}：${RESEARCH_STATUS_TEXT[report.interpretation_status]}｜整条属于 ${report.data_layer}，不是市场事实`);
  rows.push(`生成：${report.model}｜提示词 ${report.prompt_version}｜${report.generated_at}`);
  void byId;
  return rows.join("\n");
}

/**
 * 七层归位（页面按这个顺序分区渲染，保证 §十三 的「不混在一段话里」有唯一实现处）。
 * 返回类型显式写成可辨识联合：owner + 载荷键（lines / items / strings）互斥，
 * 页面据此分支即可，不需要「某键是否存在」的猜测 —— 分区语义不能靠前端兜。
 */
export type ResearchLayerSection =
  | { layer: "FACTS" | "SIGNALS" | "HISTORICAL_EVIDENCE"; owner: "服务端"; lines: EvidenceLine[]; items?: undefined; strings?: undefined }
  | { layer: "INTERPRETATION" | "RISKS"; owner: "AI"; items: ResearchSectionItem[]; lines?: undefined; strings?: undefined }
  | { layer: "UNKNOWN" | "NEXT_CHECKS"; owner: "AI"; strings: string[]; lines?: undefined; items?: undefined };

export function researchLayerSections(report: ResearchReport, ledger: EvidenceLine[]): ResearchLayerSection[] {
  return RESEARCH_LAYERS.map((layer): ResearchLayerSection => {
    if (layer === "FACTS" || layer === "SIGNALS" || layer === "HISTORICAL_EVIDENCE") {
      return { layer, owner: "服务端" as const, lines: ledger.filter((l) => l.layer === layer) };
    }
    if (layer === "INTERPRETATION") return { layer, owner: "AI" as const, items: report.interpretation };
    if (layer === "RISKS") return { layer, owner: "AI" as const, items: report.risks };
    if (layer === "UNKNOWN") return { layer, owner: "AI" as const, strings: report.unknowns };
    return { layer, owner: "AI" as const, strings: report.next_checks };
  });
}

export function researchLayeringNote(report: ResearchReport | null, counts: { rows: number }): string {
  return `已落库研究报告 ${counts.rows} 份；全部属于 AI_INTERPRETATION 层：FACTS/SIGNALS/HISTORICAL_EVIDENCE 三层由服务端从已注册能力现取，AI 只产出解释/风险/未知/下一步；本层不重算指标、不产概率，历史统计不等于当前预测${report ? `；最近一份：${report.interpretation_status}` : ""}`;
}

/** 字段完整度：页面用它说明「哪些段落是空的、空是真实状态还是没跑」。 */
export function researchFieldCompleteness(report: ResearchReport): { filled: string[]; empty: string[] } {
  const fields: Record<string, boolean> = {
    headline: !!report.headline,
    market_posture: report.market_posture !== "未记录",
    interpretation: report.interpretation.length > 0,
    risks: report.risks.length > 0,
    unknowns: report.unknowns.length > 0,
    next_checks: report.next_checks.length > 0,
  };
  return {
    filled: Object.entries(fields).filter(([, v]) => v).map(([k]) => k),
    empty: Object.entries(fields).filter(([, v]) => !v).map(([k]) => k),
  };
}

/** 多份报告的汇总口径（供能力探测与页面状态条引用同一句话）。 */
export function summarizeResearchReports(items: ResearchReport[]): {
  rows: number;
  interpreted: number;
  partial: number;
  rejected: number;
  invalid_cites: number;
  probability_claims_dropped: number;
  unsourced_numbers: number;
  violations: number;
} {
  const rows = items ?? [];
  const count = (s: ResearchStatus) => rows.filter((r) => r.interpretation_status === s).length;
  return {
    rows: rows.length,
    interpreted: count("INTERPRETED"),
    partial: count("PARTIAL"),
    rejected: count("REJECTED"),
    invalid_cites: rows.reduce((n, r) => n + r.dropped.invalid_cites.length, 0),
    probability_claims_dropped: rows.reduce((n, r) => n + r.dropped.probability_claims.length, 0),
    unsourced_numbers: rows.reduce((n, r) => n + [...r.interpretation, ...r.risks].reduce((m, i) => m + i.unsourced_numbers.length, 0), 0),
    violations: rows.reduce((n, r) => n + r.violations.length, 0),
  };
}

/** 供探测/页面引用：概率表述是否只用于剥离，本层没有任何「产出概率」的出口。 */
export const RESEARCH_PROBE = { findProbabilityClaims } as const;
