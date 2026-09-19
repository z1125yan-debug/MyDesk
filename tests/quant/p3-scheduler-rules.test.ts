// P2-自动化 调度规则单测（纯函数，无网络/无 DB → 常规回归必跑，不允许 skipped 蒙混）
// 覆盖：北京时间口径、周末不排班、收盘后窗口、幂等判定（成功/失败重试/执行中互斥/休市终止/盘中手动不挡收盘自动）、
//       交易日确证（确证不了时不猜测）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCHEDULER_CONFIG, SKIP_REASON_TEXT, addBeijingDays, beijingInstant, beijingMidnightUtc, beijingParts,
  decideRun, isDueWindow, isWeekend, judgeTradingDay, nextSlot, slotAtForDate, weekdayOf,
  type TaskRunRowLite,
} from "../../src/lib/quant/scheduler/rules.ts";

const CFG = DEFAULT_SCHEDULER_CONFIG; // 15:00 收盘 + 20 分钟等待 = 15:20，每日最多 3 次尝试
const row = (status: string, startedMinAgo: number, finishedMinAgo?: number, reason = ""): TaskRunRowLite => ({
  status,
  startedAt: Date.now() - startedMinAgo * 60_000,
  finishedAt: finishedMinAgo === undefined ? null : Date.now() - finishedMinAgo * 60_000,
  reason,
});

test("北京时间换算不依赖宿主时区", () => {
  const p = beijingParts(new Date("2026-09-21T07:30:00Z")); // UTC 07:30 = 北京 15:30
  assert.equal(p.date, "2026-09-21");
  assert.equal(p.minuteOfDay, 15 * 60 + 30);
  assert.equal(p.weekday, 1); // 周一
  const late = beijingParts(new Date("2026-09-20T17:30:00Z")); // UTC 17:30 = 北京次日 01:30
  assert.equal(late.date, "2026-09-21");
  assert.equal(late.minuteOfDay, 60 + 30);
});

test("北京时刻与日期的往返一致", () => {
  assert.equal(beijingInstant("2026-09-21", 15 * 60 + 20).toISOString(), "2026-09-21T07:20:00.000Z");
  assert.equal(new Date(beijingMidnightUtc("2026-09-21") + 8 * 3600_000).toISOString(), "2026-09-21T00:00:00.000Z");
  assert.equal(addBeijingDays("2026-09-30", 1), "2026-10-01"); // 跨月
  assert.equal(addBeijingDays("2026-01-01", -1), "2025-12-31"); // 跨年
  assert.equal(weekdayOf("2026-09-19"), 6); // 周六
  assert.ok(isWeekend(0) && isWeekend(6) && !isWeekend(1));
});

test("周末不排班，窗口顺延到下一工作日", () => {
  assert.equal(slotAtForDate("2026-09-19", CFG), null); // 周六
  assert.equal(slotAtForDate("2026-09-20", CFG), null); // 周日
  const mon = slotAtForDate("2026-09-21", CFG);
  assert.ok(mon, "工作日必须有触发时刻");
  assert.equal(mon.toISOString(), "2026-09-21T07:20:00.000Z");

  const friEvening = new Date("2026-09-18T12:00:00Z"); // 北京周五 20:00，已过收盘窗口
  const nxt = nextSlot(friEvening, CFG);
  assert.equal(nxt.date, "2026-09-21"); // 跳过周末
  assert.equal(nxt.at.toISOString(), "2026-09-21T07:20:00.000Z");

  const monMorning = new Date("2026-09-21T01:00:00Z"); // 北京周一 09:00，当日窗口未到
  assert.equal(nextSlot(monMorning, CFG).date, "2026-09-21");
});

test("执行窗口判定：未到点不触发，到点后才触发，周末整天不触发", () => {
  const before = isDueWindow(new Date("2026-09-21T07:00:00Z"), CFG); // 北京 15:00
  assert.equal(before.due, false);
  assert.equal(before.tradeDate, "2026-09-21");
  const after = isDueWindow(new Date("2026-09-21T07:20:00Z"), CFG); // 北京 15:20 整
  assert.equal(after.due, true);
  assert.equal(after.slotAt?.toISOString(), "2026-09-21T07:20:00.000Z");
  const sat = isDueWindow(new Date("2026-09-19T09:00:00Z"), CFG);
  assert.equal(sat.due, false);
  assert.equal(sat.slotAt, null);
});

test("幂等：当日已有成功结果不再重复跑", () => {
  assert.deepEqual(decideRun([row("success", 30, 25)], CFG), { action: "skip", reason: "already_success" });
  assert.equal(SKIP_REASON_TEXT.already_success.includes("收盘后"), true);
});

test("幂等：盘中手动扫描不算收盘结果，不会挡掉收盘后的自动扫描", () => {
  // 窗口设在「1 小时前」= 今日收盘扫描已到点（用相对时刻，避免断言随真实时钟漂移）
  const slot = Date.now() - 60 * 60_000;
  const morning = row("success", 300, 295); // 约 5 小时前完成（北京上午），早于窗口
  assert.deepEqual(decideRun([morning], CFG, Date.now(), slot), { action: "run", attempt: 1 });
  const afterClose = row("success", 5, 2); // 窗口之后完成 → 当日收盘结果已存在
  assert.equal(decideRun([afterClose], CFG, Date.now(), slot).action, "skip");
  // 自动口径之外（successSince=0，即手动补跑接口）任何成功都算，避免重复打数据源
  assert.equal(decideRun([morning], CFG, Date.now(), 0).action, "skip");
});

test("幂等：执行中互斥，崩溃遗留的 running 过期后自动放行（任务恢复）", () => {
  assert.deepEqual(decideRun([row("running", 5)], CFG), { action: "skip", reason: "running" });
  assert.deepEqual(decideRun([row("running", 40)], CFG), { action: "run", attempt: 1 });
  // 陈旧 running + 已有失败 → 仍按失败次数排第 2 次
  assert.deepEqual(decideRun([row("running", 45), row("failure", 20, 19)], CFG), { action: "run", attempt: 2 });
});

test("失败可重试但有上限，休市一旦确证当天不再探测", () => {
  assert.deepEqual(decideRun([row("failure", 30, 29)], CFG), { action: "run", attempt: 2 });
  assert.deepEqual(decideRun([row("failure", 30, 29), row("failure", 20, 19), row("failure", 10, 9)], CFG),
    { action: "skip", reason: "max_attempts" });
  assert.equal(SKIP_REASON_TEXT.max_attempts.includes("上限"), true);
  assert.deepEqual(decideRun([row("skipped", 30, 29, "non_trading_day")], CFG), { action: "skip", reason: "non_trading_day" });
  // 「确证不了」不是终态：允许后续再探测（由上层限速），这里不得永久拦截
  assert.deepEqual(decideRun([row("skipped", 30, 29, "trading_day_unconfirmed")], CFG), { action: "run", attempt: 1 });
});

test("交易日确证只认指数日线，取不到时明确「不可确证」而不是猜", () => {
  const ok = judgeTradingDay("2026-09-21", "2026-09-21");
  assert.equal(ok.isTradingDay, true);
  assert.match(ok.basis, /2026-09-21/);
  const closed = judgeTradingDay("2026-09-21", "2026-09-18");
  assert.equal(closed.isTradingDay, false);
  assert.match(closed.basis, /休市/);
  const unknown = judgeTradingDay("2026-09-21", null);
  assert.equal(unknown.isTradingDay, null);
  assert.match(unknown.basis, /不猜测/);
  const replay = judgeTradingDay("2026-09-18", "2026-09-21"); // 补跑历史日
  assert.equal(replay.isTradingDay, true);
  assert.match(replay.basis, /补跑/);
});

test("配置项：默认窗口为收盘后 20 分钟、每日最多 3 次；改等待时长会同步改变窗口", () => {
  assert.equal(CFG.closeMinute, 900);
  assert.equal(CFG.delayMinutes, 20);
  assert.equal(CFG.maxAttempts, 3);
  const longer = { ...CFG, delayMinutes: 60 };
  const longerSlot = slotAtForDate("2026-09-21", longer);
  assert.ok(longerSlot);
  assert.equal(longerSlot.toISOString(), "2026-09-21T08:00:00.000Z");
  assert.deepEqual(decideRun([row("failure", 30, 29), row("failure", 20, 19)], longer), { action: "run", attempt: 3 });
});
