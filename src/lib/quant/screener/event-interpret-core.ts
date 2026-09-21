// P6-B AI 事件理解的纯内核（无 DB、无 fetch、node --test 可直跑）。
//
// 任务书 §八 的边界是一句话：**AI 不负责发现不存在的事件**。
// 事件来自 global_event 库里已经落下的真实快讯行，AI 只做 8 件事：
// 分类 / 摘要 / 实体提取 / 行业与主题映射 / 潜在影响方向 / 影响范围 / 重要性解释 / 需要进一步验证的数据。
// 本层把这 8 件事变成可校验的结构（§九 的字段），并把 §九 §十 的两条禁令变成代码而不是提示词愿望：
//
// 1) 概率：§九「AI 不得自己生成概率」。confidence 只表示**AI 对自己这套解释的把握**，不是股票上涨概率。
//    所以模型文本里任何带数字的「上涨概率 80%」这类表述都会被剥掉，并原样记进 violations，
//    而不是悄悄删了让人以为模型没说过。
// 2) 可追溯：§十 要求「原始事件 → AI 提取 → AI 解释」。所以
//    - event_id 必须来自本批真实库行（否则整条解释被拒）；
//    - evidence 必须是原始标题里的子串（引不出标题之外的"原文证据"）；
//    - affected_symbols 必须在标题或该行已入库的 relatedStocks 里出现过，否则降级成 unknowns；
//    - 哪些字段是事实、哪些是 AI 解释，用字段归属表显式分开，UI 与提示词都只能引用这份表。
//
// 分层口径与 datastatus-core 一致：这里产出的东西永远标 AI_INTERPRETATION，不会升成 REAL。
import type { DataStatus } from "./datastatus-core.ts";

/** 提示词版本：改了提示词或校验口径必须自增，历史行要能看出是哪一版产出的 */
export const INTERPRET_PROMPT_VERSION = "p6b-1";

/**
 * POST /api/events/interpret 接受的模型原文长度上限（字符）。
 * 一次批量理解的正常回复在几千到两万字符量级；超过这个数说明进来的不是这份 JSON，
 * 与其解析出一堆垃圾落库，不如直接拒了让页面把原因写出来。
 */
export const MAX_RAW_CHARS = 200_000;

/** §九 要求的字段（顺序即输出顺序，报告/测试按这份清单核对完整性） */
export const REQUIRED_INTERPRET_FIELDS = [
  "event_id", "source", "published_at", "title", "summary",
  "entities", "industries", "themes", "affected_symbols",
  "impact_direction", "impact_scope", "importance", "confidence",
  "evidence", "unknowns", "follow_up_queries", "interpretation_status",
] as const;
export type RequiredInterpretField = (typeof REQUIRED_INTERPRET_FIELDS)[number];

/**
 * 字段归属：哪些值是事实（服务端从库里取的原样回填），哪些是 AI 解释（模型给的，只能当解释）。
 * 这张表是 §十「哪些是事实、哪些是 AI interpretation」的唯一出处，UI 不许自己再判一次。
 */
export const FACT_FIELDS: readonly RequiredInterpretField[] = ["event_id", "source", "published_at", "title"];
export const AI_FIELDS: readonly RequiredInterpretField[] = [
  "summary", "entities", "industries", "themes", "affected_symbols",
  "impact_direction", "impact_scope", "importance", "confidence", "evidence", "unknowns", "follow_up_queries",
];
/** AI 提供、但不在 §九 最小集里的字段：同样属于解释层，绝不允许被并进事实栏 */
export const AI_EXTRA_FIELDS = ["hypothesized_symbols", "importance_note"] as const;

/** 服务端自己算出来的核对结果（既不是原始事实也不是模型解释，属于派生） */
export const DERIVED_FIELDS = [
  "interpretation_status", "mapping_agreement", "dropped", "violations", "model", "prompt_version", "generated_at",
] as const;

/** §八 的 8 项 AI 工作 → 结构字段，用于「AI 只做了被允许的这几件事」的可核对表述 */
export const AI_JOBS: { job: string; fields: string[] }[] = [
  { job: "分类", fields: ["impact_scope", "importance"] },
  { job: "摘要", fields: ["summary"] },
  { job: "实体提取", fields: ["entities", "affected_symbols", "hypothesized_symbols"] },
  { job: "行业/主题映射", fields: ["industries", "themes"] },
  { job: "潜在影响方向", fields: ["impact_direction"] },
  { job: "影响范围", fields: ["impact_scope"] },
  { job: "重要性解释", fields: ["importance", "importance_note"] },
  { job: "需要进一步验证的数据", fields: ["unknowns", "follow_up_queries"] },
];

/** interpretation_status 的取值：本层能产出的只有这三种，其余状态由服务层/页面按「有没有跑 AI」补 */
export const INTERPRET_STATUSES = ["INTERPRETED", "PARTIAL", "REJECTED"] as const;
export type InterpretStatus = (typeof INTERPRET_STATUSES)[number];

/** 这一批事件整体没做 AI 理解时的状态（不属于某一条解释，属于一次调用的结果） */
export const NOT_RUN_STATUSES = {
  ai_unconfigured: "AI_NOT_CONFIGURED",
  ai_failed: "AI_FAILED",
  no_events: "NO_EVENTS",
} as const;

export const IMPACT_DIRECTIONS = ["利好", "利空", "双向", "中性", "未知"] as const;
export type ImpactDirection = (typeof IMPACT_DIRECTIONS)[number];

export const IMPACT_SCOPES = ["个股", "板块", "行业", "主题", "产业链", "市场整体", "海外", "未知"] as const;
export type ImpactScope = (typeof IMPACT_SCOPES)[number];

export const IMPORTANCE_LEVELS = ["高", "中", "低", "无法判断"] as const;
export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

/** 事件的真实来源（= global_event 行）。字段名与 /api/events 的返回对齐，服务层可直接传库行。 */
export interface EventFact {
  event_id: string;
  /** 快讯时间（库里的 time 列，形如 "21:00"；没有就空串，本层不猜日期） */
  published_at: string;
  title: string;
  source: string;
  /** 规则引擎的分级与分类（真实入库值，AI 不得改写） */
  level: string;
  category: string;
  /** 手工映射表命中的板块名（用于核对 AI 的主题映射有没有超出既有映射） */
  mapped_sectors: string[];
  /**
   * 该行入库时已关联的名称（global_event.relatedStocks 存的是 fundCheck 命中的板块/领涨名称，
   * 不是股票名）：作为「有出处的名字」白名单参与标的核对。
   */
  related_names: string[];
  /** 资金验证结论原文（事实层的一部分：这是引擎算出来的，不是 AI 说的） */
  fund_note: string;
  stage: string;
  /** 归档日（asOf）；服务端用于回看，本层不参与判定 */
  trade_date?: string;
}

/** §九 的完整结构。除 FACT_FIELDS 与 DERIVED_FIELDS 外都是 AI 解释。 */
export interface EventInterpretation {
  event_id: string;
  source: string;
  published_at: string;
  title: string;
  summary: string;
  entities: string[];
  industries: string[];
  themes: string[];
  affected_symbols: string[];
  /** AI 提出、但在本批事件的标题与既有映射里都没有出处的标的：属于 AI_HYPOTHESIS，不并入 affected_symbols */
  hypothesized_symbols: string[];
  impact_direction: ImpactDirection;
  impact_scope: ImpactScope;
  importance: ImportanceLevel;
  /** AI 对自己这套解释的把握度（0..1）。**不是上涨概率**，见 §九。 */
  confidence: number | null;
  evidence: string[];
  unknowns: string[];
  follow_up_queries: string[];
  interpretation_status: InterpretStatus;

  // —— 以下为服务端派生字段（不是 §九 的最小集，报告里说明为「核对结果」）——
  /** 重要性解释的补充说明（§八 第 7 项要求"解释"，只有等级不够） */
  importance_note: string;
  /** AI 的主题映射 vs 手工映射表的重合情况 */
  mapping_agreement: { matched: string[]; ai_only: string[]; map_only: string[]; note: string };
  /** 被本层剔除的内容：越界事件、无出处的标的/证据、概率断言 */
  dropped: { evidence: string[]; symbols: string[]; probability_claims: string[]; fields: string[] };
  /** 校验发现的违规原文（供人判断模型有没有越界，不静默） */
  violations: string[];
  model: string;
  prompt_version: string;
  generated_at: string;
  trade_date: string;
}

// ---------- 提示词 ----------

const RULES: string[] = [
  "事件是系统从真实快讯入库的既有事实：你不得新增事件、不得改写标题、不得补充标题里没有发生的事。",
  "你只做八件事：分类、摘要、实体提取、行业/主题映射、潜在影响方向、影响范围、重要性解释、指出需要进一步验证的数据。",
  "evidence 里的每条都必须是从该条 title 原样摘出的连续文字（用于回溯），不要写你自己知道的外部信息。",
  "affected_symbols 只列 title 里确实出现的公司/标的名称，或 mappedSectors/relatedNames 里已有的名称；你另外想到的标的写进 hypothesized_symbols（那属于猜测，会被标成未验证）。",
  "禁止输出任何概率数字：不许写「上涨概率 80%」「明天涨停概率」这类表述。confidence 是你对自己这段解释的把握度（0 到 1 的小数），不是股票涨跌概率。",
  "历史统计与回测结论只能来自系统给你的数据，你自己不产概率、不产收益预测。",
  "impact_direction 只能取 利好/利空/双向/中性/未知；impact_scope 只能取 个股/板块/行业/主题/产业链/市场整体/海外/未知；importance 只能取 高/中/低/无法判断。",
  "拿不准的写进 unknowns，并把它转成 follow_up_queries（该去查什么数据），不要用「通常」「一般」填补。",
  "只输出 JSON 数组，不要解释文字、不要 markdown 代码块之外的内容。每个对象必须包含 event_id 与上述字段。",
];

/**
 * 组装给模型的文本：只列本批真实事件的 id/时间/标题/既有映射。
 * 刻意不把标题之外的任何推断塞进提示词——否则模型会把它当原文引用回来。
 */
export function buildEventInterpretPrompt(facts: EventFact[]): string {
  const lines = facts.map((f, i) => {
    const parts = [
      `event_id=${f.event_id}`,
      `time=${f.published_at || "未记录"}`,
      `level=${f.level || "未记录"}`,
      `category=${f.category || "未记录"}`,
      `title=${f.title}`,
    ];
    if (f.mapped_sectors.length) parts.push(`mappedSectors=${f.mapped_sectors.join("、")}`);
    if (f.related_names.length) parts.push(`relatedNames=${f.related_names.join("、")}`);
    if (f.fund_note) parts.push(`fundCheck(${f.stage || "未记阶段"})=${f.fund_note}`);
    return `${i + 1}. ${parts.join(" | ")}`;
  });
  return [
    `你是行情事件理解层。下面 ${facts.length} 条事件已经由系统从真实快讯入库（来源见每条自带字段），现在对它们逐条做结构化理解。`,
    "",
    "【硬规则】",
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
    "",
    "【输出 JSON 数组，每个对象字段】",
    OUTPUT_FIELDS.join(", "),
    "",
    "【本批真实事件】",
    ...lines,
    "",
    "【数据纪律】",
    "标题里没有的实体不要出现在 affected_symbols；没有出处的判断写进 unknowns；你的输出属于解释，不构成市场事实。",
  ].join("\n");
}

/** 系统提示词（与 /api/ai/proxy 的单轮调用配合） */
// 输出字段清单（提示词与解析共用一份，避免提示词写了、解析没认）
const OUTPUT_FIELDS = [
  "event_id", "summary", "entities[]", "industries[]", "themes[]", "affected_symbols[]", "hypothesized_symbols[]",
  "impact_direction", "impact_scope", "importance", "importance_note", "confidence", "evidence[]", "unknowns[]", "follow_up_queries[]",
];

export const INTERPRET_SYSTEM_PROMPT =
  "你只做已入库真实事件的结构化理解，不发明事件、不补行情、不输出概率数字；不确定就写进 unknowns。只输出 JSON。";

// ---------- 校验与解析 ----------

/**
 * 概率与数值预测断言：§九 禁止 AI 自生成概率；「短期涨幅 3%」这类**对未来的幅度预测**同样按越界处理——
 * 事件的数字只能来自库里的事实字段，模型口里的百分比没有出处。
 * 反过来，**已经发生**的行情描述（「航运板块今日上涨 3.2%」）不在剔除范围内：那是模型在复述市场表现，
 * 不是它发明的概率；误把它删掉等于用「防概率」的名义改坏正文。
 * 因此剔除时的措辞包含"概率或涨幅预测"两类，不把它说成单纯的概率。
 *
 * 连接词用 `[^。，、；\s0-9]` 而不是任意非数字：`概率[^0-9]{0,6}\d+` 会把
 * 「概率较高，涉及 5 个板块」整段吃掉（逗号到 5 之间不足 6 个字符），标点必须截断。
 * 首条模式把「明天上涨」这类前导时间/方向词并入同一区间：只剥「涨概率 80%」会在正文里留下
 * 「明天上」这种半截残字，读者以为模型还说过别的话。
 */
const PROBABILITY_PATTERNS: RegExp[] = [
  // 「（时间/方向词）（概率|可能性）数字%」整句算一处断言
  /(?:明天|明日|次日|后天|近期|短期|中期|长期|后市)?\s*(?:上涨|下跌|涨|跌)?[^。，、；\s0-9]{0,3}(?:概率|可能性)[^。，、；\s0-9]{0,6}\s*\d+(?:\.\d+)?\s*%/g,
  /概率为?\s*\d+(?:\.\d+)?\s*%/g,
  /\d+(?:\.\d+)?\s*%\s*的?(?:概率|可能性)\s*(?:上涨|下跌|涨|跌|回落|走高|反弹)?/g,
  // 时间词 + 涨/跌幅 + 数字%：对未来幅度做预测（不含「今日上涨 3.2%」这类已发生的行情）
  /(?:明天|明日|次日|后天|近期|短期|中期|长期|后市).{0,8}?(?:涨幅|跌幅|上涨|下跌|回落|反弹|走高|涨|跌)\s*(?:约|超过|预计|达到|约在)?\s*\d+(?:\.\d+)?\s*%/g,
];

/** 剔除占位：删掉的同时必须说明为什么删，否则读者以为模型没说过 */
const PROBABILITY_PLACEHOLDER = "（AI 给出的概率或涨幅预测已剔除：本系统禁止 AI 生成概率与预测）";

/**
 * 命中区间。同一处文字会被多条规则重复命中（「上涨概率 80%」既是「概率+数字」也是「数字%」写法），
 * 不去重就会出现两条几乎相同的留档 + 同一个位置被替换两次，所以按区间合并只留覆盖最广的一条。
 */
function probabilitySpans(text: string): { start: number; end: number; text: string }[] {
  const src = String(text ?? "");
  const spans: { start: number; end: number; text: string }[] = [];
  for (const re of PROBABILITY_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const raw = m[0];
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const start = (m.index ?? 0) + (raw.length - raw.trimStart().length);
      spans.push({ start, end: start + trimmed.length, text: trimmed });
    }
  }
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: typeof spans = [];
  let lastEnd = -1;
  for (const sp of spans) {
    if (sp.start < lastEnd) continue;
    out.push(sp);
    lastEnd = sp.end;
  }
  return out;
}

/** 抽出模型文本里的概率断言原文（剥掉前先留档，便于人核对模型说过什么） */
export function findProbabilityClaims(text: string): string[] {
  return [...new Set(probabilitySpans(text).map((s) => s.text))];
}

/** 把概率断言换成明确占位，不静默删除 */
export function stripProbabilityClaims(text: string): { text: string; claims: string[] } {
  const src = String(text ?? "");
  const spans = probabilitySpans(src);
  if (!spans.length) return { text: src, claims: [] };
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    out += src.slice(cursor, sp.start) + PROBABILITY_PLACEHOLDER;
    cursor = sp.end;
  }
  out += src.slice(cursor);
  return { text: out.replace(/\s{2,}/g, " ").trim(), claims: spans.map((s) => s.text) };
}

/**
 * confidence 只接受 0..1 的小数：
 * 百分数写法（80）不猜它是 0.8，空串/非数字不猜它是 0——猜一次就等于替 AI 造了一个置信度。
 */
export function normalizeConfidence(raw: unknown): number | null {
  if (typeof raw === "boolean" || raw == null) return null;
  if (typeof raw === "number") {
    if (!isFinite(raw) || raw < 0 || raw > 1) return null;
    return Math.round(raw * 100) / 100;
  }
  const s = String(raw).trim();
  if (!s || !/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 100) / 100;
}

export function clampEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(raw ?? "").trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 字符串数组：去掉空项、去重、限长；非数组一律按缺失处理（不猜） */
function strArr(raw: unknown, max = 12): string[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x ?? "").replace(/\s+/g, " ").trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function oneLine(raw: unknown, max = 400): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 证据必须能在原始标题里找到（允许只去掉空白差异），否则视为无出处 */
export function evidenceGrounded(ev: string, fact: EventFact): boolean {
  const t = (fact.title ?? "").replace(/\s+/g, "");
  const e = String(ev ?? "").replace(/\s+/g, "");
  return e.length >= 2 && t.includes(e);
}

/** 标的必须有出处：出现在标题里，或在该行入库时已关联的名称（板块/领涨名）里 */
export function symbolGrounded(sym: string, fact: EventFact): boolean {
  const s = String(sym ?? "").trim();
  if (!s) return false;
  if ((fact.related_names ?? []).some((r) => r === s || r.includes(s) || s.includes(r))) return true;
  return (fact.title ?? "").includes(s);
}

/** AI 主题映射 vs 手工映射表：只报事实性的重合情况，不判谁对谁错 */
export function mappingAgreement(aiThemes: string[], aiIndustries: string[], fact: EventFact) {
  const aiSet = [...new Set([...aiThemes, ...aiIndustries])];
  const mapped = fact.mapped_sectors ?? [];
  const matched = aiSet.filter((a) => mapped.some((m) => m.includes(a) || a.includes(m)));
  const aiOnly = aiSet.filter((a) => !matched.includes(a));
  const mapOnly = mapped.filter((m) => !matched.some((a) => a.includes(m) || m.includes(a)));
  return {
    matched,
    ai_only: aiOnly,
    map_only: mapOnly,
    note: matched.length
      ? `AI 主题与既有映射表重合 ${matched.length} 项；AI 另提 ${aiOnly.length} 项（未经映射表/资金验证支持，属解释）`
      : `AI 主题与既有映射表${mapped.length ? "无一重合（既有映射来自手工表+资金验证）" : "无重合（该行未命中映射表）"}：两边都不判对错，引用时都按解释处理`,
  };
}

/** 从模型回复里取 JSON 数组：兼容被 ```json 包裹 / 前后有说明文字的情况 */
export function extractJsonArray(text: string): unknown[] | null {
  const cleaned = String(text ?? "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ParseResult {
  items: EventInterpretation[];
  /** 本批真实事件里没能拿到解释的（模型漏答/答了不存在的 id），页面必须逐条显示，不许静默变少 */
  missing: { event_id: string; title: string; reason: string }[];
  /** 模型给了但本批没有的 event_id（=AI 在试图发明事件）：整条拒收并原文报出 */
  unknown_ids: string[];
  ok: boolean;
  error: string | null;
  parse_failed: boolean;
}

/**
 * 模型原文 → 校验后的 §九 结构。
 * 事实字段一律服务端按真实库行回填：模型就算把 title 改了也不影响落库值（并记 violation）。
 */
export function parseEventInterpretations(
  raw: string,
  facts: EventFact[],
  opts: { model?: string; generated_at?: string } = {},
): ParseResult {
  const byId = new Map(facts.map((f) => [f.event_id, f]));
  const arr = extractJsonArray(raw);
  if (!arr) {
    return {
      items: [], missing: facts.map((f) => ({ event_id: f.event_id, title: f.title, reason: "模型回复里没有可解析的 JSON 数组" })),
      unknown_ids: [], ok: false, parse_failed: true,
      error: "模型输出解析失败：没有取到 JSON 数组（本次不产出任何解释，不用默认值凑）",
    };
  }
  const items: EventInterpretation[] = [];
  const unknown_ids: string[] = [];
  const covered = new Set<string>();

  for (const entry of arr) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const id = String(o.event_id ?? "").trim();
    const fact = byId.get(id);
    if (!fact) {
      // §八：AI 不负责发现不存在的事件。给了本批没有的 id 就整条拒收，不做「近似匹配」。
      unknown_ids.push(id || "（缺少 event_id）");
      continue;
    }
    if (covered.has(id)) continue; // 同一事件重复回答：留第一条，不叠加两份解释
    covered.add(id);

    const violations: string[] = [];
    const dropped = { evidence: [] as string[], symbols: [] as string[], probability_claims: [] as string[], fields: [] as string[] };

    // 概率/数值预测：四个自由文本字段一起扫，扫到就剥掉并留档（只删不记等于替模型隐瞒）
    const unknownsRaw = strArr(o.unknowns);
    const followUpsRaw = strArr(o.follow_up_queries);
    const stripField = (t: string) => {
      const { text, claims } = stripProbabilityClaims(t);
      dropped.probability_claims.push(...claims);
      return text;
    };
    const summary = stripField(oneLine(o.summary));
    const importanceNote = stripField(oneLine(o.importance_note));
    const unknownsOut = unknownsRaw.map(stripField).filter(Boolean);
    const followUpQueriesOut = followUpsRaw.map(stripField).filter(Boolean);
    dropped.probability_claims = [...new Set(dropped.probability_claims)];
    if (dropped.probability_claims.length) {
      violations.push(`模型输出了概率/涨幅预测（§九 禁止 AI 生成概率），原文已剔除并留档：${dropped.probability_claims.join("；")}`);
    }

    const evidenceIn: string[] = [];
    for (const e of strArr(o.evidence, 8)) {
      if (evidenceGrounded(e, fact)) evidenceIn.push(e);
      else dropped.evidence.push(e);
    }
    if (dropped.evidence.length) violations.push(`${dropped.evidence.length} 条 evidence 在原始标题里找不到出处，已剔除（不保留无出处证据）`);

    const symbolsOut: string[] = [];
    for (const s of strArr(o.affected_symbols)) {
      if (symbolGrounded(s, fact)) symbolsOut.push(s);
      else dropped.symbols.push(s);
    }
    // 没有出处的标的不删除、也不留在 affected_symbols：单列成 AI 假设，读者一眼看得出哪一层
    const hypothesized = [...new Set([...strArr(o.hypothesized_symbols), ...dropped.symbols])];
    if (dropped.symbols.length) {
      violations.push(`${dropped.symbols.length} 个标的在标题与既有映射里都没有出处，已移到 hypothesized_symbols（AI_HYPOTHESIS，未验证）`);
      const note = `AI 猜的这几个标的本批事件里没有出处：${dropped.symbols.join("、")}`;
      if (!unknownsOut.includes(note)) unknownsOut.push(note);
    }

    const confidence = normalizeConfidence(o.confidence);
    if (confidence === null) violations.push("confidence 缺失或不在 0..1 区间（不猜、不按 0 处理）");

    const titleEcho = oneLine(o.title);
    if (titleEcho && titleEcho !== fact.title) {
      violations.push("模型回传的 title 与库内原文不一致，已按库内原文保留（AI 不得改写事件）");
      dropped.fields.push("title");
    }
    const sourceEcho = oneLine(o.source);
    if (sourceEcho && sourceEcho !== fact.source) {
      violations.push("模型回传的 source 与库内原文不一致，已按库内原文保留");
      dropped.fields.push("source");
    }

    const industries = strArr(o.industries);
    const themes = strArr(o.themes);
    const core = {
      entities: strArr(o.entities),
      industries,
      themes,
      affected_symbols: symbolsOut,
      hypothesized_symbols: hypothesized,
      impact_direction: clampEnum(o.impact_direction, IMPACT_DIRECTIONS, "未知"),
      impact_scope: clampEnum(o.impact_scope, IMPACT_SCOPES, "未知"),
      importance: clampEnum(o.importance, IMPORTANCE_LEVELS, "无法判断"),
      summary,
      evidence: evidenceIn,
      unknowns: unknownsOut,
      follow_up_queries: followUpQueriesOut,
    };
    const status = interpretationStatusOf(core, violations);

    items.push({
      // 事实：服务端按真实库行回填
      event_id: fact.event_id,
      source: fact.source,
      published_at: fact.published_at,
      title: fact.title,
      // 解释
      ...core,
      importance_note: importanceNote,
      confidence,
      interpretation_status: status,
      // 派生
      mapping_agreement: mappingAgreement(themes, industries, fact),
      dropped,
      violations,
      model: opts.model ?? "未记录",
      prompt_version: INTERPRET_PROMPT_VERSION,
      generated_at: opts.generated_at ?? "",
      trade_date: fact.trade_date ?? "",
    });
  }

  const missing = facts
    .filter((f) => !covered.has(f.event_id))
    .map((f) => ({ event_id: f.event_id, title: f.title, reason: "模型未对该事件给出解释（不补默认解释）" }));

  return { items, missing, unknown_ids, ok: items.length > 0, parse_failed: false, error: null };
}

/**
 * 单条解释自身的完成度：够不够称 INTERPRETED。
 * 判据只用结构事实（有没有摘要/证据/方向是未知/有没有违规），不引入新语义。
 */
export function interpretationStatusOf(
  core: Pick<EventInterpretation, "summary" | "evidence" | "impact_direction" | "affected_symbols">,
  violations: string[],
): InterpretStatus {
  if (!core.summary) return "REJECTED";
  const weak =
    !core.evidence.length ||
    core.impact_direction === "未知" ||
    violations.length > 0;
  return weak ? "PARTIAL" : "INTERPRETED";
}

export const STATUS_TEXT: Record<InterpretStatus, string> = {
  INTERPRETED: "AI 已理解：字段齐全且有原文出处",
  PARTIAL: "AI 部分理解：有字段没站住（见核对结果），引用时必须带这句限制",
  REJECTED: "AI 解释被拒：没有可用摘要，不产出结论",
};

/** interpretation_status 的分层：AI 结论永远是 AI_INTERPRETATION，状态好也不会变成 REAL */
export function statusDataLayer(_s: InterpretStatus): DataStatus {
  return "AI_INTERPRETATION";
}

// ---------- §十 回溯文本 ----------

/**
 * 「原始事件 → AI 提取 → AI 解释 → 哪些没站住」的四段文本。
 * 同一份函数既给页面折叠面板（DeskCollapse）用，也给 AI 上下文注入用，避免两处两种说法。
 */
export function renderInterpretationTrace(itp: EventInterpretation): string {
  const conf = itp.confidence === null ? "未给出（不猜）" : `${itp.confidence.toFixed(2)}（AI 对这段解释的把握度，不是上涨概率）`;
  const ma = itp.mapping_agreement;
  return [
    `【原始事件（事实层）】${itp.published_at || "时间未记录"} · ${itp.title}`,
    `  来源：${itp.source}`,
    `  event_id：${itp.event_id}（global_event 库行，AI 不得新增事件）`,
    `【AI 提取】实体 ${itp.entities.length ? itp.entities.join("、") : "未给出"}｜有出处的标的 ${itp.affected_symbols.length ? itp.affected_symbols.join("、") : "无（标题与既有映射里没出现公司名）"}`,
    itp.hypothesized_symbols.length ? `【AI 假设标的（无出处，未验证）】${itp.hypothesized_symbols.join("、")}` : "",
    `【AI 解释】摘要：${itp.summary || "未给出"}`,
    `  行业/主题：${[...itp.industries, ...itp.themes].join("、") || "未给出"}`,
    `  影响方向 ${itp.impact_direction}｜范围 ${itp.impact_scope}｜重要性 ${itp.importance}${itp.importance_note ? `（${itp.importance_note}）` : ""}`,
    `  confidence=${conf}`,
    `【状态分层】${itp.interpretation_status}：${STATUS_TEXT[itp.interpretation_status]}｜整条属于 AI_INTERPRETATION，不是市场事实`,
    `【主题映射核对】与手工映射表重合 ${ma.matched.length ? ma.matched.join("、") : "无"}｜AI 另提 ${ma.ai_only.length ? ma.ai_only.join("、") : "无"}｜映射表另有 ${ma.map_only.length ? ma.map_only.join("、") : "无"}`,
    `  ${ma.note}`,
    itp.evidence.length ? `【证据（逐条可在原标题中找到）】${itp.evidence.map((e) => `「${e}」`).join("")}` : "【证据】模型没有给出可回溯到原文的片段：这条判断只能当假设",
    itp.unknowns.length ? `【仍需验证】${itp.unknowns.map((u) => `- ${u}`).join("\n")}` : "【仍需验证】模型未指出缺口（不代表没有缺口：见上面的核对结果）",
    itp.follow_up_queries.length ? `【下一步该查】${itp.follow_up_queries.map((q) => `- ${q}`).join("\n")}` : "",
    itp.dropped.symbols.length || itp.dropped.evidence.length || itp.dropped.probability_claims.length
      ? `【被降级 / 剔除的内容（原文留档）】${[
          itp.dropped.symbols.length ? `无出处标的（已降级为 AI 假设）${itp.dropped.symbols.join("、")}` : "",
          itp.dropped.evidence.length ? `无出处证据 ${itp.dropped.evidence.join("、")}` : "",
          itp.dropped.probability_claims.length ? `概率表述 ${itp.dropped.probability_claims.join("、")}` : "",
        ].filter(Boolean).join("｜")}`
      : "",
    itp.violations.length ? `【校验违规 ${itp.violations.length} 条】${itp.violations.join("；")}` : "",
    `生成：${itp.model}｜提示词 ${itp.prompt_version}｜${itp.generated_at || "时刻未记录"}`,
  ].filter(Boolean).join("\n");
}

/** 一条解释作为「事实 vs 解释」的分栏数据（页面按此渲染，不自己判归属） */
export function layerSplitOf(itp: EventInterpretation): { facts: string[]; ai: string[]; derived: string[] } {
  const facts = [
    `时间 ${itp.published_at || "未记录"}`,
    `标题 ${itp.title}`,
    `来源 ${itp.source}`,
    `event_id ${itp.event_id}`,
  ];
  const ai = [
    `摘要 ${itp.summary || "未给出"}`,
    `实体 ${(itp.entities || []).join("、") || "未给出"}`,
    `假设标的（无出处）${(itp.hypothesized_symbols || []).join("、") || "无"}`,
    `行业/主题 ${[...itp.industries, ...itp.themes].join("、") || "未给出"}`,
    `影响方向 ${itp.impact_direction}｜范围 ${itp.impact_scope}｜重要性 ${itp.importance}`,
    `confidence ${itp.confidence ?? "未给出"}（解释置信度，不是上涨概率）`,
    `待验证 ${(itp.unknowns || []).length} 条`,
  ];
  const derived = [
    `状态 ${itp.interpretation_status}`,
    `重合映射 ${(itp.mapping_agreement?.matched ?? []).length} 项`,
    `剔除 标的 ${(itp.dropped?.symbols ?? []).length}／证据 ${(itp.dropped?.evidence ?? []).length}／概率 ${(itp.dropped?.probability_claims ?? []).length}`,
    `违规 ${(itp.violations ?? []).length} 条`,
  ];
  return { facts, ai, derived };
}

// ---------- 一批解释的汇总口径 ----------

export function interpretLayeringNote(counts: { interpreted: number; partial: number; rejected: number; missing: number; unknown_ids: number }): string {
  return [
    `本批 AI 理解：INTERPRETED ${counts.interpreted} 条 / PARTIAL ${counts.partial} 条 / REJECTED ${counts.rejected} 条`,
    counts.missing ? `另有 ${counts.missing} 条真实事件没有拿到解释（按缺失处理，不补默认解释）` : "本批事件都拿到了解释",
    counts.unknown_ids ? `模型引用了 ${counts.unknown_ids} 个本批不存在的事件 id，已全部拒收（AI 不得发明事件）` : "模型没有引用本批之外的事件",
    "以上全部属于 AI_INTERPRETATION 层：事件本身是库里的事实，解释不是。",
  ].join("；");
}

export function summarizeInterpretations(items: EventInterpretation[], missingCount = 0, unknownIdsCount = 0) {
  const counts = {
    interpreted: items.filter((i) => i.interpretation_status === "INTERPRETED").length,
    partial: items.filter((i) => i.interpretation_status === "PARTIAL").length,
    rejected: items.filter((i) => i.interpretation_status === "REJECTED").length,
    missing: missingCount,
    unknown_ids: unknownIdsCount,
    with_probability_dropped: items.filter((i) => i.dropped.probability_claims.length > 0).length,
    violations: items.reduce((n, i) => n + i.violations.length, 0),
  };
  return { counts, layering: interpretLayeringNote(counts) };
}

/** §九 字段完整性自检：给测试与 /api/events/interpret 的 self_check 用 */
export function fieldCompleteness(itp: EventInterpretation): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const f of REQUIRED_INTERPRET_FIELDS) {
    const v = (itp as unknown as Record<string, unknown>)[f];
    if (v === undefined) { missing.push(f); continue; }
    if (isEmptyish(v)) empty.push(f);
  }
  return { missing, empty };
}

function isEmptyish(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
