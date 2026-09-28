// P31 稳智对齐 P2 #14：active_task_id 状态 + 任务过期时间（TTL 15 分钟）钉测
//
// 覆盖：
//   1. TASK_TTL_MS 常量（15 分钟）
//   2. isRunRefExpired 过期判定（createdAt 超过 TTL 返回 true，未超过返回 false）
//   3. isRunRefExpired 向后兼容（createdAt 缺失返回 false）
//   4. runRef 类型加 createdAt 字段
//   5. 过期时清掉 runRef + 结算 running 步骤

import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_TTL_MS,
  isRunRefExpired,
} from "../../src/lib/desk/task-ttl-core.ts";
import {
  settleRunningSteps,
  type ChatMessage,
} from "../../src/lib/desk/chat-core.ts";

// ─── 常量 ──────────────────────────────────────────────────────────────────

test("TASK_TTL_MS = 15 分钟", () => {
  assert.equal(TASK_TTL_MS, 15 * 60 * 1000);
  assert.equal(TASK_TTL_MS, 900000);
});

// ─── isRunRefExpired 过期判定 ──────────────────────────────────────────────

test("未过期返回 false", () => {
  const createdAt = Date.now() - 10 * 60 * 1000; // 10 分钟前
  assert.equal(isRunRefExpired({ createdAt }), false);
});

test("刚好过期边界返回 true", () => {
  const now = 1000000;
  const createdAt = now - TASK_TTL_MS - 1; // 超过 15 分钟 1ms
  assert.equal(isRunRefExpired({ createdAt }, now), true);
});

test("刚好未过期边界返回 false", () => {
  const now = 1000000;
  const createdAt = now - TASK_TTL_MS + 1; // 未超过 15 分钟
  assert.equal(isRunRefExpired({ createdAt }, now), false);
});

test("已过期返回 true", () => {
  const createdAt = Date.now() - 20 * 60 * 1000; // 20 分钟前
  assert.equal(isRunRefExpired({ createdAt }), true);
});

test("createdAt 缺失返回 false（向后兼容老存档）", () => {
  assert.equal(isRunRefExpired({}), false);
  assert.equal(isRunRefExpired(undefined), false);
  assert.equal(isRunRefExpired({ createdAt: undefined }), false);
});

test("createdAt 为 0 返回 true（0 是有效的时间戳，表示 1970 年，已过很久）", () => {
  const now = Date.now();
  // createdAt=0 表示 Unix 纪元（1970-01-01），距今远超 15 分钟
  assert.equal(isRunRefExpired({ createdAt: 0 }, now), true);
});

// ─── runRef 类型 ───────────────────────────────────────────────────────────

test("ChatMessage.runRef 支持 createdAt 字段", () => {
  const m: ChatMessage = {
    id: "m1",
    role: "assistant",
    content: "",
    ts: 0,
    runRef: { id: "r1", lastSeq: 5, createdAt: Date.now() },
  };
  assert.equal(m.runRef?.id, "r1");
  assert.equal(m.runRef?.lastSeq, 5);
  assert.equal(typeof m.runRef?.createdAt, "number");
});

test("ChatMessage.runRef 不强制 createdAt（向后兼容）", () => {
  const m: ChatMessage = {
    id: "m1",
    role: "assistant",
    content: "",
    ts: 0,
    runRef: { id: "r1", lastSeq: 5 }, // 无 createdAt
  };
  assert.equal(m.runRef?.createdAt, undefined);
});

// ─── 过期时清掉 runRef + 结算 running 步骤 ────────────────────────────────

test("settleRunningSteps 把 running 步骤结算为 error（保留 running 状态→error）", () => {
  const m: ChatMessage = {
    id: "m1",
    role: "assistant",
    content: "",
    ts: 0,
    streaming: true,
    steps: [
      { step: 1, label: "A", status: "ok" },
      { step: 2, label: "B", status: "running" },
    ],
    runRef: { id: "r1", lastSeq: 5, createdAt: Date.now() - 20 * 60 * 1000 },
  };
  // 模拟过期处理：清掉 runRef + 结算 running 步骤
  const next = settleRunningSteps({ ...m, streaming: false, runRef: undefined });
  assert.equal(next.runRef, undefined);
  assert.equal(next.streaming, false);
  // running 步骤被结算为 error（settleRunningSteps 把 running→error，标记为"未完成"）
  assert.equal(next.steps?.[1].status, "error");
});
