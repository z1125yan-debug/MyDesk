// P63：「数据日 ≠ 今天」的表述口径（纯内核 + 接线断言）。
//
// 挡的 bug（2026-09-29 09:25 实拍）：页面角标写着
//   「数据截至 2026-09-28（2026-09-29 休市）」
// 而 9/29 是**正常交易日**（data/trade-calendar.json 里就在 days 里），当时只是集合竞价中、
// 行情源还没产生当日数据。旧代码 `quoteDate !== asOf → 拼「休市」` 把「当日行情尚未产生」
// 说成了「今天休市」，属于凭空造日历事实。
//
// 纪律：①「休市」二字只能出现在「日历判定 asOfIsTradingDay === false」的分支；
//      ②日历读不到（null）不许断言休市，只能陈述「暂无当日数据」；
//      ③交易日没数据 → 说「当日行情尚未产生/尚未更新」，不甩锅给休市。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { quoteLagOf, type QuoteLagInput } from "../../src/lib/quant/screener/quote-lag-core.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

function input(o: Partial<QuoteLagInput> = {}): QuoteLagInput {
  return {
    quoteDate: "2026-09-28",
    asOf: "2026-09-29",
    asOfIsTradingDay: true,
    phase: "auction",
    sessionLabel: "集合竞价",
    ...o,
  };
}

test("事故复现：交易日 + 集合竞价中 → 文案禁止出现「休市」，须说「当日行情尚未产生」", () => {
  const r = quoteLagOf(input());
  assert.equal(r.lagging, true);
  assert.equal(r.reason, "trading_day_no_data");
  assert.ok(!r.badge.includes("休市"), `交易日不得说休市：${r.badge}`);
  assert.ok(!r.note.includes("休市"), `note 同样不得说休市：${r.note}`);
  assert.match(r.badge, /2026-09-29 集合竞价，当日行情尚未产生/);
  assert.match(r.badge, /数据截至 2026-09-28/);
});

test("真休市（日历判定 false）：才允许写「休市」，并说清上一交易日收盘即最新", () => {
  const r = quoteLagOf(input({ quoteDate: "2026-09-30", asOf: "2026-10-01", phase: "closed", sessionLabel: "已收盘", asOfIsTradingDay: false }));
  assert.equal(r.reason, "not_trading_day");
  assert.match(r.badge, /（2026-10-01 休市）/);
  assert.match(r.note, /非交易日（休市）/);
});

test("日历读不到（null）：不许断言休市，只陈述「暂无当日数据」", () => {
  const r = quoteLagOf(input({ asOfIsTradingDay: null }));
  assert.equal(r.reason, "calendar_unknown");
  assert.ok(!r.badge.includes("休市"), `角标不得提休市：${r.badge}`);
  // note 里可以出现「不对该日是否休市下结论」这种否定用法，但不得给出「非交易日（休市）」式断言
  assert.ok(!/非交易日（休市）/.test(r.note), `不得下休市断言：${r.note}`);
  assert.match(r.badge, /暂无当日数据/);
  assert.match(r.note, /交易日历不可用/);
});

test("交易日盘中未更新：说「尚未更新」，不与「尚未产生」混用", () => {
  const r = quoteLagOf(input({ phase: "trading", sessionLabel: "交易中" }));
  assert.match(r.badge, /交易中，当日行情尚未更新/);
  assert.ok(!r.badge.includes("尚未产生"), "盘中是「还没更新」而不是「还没产生」");
});

test("数据日 == 求值口径日（或日期缺失）：不显示角标、不编说明", () => {
  const same = quoteLagOf(input({ quoteDate: "2026-09-29" }));
  assert.deepEqual(same, { lagging: false, badge: "", note: "", reason: "none" });
  assert.equal(quoteLagOf(input({ quoteDate: "" })).lagging, false);
  assert.equal(quoteLagOf(input({ asOf: "" })).lagging, false);
});

test("接线断言：判定在服务端（日历+时段），前端只显示、不再自己拼「休市」", () => {
  const run = read("src/lib/quant/screener/run.ts");
  assert.match(run, /isTradingDay\(asOf\)/, "服务端必须查交易日历");
  assert.match(run, /marketSession\(\)/, "服务端必须看当前时段");
  assert.match(run, /quoteLagOf\(/, "滞后说明走纯内核");
  assert.match(run, /quote_lag: quoteLag/, "响应必须带上 quote_lag 供页面显示");

  const ui = read("src/components/desk/pages/ScreenerWorkbench.tsx");
  assert.ok(!/\{asOf\}\s*休市/.test(ui), "前端不得再硬编码「{asOf} 休市」");
  assert.match(ui, /quoteLag\?\.lagging/, "角标显示与否由服务端判定驱动");
  assert.match(ui, /quoteLag\.badge/, "角标文案取自服务端");
  assert.match(ui, /j\.quote_lag/, "解析响应里的 quote_lag");
});
