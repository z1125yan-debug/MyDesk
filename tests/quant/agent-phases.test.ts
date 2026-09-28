// agent-phases-core 单测：钉死 6 阶段推导口径
//
// 稳智逆向扒出的固定 6 阶段视图（agentStepTimeline 的 phase_key 常量）+ 4 状态机。
// 本仓库 SSE 契约是细粒度工具调用，没有 phase_key；纯核里做的是从 label/tool 语义反推。
// 每条测试都对应稳智逆向的一个典型场景（intent 命中、只有行情、跨阶段混合、error、流式中途）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAgentPhases,
  agentPhasesHeadline,
  AGENT_PHASES,
  type PhaseStatus,
} from "../../src/lib/desk/agent-phases-core.ts";
import type { StepInfo, IntentBadge } from "../../src/lib/desk/chat-core.ts";

function makeIntent(over: Partial<IntentBadge> = {}): IntentBadge {
  return {
    scene: "quote",
    label: "行情查询",
    hits: ["茅台"],
    symbol: "600519.SH",
    symbolSource: "focusSymbol",
    inherited: false,
    followUp: false,
    skipped: [],
    ...over,
  };
}

function msg(content = "回答内容", streaming = false) {
  return { content, streaming };
}

test("完整流程：intent 命中 + 3 类工具 + 有回答 → 6 阶段全 done", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情快照", status: "ok", tool: "quote", source: "prefetch" },
    { step: 2, label: "取新闻", status: "ok", tool: "news", source: "prefetch" },
    { step: 3, label: "取技术面", status: "ok", tool: "technicals" },
  ];
  const r = deriveAgentPhases(steps, makeIntent(), msg());
  assert.equal(r.length, 6);
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.intent, "done");
  assert.equal(status.skills, "done");
  assert.equal(status.local_data, "done");
  assert.equal(status.external_data, "done");
  assert.equal(status.research, "pending"); // 没回测/筛选工具 → research 保持 pending
  assert.equal(status.answer, "done");
});

test("流式中：answer 阶段为 active，其它阶段按已完成的步骤算", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote" },
  ];
  const r = deriveAgentPhases(steps, makeIntent(), msg("部分回答", true));
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.answer, "active");
  assert.equal(status.intent, "done");
});

test("error 阶段优先：只要有一个 error 步骤 → 该阶段 status=error", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote" },
    { step: 2, label: "取新闻", status: "error", tool: "news" },
  ];
  const r = deriveAgentPhases(steps, makeIntent(), msg());
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.local_data, "done"); // quote 已 done
  assert.equal(status.external_data, "error"); // news error
});

test("running 阶段为 active：streaming 中工具还在跑", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "running", tool: "quote" },
  ];
  const r = deriveAgentPhases(steps, makeIntent(), msg("", true));
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.local_data, "active");
});

test("无任何 steps、无 intent、无 content：全 pending（消息还没发出）", () => {
  const r = deriveAgentPhases([], undefined, msg(""));
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.intent, "pending");
  assert.equal(status.skills, "pending");
  assert.equal(status.answer, "pending");
});

test("intent 无徽章但已开取数 / 已有正文 → 也按 done（否则流式全程挂「正在进行：理解问题」）", () => {
  // 有 steps（哪怕还在跑）说明问题已理解完 → intent done，headline 才能让位给 answer
  const withSteps = deriveAgentPhases(
    [{ step: 1, label: "取行情", status: "running", tool: "quote" }],
    undefined,
    msg("", true),
  );
  assert.equal(Object.fromEntries(withSteps.map((p) => [p.key, p.status])).intent, "done");
  // 已有正文（流式中）同理
  const withContent = deriveAgentPhases([], undefined, msg("正文", true));
  assert.equal(Object.fromEntries(withContent.map((p) => [p.key, p.status])).intent, "done");
  // 一个都还没有（刚发出）→ intent 仍 active
  const justSent = deriveAgentPhases([], undefined, msg("", true));
  assert.equal(Object.fromEntries(justSent.map((p) => [p.key, p.status])).intent, "active");
});

test("AGENT_PHASES 顺序稳定且 6 个（钉死顺序 = 稳智 label 映射数组顺序）", () => {
  assert.equal(AGENT_PHASES.length, 6);
  assert.deepEqual(
    AGENT_PHASES.map((p) => p.key),
    ["intent", "skills", "local_data", "external_data", "research", "answer"],
  );
});

test("research 阶段：回测工具归类到 research", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "跑回测", status: "ok", tool: "run_backtest" },
  ];
  const r = deriveAgentPhases(steps, makeIntent(), msg());
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.research, "done");
  assert.equal(status.local_data, "pending"); // 没有行情工具
});

test("headline：answer done → ✨ AI 已完成分析（P56 稳智对齐）", () => {
  const r = deriveAgentPhases(
    [{ step: 1, label: "取行情", status: "ok", tool: "quote" }],
    makeIntent(),
    msg("内容"),
  );
  assert.match(agentPhasesHeadline(r), /AI 已完成分析/);
});

test("headline：有 active 阶段 → 正在进行：xxx", () => {
  const r = deriveAgentPhases(
    [{ step: 1, label: "取行情", status: "running", tool: "quote" }],
    makeIntent(),
    msg("", true),
  );
  assert.match(agentPhasesHeadline(r), /正在进行/);
});

test("headline：有 error 且 answer 未完成 → 该阶段名 + 失败", () => {
  const r = deriveAgentPhases(
    [{ step: 1, label: "取新闻", status: "error", tool: "news" }],
    makeIntent(),
    msg("", false), // 没有内容 → answer 阶段 pending，才能看到 error 优先
  );
  assert.match(agentPhasesHeadline(r), /失败/);
});
