// 产业周期健康度（industryHealth）单测 — 2026-09-29 Phase2 路线①解锁
// 钉三件事：价格斜率方向决定健康/不健康；月度点不足 → null（缺读数≠0）；
// asOf 截断只看历史月份（回放纪律）。
import test from "node:test";
import assert from "node:assert/strict";
import { computeIndustryHealth } from "../../src/lib/quant/screener/top-risk-engine.ts";

const monthly = (prices: number[], startYear = 2026, startMonth = 3): { date: string; price_trend: number }[] =>
  prices.map((p, i) => {
    const m = startMonth + i;
    const y = startYear + Math.floor((m - 1) / 12);
    return { date: `${y}-${String(((m - 1) % 12) + 1).padStart(2, "0")}`, price_trend: p };
  });

const LINKS = [{ nodeId: "mt_cu", role: "上游" }];

test("价格上涨 6 月斜率向上 → 健康分 > 50", () => {
  const snaps = { mt_cu: monthly([100, 102, 104, 106, 108, 110, 112, 115]) };
  const v = computeIndustryHealth(LINKS, snaps);
  assert.ok(v !== null && v > 50, `got ${v}`);
});

test("价格下跌 6 月斜率向下 → 健康分 < 50", () => {
  const snaps = { mt_cu: monthly([115, 112, 110, 108, 106, 104, 102, 100]) };
  const v = computeIndustryHealth(LINKS, snaps);
  assert.ok(v !== null && v < 50, `got ${v}`);
});

test("±20% 满刻度：斜率恰好 +20% → 满分档 100", () => {
  const snaps = { mt_cu: monthly([100, 100, 100, 100, 100, 100, 100, 120]) };
  const v = computeIndustryHealth(LINKS, snaps);
  assert.equal(v, 100);
});

test("月度点不足 7 → null（缺读数≠0）", () => {
  const snaps = { mt_cu: monthly([100, 101, 102, 103]) };
  assert.equal(computeIndustryHealth(LINKS, snaps), null);
});

test("无映射节点 → null", () => {
  assert.equal(computeIndustryHealth([], { mt_cu: monthly([100, 101, 102, 103, 104, 105, 106, 107]) }), null);
});

test("asOf 截断：只看历史月份，未来数据不进分数", () => {
  const snaps = { mt_cu: monthly([100, 100, 100, 100, 100, 100, 100, 140]) };
  // 截到倒数第二根（都是 100）→ 斜率 0 → 50 分；不截 → 满分
  const cut = snaps.mt_cu[snaps.mt_cu.length - 2].date; // "2026-09"
  const asOf = `${cut}-15`;
  assert.equal(computeIndustryHealth(LINKS, snaps, asOf), 50);
  assert.equal(computeIndustryHealth(LINKS, snaps), 100);
});

test("多节点取均值；无数据节点自然跳过", () => {
  const snaps = {
    mt_cu: monthly([100, 100, 100, 100, 100, 100, 100, 120]), // +20% → +1
    mt_al: monthly([100, 100, 100, 100, 100, 100, 100, 90]), // -10% → -0.5
  };
  const v = computeIndustryHealth([{ nodeId: "mt_cu" }, { nodeId: "mt_al" }, { nodeId: "mt_gold" }], snaps);
  assert.equal(v, 62.5); // (1 + -0.5)/2 = 0.25 → 50 + 12.5
});
