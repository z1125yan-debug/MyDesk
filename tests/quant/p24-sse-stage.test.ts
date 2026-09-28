// P24 SSE stage 事件钉测（稳智对齐 P1 #4）。
//
// 稳智逆向扒出的 SSE 事件流里，stage 事件是宏观阶段：researching / answer_streaming / finished /
// degraded / incomplete / failed。本仓库原来没有 stage 事件，6 阶段进度条是前端从 steps + intent
// 语义反推的。P24 加了 stage 事件：后端在关键节点 emit，前端收到后用来更新顶部进度条。
//
// 测试钉四件事：
//   1. STREAM_EVENT_TYPES 包含 stage
//   2. decodeStreamEvent 能解码 stage 事件
//   3. decodeStreamEvent 对无效 stage 值返回 null
//   4. applyEvent 收到 stage 事件后更新消息的 stage 字段
import test from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_EVENT_TYPES,
  decodeStreamEvent,
  encodeStreamEvent,
  asStreamEvent,
} from "../../src/lib/desk/chat-stream-core.ts";
import { applyEvent, type ChatMessage } from "../../src/lib/desk/chat-core.ts";

test("STREAM_EVENT_TYPES 包含 stage（P24 稳智对齐）", () => {
  assert.ok(STREAM_EVENT_TYPES.includes("stage"), "STREAM_EVENT_TYPES 应包含 stage");
});

test("decodeStreamEvent 能解码合法的 stage 事件", () => {
  const raw = '{"type":"stage","data":{"stage":"researching"}}';
  const ev = decodeStreamEvent(raw);
  assert.ok(ev);
  assert.equal(ev.type, "stage");
  assert.equal((ev as any).data.stage, "researching");
});

test("decodeStreamEvent 能解码所有合法的 stage 值", () => {
  const validStages = ["researching", "answer_streaming", "finished", "degraded", "incomplete", "failed"];
  for (const stage of validStages) {
    const raw = JSON.stringify({ type: "stage", data: { stage } });
    const ev = decodeStreamEvent(raw);
    assert.ok(ev, `stage="${stage}" 应能解码`);
    assert.equal(ev.type, "stage");
    assert.equal((ev as any).data.stage, stage);
  }
});

test("decodeStreamEvent 对无效的 stage 值返回 null", () => {
  const raw = '{"type":"stage","data":{"stage":"invalid_stage"}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("decodeStreamEvent 对 stage 字段非字符串返回 null", () => {
  const raw = '{"type":"stage","data":{"stage":123}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("decodeStreamEvent 对 stage 字段缺失返回 null", () => {
  const raw = '{"type":"stage","data":{}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("encodeStreamEvent + decodeStreamEvent 往返一致（stage 事件）", () => {
  const ev = { type: "stage", data: { stage: "researching" as const } };
  const encoded = encodeStreamEvent(ev as any);
  assert.ok(encoded.startsWith("data: "));
  // decodeStreamEvent 期望纯 JSON（不带 data: 前缀），slice(6) 去掉 "data: "
  const decoded = decodeStreamEvent(encoded.slice(6));
  assert.deepEqual(decoded, { type: "stage", data: { stage: "researching" } });
});

test("asStreamEvent 对带 seq 的 stage 事件保留 seq", () => {
  const obj = { type: "stage", data: { stage: "finished" }, seq: 42 };
  const ev = asStreamEvent(obj);
  assert.ok(ev);
  assert.equal(ev.type, "stage");
  assert.equal((ev as any).seq, 42);
});

test("applyEvent 收到 stage 事件后更新消息的 stage 字段", () => {
  const msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  const updated = applyEvent(msg, { type: "stage", data: { stage: "researching" } });
  assert.equal(updated.stage, "researching");
  assert.equal(updated.content, msg.content, "stage 事件不应改变 content");
});

test("applyEvent 收到 stage 事件后不改变其他字段", () => {
  const msg: ChatMessage = {
    id: "1", role: "assistant", content: "已有内容", ts: Date.now(),
    streaming: true, steps: [{ step: 1, label: "取行情", status: "ok" }],
    warning: "警告信息",
  };
  const updated = applyEvent(msg, { type: "stage", data: { stage: "answer_streaming" } });
  assert.equal(updated.stage, "answer_streaming");
  assert.equal(updated.content, "已有内容");
  assert.equal(updated.warning, "警告信息");
  assert.equal(updated.steps?.length, 1);
});

test("applyEvent 连续收到多个 stage 事件，后到的覆盖前到的", () => {
  let msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  msg = applyEvent(msg, { type: "stage", data: { stage: "researching" } });
  assert.equal(msg.stage, "researching");
  msg = applyEvent(msg, { type: "stage", data: { stage: "answer_streaming" } });
  assert.equal(msg.stage, "answer_streaming");
  msg = applyEvent(msg, { type: "stage", data: { stage: "finished" } });
  assert.equal(msg.stage, "finished");
});

test("applyEvent 收到 stage 事件后 streaming 字段不变", () => {
  let msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  msg = applyEvent(msg, { type: "stage", data: { stage: "researching" } });
  assert.equal(msg.streaming, true, "researching 时仍 streaming");
  msg = applyEvent(msg, { type: "stage", data: { stage: "answer_streaming" } });
  assert.equal(msg.streaming, true, "answer_streaming 时仍 streaming");
  // stage=finished 也不改变 streaming（streaming 由 done 事件收口）
  msg = applyEvent(msg, { type: "stage", data: { stage: "finished" } });
  assert.equal(msg.streaming, true, "finished 也不改变 streaming（由 done 收口）");
});

test("applyEvent 收到 stage=failed 后 streaming 仍为 true（由 error 事件收口）", () => {
  let msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  msg = applyEvent(msg, { type: "stage", data: { stage: "failed" } });
  assert.equal(msg.stage, "failed");
  assert.equal(msg.streaming, true, "failed 也不改变 streaming（由 error 收口）");
});

test("encodeStreamEvent 对 stage 事件带 seq 时保留 seq", () => {
  const ev = { type: "stage", data: { stage: "finished" as const }, seq: 100 };
  const encoded = encodeStreamEvent(ev as any);
  assert.ok(encoded.includes('"seq":100'));
});
