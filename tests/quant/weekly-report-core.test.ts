// 周报 + 大事件触发纯核单测（零 IO / 零时钟 → 常规回归必跑）
// 覆盖：周范围、复利口径、主线变化、战绩聚合、缺数口径、触发阈值与去重键。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  buildWeeklyReport,
  compoundWeeklyPct,
  evaluateBigEventTriggers,
  parseCnMeetingDate,
  weekRangeOf,
  weekdayLabel,
  type WeeklyReportInput,
} from "../../src/lib/desk/weekly-report-core.ts";

test("周范围：周日所在周的周一/周日/下周一", () => {
  assert.deepEqual(weekRangeOf("2026-10-18"), { monday: "2026-10-12", sunday: "2026-10-18", nextMonday: "2026-10-19" });
  assert.deepEqual(weekRangeOf("2026-10-14"), { monday: "2026-10-12", sunday: "2026-10-18", nextMonday: "2026-10-19" });
  assert.equal(weekdayLabel("2026-10-18"), "周日");
  assert.equal(addDays("2026-10-18", 1), "2026-10-19");
});

test("会议日期解析：带日能解析，只到月解析不出", () => {
  assert.equal(parseCnMeetingDate("10月28日", 2026), "2026-10-28");
  assert.equal(parseCnMeetingDate("12月", 2026), null);
  assert.equal(parseCnMeetingDate("12月会议", 2026), null);
});

test("本周涨跌是复利不是相加；缺数跳过，全缺为 null", () => {
  // 10% 再 -10% = -1%，不是 0
  assert.ok(Math.abs(compoundWeeklyPct([10, -10])! - (-1)) < 1e-9);
  assert.ok(Math.abs(compoundWeeklyPct([1, null, 1])! - 2.01) < 1e-9);
  assert.equal(compoundWeeklyPct([null, null]), null);
  assert.equal(compoundWeeklyPct([]), null);
});

const baseInput = (): WeeklyReportInput => ({
  sunday: "2026-10-18",
  weekStart: "2026-10-12",
  weekEnd: "2026-10-16",
  tradingDays: ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"],
  indexWeeklyPct: 1.5,
  allAMedianWeeklyPct: 0.8,
  sectors: [
    { name: "半导体", dailyMedianChange: [2, 2, 2, 2, 2] },
    { name: "白酒", dailyMedianChange: [1, 1, 1, 1, 1] },
    { name: "煤炭", dailyMedianChange: [-2, -2, -2, -2, -2] },
  ],
  prevWeekSectors: [
    { name: "半导体", dailyMedianChange: [1, 1, 1, 1, 1] },
    { name: "白酒", dailyMedianChange: [1, 1, 1, 1, 1] },
    { name: "医药", dailyMedianChange: [3, 3, 3, 3, 3] },
  ],
  picks: [],
  limitUpLeaders: [],
  fedPlain: "美联储：没取到。",
  fedMeetings: [{ meeting: "10月28日", date: "2026-10-28" }],
  nextWeekTradingDays: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
  nextWeekHolidayWindows: [],
});

test("周报：最强/最弱/主线/主线变化（留+新进+掉出）", () => {
  const r = buildWeeklyReport(baseInput());
  assert.equal(r.strongest[0].name, "半导体");
  assert.equal(r.weakest[0].name, "煤炭");
  assert.deepEqual(r.mainLine.map((s) => s.name), ["半导体", "白酒"]);
  assert.match(r.mainLineChange, /留下的主线：半导体、白酒/);
  assert.match(r.mainLineChange, /掉出主线：医药/);
  assert.match(r.plain, /大盘：上证指数本周涨 1.50%/);
  assert.match(r.plain, /战绩：本周没有 AI 优选计入战绩/);
});

test("周报：战绩聚合——已回填均值 + 跑赢基准 + 上涨只数", () => {
  const input = baseInput();
  input.picks = [
    { tradeDate: "2026-10-12", nextDaySymWin: 2, nextDaySymUp: 3, nextDaySymCount: 4, nextDayBenchNet: 0.2 },
    { tradeDate: "2026-10-13", nextDaySymWin: -1, nextDaySymUp: 1, nextDaySymCount: 2, nextDayBenchNet: 0.2 },
    { tradeDate: "2026-10-14", nextDaySymWin: null, nextDaySymUp: null, nextDaySymCount: null, nextDayBenchNet: null },
  ];
  const r = buildWeeklyReport(input);
  assert.equal(r.picks.days, 3);
  assert.equal(r.picks.filledDays, 2);
  assert.equal(r.picks.avgWinPct, 0.5);
  assert.equal(r.picks.upCount, 4);
  assert.equal(r.picks.totalCount, 6);
  assert.match(r.picks.plain, /跑赢全 A 中位个股基准/);
});

test("周报：战绩未回填 → 写没取到，不编收益", () => {
  const input = baseInput();
  input.picks = [
    { tradeDate: "2026-10-12", nextDaySymWin: null, nextDaySymUp: null, nextDaySymCount: null, nextDayBenchNet: null },
  ];
  const r = buildWeeklyReport(input);
  assert.equal(r.picks.avgWinPct, null);
  assert.match(r.picks.plain, /没取到/);
});

test("周报：财报/解禁永远没取到；下周议息在下周内才提醒", () => {
  const input = baseInput();
  input.fedMeetings = [{ meeting: "10月21日", date: "2026-10-21" }];
  const r = buildWeeklyReport(input);
  assert.equal(r.nextWeekEarnings, null);
  assert.equal(r.nextWeekUnlocks, null);
  assert.match(r.plain, /财报：没取到/);
  assert.match(r.plain, /解禁：没取到/);
  assert.match(r.plain, /下周有美联储议息：10月21日/);
});

test("周报：上周快照缺数 → 主线变化写对比不了", () => {
  const input = baseInput();
  input.prevWeekSectors = [];
  const r = buildWeeklyReport(input);
  assert.match(r.mainLineChange, /对比不了/);
});

test("大事件：美联储议息 + 重磅政策只认全球级/重大产业事件", () => {
  const alerts = evaluateBigEventTriggers({
    date: "2026-10-16",
    events: [
      { title: "美联储议息会议决定降息", level: "全球级事件", time: "02:00" },
      { title: "国务院发布重磅政策支持半导体", level: "重大产业事件", time: "10:00" },
      { title: "美联储官员讲话", level: "普通新闻", time: "11:00" },
      { title: "某公司发布财报", level: "行业新闻", time: "12:00" },
    ],
    sectors: [],
    mainLineNames: [],
    aiPickNames: [],
    indexChangePct: null,
  });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].kind, "fed");
  assert.equal(alerts[1].kind, "policy");
  assert.match(alerts[0].plain, /重点看/);
});

test("大事件：板块暴涨/暴跌阈值 5%（4.9 不触发，5.0 触发）", () => {
  const mk = (changePct: number) => evaluateBigEventTriggers({
    date: "2026-10-16",
    events: [],
    sectors: [{ name: "半导体", changePct, netYi: 10, leader: "某龙头", leaderPct: 1 }],
    mainLineNames: [],
    aiPickNames: [],
    indexChangePct: null,
  });
  assert.equal(mk(4.9).length, 0);
  assert.equal(mk(5).length, 1);
  assert.equal(mk(5)[0].kind, "sector_surge");
  assert.equal(mk(-5)[0].kind, "sector_plunge");
});

test("大事件：个股涨停只报重点——主线龙头触发，非重点不触发，20cm 真封板例外", () => {
  const mk = (leader: string, leaderPct: number, mainLineNames: string[], aiPickNames: string[]) =>
    evaluateBigEventTriggers({
      date: "2026-10-16",
      events: [],
      sectors: [{ name: "半导体", changePct: 1, netYi: 10, leader, leaderPct }],
      mainLineNames,
      aiPickNames,
      indexChangePct: null,
    });
  // 主线板块龙头 +9.8% → 触发
  assert.equal(mk("龙头A", 9.8, ["半导体"], [])[0]?.kind, "stock_limit_up");
  // 非主线、非 AI 选 +9.8% → 不触发（日常涨停不报）
  assert.equal(mk("路人B", 9.8, [], []).length, 0);
  // AI 选的票 +9.8% → 触发
  assert.equal(mk("路人B", 9.8, [], ["路人B"])[0]?.kind, "stock_limit_up");
  // 非重点但 20cm 真封板 → 触发
  assert.equal(mk("路人C", 20, [], [])[0]?.kind, "stock_limit_up");
  // 主线龙头大跌 -10% → 跌停提醒
  assert.equal(mk("龙头A", -10, ["半导体"], [])[0]?.kind, "stock_limit_down");
});

test("大事件：大盘暴涨/暴跌阈值 3%（收盘后才有数，盘中 null 不判）", () => {
  const mk = (indexChangePct: number | null) => evaluateBigEventTriggers({
    date: "2026-10-16",
    events: [],
    sectors: [],
    mainLineNames: [],
    aiPickNames: [],
    indexChangePct,
  });
  assert.equal(mk(null).length, 0);
  assert.equal(mk(2.9).length, 0);
  assert.equal(mk(3)[0].kind, "index_surge");
  assert.equal(mk(-3.5)[0].kind, "index_plunge");
});

test("大事件：去重键同日同类同主体唯一", () => {
  const input = {
    date: "2026-10-16",
    events: [{ title: "美联储议息会议决定降息", level: "全球级事件", time: "02:00" }],
    sectors: [{ name: "半导体", changePct: 6, netYi: 10, leader: "龙头A", leaderPct: 10 }],
    mainLineNames: ["半导体"],
    aiPickNames: [],
    indexChangePct: null,
  };
  const a = evaluateBigEventTriggers(input);
  const b = evaluateBigEventTriggers(input);
  assert.deepEqual(a.map((x) => x.dedupeKey), b.map((x) => x.dedupeKey));
  assert.equal(new Set(a.map((x) => x.dedupeKey)).size, a.length);
  assert.ok(a.every((x) => x.plain.includes("重点看")));
});

// ── 调度时刻（周报周日 20:00 / 大事件工作日 9:30–15:30 每 15 分钟） ──
import {
  isBigEventDue,
  isBigEventWindow,
  isWeeklyDue,
  weeklySlotForDate,
} from "../../src/lib/quant/scheduler/rules.ts";

test("周报时刻：只在周日 20:00 后到点", () => {
  assert.equal(weeklySlotForDate("2026-10-18")?.toISOString(), "2026-10-18T12:00:00.000Z"); // 周日北京 20:00 = UTC 12:00
  assert.equal(weeklySlotForDate("2026-10-19"), null); // 周一不排
  assert.equal(weeklySlotForDate("2026-10-17"), null); // 周六不排
  assert.equal(isWeeklyDue(new Date("2026-10-18T11:59:00Z")).due, false); // 周日 19:59 未到
  assert.equal(isWeeklyDue(new Date("2026-10-18T12:00:00Z")).due, true); // 周日 20:00 到点
  assert.equal(isWeeklyDue(new Date("2026-10-19T12:00:00Z")).due, false); // 周一不到
});

test("大事件窗口：工作日 9:30–15:30，间隔 15 分钟", () => {
  assert.equal(isBigEventWindow(new Date("2026-10-16T01:29:00Z")), false); // 周五 09:29 未开
  assert.equal(isBigEventWindow(new Date("2026-10-16T01:30:00Z")), true); // 周五 09:30 开
  assert.equal(isBigEventWindow(new Date("2026-10-16T07:30:00Z")), true); // 周五 15:30 含
  assert.equal(isBigEventWindow(new Date("2026-10-16T07:31:00Z")), false); // 周五 15:31 出窗口
  assert.equal(isBigEventWindow(new Date("2026-10-17T02:00:00Z")), false); // 周六不查
  const now = new Date("2026-10-16T02:00:00Z"); // 周五 10:00
  assert.equal(isBigEventDue(now, 0), true); // 没查过 → 到点
  assert.equal(isBigEventDue(now, now.getTime() - 14 * 60_000), false); // 14 分钟前查过 → 未到
  assert.equal(isBigEventDue(now, now.getTime() - 15 * 60_000), true); // 15 分钟前查过 → 到点
});
