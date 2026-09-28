// P61 回答排版对齐稳智（2026-09-27 用户拍板：「标题放大 然后回答有个框，现在的密密麻麻看着有点难受」）
//
// 尺子来自稳智前端实测（登录后从站点直取的 ai-matrix-content-DW5S8amy.css），逐条抄的是**实测声明**：
//   .stream-content / .msg-content   font-size:16px; line-height:1.82; font-variant-numeric:tabular-nums
//   .ai-content-block                border:1px solid var(--ai-rule); border-left:3px solid var(--ai-accent);
//                                    background:var(--ai-tone-neutral); border-radius:8px; padding:12px 15px
//   p{line-height:1.82;margin:0 0 20px}  ul,ol{margin:0 0 22px;padding-left:1.55em}  li{margin:10px 0}
//   h1..h6{margin:34px 0 16px;font-weight:650;line-height:1.4}  h1 22px(-.01em) / h2 19px / h3 17px
//   table{font-size:15px;line-height:1.65}  th,td{padding:11px 16px;min-width:6em;text-align:left}
//   .analysis-line-lead{font-size:17px;font-weight:700}
// 稳智深色下 --ai-accent 是 #676767（中性灰、不是彩色），所以左竖条走 --muted-foreground，不引新配色。
//
// 一把尺子：度量钉在 globals.css（一处定义），组件只钉「挂没挂上这个类」——
// 谁在组件里重新写死一个字号，这条测试就红。node --test 直跑零 IO。
//
// P62（同日第二轮，用户对着稳智截图复核）把「框」这一层全拆了：正文段落/列表/引用在稳智里本来就没有框，
// 只有表格卡、执行条、输入卡有框。本文件原来钉 .wz-block（散段一张框）、.wz-answer（回答大框）、
// .wz-md-plain（卡内第二层框）那几条已删，改由 p62-wz-bare-prose.test.ts 反向钉「不许再有框」。
// 度量数值本身（16/1.82、22/19/17、15/1.65、段间 20px）没变，继续留在这里。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 本仓源文件是 CRLF，跨行选择器要先归一成 \n 才钉得住（单行规则不受影响）
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const css = () => read("src/app/globals.css");
const md = () => read("src/components/desk/Markdown.tsx");

/** 取一条 CSS 规则体（从选择器到它自己的收尾 `}`），用来判「这条规则里到底有没有那个度量」 */
function rule(src: string, sel: string): string {
  const at = src.indexOf(sel + " {");
  assert.ok(at >= 0, `globals.css 里找不到规则 ${sel}`);
  const end = src.indexOf("}", at);
  assert.ok(end > at, `规则 ${sel} 收不住`);
  return src.slice(at, end);
}

// ─── 1. 度量本体：稳智实测值钉在 globals.css ────────────────────────────

test("globals.css：.wz-md 块间距抄稳智的 20px（旧的 space-y-2 + [&_p]:my-1 是「密密麻麻」的病灶）", () => {
  const c = css();
  assert.match(rule(c, ".wz-md > *"), /margin:\s*0 0 20px;/);
  assert.match(rule(c, ".wz-md p"), /line-height:\s*1\.82;/);
  assert.match(rule(c, ".wz-md li"), /margin:\s*10px 0;/);
  assert.match(rule(c, ".wz-md ul"), /padding-left:\s*1\.55em;/);
  assert.match(rule(c, ".wz-md ol"), /padding-left:\s*1\.55em;/);
});

test("globals.css：标题在正文流里、放大到稳智那一档（h1 22 / h2 19 / h3 17，字重 650，margin 34/16）", () => {
  const c = css();
  const h = rule(c, ".wz-h");
  assert.match(h, /margin:\s*34px 0 16px;/);
  assert.match(h, /font-weight:\s*650;/);
  assert.match(h, /line-height:\s*1\.4;/);
  assert.match(rule(c, ".wz-h1"), /font-size:\s*22px;/);
  assert.match(rule(c, ".wz-h1"), /letter-spacing:\s*-0\.01em;/);
  assert.match(rule(c, ".wz-h2"), /font-size:\s*19px;/);
  assert.match(rule(c, ".wz-h3"), /font-size:\s*17px;/);
});

test("globals.css：表格抄稳智 15px/1.65 + 格内 11x16 + 只画横线 + 表头浅底（旧的 13px / py-1 是最挤的一处）", () => {
  const c = css();
  assert.match(rule(c, ".wz-table"), /font-size:\s*15px;/);
  assert.match(rule(c, ".wz-table"), /line-height:\s*1\.65;/);
  const cells = rule(c, ".wz-table th,\n.wz-table td");
  assert.match(cells, /padding:\s*11px 16px;/);
  assert.match(cells, /min-width:\s*6em;/);
  assert.match(cells, /text-align:\s*left;/);
  assert.match(cells, /border-bottom:\s*1px solid var\(--border\);/);
  const th = rule(c, ".wz-table thead th");
  assert.match(th, /font-weight:\s*600;/);
});

test("globals.css：浮窗那一套收到 14px/1.7（380px 宽塞不下稳智的全尺寸）", () => {
  const c = css();
  assert.match(rule(c, ".wz-compact"), /font-size:\s*14px;/);
  assert.match(rule(c, ".wz-compact"), /line-height:\s*1\.7;/);
  assert.match(rule(c, ".wz-compact .wz-md > *"), /margin-bottom:\s*12px;/);
  assert.match(rule(c, ".wz-compact .wz-h1"), /font-size:\s*16px;/);
  assert.match(rule(c, ".wz-compact .wz-table"), /font-size:\s*13px;/);
});

// ─── 2. 挂载点：组件只挂类名，不许再写死字号 ────────────────────────────

test("Markdown：容器换成 .wz-md，旧的 space-y-2/[&_p]:my-1 那一长串写死的密度清零", () => {
  const src = md();
  assert.match(src, /className="wz-md"/);
  assert.equal(/space-y-2 \[&_p\]:my-1/.test(src), false, "旧的「段间距 4px」是用户嫌密密麻麻的直接原因");
  assert.equal(/\[&_p\]:my-1|\[&_li\]:my-0\.5|\[&_td\]:px-1\.5/.test(src), false, "行距类全部交给 globals.css");
});

test("Markdown：标题挂 .wz-h、表格挂 .wz-table，正文标签由 p62 反向钉成「裸标签」", () => {
  const src = md();
  assert.match(src, /<h1 className="wz-h wz-h1">/);
  assert.match(src, /"wz-h " \+ \(level === 2 \? "wz-h2" : "wz-h3"\)/);
  assert.match(src, /<table className="wz-table">/);
  assert.equal(/text-\[13px\]|text-\[13\.5px\]|text-\[15px\]|text-\[16px\]/.test(src), false,
    "标题/正文/表格的字号一律来自 globals.css，组件里不再各写一套（写死就会和稳智那套漂）");
});

test("Markdown：ul/ol 本身不做二次链接识别（识别仍只在 li 那一层，P7-⑧② 口径）", () => {
  const src = md();
  const ul = src.slice(src.indexOf("function MdUl"), src.indexOf("}", src.indexOf("function MdUl")));
  assert.equal(/Linked/.test(ul), false, "ul 再包一次 Linked 会让同一片文字被换两次、点片段重影");
  assert.match(src, /function MdLi[\s\S]{0,120}<li><Linked>/);
});

// P61 这里原本钉两条：① 分区卡卡头 17px/700 + 卡体 .wz-md-plain；② AssistantPage 正文包在 .wz-answer 框里。
// 两条都被 P62 推翻（正文彻底去框），改由 p62-wz-bare-prose.test.ts 反向钉「这些类不许再出现」。

test("StepTimeline：进度那一行抬到 15px/600（稳智 .ai-execution-title 16px/600 档），整条 13px", () => {
  const src = read("src/components/desk/StepTimeline.tsx");
  assert.match(src, /className="min-w-0 flex-1 truncate text-\[15px\] font-semibold leading-snug"/);
});

test("小面板（随问浮窗 / 分析页正文 / 个股画像）挂 .wz-compact：全尺寸排版塞进窄箱会顶爆", () => {
  const mounts: Array<[string, RegExp]> = [
    ["src/components/desk/AssistantWidget.tsx", /className="wz-compact max-w-\[92%\] rounded-lg border/],
    ["src/components/desk/pages/AnalysisPage.tsx", /className="wz-compact desk-scroll max-h-\[280px\]/],
    ["src/components/desk/pages/ProfilePage.tsx", /className="wz-compact mt-2"/],
  ];
  for (const [file, re] of mounts) {
    assert.match(read(file), re, `${file} 里的 Markdown 容器要挂 .wz-compact（度量在 globals.css 一处定义）`);
  }
});
