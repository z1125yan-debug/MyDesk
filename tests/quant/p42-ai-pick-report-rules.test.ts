// 日报 AI 优选段报数规则（用户 2026-10-17 定）：
// 决策日（新选股）只列代码、名称、理由，不显示选股日涨跌幅（没意义，不是收益）。
// 卖出日（D+2）涨跌幅 = 卖价 vs D+1 开盘买入价，扣 0.41% 成本后为净收益，三个卖点各给一个。
// 测试用 10-15 真实版本 + 模拟 10-19 卖出价（快照写临时目录，不污染生产 data/price-snapshots）。
// 买入价（10-16 开盘）是库里真实值，写死在测试里（历史日K不变）；上证买入价走 TDX，测试里同样走 TDX 取期望值。

import { test} from "node:test";
import assert from "node:assert/strict";
import { promises as fs} from "node:fs";
import { tmpdir} from "node:os";
import path from "node:path";
import { parseAiPickNote, stripPickDayChangePct} from "../../src/lib/quant/strategy/ai-pick-note.ts";
import {
buildAiPickVersionWinRateSection,
computeAiPickVersionStats,
netReturnPct,
} from "../../src/lib/desk/ai-pick-version-stats.ts";
import { tdxDayBars} from "../../src/lib/desk/tdx.ts";

const CHANGE_PCT_RE = /(涨跌幅|涨幅|跌幅|上涨|下跌|涨|跌)\s*[+-]?[\d.]+%/;

test("去选股日涨跌幅：理由里的涨幅数字去掉，其他数字保留", () => {
const reason = "大市值医药龙头，主力净流入+0.27亿、涨幅+2.44%，叠加贝莱德增持H股与北向三季度医药持仓大增，产业与资金方向一致，波动可控。";
const out = stripPickDayChangePct(reason);
assert.ok(!CHANGE_PCT_RE.test(out), `仍有涨跌幅数字：${out}`);
assert.ok(out.includes("主力净流入+0.27亿"), "主力净额应保留");
assert.ok(out.includes("贝莱德增持"), "理由正文应保留");
assert.ok(!out.includes("、，") &&!out.includes("，，"), "不应留悬空分隔符");
});

test("去选股日涨跌幅：依据里的收盘价/换手/PE保留，只去涨跌幅", () => {
const ev = "依据：收盘46.60，涨2.44%，成交额29.47亿，PE(TTM)40.03，PB4.80，市值3092.9亿，主力净额+0.27亿，换手1.00%";
const out = stripPickDayChangePct(ev);
assert.ok(!CHANGE_PCT_RE.test(out), `仍有涨跌幅数字：${out}`);
assert.ok(out.includes("收盘46.60"), "收盘价应保留");
assert.ok(out.includes("成交额29.47亿"), "成交额应保留");
assert.ok(out.includes("PE(TTM)40.03"), "PE 应保留");
assert.ok(out.includes("换手1.00%"), "换手不是涨跌幅，应保留");
});

test("去选股日涨跌幅：跌/涨跌幅/定性词", () => {
assert.equal(stripPickDayChangePct("跌1.39%"), "");
assert.equal(stripPickDayChangePct("涨跌幅+2.44%"), "");
assert.equal(stripPickDayChangePct("价涨量温和放大"), "价涨量温和放大");
assert.equal(stripPickDayChangePct("跌破近端均线"), "跌破近端均线");
assert.equal(stripPickDayChangePct("个股涨3.25%、主力小幅净流入+0.05亿"), "个股、主力小幅净流入+0.05亿");
});

test("净收益：卖价 vs D+1 开盘买入价，扣 0.41%", () => {
// 卖 50，买入开盘 46.25：毛 (50/46.25-1)*100 = 8.108…，净 7.698…
const net = netReturnPct(50, 46.25);
assert.ok(net!= null && Math.abs(net - 7.698) < 0.01, `净收益应约 7.70，得到 ${net}`);
assert.equal(netReturnPct(null, 46.25), null);
assert.equal(netReturnPct(50, null), null);
assert.equal(netReturnPct(50, 0), null);
});

test("决策日段：10-15 真实 note → 只列代码、名称、理由，无选股日涨跌幅", () => {
// 10-15 真实 symbolsNote 里的恒瑞卡（原文照抄，含供解析名称）
const note =
"【当日情绪】大盘档位 弱势。 【优选来源】600276.SH 恒瑞医药←底分型；" +
"【参考模板版】AI 从 11 只候选里优选出 4 只。逐只决策卡：600276.SH：入选理由：大市值医药龙头，主力净流入+0.27亿、涨幅+2.44%，叠加贝莱德增持H股与北向三季度医药持仓大增，产业与资金方向一致，波动可控。；" +
"入场条件：放量站稳近端均线后再关注；仓位节奏：分批；失效条件：再度跌破近端均线且主力净额转负；主要风险：PE(TTM)40.03估值偏高，医药板块情绪回落则回吐；" +
"研究结论：外资增持叠加北向医药加仓，龙头资金面偏正面；核心结论：确定性优先的防守型候选；依据：收盘46.60，涨2.44%，成交额29.47亿，PE(TTM)40.03，PB4.80，市值3092.9亿，主力净额+0.27亿，换手1.00%；贝莱德H股持股5.69%升至6.31%；" +
"关键信号：主力净流入、外资增持、北向医药加仓；强弱量价：价涨量温和放大，换手仅1.00%，筹码稳定；反证状态：若次日放量滞涨或主力净流出，说明资金承接不足；触发条件：量能配合站上近端均线；风险提示：高估值+大盘股弹性有限，注意板块轮动；操作参考：关注；";
const cards = parseAiPickNote(note);
assert.equal(cards.length, 1);
const c = cards[0];
assert.equal(c.symbol, "600276.SH");
assert.equal(c.name, "恒瑞医药");
// 决策日段渲染：代码 + 名称 + 理由（去涨跌幅），与 three-daily-reports.ts fetchStoredAiPick 同口径
const line = `${c.name}（${c.symbol}）：入选理由：${stripPickDayChangePct(c.reason?? "")}`;
assert.ok(!CHANGE_PCT_RE.test(line), `决策日段仍有选股日涨跌幅：${line}`);
assert.ok(line.includes("恒瑞医药（600276.SH）"), "应有代码+名称");
assert.ok(line.includes("大市值医药龙头"), "应有理由");
// PDF 卡片同理：依据字段去涨跌幅后，换手/PE 保留
const ev = stripPickDayChangePct(c.evidence?? "");
assert.ok(!CHANGE_PCT_RE.test(ev), `依据仍有选股日涨跌幅：${ev}`);
assert.ok(ev.includes("换手1.00%"), "依据里的换手应保留");
});

test("卖出日段：10-15 版本 + 模拟 10-19 卖出价 → 涨跌幅 = 卖价 vs 10-16 开盘买入价扣 0.41%", async () => {
// 10-16 开盘买入价（库里真实日K open，历史值不变）
const buyOpen: Record<string, number> = {
"600276.SH": 46.25, "605258.SH": 42.63, "300771.SZ": 11.75, "603198.SH": 38.1,
"605299.SH": 13.19, "603919.SH": 16.5, "601001.SH": 17.95,
};
// 模拟 10-19 三个卖点价（临时目录，不写生产快照）
const sells: Record<string, Record<string, number>> = {
"1030": { "000001.SH": 3750, "600276.SH": 47.0, "605258.SH": 40.0, "300771.SZ": 12.0, "603198.SH": 39.0, "605299.SH": 13.0, "603919.SH": 17.0, "601001.SH": 18.0},
"1130": { "000001.SH": 3740, "600276.SH": 47.5, "605258.SH": 41.0, "300771.SZ": 12.5, "603198.SH": 39.5, "605299.SH": 13.5, "603919.SH": 17.5, "601001.SH": 18.5},
close: { "000001.SH": 3720, "600276.SH": 46.0, "605258.SH": 39.0, "300771.SZ": 11.5, "603198.SH": 38.5, "605299.SH": 12.5, "603919.SH": 16.8, "601001.SH": 17.8},
};
const dir = await fs.mkdtemp(path.join(tmpdir(), "aipick-sellday-"));
try {
for (const [slot, rows] of Object.entries(sells)) {
const label = slot === "1030"? "10:30": slot === "1130"? "11:30 休盘": "15:00 收盘";
await fs.writeFile(path.join(dir, `2026-10-19-${slot}.json`), JSON.stringify({
date: "2026-10-19", slot, label, capturedAt: "2026-10-19 00:00:00",
rows: Object.entries(rows).map(([symbol, price]) => ({ symbol, name: symbol, price, prevClose: null, changePct: null})),
}));
}
const { versions, missing} = await computeAiPickVersionStats("2026-10-15", "2026-10-19", { snapshotsDir: dir});
assert.deepEqual(missing, [], `不应有缺失：${missing.join(" ")}`);
assert.equal(versions.length, 2, "10-15 应有 2 个版本");
// v1 7 只：10:30 平均净收益 = 各票 (卖价/买入开盘-1)*100 - 0.41 的等权平均
const v1 = versions[0];
assert.equal(v1.version.picks.length, 7);
assert.equal(v1.slots[0].counted, 7, "7 只都应有价并计入");
const expected1030 = v1.version.picks.reduce((sum, p) => {
const sym = String(p.symbol).toUpperCase();
return sum + ((sells["1030"][sym] / buyOpen[sym] - 1) * 100 - 0.41);
}, 0) / 7;
assert.ok(
v1.slots[0].avgChangePct!= null && Math.abs(v1.slots[0].avgChangePct - expected1030) < 0.001,
`v1 10:30 平均净收益应 ${expected1030.toFixed(4)}，得到 ${v1.slots[0].avgChangePct}`,
);
// v2 4 只：同样核对 15:00 收盘点
const v2 = versions[1];
assert.equal(v2.version.picks.length, 4);
const expectedClose = v2.version.picks.reduce((sum, p) => {
const sym = String(p.symbol).toUpperCase();
return sum + ((sells.close[sym] / buyOpen[sym] - 1) * 100 - 0.41);
}, 0) / 4;
assert.ok(
v2.slots[2].avgChangePct!= null && Math.abs(v2.slots[2].avgChangePct - expectedClose) < 0.001,
`v2 15:00 平均净收益应 ${expectedClose.toFixed(4)}，得到 ${v2.slots[2].avgChangePct}`,
);
// 上证对比同样按净收益（卖价 vs TDX 10-16 开盘，扣 0.41%）
const sseBars = await tdxDayBars("000001.SH", 30);
const sseOpen = sseBars?.find((b) => b.date === "2026-10-16")?.o?? null;
assert.ok(sseOpen!= null && sseOpen > 0, "TDX 应给出上证 10-16 开盘价");
const expectedSse1030 = (sells["1030"]["000001.SH"] / (sseOpen as number) - 1) * 100 - 0.41;
assert.ok(
v1.slots[0].sseChangePct!= null && Math.abs(v1.slots[0].sseChangePct - expectedSse1030) < 0.001,
`上证 10:30 净收益应 ${expectedSse1030.toFixed(4)}，得到 ${v1.slots[0].sseChangePct}`,
);
// 文案口径：新口径，不含旧的“收盘价成本”说法
const text = buildAiPickVersionWinRateSection("2026-10-15", "2026-10-19", versions, []);
assert.ok(text.includes("D+1 开盘买入价"), "文案应写 D+1 开盘买入价");
assert.ok(!text.includes("卖出日之前最近一个交易日收盘价"), "文案不应再写旧的收盘价成本口径");
} finally {
await fs.rm(dir, { recursive: true, force: true});
}
});
