// P2-自动化 调度规则（纯函数、无别名/无网络/无 DB → 可被 node --test 直接覆盖）
// 目标：交易日收盘后固定窗口内自动跑 Radar / Events；同一天同一任务只成功一次；失败可有限重试；
//       无法确证交易日时不猜测，交上层记为 skipped。
// 时区口径：一律按北京时间（A股交易日历语义），不依赖宿主时区；北京固定 UTC+8 无夏令时。

// P15-R20 加 "roster"：收盘后把当日涨停名单（哪几只、几连板）钉进 market_limit_up，
// 晋级率 / 梯队断层 / 昨日涨停股今日表现这三组读数只有名单攒起来之后才算得出来。
// sectorsnap（R21b）：见顶引擎/回测吃的 sector-daily-snapshots.json 刷新（此前只写 custom.db，双数据源不一致）。
// pickfill（P36-C）：收盘后把「推荐过的具体票」按 T+1/T+2 真实行情回填，攒战绩证据链
// dailybars（P36-C）：收盘后先把粮仓更新到当天；它是 picksym/pickfill 的数据前提，
// 缺了这一段，后两个任务收盘后就是空转（粮仓没当天K线 → 算不出命中的票 → 没东西回填）。
export type TaskKind = "radar" | "events" | "breadth" | "review" | "roster" | "sectorsnap" | "dailysnap" | "dailybars" | "picksym" | "pickfill";

export interface SchedulerConfig {
  /** 收盘时刻（北京时间当日分钟数，15:00 = 900） */
  closeMinute: number;
  /** 收盘后等待多少分钟再扫描（等数据源落定） */
  delayMinutes: number;
  /** 同一 (kind, tradeDate) 最多尝试次数（含首次），超过则跳过，不再打数据源 */
  maxAttempts: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  closeMinute: 15 * 60, // A股 15:00 收盘
  delayMinutes: 20,
  maxAttempts: 3,
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export interface BeijingParts { date: string; minuteOfDay: number; weekday: number } // weekday 0=周日 … 6=周六

/** 任意时刻 → 北京时间的「日期 / 当日分钟数 / 星期」 */
export function beijingParts(now: Date): BeijingParts {
  const d = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return { date: ymd(d), minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/** 北京时间「某日 00:00」对应的 UTC 时刻 */
export function beijingMidnightUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) - BEIJING_OFFSET_MS;
}

/** 北京时间「某日 HH:MM」对应的 UTC 时刻 */
export function beijingInstant(date: string, minuteOfDay: number): Date {
  return new Date(beijingMidnightUtc(date) + minuteOfDay * 60_000);
}

/** 日期字符串加减天数（仍在北京日期空间内） */
export function addBeijingDays(date: string, days: number): string {
  return ymd(new Date(beijingMidnightUtc(date) + BEIJING_OFFSET_MS + days * 86_400_000));
}

/** 北京日期的星期（0=周日） */
export function weekdayOf(date: string): number {
  return new Date(beijingMidnightUtc(date) + BEIJING_OFFSET_MS).getUTCDay();
}

export const isWeekend = (weekday: number): boolean => weekday === 0 || weekday === 6;

/** 某日的触发时刻；周末返回 null（不排班，顺延到下一工作日） */
export function slotAtForDate(date: string, cfg: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG): Date | null {
  if (isWeekend(weekdayOf(date))) return null;
  return beijingInstant(date, cfg.closeMinute + cfg.delayMinutes);
}

/** 下一个应触发窗口（含今天：今天已过时刻或非工作日则顺延） */
export function nextSlot(now: Date, cfg: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG): { date: string; at: Date } {
  const today = beijingParts(now).date;
  for (let i = 0; i < 10; i++) {
    const date = addBeijingDays(today, i);
    const at = slotAtForDate(date, cfg);
    if (at && at.getTime() > now.getTime()) return { date, at };
  }
  const date = addBeijingDays(today, 1);
  return { date, at: beijingInstant(date, cfg.closeMinute + cfg.delayMinutes) };
}

/** 当前是否已进入「今日应执行窗口」：工作日且 now >= 收盘 + 等待 */
export function isDueWindow(now: Date, cfg: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG): { due: boolean; tradeDate: string; slotAt: Date | null } {
  const p = beijingParts(now);
  const at = slotAtForDate(p.date, cfg);
  if (!at) return { due: false, tradeDate: p.date, slotAt: null };
  return { due: now.getTime() >= at.getTime(), tradeDate: p.date, slotAt: at };
}

export interface TaskRunRowLite {
  status: string;
  startedAt: number;
  finishedAt: number | null;
  /** 机器可读原因：skipped 行写 non_trading_day / trading_day_unconfirmed（与 task_run.error 字段一致） */
  reason?: string;
}

export type RunDecision =
  | { action: "run"; attempt: number }
  | { action: "skip"; reason: "already_success" | "max_attempts" | "running" | "non_trading_day" };

/** 幂等拦截原因的用户可读文案（API / 页面共用，避免同一状态在不同地方各写一遍） */
export const SKIP_REASON_TEXT: Record<"already_success" | "max_attempts" | "running" | "non_trading_day", string> = {
  already_success: "当日收盘后已有成功结果",
  max_attempts: "当日失败重试已达上限",
  running: "同类型任务正在执行中",
  non_trading_day: "当日已确证休市",
};

/**
 * 幂等判定（入参为该 (kind, tradeDate) 下的全部历史记录）：
 * - 当日已确证休市（skipped + non_trading_day）→ 跳过：休市不会当天翻成开盘，不必每分钟再打数据源
 * - 已有 success → 跳过：重复启动、进程重启、手动+自动撞车都不会再打数据源
 * - 有未结束且未满 30 分钟的 running → 跳过（同刻只有一个在跑）
 * - 失败次数达 maxAttempts → 跳过（不做无上限重试）
 * - 其余（无记录 / 有失败但未达上限 / 崩溃遗留的陈旧 running / 交易日当时无法确证）→ 允许再跑
 *
 * successSinceMs：只认「完成时刻不早于该时点」的成功。
 * 调度器传入当日触发窗口（收盘+等待），使盘中 10:00 的手动扫描不会挡掉 15:20 的收盘后扫描
 * ——盘中数据不是收盘数据，用它冒充「今日已跑完」会漏掉当日真正的收盘结果。0 = 任何成功都算（默认）。
 */
export function decideRun(
  rows: TaskRunRowLite[],
  cfg: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  nowMs = Date.now(),
  successSinceMs = 0,
): RunDecision {
  if (rows.some((r) => r.status === "skipped" && r.reason === "non_trading_day")) {
    return { action: "skip", reason: "non_trading_day" };
  }
  const blockingSuccess = rows.some((r) => {
    if (r.status !== "success") return false;
    if (!successSinceMs) return true;
    return (r.finishedAt ?? r.startedAt) >= successSinceMs;
  });
  if (blockingSuccess) return { action: "skip", reason: "already_success" };
  const freshRunning = rows.some((r) => r.status === "running" && nowMs - r.startedAt < 30 * 60_000);
  if (freshRunning) return { action: "skip", reason: "running" };
  const failures = rows.filter((r) => r.status === "failure").length;
  if (failures >= cfg.maxAttempts) return { action: "skip", reason: "max_attempts" };
  return { action: "run", attempt: failures + 1 };
}

export type TradingDayVerdict =
  | { isTradingDay: true; basis: string }
  | { isTradingDay: false; basis: string }
  | { isTradingDay: null; basis: string }; // 不可确证：不猜测

/**
 * 交易日判定：只认「真实指数日线的最后一根日期」，不用静态日历、不补假日期。
 * 相等 → 交易日；更早 → 休市/节假日；取不到 → 不可确证（上层按 skipped 记录，不冒充开盘）。
 */
export function judgeTradingDay(targetDate: string, latestBarDate: string | null | undefined): TradingDayVerdict {
  if (!latestBarDate) return { isTradingDay: null, basis: "无法确证交易日：指数日线无返回（数据源不可用），不猜测是否开盘" };
  if (latestBarDate === targetDate) return { isTradingDay: true, basis: `上证指数日线最新交易日 = ${latestBarDate}（与目标日一致）` };
  if (latestBarDate < targetDate) {
    return { isTradingDay: false, basis: `上证指数日线最新交易日 ${latestBarDate} 早于目标日 ${targetDate}：休市/节假日，当日无新数据` };
  }
  return { isTradingDay: true, basis: `上证指数日线最新交易日 ${latestBarDate} 晚于目标日 ${targetDate}（按补跑处理）` };
}
