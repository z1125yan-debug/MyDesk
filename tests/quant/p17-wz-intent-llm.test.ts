// P17-① 稳智对齐 · 意图识别器 LLM 层单元测试
// 跑法：node --experimental-strip-types --test tests/quant/p17-wz-intent-llm.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WZ_HORIZONS, WZ_HORIZON_LABELS, WZ_SIGNAL_TYPES, WZ_SIGNAL_LABELS,
  asWzHorizon, asWzSignal, asStance, STANCE_LABELS,
  WZ_INTENT_PROMPT,
  parseWzDecisionLlmOutput, renderWzDecisionBlock, wzHorizonToKairoH,
  type WzDecisionSignal,
} from "../../src/lib/desk/intent-llm-core.ts";

// ---------- 常量与白名单 ----------

test("WZ_HORIZONS 5 档，label 唯一", () => {
  assert.equal(WZ_HORIZONS.length, 5);
  const labels = WZ_HORIZONS.map((h) => h.label);
  assert.equal(new Set(labels).size, 5);
  for (const h of WZ_HORIZONS) assert.ok(WZ_HORIZON_LABELS[h.key] === h.label, h.key);
});

test("WZ_SIGNAL_TYPES 12 类，label 唯一", () => {
  assert.equal(WZ_SIGNAL_TYPES.length, 12);
  const labels = WZ_SIGNAL_TYPES.map((s) => s.label);
  assert.equal(new Set(labels).size, 12);
  for (const s of WZ_SIGNAL_TYPES) assert.ok(WZ_SIGNAL_LABELS[s.key] === s.label, s.key);
});

test("asWzHorizon 白名单严格", () => {
  for (const h of WZ_HORIZONS) assert.equal(asWzHorizon(h.key), h.key);
  assert.equal(asWzHorizon("ultrashort"), null);
  assert.equal(asWzHorizon("mid-long"), null);
  assert.equal(asWzHorizon(""), null);
  assert.equal(asWzHorizon(null), null);
  assert.equal(asWzHorizon(undefined), null);
  assert.equal(asWzHorizon(123), null);
});

test("asWzSignal 白名单严格", () => {
  for (const s of WZ_SIGNAL_TYPES) assert.equal(asWzSignal(s.key), s.key);
  assert.equal(asWzSignal("trend"), null);
  assert.equal(asWzSignal("no signal"), null);
  assert.equal(asWzSignal(""), null);
});

test("asStance 白名单 + neutral 兜底", () => {
  assert.equal(asStance("long"), "long");
  assert.equal(asStance("short"), "short");
  assert.equal(asStance("wait"), "wait");
  assert.equal(asStance("neutral"), "neutral");
  assert.equal(asStance("multi"), "neutral");
  assert.equal(asStance(""), "neutral");
  assert.equal(asStance(null), "neutral");
});

test("STANCE_LABELS 4 项，无重叠", () => {
  const vals = Object.values(STANCE_LABELS);
  assert.equal(vals.length, 4);
  assert.equal(new Set(vals).size, 4);
});

// ---------- LLM 分类 prompt 契约 ----------

test("WZ_INTENT_PROMPT 覆盖所有字段", () => {
  assert.ok(WZ_INTENT_PROMPT.includes('"scene"'));
  assert.ok(WZ_INTENT_PROMPT.includes('"horizon"'));
  assert.ok(WZ_INTENT_PROMPT.includes('"signalType"'));
  assert.ok(WZ_INTENT_PROMPT.includes('"stance"'));
  assert.ok(WZ_INTENT_PROMPT.includes('"confidence"'));
  assert.ok(WZ_INTENT_PROMPT.includes('"sentimentTemp"'));
  assert.ok(WZ_INTENT_PROMPT.includes('"symbol"'));
  assert.ok(WZ_INTENT_PROMPT.includes("只输出 JSON"));
});

test("WZ_INTENT_PROMPT 枚举齐全", () => {
  for (const h of WZ_HORIZONS) assert.ok(WZ_INTENT_PROMPT.includes(h.key), `horizon 缺 ${h.key}`);
  for (const s of WZ_SIGNAL_TYPES) assert.ok(WZ_INTENT_PROMPT.includes(s.key), `signalType 缺 ${s.key}`);
});

// ---------- parseWzDecisionLlmOutput ----------

test("解析完整合法 JSON", () => {
  const raw = JSON.stringify({
    scene: "stock_analysis",
    horizon: "short",
    signalType: "trend_breakout",
    stance: "long",
    confidence: 72,
    sentimentTemp: 65,
    symbol: "600519.SH",
    keyLevels: { support: [1680, 1650], resistance: [1780] },
    stopPlan: { stopLoss: 1620, takeProfit: 1800 },
    positionPct: 25,
    invalidation: "跌破 1620 减仓",
    riskNotes: ["高位放量滞涨", "板块轮动加快"],
    dataGaps: ["北向资金", "分析师评级"],
    confidence_reason: "MA5 上穿 MA20 + 60 日新高 + 放量",
  });
  const r = parseWzDecisionLlmOutput(raw, "stock_analysis");
  assert.equal(r.ok, true);
  assert.equal(r.signal.stance, "long");
  assert.equal(r.signal.horizon, "short");
  assert.equal(r.signal.signalType, "trend_breakout");
  assert.equal(r.signal.confidence, 72);
  assert.equal(r.signal.sentimentTemp, 65);
  assert.equal(r.signal.positionPct, 25);
  assert.deepEqual(r.signal.keyLevels.support, [1680, 1650]);
  assert.deepEqual(r.signal.keyLevels.resistance, [1780]);
  assert.equal(r.signal.stopPlan.stopLoss, 1620);
  assert.equal(r.signal.stopPlan.takeProfit, 1800);
  assert.equal(r.signal.invalidation, "跌破 1620 减仓");
  assert.equal(r.signal.riskNotes.length, 2);
  assert.equal(r.signal.dataGaps.length, 2);
  assert.equal(r.sceneDivergence, null);
  assert.ok(r.reason);
});

test("剥 markdown ```json``` 包裹", () => {
  const raw = '```json\n' + JSON.stringify({
    scene: "quote", horizon: "short", signalType: "volume_surge", stance: "long", confidence: 60,
  }) + '\n```';
  const r = parseWzDecisionLlmOutput(raw, "quote");
  assert.equal(r.ok, true);
  assert.equal(r.signal.stance, "long");
  assert.equal(r.signal.confidence, 60);
});

test("scene 分歧被记录", () => {
  const raw = JSON.stringify({ scene: "sentiment", stance: "wait" });
  const r = parseWzDecisionLlemOutputFallbackGuard("sentiment", () => {
    return parseWzDecisionLlmOutput(raw, "stock_analysis");
  });
  assert.deepEqual(r.sceneDivergence, { ruleScene: "stock_analysis", llmScene: "sentiment" });
});

test("数值越界 clamp 到 [0,100]", () => {
  const r = parseWzDecisionLlmOutput(JSON.stringify({
    stance: "long", confidence: 150, sentimentTemp: -20, positionPct: 999,
  }));
  assert.equal(r.signal.confidence, 100);
  assert.equal(r.signal.sentimentTemp, 0);
  assert.equal(r.signal.positionPct, 100);
});

test("数值非数字视为 null", () => {
  const r = parseWzDecisionLlmOutput(JSON.stringify({
    stance: "long", confidence: "abc", sentimentTemp: undefined,
  }));
  assert.equal(r.signal.confidence, null);
  assert.equal(r.signal.sentimentTemp, null);
});

test("字符串数字被解析", () => {
  const r = parseWzDecisionLlemOutputFallbackGuard("long", () => {
    return parseWzDecisionLlmOutput(JSON.stringify({ stance: "long", confidence: "65.8" }));
  });
  assert.equal(r.signal.confidence, 66); // 四舍五入
});

test("非法 horizon 键回落 null", () => {
  const r = parseWzDecisionLlmOutput(JSON.stringify({ stance: "long", horizon: "ultrashort" }));
  assert.equal(r.signal.horizon, null);
});

test("非法 signalType 键回落 null", () => {
  const r = parseWzDecisionLlmOutput(JSON.stringify({ stance: "long", signalType: "bullish" }));
  assert.equal(r.signal.signalType, null);
});

test("空对象不 ok，stance 兜底 neutral", () => {
  const r = parseWzDecisionLlmOutput("{}");
  assert.equal(r.ok, false);
  assert.equal(r.signal.stance, "neutral");
  assert.equal(r.signal.horizon, null);
  assert.equal(r.signal.signalType, null);
});

test("完全无效 JSON -> ok=false 但 signal 仍是合法对象", () => {
  const r = parseWzDecisionLlmOutput("这不是 JSON");
  assert.equal(r.ok, false);
  assert.equal(r.signal.stance, "neutral");
  assert.deepEqual(r.signal.riskNotes, []);
  assert.deepEqual(r.signal.dataGaps, []);
});

test("字符串截断纪律：invalidation 200 字 / riskNotes 100 字 / dataGaps 60 字 / reason 100 字", () => {
  const raw = JSON.stringify({
    stance: "long",
    invalidation: "x".repeat(250),
    riskNotes: ["r".repeat(150), "s".repeat(50)],
    dataGaps: ["d".repeat(80), "e".repeat(30)],
    confidence_reason: "c".repeat(150),
  });
  const r = parseWzDecisionLlmOutput(raw);
  assert.equal(r.signal.invalidation!.length, 200);
  assert.equal(r.signal.riskNotes[0].length, 100);
  assert.equal(r.signal.riskNotes[1].length, 50);
  assert.equal(r.signal.dataGaps[0].length, 60);
  assert.equal(r.signal.dataGaps[1].length, 30);
  assert.equal(r.reason!.length, 100);
});

test("riskNotes 与 dataGaps 各最多 5 条", () => {
  const raw = JSON.stringify({
    stance: "long",
    riskNotes: ["a", "b", "c", "d", "e", "f", "g"],
    dataGaps: ["1", "2", "3", "4", "5", "6", "7"],
  });
  const r = parseWzDecisionLlemOutputFallbackGuard("long", () => parseWzDecisionLlmOutput(raw));
  assert.equal(r.signal.riskNotes.length, 5);
  assert.equal(r.signal.dataGaps.length, 5);
});

test("keyLevels 非数组忽略", () => {
  const r = parseWzDecisionLlmOutput(JSON.stringify({
    stance: "long", keyLevels: { support: "not array" },
  }));
  assert.equal(r.signal.keyLevels.support, undefined);
});

test("keyLevels 里的非数字过滤", () => {
  const r = parseWzDecisionLlmOutput(JSON.stringify({
    stance: "long", keyLevels: { support: [1680, "abc", null, 1650] },
  }));
  assert.deepEqual(r.signal.keyLevels.support, [1680, 1650]);
});

test("no_signal 类型合法通过", () => {
  const r = parseWzDecisionLlemOutputFallbackGuard("long", () => {
    return parseWzDecisionLlmOutput(JSON.stringify({ stance: "wait", signalType: "no_signal" }));
  });
  assert.equal(r.signal.signalType, "no_signal");
});

// ---------- renderWzDecisionBlock ----------

test("空信号块返回空数组", () => {
  const s: WzDecisionSignal = {
    stance: "neutral", horizon: null, signalType: null, confidence: null, sentimentTemp: null,
    keyLevels: {}, stopPlan: {}, positionPct: null, invalidation: null, riskNotes: [], dataGaps: [],
  };
  assert.deepEqual(renderWzDecisionBlock(s), []);
});

test("null 字段不渲染", () => {
  const s: WzDecisionSignal = {
    stance: "long", horizon: "short", signalType: "trend_breakout",
    confidence: null, sentimentTemp: null, keyLevels: {}, stopPlan: {},
    positionPct: null, invalidation: null, riskNotes: [], dataGaps: [],
  };
  const lines = renderWzDecisionBlock(s);
  assert.ok(lines.length >= 2);
  assert.ok(lines[0].includes("稳智决策信号块"));
  const joined = lines.join("\n");
  assert.ok(!joined.includes("置信度"));
  assert.ok(!joined.includes("情绪温度"));
  assert.ok(!joined.includes("关键价位"));
  assert.ok(!joined.includes("止盈止损"));
});

test("渲染完整字段", () => {
  const s: WzDecisionSignal = {
    stance: "long", horizon: "short", signalType: "trend_breakout",
    confidence: 72, sentimentTemp: 65, keyLevels: { support: [1680], resistance: [1780] },
    stopPlan: { stopLoss: 1620, takeProfit: 1800 }, positionPct: 25,
    invalidation: "跌破 1620 减仓", riskNotes: ["风险A"], dataGaps: ["北向"],
  };
  const lines = renderWzDecisionBlock(s);
  const joined = lines.join("\n");
  assert.ok(joined.includes("偏多"));
  assert.ok(joined.includes("短"));
  assert.ok(joined.includes("趋势突破"));
  assert.ok(joined.includes("72/100"));
  assert.ok(joined.includes("65/100"));
  assert.ok(joined.includes("25%"));
  assert.ok(joined.includes("支撑 1680"));
  assert.ok(joined.includes("阻力 1780"));
  assert.ok(joined.includes("止损 1620"));
  assert.ok(joined.includes("止盈 1800"));
  assert.ok(joined.includes("跌破 1620 减仓"));
  assert.ok(joined.includes("风险A"));
  assert.ok(joined.includes("北向"));
});

test("signalType=no_signal 不写信号类型行", () => {
  const s: WzDecisionSignal = {
    stance: "wait", horizon: "short", signalType: "no_signal",
    confidence: 30, sentimentTemp: null, keyLevels: {}, stopPlan: {},
    positionPct: null, invalidation: null, riskNotes: [], dataGaps: [],
  };
  const joined = renderWzDecisionBlock(s).join("\n");
  assert.ok(!joined.includes("无信号"));
  assert.ok(joined.includes("观望"));
});

// ---------- wzHorizonToKairoH ----------

test("wzHorizonToKairoH 映射", () => {
  assert.equal(wzHorizonToKairoH("ultra_short"), "short");
  assert.equal(wzHorizonToKairoH("short"), "short");
  assert.equal(wzHorizonToKairoH("short_mid"), "short");
  assert.equal(wzHorizonToKairoH("mid"), "mid");
  assert.equal(wzHorizonToKairoH("long"), "long");
  assert.equal(wzHorizonToKairoH(null), null);
});

// ---------- 辅助：让 test 函数名保持一致 ----------

function parseWzDecisionLlemOutputFallbackGuard(scene: string, fn: () => ReturnType<typeof parseWzDecisionLlmOutput>) {
  return fn();
}
