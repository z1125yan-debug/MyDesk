// P6-A 数据状态口径的纯内核（无 DB、无 fetch、node --test 可直跑）。
//
// 为什么单独一层：P0~P5 里「没有数据」散落成 null / undefined / 0 / missing[] / catch→null / [] 好几种写法，
// 任务书 §六 禁止的是同一件事——上游 200 但 data=[] 被前端显示成「0」。一旦这个判定散在每个页面里，
// 就一定会出现「这一页把失败当 0、那一页把未覆盖当暂无」。所以集中一处，页面与 AI 层只能引用这里的结论。
//
// 关键约束（REAL_DATA_ONLY 的可执行版本）：
// - 真 0 / 没有数据 / 请求失败 / 数据源未覆盖 是四种不同的事，必须给四种不同的 kind，绝不能合并；
// - MISSING ≠ 0：显示层拿 no_data 只能渲染「暂无数据」，不允许渲染 0；
// - DEGRADED ≠ NORMAL：主源失败、靠兜底源或靠部分数据支撑时，kind 仍是 value，但 status 必须降为 DEGRADED；
// - AI_INTERPRETATION 不是数据状态而是**来源分层**，与 REAL/DERIVED/HISTORICAL 并列出现在 DATA_STATUSES 里，
//   目的是让「AI 说了什么」和「库里算了什么」在类型上就无法混为一谈。

/** 一个数据的来源分层（任务书 §三 的 8 类，逐字对齐） */
export const DATA_STATUSES = [
  "REAL", "DERIVED", "HISTORICAL", "SNAPSHOT", "AI_INTERPRETATION", "AI_HYPOTHESIS", "MISSING", "DEGRADED",
] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

/** UNVERIFIED 是「方法有没有被验证」，与「数据在不在」正交，单独一组常量，避免被塞进 DATA_STATUSES 里混淆 */
export const VERIFY_STATUSES = ["VERIFIED", "UNVERIFIED", "NOT_APPLICABLE"] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

export const DATA_STATUS_TEXT: Record<DataStatus, string> = {
  REAL: "真实数据直接计算得到",
  DERIVED: "由真实数据派生的二次计算",
  HISTORICAL: "历史回测 / 历史统计，不是当前",
  SNAPSHOT: "某一刻留档的结果，不是实时",
  AI_INTERPRETATION: "AI 对已有真实数据的解释，不是事实本身",
  AI_HYPOTHESIS: "AI 提出的假设，未经数据支持",
  MISSING: "数据不存在或当前取不到",
  DEGRADED: "数据源异常或部分缺失，结果已降级",
};

export function isDataStatus(raw: unknown): raw is DataStatus {
  return typeof raw === "string" && (DATA_STATUSES as readonly string[]).includes(raw);
}

/** 一次取数的实际观测结果：这五种情形必须互不相同（任务书 §六「真实 0 / 没有数据 / 请求失败 / 未覆盖」） */
export const OBSERVATION_KINDS = ["value", "real_zero", "no_data", "request_failed", "not_covered"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const OBSERVATION_TEXT: Record<ObservationKind, string> = {
  value: "有值",
  real_zero: "真实的 0（上游确实算了个 0）",
  no_data: "没有数据（请求成功但本次无内容 / 字段为空）",
  request_failed: "请求失败（超时、非 2xx、上游异常、解析不出）",
  not_covered: "数据源未覆盖（该字段本就没有可靠来源，或已停止披露）",
};

export interface ObserveInput<T> {
  /** 本次是否真的向数据源发起了请求（false 通常意味着前置校验就拒了） */
  requested: boolean;
  /** 请求是否成功（HTTP 2xx 且能解析）。失败时 value 不参与判定 */
  ok: boolean;
  /** 该数据源是否覆盖这个字段：北向净流入、板块日K连续强势天数这类「本来就没有」的东西填 false */
  covered: boolean;
  value?: T | null;
  /** 失败 / 未覆盖的原因原文（必须能贴出来，不能只写「异常」） */
  reason?: string;
}

/** 是否为「空值」：null / undefined / 空串 / 空数组 / 非Finite 数字。0 与 false 都**不算**空 */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return !isFinite(v);
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 把一次取数压成四态结论。判定顺序刻意是「请求失败 → 未覆盖 → 没发起请求 → 空 → 真 0 → 有值」：
 * 失败必须优先于「空」，否则一次超时会伪装成「今天没有数据」。
 */
export function observeValue<T>(input: ObserveInput<T>): { kind: ObservationKind; value: T | null; reason: string } {
  if (!input.ok) {
    return { kind: "request_failed", value: null, reason: input.reason?.trim() || "数据源请求失败（未取得任何值，不按 0 处理）" };
  }
  if (!input.covered) {
    return { kind: "not_covered", value: null, reason: input.reason?.trim() || "该字段没有可靠数据源，未覆盖" };
  }
  if (!input.requested) {
    return { kind: "no_data", value: null, reason: input.reason?.trim() || "本次未发起取数（前置条件不满足）" };
  }
  if (isEmptyValue(input.value)) {
    return { kind: "no_data", value: null, reason: input.reason?.trim() || "请求成功但没有返回内容（不是 0）" };
  }
  if (typeof input.value === "number" && input.value === 0) {
    return { kind: "real_zero", value: input.value as T, reason: input.reason?.trim() ?? "" };
  }
  return { kind: "value", value: input.value as T, reason: input.reason?.trim() ?? "" };
}

export function isUsable(kind: ObservationKind): boolean {
  return kind === "value" || kind === "real_zero";
}

/**
 * 显示层唯一的出口：把观测结果变成给人看的字符串。
 * no_data / request_failed / not_covered 一律不出现「0」，从函数层面堵死「把缺失补成 0」。
 */
export function displayOf(kind: ObservationKind, value?: unknown, opts?: { digits?: number; suffix?: string }): string {
  const suffix = opts?.suffix ?? "";
  if (kind === "real_zero") return `0${suffix}`;
  if (kind !== "value") return "暂无数据";
  if (typeof value === "number") return `${opts?.digits != null ? value.toFixed(opts.digits) : String(value)}${suffix}`;
  return `${String(value)}${suffix}`;
}

/** 一个数据块/一次工具调用的完整信封：状态、来源、时刻、新鲜度、缓存、降级说明都在同一处 */
export interface DataEnvelope<T = unknown> {
  status: DataStatus;
  verify: VerifyStatus;
  kind: ObservationKind;
  value: T | null;
  source: string;
  source_type: SourceType;
  /** 服务端观测到的时刻（北京时间，墙钟）；不是上游时间时要显式写进 note */
  as_of: string;
  /** 数据所属交易日（行情/信号类必填；派生统计用被统计的那一天） */
  trade_date?: string | null;
  /** 该结果距今多少秒（缓存年龄），未提供时不要瞎猜 */
  freshness_s?: number | null;
  /** 主源失败但兜底成功 ⇒ degraded_from + note 说明降级 */
  degraded_from?: string | null;
  note?: string;
}

export const SOURCE_TYPES = ["http_direct", "local_gateway", "database", "derived_engine", "llm", "mcp", "static_config"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_TEXT: Record<SourceType, string> = {
  http_direct: "本机直连公开 HTTP 接口",
  local_gateway: "本机自建网关（如通达信行情网关）",
  database: "本地 SQLite（Prisma）",
  derived_engine: "对已有数据做计算的本机引擎",
  llm: "用户自配的大模型接口",
  mcp: "MCP 服务器（外部工具）",
  static_config: "仓库内静态配置/账本",
};

export interface EnvelopeInput<T> {
  observed: { kind: ObservationKind; value: T | null; reason: string };
  status: DataStatus;
  source: string;
  source_type: SourceType;
  as_of: string;
  trade_date?: string | null;
  verify?: VerifyStatus;
  freshness_s?: number | null;
  degraded_from?: string | null;
  note?: string;
}

/**
 * 组装信封时强制自洽：观测到不可用 ⇒ status 只能是 MISSING / DEGRADED，
 * 否则就会出现「kind:request_failed 但 status:REAL」这种自相矛盾的响应。
 */
export function envelopeOf<T>(input: EnvelopeInput<T>): DataEnvelope<T> {
  const usable = isUsable(input.observed.kind);
  let status = input.status;
  if (!usable) status = input.degraded_from ? "DEGRADED" : "MISSING";
  else if (input.degraded_from) status = "DEGRADED";
  return {
    status,
    verify: input.verify ?? "NOT_APPLICABLE",
    kind: input.observed.kind,
    value: usable ? input.observed.value : null,
    source: input.source,
    source_type: input.source_type,
    as_of: input.as_of,
    ...(input.trade_date !== undefined ? { trade_date: input.trade_date } : {}),
    ...(input.freshness_s != null ? { freshness_s: input.freshness_s } : {}),
    degraded_from: input.degraded_from ?? null,
    note: [input.note, input.observed.reason].filter(Boolean).join(" · ") || undefined,
  };
}

/** 新鲜度上限：超过就不允许再被当作 live 呈现（任务书 §五 的 freshness 字段） */
export const FRESHNESS_LIMITS_S = { live: 90, intraday: 300, daily: 86400, static: 31536000 } as const;
export type FreshnessClass = keyof typeof FRESHNESS_LIMITS_S;

export function freshnessNote(freshness_s: number | null | undefined, limit: FreshnessClass): string {
  if (freshness_s == null || !isFinite(freshness_s)) return FRESHNESS_UNKNOWN_NOTE;
  const cap = FRESHNESS_LIMITS_S[limit];
  return freshness_s <= cap
    ? `新鲜度 ${Math.round(freshness_s)} 秒（在 ${limit} 口径的 ${cap} 秒内）`
    : `已超出 ${limit} 口径的新鲜度上限（${Math.round(freshness_s)} 秒 > ${cap} 秒）：按降级处理`;
}

/** 未知就是未知：把这句话抽成常量，UI 与内核共用一份，避免「? 秒」被写成「超出上限」 */
export const FRESHNESS_UNKNOWN_NOTE = "新鲜度未知（数据源没给出可核对的时刻，不猜是否仍算实时）";

/**
 * as_of 只给到日期时唯一能证的结论：日期等于服务端今天 ⇒ 观测时刻必然落在今天 00:00 之后，
 * 距今 < 24h，即 daily 口径（86400 秒）内。跨天时算不出具体秒数，只能判未知（不猜）。
 */
export function freshWithinDailyFromDateOnly(as_of: string | null | undefined, today: string): boolean {
  const d = (as_of ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d === today;
}

/**
 * 一行徽标文案（面板用）：判定结论由服务端给的 fresh 决定，本函数只负责措辞——
 * fresh=false 才能说「不再算实时」；fresh=null 说「未知」；static 口径不按实时判，不占位置。
 */
export function freshnessChip(fresh: boolean | null, limit: FreshnessClass, freshness_s: number | null = null): string {
  if (fresh === null) return limit === "static" ? "" : FRESHNESS_UNKNOWN_NOTE;
  if (fresh === true) return "";
  const cap = FRESHNESS_LIMITS_S[limit];
  return `超出 ${limit} 口径上限${freshness_s != null && isFinite(freshness_s) ? `（${Math.round(freshness_s)} 秒 > ${cap} 秒）` : ""}：不再算实时`;
}

/** 是否仍算 live：超上限的不能继续显示成实时 */
export function stillFresh(freshness_s: number | null | undefined, limit: FreshnessClass): boolean {
  if (freshness_s == null || !isFinite(freshness_s)) return false;
  return freshness_s <= FRESHNESS_LIMITS_S[limit];
}

/**
 * 一句话把「哪些是事实、哪些是历史统计、哪些是 AI 解释、哪些仍缺」讲清楚，
 * 供 UI 与 AI 层共用一份文案（避免同一个结论两处两种说法）。
 */
export function layeringNote(counts: Partial<Record<DataStatus, number>>): string {
  const parts = DATA_STATUSES.filter((s) => (counts[s] ?? 0) > 0).map((s) => `${s} ${counts[s]}`);
  if (!parts.length) return "本次没有任何一层数据被取到：先解决取数，再谈结论。";
  return `分层计数：${parts.join(" / ")}；MISSING 不会被并入 0，AI_INTERPRETATION 不构成事实。`;
}
