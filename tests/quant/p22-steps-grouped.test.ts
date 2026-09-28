// P22 步骤按阶段分组渲染的钉测。
//
// 稳智对齐 P1 #5：稳智 StepTimeline 把步骤按 6 阶段固定分组，每组带阶段标题行；本仓库原来是
// 平铺列表，用户看不到「这是行情还是新闻」。改动分两块：
//   - agent-phases-core.ts：classifyStep 从内部函数改成 export（单一映射规则两处消费，不重造）
//   - StepTimeline.tsx：把 steps.map 换成 AGENT_PHASES.map，每组筛出该阶段的步骤，空阶段跳过
//
// 测试钉三件事：
//   1. classifyStep 已导出且口径与 deriveAgentPhases 内部一致（分类器钉）
//   2. 分组结果只包含该阶段的步骤（分组钉）
//   3. 空阶段真的跳过（不出现"0 步"标题行）
//
// 为什么不直接渲染 StepTimeline.tsx 做快照：React 组件依赖 jsdom + lucide + radix，钉测成本
// 远大于收益。分组逻辑本身是纯函数（steps + classifyStep + AGENT_PHASES），把这段"分组筛选"
// 逻辑抽出成 groupStepsByPhase 函数放在 agent-phases-core 里，StepTimeline 直接消费，测试
// 就能只打纯核，绕开 React 依赖。
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStep,
  AGENT_PHASES,
  groupStepsByPhase,
  deriveAgentPhases,
  type PhaseKey,
} from "../../src/lib/desk/agent-phases-core.ts";
import type { StepInfo, IntentBadge } from "../../src/lib/desk/chat-core.ts";

function intent(): IntentBadge {
  return {
    scene: "quote", label: "行情查询", hits: ["茅台"],
    symbol: "600519.SH", symbolSource: "focusSymbol",
    inherited: false, followUp: false, skipped: [],
  };
}

test("classifyStep 已导出且按工具/label 语义分类", () => {
  // local_data：行情/快照/技术
  assert.equal(classifyStep({ step: 1, label: "取行情快照", status: "ok", tool: "quote" }), "local_data");
  assert.equal(classifyStep({ step: 1, label: "取技术面 RSI", status: "ok", tool: "technicals" }), "local_data");
  // external_data：新闻/公告
  assert.equal(classifyStep({ step: 2, label: "取新闻", status: "ok", tool: "news" }), "external_data");
  assert.equal(classifyStep({ step: 2, label: "公告检索", status: "ok", tool: "stock_news" }), "external_data");
  // research：回测/筛选/因子
  assert.equal(classifyStep({ step: 3, label: "跑回测", status: "ok", tool: "run_backtest" }), "research");
  assert.equal(classifyStep({ step: 3, label: "跑筛选器", status: "ok", tool: "screener" }), "research");
});

test("classifyStep 兜底归 local_data（大部分系统预取是行情/快照类）", () => {
  // 无任何关键词命中时兜底 local_data
  assert.equal(classifyStep({ step: 1, label: "神秘步骤", status: "ok", tool: "mystery_tool" }), "local_data");
  assert.equal(classifyStep({ step: 1, label: "", status: "ok" }), "local_data");
});

test("classifyStep 优先级：local_data > external_data > research", () => {
  // 同时命中多组时，按 classifyStep 内部顺序取最前面那个
  // 例：label 里同时有"行情"和"新闻"关键词 → 命中 local_data
  const s: StepInfo = { step: 1, label: "行情新闻混合步骤", status: "ok", tool: "quote" };
  assert.equal(classifyStep(s), "local_data");
});

test("groupStepsByPhase 只把属于该阶段的步骤分到该阶段", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情快照", status: "ok", tool: "quote" },
    { step: 2, label: "取新闻", status: "ok", tool: "news" },
    { step: 3, label: "跑回测", status: "ok", tool: "run_backtest" },
    { step: 4, label: "取技术面", status: "ok", tool: "technicals" },
  ];
  const groups = groupStepsByPhase(steps);
  assert.equal(groups.local_data.length, 2, "quote + technicals 都归 local_data");
  assert.deepEqual(groups.local_data.map((s) => s.step), [1, 4]);
  assert.equal(groups.external_data.length, 1);
  assert.deepEqual(groups.external_data.map((s) => s.step), [2]);
  assert.equal(groups.research.length, 1);
  assert.deepEqual(groups.research.map((s) => s.step), [3]);
  // intent/skills/answer 三阶段永远空（步骤只可能归后三阶段）
  assert.equal(groups.intent.length, 0);
  assert.equal(groups.skills.length, 0);
  assert.equal(groups.answer.length, 0);
});

test("groupStepsByPhase 保留原始顺序（步骤按 step 号升序进入时输出仍升序）", () => {
  const steps: StepInfo[] = [
    { step: 5, label: "行情 A", status: "ok", tool: "quote" },
    { step: 1, label: "行情 B", status: "ok", tool: "quote" },
    { step: 3, label: "行情 C", status: "ok", tool: "quote" },
  ];
  const groups = groupStepsByPhase(steps);
  // 输入顺序保留：5 → 1 → 3
  assert.deepEqual(groups.local_data.map((s) => s.step), [5, 1, 3]);
});

test("groupStepsByPhase 空输入返回全空数组（不硬凑）", () => {
  const groups = groupStepsByPhase([]);
  for (const k of Object.keys(groups) as (keyof typeof groups)[]) {
    assert.deepEqual(groups[k], []);
  }
});

test("AGENT_PHASES 顺序钉死（分组渲染依赖这个顺序 = 稳智 label 映射数组顺序）", () => {
  assert.equal(AGENT_PHASES.length, 6);
  assert.deepEqual(
    AGENT_PHASES.map((p) => p.key),
    ["intent", "skills", "local_data", "external_data", "research", "answer"],
  );
});

test("PhaseKey 类型覆盖 6 阶段（防未来加阶段时忘改 StepTimeline 分支）", () => {
  const keys: PhaseKey[] = ["intent", "skills", "local_data", "external_data", "research", "answer"];
  assert.equal(keys.length, 6);
  // AGENT_PHASES 里每个 key 都是合法 PhaseKey（TypeScript 编译期已经保证，这里再钉一次运行期）
  for (const ph of AGENT_PHASES) {
    assert.ok(keys.includes(ph.key), `AGENT_PHASES 含非法 key: ${ph.key}`);
  }
});

test("分组结果与 deriveAgentPhases 的阶段集合一致（不重复分类、不遗漏）", () => {
  // 同一批 steps，deriveAgentPhases 认为哪些阶段有活动，groupStepsByPhase 就应该哪些阶段非空
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote" },
    { step: 2, label: "取新闻", status: "error", tool: "news" },
  ];
  const phases = deriveAgentPhases(steps, intent(), { content: "回答", streaming: false });
  const groups = groupStepsByPhase(steps);
  const phaseStatus = Object.fromEntries(phases.map((p) => [p.key, p.status]));
  // local_data done（有 quote 步骤）
  assert.equal(phaseStatus.local_data, "done");
  assert.ok(groups.local_data.length > 0);
  // external_data error（news 失败）
  assert.equal(phaseStatus.external_data, "error");
  assert.ok(groups.external_data.length > 0);
  // research 无任何步骤，groupStepsByPhase 应空
  assert.equal(phaseStatus.research, "pending");
  assert.equal(groups.research.length, 0);
});
