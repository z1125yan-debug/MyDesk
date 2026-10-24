// 周报 + 大事件触发（纯函数，零 IO、零时钟）。
//
// 用户 2026-10-16 确认：周报（周日晚上）+ 大事件触发（有大事件就单独发，不等日报）。
// 只报重点：主线 + AI 选的 + 风险 + 涨停龙头，其他票不报。
// 缺数据就说“没取到”，不编。财报日历 / 解禁日历暂无数据源：
// 本层永远写“没取到”，不许调用方拿别的日期冒充。
//
// 口径：
// - 一周 = 周一～周日；周报的“本周”取其中有板块快照的交易日。
// - 板块本周涨跌 = 该板块各交易日中位涨跌幅复利（Π(1+日涨跌) - 1），
// 不是简单相加；某日缺数就跳过那天，全部缺数 → null。
// - 主线 = 本周涨跌 > 0 的板块按本周涨跌从大到小取前 3（价格口径；
// 周度资金归档暂无，不拿单日资金冒充一周资金）。
// - 战绩 = AI 优选（source="ai_pick"）已回填的次日净收益均值与跑赢情况。

// ── 日期工具（纯字符串运算，北京日期空间） ──

/** 日期加减天数（YYYY-MM-DD，UTC 算避免宿主机时区漂移） */
export function addDays(date: string, days: number): string {
const d = new Date(`${date}T00:00:00Z`);
d.setUTCDate(d.getUTCDate() + days);
return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 星期几（按日期的 UTC 星期，北京日期空间下与日历一致） */
export function weekdayLabel(date: string): string {
return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** 某日所在周的周一 / 周日 / 下周一 */
export function weekRangeOf(date: string): { monday: string; sunday: string; nextMonday: string} {
const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=周日 … 6=周六
const toMonday = dow === 0? -6: 1 - dow;
const monday = addDays(date, toMonday);
return { monday, sunday: addDays(monday, 6), nextMonday: addDays(monday, 7)};
}

/** “10月28日” / “12月会议”这类会议标签 → YYYY-MM-DD；解析不出 → null */
export function parseCnMeetingDate(meeting: string, year: number): string | null {
const m = /(\d{1,2})月(\d{1,2})日/.exec(meeting?? "");
if (!m) return null;
const mm = Number(m[1]);
const dd = Number(m[2]);
if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// ── 周报 ──

export interface WeeklySectorInput {
name: string;
/** 与本周交易日一一对应的各日中位涨跌幅 %；缺数用 null（跳过，不补 0） */
dailyMedianChange: (number | null)[];
}

export interface WeeklyPickRow {
tradeDate: string;
/** 已回填的次日平均净收益 %（扣费后，等权）；未回填 = null */
nextDaySymWin: number | null;
nextDaySymUp: number | null;
nextDaySymCount: number | null;
/** 同期全 A 中位个股净收益 %；无 = null */
nextDayBenchNet: number | null;
}

export interface WeeklyLimitUpRow {
name: string;
symbol: string;
tradeDate: string;
boards: number | null;
changePct: number | null;
}

export interface WeeklyFedMeeting {
meeting: string;
/** 解析出的日期；“12月”这种无具体日 → null */
date: string | null;
}

export interface WeeklyReportInput {
/** 本周日，如 2026-10-18 */
sunday: string;
weekStart: string; // 本周一
weekEnd: string; // 本周五（或本周最后一个有数据的交易日）
/** 本周有板块快照的交易日（升序） */
tradingDays: string[];
/** 上证指数本周首收 → 末收涨跌幅 %；日 K 里没有指数行 → null */
indexWeeklyPct: number | null;
/** 全市场中位个股本周复利涨跌幅 %；快照缺数 → null */
allAMedianWeeklyPct: number | null;
sectors: WeeklySectorInput[];
prevWeekSectors: WeeklySectorInput[];
picks: WeeklyPickRow[];
/** 本周连板 ≥3 的涨停龙头行（已按连板数排好） */
limitUpLeaders: WeeklyLimitUpRow[];
fedPlain: string;
fedMeetings: WeeklyFedMeeting[];
nextWeekTradingDays: string[];
nextWeekHolidayWindows: { start: string; end: string; len: number}[];
}

export interface SectorWeekly {
name: string;
weeklyPct: number;
}

export interface PicksWeekly {
/** 本周计入战绩的天数（AI 优选行数） */
days: number;
/** 其中已回填的天数 */
filledDays: number;
/** 已回填天的平均次日净收益 %；无回填 → null */
avgWinPct: number | null;
/** 已回填天合计：上涨只数 / 参与只数 */
upCount: number | null;
totalCount: number | null;
/** 已回填天的平均全 A 中位基准 %；无 → null */
avgBenchPct: number | null;
plain: string;
}

export interface WeeklyReport {
sunday: string;
weekStart: string;
weekEnd: string;
tradingDays: string[];
indexWeeklyPct: number | null;
allAMedianWeeklyPct: number | null;
strongest: SectorWeekly[];
weakest: SectorWeekly[];
/** 主线：本周涨 > 0 的板块前 3 */
mainLine: SectorWeekly[];
/** 主线变化：续留 / 新进 / 掉出（上周没取到时如实说对比不了） */
mainLineChange: string;
picks: PicksWeekly;
limitUpLeaders: WeeklyLimitUpRow[];
/** 下周交易日（带星期） */
nextWeekTradingDays: string[];
nextWeekHolidayWindows: { start: string; end: string; len: number}[];
fedPlain: string;
fedMeetings: WeeklyFedMeeting[];
/** 下周大事：财报 / 解禁永远 null（暂无数据源，不编） */
nextWeekEarnings: null;
nextWeekUnlocks: null;
plain: string;
hasData: boolean;
}

/** 各日中位涨跌幅 → 本周复利涨跌幅 %；全缺 → null */
export function compoundWeeklyPct(daily: readonly (number | null)[]): number | null {
let acc = 1;
let n = 0;
for (const v of daily) {
if (v == null ||!Number.isFinite(v)) continue;
acc *= 1 + v / 100;
n++;
}
if (!n) return null;
return (acc - 1) * 100;
}

function fmtPct(v: number | null): string {
if (v == null) return "没取到";
return v >= 0? `涨 ${v.toFixed(2)}%`: `跌 ${Math.abs(v).toFixed(2)}%`;
}

function sectorWeeklies(sectors: readonly WeeklySectorInput[]): SectorWeekly[] {
const out: SectorWeekly[] = [];
for (const s of sectors) {
const w = compoundWeeklyPct(s.dailyMedianChange);
if (w!= null) out.push({ name: s.name, weeklyPct: w});
}
return out;
}

function mainLineOf(weeklies: readonly SectorWeekly[]): SectorWeekly[] {
return [...weeklies].filter((s) => s.weeklyPct > 0).sort((a, b) => b.weeklyPct - a.weeklyPct).slice(0, 3);
}

function buildPicksWeekly(picks: readonly WeeklyPickRow[]): PicksWeekly {
const filled = picks.filter((p) => p.nextDaySymWin!= null);
if (!picks.length) {
return {
days: 0, filledDays: 0, avgWinPct: null, upCount: null, totalCount: null, avgBenchPct: null,
plain: "战绩：本周没有 AI 优选计入战绩，算不出本周战绩。",
};
}
if (!filled.length) {
return {
days: picks.length, filledDays: 0, avgWinPct: null, upCount: null, totalCount: null, avgBenchPct: null,
plain: `战绩：本周 AI 优选计入战绩 ${picks.length} 天，但次日行情还没回填完（要等 T+1/T+2 走完），本周战绩没取到。`,
};
}
const avgWin = filled.reduce((a, p) => a + (p.nextDaySymWin?? 0), 0) / filled.length;
const up = filled.reduce((a, p) => a + (p.nextDaySymUp?? 0), 0);
const total = filled.reduce((a, p) => a + (p.nextDaySymCount?? 0), 0);
const benches = filled.map((p) => p.nextDayBenchNet).filter((v): v is number => v!= null);
const avgBench = benches.length? benches.reduce((a, b) => a + b, 0) / benches.length: null;
const vsBench = avgBench == null
? "基准没取到，比不了。"
: avgWin > avgBench
? `跑赢全 A 中位个股基准（基准 ${avgBench >= 0? "+": ""}${avgBench.toFixed(2)}%）。`
: avgWin < avgBench
? `没跑赢全 A 中位个股基准（基准 ${avgBench >= 0? "+": ""}${avgBench.toFixed(2)}%）。`
: "和全 A 中位个股基准打平。";
const winRate = total > 0? `上涨 ${up}/${total} 只`: "上涨只数没取到";
return {
days: picks.length,
filledDays: filled.length,
avgWinPct: avgWin,
upCount: total > 0? up: null,
totalCount: total > 0? total: null,
avgBenchPct: avgBench,
plain: `战绩：本周 AI 优选计入战绩 ${picks.length} 天，已回填 ${filled.length} 天；已回填天的平均次日净收益 ${avgWin >= 0? "+": ""}${avgWin.toFixed(2)}%（扣费后，等权），${winRate}。${vsBench}`,
};
}

/** 周报：本周总结 + 下周看什么（只报重点：主线 + AI 选的 + 风险 + 涨停龙头） */
export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
const weeklies = sectorWeeklies(input.sectors);
const strongest = [...weeklies].sort((a, b) => b.weeklyPct - a.weeklyPct).slice(0, 3);
const weakest = [...weeklies].sort((a, b) => a.weeklyPct - b.weeklyPct).slice(0, 3);
const mainLine = mainLineOf(weeklies);
const prevMainLine = mainLineOf(sectorWeeklies(input.prevWeekSectors));
let mainLineChange: string;
if (!input.prevWeekSectors.length) {
mainLineChange = "主线变化：上周板块快照没取到，对比不了主线变没变。";
} else if (!mainLine.length) {
mainLineChange = prevMainLine.length
? `主线变化：上周主线是${prevMainLine.map((s) => s.name).join("、")}，本周没有涨的板块，没有明确的主线（主线断了）。`
: "主线变化：上周和本周都没有涨的板块，没有明确的主线。";
} else {
const prevNames = new Set(prevMainLine.map((s) => s.name));
const curNames = new Set(mainLine.map((s) => s.name));
const kept = mainLine.filter((s) => prevNames.has(s.name)).map((s) => s.name);
const added = mainLine.filter((s) =>!prevNames.has(s.name)).map((s) => s.name);
const dropped = prevMainLine.filter((s) =>!curNames.has(s.name)).map((s) => s.name);
const parts: string[] = [];
if (kept.length) parts.push(`留下的主线：${kept.join("、")}`);
if (added.length) parts.push(`新进的主线：${added.join("、")}`);
if (dropped.length) parts.push(`掉出主线：${dropped.join("、")}`);
mainLineChange = `主线变化：${parts.length? parts.join("；"): "和上周一模一样"}。`;
}
const picks = buildPicksWeekly(input.picks);

const range = input.tradingDays.length
? `${input.weekStart}～${input.weekEnd}（${input.tradingDays.length} 个交易日有数据）`
: `${input.weekStart}～${input.weekEnd}（本周交易日没取到）`;
const indexLine = input.indexWeeklyPct == null
? "大盘：上证指数本周涨跌没取到（日 K 里没有指数行）。"
: `大盘：上证指数本周${fmtPct(input.indexWeeklyPct)}。`;
const allALine = input.allAMedianWeeklyPct == null
? "全市场中位个股本周涨跌没取到。"
: `全市场中位个股本周${fmtPct(input.allAMedianWeeklyPct)}（复利口径）。`;
const strongLine = strongest.length
? `最强板块：${strongest.map((s) => `${s.name}（${fmtPct(s.weeklyPct)}）`).join("、")}。`
: "最强板块：本周板块快照没取到，算不出。";
const weakLine = weakest.length
? `最弱板块：${weakest.map((s) => `${s.name}（${fmtPct(s.weeklyPct)}）`).join("、")}。`
: "最弱板块：本周板块快照没取到，算不出。";
const mainLineLine = mainLine.length
? `本周主线：${mainLine.map((s) => `${s.name}（${fmtPct(s.weeklyPct)}）`).join("、")}。${mainLineChange}`
: `本周主线：没有涨的板块，没有明确的主线。${mainLineChange}`;
const leaderLine = input.limitUpLeaders.length
? `涨停龙头：${input.limitUpLeaders.map((r) => `${r.name}（${r.boards?? "?"}连板，${r.tradeDate}，${fmtPct(r.changePct)}）`).join("、")}。`
: "涨停龙头：本周没有 3 连板以上的涨停龙头（或涨停名单没取到）。";
const riskLine = "风险：本周全周减持汇总没取到（巨潮公告只在日报里按日汇总，不编一周总数）；主线里的票有没有连续减持，看本周各日报的主线减持一节。";

const nextDays = input.nextWeekTradingDays.length
? `下周交易日：${input.nextWeekTradingDays.map((d) => `${d.slice(5).replace("-", "/")}（${weekdayLabel(d)}）`).join("、")}。`
: "下周交易日：交易日历没取到，算不出下周哪天开盘。";
const holLine = input.nextWeekHolidayWindows.length
? `下周休市：${input.nextWeekHolidayWindows.map((h) => `${h.start.slice(5).replace("-", "/")}—${h.end.slice(5).replace("-", "/")}（${h.len} 天）`).join("、")}。`
: "下周休市：下周没有连续 2 天以上的休市段（或交易日历没取到）。";
const nextMon = addDays(input.sunday, 1);
const nextSun = addDays(input.sunday, 7);
const fedNext = input.fedMeetings.filter((m) => m.date!= null && m.date >= nextMon && m.date <= nextSun);
const fedNextLine = fedNext.length
? `⚠️ 下周有美联储议息：${fedNext.map((m) => `${m.meeting}（${m.date}）`).join("、")}，议息前后小心波动。`
: "下周美联储：已知会议（10月28日、12月）都不在下周；具体日期没取到的会议无法判断。";
const nextWeekLine = `下周看什么：${nextDays}${holLine}${fedNextLine}财报：没取到（暂无财报日历数据源，不编）。解禁：没取到（暂无解禁日历数据源，不编）。下周重点看本周主线能不能续上（${mainLine.length? mainLine.map((s) => s.name).join("、"): "本周无明确主线"}），主线断了就先别追。`;

const plain = [
`📅 周报（${range}）：`,
indexLine,
allALine,
strongLine,
weakLine,
mainLineLine,
picks.plain,
leaderLine,
riskLine,
nextWeekLine,
`美联储 / 预测市场：${input.fedPlain}`,
].join("\n");

return {
sunday: input.sunday,
weekStart: input.weekStart,
weekEnd: input.weekEnd,
tradingDays: [...input.tradingDays],
indexWeeklyPct: input.indexWeeklyPct,
allAMedianWeeklyPct: input.allAMedianWeeklyPct,
strongest,
weakest,
mainLine,
mainLineChange,
picks,
limitUpLeaders: [...input.limitUpLeaders],
nextWeekTradingDays: [...input.nextWeekTradingDays],
nextWeekHolidayWindows: [...input.nextWeekHolidayWindows],
fedPlain: input.fedPlain,
fedMeetings: [...input.fedMeetings],
nextWeekEarnings: null,
nextWeekUnlocks: null,
plain,
hasData: input.tradingDays.length > 0 || weeklies.length > 0,
};
}

// ── 大事件触发 ──

export type BigEventKind =
| "fed"
| "policy"
| "sector_surge"
| "sector_plunge"
| "stock_limit_up"
| "stock_limit_down"
| "index_surge"
| "index_plunge";

/** 板块当日涨跌幅绝对值 ≥ 5% → 大事件 */
export const SECTOR_EVENT_PCT = 5;
/** 上证指数当日涨跌幅绝对值 ≥ 3% → 大事件 */
export const INDEX_EVENT_PCT = 3;
/** 板块领涨股涨跌幅 ≥ 9.5% → 疑似涨停（主板 10% 板；20cm 票 ≥19.5% 才算真封板） */
export const LEADER_LIMIT_UP_PCT = 9.5;
export const LEADER_LIMIT_UP_20CM_PCT = 19.5;
/** 板块领涨股跌幅 ≤ -9.5% → 疑似跌停 */
export const LEADER_LIMIT_DOWN_PCT = -9.5;
/** 连板 ≥ 3 才算“涨停龙头”，日常首板不触发 */
export const LIMIT_UP_LEADER_BOARDS = 3;

export const FED_KEYWORDS = ["美联储", "FOMC", "议息", "美联储会议", "鲍威尔"];
export const POLICY_KEYWORDS = [
"降准", "降息", "证监会", "国务院", "发改委", "政治局", "国常会",
"央行", "印花税", "减税", "刺激", "重磅政策", "重大政策",
];

export interface BigEventSourceEvent {
title: string;
level: string;
time: string;
}

export interface BigEventSourceSector {
name: string;
changePct: number | null;
netYi: number | null;
leader: string;
leaderPct: number | null;
}

export interface BigEventInput {
/** 北京时间日期 YYYY-MM-DD */
date: string;
/** 最近落库的事件（调用方已按时间倒序取最近一批） */
events: BigEventSourceEvent[];
/** 当日板块榜（同花顺行业榜，盘中即实时） */
sectors: BigEventSourceSector[];
/** 当日主线板块名（钱进且价涨前 3，与日报主线同口径） */
mainLineNames: string[];
/** 当日 AI 优选的票名（只报重点：非主线、非 AI 选的票不触发个股提醒） */
aiPickNames: string[];
/** 上证指数当日涨跌幅 %（盘中取不到 → null，只在收盘后判定） */
indexChangePct: number | null;
}

export interface BigEventAlert {
kind: BigEventKind;
/** 触发主体：板块名 / 票名 / 事件标题 */
subject: string;
direction: "利多" | "利空" | "双向";
/** 短提醒：事件是什么、方向、影响、重点看什么 */
plain: string;
/** 去重键：同日同类同主体只发一次 */
dedupeKey: string;
}

const alert = (date: string, kind: BigEventKind, subject: string, direction: BigEventAlert["direction"], plain: string): BigEventAlert => ({
kind,
subject,
direction,
plain,
dedupeKey: `${date}:${kind}:${subject}`,
});

function eventLevelIsBig(level: string): boolean {
return level === "全球级事件" || level === "重大产业事件";
}

/** 大事件判定（纯函数）：任一条件命中即一条提醒；日常波动不触发 */
export function evaluateBigEventTriggers(input: BigEventInput): BigEventAlert[] {
const out: BigEventAlert[] = [];
const { date} = input;

// 1) 美联储议息 / 重磅政策：只认全球级 / 重大产业事件 + 关键词；普通新闻不触发
for (const e of input.events) {
if (!eventLevelIsBig(e.level)) continue;
const title = e.title?? "";
if (FED_KEYWORDS.some((k) => title.includes(k))) {
out.push(alert(date, "fed", title, "双向", `${title}。方向：议息结果没出来前是双向，偏鹰（加息/不降息）利空、偏鸽（降息/放鸽）利多。影响：钱的价格变了，A 股开盘大概率跟着动。重点看：议息声明原文 + 下周日报的美联储/预测市场一节，别听小道消息抢跑。`));
} else if (POLICY_KEYWORDS.some((k) => title.includes(k))) {
out.push(alert(date, "policy", title, "双向", `${title}。方向：政策原文出来前是双向，利好方向的板块涨、利空方向的板块跌。影响：政策直接改游戏规则，比技术面管用。重点看：政策原文针对哪个板块（主线有没有变）、龙头有没有放量跟上，别只看标题追。`));
}
}

const mainLine = new Set(input.mainLineNames);
const aiPicks = new Set(input.aiPickNames);

// 2) 板块突然暴涨 / 暴跌（当日涨跌幅 ≥ 5%）
for (const s of input.sectors) {
if (s.changePct == null ||!Number.isFinite(s.changePct)) continue;
if (s.changePct >= SECTOR_EVENT_PCT) {
out.push(alert(date, "sector_surge", s.name, "利多", `${s.name}今天涨 ${s.changePct.toFixed(2)}%（≥${SECTOR_EVENT_PCT}%）。方向：利多该板块。影响：资金在往这个板块涌，主线可能正在往这儿切。重点看：龙头${s.leader || "没取到"}能不能封住、板块资金是真流入还是拉高出货，别追高。`));
} else if (s.changePct <= -SECTOR_EVENT_PCT) {
out.push(alert(date, "sector_plunge", s.name, "利空", `${s.name}今天跌 ${Math.abs(s.changePct).toFixed(2)}%（≥${SECTOR_EVENT_PCT}%）。方向：利空该板块。影响：资金在从这个板块跑，主线可能正在断。重点看：龙头${s.leader || "没取到"}有没有止跌、是不是主线板块在退潮，别急着抄底。`));
}
}

// 3) 个股涨停 / 跌停：只报重点——主线板块的龙头、AI 选的票、20cm 真封板；日常首板不报
for (const s of input.sectors) {
if (!s.leader || s.leaderPct == null ||!Number.isFinite(s.leaderPct)) continue;
const inScope = mainLine.has(s.name) || aiPicks.has(s.leader);
if (s.leaderPct >= LEADER_LIMIT_UP_PCT && (inScope || s.leaderPct >= LEADER_LIMIT_UP_20CM_PCT)) {
const boardNote = s.leaderPct >= LEADER_LIMIT_UP_20CM_PCT? "20cm 涨停": "主板接近/达到涨停（≥9.5%）";
out.push(alert(date, "stock_limit_up", s.leader, "利多", `${s.leader}（${s.name}）涨 ${s.leaderPct.toFixed(2)}%（${boardNote}）。方向：利多该票与所在板块。影响：龙头封板会带板块情绪，主线可能就此确认。重点看：封单稳不稳、有没有炸板、板块内跟风票多不多，别在炸板时接。`));
} else if (s.leaderPct <= LEADER_LIMIT_DOWN_PCT && inScope) {
out.push(alert(date, "stock_limit_down", s.leader, "利空", `${s.leader}（${s.name}）跌 ${Math.abs(s.leaderPct).toFixed(2)}%（≤${LEADER_LIMIT_DOWN_PCT}%）。方向：利空该票与所在板块。影响：主线/AI 选的票大跌，主线可能正在退潮。重点看：是不是减持/利空消息砸的、跌停封单大不大，别急着抄底。`));
}
}

// 4) 大盘暴涨 / 暴跌（收盘后才有当日涨跌幅，盘中取不到就不判）
if (input.indexChangePct!= null && Number.isFinite(input.indexChangePct)) {
if (input.indexChangePct >= INDEX_EVENT_PCT) {
out.push(alert(date, "index_surge", "上证指数", "利多", `上证指数今天涨 ${input.indexChangePct.toFixed(2)}%（≥${INDEX_EVENT_PCT}%）。方向：利多大盘。影响：全市场情绪会被点燃，主线板块大概率跟着涨。重点看：涨的是主线还是普涨、成交量有没有放大（没量就是虚涨）。`));
} else if (input.indexChangePct <= -INDEX_EVENT_PCT) {
out.push(alert(date, "index_plunge", "上证指数", "利空", `上证指数今天跌 ${Math.abs(input.indexChangePct).toFixed(2)}%（≥${INDEX_EVENT_PCT}%）。方向：利空大盘。影响：全市场情绪会退潮，主线也难独善其身。重点看：主线板块抗不抗跌、有没有资金护盘，别急着抄底。`));
}
}

return out;
}
