// P50 字号与版式对齐稳智（2026-09-26 用户拍板）钉测
//
// 用户原话：「把每个菜单和里面的字体调大一点，然后铺满、挨着菜单的，参考稳智的字体。」
//
// 覆盖两件事：
//   1. 字号刻度对齐稳智源码实证值（aiwuchuan :root 的 --font-small/--font-body/--font-h3…），
//      标准 Tailwind 字号在 globals.css 的 @theme 里整体上调一档；页面里写死的 text-[Npx] 同步 +1px。
//   2. 各页面根容器不再「居中限宽」（mx-auto max-w-*），改成满宽 w-full —— 内容贴着侧栏铺满，
//      与 EventsPage 既有的「不再用居中限宽容器」口径统一。
//
// 一把尺子：口径钉在源码形状上，node --test 直跑零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// ─── 1. 字号刻度：globals.css 的 @theme 对齐稳智 ───────────────────────────

test("globals.css 把标准字号整体上调一档，对齐稳智刻度（small 13 / body 14 / h3 16）", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /--text-xs:\s*13px;/, "text-xs 12→13px（稳智 --font-small 13px）");
  assert.match(css, /--text-sm:\s*15px;/, "text-sm 14→15px");
  assert.match(css, /--text-base:\s*17px;/, "text-base 16→17px");
  assert.match(css, /--text-lg:\s*19px;/, "text-lg 18→19px");
  assert.match(css, /--text-2xl:\s*26px;/, "text-2xl 24→26px");
});

// ─── 2. 侧栏菜单：字号与行高整体放大 ──────────────────────────────────────

test("Sidebar 一级菜单：侧栏加宽到 w-64，菜单字号 15.5px、图标 19px、行高 py-3", () => {
  const src = read("src/components/desk/Sidebar.tsx");
  assert.match(src, /flex h-full w-64 shrink-0 flex-col/, "侧栏宽 240→256px，给放大的菜单留位");
  assert.match(src, /rounded-\[12px\] px-4 py-3 text-\[15\.5px\]/, "一级菜单 14→15.5px，行距同步放大");
  assert.match(src, /<Icon size=\{19\}/, "菜单图标 17→19px，跟字号一起放大");
});

test("Sidebar 次级菜单与「最近」区字号同步放大（14px）", () => {
  const src = read("src/components/desk/Sidebar.tsx");
  assert.match(src, /rounded-lg px-3\.5 py-2 text-left text-\[14px\]/, "次级页 12.5→14px");
  // 2026-09-30 同步判据：「最近」会话行改 pl-3 pr-8（右侧留悬停 ❌ 删除键的位），14px 未变——
  // 旧钉测写死 px-3 与现状失配（master 上即红，先于 P33 改动），按「同步判据不回滚写法」惯例修正
  assert.match(src, /rounded-lg py-2 pl-3 pr-8 text-left text-\[14px\]/, "「最近」会话 12.5→14px");
  assert.match(src, /text-\[17px\] font-semibold tracking-tight">Kairo/, "品牌名 15→17px");
});

// ─── 3. 页面铺满：不再居中限宽 ────────────────────────────────────────────

test("所有页面根容器都不再是「居中限宽」：pages/ 下 mx-auto max-w-* 清零", () => {
  const dir = path.join(process.cwd(), "src/components/desk/pages");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 20, "页面目录至少 20 个文件，尺子没扫错地方");
  const offenders = files.filter((f) => /mx-auto max-w-/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(offenders, [], "铺满口径：页面根容器不许再出现 mx-auto max-w-*（居中限宽）");
});

test("大盘情绪页铺满：MarketPage 根容器改满宽", () => {
  const src = read("src/components/desk/pages/MarketPage.tsx");
  assert.match(src, /<div className="w-full space-y-5 px-8 py-6">/, "市场情绪页根容器满宽");
});

test("LLM 分析页铺满：LlmAnalysisPage 去掉按 tab 分档的限宽三元式", () => {
  const src = read("src/components/desk/LlmAnalysisPage.tsx");
  assert.match(src, /<div className="w-full px-8 py-5">/, "LLM 分析页根容器满宽");
  assert.equal(/max-w-\[1800px\]|max-w-\[1500px\]/.test(src), false, "1800/1500 限宽分档清零");
});

test("对话页铺满：输入条满宽（P50）；消息流改居中窄栏（P62 照稳智的阅读栏）", () => {
  const src = read("src/components/desk/pages/AssistantPage.tsx");
  // P50 当初把消息流也拉满宽，是为了「贴侧栏、不留大片空白」。2026-09-27 P62 用户拿稳智截图复核后
  // 反向确认：正文满宽＝一行七八十个字，读起来最累的那一条就是它。所以正文收回居中 880px（.wz-col），
  // 「铺满」这条纪律只留在输入条上。
  assert.match(src, /<div className="wz-col space-y-6 px-6 py-6">/, "消息流＝居中窄栏 .wz-col");
  assert.equal(/mx-auto w-full max-w-6xl/.test(src), false, "输入条不再居中限宽");
});

test("量化选股工作台/行业板块/自选三页根容器满宽（贴侧栏）", () => {
  // 2026-09-29 用户实测：选股结果表「还得拉一下才能看完」。左右内边距 px-8 → px-3，
  // 把省下的横向空间让给表格（**满宽纪律不变**：仍是 w-full，仍禁止限宽居中）。
  const screener = read("src/components/desk/pages/ScreenerWorkbench.tsx");
  assert.match(screener, /<div className="w-full space-y-4 px-3 py-6">/, "选股工作台满宽（内边距收窄以容纳结果表）");
  assert.ok(!/mx-auto max-w-\d/.test(screener), "选股工作台不居中限宽");
  assert.match(read("src/components/desk/pages/SectorsPage.tsx"), /<div className="w-full space-y-4 px-6 py-4">/, "行业板块满宽");
  assert.match(read("src/components/desk/pages/WatchlistPage.tsx"), /<div className="w-full space-y-4 px-6 py-4">/, "自选页满宽");
});
