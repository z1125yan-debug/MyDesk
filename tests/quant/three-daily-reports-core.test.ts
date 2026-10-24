// 三份日报纯核单测：时段 / 门禁 / 只报重点上限 / “看什么”条件句
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_SLOT_DEFS,
  buildAfternoonWatch,
  buildWatchToday,
  isSlotDue,
  nextReportSlot,
  pickDivergenceHighlights,
  pickLimitUpLeaders,
  pickReductionHighlights,
  slotAtForDate,
  tradingDayGate,
} from "../../src/lib/desk/three-daily-reports-core.ts";

test("三份日报时段：早报 08:30 / 午报 12:00 / 晚报 16:00（北京时间）", () => {
  const bySlot = Object.fromEntries(REPORT_SLOT_DEFS.map((d) => [d.slot, d.minuteOfDay]));
  assert.equal(bySlot.morning, 510);
  assert.equal(bySlot.noon, 720);
  assert.equal(bySlot.evening, 960);
  // 2026-10-16 是周五：早报触发时刻 = 北京时间 08:30 = UTC 00:30
  const at = slotAtForDate("2026-10-16", "morning");
  assert.equal(at?.toISOString(), "2026-10-16T00:30:00.000Z");
  // 周末不排班
  assert.equal(slotAtForDate("2026-10-17", "morning"), null); // 周六
  assert.equal(slotAtForDate("2026-10-18", "evening"), null); // 周日
});

test("门禁：非交易日不发；日历读不到也不发（不猜）", () => {
  assert.equal(tradingDayGate(false, "2026-10-17").send, false);
  assert.equal(tradingDayGate(null, "2026-10-16").send, false);
  assert.equal(tradingDayGate(true, "2026-10-16").send, true);
});

test("只报重点：分歧最多 5 个（按 |净流入| 从大到小）；涨停龙头最多 10 只；减持大股东先报、最多 10 条", () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({
    name: `板块${i}`, changePct: -1, netYi: (i + 1) * 10, plain: `p${i}`,
  }));
  assert.deepEqual(
    pickDivergenceHighlights(cards).map((c) => c.name),
    ["板块7", "板块6", "板块5", "板块4", "板块3"],
  );
  // 方向一致的不算分歧
  assert.equal(pickDivergenceHighlights([{ name: "A", changePct: 1, netYi: 5, plain: "" }]).length, 0);
  const leaders = Array.from({ length: 12 }, (_, i) => ({
    symbol: `00000${i}`, name: `股${i}`, boards: i + 1, changePct: 10,
  }));
  assert.equal(pickLimitUpLeaders(leaders).length, 10);
  assert.equal(pickLimitUpLeaders(leaders)[0].boards, 12);
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ plainLine: `小${i}`, isBigHolder: false })),
    ...Array.from({ length: 12 }, (_, i) => ({ plainLine: `大${i}`, isBigHolder: true })),
  ];
  const picked = pickReductionHighlights(rows);
  assert.equal(picked.lines.length, 10);
  assert.equal(picked.overflow, 5);
  assert.ok(picked.lines[0].startsWith("大"));
});

test("早报“今天看什么”：无信号时明说先看不买，不编信号", () => {
  const watch = buildWatchToday({
    usDown: null, nvdaDownSharp: null, mainLines: [], divergences: [],
    mainLineReductions: [], bigHolderReductions: null, fedHikeHigh: null,
  });
  assert.ok(watch.some((w) => w.includes("先看不买") || w.includes("先看、不急着买")));
  const withSignal = buildWatchToday({
    usDown: true, nvdaDownSharp: true, mainLines: ["半导体"], divergences: ["白酒"],
    mainLineReductions: ["某票"], bigHolderReductions: 12, fedHikeHigh: true,
  });
  assert.ok(withSignal.some((w) => w.includes("低开")));
  assert.ok(withSignal.some((w) => w.includes("半导体") && w.includes("别急着买")));
  assert.ok(withSignal.some((w) => w.includes("避开")));
});

test("午报“下午看什么”：分歧收敛 + 最高板封板 + 资金延续", () => {
  const watch = buildAfternoonWatch({
    divergences: ["白酒"], maxBoards: 3, topInflowSector: "半导体", topOutflowSector: "煤炭",
  });
  assert.ok(watch.some((w) => w.includes("白酒") && w.includes("收不收敛")));
  assert.ok(watch.some((w) => w.includes("3 连板") && w.includes("封不封得住")));
  assert.ok(watch.some((w) => w.includes("半导体") && w.includes("继续吸金")));
});

test("下一份日报：今天已过时刻顺延；isSlotDue 只认当日时刻", () => {
  // 北京时间 2026-10-16 09:00（UTC 01:00）：下一份是当日午报
  const next = nextReportSlot(new Date("2026-10-16T01:00:00Z"));
  assert.equal(next.date, "2026-10-16");
  assert.equal(next.slot, "noon");
  assert.equal(isSlotDue(new Date("2026-10-16T01:00:00Z"), "morning"), true);
  assert.equal(isSlotDue(new Date("2026-10-16T01:00:00Z"), "noon"), false);
});
