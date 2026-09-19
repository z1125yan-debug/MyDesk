// P4 第四阶段 历史复盘的纯内核：只做「参数解析 + 库行整形 + 口径文案」，不碰数据库、不重算任何信号。
//
// 为什么单独一个无依赖模块（和 P3 的 incremental-core 同一套分层理由）：
// node --test 只剥类型、解析不了 @/ 别名，纯函数放这里才能被单元测试直接 import 跑真实断言；
// 需要连库的读取放在 ./history.ts（客户端由调用方注入），本文件保持零依赖。
//
// REAL_DATA_ONLY 在本层的落点：
// 1) 查不到就是查不到 —— 解析不了/没数据都返回结构化空结果，绝不回退到「今天」的数据冒充历史；
// 2) 库里没有的字段（例如 radar_finding 没有逐行 source 列）不编造，只按已有字段推导并说明推导依据；
// 3) JSON 列损坏时如实报「无法解析」，不静默当成空数组（那会把真实存在的信息显示成"没有")。
import { modeFromBasis } from "./incremental-core.ts";

export type HistoryKind = "radar" | "events";
export const HISTORY_KINDS: HistoryKind[] = ["radar", "events"];

/** 状态筛选：radar 行有 live / superseded 两态；events 表根本没有 state 列（见 stateFilterBasis） */
export type StateFilter = "live" | "superseded" | "all";
export const STATE_FILTERS: StateFilter[] = ["live", "superseded", "all"];
export const STATE_TEXT: Record<StateFilter, string> = {
  live: "只看当前成立（state=live）",
  superseded: "只看已标记消失（state=superseded，保留不删）",
  all: "全部（当前成立 + 已标记消失一起看）",
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 请求参数里的 kind；无法识别时 null（调用方必须回 400，不能默认成 radar 蒙混） */
export function parseKind(raw: string | null | undefined): HistoryKind | null {
  return HISTORY_KINDS.includes(raw as HistoryKind) ? (raw as HistoryKind) : null;
}

/** 请求参数里的状态筛选；缺省 all（复盘要一次看全），无法识别同样交回 null 由接口拒绝 */
export function parseStateFilter(raw: string | null | undefined): StateFilter | null {
  if (raw === null || raw === undefined || raw === "") return "all";
  return STATE_FILTERS.includes(raw as StateFilter) ? (raw as StateFilter) : null;
}

export interface DateParseOk { ok: true; date: string }
export interface DateParseErr { ok: false; error: string }

/**
 * 查询日期必须是 YYYY-MM-DD，且不晚于服务端当日（上海时区）。
 * 未来日期直接拒绝而不是返回空列表：空列表的意思应是「这段历史库里确实没有」，
 * 而不是「你问了一个还没发生的日子」。
 */
export function parseQueryDate(raw: string | null | undefined, today: string): DateParseOk | DateParseErr {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "缺少 date 参数（历史查询必须指定 YYYY-MM-DD）" };
  if (!DATE_RE.test(s)) return { ok: false, error: `date 必须是 YYYY-MM-DD，收到的是「${s.slice(0, 32)}」` };
  const [y, m, d] = s.split("-").map(Number);
  // 日历合法性：2026-02-30 这种串格式对但不存在，必须拒掉，否则会被当成一次真实的"无数据"查询
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return { ok: false, error: `date 不是存在的日历日：${s}` };
  if (s > today) return { ok: false, error: `date 不得晚于服务端当日（${today}）：历史查询只读已落库的数据，不预测未来` };
  return { ok: true, date: s };
}

/** 库里的日期列表 → 最近有数据的一天（没有任何数据时返回 null，由调用方如实说明，不拿今天顶上） */
export function latestDate(dates: string[]): string | null {
  return dates.filter((d) => DATE_RE.test(d)).sort().reverse()[0] ?? null;
}

export interface DateBucket { date: string; rows: number; live: number; superseded: number | null; is_today: boolean }

/**
 * groupBy 结果（asOf + 行数 + live/superseded）→ 页面日期选择器用的倒序清单。
 * events 传 superseded=null：事件表没有 state 列，这里如实保持 null，页面据此不显示「消失」栏。
 */
export function availableDates(
  counts: { date: string; rows: number; live: number; superseded: number | null }[],
  today: string,
): DateBucket[] {
  return counts
    .filter((c) => DATE_RE.test(String(c.date)))
    .map((c) => ({
      date: c.date,
      rows: Math.max(0, Number(c.rows) || 0),
      live: Math.max(0, Number(c.live) || 0),
      superseded: c.superseded === null ? null : Math.max(0, Number(c.superseded) || 0),
      is_today: c.date === today,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** JSON 列解析：损坏/缺省都如实回报，不把"读不出来"伪装成"确实是空的" */
export interface ParsedJson<T> { value: T; broken: boolean }
export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): ParsedJson<T> {
  const s = String(raw ?? "").trim();
  if (!s) return { value: fallback, broken: false };
  try {
    return { value: JSON.parse(s) as T, broken: false };
  } catch {
    return { value: fallback, broken: true };
  }
}

/** radar_finding 的库行（history.ts 取到的字段原样传进来） */
export interface RadarDbRowLite {
  id: string; asOf: string; kind: string; title: string; detail: string;
  evidence: string; state: string; createdAt: Date;
}
/** 页面用的一条雷达历史行：state / asOf 原样带出，绝不因为「好看」而隐藏消失行 */
export interface RadarHistoryItem {
  id: string; as_of: string; kind: string; title: string; detail: string;
  evidence: Record<string, unknown>; evidence_broken: boolean;
  state: string; state_label: string; superseded: boolean;
  created_at: string; source: string; source_basis: string;
}

/** 行里没有 state 以外的"是否消失"标记：其它值一律如实显示原值，不猜成 live */
export function stateLabel(state: string): string {
  if (state === "live") return "当前成立";
  if (state === "superseded") return "已标记消失";
  return `未知状态（原值 ${state || "空"}）`;
}

/**
 * 雷达信号的「来源」。
 * radar_finding 没有逐行来源列（schema 里只有 kind/title/detail/evidence/state），
 * 所以这里只按已存的 kind + evidence 字段推导出信号出自哪条计算链，并把推导依据一并返回，
 * 不把推断写成库内字段。当日的真实扫描记录（谁触发的、什么口径）另见 task_run，见 dayRunItems。
 */
export function radarSourceOf(kind: string, evidence: Record<string, unknown>): { source: string; basis: string } {
  const has = (k: string) => evidence[k] !== undefined && evidence[k] !== null && evidence[k] !== "";
  switch (kind) {
    case "risk":
    case "anomaly":
      return { source: "市场情绪计算链（computeSentiment）", basis: "按 kind=risk/anomaly 且证据字段为全市场统计量（涨跌家数、炸板率等）推导；行内无来源列" };
    case "theme":
      return { source: has("code") ? `板块主线发现（discoverThemes，证据 code=${String(evidence.code)}）` : "板块主线发现（discoverThemes）", basis: "按 kind=theme 与证据里的板块 code/涨幅推导；行内无来源列" };
    case "fund":
      return { source: has("code") ? `板块资金榜（证据 code=${String(evidence.code)}）` : "板块资金榜", basis: "按 kind=fund 与证据里的资金字段推导；行内无来源列" };
    case "news":
      return {
        source: has("keywords") ? `快讯产业链映射 + 板块资金验证（关键词 ${(evidence.keywords as unknown[]).map(String).join("、") || "未记录"}）` : "快讯产业链映射 + 板块资金验证",
        basis: "按 kind=news 与证据里的关键词/板块推导；行内无来源列",
      };
    default:
      return { source: "未知（库内该行没有来源字段）", basis: `kind=${kind || "空"}，无对应的推导依据，不做猜测` };
  }
}

export function radarHistoryItem(r: RadarDbRowLite): RadarHistoryItem {
  const ev = parseJsonColumn<Record<string, unknown>>(r.evidence, {});
  const src = radarSourceOf(r.kind, ev.value);
  return {
    id: r.id, as_of: r.asOf, kind: r.kind, title: r.title, detail: r.detail,
    evidence: ev.value, evidence_broken: ev.broken,
    state: r.state, state_label: stateLabel(r.state), superseded: r.state === "superseded",
    created_at: r.createdAt.toISOString(),
    source: src.source, source_basis: src.basis,
  };
}

/** global_event 的库行 */
export interface EventDbRowLite {
  id: string; asOf: string; title: string; time: string; level: string; category: string;
  mappedSectors: string; relatedStocks: string; fundCheck: string; stage: string; source: string; createdAt: Date;
}
export interface EventHistoryItem {
  id: string; as_of: string; title: string; time: string; level: string; category: string;
  mapped_sectors: string[]; related_stocks: string[]; fund_check: Record<string, unknown>;
  stage: string; source: string; created_at: string;
  chain_mapped: boolean; broken_columns: string[];
}

/**
 * 事件历史行：产业链映射信息（mappedSectors / relatedStocks）与资金验证（fundCheck）都是入库时算好的真实值，
 * 历史查询只读出、不重算。未命中映射在库里就是空数组 —— 空数组显示成「未命中映射」而不是删掉这行。
 */
export function eventHistoryItem(r: EventDbRowLite): EventHistoryItem {
  const sectors = parseJsonColumn<string[]>(r.mappedSectors, []);
  const stocks = parseJsonColumn<string[]>(r.relatedStocks, []);
  const fund = parseJsonColumn<Record<string, unknown>>(r.fundCheck, {});
  const broken: string[] = [];
  if (sectors.broken) broken.push("mappedSectors");
  if (stocks.broken) broken.push("relatedStocks");
  if (fund.broken) broken.push("fundCheck");
  return {
    id: r.id, as_of: r.asOf, title: r.title, time: r.time, level: r.level, category: r.category,
    mapped_sectors: Array.isArray(sectors.value) ? sectors.value.map(String) : [],
    related_stocks: Array.isArray(stocks.value) ? stocks.value.map(String) : [],
    fund_check: fund.value && typeof fund.value === "object" && !Array.isArray(fund.value) ? fund.value : {},
    stage: r.stage, source: r.source, created_at: r.createdAt.toISOString(),
    chain_mapped: Array.isArray(sectors.value) && sectors.value.length > 0,
    broken_columns: broken,
  };
}

/** task_run 行 → 复盘用的「当次运行」条目：口径由 basis 反解（写读同源，见 incremental-core.MODE_TEXT） */
export interface RunDbRowLite {
  id: string; kind: string; tradeDate: string; status: string; trigger: string;
  startedAt: Date; finishedAt: Date | null; scanned: number; results: number;
  missing: string; error: string; basis: string; note: string;
}
export interface HistoryRunItem {
  id: string; status: string; trigger: string; trigger_label: string;
  started_at: string; finished_at: string | null;
  scanned: number; results: number; error: string; basis: string; note: string;
  mode: "full" | "incremental" | ""; mode_label: string; missing: string[];
}

export function dayRunItems(rows: RunDbRowLite[]): HistoryRunItem[] {
  return rows.map((r) => {
    const mode = modeFromBasis(r.basis);
    return {
      id: r.id, status: r.status, trigger: r.trigger,
      trigger_label: r.trigger === "schedule" ? "收盘后自动" : r.trigger === "manual" ? "手动触发" : `其它（${r.trigger || "空"}）`,
      started_at: r.startedAt.toISOString(),
      finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
      scanned: r.scanned, results: r.results, error: r.error, basis: r.basis, note: r.note,
      mode, mode_label: mode ? (mode === "full" ? "全量" : "增量") : "未记录（该次运行早于增量口径上线，basis 里没写口径）",
      missing: (() => { const v = parseJsonColumn<unknown>(r.missing, []).value; return Array.isArray(v) ? v.map(String) : []; })(),
    };
  });
}

/**
 * 本次查看的口径说明（页面顶部必须显示，REAL_DATA_ONLY：查看口径不能靠用户自己脑补）。
 * is_today=false 时明确写「历史归档只读」，绝不出现「实时」二字。
 */
export function viewBasis(kind: HistoryKind, date: string, isToday: boolean, filter: StateFilter): string {
  const table = kind === "radar" ? "radar_finding" : "global_event";
  if (isToday) {
    return `今日（${date}）· ${table} 当日库行，随每次扫描刷新（写库口径见当日 task_run）`;
  }
  const extra = kind === "radar" && filter !== "all" ? `；${STATE_TEXT[filter]}` : "";
  return `历史归档（只读）· ${table} 中 asOf=${date} 的库行，不重算、不回补、不会被今天的扫描改写${extra}`;
}

/**
 * 指定日期一条都没有时的如实结论（不回退今天，也不把"没数据"写成"没问题"）。
 * 三种「空」的原因不能混为一谈（REAL_DATA_ONLY）：
 * - 查的是今天：今天的行会被每次扫描重写，现在为空只说明「当前库里没有」，不能说"今天没被扫描过"；
 * - 那天有扫描记录但库里空：那次扫描本身落库 0 条，或后来按全量口径重刷时当日行被重写；
 * - 那天没有任何记录：才可以说"没有被扫描过（或全部失败）"。
 */
export function emptyDayNote(
  kind: HistoryKind, date: string, filter: StateFilter, totalRowsOnDay: number,
  opts?: { isToday?: boolean; runCount?: number },
): string {
  if (totalRowsOnDay > 0) {
    return `asOf=${date} 共有 ${totalRowsOnDay} 行，但都不在当前筛选（${STATE_TEXT[filter]}）里：换「全部」再看，不代表这天没有记录`;
  }
  const table = kind === "radar" ? "雷达信号" : "全球事件";
  const runs = opts?.runCount ?? 0;
  const why = opts?.isToday
    ? `今天是 ${date}，当日行会随每次扫描被重写（全量口径先删后插）：现在的真实状态就是 0 行，运行记录见上方 task_run`
    : runs > 0
      ? `那天有扫描记录（上方为最近的 ${runs} 条），但库里没有留下 asOf=${date} 的${table}行（那次扫描落库 0 条，或后来按全量口径重刷当日时被重写）`
      : "这一天没有被扫描过（或那天的扫描全部失败、未落库）";
  return `库里没有 asOf=${date} 的${table}记录：${why}。历史查询不会用别的数据顶上、也不会重新计算那一天。`;
}

/** events 没有 state 列：把这件事讲清楚，而不是让页面显示一个永远为空的「消失」计数 */
export function stateFilterBasis(kind: HistoryKind, filter: StateFilter): string {
  if (kind === "radar") return `状态筛选 ${STATE_TEXT[filter]}（live=当前成立，superseded=当日曾成立但最近一次扫描未再算出，行仍在库里）`;
  return filter === "all"
    ? "事件表没有 state 列：快讯滑出上游窗口不代表它当时是错的，所以历史行全部原样保留（P3 增量口径对事件永不标记消失）"
    : `事件表没有 state 列，state=${filter} 对事件无意义：本次仍按全部历史行返回`;
}

/** 日期选择器上「今天 / 最近有数据 / 指定日期」三种入口的可用性判定（纯函数，页面据此置灰不可用项） */
export function historyNavState(today: string, dates: DateBucket[]) {
  const withData = dates.find((d) => d.rows > 0) ?? null;
  const todayBucket = dates.find((d) => d.date === today) ?? null;
  return {
    has_any: dates.some((d) => d.rows > 0),
    latest_with_data: withData?.date ?? "",
    today_has_data: !!todayBucket && todayBucket.rows > 0,
    note: dates.some((d) => d.rows > 0)
      ? ""
      : "库里还没有任何归档行：日期选择器只是入口，不会凭空造出可查询的历史日期",
  };
}

/**
 * 页面「查看中」的一句话摘要：条数只讲库里真有的行，不掺任何"实时"字样。
 * 供 Radar / Events 两个页面共用，避免两处各写一句而口径漂移。
 */
export function daySummaryText(
  kind: HistoryKind, date: string, isToday: boolean,
  counts: { live: number; superseded: number | null; shown: number },
): string {
  const head = `${date} · ${counts.shown} 条${kind === "radar" ? "信号" : "事件"}`;
  const state = kind === "radar"
    ? `（当前成立 ${counts.live}${counts.superseded === null ? "" : `、已标记消失 ${counts.superseded}`}）`
    : "";
  const tail = isToday ? "：今天这一天的库行，会随每次扫描被重写或增量更新" : "：历史归档，只读不改写";
  return `${head}${state}${tail}`;
}
