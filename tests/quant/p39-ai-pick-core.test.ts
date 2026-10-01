// P39 / #75 AI优选战绩层 · 纯核钉测（2026-10-01）
//
// 钉住的行为：
// ① buildAiPickPrompt 把候选清单 + topN 上限写进指令，且只要求从清单内选；
// ② parseAiPickResponse 收得回合法 JSON（含 ```json 包裹）、收不回（乱码/无 picks）一律 null；
// ③ narrowChoices 只保留「候选集内」的票、限量、去重；清单外的选择一律丢弃（脱离可复核候选 = 无效）。
// 这些都只是字符串/数组变换，零 IO、零时钟，node --test 直跑。

import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PICK_MAX, buildAiPickPrompt, parseAiPickResponse, narrowChoices, candidateMap, type AiPickCandidate,
} from "../../src/lib/quant/strategy/ai-pick-core.ts";

const cands: AiPickCandidate[] = [
  { symbol: "600519.SH", name: "贵州茅台", close: 1500 },
  { symbol: "000858.SZ", name: "五粮液", close: 140 },
  { symbol: "300750.SZ", name: "宁德时代", close: 200 },
  { symbol: "601318.SH", name: "中国平安", close: 50 },
];

test("prompt 含交易日、候选清单与上限指令", () => {
  const p = buildAiPickPrompt(cands, "2026-09-30", 3);
  assert.ok(p.includes("2026-09-30"), "带交易日");
  assert.ok(p.includes("600519.SH"), "列候选代码");
  assert.ok(p.includes("最多选 3 只"), "写 topN 上限");
  assert.ok(/严格如下/.test(p) || p.includes('"picks"'), "要求严格 JSON 形状");
});

test("解析：干净 JSON → 选择列表", () => {
  const r = parseAiPickResponse('{"picks":[{"symbol":"600519.SH","reason":"龙头"}]}');
  assert.ok(r, "应解析成功");
  assert.equal(r!.length, 1);
  assert.equal(r![0].symbol, "600519.SH");
  assert.equal(r![0].reason, "龙头");
});

test("解析：容忍 ```json 代码块包裹与前后闲话", () => {
  const text = '好的，这是结果：\n```json\n{"picks":[{"symbol":"000858.SZ","reason":"次优"}]}\n```\n以上。';
  const r = parseAiPickResponse(text);
  assert.ok(r, "应剥掉 markdown 收出 JSON");
  assert.equal(r!.length, 1);
  assert.equal(r![0].symbol, "000858.SZ");
});

test("解析：非 JSON / 无 picks → null（不造假）", () => {
  assert.equal(parseAiPickResponse("今天没有特别好的票"), null);
  assert.equal(parseAiPickResponse('{"foo":1}'), null);
  assert.equal(parseAiPickResponse(""), null);
});

test("收窄：只保留候选集内的票，限量、去重", () => {
  const choices = [
    { symbol: "600519.SH", reason: "a" },
    { symbol: "600519.SH", reason: "重复" },           // 同票去重
    { symbol: "999999.SH", reason: "清单外" },          // 候选里没有 → 丢弃
    { symbol: "300750.SZ", reason: "b" },
    { symbol: "000858.SZ", reason: "c" },
  ];
  const out = narrowChoices(choices, cands, 2);
  assert.equal(out.length, 2, "限量到 topN=2");
  assert.deepEqual(out.map((x) => x.symbol).sort(), ["300750.SZ", "600519.SH"].sort());
  assert.ok(!out.some((x) => x.symbol === "999999.SH"), "清单外被剔除");
  assert.equal(out[0].reason, "a", "理由随票带走");
});

test("收窄：模型只回 6 位代码也能归并到候选（去后缀匹配）", () => {
  const choices = [{ symbol: "601318", reason: "d" }];
  const out = narrowChoices(choices, cands, AI_PICK_MAX);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "601318.SH", "还原成候选原代码（带后缀）");
});

test("候选映射：大小写/后缀归一（key 去后缀、value 保留原代码）", () => {
  const m = candidateMap([{ symbol: "600519.sh" }]);
  assert.ok(m.has("600519"), "key 归一成去后缀大写");
  assert.equal(m.get("600519")!.symbol, "600519.sh", "value 保留原始代码形态");
  // 大写带后缀入参走的是同一条归一路径
  const m2 = candidateMap([{ symbol: "000858.SZ" }]);
  assert.ok(m2.has("000858"), "大写带后缀也能进同一 key 空间");
});
