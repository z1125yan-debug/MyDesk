// P62（2026-09-29）：交易日历必须带「正确星期」，且模型照抄即可、不许自己算。
// 事故：旧 tradeCalendarNote 不带星期，模型把 9/29 写成「周五」（实际周二）、9/30「周六」（实际周三）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeCalendarNote, weekdayOf } from "../../src/lib/desk/trade-calendar.ts";

test("weekdayOf 确定性正确（UTC+8 无夏令时）", () => {
  assert.equal(weekdayOf("2026-09-28"), "周一");
  assert.equal(weekdayOf("2026-09-29"), "周二");
  assert.equal(weekdayOf("2026-09-30"), "周三");
  assert.equal(weekdayOf("2026-10-01"), "周四"); // 国庆
  assert.equal(weekdayOf("2026-10-08"), "周四"); // 复市
  assert.equal(weekdayOf("2026-10-09"), "周五");
  assert.equal(weekdayOf("2026-10-10"), "周六"); // 周末
  assert.equal(weekdayOf("2026-10-11"), "周日");
  assert.equal(weekdayOf("2026-10-12"), "周一");
});

test("tradeCalendarNote(9/29) 星期与休市段全部正确，且不含错误星期", () => {
  const note = tradeCalendarNote("2026-09-29");
  assert.ok(note, "日历读得到时不应返回 null");
  // 交易日 + 正确星期
  assert.ok(note!.includes("9/29（周二）"), "9/29 应为周二");
  assert.ok(note!.includes("9/30（周三）"), "9/30 应为周三");
  assert.ok(note!.includes("10/8（周四）"), "10/8 应为周四");
  assert.ok(note!.includes("10/9（周五）"), "10/9 应为周五");
  assert.ok(note!.includes("10/12（周一）"), "10/12 应为周一");
  // 休市段标注
  assert.ok(note!.includes("10/1—10/7 国庆休市"), "国庆长假需标「国庆休市」");
  assert.ok(note!.includes("10/10—10/11 周末休市"), "周六日连休需标「周末休市」");
  // 反例：绝不许出现被模型编造过的错星期
  assert.ok(!note!.includes("9/29（周五）"), "9/29 绝不可能是周五");
  assert.ok(!note!.includes("9/30（周六）"), "9/30 绝不可能是周六");
  assert.ok(!note!.includes("10/8（周一）"), "10/8 绝不可能是周一");
});

test("注入用 note（from=今天 9/29）不含已收盘的 as-of 当天 9/28", () => {
  // route.ts 调 tradeCalendarNote(today)，today=9/29；as-of(9/28) 已收盘，
  // 「接下来」从次日 9/29 起算，绝不该把 9/28 再列进「接下来」。
  const note = tradeCalendarNote("2026-09-29");
  assert.ok(note, "日历读得到时不应返回 null");
  assert.ok(!note!.includes("9/28"), "「接下来」不应包含已收盘的 9/28");
});
