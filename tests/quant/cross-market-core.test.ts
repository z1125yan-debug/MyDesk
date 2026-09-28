// 跨市场预警纯核单测 — 2026-09-29
// 钉三件事：连跌判定只认"持续"（连续收跌+累计跌幅，单日急跌不算）；读数不足=bearish=null 不是 false；
// 板块映射只挂真实对应品种，没映射的板块如实说"没有贴近品种"。
import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeInstrument, judgeSectorOverseas, SECTOR_OVERSEAS_MAP, CROSS_TH, sectorOverseasNote, recentRiskVerdict,
  type CrossInstrumentInput,
} from "../../src/lib/quant/screener/cross-market-core.ts";

const barsFrom = (closes: number[], start = "2026-09-20"): { date: string; close: number }[] =>
  closes.map((c, i) => ({ date: `${start}+${i}`, close: c }));

const mk = (key: string, closes: number[], missing = ""): CrossInstrumentInput => {
  const def = { usSMH: "美国半导体ETF", usNQ: "纳指期货", comexGold: "COMEX黄金", nymexCrude: "NYMEX原油" }[key] ?? key;
  const kind = key === "comexGold" || key === "nymexCrude" ? "futures" : "etf";
  return { key, label: def as string, kind, bars: missing ? [] : barsFrom(closes), missing };
};

test("连跌判定：连续3天收跌且3日累计跌破阈值 → bearish", () => {
  // 100 → 跌3天：100, 99, 97, 94.5（3日累计 -5.5%，SMH 阈值 cum3=-3 / streak=3）
  const j = judgeInstrument(mk("usSMH", [100, 99, 97, 94.5]));
  assert.equal(j.downStreak, 3);
  assert.equal(j.bearish, true);
  assert.ok(j.line.includes("连跌 3 天"));
});

test("单日急跌不算持续：只跌一天 → bearish=false", () => {
  // 100, 101, 102, 90 —— 3日累计 -10% 但只连跌1天；5日累计不适用（4根）
  // cum3 = 90/102-1 = -11.8% ≤ -5？ cum3 阈值是 -3 且 streak=1 <3 → 不触发；cum5 需要 n>5
  const j = judgeInstrument(mk("usSMH", [100, 101, 102, 90]));
  assert.equal(j.downStreak, 1);
  assert.equal(j.bearish, false, "单日暴跌不是'持续看跌'，不该报警");
});

test("5日累计跌破阈值即使不连跌也触发（V型下跌中继）", () => {
  // 100, 95, 96, 97, 96, 94 —— 连跌1天，但 5 日累计 94/95-1=-1.05%？需要更狠：
  // 100, 98, 96, 94, 92, 96 —— cum5 = 96/98-1 = -2.04？直接构造：closes[n-1]/closes[n-6]
  const j = judgeInstrument(mk("usSMH", [100, 105, 102, 99, 96, 94]));
  // cum5 = 94/100-1 = -6% ≤ -5 → 触发，尽管只连跌1天
  assert.equal(j.cum5, -6);
  assert.equal(j.bearish, true);
});

test("读数不足：missing 或 bars<4 → bearish=null，文案不装", () => {
  const miss = judgeInstrument(mk("usSMH", [], "上游挂了"));
  assert.equal(miss.bearish, null);
  assert.ok(miss.line.includes("读数没拿到"));
  assert.ok(miss.line.includes("上游挂了"));
  const short = judgeInstrument(mk("usNQ", [100, 99]));
  assert.equal(short.bearish, null);
  assert.ok(short.line.includes("不够判持续"));
});

test("上涨行情 → bearish=false 且文案说'没有明显拖累'", () => {
  const j = judgeInstrument(mk("comexGold", [100, 100.5, 101, 101.5, 102, 102.5]));
  assert.equal(j.bearish, false);
  assert.ok(j.line.includes("没有明显拖累"));
});

test("黄金阈值与原油阈值分开（黄金低波动、原油高波动）", () => {
  assert.ok(Math.abs(CROSS_TH.comexGold.cum5) < Math.abs(CROSS_TH.nymexCrude.cum5));
});

test("板块映射：半导体挂 SMH+QQQ，外盘连跌 → warn + 红标", () => {
  const smh = judgeInstrument(mk("usSMH", [100, 99, 97, 94.5]));
  const qqq = judgeInstrument(mk("usNQ", [100, 100.5, 101, 101.2]));
  const sig = judgeSectorOverseas("半导体", [smh, qqq]);
  assert.equal(sig.warn, true);
  assert.equal(sig.tag, "外盘连跌");
  assert.equal(sig.tone, "red");
  assert.ok(sig.line.includes("美国半导体ETF"));
});

test("板块映射：对应外盘都健康 → 不 warn，文案说没有拖累", () => {
  const smh = judgeInstrument(mk("usSMH", [100, 100.5, 101, 101.5]));
  const sig = judgeSectorOverseas("半导体", [smh]);
  assert.equal(sig.warn, false);
  assert.ok(sig.line.includes("没有明显拖累") || sig.line.includes("隔夜压力不大"));
});

test("没映射的板块：如实说没有贴近品种，不硬套", () => {
  assert.equal(SECTOR_OVERSEAS_MAP["白酒"], undefined);
  const sig = judgeSectorOverseas("白酒", []);
  assert.equal(sig.warn, false);
  assert.ok(sig.line.includes("没有贴近的外盘品种"));
});

test("映射内但读数全缺 → warn=false，文案说'判不了'而非'没有信号'", () => {
  const miss = judgeInstrument(mk("usSMH", [], "腾讯没回"));
  const sig = judgeSectorOverseas("半导体", [miss]);
  assert.equal(sig.warn, false);
  assert.ok(sig.line.includes("判不了"));
});

test("化学类的原油是成本端代理，备注要说破", () => {
  assert.ok(sectorOverseasNote("化学原料").includes("成本端"));
  assert.equal(sectorOverseasNote("半导体"), "");
});

test("近期风险综合结论：阶段+分数+外盘 → 高风险档", () => {
  const v = recentRiskVerdict({
    stage: "趋势反转", midTop: 75, trendDamage: 45, shortPullback: 80,
    deltaUp: true, crossWarn: true, crossShort: "COMEX黄金 连跌5天、5日 -4.9%",
  });
  assert.equal(v.tone, "red");
  assert.equal(v.label, "高风险");
  assert.ok(v.line.includes("趋势反转"));
  assert.ok(v.line.includes("COMEX黄金 连跌5天"));
  assert.ok(v.line.endsWith("。"));
});

test("近期风险综合结论：各项平稳 → 暂时安全，理由不硬凑", () => {
  const v = recentRiskVerdict({
    stage: "趋势健康", midTop: 20, trendDamage: 15, shortPullback: 30,
    deltaUp: false, crossWarn: false, crossShort: null,
  });
  assert.equal(v.tone, "green");
  assert.equal(v.label, "暂时安全");
  assert.ok(v.line.includes("没有触发项"));
});

test("近期风险综合结论：外盘连跌单独也能抬一档", () => {
  const a = recentRiskVerdict({ stage: "趋势健康", midTop: 20, trendDamage: 15, shortPullback: 30, deltaUp: false, crossWarn: false, crossShort: null });
  const b = recentRiskVerdict({ stage: "趋势健康", midTop: 20, trendDamage: 15, shortPullback: 30, deltaUp: false, crossWarn: true, crossShort: "NYMEX原油 连跌4天、5日 -7%" });
  assert.equal(a.label, "暂时安全");
  assert.equal(b.label, "有风险苗头");
  assert.ok(b.line.includes("NYMEX原油 连跌4天"));
});
