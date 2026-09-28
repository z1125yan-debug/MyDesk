// P27 Agent Loop 6 阶段固定顺序（后端显式发 phase_key）钉测（稳智对齐 P2 #10）。
//
// 稳智逆向扒出的 Agent Loop 是 6 阶段固定顺序：intent → skills → local_data → external_data → research → answer。
// 本仓库 P22 已经做了前端语义映射（classifyStep），P27 加了后端显式发 phase_key 字段。
// 前端收到后优先用 phase_key，没有时 fallback 到语义映射（旧服务端/未升级的客户端）。
//
// 测试钉三件事：
//   1. StreamStep 类型有 phase_key 字段（TypeScript 编译期保证）
//   2. decodeStreamEvent 能解码带 phase_key 的 step 事件
//   3. groupStepsByPhase 优先用 phase_key，没有时 fallback 到 classifyStep
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeStreamEvent,
  encodeStreamEvent,
} from "../../src/lib/desk/chat-stream-core.ts";
import {
  groupStepsByPhase,
  classifyStep,
  AGENT_PHASES,
} from "../../src/lib/desk/agent-phases-core.ts";
import type { StepInfo } from "../../src/lib/desk/chat-core.ts";

test("decodeStreamEvent 能解码带 phase_key 的 step 事件", () => {
  const raw = '{"type":"step","data":{"step":1,"label":"取行情","status":"ok","tool":"quote","phase_key":"local_data"}}';
  const ev = decodeStreamEvent(raw);
  assert.ok(ev);
  assert.equal(ev.type, "step");
  assert.equal((ev as any).data.phase_key, "local_data");
});

test("decodeStreamEvent 对无效的 phase_key 值丢弃该字段（不报错）", () => {
  const raw = '{"type":"step","data":{"step":1,"label":"取行情","status":"ok","tool":"quote","phase_key":"invalid_phase"}}';
  const ev = decodeStreamEvent(raw);
  assert.ok(ev);
  assert.equal(ev.type, "step");
  // phase_key 不在合法白名单内，应该被丢弃（不报错，整帧照旧）
  assert.equal((ev as any).data.phase_key, undefined);
});

test("decodeStreamEvent 对 phase_key 非字符串丢弃该字段", () => {
  const raw = '{"type":"step","data":{"step":1,"label":"取行情","status":"ok","tool":"quote","phase_key":123}}';
  const ev = decodeStreamEvent(raw);
  assert.ok(ev);
  assert.equal((ev as any).data.phase_key, undefined);
});

test("encodeStreamEvent + decodeStreamEvent 往返一致（带 phase_key 的 step 事件）", () => {
  const ev = { type: "step", data: { step: 1, label: "取行情", status: "ok", tool: "quote", phase_key: "local_data" as const } };
  const encoded = encodeStreamEvent(ev as any);
  assert.ok(encoded.startsWith("data: "));
  const decoded = decodeStreamEvent(encoded.slice(6));
  // decodeStreamEvent 总是给 ms 赋 null（如果原始数据没有 ms），所以预期也要带 ms: null
  assert.deepEqual(decoded, { type: "step", data: { step: 1, label: "取行情", status: "ok", ms: null, tool: "quote", phase_key: "local_data" } });
});

test("groupStepsByPhase 优先用 phase_key（后端显式发）", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote", phase_key: "local_data" },
    { step: 2, label: "取新闻", status: "ok", tool: "news", phase_key: "external_data" },
    { step: 3, label: "跑回测", status: "ok", tool: "run_backtest", phase_key: "research" },
  ];
  const groups = groupStepsByPhase(steps);
  assert.equal(groups.local_data.length, 1);
  assert.equal(groups.external_data.length, 1);
  assert.equal(groups.research.length, 1);
});

test("groupStepsByPhase 对无 phase_key 的步骤 fallback 到 classifyStep 语义映射", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote" }, // 无 phase_key → classifyStep → local_data
    { step: 2, label: "取新闻", status: "ok", tool: "news" },   // 无 phase_key → classifyStep → external_data
  ];
  const groups = groupStepsByPhase(steps);
  assert.equal(groups.local_data.length, 1);
  assert.equal(groups.external_data.length, 1);
});

test("groupStepsByPhase 混合 phase_key 和语义映射", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote", phase_key: "local_data" },  // 有 phase_key
    { step: 2, label: "取新闻", status: "ok", tool: "news" },                              // 无 phase_key → fallback
    { step: 3, label: "跑回测", status: "ok", tool: "run_backtest", phase_key: "research" }, // 有 phase_key
  ];
  const groups = groupStepsByPhase(steps);
  assert.equal(groups.local_data.length, 1);
  assert.equal(groups.external_data.length, 1);
  assert.equal(groups.research.length, 1);
});

test("groupStepsByPhase 对 phase_key 与 classifyStep 冲突时优先用 phase_key", () => {
  // 构造一个 phase_key 与语义映射不一致的 case：label 是"取新闻"（语义映射到 external_data），但 phase_key 是"local_data"
  const steps: StepInfo[] = [
    { step: 1, label: "取新闻", status: "ok", tool: "news", phase_key: "local_data" },
  ];
  const groups = groupStepsByPhase(steps);
  // phase_key 优先，归到 local_data（不是语义映射的 external_data）
  assert.equal(groups.local_data.length, 1);
  assert.equal(groups.external_data.length, 0);
});

test("classifyStep 对无 phase_key 的步骤仍正常语义映射（P22 逻辑不变）", () => {
  // 确认 P22 的语义映射逻辑没被 P27 破坏
  assert.equal(classifyStep({ step: 1, label: "取行情", status: "ok", tool: "quote" }), "local_data");
  assert.equal(classifyStep({ step: 2, label: "取新闻", status: "ok", tool: "news" }), "external_data");
  assert.equal(classifyStep({ step: 3, label: "跑回测", status: "ok", tool: "run_backtest" }), "research");
});

test("AGENT_PHASES 顺序钉死（P22 逻辑不变）", () => {
  assert.equal(AGENT_PHASES.length, 6);
  assert.deepEqual(
    AGENT_PHASES.map((p) => p.key),
    ["intent", "skills", "local_data", "external_data", "research", "answer"],
  );
});
