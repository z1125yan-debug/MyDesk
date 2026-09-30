// P36-B 事件回测口径核：扣费 / 可成交 / 三段切分
// 钉的是什么：页面上的收益数字必须是「T+1 开盘买进、扣完费、样本外」的，
// 任何一条退化（退回 T 日收盘买、忘记扣费、拿全期冒充样本外）都要在这里红。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_COST,
  buyDragOf,
  sellDragOf,
  roundTripDragOf,
  netOf,
  eventOutcomeOf,
  eventStatOf,
  eventStatOfSplit,
  splitOfIndex,
  type EventQuote,
  type EventSample,
} from "../../src/lib/quant/backtest/event-core.ts";
import { DEFAULT_COST } from "../../src/lib/quant/backtest/engine.ts";

const q = (over: Partial<EventQuote> = {}): EventQuote => ({
  entryOpen: 10,
  signalClose: 10,
  limitRatio: 0.1,
  exitOpen1: 10.2,
  exitOpen5: 11,
  ...over,
});

test("成本模型与组合回测引擎同源（不许出现第二套费率）", () => {
  assert.equal(EVENT_COST.commissionRate, DEFAULT_COST.commissionRate);
  assert.equal(EVENT_COST.stampDuty, DEFAULT_COST.stampDuty);
  assert.equal(EVENT_COST.slippageRate, DEFAULT_COST.slippageRate);
  assert.equal(EVENT_COST.spreadRate, DEFAULT_COST.spreadRate);
});

test("往返成本 0.41%（佣金+印花税+滑点+点差，可给页面解释用）", () => {
  const rt = roundTripDragOf();
  assert.ok(rt > 0.004 && rt < 0.005, `往返成本应落在 0.4%~0.5%，实际 ${(rt * 100).toFixed(3)}%`);
  // 卖出比买入多一道印花税
  assert.ok(sellDragOf() > buyDragOf());
  assert.ok(Math.abs((sellDragOf() - buyDragOf()) - DEFAULT_COST.stampDuty) < 1e-12);
});

test("净收益 = 毛收益乘性扣费，不会随涨跌幅漂移", () => {
  const g = 2; // +2%
  const net = netOf(g) as number;
  assert.ok(net < g, "扣费后必须小于毛收益");
  // 乘性：net = (1+g)(1-b)(1-s)-1
  const expect = ((1 + g / 100) * (1 - buyDragOf()) * (1 - sellDragOf()) - 1) * 100;
  assert.ok(Math.abs(net - expect) < 1e-12);
  assert.ok(Math.abs(net - (g - roundTripDragOf() * 100)) < 0.02, "小涨跌幅下应≈毛收益减往返成本");
});

test("毛收益为 0 时净收益是负的（来回一趟就要交钱）", () => {
  const net = netOf(0) as number;
  assert.ok(net < 0, `0 涨幅不该是 0 收益，实际 ${net}`);
});

test("次日一字涨停 → 这笔买不进，不计入样本（不是收益 0）", () => {
  const o = eventOutcomeOf(q({ entryOpen: 11, signalClose: 10, limitRatio: 0.1 }));
  assert.equal(o.tradable, false);
  assert.match(o.blockedReason ?? "", /一字涨停/);
  assert.equal(o.net1, null, "买不进不许记 0 收益");
});

test("次日停牌无价 → 不可成交", () => {
  const o = eventOutcomeOf(q({ entryOpen: null }));
  assert.equal(o.tradable, false);
  assert.match(o.blockedReason ?? "", /停牌/);
});

test("正常成交：1 日/5 日净收益都算出且都小于毛收益", () => {
  const o = eventOutcomeOf(q());
  assert.equal(o.tradable, true);
  assert.equal(o.blockedReason, null);
  assert.ok((o.gross1 as number) > 0 && (o.net1 as number) < (o.gross1 as number));
  assert.ok((o.net5 as number) > (o.net1 as number), "5 日涨幅更大应体现在净收益上");
});

test("5 日后视窗不足 → net5 为 null（不许拿 1 日值顶替）", () => {
  const o = eventOutcomeOf(q({ exitOpen5: null }));
  assert.equal(o.net5, null);
  assert.ok(o.net1 != null);
});

test("统计：买不进的样本被踢出，胜率与净收益只按真实成交算", () => {
  const samples: EventSample[] = [
    { t: 0, outcome: eventOutcomeOf(q({ exitOpen1: 10.5 })) }, // +5% 毛 → 赢
    { t: 1, outcome: eventOutcomeOf(q({ exitOpen1: 9.5 })) }, // 输
    { t: 2, outcome: eventOutcomeOf(q({ entryOpen: 11, signalClose: 10 })) }, // 一字买不进，应被剔除
  ];
  const st = eventStatOf(samples, { totalDates: 100 });
  assert.ok(st);
  assert.equal(st!.n, 2, "买不进的不计入 n");
  assert.equal(st!.win, 50);
  assert.ok(st!.net1 != null);
});

test("三段切分：下标按比例归类，样本外段可单独统计", () => {
  assert.equal(splitOfIndex(0, 100), "train");
  assert.equal(splitOfIndex(59, 100), "train");
  assert.equal(splitOfIndex(60, 100), "validation");
  assert.equal(splitOfIndex(79, 100), "validation");
  assert.equal(splitOfIndex(80, 100), "test");
  assert.equal(splitOfIndex(99, 100), "test");
});

test("样本外单独统计：样本不足返回 null，不许拿全期数字冒充", () => {
  const samples: EventSample[] = [
    { t: 5, outcome: eventOutcomeOf(q({ exitOpen1: 10.5 })) }, // train
    { t: 95, outcome: eventOutcomeOf(q({ exitOpen1: 10.5 })) }, // test
  ];
  const oos = eventStatOfSplit(samples, "test", { totalDates: 100 });
  assert.ok(oos);
  assert.equal(oos!.n, 1);
  assert.equal(oos!.split.test, 1);
  assert.equal(oos!.split.train, 0, "切段统计里不该混进 train 样本");
  const empty = eventStatOfSplit(samples, "validation", { totalDates: 100 });
  assert.equal(empty, null);
});

test("全空样本返回 null（n=0 不许报 0% 胜率）", () => {
  assert.equal(eventStatOf([], { totalDates: 100 }), null);
  assert.equal(eventStatOf([{ t: 0, outcome: eventOutcomeOf(q({ entryOpen: null })) }], { totalDates: 100 }), null);
});

test("胜率带 Wilson 区间（点估计不许单独出门）", () => {
  const samples: EventSample[] = Array.from({ length: 60 }, (_, i) => ({
    t: i,
    outcome: eventOutcomeOf(q({ exitOpen1: i % 3 === 0 ? 9.5 : 10.5 })),
  }));
  const st = eventStatOf(samples, { totalDates: 100 });
  assert.ok(st);
  assert.match(st!.winCi, /95%CI/);
  assert.match(st!.winCi, /N=60/);
});
