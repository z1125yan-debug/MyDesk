// P62 按稳智原版重做回答排版：正文彻底去框 + 居中窄栏（2026-09-27 用户拍板）
//
// 触发点：用户拿三张截图对比（两张稳智 ai-matrix、一张我们的 #/copilot）问「你觉得这样好看吗？」。
// 对着稳智那张复核后确认 P61 抄错了层——稳智的 `.ai-content-block` 是给「卡片式模块」用的，
// 正文段落/列表/引用在它那一屏里**根本没有框**；有框的只有三处：表格卡、执行条、输入卡。
// 我们当时是「每条散段一张框 + 每个小节一张灰卡 + 整段回答再套一张大框」= 三层框叠加，
// 而且整栏铺满宽度、一行七八十个字，读起来比原来更累。
//
// 这一轮的口径（用户从两个选项里挑的）：
//   ① 完全照稳智：正文彻底去框（小节标题退成正文流里一行 emoji + 加粗字，不再画色带/卡头）
//   ② 栏宽：居中窄栏 ~880px（.wz-col），一行 40~48 个汉字
//
// 尺子出处仍是稳智 ai-matrix-content-DW5S8amy.css 的实测值（度量本体在 globals.css 一处定义）。
// 本文件反向钉「不许再有框」——谁哪天手滑把 .wz-block / .wz-answer 加回来，这里就红。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 本仓源文件是 CRLF，跨行内容先归一成 \n 再钉
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const css = () => read("src/app/globals.css");
const md = () => read("src/components/desk/Markdown.tsx");

/** 取一条 CSS 规则体（从选择器到它自己的收尾 `}`） */
function rule(src: string, sel: string): string {
  const at = src.indexOf(sel + " {");
  assert.ok(at >= 0, `globals.css 里找不到规则 ${sel}`);
  const end = src.indexOf("}", at);
  assert.ok(end > at, `规则 ${sel} 收不住`);
  return src.slice(at, end);
}

// ─── 1. 框全部拆掉：CSS 里不许再有那三个类 ─────────────────────────────

test("globals.css：.wz-answer / .wz-block / .wz-md-plain 三个框类已删除（正文一律无框）", () => {
  const c = css();
  for (const dead of [".wz-answer", ".wz-block", ".wz-md-plain"]) {
    assert.equal(c.includes(dead + " {"), false, `${dead} 是 P61 画蛇添足的框，P62 已经拆掉，不许回流`);
    assert.equal(c.includes(dead + " >"), false, `${dead} 的后代选择器也要一起清掉`);
  }
});

test("globals.css：正文段落/列表/引用规则里没有任何 border（框只留给表格卡）", () => {
  const c = css();
  for (const sel of [".wz-md p", ".wz-md li", ".wz-md ul", ".wz-md ol", ".wz-md > *"]) {
    assert.equal(/border/.test(rule(c, sel)), false, `${sel} 不该画框`);
  }
  // 引用块稳智也只是一条左竖条 + 弱色，不给整圈描边
  const bq = rule(c, ".wz-md blockquote");
  assert.match(bq, /border-left:\s*2px solid var\(--muted-foreground\);/);
  assert.equal(/border:\s*1px/.test(bq), false, "引用块不描整圈");
});

// ─── 2. 居中窄栏：稳智那栏 ~880px、一行 40~48 个汉字 ───────────────────

test("globals.css：.wz-col 是居中窄栏（max-width 880px + margin-inline auto）", () => {
  const col = rule(css(), ".wz-col");
  assert.match(col, /width:\s*100%;/);
  assert.match(col, /max-width:\s*880px;/);
  assert.match(col, /margin-inline:\s*auto;/);
});

test("AssistantPage：消息流挂 .wz-col，正文不再套 .wz-answer 大框", () => {
  const src = read("src/components/desk/pages/AssistantPage.tsx");
  assert.match(src, /className="wz-col space-y-6 px-6 py-6"/, "居中窄栏由页面挂，度量在 globals.css");
  assert.equal(/className="wz-answer"/.test(src), false, "回答外框已拆：框里只有正文这件事，由「根本没有框」实现");
  assert.match(src, /wz-user-bubble/, "用户气泡仍然挂 .wz-user-bubble（15px/1.75 在 CSS 一处定义）");
});

// ─── 3. Markdown：正文标签裸出，小节标题退成正文流里一行加粗字 ─────────

test("Markdown：段落/列表/引用是裸标签，不带任何 className", () => {
  const src = md();
  assert.match(src, /return <p><Linked>\{children\}<\/Linked><\/p>;/);
  assert.match(src, /return <li><Linked>\{children\}<\/Linked><\/li>;/);
  assert.match(src, /return <ul>\{children\}<\/ul>;/);
  assert.match(src, /return <ol>\{children\}<\/ol>;/);
  assert.match(src, /return <blockquote><Linked>\{children\}<\/Linked><\/blockquote>;/);
  assert.equal(/className="wz-block"/.test(src), false, "散段的框是 P61 抄错层抄出来的，P62 拆掉");
});

test("Markdown：SectionCard 不再画卡壳（无 section/描边/卡头色带），只输出 emoji + 加粗标题行 + 裸正文", () => {
  const src = md();
  const at = src.indexOf("function SectionCard");
  assert.ok(at >= 0, "SectionCard 仍在（小节还要抬成标题），但画法已换成一行标题 + 裸正文");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /<h2 className="wz-h wz-h2">/, "小节标题走正文流标题那一档（19px/650）");
  assert.match(body, /\{block\.body && <MdTree text=\{block\.body\} \/>\}/, "正文直接给 MdTree，不再包一层容器");
  for (const dead of ["<section", "rounded-xl border", "border-border/80", "bg-accent/40", "wz-md-plain", "header"]) {
    assert.equal(body.includes(dead), false, `卡壳残留：${dead}（P62 用户口径：正文彻底去框）`);
  }
});

test("Markdown：表格仍然留在 .wz-table-card 里（稳智少数「该有框」的地方之一）", () => {
  const src = md();
  assert.match(src, /className="wz-table-card desk-scroll -mx-1 overflow-x-auto"/);
  const card = rule(css(), ".wz-table-card");
  assert.match(card, /border:\s*1px solid var\(--border\);/);
  assert.match(card, /border-radius:\s*12px;/);
});

// ─── 4. 决策卡那条路径不受影响：命中原版决策结构时仍走 DecisionWidget ──

test("Markdown：决策命中时不再切分区小节，未命中才走 SectionCard 那条裸排路径", () => {
  const src = md();
  const at = src.indexOf("const decision = extractDecision(content);");
  assert.ok(at >= 0, "11 字段决策仍然优先（P18 决定，不因排版改动）");
  assert.match(src.slice(at), /splitBlocks\(content\)/);
  assert.match(src.slice(at), /b\.kind === "card"/);
});
