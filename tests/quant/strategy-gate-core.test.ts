// 「预测」按钮纯核单测（strategy-gate-core）：闸门判定 / 组合打包 / 攒样本进度。
// 不依赖 DB / 数据源；运行：node --test --experimental-strip-types tests/quant/strategy-gate-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateOf, packForecast, marketProbState, type GateStrategy } from "../../src/lib/quant/strategy/strategy-gate-core.ts";

const s = (over: Partial<GateStrategy>): GateStrategy => ({
  id: 1, name: "测试策略", like: 0, dislike: 0, n_mapped: 5, threshold: 60, mode: ">=", ...over,
});

/* ---------------- gateOf ---------------- */

test("gateOf：没设前提的策略永远不挡（pass 且不 unknown）", () => {
  const v = gateOf({ threshold: null }, 65);
  assert.equal(v.pass, true);
  assert.equal(v.unknown, false);
  assert.equal(v.reason, "");
});

test("gateOf：档位分 null → unknown（不猜一个分）", () => {
  const v = gateOf({ threshold: 75, mode: ">=" }, null);
  assert.equal(v.pass, false);
  assert.equal(v.unknown, true);
  assert.match(v.reason, /没算出来/);
});

test("gateOf：NaN 档位分同 unknown", () => {
  const v = gateOf({ threshold: 75 }, NaN);
  assert.equal(v.unknown, true);
});

test("gateOf：>= 门槛，分数够 → 过；不够 → 挡且差值写进 reason", () => {
  const ok = gateOf({ threshold: 60, mode: ">=" }, 65);
  assert.equal(ok.pass, true);
  assert.match(ok.reason, /成立（今天 65 分）/);
  const no = gateOf({ threshold: 80, mode: ">=" }, 65);
  assert.equal(no.pass, false);
  assert.equal(no.unknown, false);
  assert.match(no.reason, /还差 15 分/);
});

test("gateOf：<= 门槛（低分档）按 <= 判", () => {
  assert.equal(gateOf({ threshold: 30, mode: "<=" }, 25).pass, true);
  assert.equal(gateOf({ threshold: 30, mode: "<=" }, 65).pass, false);
});

test("gateOf：分数按四舍五入比对（65.4 → 65）", () => {
  assert.equal(gateOf({ threshold: 65, mode: ">=" }, 65.4).pass, true);
  assert.equal(gateOf({ threshold: 65, mode: ">=" }, 65.49).pass, true);
  assert.equal(gateOf({ threshold: 65, mode: ">=" }, 64.49).pass, false);
});

/* ---------------- marketProbState ---------------- */

test("marketProbState：v1 恒 accumulating，不出概率数字", () => {
  const a = marketProbState(1, 30);
  assert.equal(a.state, "accumulating");
  assert.equal(a.n, 1);
  assert.match(a.note, /1\/30/);
});

test("marketProbState：攒够也只说「样本已攒够」，不拿 base rate 冒充条件概率", () => {
  const a = marketProbState(45, 30);
  assert.equal(a.state, "accumulating");
  assert.match(a.note, /样本已攒够/);
  assert.doesNotMatch(a.note, /概率 \d+%/);
});

test("marketProbState：负数/非有限行数按 0 处理", () => {
  assert.equal(marketProbState(-3, 30).n, 0);
  assert.equal(marketProbState(NaN, 30).n, 0);
});

/* ---------------- packForecast ---------------- */

test("packForecast：档位分拿不到 → 全部 unknown、items 空、tierOk=false", () => {
  const p = packForecast({
    score: null, tier: "",
    strategies: [s({ id: 1, threshold: 60 }), s({ id: 2, threshold: null, name: "无前提" })],
    snapshotRows: 1,
  });
  assert.equal(p.tierOk, false);
  assert.equal(p.counts.unknown, 1);
  assert.equal(p.counts.pass, 0);
  assert.deepEqual(p.items, []);
  assert.equal(p.gates["1"].unknown, true);
  // 没设前提的策略不进 gates（它不参与闸门折叠）
  assert.equal(p.gates["2"], undefined);
});

test("packForecast：counts 三分口径（过闸/被挡/待判）互斥且合计=带前提总数", () => {
  const p = packForecast({
    score: 65, tier: "偏高",
    strategies: [
      s({ id: 1, threshold: 60 }),   // 过
      s({ id: 2, threshold: 80 }),   // 挡
      s({ id: 3, threshold: null }), // 没前提，不算 gated
    ],
    snapshotRows: 1,
  });
  assert.equal(p.counts.total, 3);
  assert.equal(p.counts.gated, 2);
  assert.equal(p.counts.pass, 1);
  assert.equal(p.counts.blocked, 1);
  assert.equal(p.counts.unknown, 0);
});

test("packForecast：推荐列表 组合在前、按赞踩排序、n_mapped=0 的不进推荐", () => {
  const p = packForecast({
    score: 65, tier: "偏高",
    strategies: [
      s({ id: 10, name: "高赞", like: 20, dislike: 2, threshold: 60 }),
      s({ id: 11, name: "次赞", like: 8, dislike: 1, threshold: 60 }),
      s({ id: 12, name: "三赞", like: 5, dislike: 0, threshold: 60 }),
      s({ id: 13, name: "四赞", like: 3, dislike: 0, threshold: 60 }),
      s({ id: 14, name: "本地跑不了", like: 99, dislike: 0, threshold: 60, n_mapped: 0 }),
      s({ id: 15, name: "被挡的", like: 50, dislike: 0, threshold: 90 }),
    ],
    snapshotRows: 1,
  });
  assert.equal(p.counts.pass, 5); // 10/11/12/13/14 过闸（14 的 n_mapped=0 只影响推荐，不影响闸门判定）
  assert.equal(p.items[0].kind, "combo");
  assert.deepEqual(p.items[0].memberIds, [10, 11]);
  assert.equal(p.items[1].kind, "combo");
  assert.deepEqual(p.items[1].memberIds, [12, 13]);
  // 单条只取前 3；14（n_mapped=0）与被挡的 15（赞 50 最高）都绝不进推荐
  const singles = p.items.filter((x) => x.kind === "single");
  assert.ok(singles.length >= 1 && singles.length <= 3);
  assert.ok(!p.items.some((x) => x.memberIds.includes(15)));
  assert.ok(!p.items.some((x) => x.memberIds.includes(14)));
  // record 恒 null（v1 无台账），来源写明稳智策略库/系统打包
  for (const it of p.items) {
    assert.equal(it.record, null);
    assert.match(it.source, /稳智策略库/);
    if (it.kind === "combo") assert.match(it.source, /系统打包/);
  }
});

test("packForecast：组合成员明示（memberIds 与名称一致，key 稳定）", () => {
  const p = packForecast({
    score: 65, tier: "偏高",
    strategies: [s({ id: 7, name: "甲", threshold: 50 }), s({ id: 9, name: "乙", threshold: 50 })],
    snapshotRows: 0,
  });
  assert.equal(p.items[0].key, "combo-7-9");
  assert.equal(p.items[0].name, "甲 + 乙");
  assert.deepEqual(p.items[0].memberIds, [7, 9]);
  assert.match(p.items[0].reason, /今天 65 分/);
});

test("packForecast：marketProb 把 snapshotRows 原样带给进度行", () => {
  const p = packForecast({ score: 65, tier: "偏高", strategies: [], snapshotRows: 1, target: 30 });
  assert.equal(p.marketProb.n, 1);
  assert.equal(p.marketProb.target, 30);
});
