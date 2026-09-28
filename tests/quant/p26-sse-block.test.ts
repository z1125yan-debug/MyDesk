// P26 SSE block_started/finished 事件钉测（稳智对齐 P2 #9）。
//
// 稳智逆向扒出的 SSE 事件流里，block_started/finished 事件是结构化块：table/code/quote/markdown。
// 本仓库原来没有 block 事件，Markdown 渲染是纯文本流式（delta 事件逐字追加）。P26 加了 block 事件：
// 后端在遇到 markdown 结构化块时 emit，前端收到后用来渲染成结构化卡片。
//
// 测试钉四件事：
//   1. STREAM_EVENT_TYPES 包含 block_started 和 block_finished
//   2. decodeStreamEvent 能解码合法的 block 事件
//   3. decodeStreamEvent 对无效的 block 值返回 null
//   4. applyEvent 收到 block 事件后更新消息的 blocks 数组
import test from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_EVENT_TYPES,
  decodeStreamEvent,
  encodeStreamEvent,
  asStreamEvent,
} from "../../src/lib/desk/chat-stream-core.ts";
import { applyEvent, type ChatMessage } from "../../src/lib/desk/chat-core.ts";

test("STREAM_EVENT_TYPES 包含 block_started 和 block_finished（P26 稳智对齐）", () => {
  assert.ok(STREAM_EVENT_TYPES.includes("block_started"), "STREAM_EVENT_TYPES 应包含 block_started");
  assert.ok(STREAM_EVENT_TYPES.includes("block_finished"), "STREAM_EVENT_TYPES 应包含 block_finished");
});

test("decodeStreamEvent 能解码合法的 block_started 事件", () => {
  const raw = '{"type":"block_started","data":{"block_id":"block-1","block_type":"table"}}';
  const ev = decodeStreamEvent(raw);
  assert.ok(ev);
  assert.equal(ev.type, "block_started");
  assert.equal((ev as any).data.block_id, "block-1");
  assert.equal((ev as any).data.block_type, "table");
});

test("decodeStreamEvent 能解码所有合法的 block_type 值", () => {
  const validBlockTypes = ["table", "code", "quote", "markdown"];
  for (const blockType of validBlockTypes) {
    const raw = JSON.stringify({ type: "block_started", data: { block_id: "block-1", block_type: blockType } });
    const ev = decodeStreamEvent(raw);
    assert.ok(ev, `block_type="${blockType}" 应能解码`);
    assert.equal(ev.type, "block_started");
    assert.equal((ev as any).data.block_type, blockType);
  }
});

test("decodeStreamEvent 能解码合法的 block_finished 事件", () => {
  const raw = '{"type":"block_finished","data":{"block_id":"block-1"}}';
  const ev = decodeStreamEvent(raw);
  assert.ok(ev);
  assert.equal(ev.type, "block_finished");
  assert.equal((ev as any).data.block_id, "block-1");
});

test("decodeStreamEvent 对无效的 block_type 值返回 null", () => {
  const raw = '{"type":"block_started","data":{"block_id":"block-1","block_type":"invalid_type"}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("decodeStreamEvent 对 block_id 非字符串返回 null", () => {
  const raw = '{"type":"block_started","data":{"block_id":123,"block_type":"table"}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("decodeStreamEvent 对 block_type 缺失返回 null", () => {
  const raw = '{"type":"block_started","data":{"block_id":"block-1"}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("decodeStreamEvent 对 block_finished 缺 block_id 返回 null", () => {
  const raw = '{"type":"block_finished","data":{}}';
  const ev = decodeStreamEvent(raw);
  assert.equal(ev, null);
});

test("encodeStreamEvent + decodeStreamEvent 往返一致（block_started 事件）", () => {
  const ev = { type: "block_started", data: { block_id: "block-1", block_type: "table" as const } };
  const encoded = encodeStreamEvent(ev as any);
  assert.ok(encoded.startsWith("data: "));
  const decoded = decodeStreamEvent(encoded.slice(6));
  assert.deepEqual(decoded, { type: "block_started", data: { block_id: "block-1", block_type: "table" } });
});

test("encodeStreamEvent + decodeStreamEvent 往返一致（block_finished 事件）", () => {
  const ev = { type: "block_finished", data: { block_id: "block-1" } };
  const encoded = encodeStreamEvent(ev as any);
  assert.ok(encoded.startsWith("data: "));
  const decoded = decodeStreamEvent(encoded.slice(6));
  assert.deepEqual(decoded, { type: "block_finished", data: { block_id: "block-1" } });
});

test("asStreamEvent 对带 seq 的 block 事件保留 seq", () => {
  const obj = { type: "block_started", data: { block_id: "block-1", block_type: "code" }, seq: 42 };
  const ev = asStreamEvent(obj);
  assert.ok(ev);
  assert.equal(ev.type, "block_started");
  assert.equal((ev as any).seq, 42);
});

test("applyEvent 收到 block_started 后创建新 block 条目", () => {
  const msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  const updated = applyEvent(msg, { type: "block_started", data: { block_id: "block-1", block_type: "table" } });
  assert.ok(updated.blocks);
  assert.equal(updated.blocks?.length, 1);
  assert.equal(updated.blocks?.[0].block_id, "block-1");
  assert.equal(updated.blocks?.[0].block_type, "table");
  assert.equal(updated.blocks?.[0].content, "");
  assert.equal(updated.blocks?.[0].finished, false);
});

test("applyEvent 收到 block_finished 后标记 block 结束", () => {
  const msg: ChatMessage = {
    id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true,
    blocks: [{ block_id: "block-1", block_type: "table", content: "some content", finished: false }],
  };
  const updated = applyEvent(msg, { type: "block_finished", data: { block_id: "block-1" } });
  assert.equal(updated.blocks?.[0].finished, true);
});

test("applyEvent 收到 delta 时如果当前有未结束的 block，内容追加到 block 的 content 里", () => {
  const msg: ChatMessage = {
    id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true,
    blocks: [{ block_id: "block-1", block_type: "table", content: "开始", finished: false }],
  };
  const updated = applyEvent(msg, { type: "delta", data: { content: "追加" } });
  assert.equal(updated.content, "");
  assert.equal(updated.blocks?.[0].content, "开始追加");
});

test("applyEvent 收到 delta 时如果没有未结束的 block，内容追加到消息的 content 里", () => {
  const msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  const updated = applyEvent(msg, { type: "delta", data: { content: "普通内容" } });
  assert.equal(updated.content, "普通内容");
  assert.equal(updated.blocks, undefined);
});

test("applyEvent 收到 delta 时如果最后一个 block 已结束，内容追加到消息的 content 里", () => {
  const msg: ChatMessage = {
    id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true,
    blocks: [{ block_id: "block-1", block_type: "table", content: "内容", finished: true }],
  };
  const updated = applyEvent(msg, { type: "delta", data: { content: "普通内容" } });
  assert.equal(updated.content, "普通内容");
  assert.equal(updated.blocks?.[0].content, "内容");
});

test("applyEvent 连续收到多个 block_started，blocks 数组累加", () => {
  let msg: ChatMessage = { id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true };
  msg = applyEvent(msg, { type: "block_started", data: { block_id: "block-1", block_type: "table" } });
  msg = applyEvent(msg, { type: "block_started", data: { block_id: "block-2", block_type: "code" } });
  assert.equal(msg.blocks?.length, 2);
  assert.equal(msg.blocks?.[0].block_id, "block-1");
  assert.equal(msg.blocks?.[1].block_id, "block-2");
});

test("applyEvent 收到 block_finished 时只标记匹配的 block_id", () => {
  const msg: ChatMessage = {
    id: "1", role: "assistant", content: "", ts: Date.now(), streaming: true,
    blocks: [
      { block_id: "block-1", block_type: "table", content: "1", finished: false },
      { block_id: "block-2", block_type: "code", content: "2", finished: false },
    ],
  };
  const updated = applyEvent(msg, { type: "block_finished", data: { block_id: "block-1" } });
  assert.equal(updated.blocks?.[0].finished, true);
  assert.equal(updated.blocks?.[1].finished, false);
});
