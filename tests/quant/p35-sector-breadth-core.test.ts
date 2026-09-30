// 钉住板块均线广度纯核：口径纪律（「算不出」≠「没站上」、分母=有判定家数）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { maOf, aboveMa, verdictOf, summarizeBreadth } from "../../src/lib/desk/sector-breadth-core.ts";

test("maOf：样本不足 / 含非有限值 → null，不硬算", () => {
  assert.equal(maOf([1, 2, 3], 5), null, "不足 5 根不许返回均线");
  assert.equal(maOf([1, 2, NaN, 4, 5], 5), null, "窗口里有 NaN 算不出就 null");
  assert.equal(maOf([1, 2, 3, 4, 6], 5), 16 / 5);
  assert.equal(maOf([], 1), null);
});

test("aboveMa：最新收盘 ≥ MA-N（含等于）算站上；不足 N 根 → null", () => {
  // 5 根 [10,10,10,10,11]：MA5=10.2，最新 11 站上
  assert.equal(aboveMa([10, 10, 10, 10, 11], 5), true);
  // [10,10,10,10,9]：MA5=9.8，最新 9 没站上
  assert.equal(aboveMa([10, 10, 10, 10, 9], 5), false);
  // 恰好等于：≥ 含等于，算站上
  assert.equal(aboveMa([10, 10, 10, 10, 10], 5), true);
  assert.equal(aboveMa([10, 10, 10], 5), null, "3 根K线问 MA5 → null（算不出≠没站上）");
});

test("verdictOf：三个周期各判各的，互不冒充", () => {
  const v = verdictOf({ symbol: "600000.SH", closes: [10, 10, 10, 10, 11] });
  assert.equal(v.aboveMa5, true);
  assert.equal(v.aboveMa10, null, "只有 5 根，MA10 算不出，必须 null");
  assert.equal(v.aboveMa20, null);
});

test("summarizeBreadth：分母=有判定家数，剔除家数如实报", () => {
  const rows = [
    { symbol: "A", closes: [10, 10, 10, 10, 11] },        // MA5 上
    { symbol: "B", closes: [10, 10, 10, 10, 9] },         // MA5 下
    { symbol: "C", closes: [10, 10, 10, 10, 10] },        // MA5 恰好线上
    { symbol: "D", closes: [1, 2] },                       // 不足 5 根：剔除
  ];
  const s = summarizeBreadth(rows);
  assert.equal(s.n, 4);
  assert.equal(s.skipped, 1, "D 无任何判定，必须进 skipped");
  assert.equal(s.aboveMa5Pct, 66.7, "2/3 站上 → 66.7%（分母 3，不是 4）");
  assert.equal(s.denomMa5, 3, "分母是有判定的 3 只，不是成分股总数 4");
  assert.equal(s.aboveMa20Pct, null, "没有任何一只够 20 根 → null，不许是 0%");
});

test("summarizeBreadth：空输入全 null，不许出现 NaN/0% 冒充", () => {
  const s = summarizeBreadth([]);
  assert.equal(s.n, 0);
  assert.equal(s.aboveMa5Pct, null);
  assert.equal(s.aboveMa10Pct, null);
  assert.equal(s.aboveMa20Pct, null);
});
