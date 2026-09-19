// P6-A 混合取K线层的口径测试（纯内核，不 fetch、不碰库）。
//
// 挡的 bug：fetchBarsHybrid 修复前对「两条通道都失败」和「这只票真的没有K线」返回同一个空数组，
// 下游 `if (!bars.length) continue` 之后，一次限流就会在漏斗里伪装成「这只不符合条件」。
// 这里断言的是分类本身：三种结果互不合并、失败优先于空、兜底要留降级痕迹。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBarOutcome, outcomeWarning, summarizeOutcomes, type BarOutcome,
} from "../../src/lib/quant/data/hybrid-core.ts";

function oc(o: Partial<BarOutcome> & { symbol: string }): BarOutcome {
  return { kind: "value", count: 120, channel: "tdx", degraded: false, reason: "", ...o };
}

test("eltdx 直连成功 = value，且不算降级", () => {
  const r = classifyBarOutcome({ symbol: "600000.SH", channel: "tdx", ok: true, count: 240 });
  assert.equal(r.kind, "value");
  assert.equal(r.degraded, false);
  assert.equal(r.count, 240);
});

test("走腾讯兜底拿到数据 = value 但必须标降级痕迹", () => {
  const r = classifyBarOutcome({ symbol: "600000.SH", channel: "tencent", ok: true, count: 30 });
  assert.equal(r.kind, "value");
  assert.equal(r.degraded, true);
  assert.equal(r.channel, "tencent");
});

test("通道成功但 0 根 = no_data，不是取数失败", () => {
  const r = classifyBarOutcome({ symbol: "688981.SH", channel: "tdx", ok: true, count: 0 });
  assert.equal(r.kind, "no_data");
  assert.match(r.reason, /不是 0 根可用数据/);
});

test("请求失败优先于「空」：抛错时即使 count 是 0 也只能判 request_failed", () => {
  const r = classifyBarOutcome({ symbol: "600000.SH", channel: null, ok: false, count: 0 });
  assert.equal(r.kind, "request_failed");
  assert.equal(r.degraded, true);
  assert.match(r.reason, /不按 0 处理/);
  // 失败原文必须能贴出来，不能只剩「异常」
  const withErr = classifyBarOutcome({ symbol: "600000.SH", channel: "tencent", ok: false, count: 0, error: "ETIMEDOUT 2500ms" });
  assert.equal(withErr.reason, "ETIMEDOUT 2500ms");
});

test("失败与无数据分别计数，互不并入", () => {
  const c = summarizeOutcomes([
    oc({ symbol: "A" }),
    oc({ symbol: "B", kind: "request_failed", count: 0, channel: null, degraded: true }),
    oc({ symbol: "C", kind: "no_data", count: 0, degraded: true, channel: "tencent" }),
    oc({ symbol: "D", channel: "tencent", degraded: true }),
  ]);
  assert.deepEqual(c, { value: 2, no_data: 1, request_failed: 1, tdx: 1, tencent: 2 });
});

test("全部走 eltdx 时不追加噪音", () => {
  assert.equal(outcomeWarning([oc({ symbol: "A" }), oc({ symbol: "B" })]), "");
});

test("警告文案把「取数失败」和「没有数据」分开写，不把失败说成不符合条件", () => {
  const w = outcomeWarning([
    oc({ symbol: "A", kind: "request_failed", count: 0, channel: null, degraded: true }),
    oc({ symbol: "B", kind: "request_failed", count: 0, channel: null, degraded: true }),
    oc({ symbol: "C", kind: "no_data", count: 0, channel: "tencent", degraded: true }),
  ]);
  assert.match(w, /取数失败 2 只/);
  assert.match(w, /无K线返回 1 只/);
  assert.match(w, /不合并统计/);
  assert.ok(!/无数据 3 只/.test(w), "失败不得并入「无数据」总数");
});

test("兜底通道单独成句：说明结果是降级口径", () => {
  const w = outcomeWarning([oc({ symbol: "A", channel: "tencent", degraded: true })]);
  assert.match(w, /腾讯兜底 1 只（主通道不可用，已降级）/);
});
