// A 任务：可成交性判定纯核单测。
// 不依赖 DB / 网关；可直接 `node --test --experimental-strip-types tests/quant/p36-a-tradeable-core.test.ts` 运行。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verdictOfCond, verdictOfStrategy, shouldDrop, type CondLike,
} from "../../src/lib/quant/strategy/tradeable-core.ts";

const v = (op: string, value: unknown) => verdictOfCond({ field: "is_limit_up", op, value })?.verdict;

test("要求涨停（=1 / >=1 / >0 / !=0）→ untradeable：买不进", () => {
  assert.equal(v("=", 1), "untradeable");
  assert.equal(v("==", 1), "untradeable");
  assert.equal(v(">=", 1), "untradeable");
  assert.equal(v(">", 0), "untradeable"); // >0 等价于 =1
  assert.equal(v("!=", 0), "untradeable"); // !=0 等价于 =1
});

test("排除涨停（=0 / !=1 / <1 / <=0）→ ok：可以正常买入", () => {
  assert.equal(v("=", 0), "ok");
  assert.equal(v("!=", 1), "ok");
  assert.equal(v("<", 1), "ok");
  assert.equal(v("<=", 0), "ok");
});

test("恒假写法（>1 / >=2 / =2 / <0）→ dead：永远选不出票", () => {
  assert.equal(v(">", 1), "dead");
  assert.equal(v(">=", 2), "dead");
  assert.equal(v("=", 2), "dead");
  assert.equal(v("<", 0), "dead");
});

test("恒真废条件（>=0 / <=1 / <2 / <3）→ vacuous：等于没写", () => {
  assert.equal(v(">=", 0), "vacuous");
  assert.equal(v("<=", 1), "vacuous");
  assert.equal(v("<", 2), "vacuous");
  assert.equal(v("<", 3), "vacuous");
});

test("非封板字段不判定；认不出的运算符不猜", () => {
  assert.equal(verdictOfCond({ field: "macd_cross", op: "=", value: 1 }), null);
  assert.equal(verdictOfCond({ field: "above_ma_5", op: "=", value: 1 }), null);
  assert.equal(verdictOfCond({ field: "is_limit_up", op: "~=", value: 1 }), null);
  assert.equal(verdictOfCond({ field: "is_limit_up", op: "=", value: "x" }), null);
});

test("整条策略取最严重档位（untradeable > dead > vacuous > ok）", () => {
  const r1 = verdictOfStrategy([
    { field: "macd_cross", op: "=", value: 1 },
    { field: "is_limit_up", op: "=", value: 1 },
  ]);
  assert.equal(r1.verdict, "untradeable");
  assert.equal(r1.details.length, 1); // 只收封板类条件

  const r2 = verdictOfStrategy([
    { field: "is_limit_up", op: "<=", value: 1 }, // vacuous
    { field: "is_limit_up", op: ">", value: 1 },  // dead
  ]);
  assert.equal(r2.verdict, "dead");

  const r3 = verdictOfStrategy([{ field: "is_limit_up", op: "!=", value: 1 }]);
  assert.equal(r3.verdict, "ok");
});

test("真实案例 #959「放大量」→ untradeable（14 条条件里 is_limit_up=1 出现 7 次）", () => {
  const conds959: CondLike[] = [
    { op: "=", field: "is_limit_up", value: 1 },
    { op: "=", field: "macd_cross", value: 1 },
    { op: "=", field: "is_limit_up", value: 1 },
    { op: "=", field: "chan_bottom_fractal", value: 1 },
    { op: ">=", field: "floatcap_yi", value: 100 },
    { op: "=", field: "above_ma_5", value: 1 },
  ];
  const r = verdictOfStrategy(conds959);
  assert.equal(r.verdict, "untradeable");
  assert.equal(r.details.length, 2);
  assert.match(r.summary, /买不进去/);
});

test("空条件 / null → ok，不抛", () => {
  assert.equal(verdictOfStrategy([]).verdict, "ok");
  assert.equal(verdictOfStrategy(null).verdict, "ok");
  assert.equal(verdictOfStrategy(undefined).verdict, "ok");
});

test("shouldDrop：只有 untradeable 与 dead 该删，vacuous/ok 保留", () => {
  assert.equal(shouldDrop(verdictOfStrategy([{ field: "is_limit_up", op: "=", value: 1 }])), true);
  assert.equal(shouldDrop(verdictOfStrategy([{ field: "is_limit_up", op: ">", value: 1 }])), true);
  assert.equal(shouldDrop(verdictOfStrategy([{ field: "is_limit_up", op: "<=", value: 1 }])), false);
  assert.equal(shouldDrop(verdictOfStrategy([{ field: "is_limit_up", op: "!=", value: 1 }])), false);
});

test("钉：判定理由必须是人话，不许出现黑话（MA20/IC/截面/样本外/反向因子）", () => {
  const cases: [string, unknown][] = [["=", 1], [">=", 1], [">", 1], ["<=", 1], ["!=", 1], ["=", 0]];
  for (const [op, value] of cases) {
    const d = verdictOfCond({ field: "is_limit_up", op, value });
    assert.ok(d, `${op}${value} 应能判定`);
    assert.doesNotMatch(d!.reason, /MA20|IC|rankIC|截面|样本外|反向因子|不可成交|monotonic/i);
  }
});
