// P29 稳智对齐：parentStepId 嵌套步骤 —— 子 Agent 步骤挂父步骤
//
// 覆盖：
//   - StreamStep 加 parentStepId 字段
//   - asStreamEvent 解析 parentStepId（只收 number，坏值丢弃）
//   - applyEvent 透传 parentStepId（step upsert 时写入）
//   - 层次化步骤分组函数（新增：buildStepTree，把扁平 steps 转成嵌套树）
//   - SSE 编码往返不丢 parentStepId
//   - 老客户端兼容（不带 parentStepId 就当扁平处理）

import test from "node:test";
import assert from "node:assert/strict";
import {
  asStreamEvent,
  decodeStreamEvent,
  encodeStreamEvent,
  STREAM_EVENT_TYPES,
  type StreamStep,
} from "../../src/lib/desk/chat-stream-core.ts";
import {
  applyEvent,
  buildStepTree,
  type ChatMessage,
} from "../../src/lib/desk/chat-core.ts";

// 辅助：造一个空的 assistant 消息
function newMsg(): ChatMessage {
  return { id: "m1", role: "assistant", content: "", streaming: true, ts: 0 };
}

// ─── 类型定义 ──────────────────────────────────────────────────────────────

test("StreamStep 支持可选 parentStepId（number 类型）", () => {
  const s: StreamStep = {
    step: 2,
    label: "fetch_news",
    status: "ok",
    parentStepId: 1, // 挂在 step 1 下面
  };
  assert.equal(s.parentStepId, 1);
});

test("不带 parentStepId 的 step 是顶层步骤", () => {
  const s: StreamStep = { step: 1, label: "研究", status: "ok" };
  assert.equal(s.parentStepId, undefined);
});

// ─── asStreamEvent 解析 ────────────────────────────────────────────────────

test("合法 number parentStepId 被解析", () => {
  const event = asStreamEvent({
    type: "step",
    data: { step: 2, label: "fetch_news", status: "ok", parentStepId: 1 },
  });
  assert.ok(event);
  assert.equal(event.type, "step");
  if (event.type === "step") {
    assert.equal(event.data.parentStepId, 1);
  }
});

test("坏值（字符串）parentStepId 被丢弃，帧仍然合法", () => {
  const event = asStreamEvent({
    type: "step",
    data: { step: 2, label: "fetch_news", status: "ok", parentStepId: "1" },
  });
  assert.ok(event);
  assert.equal(event.type, "step");
  if (event.type === "step") {
    assert.equal(event.data.parentStepId, undefined);
  }
});

test("坏值（非数值字符串）parentStepId 被丢弃", () => {
  const event = asStreamEvent({
    type: "step",
    data: { step: 2, label: "fetch_news", status: "ok", parentStepId: "not-a-number" },
  });
  assert.ok(event);
  assert.equal(event.type, "step");
  if (event.type === "step") {
    assert.equal(event.data.parentStepId, undefined);
  }
});

// ─── applyEvent 透传 ───────────────────────────────────────────────────────

test("step 事件带 parentStepId，upsert 后 message.steps 里保留", () => {
  let m = newMsg();
  m = applyEvent(m, { type: "step", data: { step: 1, label: "研究", status: "running" } });
  m = applyEvent(m, { type: "step", data: { step: 2, label: "fetch_news", status: "ok", parentStepId: 1 } });

  assert.equal(m.steps?.[0].parentStepId, undefined);
  assert.equal(m.steps?.[1].parentStepId, 1);
});

test("后到的同 step 事件覆盖前一个（parentStepId 可更新）", () => {
  let m = newMsg();
  m = applyEvent(m, { type: "step", data: { step: 2, label: "fetch_news", status: "running" } });
  // 后到的更新事件补上 parentStepId
  m = applyEvent(m, { type: "step", data: { step: 2, label: "fetch_news", status: "ok", parentStepId: 1 } });

  assert.equal(m.steps?.[0].parentStepId, 1);
});

// ─── buildStepTree 层次化分组 ─────────────────────────────────────────────

test("扁平 steps 转成嵌套树", () => {
  const steps: ChatMessage["steps"] = [
    { step: 1, label: "研究", status: "ok" },
    { step: 2, label: "fetch_news", status: "ok", parentStepId: 1 },
    { step: 3, label: "fetch_quote", status: "ok", parentStepId: 1 },
    { step: 4, label: "回答", status: "ok" },
  ];
  const tree = buildStepTree(steps);
  assert.equal(tree.length, 2); // 2 个顶层步骤：研究 + 回答
  assert.equal(tree[0].step, 1);
  assert.equal(tree[0].children?.length, 2);
  assert.equal(tree[0].children![0].step, 2);
  assert.equal(tree[0].children![1].step, 3);
  assert.equal(tree[1].children, undefined);
});

test("无 parentStepId 时返回扁平树（所有步骤都是顶层）", () => {
  const steps: ChatMessage["steps"] = [
    { step: 1, label: "意图", status: "ok" },
    { step: 2, label: "取数", status: "ok" },
    { step: 3, label: "回答", status: "ok" },
  ];
  const tree = buildStepTree(steps);
  assert.equal(tree.length, 3);
  assert.ok(tree.every((s) => s.children === undefined));
});

test("孤儿步骤（parentStepId 指向不存在的父步骤）作为顶层处理", () => {
  const steps: ChatMessage["steps"] = [
    { step: 2, label: "子步骤", status: "ok", parentStepId: 999 }, // 父步骤 999 不存在
  ];
  const tree = buildStepTree(steps);
  // 孤儿步骤不能丢，作为顶层保留
  assert.equal(tree.length, 1);
  assert.equal(tree[0].step, 2);
});

test("支持多层嵌套（孙步骤）", () => {
  const steps: ChatMessage["steps"] = [
    { step: 1, label: "研究", status: "ok" },
    { step: 2, label: "取数", status: "ok", parentStepId: 1 },
    { step: 3, label: "fetch_news", status: "ok", parentStepId: 2 }, // 孙步骤
  ];
  const tree = buildStepTree(steps);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children?.[0].step, 2);
  assert.equal(tree[0].children?.[0].children?.[0].step, 3);
});

test("children 按 step 号排序", () => {
  const steps: ChatMessage["steps"] = [
    { step: 1, label: "父", status: "ok" },
    { step: 3, label: "子3", status: "ok", parentStepId: 1 },
    { step: 2, label: "子2", status: "ok", parentStepId: 1 },
  ];
  const tree = buildStepTree(steps);
  assert.deepEqual(tree[0].children?.map((c) => c.step), [2, 3]);
});

// ─── SSE 编码往返 ─────────────────────────────────────────────────────────

test("step 事件带 parentStepId，encode + decode 往返一致", () => {
  const step: StreamStep = { step: 2, label: "fetch_news", status: "ok", parentStepId: 1 };
  // encodeStreamEvent 输出 "data: <json>\n\n"，decodeStreamEvent 接纯 JSON 字符串
  const encoded = encodeStreamEvent({ type: "step", data: step });
  const jsonOnly = encoded.startsWith("data: ") ? encoded.slice(6).trim() : encoded;
  const decoded = decodeStreamEvent(jsonOnly);
  assert.ok(decoded);
  assert.equal(decoded.type, "step");
  if (decoded.type === "step") {
    assert.equal(decoded.data.parentStepId, 1);
  }
});

// ─── 兼容性 ───────────────────────────────────────────────────────────────

test("STREAM_EVENT_TYPES 仍然是 8 类（parentStepId 是字段不是新事件）", () => {
  assert.equal(STREAM_EVENT_TYPES.length, 8);
  assert.ok(STREAM_EVENT_TYPES.includes("step" as never));
});

test("老客户端（不带 parentStepId）解码不报错", () => {
  const event = asStreamEvent({
    type: "step",
    data: { step: 1, label: "意图", status: "ok" },
  });
  assert.ok(event);
  assert.equal(event.type, "step");
});
