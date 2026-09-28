// decision-widget-core 单测：钉死稳智 11 字段解析口径
//
// 目的：让前端结构化渲染器不再依赖"模型刚好吐对了格式"的运气——
// 每种典型吐法（行内、跨行、缺字段、乱序）都要有断言，解析规则一旦悄悄漂走立刻红。
import test from "node:test";
import assert from "node:assert/strict";
import { extractDecision, DECISION_FIELDS, EVIDENCE_BLOCKS } from "../../src/lib/desk/decision-widget-core.ts";

// 参考 modes.ts MODE_NOTES.decision 的完整模板
const FULL_TEMPLATE = `🎯 研究结论
- 📌 核心结论：现在不宜追高，等回调。
- 📌 依据：5 日线 12.30、成交量缩至 20 日均量 0.6 倍
- 📈 关键信号：站上 5 日线；量能萎缩；资金净流出 1.2 亿
- 📊 强弱/量价：价涨量缩，量价背离
- 🧪 反证状态：若放量突破 13.00 则推翻结论
- 🗓️ 触发条件：回踩 11.80 支撑再启动
- 🛑 失效条件：跌破 11.50
- 📦 仓位节奏：2 成仓试仓，回踩加仓至 4 成
- ⚠️ 风险提示：短线抛压；行业景气波动
- 🧭 操作参考：等回调再动，不追高

🔬 Agent Loop 摘要：调了 quote、news 两个工具，拿到现价 12.45、量能数据
🔎 已核验的信息来源：来源：东财 15:32
📊 结构化结果：量比 0.58
⚠️ 数据提示：筹码分布数据暂无`;

test("完整模板：10 个 11 字段 + 4 个证据区块都能抽到", () => {
  const r = extractDecision(FULL_TEMPLATE);
  assert.ok(r, "应命中决策 widget");
  assert.equal(r.hit, true);
  assert.equal(Object.keys(r.fields).length, 10, "10 个 11 字段");
  assert.equal(Object.keys(r.blocks).length, 4, "4 个证据区块");
  // 关键字段的正文片段
  assert.match(r.fields.core_judgement!, /不宜追高/);
  assert.match(r.fields.falsification!, /放量突破/);
  assert.match(r.fields.position_plan!, /2 成仓/);
  assert.match(r.blocks.sources!, /东财/);
});

test("字段顺序按锚点出现顺序（渲染时按 DECISION_FIELDS 固定顺序）", () => {
  const r = extractDecision(FULL_TEMPLATE)!;
  // 顺序数组里前 10 个就是 fields 键的顺序
  const fieldKeys = r.order.filter((k) => DECISION_FIELDS.some((d) => d.key === k));
  assert.deepEqual(fieldKeys, DECISION_FIELDS.map((d) => d.key));
});

test("证据区块顺序按出现顺序", () => {
  const r = extractDecision(FULL_TEMPLATE)!;
  const blockKeys = r.order.filter((k) => EVIDENCE_BLOCKS.some((b) => b.key === k));
  assert.deepEqual(blockKeys, EVIDENCE_BLOCKS.map((b) => b.key));
});

test("signal 抽取：标题后紧跟的第一句正文（不吞下一个锚点）", () => {
  const md = `## 🎯 研究结论
现在不宜追高，等回调再动。

- 📌 核心结论：结论句`;
  const r = extractDecision(md);
  assert.ok(r);
  assert.equal(r.signal, "现在不宜追高，等回调再动。");
});

test("少填一半：只命中 3 个字段也算命中，前端画半张卡", () => {
  const md = `🎯 研究结论
- 📌 核心结论：结论句
- 📈 关键信号：三条信号
- ⚠️ 风险提示：两条风险`;
  const r = extractDecision(md);
  assert.ok(r);
  assert.equal(r.hit, true);
  assert.equal(Object.keys(r.fields).length, 3);
  assert.equal(Object.keys(r.blocks).length, 0);
});

test("完全不匹配：不命中就返回 null（交给普通分区卡渲染）", () => {
  const md = `普通回答
没有决策结构，就是聊两句。
今天行情不错，明天继续观察。`;
  assert.equal(extractDecision(md), null);
});

test("空字符串：返回 null", () => {
  assert.equal(extractDecision(""), null);
});

test("字段缺失时不猜不编——不写进去", () => {
  const md = `🎯 研究结论
- 📌 核心结论：只有一句
- 🧭 操作参考：等回调`;
  const r = extractDecision(md)!;
  assert.equal(r.fields.core_judgement, "只有一句");
  assert.equal(r.fields.action, "等回调");
  assert.equal(r.fields.signals, undefined);
  assert.equal(r.fields.risk, undefined);
});
