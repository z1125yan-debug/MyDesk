// P36-B 命中矩阵：必须和 condMetAt 逐点一致
// 钉的是什么：回测为了跑得动把条件判定向量化了，但「判定语义只能有一份」——
// 位图一旦和 condMetAt 分叉，回测数字就会和页面选股/概率引擎对不上，且极难发现。

import { test } from "node:test";
import assert from "node:assert/strict";
import { hitMatrixOf, andMatrices, condKeyOf, type MatCond } from "../../src/lib/quant/strategy/cond-matrix-core.ts";
import { condMetAt } from "../../src/lib/quant/factors/probability.ts";

function seriesOfFactory(series: (number | null)[]) {
  return (key: string) => (key === "f" ? series : undefined);
}

function compareAll(cond: MatCond, series: (number | null)[]): void {
  const mat = hitMatrixOf(cond, series);
  const seriesOf = seriesOfFactory(series);
  for (let t = 0; t < series.length; t++) {
    const expect = condMetAt(cond as never, seriesOf as never, t);
    assert.equal(mat[t] === 1, expect, `t=${t} 位图=${mat[t]} condMetAt=${expect} cond=${JSON.stringify(cond)}`);
  }
}

// 含 null 的混合序列（缺失/停牌是常态，不能只测干净数据）
const S: (number | null)[] = [1, null, 3, 5, 8, 13, null, 21, 34, 2, 0, -1, 7, 7, 9, null, 4, 6, 11, 18];

test("single：与 condMetAt 逐点一致（= >= > <= < !=）", () => {
  for (const op of ["=", ">=", ">", "<=", "<", "!="]) {
    for (const value of [0, 1, 7, 13, 100]) {
      compareAll({ field: "f", op, value, type: "single" }, S);
    }
  }
});

test("single：序列缺失（null）一律判不成立，不许当 0 参与比较", () => {
  const mat = hitMatrixOf({ field: "f", op: "<=", value: 100, type: "single" }, [null, 5, null, 7]);
  assert.deepEqual([...mat], [0, 1, 0, 1]);
});

test("rolling_return：与 condMetAt 逐点一致", () => {
  for (const w of [1, 3, 5]) {
    for (const op of [">=", "<="]) {
      compareAll({ field: "f", op, value: 0, type: "rolling_return", window: w }, S);
    }
  }
});

test("rolling_sum：与 condMetAt 逐点一致", () => {
  for (const w of [2, 4]) {
    for (const op of [">=", "<="]) {
      compareAll({ field: "f", op, value: 20, type: "rolling_sum", window: w }, S);
    }
  }
});

test("rolling_any：与 condMetAt 逐点一致（含 min_match_days）", () => {
  for (const w of [2, 3, 5]) {
    for (const mm of [1, 2]) {
      compareAll({ field: "f", op: ">=", value: 5, type: "rolling_any", window: w, min_match_days: mm }, S);
    }
  }
});

test("未知字段 / 空序列：全 0，不崩", () => {
  assert.deepEqual([...hitMatrixOf({ field: "nope", op: ">=", value: 1 }, undefined)], []);
  assert.deepEqual([...hitMatrixOf({ field: "f", op: ">=", value: 1 }, [])], []);
});

test("in / not in 多值也走 cmpWithOp（与概率引擎同语义）", () => {
  const mat = hitMatrixOf({ field: "f", op: "in", value: [7, 13], type: "single" }, [7, 8, 13, 5]);
  assert.deepEqual([...mat], [1, 0, 1, 0]);
  const neg = hitMatrixOf({ field: "f", op: "not in", value: "7,13", type: "single" }, [7, 8, 13, 5]);
  assert.deepEqual([...neg], [0, 1, 0, 1]);
});

test("condKeyOf：相同条件同键，不同条件不同键（位图缓存靠它去重）", () => {
  const a = { field: "f", op: ">=", value: 5, type: "single" as const };
  const b = { field: "f", op: ">=", value: 5, type: "single" as const };
  const c = { field: "f", op: ">=", value: 6, type: "single" as const };
  assert.equal(condKeyOf(a), condKeyOf(b));
  assert.notEqual(condKeyOf(a), condKeyOf(c));
  assert.notEqual(condKeyOf(a), condKeyOf({ ...a, window: 5 }));
});

test("andMatrices：多条件按位与", () => {
  const a = new Uint8Array([1, 1, 0, 1]);
  const b = new Uint8Array([1, 0, 1, 1]);
  assert.deepEqual([...andMatrices([a, b], 4)], [1, 0, 0, 1]);
  assert.deepEqual([...andMatrices([], 4)], [0, 0, 0, 0]);
});
