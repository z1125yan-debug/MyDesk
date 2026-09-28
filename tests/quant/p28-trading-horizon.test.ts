// P28 交易周期 3→5 档钉测（稳智对齐 P2 #11）。
//
// 稳智逆向扒出的交易周期是 5 档：ultra_short / short_term / short_mid_term / mid_term / long_term。
// 本仓库原来是 3 档（short/mid/long），P28 扩到 5 档（ultrashort/short/shortmid/mid/long）。
// 稳智还有 resolveTradingHorizonForInput 自动检测函数，P28 也加了同一逻辑。
//
// 测试钉三件事：
//   1. CHAT_HORIZONS 有 5 个合法值
//   2. HORIZON_NOTES 覆盖所有 5 个 ChatHorizon
//   3. resolveTradingHorizonForInput 能正确匹配各种关键词
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_HORIZONS,
  HORIZON_NOTES,
  asHorizon,
  chatHorizonLabel,
  resolveTradingHorizonForInput,
  type ChatHorizon,
} from "../../src/lib/desk/modes.ts";

test("CHAT_HORIZONS 有 5 个合法值（P28 稳智对齐）", () => {
  assert.equal(CHAT_HORIZONS.length, 5);
  const keys = CHAT_HORIZONS.map((h) => h.key);
  assert.deepEqual(keys, ["ultrashort", "short", "shortmid", "mid", "long"]);
});

test("CHAT_HORIZONS 每个值都有 label 和 desc", () => {
  for (const h of CHAT_HORIZONS) {
    assert.ok(h.label.length > 0, `${h.key} 缺 label`);
    assert.ok(h.desc.length > 0, `${h.key} 缺 desc`);
  }
});

test("HORIZON_NOTES 覆盖所有 5 个 ChatHorizon", () => {
  const keys = Object.keys(HORIZON_NOTES);
  assert.deepEqual(keys.sort(), ["long", "mid", "short", "shortmid", "ultrashort"]);
  for (const k of keys) {
    assert.ok(HORIZON_NOTES[k as ChatHorizon].length > 0, `${k} 文案为空`);
  }
});

test("asHorizon 对合法值返回原样", () => {
  for (const h of CHAT_HORIZONS) {
    assert.equal(asHorizon(h.key), h.key);
  }
});

test("asHorizon 对非法值返回 null", () => {
  assert.equal(asHorizon("invalid"), null);
  assert.equal(asHorizon(""), null);
  assert.equal(asHorizon(null), null);
  assert.equal(asHorizon(undefined), null);
  assert.equal(asHorizon(123), null);
});

test("chatHorizonLabel 对合法值返回 label", () => {
  assert.equal(chatHorizonLabel("ultrashort"), "超短");
  assert.equal(chatHorizonLabel("short"), "短线");
  assert.equal(chatHorizonLabel("shortmid"), "短中");
  assert.equal(chatHorizonLabel("mid"), "中线");
  assert.equal(chatHorizonLabel("long"), "长线");
});

test("chatHorizonLabel 对非法值返回'未选'", () => {
  assert.equal(chatHorizonLabel("invalid"), "未选");
  assert.equal(chatHorizonLabel(""), "未选");
  assert.equal(chatHorizonLabel(null), "未选");
  assert.equal(chatHorizonLabel(undefined), "未选");
});

test("resolveTradingHorizonForInput 匹配'超短'关键词", () => {
  assert.equal(resolveTradingHorizonForInput("超短线"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("日内交易"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("隔夜单"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("打板"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("T+0"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("1天"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("一天"), "ultrashort");
});

test("resolveTradingHorizonForInput 匹配'短线'关键词", () => {
  assert.equal(resolveTradingHorizonForInput("短线"), "short");
  assert.equal(resolveTradingHorizonForInput("1到3天"), "short");
  assert.equal(resolveTradingHorizonForInput("2天"), "short");
  assert.equal(resolveTradingHorizonForInput("三天"), "short");
  assert.equal(resolveTradingHorizonForInput("3天"), "short");
  assert.equal(resolveTradingHorizonForInput("两三天"), "short");
});

test("resolveTradingHorizonForInput 匹配'短中'关键词", () => {
  assert.equal(resolveTradingHorizonForInput("短中"), "shortmid");
  assert.equal(resolveTradingHorizonForInput("3到5天"), "shortmid");
  assert.equal(resolveTradingHorizonForInput("四天"), "shortmid");
  assert.equal(resolveTradingHorizonForInput("五天"), "shortmid");
  assert.equal(resolveTradingHorizonForInput("5天"), "shortmid");
  assert.equal(resolveTradingHorizonForInput("三四天"), "shortmid");
});

test("resolveTradingHorizonForInput 匹配'中线'关键词", () => {
  assert.equal(resolveTradingHorizonForInput("中线"), "mid");
  assert.equal(resolveTradingHorizonForInput("波段"), "mid");
  assert.equal(resolveTradingHorizonForInput("1到4周"), "mid");
  assert.equal(resolveTradingHorizonForInput("2周"), "mid");
  assert.equal(resolveTradingHorizonForInput("三周"), "mid");
  assert.equal(resolveTradingHorizonForInput("4周"), "mid");
  assert.equal(resolveTradingHorizonForInput("一个月"), "mid");
  assert.equal(resolveTradingHorizonForInput("20天"), "mid");
});

test("resolveTradingHorizonForInput 匹配'长线'关键词", () => {
  assert.equal(resolveTradingHorizonForInput("长线"), "long");
  assert.equal(resolveTradingHorizonForInput("长期"), "long");
  assert.equal(resolveTradingHorizonForInput("中长期"), "long");
  assert.equal(resolveTradingHorizonForInput("1个月"), "long");
  assert.equal(resolveTradingHorizonForInput("半年"), "long");
  assert.equal(resolveTradingHorizonForInput("一年"), "long");
  assert.equal(resolveTradingHorizonForInput("长期持有"), "long");
});

test("resolveTradingHorizonForInput 对无关键词的输入返回 null", () => {
  assert.equal(resolveTradingHorizonForInput(""), null);
  assert.equal(resolveTradingHorizonForInput("你好"), null);
  assert.equal(resolveTradingHorizonForInput("分析茅台"), null);
  assert.equal(resolveTradingHorizonForInput("今天行情怎么样"), null);
});

test("resolveTradingHorizonForInput 对大小写不敏感", () => {
  assert.equal(resolveTradingHorizonForInput("T+0"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("t+0"), "ultrashort");
  assert.equal(resolveTradingHorizonForInput("T+0 策略"), "ultrashort");
});
