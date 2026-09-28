// P21 结论契约（稳智对齐 P1 #8）：
// 前端 markdown-sections-core 强识别四类固定前缀（🎯 核心判断 / 🔍 关注清单 / 🛑 失效条件 / 🧭 执行计划），
// MODE_NOTES.decision 注入同一套前缀规范，让 decision 模式 LLM 输出遵循契约。
//
// 三条口径钉死：
//   1. 4 类新 kind（conclusion/watchlist/invalidation/plan）排在通用类之前——避免"失效条件"被 risk 抢走、"操作计划"被 action 抢走
//   2. MODE_NOTES.decision 里必须写出四类前缀（LLM 不看不写，前端识别不到）
//   3. SECTION_EMOJI 覆盖新 4 类（Markdown.tsx 渲染时通过 SECTION_EMOJI[block.section] 取 emoji）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECTION_DEFS, SECTION_EMOJI, classifyHeading, splitBlocks, stripLeadingEmoji } from "../../src/lib/desk/markdown-sections-core.ts";
import { MODE_NOTES } from "../../src/lib/desk/modes.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("P21-① 四类结论契约 kind 都在 SECTION_DEFS 里", () => {
  const kinds = SECTION_DEFS.map((d) => d.kind);
  for (const k of ["conclusion", "watchlist", "invalidation", "plan"] as const) {
    assert.ok(kinds.includes(k), `缺 ${k}`);
  }
});

test("P21-② 四类排在通用类之前（避免关键词被抢走）", () => {
  const kinds = SECTION_DEFS.map((d) => d.kind);
  const planIdx = kinds.indexOf("plan");
  const riskIdx = kinds.indexOf("risk");
  const actionIdx = kinds.indexOf("action");
  assert.ok(planIdx < riskIdx, "plan 必须在 risk 之前：否则「操作计划」被归成 risk");
  assert.ok(planIdx < actionIdx, "plan 必须在 action 之前：否则「操作计划」被归成 action");
  assert.ok(kinds.indexOf("invalidation") < riskIdx, "invalidation 必须在 risk 之前：否则「失效条件」被归成 risk");
});

test("P21-③ 四类 SECTION_EMOJI 覆盖（渲染层靠这个取值）", () => {
  assert.equal(SECTION_EMOJI.conclusion, "🎯");
  assert.equal(SECTION_EMOJI.watchlist, "🔍");
  assert.equal(SECTION_EMOJI.invalidation, "🛑");
  assert.equal(SECTION_EMOJI.plan, "🧭");
});

test("P21-④ classifyHeading 命中固定前缀（含/不含 emoji 前缀都命中）", () => {
  // 无 emoji
  assert.equal(classifyHeading("核心判断"), "conclusion");
  assert.equal(classifyHeading("关注清单"), "watchlist");
  assert.equal(classifyHeading("失效条件"), "invalidation");
  assert.equal(classifyHeading("执行计划"), "plan");
  // 带 emoji 前缀（模型按契约输出时的形态）
  assert.equal(classifyHeading("🎯 核心判断"), "conclusion");
  assert.equal(classifyHeading("🔍 关注清单"), "watchlist");
  assert.equal(classifyHeading("🛑 失效条件"), "invalidation");
  assert.equal(classifyHeading("🧭 执行计划"), "plan");
});

test("P21-⑤ 契约优先级：含多关键词时按契约顺序命中", () => {
  // 「风险与操作计划」同时含 risk 和 plan 关键词，plan 在前 → plan
  assert.equal(classifyHeading("风险与操作计划"), "plan");
  // 「失效条件与风险」→ invalidation（排前面）
  assert.equal(classifyHeading("失效条件与风险"), "invalidation");
  // 「核心判断：买入」→ conclusion
  assert.equal(classifyHeading("核心判断：买入"), "conclusion");
});

test("P21-⑥ splitBlocks：命中契约前缀切卡，正文连进来", () => {
  const md = `
先给一段引言，不分类。

### 🎯 核心判断
一句话结论：看多。

### 🧭 执行计划
- 仓位 30%
- 入场区间 25.5-25.8

### 🛑 失效条件
跌破 25.0 就错了。
`;
  const { intro, blocks } = splitBlocks(md);
  assert.ok(intro.includes("引言"), "引言部分保留");
  assert.ok(blocks.length >= 3, `应至少切成 3 张卡，实际 ${blocks.length}`);
  const kinds = blocks.filter((b) => b.kind === "card").map((b) => (b as any).section);
  assert.ok(kinds.includes("conclusion"), "应有 conclusion 卡");
  assert.ok(kinds.includes("plan"), "应有 plan 卡");
  assert.ok(kinds.includes("invalidation"), "应有 invalidation 卡");
});

test("P21-⑦ MODE_NOTES.decision 注入稳智生产骨架（wz-dump/history-611 实扒口径）", () => {
  const note = MODE_NOTES.decision;
  // P56：输出骨架迁移到稳智生产版（## 分节 + 一句话定性 + 情形化观察方案），
  // 四类 ### 契约前缀仍是 markdown-sections-core 的解析合同（p21-①~⑥ 钉住），但提示词侧不再要求模型输出它们。
  assert.ok(note.includes("📌 **一句话定性：**"), "decision 提示词必须写 📌 一句话定性");
  assert.ok(note.includes("## 结论与条件方案"), "decision 提示词必须写 ## 结论与条件方案");
  assert.ok(note.includes("**失效条件"), "decision 提示词必须写失效条件（结论方案内）");
  assert.ok(note.includes("**一句话总结"), "decision 提示词必须写一句话总结收口");
  assert.ok(note.includes("观察窗口"), "decision 提示词必须写观察窗口");
});

test("P21-⑧ stripLeadingEmoji 剥掉契约 emoji 前缀（卡头不重复画）", () => {
  assert.equal(stripLeadingEmoji("🎯 核心判断"), "核心判断");
  assert.equal(stripLeadingEmoji("🔍 关注清单"), "关注清单");
  assert.equal(stripLeadingEmoji("🛑 失效条件"), "失效条件");
  assert.equal(stripLeadingEmoji("🧭 执行计划"), "执行计划");
});

test("P21-⑨ 契约前缀不影响其他模式（judge/deep/search 提示词不变）", () => {
  // 其他三种模式不应包含契约前缀，避免污染
  for (const m of ["judge", "deep", "search"] as const) {
    assert.ok(!MODE_NOTES[m].includes("🎯 核心判断"), `${m} 模式不应含契约前缀`);
    assert.ok(!MODE_NOTES[m].includes("🔍 关注清单"), `${m} 模式不应含契约前缀`);
  }
});

test("P21-⑩ SectionKind 类型覆盖新 4 类（编译期强约束）", () => {
  // TypeScript 编译期强检查：新 4 类必须在类型里
  const kinds: import("../../src/lib/desk/markdown-sections-core.ts").SectionKind[] = [
    "conclusion", "watchlist", "invalidation", "plan",
  ];
  assert.equal(kinds.length, 4);
});
