// 「每天第一次打开取一次就固定」的当日沉淀缓存（纯判定 + 可注入 storage，便于单测）。
//
// 用户 2026-09-29 指示（大盘情绪页）：
//   「首页四个卡片（情绪温度/成交额/连板高度/涨跌比）是实时更新的；
//     像下面这些**需要收盘后**的就固定——确保每天第一次打开刷新之后，再点击（进页面）
//     除了那四个卡片以外都是实时的，而不是得等待。」
//
// 也就是：下方那些「收盘后才沉淀出来」的历史口径（成交额趋势 / 5日线占比 / 涨跌停分布 /
// 连板梯队历史 / 指数区间涨跌）每天只回源一次，当天内一律走缓存**秒开**，不再让用户等。
//
// 两条纪律：
//   ① 缓存按**自然日**（北京时区）失效——「每天第一次打开」就是它刷新的时机；
//   ② **收盘后必须再取一次**：如果这份缓存是当天盘中（15:00 前）生成的，那么当天收盘后第一次打开
//      要把它换掉——否则页面会一整天定在盘中那份数上（用户原话「防止定在盘中」）。

export interface SettledEntry<T> {
  /** 缓存格式版本：口径变了自动作废，不误用老结构 */
  v: number;
  /** 数据生成时所属自然日（北京）YYYY-MM-DD */
  day: string;
  /** 数据生成时刻（北京）HH:mm */
  at: string;
  /** 生成时的 ISO 时间戳（排障用） */
  ts: string;
  data: T;
}

export type SettledReason = "hit" | "missing" | "corrupt" | "new_day" | "closed_after_intraday";

export interface SettledDecision {
  /** 能不能直接用缓存渲染（true = 秒开，不发请求） */
  use: boolean;
  /** 需要回源取新数据 */
  refetch: boolean;
  reason: SettledReason;
}

/** 北京时区的「当天日期 + 时分」，用于缓存失效判定 */
export function beijingDayTime(now = new Date()): { day: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  const h = get("hour") === "24" ? "00" : get("hour");
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hm: `${h}:${get("minute")}` };
}

/** 收盘时刻（北京 HH:mm）：A股 15:00 */
export const CLOSE_HM = "15:00";

const versionOf = (v: number) => v;

/**
 * 决定「用缓存」还是「回源」。
 * @param entry 缓存条目（null = 没有）
 * @param now   当前北京时间（day + hm）
 * @param closeHm 收盘时刻，默认 15:00
 */
export function decideSettled<T>(
  entry: SettledEntry<T> | null | undefined,
  now: { day: string; hm: string },
  closeHm: string = CLOSE_HM,
  version = versionOf(1),
): SettledDecision {
  if (!entry || typeof entry !== "object" || !entry.day || !("data" in entry)) {
    return { use: false, refetch: true, reason: entry ? "corrupt" : "missing" };
  }
  if (entry.v !== version) return { use: false, refetch: true, reason: "corrupt" };
  if (entry.day !== now.day) return { use: false, refetch: true, reason: "new_day" };
  // 同一天，但这份数是收盘前取的、现在已经收盘 → 必须换新（防止一整天定在盘中）
  if ((entry.at || "00:00") < closeHm && now.hm >= closeHm) {
    return { use: false, refetch: true, reason: "closed_after_intraday" };
  }
  return { use: true, refetch: false, reason: "hit" };
}

/* ---------- storage 层（浏览器 localStorage；测试可注入假 storage） ---------- */

export interface MinimalStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const SETTLED_VERSION = 1;
export const SETTLED_PREFIX = "mydesk-settled";

export function settledKey(name: string): string {
  return `${SETTLED_PREFIX}:v${SETTLED_VERSION}:${name}`;
}

function storageOf(injected?: MinimalStorage): MinimalStorage | null {
  if (injected) return injected;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // 隐私模式/禁用 storage：退化成「每次都回源」，不影响功能
  }
}

export function readSettled<T>(name: string, injected?: MinimalStorage): SettledEntry<T> | null {
  const s = storageOf(injected);
  if (!s) return null;
  try {
    const raw = s.getItem(settledKey(name));
    if (!raw) return null;
    const j = JSON.parse(raw) as SettledEntry<T>;
    return j && typeof j === "object" && j.day ? j : null;
  } catch {
    return null;
  }
}

export function writeSettled<T>(name: string, data: T, now = new Date(), injected?: MinimalStorage): SettledEntry<T> {
  const { day, hm } = beijingDayTime(now);
  const entry: SettledEntry<T> = { v: SETTLED_VERSION, day, at: hm, ts: now.toISOString(), data };
  const s = storageOf(injected);
  try {
    s?.setItem(settledKey(name), JSON.stringify(entry));
  } catch {
    /* 配额满/被禁用：缓存写不进去不影响页面 */
  }
  return entry;
}
