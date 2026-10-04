// P67 体检红线 #1 的行为钉测：日/周/月K 磁盘缓存的有效性规则（kline-disk-core.ts）。
// 旧规则「按自然日整天有效」在交易日会把当天末根K线冻结在首抓值——休市日看不出来，开盘日全天说谎。
import { test } from "node:test";
import assert from "node:assert/strict";
import { klineDiskUsable } from "../../src/lib/desk/kline-disk-core.ts";

const DAY = "2026-10-09"; // 周五（交易日）
const CLOSE = Date.parse(`${DAY}T15:05:00+08:00`);
const ctxTrading = { today: DAY, nowMs: CLOSE + 3600_000, tradingDay: true, closeMs: CLOSE };
const ctxHoliday = { today: DAY, nowMs: CLOSE + 3600_000, tradingDay: false, closeMs: CLOSE };

test("节假日：当天写的档整天可信（上游无新数据，防限流的原意保留）", () => {
  assert.equal(klineDiskUsable({ day: DAY }, ctxHoliday), true, "连 at 都没有也可信——节假日上游本来就不动");
  assert.equal(klineDiskUsable({ day: DAY, at: Date.parse(`${DAY}T08:00:00+08:00`) }, ctxHoliday), true, "盘前写的也可信");
});

test("交易日：只有收盘后写入的档当天才可信", () => {
  assert.equal(
    klineDiskUsable({ day: DAY, at: CLOSE + 1000 }, ctxTrading), true, "15:05 后写的可信",
  );
  assert.equal(
    klineDiskUsable({ day: DAY, at: Date.parse(`${DAY}T09:31:00+08:00`) }, ctxTrading), false,
    "盘中写的末根随时会变，不可信",
  );
  assert.equal(
    klineDiskUsable({ day: DAY, at: Date.parse(`${DAY}T08:00:00+08:00`) }, ctxTrading), false,
    "盘前写的末根还是昨收，收盘后也不得冒充今日收盘",
  );
  assert.equal(
    klineDiskUsable({ day: DAY }, ctxTrading), false, "交易日缺 at 无法判定写入时机 → 不可信（宁重抓）",
  );
});

test("跨自然日一律失效（两种日都不豁免）", () => {
  assert.equal(klineDiskUsable({ day: "2026-10-08", at: CLOSE + 1000 }, ctxTrading), false);
  assert.equal(klineDiskUsable({ day: "2026-10-08", at: CLOSE + 1000 }, ctxHoliday), false);
});
