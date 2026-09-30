// P36 小白体验：策略名反推核心（strategy-name-core.ts）的回归钉测。
//
// 这是「小白看得懂推荐」这条体验线的命门——社区策略库里大量名字就是「1 / 2 / 我的 / test」，
// 直接摆出来等于没名字。humanName 要从条件反推成一句话（如「近7日涨幅≤10% · 站上20日线」）。
// 这里把几条关键分支钉死，防止有人把反推改坏、又退回「1/2/3」。
import { test } from "node:test";
import assert from "node:assert/strict";
// 走相对路径 + 显式 .ts 后缀：仓库没有 tsx/vitest，测试靠 Node 22 自带的类型擦除直接跑，
// 运行时解析不了 @/ 别名，只能相对引；strategy-name-core 是零依赖纯核，import 它不会拉进 React/Next。
import { humanName, isJunkName, condToZh, type NameCond } from "../../src/lib/quant/strategy/strategy-name-core.ts";

test("isJunkName：纯数字 / 我的 / test 都算垃圾名", () => {
  for (const n of ["1", "123", "我的", "test", "TEST", "无", "x", ""]) {
    assert.equal(isJunkName(n), true, `「${n}」应判为垃圾名`);
  }
  for (const n of ["趋势向上低吸", "站上20日线再缩量", "强"]) {
    assert.equal(isJunkName(n), false, `「${n}」是有效名，不应判垃圾`);
  }
});

test("humanName：有效名原样返回", () => {
  assert.equal(humanName("趋势向上低吸", undefined, 7), "趋势向上低吸");
  assert.equal(humanName("趋势向上低吸", [{ field: "above_ma_20", op: "=" } as NameCond], 7), "趋势向上低吸");
});

test("humanName：垃圾名用前 3 条条件拼一句话", () => {
  const conds: NameCond[] = [
    { field: "change_pct", type: "rolling_return", op: "<=", value: 10, window: 7 },
    { field: "above_ma_20", op: "=", value: 1 },
    { field: "turnover_rate", op: ">=", value: 3 },
    { field: "volume_ratio", op: ">=", value: 1.5 },
  ];
  const got = humanName("1", conds, 42);
  // 期望前三条拼成「近7日涨幅≤10 · 站上20日线 · 换手率≥3」，第 4 条被截断（实现不额外补“%”）
  assert.equal(got, "近7日涨幅≤10 · 站上20日线 · 换手率≥3", `反推文案不符：得到「${got}」`);
});

test("humanName：垃圾名且无条件 → 退化为「策略 #id」", () => {
  assert.equal(humanName("2", [], 88), "策略 #88");
});

test("humanName：垃圾名 + 无 id + 无条件 → 不抛错，回退原名", () => {
  assert.equal(humanName("我的", [], undefined), "我的");
});

test("condToZh：布尔型 =1 只说状态不写 =1", () => {
  assert.equal(condToZh({ field: "above_ma_20", op: "=", value: 1 }), "站上20日线");
});

test("condToZh：rolling_return 字段说「涨幅」而非「收盘价」", () => {
  assert.equal(condToZh({ field: "close", type: "rolling_return", op: "<=", value: 10, window: 7 }), "近7日涨幅≤10");
});

test("condToZh：命中不到的字段回退原始字段名（仍比「1」强）", () => {
  assert.equal(condToZh({ field: "weird_field", op: ">=", value: 5 }), "weird_field≥5");
});
