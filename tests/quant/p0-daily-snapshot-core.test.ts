// P0 类型B预测数据底座：纯函数单测（deriveRiskLevel / computeNextDayChg）。
// 不依赖 DB / 数据源；可直接 `node --test --experimental-strip-types tests/quant/p0-daily-snapshot-core.test.ts` 运行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRiskLevel, computeNextDayChg, medianOf } from "../../src/lib/quant/screener/daily-snapshot-core.ts";

test("deriveRiskLevel：缺失主轴占比 → 空串（不猜档）", () => {
  assert.equal(deriveRiskLevel(null, 1000, 50, 5), "");
  assert.equal(deriveRiskLevel(NaN, 1000, 50, 5), "");
});

test("deriveRiskLevel：普涨健康环境 → 正常", () => {
  assert.equal(deriveRiskLevel(65, 800, 80, 5), "正常");
});

test("deriveRiskLevel：中等宽度 → 注意", () => {
  assert.equal(deriveRiskLevel(55, 1500, 60, 10), "注意");
});

test("deriveRiskLevel：宽度偏低 → 偏高", () => {
  assert.equal(deriveRiskLevel(30, 2500, 40, 20), "偏高");
});

test("deriveRiskLevel：普跌 / 涨跌比失衡 / 跌停潮 → 高风险", () => {
  assert.equal(deriveRiskLevel(20, 4200, 10, 80), "高风险"); // 普跌
  assert.equal(deriveRiskLevel(40, 2000, 10, 60), "高风险"); // 涨跌比 1:6
  assert.equal(deriveRiskLevel(45, 1500, 20, 55), "高风险"); // 跌停≥50
});

test("computeNextDayChg：上涨日 +2%", () => {
  assert.ok(Math.abs(computeNextDayChg(3000, 3060) - 2) < 1e-9);
});

test("computeNextDayChg：下跌日 -2%", () => {
  assert.ok(Math.abs(computeNextDayChg(3000, 2940) - -2) < 1e-9);
});

test("computeNextDayChg：非法入参 → NaN（调用方决定是否落 null）", () => {
  assert.ok(Number.isNaN(computeNextDayChg(0, 100)));
  assert.ok(Number.isNaN(computeNextDayChg(100, NaN)));
  assert.ok(Number.isNaN(computeNextDayChg(NaN, 100)));
});

test("medianOf：奇数个取中值", () => {
  assert.ok(Math.abs(medianOf([1, 2, 3]) - 2) < 1e-9);
});

test("medianOf：偶数个取中间两数均值", () => {
  assert.ok(Math.abs(medianOf([1, 2, 3, 4]) - 2.5) < 1e-9);
});

test("medianOf：过滤非有限值；空 → NaN", () => {
  assert.ok(Math.abs(medianOf([NaN, 5, 7, Infinity]) - 6) < 1e-9);
  assert.ok(Number.isNaN(medianOf([])));
});
