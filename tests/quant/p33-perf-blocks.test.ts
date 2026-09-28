// P33 稳智对齐 P3 #16：调试视图 3 个 perf-block 钉测
//
// 覆盖：
//   1. buildPerfBlocks 后端耗时拆解（从 steps 的 ms 算）
//   2. buildPerfBlocks LLM 详情（从 done.transport 算）
//   3. buildPerfBlocks SSE 事件统计（从 steps 的 status 算）
//   4. 空 steps 时 perf-block 全为 null/0
//   5. DebugView 包含 perfBlocks 字段

import test from "node:test";
import assert from "node:assert/strict";
import { buildDebugView } from "../../src/lib/desk/debug-core.ts";

// ─── buildPerfBlocks 后端耗时拆解 ──────────────────────────────────────────

test("后端耗时拆解：从 steps 的 ms 算 firstTokenMs", () => {
  const view = buildDebugView({
    steps: [
      { step: 1, label: "A", status: "ok", ms: 120 },
      { step: 2, label: "B", status: "ok", ms: 45 },
    ],
    done: { modelMs: 500, transport: "stream" },
  });
  assert.equal(view.perfBlocks.backendTiming.firstTokenMs, 45); // min(120, 45)
  assert.equal(view.perfBlocks.backendTiming.streamDoneMs, 500);
});

test("后端耗时拆解：无 steps 时 firstTokenMs 为 null", () => {
  const view = buildDebugView({
    steps: [],
    done: { modelMs: 500, transport: "stream" },
  });
  assert.equal(view.perfBlocks.backendTiming.firstTokenMs, null);
  assert.equal(view.perfBlocks.backendTiming.streamDoneMs, 500);
});

test("后端耗时拆解：无 done 时 streamDoneMs 为 null", () => {
  const view = buildDebugView({
    steps: [{ step: 1, label: "A", status: "ok", ms: 100 }],
    done: null,
  });
  assert.equal(view.perfBlocks.backendTiming.firstTokenMs, 100);
  assert.equal(view.perfBlocks.backendTiming.streamDoneMs, null);
});

// ─── buildPerfBlocks LLM 详情 ─────────────────────────────────────────────

test("LLM 详情：从 done.transport 算 variant", () => {
  const view = buildDebugView({
    steps: [],
    done: { modelMs: 500, transport: "stream" },
  });
  assert.equal(view.perfBlocks.llmDetail.variant, "stream");
  assert.equal(view.perfBlocks.llmDetail.mode, null); // 前端拿不到 mode
});

test("LLM 详情：无 done 时 variant 为 null", () => {
  const view = buildDebugView({
    steps: [],
    done: null,
  });
  assert.equal(view.perfBlocks.llmDetail.variant, null);
  assert.equal(view.perfBlocks.llmDetail.mode, null);
});

// ─── buildPerfBlocks SSE 事件统计 ─────────────────────────────────────────

test("SSE 事件统计：从 steps 的 status 算", () => {
  const view = buildDebugView({
    steps: [
      { step: 1, label: "A", status: "ok", ms: 100 },
      { step: 2, label: "B", status: "error", ms: 50 },
      { step: 3, label: "C", status: "missing", ms: 30 },
    ],
    done: { modelMs: 500, transport: "stream" },
  });
  assert.equal(view.perfBlocks.sseEventCount.step, 3);
  assert.equal(view.perfBlocks.sseEventCount.error, 1); // 1 个 error
  assert.equal(view.perfBlocks.sseEventCount.total, 5); // 3 steps + 1 done + 1 error
});

test("SSE 事件统计：无 steps 无 done 时全为 0", () => {
  const view = buildDebugView({
    steps: [],
    done: null,
  });
  assert.equal(view.perfBlocks.sseEventCount.step, 0);
  assert.equal(view.perfBlocks.sseEventCount.error, 0);
  assert.equal(view.perfBlocks.sseEventCount.total, 0);
});

// ─── DebugView 包含 perfBlocks ────────────────────────────────────────────

test("DebugView 包含 perfBlocks 字段", () => {
  const view = buildDebugView({
    steps: [{ step: 1, label: "A", status: "ok" }],
    done: null,
  });
  assert.ok(view.perfBlocks, "perfBlocks 字段存在");
  assert.ok(view.perfBlocks.backendTiming, "backendTiming 存在");
  assert.ok(view.perfBlocks.llmDetail, "llmDetail 存在");
  assert.ok(view.perfBlocks.sseEventCount, "sseEventCount 存在");
});
