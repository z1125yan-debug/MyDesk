// 因子缓存的「口径」判定（纯函数）：这份缓存是**盘中**取的，还是**收盘**后取的？
//
// 用户 2026-09-29 指示：「量化因子选股确保每天点击之后有缓存，如果当天开盘能刷新出来，
// 那么收盘后需要再刷新一下，防止定在盘中」。
//
// 问题根因：缓存按行情源日期（quote_date）归档，盘中预热写进去的是**盘中快照**；
// 收盘后再筛，命中同一份缓存 → 用户看到的一整天都是上午 10 点的价钱（"定在盘中"）。
//
// 口径：
//   · 数据属于**上一交易日**（quote_date < as_of）：它本来就是那天的收盘值 → closed；
//   · 数据属于**当天**：看当前时段——已收盘 → closed；否则（盘中/午间/竞价/未开盘）→ intraday。

export type WarmPhase = "intraday" | "closed";

export interface WarmPhaseInput {
  /** 行情源数据实际所属交易日 YYYY-MM-DD */
  quoteDate: string;
  /** 本次求值口径日（通常是系统当天）YYYY-MM-DD */
  asOf: string;
  /** 当前时段 phase（marketSession().phase） */
  sessionPhase: "trading" | "auction" | "break" | "closed" | "unknown";
}

export function warmPhaseOf(input: WarmPhaseInput): WarmPhase {
  const quoteDate = String(input.quoteDate ?? "").slice(0, 10);
  const asOf = String(input.asOf ?? "").slice(0, 10);
  if (quoteDate && asOf && quoteDate < asOf) return "closed";
  if (input.sessionPhase === "closed") return "closed"; // 含「已收盘」与「未开盘」两种 closed 文案
  return "intraday";
}

export interface RewarmDecision {
  /** 要不要重新预热 */
  rewarm: boolean;
  reason: "none" | "no_cache" | "stale_intraday" | "date_mismatch";
}

/** 已有缓存元数据 vs 当前应属口径 → 是否需要重算 */
export function decideRewarm(
  meta: { trade_date: string; phase: WarmPhase } | null | undefined,
  want: { date: string; phase: WarmPhase },
): RewarmDecision {
  if (!meta) return { rewarm: true, reason: "no_cache" };
  if (meta.trade_date !== want.date) return { rewarm: true, reason: "date_mismatch" };
  // 盘中的那份数，到了收盘口径就必须重算——这正是「防止定在盘中」的那一步
  if (meta.phase === "intraday" && want.phase === "closed") return { rewarm: true, reason: "stale_intraday" };
  return { rewarm: false, reason: "none" };
}

/** ISO 时间戳 → 北京 HH:mm（页面/文案都是给北京用户看的，绝不能直接截 ISO 里的 UTC 时分） */
function beijingHM(iso: string): string {
  const t = String(iso ?? "").trim();
  if (!t) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (k: string) => parts.find((x) => x.type === k)?.value ?? "00";
  const h = g("hour") === "24" ? "00" : g("hour");
  return `${h}:${g("minute")}`;
}

/** 缓存口径的可读标签（进 warning / 页面角标，让用户知道手上这份数是什么口径） */
export function warmPhaseLabel(phase: WarmPhase, generatedAt?: string | null): string {
  const hm = beijingHM(String(generatedAt ?? ""));
  if (phase === "closed") return `收盘口径${hm ? ` ${hm}` : ""}`;
  return `盘中口径${hm ? ` ${hm}` : ""}（收盘后会自动重算）`;
}
