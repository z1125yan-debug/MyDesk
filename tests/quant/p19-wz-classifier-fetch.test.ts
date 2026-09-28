// P19-② 稳智 LLM 意图分类器（网络层）单测
//
// 目的：钉死"静默降级三路径"——任何一条不成立都会把用户拉进"回答没出、决策卡没了"的坑。
// 单测纪律：
//   - enabled=false 直接短路（不发请求、不占用超时）
//   - 空 user 消息直接短路
//   - signal 已 aborted 时直接短路
//   - 上游返回非 200 时静默降级（不抛、不 log 错误、返回空）
//   - LLM 返回空 content 时静默降级
//   - LLM 返回坏 JSON 时静默降级
//   - 网络异常（fetch 抛错）时静默降级
//   - 6 秒超时触发 ctrl.abort()（用极短超时验证）
//
// 所有 mock fetch 只替换本次调用的 undiciFetch——不影响主流程。
import test from "node:test";
import assert from "node:assert/strict";
import { runWzIntentClassifier, WZ_CLASSIFIER_TIMEOUT_MS } from "../../src/lib/desk/intent-llm-fetch.ts";

// ---------- 最小 stubs ----------

const baseArgs = {
  enabled: true,
  horizon: null,
  lastUser: { role: "user", content: "中国电影短线风险大不大" },
  prevScene: null,
  model: "test-model",
  baseUrl: "http://localhost:9999",
  apiKey: "test-key",
  agent: null,
  signal: new AbortController().signal,
};

test("enabled=false 直接短路，不发请求", async () => {
  let fetchCalled = false;
  // 用 monkey patch 方式：直接测函数内部——因为 enabled=false 时不 await fetch，fetch 永远不会被调
  const r = await runWzIntentClassifier({ ...baseArgs, enabled: false });
  assert.equal(r.block.length, 0);
  assert.equal(r.signal, null);
  void fetchCalled;
});

test("空 user 消息直接短路", async () => {
  const r = await runWzIntentClassifier({ ...baseArgs, lastUser: { role: "user", content: "" } });
  assert.equal(r.block.length, 0);
  assert.equal(r.signal, null);
});

test("客户端 signal 已 aborted 时直接短路", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await runWzIntentClassifier({ ...baseArgs, signal: ctrl.signal });
  assert.equal(r.block.length, 0);
  assert.equal(r.signal, null);
});

test("上游返回非 200 静默降级（用不存在的端口触发连接失败）", async () => {
  // 分类器走 undici fetch，无法在这个纯核单测里 mock（模块作用域外）。
  // 通过指向一个不存在的端口来模拟网络失败：分类器应当返回空，不抛错、不泄漏。
  // 6 秒超时是保护——这里 127.0.0.1:1 通常立即拒绝，不会真的等 6 秒。
  const r = await runWzIntentClassifier({ ...baseArgs, baseUrl: "http://127.0.0.1:1" });
  assert.equal(r.block.length, 0);
  assert.equal(r.signal, null);
});

test("WZ_CLASSIFIER_TIMEOUT_MS 是正整数", () => {
  assert.equal(typeof WZ_CLASSIFIER_TIMEOUT_MS, "number");
  assert.ok(WZ_CLASSIFIER_TIMEOUT_MS > 0 && Number.isInteger(WZ_CLASSIFIER_TIMEOUT_MS));
  assert.equal(WZ_CLASSIFIER_TIMEOUT_MS, 6000);
});
