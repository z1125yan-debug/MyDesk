// AI优选决策卡解析钉测（2026-10-16）
//
// 钉住的行为：
// ① 生产格式 note（ai-pick-generate.ts 拼的++「逐只决策卡：」+「第 5 种分歧」附录）
// 能解析回每只票一张卡，名称取自段；
// ② 11 个字段各就其位，值里自带的「；」不截断；
// ③ 模型没给的字段 = null（前端显示「未取到」，不编）；
// ④ 末尾「第 5 种分歧」附录不进任何字段；
// ⑤ 旧格式 note（无「逐只决策卡：」）→ []，调用方保留原文本展示。
// 纯字符串变换，零 IO，node --test 直跑。

import test from "node:test";
import assert from "node:assert/strict";
import {
AI_PICK_CARD_FIELDS,
parseAiPickNote,
} from "../../src/lib/quant/strategy/ai-pick-note.ts";

const L = String.fromCharCode(0x3010);
const R = String.fromCharCode(0x3011);

const NOTE =
(L + "优选来源" + R) + "600519.SH 贵州茅台←动量策略；000858.SZ 五粮液←动量策略 " +
(L + "参考模板版" + R) + "AI 从 20 只候选里优选出 2 只（服务端模型 test 收窄，按 docs/参考平台能力清单.md：5 字段入选理由/入场条件/仓位节奏/失效条件/主要风险 + 11 字段研究卡 + 七维框架）。" +
"逐只决策卡：600519.SH：入选理由：白酒龙头，资金回流；入场条件：放量站上近端均线再关注；仓位节奏：轻仓分批；失效条件：跌破近端均线且放量下跌；主要风险：消费复苏不及预期；" +
"研究结论：值得关注；核心结论：龙头企稳信号；依据：PE 20；主力净流入 1.2 亿；关键信号：放量站上均线；强弱量价：价稳量增，换手 1.5%；反证状态：放量跌破均线说明我错了；触发条件：放量站上近端均线；风险提示：白酒板块波动大；操作参考：关注，不追高；" +
"000858.SZ：入选理由：二线白酒跟随；仓位节奏：观望；失效条件：跌破均线；研究结论：跟随关注；核心结论：跟随龙头；反证状态：跌破均线说明我错了；触发条件：站上均线；风险提示：跟随波动；操作参考：观望 " +
(L + "第 5 种分歧：主力 vs 大户散户" + R) + "（AI 优选之后，按每只算；主力在留 = 主力没跑）2 只里有 0 只出现分歧：600519.SH 主力没跑；000858.SZ 主力没跑";

test("11 字段顺序与参考平台一致", () => {
assert.deepEqual(
AI_PICK_CARD_FIELDS.map((f) => f.label),
["研究结论", "核心结论", "依据", "关键信号", "强弱量价", "反证状态", "触发条件", "失效条件", "仓位节奏", "风险提示", "操作参考"],
);
});

test("解析出 2 张卡，名称来自优选来源段", () => {
const cards = parseAiPickNote(NOTE);
assert.equal(cards.length, 2);
assert.equal(cards[0].symbol, "600519.SH");
assert.equal(cards[0].name, "贵州茅台");
assert.equal(cards[1].symbol, "000858.SZ");
assert.equal(cards[1].name, "五粮液");
});

test("第一张卡 11 字段齐全，值正确", () => {
const c = parseAiPickNote(NOTE)[0];
assert.equal(c.researchConclusion, "值得关注");
assert.equal(c.coreConclusion, "龙头企稳信号");
// 值里的「；」不截断：依据是完整的一句，不是 "PE 20"
assert.equal(c.evidence, "PE 20；主力净流入 1.2 亿");
assert.equal(c.keySignals, "放量站上均线");
assert.equal(c.priceVolume, "价稳量增，换手 1.5%");
assert.equal(c.falsification, "放量跌破均线说明我错了");
assert.equal(c.trigger, "放量站上近端均线");
assert.equal(c.invalidCondition, "跌破近端均线且放量下跌");
assert.equal(c.positionRhythm, "轻仓分批");
assert.equal(c.riskHint, "白酒板块波动大");
assert.equal(c.actionRef, "关注，不追高");
// 头部三项也不丢
assert.equal(c.reason, "白酒龙头，资金回流");
assert.equal(c.entryCondition, "放量站上近端均线再关注");
assert.equal(c.mainRisk, "消费复苏不及预期");
});

test("第二张卡缺字段 = null（不编），分歧附录不进字段", () => {
const c = parseAiPickNote(NOTE)[1];
assert.equal(c.evidence, null);
assert.equal(c.keySignals, null);
assert.equal(c.priceVolume, null);
assert.equal(c.entryCondition, undefined);
assert.equal(c.mainRisk, undefined);
assert.equal(c.researchConclusion, "跟随关注");
assert.equal(c.actionRef, "观望");
assert.ok(!c.actionRef.includes("分歧"), "分歧附录不能进操作参考");
});

test("旧格式 / 空 note → []", () => {
assert.deepEqual(parseAiPickNote("当时没记具体票，补不出来"), []);
assert.deepEqual(parseAiPickNote("600519.SH 贵州茅台←动量策略"), []);
assert.deepEqual(parseAiPickNote(null), []);
assert.deepEqual(parseAiPickNote(""), []);
});
