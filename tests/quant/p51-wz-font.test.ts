// P51 字体对齐稳智（2026-09-27 用户拍板：「把字体也调成一样的」）钉测
//
// 用户原话：给了稳智（aiwuchuan.com）的账号，要求把本仓字体也调成跟稳智一样。
// 证据来源：登录后从站点直接取的静态资源（AiMatrixHome-BKMfPe6T.css / index-D-SymAuI.css），
// 逐条抄的是**实测声明**，不是观感推测：
//
//   index-D-SymAuI.css
//     body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,
//                          Hiragino Sans GB,Microsoft YaHei,sans-serif }
//     .text-mono { font-family: SF Mono,Monaco,Cascadia Code,Roboto Mono,Consolas,
//                                 Courier New,monospace !important }
//   AiMatrixHome-BKMfPe6T.css
//     .msg-content[data-v-a3f294f6] { font-size:15px; line-height:1.78; letter-spacing:.1px;
//                                     font-family:-apple-system,…,sans-serif }
//     .msg-content[data-v-a563c97c] { font-size:16px; line-height:1.82 }        ← 流式中
//     .msg.user .msg-content[data-v-eea4e7ec] { font-size:14px; line-height:1.7 } ← 用户气泡
//     .msg.md-table .msg-content[…] { font-family:ui-monospace,SFMono-Regular,Menlo,… }
//     .ai-execution-strip[data-v-f04f1d5c] { font-family:ui-sans-serif,-apple-system,… }
//   全站 @font-face 为空 → 稳智没有 webfont，纯系统字体栈。
//
// 一把尺子：口径钉在源码形状上，node --test 直跑零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const css = () => read("src/app/globals.css");

// ─── 1. 字体栈：与稳智逐项一致 ────────────────────────────────────────────

test("globals.css：--wz-sans 与稳智 body/.msg-content 的字体栈逐项一致", () => {
  assert.match(
    css(),
    /--wz-sans:\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*"PingFang SC",\s*"Hiragino Sans GB",\s*"Microsoft YaHei",\s*sans-serif;/,
    "必须是稳智那 7 项、顺序不变",
  );
});

test("globals.css：执行条用稳智 .ai-execution-strip 那套（ui-sans-serif 打头、含 Helvetica Neue / Arial）", () => {
  assert.match(
    css(),
    /--wz-strip:\s*ui-sans-serif,\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*"Helvetica Neue",\s*Arial,\s*"PingFang SC",\s*"Microsoft YaHei",\s*sans-serif;/,
  );
});

test("globals.css：等宽走稳智 .msg.md-table 那套（ui-monospace 打头）", () => {
  assert.match(
    css(),
    /--wz-mono:\s*ui-monospace,\s*SFMono-Regular,\s*Menlo,\s*Monaco,\s*Consolas,\s*"Liberation Mono",\s*"Courier New",\s*monospace;/,
  );
});

test("globals.css：html, body 用稳智同一串，且不再有 SF Pro Display / Helvetica Neue 在栈里", () => {
  const c = css();
  const block = c.slice(c.indexOf("html, body {"), c.indexOf("}", c.indexOf("html, body {")));
  assert.match(block, /font-family:\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*"PingFang SC",/, "body 栈与稳智一致");
  assert.equal(/SF Pro Display|SF Pro Text/.test(block), false, "稳智没有 SF Pro Display/Text，本仓也不该有（否则装了 SF Pro 的机器会单方面换字面）");
  assert.equal(/Helvetica Neue/.test(block), false, "稳智 body 栈句尾没有 Helvetica Neue / Arial");
});

test("globals.css：@theme 的 --font-sans/--font-mono 不再指向未定义的 --font-geist-*", () => {
  const c = css();
  assert.match(c, /--font-sans:\s*var\(--wz-sans\);/, "font-sans 工具类接上真实栈（原值是 var(--font-geist-sans)，本仓从未定义 → 声明恒无效）");
  assert.match(c, /--font-mono:\s*var\(--wz-mono\);/);
  assert.equal(/--font-geist-sans|--font-geist-mono/.test(c), false, "失效引用清零");
});

// ─── 2. 正文度量：流式态 / 最终态 / 用户气泡三套 ─────────────────────────

test("globals.css：.wz-msg 正文度量（P61 起与流式态同为 16px/1.82，另留 letter-spacing .1px + 数字等宽）", () => {
  const c = css();
  const blk = c.slice(c.indexOf(".wz-msg {"), c.indexOf("}", c.indexOf(".wz-msg {")));
  assert.match(blk, /font-family:\s*var\(--wz-sans\);/);
  // P51 原本抄的是 AiMatrixHome 的最终态 15px/1.78；P61（用户：「密密麻麻看着有点难受」）
  // 改抄 ai-matrix-content 的正文渲染层 .msg-content/.stream-content：16px/1.82，
  // 收口不再回落 15px，顺带消掉「流式→定稿字号跳一下」的抖动。
  assert.match(blk, /font-size:\s*16px;/, "正文 16px（稳智 ai-matrix 实测值）");
  assert.match(blk, /line-height:\s*1\.82;/);
  assert.match(blk, /letter-spacing:\s*0\.1px;/);
  assert.match(blk, /font-variant-numeric:\s*tabular-nums;/, "稳智正文数字等宽：行情数字上下对齐不跳");
});

test("globals.css：.wz-stream 抄稳智流式态 16px / 1.82", () => {
  const c = css();
  const blk = c.slice(c.indexOf(".wz-stream {"), c.indexOf("}", c.indexOf(".wz-stream {")));
  assert.match(blk, /font-size:\s*16px;/);
  assert.match(blk, /line-height:\s*1\.82;/);
});

test("globals.css：.wz-user-bubble 抄稳智用户气泡 15px / 1.75（P62 随正文一起放大一档）", () => {
  const c = css();
  const blk = c.slice(c.indexOf(".wz-user-bubble {"), c.indexOf("}", c.indexOf(".wz-user-bubble {")));
  assert.match(blk, /font-size:\s*15px;/);
  assert.match(blk, /line-height:\s*1\.75;/);
});

test("globals.css：.wz-strip 走 --wz-strip（执行条自带字体栈）", () => {
  const c = css();
  const blk = c.slice(c.indexOf(".wz-strip {"), c.indexOf("}", c.indexOf(".wz-strip {")));
  assert.match(blk, /font-family:\s*var\(--wz-strip\);/);
});

// ─── 3. 挂载点：正文跟着状态切度量、执行条带上执行条字体 ─────────────────

test("AssistantPage：AI 正文按 streaming 切 .wz-stream / .wz-msg，不再写死 16px/leading-8", () => {
  const src = read("src/components/desk/pages/AssistantPage.tsx");
  assert.match(
    src,
    /className=\{"min-w-0 flex-1 pt-1 text-foreground\/95 " \+ \(m\.streaming \? "wz-stream" : "wz-msg"\)\}/,
    "流式中 16/1.82、收口后 15/1.78 —— 度量本体在 globals.css",
  );
  assert.equal(/flex-1 pt-1 text-\[16px\] leading-8/.test(src), false, "旧的写死度量清零（行高 2.0 不是稳智的值）");
});

test("AssistantPage：用户气泡带 .wz-user-bubble（稳智 15px/1.75）", () => {
  const src = read("src/components/desk/pages/AssistantPage.tsx");
  assert.match(src, /rounded-3xl rounded-br-md bg-overlay-strong px-5 py-3 wz-user-bubble text-foreground/);
});

test("StepTimeline：执行条挂 .wz-strip（P61 把条内字号从 12px 抬到 13px，进度那一行 15px/600）", () => {
  const src = read("src/components/desk/StepTimeline.tsx");
  assert.match(src, /className="text-\[13px\] wz-strip"/);
  assert.match(src, /triggerClassName="text-\[13px\] wz-strip"/);
  assert.equal(/text-\[12px\] wz-strip/.test(src), false, "旧的 12px 清零：稳智 .ai-execution-title 是 16px/600 档");
});
