// P53 「上游把思维链写进正文」护栏钉测（2026-09-27）
//
// 挡的是哪一个真实 bug：本机 dev server 真实发问「上证指数现在多少点」，抓包 `q1.txt` 共 875 个 delta 帧：
//
//   帧 1     信号块：市场情绪偏冷，风险等级偏高，建议观望为主。请结合真实数据给出你的判断。   ← 脚手架自述
//   帧 2–364 ### 我的分析 / 用户问上证指数点位。数据块里有… / 让我给出判断。… / 让我调用它。   ← 内心独白
//   帧 365   </think>                                                                      ← 思维链收尾标签
//   帧 366–  ### 🎯 核心判断——上证指数 3888.37 点…                                            ← 真答案
//
// 上游：AMD 网关 `DeepSeek-V4-Flash-Vision-Exp`（`delta.content` 里内联吐思维链，以 `</think>` 收口；
// 开场标签被上游吃掉，只剩收尾标签）。P52 的护栏只摘「文本最前面」的控制标签，`</think>` 在中途 → 整段原样流出。
//
// P53 补两层确定性判据（都在 answer-guard-core）：
//   A. 收尾标签切割：出现 `</think>` → 标签之前的一切都不是正文；只有开场标签未闭合 → 到此刻全是推理；
//   B. 推理叙述块判据：整块每行都是「用户问…/数据块…/让我…/### 我的分析/信号块：」这类自述 → 整块吃掉。
// 另一条踩坑：流式头护栏「判定过早」——脚手架段以 `\n\n` 收尾时立刻判定，会把被切开的「###」当正文先发出去。
//
// 一把尺子：口径钉在源码/函数形状上，node --test 直跑零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { stripScaffoldEcho, isScaffoldBlock, SCAFFOLD_ONLY_NOTICE } from "../../src/lib/desk/answer-guard-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

/** 复刻 route.ts 里 createHeadGuard 的判定链，验证「用户实际看到什么」（逐字流） */
function runHeadGuard(deltas: string[], opts?: { echoes?: string[] }): { text: string; warnings: number } {
  const RAW_FLUSH_MIN = 120;
  const RAW_FLUSH_CAP = 2000;
  let raw = "";
  let decided = false;
  let emitted = "";
  let warnings = 0;
  const decide = (final: boolean) => {
    if (decided) return;
    const g = stripScaffoldEcho(raw, opts);
    if (!final && (g.text.length < RAW_FLUSH_MIN || (!raw.endsWith("\n") && raw.length < RAW_FLUSH_CAP))) return;
    decided = true;
    raw = "";
    if (g.stripped) warnings++;
    emitted = g.text || (g.stripped ? SCAFFOLD_ONLY_NOTICE : "");
  };
  for (const d of deltas) {
    if (decided) { emitted += d; continue; }
    raw += d;
    if (raw.length >= RAW_FLUSH_CAP || /\n\s*\n/.test(raw) || raw.length >= RAW_FLUSH_MIN) decide(false);
  }
  decide(true);
  return { text: emitted, warnings };
}

// 真实 q1 的前半段（脚手架 + 内心独白 + </think> + 真答案开头），逐字拆帧
const Q1_LEAK = [
  "信号块：市场情绪偏冷，风险等级偏高，建议观望为主。请结合真实数据给出你的判断。\n\n",
  "### 我的分析\n\n",
  "用户问上证指数点位。数据块里有上证指数 3888.37，-1.22%。市场情绪偏冷，风险偏高。\n\n",
  "让我给出判断。需要结合市场整体状态。\n\n",
  "让我调用一些工具补充数据。实际上市场情绪数据已经有了。我可以引用它。\n\n",
  "让我看看是否需要调用工具。用户问的是上证指数点位，数据块已有。\n\n",
  "不过按指令，我应该结合真实数据。已有数据块足够回答。我可以补充调用 tdx_market_overview 交叉核对。\n\n",
  "让我调用它。</think>\n\n\n",
  "### 🎯 核心判断——上证指数 3888.37 点，今日跌 1.22%，市场整体偏冷、风险偏高，建议观望为主\n\n",
  "上证指数现报 **3888.37 点**，单日下跌 **1.22%**（来源：market_sentiment，2026-09-25 快照）。\n",
];

// ---------- 1. 收尾标签切割（判据 A） ----------

test("stripScaffoldEcho：整段内心独白 + </think> → 标签之前全剥，正文从真答案开始", () => {
  const g = stripScaffoldEcho(Q1_LEAK.join(""));
  assert.equal(g.text.trimStart().startsWith("### 🎯 核心判断——上证指数 3888.37 点"), true, "真答案没被切出来");
  assert.equal(g.text.includes("让我调用"), false, "内心独白没剥掉");
  assert.equal(g.text.includes("</think>"), false, "收尾标签没剥掉");
  assert.equal(g.text.includes("信号块："), false, "脚手架自述没剥掉");
  assert.ok(g.stripped.includes("让我调用它。"), "剥掉的内容要留痕");
});

test("stripScaffoldEcho：只有开场标签、还没收尾 → 返回空正文（流式下据此继续等，不把半截独白当答案）", () => {
  const g = stripScaffoldEcho("<think>\n用户问的是上证指数点位。让我先看数据块。");
  assert.equal(g.text, "", "未闭合的推理段被当成正文了");
  assert.notEqual(g.stripped, "", "剥了必须留痕");
});

test("stripScaffoldEcho：收尾标签贴在正文行首 → 只摘标签，正文一字不动（P52 旧口径不许回退）", () => {
  const g = stripScaffoldEcho("</think>**上证指数现在 3888.37 点**，跌 1.22%。");
  assert.equal(g.text, "**上证指数现在 3888.37 点**，跌 1.22%。");
  assert.equal(g.stripped, "</think>");
});

test("stripScaffoldEcho：同族标签（analysis/reasoning）一样认，不挑标签名", () => {
  assert.equal(stripScaffoldEcho("<analysis>\n</analysis>**结论：偏弱**").text, "**结论：偏弱**");
  assert.equal(stripScaffoldEcho("<scratchpad>\n</scratchpad>**结论：偏弱**").text, "**结论：偏弱**");
});

// ---------- 2. 推理叙述块判据（判据 B：没有标签时的兜底） ----------

test("stripScaffoldEcho：没有控制标签、整段都是独白 → 照样剥（全靠句式判据）", () => {
  const body = [
    "用户问上证指数点位。",
    "",
    "数据块里有上证指数 3888.37，-1.22%。市场情绪偏冷，风险偏高。",
    "",
    "让我给出判断。需要结合市场整体状态。",
    "",
    "### 🎯 核心判断——偏冷，建议观望",
    "",
    "上证指数现报 **3888.37 点**。",
  ].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.trimStart().startsWith("### 🎯 核心判断"), true, "独白没剥干净");
  assert.equal(g.text.includes("让我给出判断"), false);
});

test("stripScaffoldEcho：「### 我的分析」这种推理小节标题也算独白，整块吃掉", () => {
  const g = stripScaffoldEcho("### 我的分析\n\n让我看数据块。\n\n## 📊 当前状态\n\n**趋势结构：** 站上 MA20。");
  assert.equal(g.text.trimStart().startsWith("## 📊 当前状态"), true, "推理小节标题没剥掉");
});

test("isScaffoldBlock：多行独白块整块判真（每行都是自述线索）", () => {
  assert.equal(isScaffoldBlock(["让我先看数据块。", "用户问的是点位。", "实际上已有数据。"]), true);
  assert.equal(isScaffoldBlock(["## 📊 当前状态", "**趋势结构：** 站上 MA20。"]), false, "正常分节标题不该被判成脚手架");
});

// ---------- 2b. 分类器字段回显 / 注入块标题回显 / 提问回显（q4 实测形态） ----------

test("stripScaffoldEcho：模型自报的「分类器判定：… 分类器置信度：… 分类器提示：…」整行剥掉（q4 实测）", () => {
  const body = [
    " 分类器判定：市场环境问题。 分类器置信度：0.99。 分类器提示：市场环境类问题，请用市场环境框架回答。 数据块里没有情绪温度时，明确说「未取到当日情绪」，不要用印象补。",
    "",
    "上证指数现在 3888.37 点，跌 1.22%。",
  ].join("\n");
  const g = stripScaffoldEcho(body, { echoes: ["上证指数现在多少点？"] });
  assert.equal(g.text.trimStart().startsWith("上证指数现在 3888.37 点"), true, `剥后是「${g.text.slice(0, 30)}…」`);
  assert.equal(g.text.includes("分类器判定"), false);
});

test("stripScaffoldEcho：注入块标题被抄成 markdown 标题（### 市场情绪块）也算回显（q2 实测）", () => {
  const body = [
    "### 市场情绪块",
    "- 情绪温度 42.2/100 · 偏冷",
    "- 涨跌家数：上涨 1120 / 下跌 4306",
    "",
    "## 📊 结论",
    "",
    "偏冷，建议观望。",
  ].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.trimStart().startsWith("## 📊 结论"), true, "注入块标题没被当回显");
  assert.equal(g.text.includes("情绪温度 42.2"), false);
});

test("stripScaffoldEcho：把用户提问整句抄一遍的开头块剥掉（echoes 比对吃标点差异）", () => {
  const body = ["上证指数现在多少点", "", "上证指数现在 3888.37 点，跌 1.22%。"].join("\n");
  const g = stripScaffoldEcho(body, { echoes: ["上证指数现在多少点？"] });
  assert.equal(g.text.trimStart().startsWith("上证指数现在 3888.37 点"), true);
});

test("stripScaffoldEcho：没给 echoes 时不做回显比对（默认行为不变）", () => {
  const body = ["上证指数现在多少点？", "", "上证指数现在 3888.37 点，跌 1.22%。"].join("\n");
  assert.equal(stripScaffoldEcho(body).text, body);
});

test("stripScaffoldEcho：正文中段出现分类器字段不算开头脚手架（只剥开头）", () => {
  const body = "## 结论\n\n**判断：** 偏冷。\n\n补充：分类器判定的是市场环境，所以按环境口径回答。";
  const g = stripScaffoldEcho(body, { echoes: ["上证指数现在多少点？"] });
  assert.equal(g.text, body);
});

test("stripScaffoldEcho：强线索开场 + 多句自述（q2 残留形态）也剥，但带加粗标签的正文放行", () => {
  const leaked = [
    "用户问的是上证指数点位，请直接给出点位并给出风险等级结论。请用自然语言散文体输出，不要用列表。请用自然语言散文体输出，不要用列表。",
    "",
    "上证指数现在 3888.37 点。",
  ].join("\n");
  const g = stripScaffoldEcho(leaked);
  assert.equal(g.text.trimStart().startsWith("上证指数现在 3888.37 点"), true, `剥后是「${g.text.slice(0, 30)}…」`);
  // 真答案的第一行是加粗结论 —— 同样是「让我…」开场但带 `**`，一律放行
  const real = "让我把结论放最前面：**偏冷，建议观望**。\n\n再看量能。";
  assert.equal(stripScaffoldEcho(real).text, real, "带加粗标签的正文被误剥了");
});

test("stripScaffoldEcho：注入块标题后面接后缀也算回显（### 指数快照（东财口径））", () => {
  const body = ["### 指数快照（东财口径）", "- 上证指数 3888.37，-1.22%", "", "## 结论", "", "偏冷。"].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.trimStart().startsWith("## 结论"), true, "带后缀的注入块标题没被认出");
});

test("stripScaffoldEcho：只有水平线的头块算透明隔断，继续往下剥", () => {
  const body = ["---", "", "用户问的是点位。数据块里有 3888.37。", "", "## 结论", "", "偏冷。"].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.trimStart().startsWith("## 结论"), true, "水平线把头块扫描挡住了");
});

test("stripScaffoldEcho：中段自述单独成段也清掉（q7 实测：「让我调一下实时数据。」夹在两条答案之间）", () => {
  const body = [
    "## 📊 结论",
    "",
    "上证 3888.37 点，跌 1.22%。",
    "",
    "让我调一下实时数据。",
    "",
    "**翻译成白话：** 偏弱，建议观望。",
  ].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.includes("让我调一下实时数据"), false, "中段自述没被清掉");
  assert.equal(g.text.includes("上证 3888.37 点"), true, "正中段正文被误删");
  assert.equal(g.text.includes("**翻译成白话：**"), true, "加粗标签段被误删");
});

test("stripScaffoldEcho：中段的水平线 / 加粗列表一律不动（只清整段脚手架）", () => {
  const body = [
    "## 结论",
    "",
    "---",
    "",
    "- 📌 **仓位：** 5 成",
    "- ⚠️ **失效：** 跌破 1050",
  ].join("\n");
  assert.equal(stripScaffoldEcho(body).text, body);
});

test("stripScaffoldEcho：「决策信号：…信号块建议：…」整段剥掉（q7 实测头部形态）", () => {
  const body = [
    " 决策信号：观望/中性，风险等级：偏高，市场温度：42.2/100 偏冷。信号块提示：市场宽度偏弱。信号块建议：观望为主，等待市场企稳。",
    "",
    "上证指数现在 3888.37 点，跌 1.22%。",
  ].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.trimStart().startsWith("上证指数现在 3888.37 点"), true, `剥后是「${g.text.slice(0, 30)}…」`);
});

// ---------- 3. 误伤回归（正常答案一个字都不许动） ----------
test("stripScaffoldEcho：稳智式正常答案一字不动（含「一句话定性 / 分节 / 免责」）", () => {
  const body = [
    "📌 **一句话定性：** 不是现价追买的时点。",
    "",
    "## 📊 当前状态：反弹遇阻，中期尚未转强",
    "",
    "**趋势结构：** 现价 39.20 元，站上 10 日与 20 日均线。",
    "",
    "以上内容仅供参考，不构成投资建议。",
  ].join("\n");
  assert.equal(stripScaffoldEcho(body).text, body);
});

test("stripScaffoldEcho：正文中段引用「用户问的是」不算独白（只剥开头）", () => {
  const body = "## 结论\n\n**判断：** 偏冷。\n\n补充：用户问的是点位，我们给出 3888.37。";
  assert.equal(stripScaffoldEcho(body).text, body);
});

test("stripScaffoldEcho：「另外要注意风险」这类正文首句不许被当独白（单句只认强线索）", () => {
  const body = "另外要注意风险。\n\n## 盘面\n\n跌 1.22%。";
  assert.equal(stripScaffoldEcho(body).text, body);
});

test("stripScaffoldEcho：「我先看大盘」是模型写的正文，不剥（「我先」不在强线索里）", () => {
  const body = "我先看大盘。\n\n结论是偏冷。";
  assert.equal(stripScaffoldEcho(body).text, body);
});

// ---------- 4. 流式头护栏：真实帧流下「用户看到什么」 ----------

test("逐字流（真实 q1 帧序）：用户看到的第一行就是真答案，独白与标签一个字都不许漏出去", () => {
  const { text, warnings } = runHeadGuard(Q1_LEAK);
  assert.equal(text.trimStart().startsWith("### 🎯 核心判断——"), true, `用户看到的是「${text.slice(0, 40)}…」—— 独白漏出去了`);
  assert.equal(text.includes("让我"), false, "「让我…」独白漏到用户界面");
  assert.equal(text.includes("</think>"), false, "控制标签漏到用户界面");
  assert.equal(text.includes("信号块"), false, "脚手架自述漏到用户界面");
  assert.equal(warnings, 1, "剥了必须发一条 warning（不静默丢内容）");
});

test("逐字流：被切开的「###」不许当成正文先发出去（判定过早的坑）", () => {
  // 旧实现：脚手架段以 \n\n 收尾 → 立刻判定 → 把下一个 delta「###」当正文发出去，答案头被截断
  const { text } = runHeadGuard(["用户问的是点位。\n\n", "###", " 🎯 结论", "——偏冷，建议观望\n\n", "跌 1.22%。"]);
  assert.equal(text.trimStart().startsWith("###"), true, "标题残片被单独发出去过");
  assert.equal(text.includes("用户问的是"), false);
});

test("逐字流：整轮只有独白、没有正文 → 给一句如实话术，绝不空回也不放内部提示词", () => {
  const { text } = runHeadGuard(["用户问上证指数点位。\n\n", "数据块里有 3888.37。\n\n", "让我给出判断。"]);
  assert.equal(text, SCAFFOLD_ONLY_NOTICE);
});

test("逐字流：长脚手架块（自证标记挂在块尾）不许被前 120 字判成正文（q3 实测形态）", () => {
  const block = "市场情绪温度 42.2/100 · 偏冷 · 震荡行情（资金流缺读未计权，按可算项缩权）。涨跌家数：上涨 1120 / 下跌 4306 / 平盘 143，总数 5569。涨停 55 / 跌停 22。成交额 16691 亿。风险等级：偏高。指数：上证 3888.37 跌 1.22%，深证 13316.97 跌 2.34%，创业板 3288.95 跌 2.68%。【决策信号块结束】";
  assert.equal(block.length > 120, true, "这条要够长，才复现得出「前 120 字还没有标记」");
  const deltas = [
    ...block.match(/[\s\S]{1,8}/g)!.map((s) => s),
    "\n\n",
    "用户问上证指数现在多少点。数据块里已有上证指数价格。直接回答。\n\n",
    "上证指数现在 3888.37 点，跌 1.22%。\n\n",
    "这是 2026-09-25 的收盘快照（来源：market_sentiment）。\n",
  ];
  const { text } = runHeadGuard(deltas);
  assert.equal(text.trimStart().startsWith("上证指数现在 3888.37 点"), true, `用户看到的是「${text.slice(0, 40)}…」—— 长脚手架块漏判`);
  assert.equal(text.includes("决策信号块"), false);
  assert.equal(text.includes("用户问上证指数"), false);
});

test("逐字流：正常答案一字不差（含短答案，收尾时整段发出）", () => {
  const normal = "📌 **一句话定性：** 不是追买时点，主力资金持续净流出。\n\n## 📊 当前状态\n\n**趋势结构：** 站上 MA20，低于 MA60。\n\n以上内容仅供参考，不构成投资建议。";
  assert.equal(runHeadGuard([normal.slice(0, 40), normal.slice(40)]).text, normal);
  assert.equal(runHeadGuard(["**上涨趋势**，建议持有。"]).text, "**上涨趋势**，建议持有。");
});

// ---------- 5. 源码形状钉 ----------

test("answer-guard-core：收尾标签切割与「未闭合开场标签」两条判据都在源码里", () => {
  const src = read("src/lib/desk/answer-guard-core.ts");
  assert.match(src, /const THINK_CLOSE_RE = /, "收尾标签正则没了");
  assert.match(src, /function findThinkClose\(/, "收尾标签定位函数没了");
  assert.match(src, /else if \(THINK_OPEN_RE\.test\(body\)\) \{/, "未闭合开场标签的分支没了");
  assert.match(src, /const REASONING_LINE_RE = /, "内心独白行判据没了");
  assert.match(src, /function isReasoningLine\(/, "内心独白单行判据没了");
});

test("route.ts：流式头护栏非收尾时必须「清洗后正文够长」且「停在行边界」才判定", () => {
  const src = read("src/app/api/ai/chat/route.ts");
  assert.match(src, /if \(!final && \(g\.text\.length < RAW_FLUSH_MIN \|\| \(!raw\.endsWith\("\\n"\) && raw\.length < RAW_FLUSH_CAP\)\)\) return;/);
});
