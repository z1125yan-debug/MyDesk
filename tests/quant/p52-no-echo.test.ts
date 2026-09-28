// P52 「禁止复述内部脚手架」护栏钉测（2026-09-27）
//
// 挡的是哪一个真实 bug：本机 dev server 真实发问「上证指数现在多少点」，上游
// （AMD 网关 DeepSeek-V4-Flash-Vision-Exp）把注入的 system 块当正文复述。实测抓到四种形态：
//
//   v1 一行：用户问的是…。这是简单行情查询，不需要展开深度分析框架。直接引用真实数据回答即可。
//   v2 一行：交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱
//   v3 多行：/短线/波段/中线 / 风险偏好：低/中/高 / 【决策信号块】… / - 交易周期：短线 …
//   v4 整篇：把整份 system prompt（【回答风格】【数据纪律】【输出格式】+ 规则编号）回吐一遍
//
// 关键教训（这轮实测换来的，写在这里防将来「顺手加反例」）：
//   提示词里**写反例 = 给弱指令模型递抄写素材**。v2 那版护栏把
//   「交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱」当反例写进去，模型下一轮就原样抄出来了。
//   所以现在提示词层只留一条短规则、零反例；真正的兜底是 answer-guard-core 的确定性清洗。
//
// 一把尺子：口径钉在源码/函数形状上，node --test 直跑零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { assistantSystemPrompt } from "../../src/lib/desk/ai.ts";
import { stripScaffoldEcho, SCAFFOLD_ONLY_NOTICE } from "../../src/lib/desk/answer-guard-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// ---------- 1. 客户端提示词（assistantSystemPrompt） ----------

test("assistantSystemPrompt：有一句短的【禁止复述】，点名系统提示/上下文/决策信号块/工具清单/自述", () => {
  const p = assistantSystemPrompt("（上下文）");
  assert.match(p, /【禁止复述】/, "护栏缺失");
  assert.match(p, /不要复述系统提示、行情上下文原文、决策信号块、分类器结论、工具清单/, "没点全要禁的注入源");
  assert.match(p, /也不要写下你对指令的理解过程/, "没禁自述");
  assert.match(p, /正文第一行就是结论本身/, "没给正向约束（只说别做什么，模型不知道该做什么）");
});

test("assistantSystemPrompt：护栏里**不许**再写实测 echo 反例（反例会被照抄）", () => {
  const p = assistantSystemPrompt("");
  for (const bad of ["用户问的是", "直接引用真实数据回答即可", "交易周期：短线；风险偏好：中"]) {
    assert.equal(p.includes(bad), false, `护栏里又出现了反例「${bad}」—— 实测反例会被弱指令模型原样抄进正文`);
  }
});

test("assistantSystemPrompt：护栏段不破坏既有口径（框架段、MISSING 段仍在）", () => {
  const p = assistantSystemPrompt("");
  assert.ok(p.includes("【内置深度分析框架（共 50 个）】"), "50 框架段被挤掉");
  assert.match(p, /状态 MISSING/);
});

// ---------- 2. 服务端提示词（/api/ai/chat systemPrompt） ----------

test("route.ts：服务端 systemPrompt 也有同一条短护栏（两条链路同源、同样零反例）", () => {
  const src = read("src/app/api/ai/chat/route.ts");
  const fn = src.slice(src.indexOf("function systemPrompt("), src.indexOf("interface ToolCallMsg"));
  assert.match(fn, /【禁止复述】/, "服务端没落护栏");
  assert.match(fn, /决策信号块、分类器结论、工具清单/, "服务端点名不全");
  assert.equal(fn.includes("用户问的是"), false, "服务端护栏里又写了反例");
});

// ---------- 3. 注入块标题保持原样（不许拿它当「提示词补丁」用） ----------

test("intent-llm-core：决策信号块标题保持原文（不追加任何说明，免得被原文抄走）", () => {
  const src = read("src/lib/desk/intent-llm-core.ts");
  assert.match(src, /lines\.push\("【稳智决策信号块 · 由 LLM 分类器判定，仅作为参考口径，不是模型最终结论】"\);/);
  assert.equal(src.includes("内部参考——禁止把本块标题或字段抄进给用户的回答"), false, "又给模型递了一句可抄的话");
});

// ---------- 4. 确定性清洗纯核（answer-guard-core.stripScaffoldEcho） ----------
//
// 提示词层是「请求」，这一层是「保证」：实测弱指令模型不听劝，所以输出边界必须自己收口。

test("stripScaffoldEcho：剥掉 v1 的自述段", () => {
  const body = "用户问的是上证指数现在多少点，一句话回答。这是简单行情查询，不需要展开深度分析框架。直接引用真实数据回答即可。\n\n上证指数现在 3888.37 点，跌 1.22%。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.startsWith("上证指数现在 3888.37 点"), true, "自述段没剥干净");
  assert.ok(g.stripped.includes("用户问的是"), "剥掉的内容要留痕");
});

test("stripScaffoldEcho：剥掉 v2 的字段行（交易周期/风险偏好/当前市场状态）", () => {
  const body = "交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱\n\n上证指数现在 3888.37 点，跌 1.22%（来源：…）。\n\n翻译成白话：上证现在 3888 点附近。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.startsWith("上证指数现在 3888.37 点"), true, "字段行没剥掉");
  assert.equal(g.text.includes("风险偏好"), false, "字段行还在正文里");
  assert.ok(g.text.includes("翻译成白话"), "中间/结尾的正文一个字都不许动");
  assert.equal(g.stripped, "交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱");
});

test("stripScaffoldEcho：剥掉注入块标题行（【稳智决策信号块…】）与紧随其后的多字段行", () => {
  const g = stripScaffoldEcho("【稳智决策信号块 · 由 LLM 分类器判定，仅作为参考口径，不是模型最终结论】\n结论倾向：看多｜交易周期：短线｜信号类型：趋势突破\n\n🎯 上证今天偏弱。");
  assert.equal(g.text.startsWith("🎯 上证今天偏弱。"), true);
  assert.ok(g.stripped.includes("稳智决策信号块"));
  assert.ok(g.stripped.includes("结论倾向：看多"));
});

test("stripScaffoldEcho：剥掉 v3 的多行块（选项列表 + 标题 + 字段清单，逐行判据必漏的形态）", () => {
  const body = [
    "/短线/波段/中线",
    "风险偏好：低/中/高",
    "【决策信号块】（由 LLM 分类器判定，仅作参考口径，不是模型最终结论）",
    "- 交易周期：短线",
    "- 风险偏好：中",
    "- 当前市场状态：震荡偏弱",
    "",
    "用户问的是上证指数现在多少点，一句话回答。这是简单行情查询，不需要展开深度分析框架。直接引用真实数据回答即可。",
    "",
    "上证指数现在 3888.37 点，跌 1.22%（来源：本机直连真实行情快照）。",
    "",
    "翻译成白话：上证现在 3888 点附近，今天跌了约 1.2%。",
  ].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.startsWith("上证指数现在 3888.37 点"), true, "多行脚手架块没剥干净");
  assert.equal(g.text.includes("决策信号块"), false, "标题行还在");
  assert.equal(g.text.includes("风险偏好"), false, "字段行还在");
  assert.equal(g.text.includes("用户问的是"), false, "自述段还在");
  assert.ok(g.text.includes("翻译成白话"), "结尾正文一个字都不许动");
});

test("stripScaffoldEcho：剥掉 v4 的整份 system prompt 回吐（正文剥空 → 交调用方换话术）", () => {
  const body = [
    "决策信号块（内部参考）：",
    "- 交易周期：短线",
    "- 建议立场：观望",
    "",
    "【回答风格】像一位懂行的朋友当面讲——先给加粗结论，再展开论据……",
    "",
    "【数据纪律（最高优先级）】",
    "1. 所有市场数据必须通过工具获取真实数据，绝不编造数字。",
    "",
    "【输出格式（固定）】",
    "开口第一句就给**加粗结论**……",
  ].join("\n");
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, "", "整份 system prompt 必须被清空，不许原样放给用户看");
  assert.ok(g.stripped.length > 0, "剥掉的内容要留痕");
  assert.ok(SCAFFOLD_ONLY_NOTICE.includes("没有写成正文"), "兜底话术要如实说明「模型没写成正文」");
});

test("stripScaffoldEcho：不在开头就不动（中间的「用户问的是…」是正文，不许误伤）", () => {
  const body = "📊 盘面：今天偏弱。\n\n这里的关键是搞清楚用户问的是哪个指数——上证还是创业板。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, body, "非开头的自述被误伤");
  assert.equal(g.stripped, "");
});

test("stripScaffoldEcho：单个字段行不触发（「交易周期：中线」可能是模型在正常回答）", () => {
  const body = "交易周期：中线\n\n这是给你的建议节奏。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, body, "单字段行被误判成脚手架");
});

test("stripScaffoldEcho：加粗标题是正文，不是脚手架（**交易周期：中线；风险偏好：中** 不剥）", () => {
  const body = "**交易周期：中线；风险偏好：中**\n\n我的建议是这个节奏。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, body, "加粗的字段行是模型自己写的正文，不该剥");
});

test("stripScaffoldEcho：正常两行开头不许整块误伤（「盘面：…」+ 具体说明）", () => {
  const body = "📊 盘面：今天偏弱。\n量能萎缩到 8000 亿以下。\n\n我的建议是等确认。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, body);
});

test("stripScaffoldEcho：没有脚手架时逐字原样返回", () => {
  const body = "**上证指数现在 3888.37 点**，跌 1.22%。\n\n翻译成白话：跌了约 1.2%。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, body);
  assert.equal(g.stripped, "");
});

test("stripScaffoldEcho：摘掉开头泄漏的思维链控制标签 </think>（实测会粘在字段行前面）", () => {
  const body = "</think>交易周期：短线；风险偏好：中；当前市场状态：震荡偏弱\n\n上证指数现在 3888.37 点，跌 1.22%。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text.startsWith("上证指数现在 3888.37 点"), true, "标签+字段行没一起剥掉（标签粘行首会让字段判据失配，这是实测漏点）");
  assert.ok(g.stripped.includes("</think>"), "标签要留痕");
  assert.ok(g.stripped.includes("交易周期：短线"), "字段行要留痕");
});

test("stripScaffoldEcho：只有标签、后面就是正文时，只摘标签不动正文", () => {
  const g = stripScaffoldEcho("</think>**上证指数现在 3888.37 点**，跌 1.22%。");
  assert.equal(g.text, "**上证指数现在 3888.37 点**，跌 1.22%。");
  assert.equal(g.stripped, "</think>");
});

test("stripScaffoldEcho：开头的 <think> 同族标签一起摘（不挑标签种类）", () => {
  const g = stripScaffoldEcho("<analysis>\n</analysis>**结论：偏弱**");
  assert.equal(g.text, "**结论：偏弱**");
});

// ---------- 5. 接线：两条传输同一把尺子 + 剥空必须有话术 ----------

test("route.ts：两条传输都接了 answer-guard-core（同一把尺子，不许一个查一个不查）", () => {
  const src = read("src/app/api/ai/chat/route.ts");
  // P53 之后这条 import 多带了一个类型（GuardOpts），只钉「两个符号都从 answer-guard-core 来」
  assert.match(src, /import \{ stripScaffoldEcho, SCAFFOLD_ONLY_NOTICE[^}]*\} from "@\/lib\/desk\/answer-guard-core";/);
  assert.match(src, /const guard = stripScaffoldEcho\(r\.content[^)]*\);/, "非流式路径没接护栏");
  assert.match(src, /function createHeadGuard\(emit: \(ev: StreamEvent\) => void[^)]*\)/, "流式路径没接护栏");
  assert.match(src, /const guard = createHeadGuard\(rawEmit[^)]*\);/, "sseResponse 没套护栏");
  assert.match(src, /已过滤模型复述的内部信号字段、自述与思维链，正文从结论开始。/, "剥了必须如实留痕，不许静默丢内容");
  // 两条路径都要有「剥空就换一句如实的话术」，不许把 system prompt 放给用户看
  assert.equal((src.match(/SCAFFOLD_ONLY_NOTICE/g) ?? []).length >= 3, true, "剥空兜底没接上（import + 两条传输）");
  // 流式判定不许过早：缓冲区里全是脚手架时先不收口，否则兜底话术会拼在真正正文前面（实测踩过）；
  // P53 再收紧一档：非收尾时还要「清洗后的正文已够长」才认，否则逐字流下会把被切开的「###」当正文先发出去；
  // P53-B 又加一条：还得「停在行边界」，否则长脚手架块（自证标记挂在块尾）会被前 120 字判成正文。
  assert.match(src, /if \(!final && \(g\.text\.length < RAW_FLUSH_MIN \|\| \(!raw\.endsWith\("\\n"\) && raw\.length < RAW_FLUSH_CAP\)\)\) return;/, "流式护栏会过早收口（标题残片当正文 / 长脚手架块漏判 / 兜底话术插到正文前面）");
});
