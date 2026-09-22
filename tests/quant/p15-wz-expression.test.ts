import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyHeading, stripLeadingEmoji, splitBlocks, SECTION_DEFS, SECTION_EMOJI,
} from "../../src/lib/desk/markdown-sections-core.ts";

// P15 对话表达层对齐稳智：小节分类/切块是纯核（零 IO），这里测行为；
// 渲染层（Markdown.tsx）与提示词（ai.ts / chat route）只钉「吃的是这份唯一出处」。

const readSrc = (p: string) => readFileSync(new URL(p, new URL("../../", import.meta.url)), "utf8");

test("P15-① 分类器按关键词命中九类，优先级由定义顺序定（多类词取先命中）", () => {
  assert.equal(classifyHeading("风险提示"), "risk");
  assert.equal(classifyHeading("仓位与买点"), "action");
  assert.equal(classifyHeading("资金与量能"), "capital");
  assert.equal(classifyHeading("技术结构"), "technical");
  assert.equal(classifyHeading("基本面与估值"), "fundamental");
  assert.equal(classifyHeading("市场与主线环境"), "market");
  assert.equal(classifyHeading("消息与催化"), "event");
  assert.equal(classifyHeading("结论"), "decision");
  assert.equal(classifyHeading("数据口径"), "note");
  // 「风险与操作计划」同时命中两类：定义顺序 risk 在前 → risk（与稳智分类器同纪律）
  assert.equal(classifyHeading("风险与操作计划"), "risk");
});

test("P15-② 认不出不硬凑：空/超长/无关键词一律 null（普通标题渲染）", () => {
  assert.equal(classifyHeading(""), null);
  assert.equal(classifyHeading("今天天气不错"), null);
  assert.equal(classifyHeading("结论".repeat(30)), null, "超长标题不成卡（多是模型跑偏的整段）");
});

test("P15-③ emoji 剥前缀再分类：模型自己挂了 emoji 的认同一类，卡头不重复画", () => {
  assert.equal(stripLeadingEmoji("🎯 结论"), "结论");
  assert.equal(classifyHeading("🎯 结论"), "decision");
  assert.equal(classifyHeading("⚠️ 风险与失效点"), "risk");
  assert.equal(SECTION_EMOJI.decision, "🎯");
});

test("P15-④ splitBlocks：命中标题连正文成卡，未命中留 plain，代码围栏里的伪标题不算标题", () => {
  const md = [
    "开头一句话。",
    "",
    "## 🎯 结论",
    "第一句判断。",
    "",
    "## 随便一个没命中的标题",
    "普通段落",
    "",
    "### ⚠️ 风险",
    "- 破位",
    "```md",
    "## 这是代码块里的伪标题，不能切",
    "```",
  ].join("\n");
  const { intro, blocks } = splitBlocks(md);
  assert.equal(intro, "开头一句话。");
  // 未命中的同级标题让上一张卡收口：它的正文只有命中后的那段，标题不塞进别人卡里
  assert.equal(blocks[0].kind, "card");
  assert.equal((blocks[0] as { section: string }).section, "decision");
  assert.equal((blocks[0] as { body: string }).body, "第一句判断。");
  assert.equal(blocks[1].kind, "plain");
  assert.ok((blocks[1] as { text: string }).text.includes("## 随便一个没命中的标题"), "未命中标题原样留 plain");
  // 风险卡照开，围栏里的伪标题整段留在卡正文：没被「##」腰斩
  assert.equal(blocks[2].kind, "card");
  assert.equal((blocks[2] as { section: string }).section, "risk");
  assert.ok((blocks[2] as { body: string }).body.includes("## 这是代码块里的伪标题，不能切"));
  assert.equal(blocks.length, 3);
});

test("P15-⑤ 卡后接卡：下一张卡开始时前一张收口，正文不串卡", () => {
  const { intro, blocks } = splitBlocks("## 结论\nA段\n\n## 风险提示\nB段\n\n## 仓位计划\nC段");
  assert.equal(intro, "", "首行即卡时 intro 为空");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => (b as { section: string }).section), ["decision", "risk", "action"]);
  assert.equal((blocks[1] as { body: string }).body, "B段");
});

test("P15-⑥ 接线钉：渲染层只吃纯核一份定义，提示词带「翻译成白话/数字带解读」口径", () => {
  const md = readSrc("src/components/desk/Markdown.tsx");
  assert.ok(md.includes("splitBlocks"), "渲染层用纯核切块");
  assert.ok(md.includes("SECTION_EMOJI"), "emoji 出处在纯核，界面不另抄");
  assert.ok(!md.includes("function ModuleHeading"), "旧标题色带画法退役（只画卡头）");
  assert.ok(md.includes("rounded-xl border"), "小节整段包卡（稳智 .decision-card 观感）");
  // 用户口径「做成同款灰卡」：钉死统一描边底色 + 九类分色表不得回潮（分类只出 emoji 与成卡）
  assert.ok(md.includes("border-border/80") && md.includes("bg-accent/40"), "同款灰卡：中性描边+浅灰卡头");
  assert.ok(!md.includes("const MODULES"), "分色配置表已退役，颜色不再按小节种类漂");
  const ai = readSrc("src/lib/desk/ai.ts");
  assert.ok(ai.includes("翻译成白话"), "客户端提示词：白话复述");
  assert.ok(ai.includes("只报数字不解读等于没报"), "客户端提示词：数字带解读");
  const route = readSrc("src/app/api/ai/chat/route.ts");
  assert.ok(route.includes("翻译成白话"), "工具环提示词同源要求");
  const tl = readSrc("src/components/desk/StepTimeline.tsx");
  assert.ok(tl.includes("AI 已完成分析 · 共"), "步骤条收口措辞对齐");
  assert.ok(tl.includes("步缺数据"), "缺数据照样挂标题上：收口不等于瞒");
});

test("P15-⑦ 定义完整性：九类都有 emoji 与至少一个关键词，键集与渲染层 MODULES 对齐", () => {
  assert.equal(SECTION_DEFS.length, 9);
  for (const d of SECTION_DEFS) {
    assert.ok(d.emoji.length > 0, `${d.kind} 必须有 emoji`);
    assert.ok(d.words.length > 0, `${d.kind} 必须有关键词`);
    assert.equal(SECTION_EMOJI[d.kind], d.emoji);
  }
});
