// 三份日报 · 纯核（零 IO、零时钟、零数据库）
//
// 用户 2026-10-16 定：日报分三份，只报重点。
//   · 早报 08:30（开盘前）：美股昨晚 + 昨天 A 股复盘（明确标“昨天”）+ 今天看什么
//   · 午报 12:00（午盘）：上午盘复盘（9:30–11:30）+ 下午看什么（13:00–15:00）
//   · 晚报 16:00（收盘后）：今天收盘 + 板块资金 + 分歧 + 涨停板 + 减持风险 + AI 优选
//
// 只报重点口径（本文件钉死）：
//   · 主线：钱进且价涨的板块，前 3（复用 daily-report-by-sector-core 的口径）
//   · 分歧：资金与价格打架的板块，最多 5 个（按 |净流入| 从大到小）
//   · 涨停龙头：涨停梯队按连板数从高到低，最多 10 只
//   · 减持：大股东的先报，最多 10 条；其余只报总数
//   · 其余票一律不报，不把全市场混在一起。
//
// 缺数据就说“没取到”，不编。日期口径：
//   · 早报的 A 股数据属于“昨天”（最近一个已收盘交易日），绝不写成“今天”
//   · 晚报的 A 股数据属于“今天”（当日收盘）；午报属于“上午盘”（当日 9:30–11:30）
// 交易日门禁（周末/节假日不发）由调用方用真实日历（trade-calendar）判定后传入，
// 本层不猜节假日：isTradingDay === null（日历读不到）时也不发。

export type ReportSlot = "morning" | "noon" | "evening";

// ── 午报门禁：午报是上午盘复盘（9:30–11:30），必须 12:00 之后才发 ──
//
// 用户 2026-10-16：“午报不是十二点之后才推送吗”——之前手动生成的 09:56
// 那份是“上午盘中快照”，不是午报。09:56 的数据当午报发，口径是错的。
// 本门禁钉死：午报在 12:00 之前不生成、不推送（定时器和手动强制都挡），
// 调用方收到 NoonNotDue 时应返回 425（太早），不要用盘中快照冒充午报。

/** 午报最早 12:00（北京时间当日分钟数 720）之后才发 */
export const NOON_EARLIEST_MINUTE = 12 * 60;

export type NoonGate =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * 午报门禁：now 没到当日 12:00 → 不发。北京时间换算用 UTC+8，
 * 不依赖宿主机时区。
 */
export function noonGate(now: Date): NoonGate {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  if (minute >= NOON_EARLIEST_MINUTE) return { allowed: true };
  const hh = String(beijing.getUTCHours()).padStart(2, "0");
  const mm = String(beijing.getUTCMinutes()).padStart(2, "0");
  return {
    allowed: false,
    reason: `午报 12:00 之后才发，现在是 ${hh}:${mm}，未到午报时间；${hh}:${mm} 的数据是上午盘中快照，不是午报。`,
  };
}

/** 三份日报的固定时段（北京时间当日分钟数） */
export interface ReportSlotDef {
  slot: ReportSlot;
  /** 如“早报” */
  label: string;
  /** 如“早报（开盘前）” */
  title: string;
  /** 北京时间当日分钟数：08:30 = 510，12:00 = 720，16:00 = 960 */
  minuteOfDay: number;
  /** 该份日报的 A 股数据归属（写进标题/正文，防止把昨天当今天） */
  dataBelongsTo: string;
  /** 该份日报包含的节 key（顺序即展示顺序） */
  sections: string[];
}

export const REPORT_SLOT_DEFS: ReportSlotDef[] = [
  {
    slot: "morning",
    label: "早报",
    title: "早报（开盘前）",
    minuteOfDay: 8 * 60 + 30,
    dataBelongsTo: "美股是昨晚收盘；A 股复盘是昨天（最近一个已收盘交易日）",
    sections: ["us-overnight", "yesterday-review", "watch-today", "risk"],
  },
  {
    slot: "noon",
    label: "午报",
    title: "午报（午盘）",
    minuteOfDay: 12 * 60,
    dataBelongsTo: "上午盘（当日 9:30–11:30）",
    sections: ["morning-session", "sell-window", "afternoon-watch"],
  },
  {
    slot: "evening",
    label: "晚报",
    title: "晚报（收盘后）",
    minuteOfDay: 16 * 60,
    dataBelongsTo: "今天（当日收盘）",
    sections: ["close", "divergence", "limit-up", "reduction", "ai-pick", "main-line", "sell-window"],
  },
];

/** 节 key → 中文标题（调用方/页面共用，避免各处各写一遍） */
export const REPORT_SECTION_TITLES: Record<string, string> = {
  "us-overnight": "美股昨晚收盘",
  "major-news": "重大新闻（美联储 / 预测市场）",
  "cls-news": "财联社新闻",
  "next-week-calendar": "下周大事日历",
  "weekend-policy": "周末政策面",
  "commodities-fx-btc": "大宗商品 + 汇率 + 比特币",
  "weekend-company": "周末公司公告",
  "hk-friday": "港股周五收盘 + AH 溢价",
  "yesterday-review": "昨天 A 股复盘",
  "watch-today": "今天看什么",
  risk: "风险提示",
  "morning-session": "上午盘复盘（9:30–11:30）",
  "afternoon-watch": "下午看什么（13:00–15:00）",
  close: "今天 A 股收盘",
  divergence: "分歧（钱和价打架）",
  "limit-up": "涨停板（涨停龙头）",
  reduction: "减持风险",
  "ai-pick": "AI 优选",
  "ai-pick-version-winrate": "AI 优选分版胜率",
  "main-line": "主线",
  "sell-window": "什么时候卖最合适（10:30 / 11:30 休盘 / 15:00 收盘对比）",
};

export function slotDefOf(slot: ReportSlot): ReportSlotDef {
  return REPORT_SLOT_DEFS.find((d) => d.slot === slot) ?? REPORT_SLOT_DEFS[2];
}

/** 只报重点的上限 */
export const HIGHLIGHT_CAPS = {
  /** 分歧板块最多报几个 */
  divergence: 5,
  /** 涨停龙头最多报几只 */
  limitUpLeaders: 10,
  /** 减持最多报几条明细（其余只报总数） */
  reductionRows: 10,
} as const;

// ── 北京时间日期算术（纯函数，不依赖宿主机时区；北京固定 UTC+8 无夏令时） ──

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function beijingDateOf(now: Date): string {
  return ymd(new Date(now.getTime() + BEIJING_OFFSET_MS));
}

function beijingMidnightUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) - BEIJING_OFFSET_MS;
}

function addBeijingDays(date: string, days: number): string {
  return ymd(new Date(beijingMidnightUtc(date) + BEIJING_OFFSET_MS + days * 86_400_000));
}

function weekdayOfBeijingDate(date: string): number {
  return new Date(beijingMidnightUtc(date) + BEIJING_OFFSET_MS).getUTCDay();
}

/** 某日某份日报的触发时刻（北京时间）；周末返回 null（不排班，顺延到下一工作日） */
export function slotAtForDate(date: string, slot: ReportSlot): Date | null {
  const wd = weekdayOfBeijingDate(date);
  if (wd === 0 || wd === 6) return null;
  return new Date(beijingMidnightUtc(date) + slotDefOf(slot).minuteOfDay * 60_000);
}

/** 下一份应发的日报（含今天：今天已过时刻或非工作日则顺延；只跳周末，节假日由调用方日历门禁挡） */
export function nextReportSlot(now: Date): { date: string; slot: ReportSlot; at: Date } {
  const today = beijingDateOf(now);
  for (let i = 0; i < 10; i++) {
    const date = addBeijingDays(today, i);
    for (const def of REPORT_SLOT_DEFS) {
      const at = slotAtForDate(date, def.slot);
      if (at && at.getTime() > now.getTime()) return { date, slot: def.slot, at };
    }
  }
  const date = addBeijingDays(today, 1);
  return { date, slot: "morning", at: slotAtForDate(date, "morning") ?? new Date() };
}

/** 当前是否已进入某份日报的发送窗口（当日该时刻之后） */
export function isSlotDue(now: Date, slot: ReportSlot): boolean {
  const at = slotAtForDate(beijingDateOf(now), slot);
  return !!at && now.getTime() >= at.getTime();
}

// ── 交易日门禁：只在 A 股交易日发，周末/节假日不发 ──

export type TradingDayGate =
  | { send: true }
  | { send: false; reason: string };

/**
 * isTradingDay 来自真实日历（trade-calendar，含法定节假日）：
 *   true → 发；false → 不发（周末/节假日）；null → 日历读不到，不猜，不发。
 */
export function tradingDayGate(isTradingDay: boolean | null, date: string): TradingDayGate {
  if (isTradingDay === true) return { send: true };
  if (isTradingDay === false) {
    return { send: false, reason: `${date} 不是 A 股交易日（周末/节假日），日报不发。` };
  }
  return { send: false, reason: `交易日历读不到（${date} 是否交易日无法确证），日报不发，不猜。` };
}

// ── 只报重点：高亮筛选（纯函数） ──

export interface DivergenceInput {
  name: string;
  changePct: number;
  netYi: number;
  plain: string;
}

/** 分歧板块：只留资金与价格打架的，按 |净流入| 从大到小，最多 5 个 */
export function pickDivergenceHighlights(
  cards: readonly DivergenceInput[],
): DivergenceInput[] {
  return cards
    .filter((c) => (c.netYi > 0 && c.changePct < 0) || (c.netYi < 0 && c.changePct > 0))
    .sort((a, b) => Math.abs(b.netYi) - Math.abs(a.netYi))
    .slice(0, HIGHLIGHT_CAPS.divergence);
}

export interface LimitUpLeaderInput {
  symbol: string;
  name: string;
  boards: number;
  changePct: number | null;
}

/** 涨停龙头：按连板数从高到低，最多 10 只 */
export function pickLimitUpLeaders(
  stocks: readonly LimitUpLeaderInput[],
): LimitUpLeaderInput[] {
  return [...stocks]
    .sort((a, b) => b.boards - a.boards || (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, HIGHLIGHT_CAPS.limitUpLeaders);
}

export interface ReductionHighlightInput {
  plainLine: string;
  /** 是否大股东（控股股东 / 持股 5% 以上股东） */
  isBigHolder: boolean;
}

/**
 * 减持：大股东的先报，最多 10 条明细；其余只报总数。
 * 返回 { lines, overflow }：overflow > 0 时调用方在文案里写“其余 N 只见巨潮公告”。
 */
export function pickReductionHighlights(
  rows: readonly ReductionHighlightInput[],
): { lines: string[]; overflow: number } {
  const sorted = [...rows].sort(
    (a, b) => Number(b.isBigHolder) - Number(a.isBigHolder),
  );
  const lines = sorted.slice(0, HIGHLIGHT_CAPS.reductionRows).map((r) => r.plainLine);
  return { lines, overflow: Math.max(0, sorted.length - lines.length) };
}

// ── “看什么”：等什么信号再买（纯函数，只从传入的事实推导条件句，不编信号） ──

export interface WatchFacts {
  /** 美股昨晚：null = 没取到 */
  usDown: boolean | null;
  /** 英伟达昨晚跌超 1%：null = 没取到 */
  nvdaDownSharp: boolean | null;
  /** 主线板块名（钱进且价涨，前 3） */
  mainLines: string[];
  /** 分歧板块名 */
  divergences: string[];
  /** 主线里连续减持的票名 */
  mainLineReductions: string[];
  /** 大股东减持只数：null = 没取到 */
  bigHolderReductions: number | null;
  /** 10 月会议加息概率 >= 50%：null = 没取到 */
  fedHikeHigh: boolean | null;
}

/** 早报“今天看什么”：等什么信号再买 + 风险提示（条件句，无信号时明说“先看不买”） */
export function buildWatchToday(f: WatchFacts): string[] {
  const out: string[] = [];
  if (f.usDown === true) out.push("美股昨晚跌了，今天开盘可能低开：别开盘就追，等企稳再看。");
  else if (f.usDown === false) out.push("美股昨晚涨了，今天开盘可能高开：高开别追，等回踩确认再看。");
  else out.push("美股昨晚没取到：今天开盘方向没有外盘参考，先看开盘半小时。");
  if (f.nvdaDownSharp === true) out.push("英伟达昨晚跌超 1%：半导体今天可能跟着跌，半导体票先别急着买。");
  for (const name of f.mainLines) {
    out.push(`主线在${name}：等${name}放量站稳再考虑，缩量跟涨不追。`);
  }
  for (const name of f.divergences) {
    out.push(`${name}钱和价还在打架：等分歧收敛（钱价同向）再动手，半路不追。`);
  }
  for (const name of f.mainLineReductions) {
    out.push(`${name}有大股东连续减持：主线票里先避开这只，等减持公告说清再看。`);
  }
  if (f.bigHolderReductions != null && f.bigHolderReductions >= 10) {
    out.push(`昨天大股东减持的票有 ${f.bigHolderReductions} 只，比较多：今天新开仓先轻仓，大股东集中卖的时候要当心。`);
  }
  if (f.fedHikeHigh === true) out.push("美联储加息概率过半：仓位别加满，等会议结果落地。");
  if (!f.mainLines.length && !f.divergences.length) {
    out.push("没有明确的主线和分歧信号：今天先看、不急着买，等主线走出来。");
  }
  return out;
}

export interface AfternoonFacts {
  /** 上午分歧板块名 */
  divergences: string[];
  /** 上午涨停最高连板数：null = 没取到 */
  maxBoards: number | null;
  /** 上午流入最多的板块：null = 没取到 */
  topInflowSector: string | null;
  /** 上午流出最多的板块：null = 没取到 */
  topOutflowSector: string | null;
}

/** 午报“下午看什么（13:00–15:00）” */
export function buildAfternoonWatch(f: AfternoonFacts): string[] {
  const out: string[] = [];
  for (const name of f.divergences) {
    out.push(`下午看${name}的分歧收不收敛：钱价同向了才算稳住，还打架就别碰。`);
  }
  if (f.maxBoards != null && f.maxBoards > 0) {
    out.push(`上午最高板是 ${f.maxBoards} 连板：下午看它封不封得住，炸板就说明短线情绪在退潮。`);
  } else if (f.maxBoards === null) {
    out.push("上午涨停梯队没取到：下午先看涨停家数有没有起来，起不来说明情绪弱。");
  }
  if (f.topInflowSector) out.push(`上午钱进得最多的是${f.topInflowSector}：下午看它能不能继续吸金，断了就说明上午是假动作。`);
  if (f.topOutflowSector) out.push(`上午钱跑得最多的是${f.topOutflowSector}：下午看它止不止跌，还在流出就别抄底。`);
  if (!out.length) out.push("上午没有明确信号：下午先看、不急着买，等方向走出来。");
  return out;
}
