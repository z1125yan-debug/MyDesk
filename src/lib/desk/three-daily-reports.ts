// 三份日报 · 拉取层（带 IO）。
//
// 早报 08:30 / 午报 12:00 / 晚报 16:00，只报重点：主线 + AI 选的 + 风险 + 涨停龙头。
// 复用现有口径，不另起一套：板块资金/美股/美联储/动态/主线减持走 fetchDailyReportBySector，
// 减持风险走 fetchDailyReductionRisk，涨停梯队走 computeLimitUp，AI 优选读已落库的
// StrategyPick（source=ai_pick），不重跑模型、不编数据。
//
// 日期口径（绝不把昨天当今天）：
// · 早报：A 股数据归属 = resolveTradeDate 给的最近已收盘交易日（8:30 未开盘时就是昨天）
// · 午报/晚报：A 股数据归属 = 当天（午报是上午盘快照，晚报是收盘定稿；未到时刻生成时标 preliminary）
// 生成结果落档 data/daily-reports/<签发日>-<slot>.json（签发日 = 北京时间当天），
// 同一份同一天只生成一次（已有落档直接返回），调度器幂等另由 task_run 保证。

import { promises as fs} from "node:fs";
import path from "node:path";
import { fetchDailyReportBySector} from "@/lib/desk/daily-report-by-sector";
import { fetchDailyReductionRisk} from "@/lib/desk/daily-report-sections";
import { sellPairSectionNoon, sellWindowSection } from "@/lib/desk/price-snapshots";
import { buildAiPickVersionWinRateSection, computeAiPickVersionStats, decisionDateSellingOn } from "@/lib/desk/ai-pick-version-stats";
import { parseAiPickNote, stripPickDayChangePct } from "@/lib/quant/strategy/ai-pick-note";
import { morningDataDate, resolveTradeDate } from "@/lib/desk/trade-date";
import { isTradingDay, tradingDaysAfter, weekdayOf } from "@/lib/desk/trade-calendar";
import { fetchClsDayItems } from "@/lib/desk/cls-telegraph";
import { buildCommodities, buildHkFriday, buildNextWeekCalendar, buildWeekendCompanyAnnouncements, buildWeekendPolicy } from "@/lib/desk/slim-extra-sections";
import { interpretNewsTitle } from "@/lib/desk/news-interpret";
import { shanghaiDate, shanghaiStamp} from "@/lib/desk/session";
import { db} from "@/lib/db";
import { computeLimitUp} from "@/lib/quant/screener/limitup";
import {
buildAfternoonWatch,
buildWatchToday,
noonGate,
pickDivergenceHighlights,
pickLimitUpLeaders,
pickReductionHighlights,
REPORT_SECTION_TITLES,
slotDefOf,
type ReportSlot,
} from "./three-daily-reports-core";

/** 午报未到 12:00：调用方应返回 425（太早），不要用盘中快照冒充午报。 */
export class NoonNotDueError extends Error {}

export interface ThreeDailyReportSection {
key: string;
title: string;
plain: string;
}

export interface ThreeDailyReport {
slot: ReportSlot;
label: string;
title: string;
/** 签发日（北京时间当天，如 2026-10-16） */
issueDate: string;
/** A 股数据归属的交易日：早报 = 昨天，午报/晚报 = 今天 */
dataDate: string;
/** 数据归属说明（写进标题下，防止把昨天当今天） */
dataBelongsTo: string;
/** 生成时刻（北京时间戳） */
generatedAt: string;
/** 未到收盘/午盘时刻就生成时为 true：这份是盘中快照，不是定稿 */
preliminary: boolean;
/** 非交易日瘦身版（只做美股 + 重大新闻 + 财联社新闻，不重复推昨天 A 股内容） */
slim?: boolean;
sections: ThreeDailyReportSection[];
/** 全文（各节标题 + 正文拼接） */
plain: string;
hasData: boolean;
/** 缺失口径（取不到的节） */
missing: string[];
}

const REPORTS_DIR = path.join(process.cwd(), "data", "daily-reports");

function fileOf(issueDate: string, slot: ReportSlot): string {
return path.join(REPORTS_DIR, `${issueDate}-${slot}.json`);
}

export async function readStoredReport(
issueDate: string,
slot: ReportSlot,
): Promise<ThreeDailyReport | null> {
try {
const raw = await fs.readFile(fileOf(issueDate, slot), "utf-8");
const parsed = JSON.parse(raw) as ThreeDailyReport;
if (parsed?.slot === slot && parsed?.issueDate === issueDate) return parsed;
return null;
} catch {
return null;
}
}

async function persistReport(report: ThreeDailyReport): Promise<void> {
try {
await fs.mkdir(REPORTS_DIR, { recursive: true});
await fs.writeFile(fileOf(report.issueDate, report.slot), JSON.stringify(report, null, 2), "utf-8");
} catch {
// 落档失败不阻塞返回：调用方仍能拿到本次生成的内容，调度器会记 failure
throw new Error("日报落档失败（data/daily-reports 写不进）");
}
}

function section(key: string, plain: string): ThreeDailyReportSection {
return { key, title: REPORT_SECTION_TITLES[key]?? key, plain};
}

/** “今日”→“昨天”：早报复盘节的文案必须标昨天，不能把昨天的数说成今天的 */
const toYesterday = (s: string): string => s.replaceAll("今日", "昨天").replaceAll("今天", "昨天");
/** “今日”→“上午”：午报上午盘节的文案必须标上午 */
const toMorning = (s: string): string => s.replaceAll("今日", "上午").replaceAll("今天", "上午");

/** 读已落库的 AI 优选（source=ai_pick，tradeDate=dataDate）：只读，不重跑模型。
 * 报数规则（2026-10-17）：决策日 = 今天的新选股，只列代码、名称、理由，
 * 不显示选股日涨跌幅（没意义，不是收益）。理由里的涨跌幅数字一并去掉。 */
async function fetchStoredAiPick(dataDate: string): Promise<ThreeDailyReportSection> {
try {
const row = await db.strategyPick.findFirst({
where: { tradeDate: dataDate, strategyId: -1, source: "ai_pick"},
orderBy: { pickedAt: "desc"},
select: { symbols: true, symbolsNote: true},
});
if (!row) {
return section("ai-pick", `AI 优选：${dataDate} 还没生成（收盘后自动任务还没跑出结果，或当天无候选），不编。`);
}
const note = (row.symbolsNote?? "").trim();
// 结构化卡（11 字段）能解析 → 每只只列代码、名称、理由（理由去选股日涨跌幅）
const cards = parseAiPickNote(note);
if (cards.length) {
const lines = cards.map((c) => {
const name = (c.name || "").trim();
const sym = (c.symbol || "").trim();
const reason = stripPickDayChangePct(c.reason ?? "");
return `${name ? `${name}（${sym}）` : sym}：${reason ? `入选理由：${reason}` : "入选理由未取到"}`;
});
return section("ai-pick", `AI 优选（${dataDate}）：共 ${cards.length} 只。\n${lines.join("\n")}`);
}
// 旧格式 note（解析不出卡）→ 原文去涨跌幅后截断展示，不冒充有卡
let names: string[] = [];
try {
const syms = JSON.parse(row.symbols?? "[]") as { symbol?: string; name?: string}[];
names = syms.map((s) => `${s.name || ""}（${s.symbol || ""}）`.trim()).filter((x) => x!== "（）");
} catch {
names = [];
}
const head = names.length
? `AI 优选（${dataDate}）：共 ${names.length} 只：${names.join("、")}。`
: `AI 优选（${dataDate}）：已生成但没有具体票（symbols 为空），不编票。`;
const strippedNote = stripPickDayChangePct(note);
const noteText =!strippedNote
? ""
: strippedNote.length > 2000
? `\n${strippedNote.slice(0, 2000)}……（已截断，完整版见 AI 优选战绩记录）`
: `\n${strippedNote}`;
return section("ai-pick", `${head}${noteText}`);
} catch {
return section("ai-pick", "AI 优选：战绩库读不到，算不出今天的 AI 优选。");
}
}

/** 涨停梯队 → 只报涨停龙头（连板最高的前 10 只） */
async function fetchLimitUpSection(): Promise<{ sec: ThreeDailyReportSection; maxBoards: number | null}> {
try {
const r = await computeLimitUp();
const flat = r.tiers.flatMap((t) => t.stocks);
const leaders = pickLimitUpLeaders(flat.map((s) => ({
symbol: s.symbol, name: s.name, boards: s.boards, changePct: s.changePct,
})));
const leaderText = leaders.length
? `涨停龙头（连板最高的前 ${leaders.length} 只）：${leaders.map((s) => `${s.name}（${s.boards} 连板）`).join("、")}。`
: "今天没有涨停龙头（涨停名单为空）。";
const breakText = r.touched_count > 0
? `触板 ${r.touched_count} 家，炸板 ${r.broken_count} 家。`
: "";
return {
sec: section("limit-up", `涨停板：涨停 ${r.limit_up_count} 家，最高 ${r.max_boards} 连板。${breakText}${leaderText}`),
maxBoards: r.max_boards,
};
} catch {
return {
sec: section("limit-up", "涨停板：涨停梯队没取到，算不出今天的涨停龙头。"),
maxBoards: null,
};
}
}

/**
 * 非交易日瘦身版早报（用户 2026-10-17 定，八节）：原有三节（美股 + 重大新闻 + 财联社新闻）
 * + 新增三节（下周大事日历 + 周末政策面 + 大宗商品/汇率/比特币）
 * + 再新增两节（周末公司公告 + 港股周五收盘/AH 溢价），
 * 不重复推昨天交易日的 A 股内容（大盘复盘、板块资金“钱去哪了”、涨跌家数、AI 优选旧数据）。
 * 数据归属 = 今天（issueDate）：美股是昨晚收盘，财联社新闻是今天至今的电报。
 * 新闻条目后直接跟一句自然解释（能解释的才加，分析不出来的只留新闻本身，不加“解读：”标签、不加填充句）。
 */
async function buildSlimMorning(now: Date, issueDate: string): Promise<{ sections: ThreeDailyReportSection[]; missing: string[]}> {
  const missing: string[] = [];
  // 下一交易日标签（交易日历算，不硬编码“周一”）：瘦身版美股节的 A 股影响写
  // “A 股周一（10-19）开盘可能低开”，绝不写“今天开盘”。日历读不到时退回“下一交易日”。
  const nextDay = tradingDaysAfter(issueDate, 1)[0] ?? null;
  const openDayLabel = nextDay ? `${weekdayOf(nextDay)}（${nextDay.slice(5)}）` : "下一交易日";
  const bySector = await fetchDailyReportBySector({ usOpenDayLabel: openDayLabel }).catch(() => null);
  const sections: ThreeDailyReportSection[] = [];
  // 1. 美股昨晚收盘（与完整版早报第 1 节同口径）
  if (bySector) {
    sections.push(section("us-overnight", bySector.usMarket.plain));
    if (!bySector.usMarket.hasData) missing.push("美股昨晚收盘没取到");
  } else {
    sections.push(section("us-overnight", "美股：昨晚收盘没取到，算不出对 A 股的影响。"));
    missing.push("美股昨晚收盘没取到");
  }
  // 2. 重大新闻：美联储 / 预测市场（宏观大事，不含 A 股重推）
  if (bySector) {
    sections.push(section("major-news", bySector.fed.plain));
    if (!bySector.fed.hasData) missing.push("美联储 / 预测市场没取到");
  } else {
    sections.push(section("major-news", "重大新闻：美联储 / 预测市场没取到，算不出加息概率。"));
    missing.push("美联储 / 预测市场没取到");
  }
  // 3. 财联社新闻：今天至今的电报（只报今天的，不拿昨天的冒充）；能解释的直接跟一句自然解释
  try {
    const items = await fetchClsDayItems(issueDate);
    if (!items.length) {
      sections.push(section("cls-news", `财联社新闻：今天（${issueDate}）至今暂无电报。`));
    } else {
      const top = items.slice(0, 15);
      const lines = top.map((it) => {
        const exp = interpretNewsTitle(it.title);
        return `${it.time.slice(11, 16)} ${it.title}${exp ? ` ${exp}` : ""}`;
      });
      sections.push(section(
        "cls-news",
        `财联社新闻：今天（${issueDate}）至今 ${items.length} 条电报，最新 ${top.length} 条：\n${lines.join("\n")}`,
      ));
    }
  } catch {
    sections.push(section("cls-news", "财联社新闻：没取到，算不出今天的新闻。"));
    missing.push("财联社新闻没取到");
  }
  // 4. 下周大事日历（日期均经公开源核实，核实不了的写“没取到”）
  const calendarPlain = buildNextWeekCalendar(issueDate);
  sections.push(section("next-week-calendar", calendarPlain));
  if (calendarPlain.includes("没取到")) missing.push("下周大事日历部分没取到");
  // 5. 周末政策面：周五收盘后至今的政策面电报；没有写“暂无”
  const policy = await buildWeekendPolicy();
  sections.push(section("weekend-policy", policy.plain));
  if (policy.missing) missing.push("周末政策面没取到");
  // 6. 大宗商品 + 汇率 + 比特币（Yahoo 公开行情；取不到的品种写 NULL）
  const comm = await buildCommodities();
  sections.push(section("commodities-fx-btc", comm.plain));
  if (comm.missing) missing.push("大宗商品 / 汇率 / 比特币部分没取到");
  // 7. 周末公司公告：上一交易日收盘后至今的巨潮公司公告（停牌 / 重大事项 / 业绩预告类）
  const company = await buildWeekendCompanyAnnouncements(issueDate);
  sections.push(section("weekend-company", company.plain));
  if (company.missing) missing.push("周末公司公告没取到");
  // 8. 港股周五收盘 + AH 溢价（Yahoo 公开行情；AH 溢价取不到写 NULL，不编）
  const hk = await buildHkFriday(issueDate);
  sections.push(section("hk-friday", hk.plain));
  if (hk.missing) missing.push("港股周五收盘部分没取到");
  return { sections, missing };
}

async function buildMorning(now: Date, dataDate: string): Promise<{ sections: ThreeDailyReportSection[]; missing: string[]}> {
const missing: string[] = [];
const [bySector, reduction] = await Promise.all([
fetchDailyReportBySector().catch(() => null),
fetchDailyReductionRisk(dataDate).catch(() => null),
]);
const sections: ThreeDailyReportSection[] = [];
// 1. 美股昨晚收盘（美股北京时间凌晨 4:00 已收盘，8:30 能拿完整收盘）
if (bySector) {
sections.push(section("us-overnight", bySector.usMarket.plain));
if (!bySector.usMarket.hasData) missing.push("美股昨晚收盘没取到");
} else {
sections.push(section("us-overnight", "美股：昨晚收盘没取到，算不出对 A 股的影响。"));
missing.push("美股昨晚收盘没取到");
}
// 2. 昨天 A 股复盘：明确标“昨天”，不要把昨天当今天
if (bySector?.hasData) {
const divCards = pickDivergenceHighlights(bySector.cards.map((c) => ({
name: c.name, changePct: c.changePct, netYi: c.netYi, plain: c.plain,
})));
const divText = divCards.length
? `昨天有 ${divCards.length} 个板块钱和价打架：${divCards.map((c) => c.plain).join(" ")}`
: "昨天没有板块出现钱和价打架。";
sections.push(section(
"yesterday-review",
`昨天（${dataDate}）A 股复盘：${toYesterday(bySector.sectorFlow.plain)} ${toYesterday(bySector.mainLineReduction.plain)} ${toYesterday(divText)}`,
));
} else {
sections.push(section("yesterday-review", `昨天（${dataDate}）A 股复盘：板块数据没取到，算不出昨天的情况。`));
missing.push("昨天 A 股板块数据没取到");
}
// 3. 今天看什么：等什么信号再买（只从上面取到的事实推导）
const usDown = bySector?.usMarket.quotes.find((q) => q.symbol === "SPY")?.changePct
?? bySector?.usMarket.quotes.find((q) => q.symbol === "VOO")?.changePct
?? null;
const nvda = bySector?.usMarket.quotes.find((q) => q.symbol === "NVDA")?.changePct?? null;
const watch = buildWatchToday({
usDown: usDown == null? null: usDown < 0,
nvdaDownSharp: nvda == null? null: nvda < -1,
mainLines: bySector?.mainLineReduction.mainLines.map((m) => m.name)?? [],
divergences: bySector
? pickDivergenceHighlights(bySector.cards.map((c) => ({ name: c.name, changePct: c.changePct, netYi: c.netYi, plain: c.plain}))).map((c) => c.name)
: [],
mainLineReductions: bySector?.mainLineReduction.continuous.map((c) => c.name)?? [],
bigHolderReductions: reduction?.hasData? reduction.bigHolderCount: null,
fedHikeHigh: (() => {
const oct = bySector?.fed.meetings[0]?.avgHikePct?? null;
return oct == null? null: oct >= 50;
})(),
});
sections.push(section("watch-today", `今天看什么（等什么信号再买）：${watch.join(" ")}`));
// 4. 风险提示：昨天减持 + 美联储/预测市场 + 动态相关
const riskParts: string[] = [];
if (reduction?.hasData) riskParts.push(toYesterday(reduction.plain));
else { riskParts.push("减持风险：巨潮公告没取到，算不出昨天谁在减持。"); missing.push("减持风险没取到");}
if (bySector) {
riskParts.push(bySector.fed.plain);
if (bySector.feedRelated.hasData || bySector.feedRelated.checkedCount!= null) riskParts.push(bySector.feedRelated.plain);
}
sections.push(section("risk", `风险提示：${riskParts.join(" ")}`));
return { sections, missing};
}

async function buildNoon(now: Date, dataDate: string): Promise<{ sections: ThreeDailyReportSection[]; missing: string[]}> {
const missing: string[] = [];
const bySector = await fetchDailyReportBySector().catch(() => null);
const limitUp = await fetchLimitUpSection();
const sections: ThreeDailyReportSection[] = [];
// 1. 上午盘复盘：上午涨/跌、钱去了哪、哪个板块突然动了
if (bySector?.hasData) {
const divCards = pickDivergenceHighlights(bySector.cards.map((c) => ({
name: c.name, changePct: c.changePct, netYi: c.netYi, plain: c.plain,
})));
const movedText = divCards.length
? `突然动了的板块（钱和价打架，口径见注）：${divCards.map((c) => c.plain).join(" ")}`
: "上午没有板块出现钱和价打架，没有突然动了的板块。";
sections.push(section(
"morning-session",
`上午盘（${dataDate} 9:30–11:30）复盘：${toMorning(bySector.sectorFlow.plain)} ${toMorning(bySector.mainLineReduction.plain)} ${toMorning(movedText)} ${limitUp.sec.plain}`
+ " 注：“突然动了”以资金与价格打架 + 上午资金 Top 为口径（没有上一时刻快照对比，不编涨速）。",
));
} else {
sections.push(section(
"morning-session",
`上午盘（${dataDate} 9:30–11:30）复盘：板块数据没取到，算不出上午的情况。${limitUp.sec.plain}`,
));
missing.push("上午盘板块数据没取到");
}
if (limitUp.maxBoards == null) missing.push("涨停梯队没取到");
// 2. 什么时候卖最合适（午报两点对比：10:30 vs 11:30 休盘；收盘还没发生，比不了收盘）
try {
  const pairText = await sellPairSectionNoon(dataDate);
  sections.push(section("sell-window", pairText));
} catch {
  sections.push(section("sell-window", "什么时候卖最合适（午报两点对比）：快照读不到，比不出哪个时间卖最合适。"));
  missing.push("卖点快照没取到");
}
// 3. 下午看什么（13:00–15:00）
const afternoon = buildAfternoonWatch({
divergences: bySector
? pickDivergenceHighlights(bySector.cards.map((c) => ({ name: c.name, changePct: c.changePct, netYi: c.netYi, plain: c.plain}))).map((c) => c.name)
: [],
maxBoards: limitUp.maxBoards,
topInflowSector: bySector?.sectorFlow.topInflow[0]?.name?? null,
topOutflowSector: bySector?.sectorFlow.topOutflow[0]?.name?? null,
});
sections.push(section("afternoon-watch", `下午看什么（13:00–15:00）：${afternoon.join(" ")}`));
return { sections, missing};
}

async function buildEvening(now: Date, dataDate: string): Promise<{ sections: ThreeDailyReportSection[]; missing: string[]}> {
const missing: string[] = [];
const [bySector, reduction, limitUp, aiPick] = await Promise.all([
fetchDailyReportBySector().catch(() => null),
fetchDailyReductionRisk(dataDate).catch(() => null),
fetchLimitUpSection(),
fetchStoredAiPick(dataDate),
]);
const sections: ThreeDailyReportSection[] = [];
// 1. 今天收盘：大盘 + 板块资金
if (bySector?.hasData) {
sections.push(section(
"close",
`今天（${dataDate}）A 股收盘：${bySector.sectorFlow.plain} ${limitUp.sec.plain}`,
));
} else {
sections.push(section("close", `今天（${dataDate}）A 股收盘：板块数据没取到，算不出今天的情况。`));
missing.push("今天收盘板块数据没取到");
}
// 2. 分歧：只报打架的板块（最多 5 个）
if (bySector?.hasData) {
const divCards = pickDivergenceHighlights(bySector.cards.map((c) => ({
name: c.name, changePct: c.changePct, netYi: c.netYi, plain: c.plain,
})));
sections.push(section(
"divergence",
divCards.length
? `分歧（钱和价打架，只报前 ${divCards.length} 个）：${divCards.map((c) => c.plain).join(" ")}`
: "分歧：今天没有板块出现钱和价打架。",
));
} else {
sections.push(section("divergence", "分歧：板块数据没取到，算不出今天的分歧。"));
}
// 3. 涨停板（已在收盘节里带一句，这里是龙头明细）
sections.push(limitUp.sec);
if (limitUp.maxBoards == null) missing.push("涨停梯队没取到");
// 4. 减持风险：只报重点（大股东先报，最多 10 条明细，其余只报总数）
if (reduction?.hasData) {
const picked = pickReductionHighlights(reduction.rows.map((r) => ({
plainLine: r.plainLine,
isBigHolder: r.holder === "控股股东" || r.holder === "大股东",
})));
const overflowText = picked.overflow > 0? `其余 ${picked.overflow} 只见巨潮公告。`: "";
sections.push(section(
"reduction",
`减持风险：今天全市场 ${reduction.total} 只票发了减持公告，其中大股东 ${reduction.bigHolderCount} 只。`
+ (picked.lines.length? `重点：${picked.lines.join("；")}。${overflowText}`: "今天没有需要重点报的减持。"),
));
} else {
sections.push(section("reduction", "减持风险：巨潮公告没取到，算不出今天谁在减持。"));
missing.push("减持风险没取到");
}
// 5. AI 优选（读已落库的结果，不重跑模型）
sections.push(aiPick);
// 5b. AI 优选分版胜率（只在卖出日算：决策日 = 卖出日是今天的那个决策日；验证日 = 今天 = 卖出日 D+2。
// 与接口 /api/daily-report/ai-pick-versions 用同一份 compute 结果，两处呈现同一份对比。）
try {
  const decisionDate = await decisionDateSellingOn(dataDate);
  if (!decisionDate) {
    sections.push(section("ai-pick-version-winrate", "AI 优选分版胜率：今天没有 AI 优选版本到卖出日（卖出日 = 决策日之后第 2 个交易日），没有分版胜率要算。"));
  } else {
    const stats = await computeAiPickVersionStats(decisionDate, dataDate);
    sections.push(section("ai-pick-version-winrate", buildAiPickVersionWinRateSection(decisionDate, dataDate, stats.versions, stats.missing)));
  }
} catch {
  sections.push(section("ai-pick-version-winrate", "AI 优选分版胜率：版本文件读不到，算不出。"));
  missing.push("AI 优选分版胜率没取到");
}
// 6. 主线（含主线里连续减持）
if (bySector?.hasData) {
sections.push(section("main-line", bySector.mainLineReduction.plain));
} else {
sections.push(section("main-line", "主线：板块数据没取到，算不出今天的主线。"));
}
// 7. 什么时候卖最合适（三个卖点对比：今天 10:30 / 11:30 休盘 / 15:00 收盘，成本 = 昨天收盘价）
try {
  const sellText = await sellWindowSection(dataDate);
  sections.push(section("sell-window", sellText));
} catch {
  sections.push(section("sell-window", "什么时候卖最合适（10:30 / 11:30 休盘 / 15:00 收盘对比）：快照读不到，比不出哪个时间卖最合适。"));
  missing.push("卖点快照没取到");
}
return { sections, missing};
}

/**
* 生成一份日报。
* force=false 时已有同日同份落档直接返回（不重复拉数据源）；force=true 强制重算。
* 非交易日：早报走瘦身版（原有三节 + 下周大事日历 + 周末政策面 + 大宗商品/汇率/比特币 = 六节），午/晚报抛错不发；
* 调度器层：非交易日只跑早报（瘦身版），午/晚报记 skipped。日历读不到（null）时按老逻辑走完整版。
* 手动触发（API?force=1）允许在任意日生成，但正文里的数据归属日期照实写。
*/
export async function fetchThreeDailyReport(
slot: ReportSlot,
now = new Date(),
opts?: { force?: boolean},
): Promise<ThreeDailyReport> {
const def = slotDefOf(slot);
// 午报门禁：12:00 之前不生成、不推送（定时器和手动强制都挡）。
// 09:56 的数据是“上午盘中快照”，不是午报；不要用盘中快照冒充午报。
if (slot === "noon") {
  const gate = noonGate(now);
  if (!gate.allowed) throw new NoonNotDueError(gate.reason);
}
const issueDate = shanghaiDate(now);
if (!opts?.force) {
const stored = await readStoredReport(issueDate, slot);
if (stored) return stored;
}
// 非交易日分流（用户 2026-10-17 定）：非交易日只发早报瘦身版（八节，
// 不重复推昨天 A 股内容）；午/晚报在非交易日不发。日历读不到（null）时按老逻辑走完整版，
// 调度器层仍按“日历读不到不发”处理，不在这里猜。
const tradingDay = isTradingDay(issueDate);
const slim = tradingDay === false && slot === "morning";
if (tradingDay === false && slot !== "morning") {
  throw new Error(`非交易日只发早报瘦身版，${slot}不发（${issueDate} 不是 A 股交易日）。`);
}
// 早报的 dataDate 必须是签发日的上一交易日：用 morningDataDate 按 08:00 盘前口径解析，
// 不用 resolveTradeDate(now)——它开盘后翻成今天，会把今天标成「昨天」（2026-10-16 实测）。
const dataDate = slim
  ? issueDate
  : slot === "morning"
    ? (await morningDataDate(issueDate).catch(() => null))
      ?? (await resolveTradeDate(now).catch(() => null))?.date
      ?? issueDate
    : (await resolveTradeDate(now).catch(() => null))?.date ?? issueDate;
// 未到时刻生成 → 盘中快照，不是定稿（晚报 15:00 前；午报 12:00 前已被门禁挡住，走到这里一定是定稿）
const stamp = shanghaiStamp(now);
const minuteOfDay = Number(stamp.slice(11, 13)) * 60 + Number(stamp.slice(14, 16));
const preliminary = slot === "evening"? minuteOfDay < 15 * 60 : false;
const built = slim
? await buildSlimMorning(now, issueDate)
: slot === "morning"
? await buildMorning(now, dataDate)
: slot === "noon"
? await buildNoon(now, dataDate)
: await buildEvening(now, dataDate);
const plain = built.sections
.map((s) => `${s.plain}`)
.join("\n\n");
const report: ThreeDailyReport = {
slot,
label: def.label,
title: def.title,
issueDate,
dataDate,
dataBelongsTo: slim
? `非 A 股交易日瘦身版：美股 + 重大新闻 + 财联社新闻 + 下周大事日历 + 周末政策面 + 大宗商品/汇率/比特币 + 周末公司公告 + 港股周五收盘/AH 溢价，不重复推昨天 A 股内容（${issueDate}）`
: slot === "morning"
? `美股是昨晚收盘；A 股复盘是昨天（${dataDate}）`
: slot === "noon"
? `上午盘（${dataDate} 9:30–11:30）`
: `今天（${dataDate}）收盘`,
generatedAt: stamp,
preliminary,
slim: slim || undefined,
sections: built.sections,
plain: preliminary
? `（盘中快照，未到收盘/午盘时刻，不是定稿）\n${plain}`
: plain,
hasData: built.sections.some((s) =>!s.plain.includes("没取到")),
missing: built.missing,
};
await persistReport(report);
return report;
}
