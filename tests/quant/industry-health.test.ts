// 产业周期健康度（industryHealth）单测 — 2026-09-29 Phase2 路线①解锁
// 钉三件事：价格斜率方向决定健康/不健康；月度点不足 → null（缺读数≠0）；
// asOf 截断只看历史月份（回放纪律）。
import test from "node:test";
import assert from "node:assert/strict";
import { computeIndustryHealth, readFundamentals } from "../../src/lib/quant/screener/top-risk-engine.ts";

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

test("财务分量：利润/订单同比为正推高健康分，存货为反向刻度", () => {
  const v = computeIndustryHealth(
    [],
    {},
    undefined,
    { earnings_yoy: 30, earnings_period: "2026-06-30", orders_yoy: 30, orders_period: "2026-06-30", inventory_yoy: -30, inventory_period: "2026-06-30", capex_yoy: 40, capex_period: "2026-06-30", sampled: 8, total: 77 },
  );
  // 全部分量满格正向 → 100（存货-30 乘 sign=-1 → +1）
  assert.equal(v, 100);
});

test("财务分量：利润大跌压低健康分", () => {
  const v = computeIndustryHealth([], {}, undefined, { earnings_yoy: -60, earnings_period: "2026-06-30", sampled: 8, total: 10 });
  assert.ok(v !== null && v < 50, `got ${v}`);
});

test("披露期防回放前视：asOf 未到报告期 → 财务分量不参与", () => {
  const withFin = computeIndustryHealth([], {}, undefined, { earnings_yoy: 60, earnings_period: "2026-06-30" });
  const before = computeIndustryHealth([], {}, "2026-05-15", { earnings_yoy: 60, earnings_period: "2026-06-30" });
  assert.ok((withFin ?? 0) > 50);
  assert.equal(before, null, "报告期晚于 asOf → 分量不可见 → null");
});

test("权重归一：只有价格分量时与只有财务分量时都能出分", () => {
  const priceOnly = computeIndustryHealth([{ nodeId: "mt_cu" }], { mt_cu: monthly([100, 100, 100, 100, 100, 100, 100, 120]) });
  const finOnly = computeIndustryHealth([], {}, undefined, { earnings_yoy: 30, earnings_period: "2026-06-30" });
  assert.equal(priceOnly, 100);
  assert.equal(finOnly, 100);
});

test("解读：用户范式的标题+正文（利润翻倍/订单超一倍/提前备货/订单≠利润提醒）", () => {
  const r = readFundamentals({ earnings_yoy: 100.4, orders_yoy: 142.4, inventory_yoy: 88.2, period: "2026-06-30", sampled: 8 });
  assert.ok(r!.headline.includes("利润翻倍"), r!.headline);
  assert.ok(r!.headline.includes("订单增长超一倍"), r!.headline);
  assert.ok(r!.headline.includes("提前备货"), r!.headline);
  assert.ok(r!.body.startsWith("截至2026-06-30，市值排名前8的行业龙头"), r!.body);
  assert.ok(r!.body.includes("订单/合同负债增速甚至高于利润增速"), r!.body);
  assert.ok(r!.body.includes("订单增长不等于最终利润一定增长"), r!.body);
  assert.ok(r!.body.includes("资本开支数据暂缺"), r!.body);
});

test("解读：订单萎缩+存货积压 → 风险话术", () => {
  const r = readFundamentals({ earnings_yoy: -5, orders_yoy: -35, inventory_yoy: 40 });
  assert.ok(r!.headline.includes("订单大幅萎缩"));
  assert.ok(r!.headline.includes("库存明显积压"), r!.headline);
  assert.ok(r!.body.includes("库存积压会侵蚀后续利润"), r!.body);
});

test("解读：capex 有数 → 说明扩产/收缩，不再说暂缺", () => {
  const r = readFundamentals({ earnings_yoy: 10, capex_yoy: 45 });
  assert.ok(r!.body.includes("同步扩产"), r!.body);
  const r2 = readFundamentals({ earnings_yoy: 10 });
  assert.ok(r2!.body.includes("资本开支数据暂缺"), r2!.body);
});

test("解读：全空 → null", () => {
  assert.equal(readFundamentals({}), null);
});
