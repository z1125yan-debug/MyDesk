// P30 稳智对齐 P2 #13：数据源面板（已核验来源，按类型分组）钉测
//
// 覆盖：
//   1. classifyStep 分类正确（news/quote/kline/fund/other 五类）
//   2. groupStepsBySource 分组正确（只收 ok/missing/stale，跳过 running/error）
//   3. 空 steps 返回空分组
//   4. 全 running/error 时所有分类为空

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStep,
  groupStepsBySource,
  type SourceGroupKey,
} from "../../src/lib/desk/source-groups-core.ts";
import type { StepInfo } from "../../src/lib/desk/chat-core.ts";

// ─── classifyStep ──────────────────────────────────────────────────────────

test("news 类工具归类正确", () => {
  assert.equal(classifyStep("stock_news"), "news");
  assert.equal(classifyStep("market_news"), "news");
});

test("quote 类工具归类正确", () => {
  assert.equal(classifyStep("stock_snapshot"), "quote");
  assert.equal(classifyStep("tdx_quotes"), "quote");
  assert.equal(classifyStep("stock_depth"), "quote");
  assert.equal(classifyStep("stock_trades"), "quote");
  assert.equal(classifyStep("tdx_market_overview"), "quote");
});

test("kline 类工具归类正确", () => {
  assert.equal(classifyStep("stock_kline_summary"), "kline");
  assert.equal(classifyStep("tdx_kline"), "kline");
});

test("fund 类工具归类正确", () => {
  assert.equal(classifyStep("stock_fund_flow"), "fund");
  assert.equal(classifyStep("market_sentiment"), "fund");
  assert.equal(classifyStep("historical_probability"), "fund");
});

test("其他工具归 other", () => {
  assert.equal(classifyStep("sector_rank"), "other");
  assert.equal(classifyStep("candidate_pool"), "other");
  assert.equal(classifyStep("factor_screener"), "other");
  assert.equal(classifyStep("run_backtest"), "other");
  assert.equal(classifyStep("watchlist_overview"), "other");
});

test("undefined 或空工具归 other", () => {
  assert.equal(classifyStep(undefined), "other");
});

test("未知工具归 other", () => {
  assert.equal(classifyStep("unknown_tool_xyz"), "other");
});

// ─── groupStepsBySource ────────────────────────────────────────────────────

test("空 steps 返回空分组", () => {
  const result = groupStepsBySource(undefined);
  assert.equal(result.news.length, 0);
  assert.equal(result.quote.length, 0);
  assert.equal(result.kline.length, 0);
  assert.equal(result.fund.length, 0);
  assert.equal(result.other.length, 0);
});

test("空数组返回空分组", () => {
  const result = groupStepsBySource([]);
  const total = (Object.keys(result) as SourceGroupKey[]).reduce((n, k) => n + result[k].length, 0);
  assert.equal(total, 0);
});

test("只收 ok/missing/stale 状态，跳过 running/error", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "A", status: "ok", tool: "stock_news" },
    { step: 2, label: "B", status: "missing", tool: "market_news" },
    { step: 3, label: "C", status: "stale", tool: "stock_snapshot" },
    { step: 4, label: "D", status: "running", tool: "tdx_quotes" }, // 跳过
    { step: 5, label: "E", status: "error", tool: "stock_fund_flow" }, // 跳过
  ];
  const result = groupStepsBySource(steps);
  assert.equal(result.news.length, 2); // A + B
  assert.equal(result.quote.length, 1); // C
  assert.equal(result.fund.length, 0); // E 被跳过
  const total = (Object.keys(result) as SourceGroupKey[]).reduce((n, k) => n + result[k].length, 0);
  assert.equal(total, 3); // 3 项保留
});

test("多工具跨分类正确分组", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "A", status: "ok", tool: "stock_news" },
    { step: 2, label: "B", status: "ok", tool: "stock_snapshot" },
    { step: 3, label: "C", status: "ok", tool: "stock_kline_summary" },
    { step: 4, label: "D", status: "ok", tool: "stock_fund_flow" },
    { step: 5, label: "E", status: "ok", tool: "run_backtest" },
  ];
  const result = groupStepsBySource(steps);
  assert.equal(result.news.length, 1);
  assert.equal(result.quote.length, 1);
  assert.equal(result.kline.length, 1);
  assert.equal(result.fund.length, 1);
  assert.equal(result.other.length, 1);
});

test("无 tool 字段的步骤归 other", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "无工具", status: "ok" },
    { step: 2, label: "有工具", status: "ok", tool: "stock_news" },
  ];
  const result = groupStepsBySource(steps);
  assert.equal(result.other.length, 1); // 步骤 1 无 tool
  assert.equal(result.news.length, 1);
});

test("全 running 时所有分类为空", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "A", status: "running", tool: "stock_news" },
    { step: 2, label: "B", status: "running", tool: "stock_snapshot" },
  ];
  const result = groupStepsBySource(steps);
  const total = (Object.keys(result) as SourceGroupKey[]).reduce((n, k) => n + result[k].length, 0);
  assert.equal(total, 0);
});

test("保留原步骤字段（label/ms/detail 等）", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取个股新闻", status: "ok", tool: "stock_news", ms: 120, detail: "取到 5 条" },
  ];
  const result = groupStepsBySource(steps);
  assert.equal(result.news[0].step, 1);
  assert.equal(result.news[0].label, "取个股新闻");
  assert.equal(result.news[0].ms, 120);
  assert.equal(result.news[0].detail, "取到 5 条");
});
