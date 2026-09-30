// 钉住 Wilson CI：小样本不能把点估计当真值卖（类型 B 放行口径的前置纪律）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { wilsonCI, pctWithCI } from "../../src/lib/quant/factors/wilson-core.ts";

test("wilsonCI：正常样本给出 [0,1] 区间，且包含点估计", () => {
  // 323 次里 69% → 223 次命中
  const ci = wilsonCI(223, 323);
  assert.ok(ci.lo != null && ci.hi != null);
  assert.ok(ci.lo >= 0 && ci.hi <= 1);
  assert.ok(ci.lo < 0.69 && ci.hi > 0.69, "区间应包住点估计");
  assert.ok(ci.hi - ci.lo < 0.12, "N=323 的区间不该宽得没意义");
});

test("wilsonCI：样本越小区间越宽（这是它的全部意义）", () => {
  const small = wilsonCI(7, 10);
  assert.ok(small.lo != null && small.hi != null);
  const big = wilsonCI(700, 1000);
  assert.ok(big.lo != null && big.hi != null);
  assert.ok(small.hi - small.lo > big.hi - big.lo, "N=10 的区间必须明显宽于 N=1000");
});

test("wilsonCI：非法入参 → null，不许返回 0 冒充", () => {
  assert.deepEqual(wilsonCI(5, 0), { lo: null, hi: null }, "N=0 算不出");
  assert.deepEqual(wilsonCI(5, 3), { lo: null, hi: null }, "wins>n 越界");
  assert.deepEqual(wilsonCI(-1, 10), { lo: null, hi: null });
  assert.deepEqual(wilsonCI(NaN, 10), { lo: null, hi: null });
});

test("wilsonCI：极端比例（0 / 全部命中）仍给区间，不塌成一点", () => {
  const zero = wilsonCI(0, 20);
  assert.ok(zero.lo != null && zero.hi != null);
  assert.ok(zero.lo === 0 && zero.hi > 0, "0/20 的上界必须 >0（不能说「真实胜率必然是 0」）");
  const all = wilsonCI(20, 20);
  assert.ok(all.lo != null && all.hi != null);
  assert.ok(all.hi === 1 && all.lo < 1, "20/20 的下界必须 <1（不能说「必然 100%」）");
});

test("pctWithCI：输出带 N 与区间；算不出时如实说算不出", () => {
  const s = pctWithCI(69, 323);
  assert.match(s, /^69% \[95%CI \d+–\d+\]（N=323）$/);
  assert.match(pctWithCI(null, 10), /CI算不出/);
  assert.match(pctWithCI(69, null), /N未知/);
  assert.match(pctWithCI(69, 0), /CI算不出/);
});
