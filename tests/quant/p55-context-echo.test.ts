// P55 「注入上下文整段回显」护栏钉测（2026-09-27）
//
// 挡的是哪一个真实 bug：用户截图（06:19，/#/copilot，决策模式 + 超短）里助手气泡整屏都是——
//
//   - 02:33 以军袭击加沙多地 致多人受伤                          ← 注入快讯行被抄回
//   【用户持仓周期回注】回应（1天以内，日内或隔夜）。入场条件看分时/5 分钟 K 线…  ← 周期口径句被改头抄回
//   【系统写入实时行情快照】【行情上下文】（逐条标注来源分层：真实 2 条 / 派生 2 条）…
//   - 寒武纪（688256.SH）报价｜REAL｜真实数据：…最新价 1091.48 元（-1.05%）      ← 注入快照行被抄回
//
// 真答案一个字没有。q9 同参数 curl 复现是干净的 → 判据缺口不在传输、在「回显行」这类形态：
// 注入的快讯行/快照行不带任何脚手架标记，旧判据一行都抓不住。
//
// P55 补两处：
//   A. answer-guard-core：isEchoLine（整行照抄 ≥12 字 / 行内 24 字语料段覆盖过半）进 isScaffoldBlock，
//      语料 = opts.echoes（本轮用户原话，含注入的快照/快讯后缀）；
//   B. /api/ai/proxy：接入 head-guard-core（流式逐帧 + done + 退化掐上游）与非流式 JSON 同口径护栏。
//
// 一把尺子：误伤回归用 q9 真答案的代表行——护栏不许碰它一个字。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  stripScaffoldEcho, isScaffoldBlock, isEchoLine, SCAFFOLD_ONLY_NOTICE,
} from "../../src/lib/desk/answer-guard-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// 本轮注入件（与 AssistantPage.snapshot + fetchNewsBlock 同形状），作为 echoes 语料
const INJECTED = [
  "现在能不能买入？帮我看看",
  "",
  "<<系统注入·实时行情快照>>",
  "[行情快照·逐条标注来源分层]",
  "【行情上下文】（逐条标注来源分层：真实 1 条 / 派生 1 条）",
  "取数时刻（本机）：2026-09-27 06:19:41",
  "- 寒武纪（688256.SH）报价｜REAL｜真实数据：本机直连取到的原始值，可当事实引用",
  "    最新价 1091.48 元（-1.05%）",
  "- 寒武纪（688256.SH）技术面｜DERIVED｜派生数据：本机引擎对真实数据的计算，可引用但要说明是算出来的",
  "    多周期趋势: 15分=下行, 60分=上行, 日线=下行, 周线=上行；RSI: 15分 39, 60分 44, 日线 49, 周线 50",
  "【最新财经快讯】（本机直连实时获取）",
  "- 02:33 以军袭击加沙多地 致多人受伤",
  "- 02:10 美联储官员放鹰 美元指数走高",
  "用户的持仓周期偏好：超短（1 天以内，日内或隔夜）。入场条件看分时/5 分钟 K 线级别的突破与回踩、仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。",
].join("\n");
const OPTS = { echoes: [INJECTED] };

// q9 真答案的代表行（curl 实测 done.fullText）——误伤回归的尺子
const Q9_BODY = [
  "### 🎯 核心判断——一句话定性 + 建议立场",
  "",
  "**寒武纪（688256.SH）现在不是「能不能买」的问题——我的立场是：观望，不追高，等回踩确认。**",
  "",
  "现价 1091.48，跌 1.05%，换手 1.04%，量比 0.77（来源：stock_snapshot，通达信网关/腾讯快照）。量比 0.77 说明今天成交比近期均量还低，是**缩量阴跌**。",
  "- **时间尺度**：你的偏好是超短（1 天以内，日内或隔夜）。这个尺度下，寒武纪这种 6863 亿市值的高位品种，日内波动大但方向不明。",
].join("\n");

// ---------------------------------------------------------------- 1. 判据本体

test("isEchoLine：注入快讯行整行照抄 → 认", () => {
  const corpus = INJECTED;
  assert.equal(isEchoLine("- 02:33 以军袭击加沙多地 致多人受伤", corpus), true);
});

test("isEchoLine：注入快照行（带来源分层）整行照抄 → 认", () => {
  assert.equal(isEchoLine("- 寒武纪（688256.SH）报价｜REAL｜真实数据：本机直连取到的原始值，可当事实引用", INJECTED), true);
});

test("isEchoLine：改头抄写的口径句（24 字窗口覆盖过半）→ 认", () => {
  // 模型自己加了【用户持仓周期回注】的头，正文整段照抄周期口径
  assert.equal(
    isEchoLine("【用户持仓周期回注】回应（1天以内，日内或隔夜）。入场条件看分时/5分钟K线级别的突破与回踩、仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。", INJECTED),
    true,
  );
});

test("isEchoLine：短行（<12 字）与带 ** 的行一律不认", () => {
  assert.equal(isEchoLine("02:33", INJECTED), false);
  assert.equal(isEchoLine("- **时间尺度**：你的偏好是超短（1 天以内，日内或隔夜）。", INJECTED), false);
});

test("isEchoLine：真答案引用一句口径（最长公共段 ~11 字）→ 不认", () => {
  assert.equal(isEchoLine("你的偏好是超短（1 天以内，日内或隔夜）。这个尺度下，寒武纪这种高位品种日内波动大但方向不明。", INJECTED), false);
});

test("isEchoLine：空语料（没传 echoes）→ 判据关闭", () => {
  assert.equal(isEchoLine("- 02:33 以军袭击加沙多地 致多人受伤", ""), false);
});

// ---------------------------------------------------------------- 2. 整块剥离

test("整块全是注入快讯行 → 头部剥掉并留痕", () => {
  const text = "- 02:33 以军袭击加沙多地 致多人受伤\n- 02:10 美联储官员放鹰 美元指数走高\n\n### 🎯 核心判断\n\n观望。";
  const g = stripScaffoldEcho(text, OPTS);
  assert.equal(g.text, "### 🎯 核心判断\n\n观望。");
  assert.ok(g.stripped.includes("以军袭击加沙多地"));
});

test("快讯 + 改头口径句 + 快照行三段连抄 → 全剥，正文从结论开始", () => {
  const text = [
    "- 02:33 以军袭击加沙多地 致多人受伤",
    "【用户持仓周期回注】回应（1天以内，日内或隔夜）。入场条件看分时/5分钟K线级别的突破与回踩、仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。",
    "【系统写入实时行情快照】【行情上下文】（逐条标注来源分层：真实 2 条 / 派生 2 条）取数时刻（本机）：2026-09-27 06:19:41",
    "- 寒武纪（688256.SH）报价｜REAL｜真实数据：本机直连取到的原始值，可当事实引用",
    "    最新价 1091.48 元（-1.05%）",
    "",
    "### 🎯 核心判断",
    "",
    "观望，不追高。",
  ].join("\n\n");
  const g = stripScaffoldEcho(text, OPTS);
  // 中段清理保留空行结构（q7 时代拍板的口径），所以这里按「压平连续空行后逐字相等」断言
  assert.equal(g.text.replace(/\n{2,}/g, "\n\n").trim(), "### 🎯 核心判断\n\n观望，不追高。");
  assert.ok(g.stripped.length > 0);
});

test("中段插一段快照回显 → 中段整段清掉，前后正文不动", () => {
  const text = [
    "### 🎯 核心判断",
    "",
    "观望，不追高。",
    "",
    "- 寒武纪（688256.SH）报价｜REAL｜真实数据：本机直连取到的原始值，可当事实引用",
    "    最新价 1091.48 元（-1.05%）",
    "",
    "### 🧭 执行计划",
    "",
    "等回踩确认。",
  ].join("\n\n");
  const g = stripScaffoldEcho(text, OPTS);
  assert.ok(g.text.includes("观望，不追高。"));
  assert.ok(g.text.includes("等回踩确认。"));
  assert.ok(!g.text.includes("本机直连取到的原始值"));
});

test("整篇都是回显（没有任何正文）→ 空正文 + 留痕（调用方换兜底话术）", () => {
  const text = "- 02:33 以军袭击加沙多地 致多人受伤\n- 02:10 美联储官员放鹰 美元指数走高";
  const g = stripScaffoldEcho(text, OPTS);
  assert.equal(g.text, "");
  assert.ok(g.stripped.includes("以军袭击"));
  assert.ok(SCAFFOLD_ONLY_NOTICE.length > 0);
});

// ---------------------------------------------------------------- 3. 误伤回归（q9 真答案一字不动）

test("误伤回归：q9 真答案在 echoes 语料面前一字不动", () => {
  const g = stripScaffoldEcho(Q9_BODY, OPTS);
  assert.equal(g.text, Q9_BODY);
  assert.equal(g.stripped, "");
});

test("误伤回归：复述问题再作答的正常开头（问题 <24 字凑不满窗口）不剥", () => {
  const q = "帮我对比寒武纪和中芯国际谁的弹性更大";
  const body = "对比寒武纪和中芯国际谁的弹性更大：结论是寒武纪弹性更大，但回撤也更深。\n\n依据是……";
  const g = stripScaffoldEcho(body, { echoes: [q] });
  assert.equal(g.text, body);
});

test("误伤回归：没有 echoes 时中性行为与 P53 时代逐字一致", () => {
  const body = "两市缩量整理，创业板相对占优。\n\n正文。";
  const g = stripScaffoldEcho(body);
  assert.equal(g.text, body);
});

test("P57 契约：时间戳无句末标点的 bullet 是注入快讯形状，没有 echoes 也剥（q23 截图事故的根源形态）", () => {
  const g = stripScaffoldEcho("- 02:33 以军袭击加沙多地 致多人受伤\n\n正文。");
  assert.equal(g.text, "正文。");
});

test("误伤回归：isScaffoldBlock 多行块里混一行模型自己的话 → 不认", () => {
  const blk = [
    "- 02:33 以军袭击加沙多地 致多人受伤",
    "这一条对 A 股军工板块是情绪催化。",
  ];
  assert.equal(isScaffoldBlock(blk, OPTS), false);
});

// ---------------------------------------------------------------- 4. proxy 接线钉（源码形状）

test("proxy 路由：接了 head-guard-core 护栏（流式逐帧 + done + flush）", () => {
  const src = read("src/app/api/ai/proxy/route.ts");
  assert.match(src, /import \{ createHeadGuard \} from "@\/lib\/desk\/head-guard-core";/, "proxy 没接共享护栏");
  assert.match(src, /const guard = createHeadGuard\(rawEmit, \{ echoes: lastUserEcho \}\);/, "护栏没拿本轮原话当回显语料");
  assert.match(src, /const emit = guard\.emit;/, "出帧没过护栏");
  assert.match(src, /try \{ guard\.flush\(\); \} catch/, "run 结束没补收尾判定");
});

test("proxy 路由：退化命中掐上游（不再白烧到超时）", () => {
  const src = read("src/app/api/ai/proxy/route.ts");
  assert.match(src, /shouldStop\?: \(\) => boolean/, "callOpenAIStream 没有停止闸参数");
  assert.match(src, /if \(shouldStop\?\.\(\)\) \{ try \{ body\.destroy\?\.\(\); \} catch \{ \/\* 已断开 \*\/ \} break; \}/, "流循环里没有按闸掐上游");
  assert.match(src, /\(\) => guard\.isDegenerate\(\)/, "闸没接护栏的退化标志");
});

test("proxy 路由：非流式 JSON 同口径（剥头 + 判重复 + 留痕）", () => {
  const src = read("src/app/api/ai/proxy/route.ts");
  assert.match(src, /import \{ stripScaffoldEcho, SCAFFOLD_ONLY_NOTICE \} from "@\/lib\/desk\/answer-guard-core";/, "非流式没接剥头纯核");
  assert.match(src, /const pg = stripScaffoldEcho\(content, \{ echoes: lastUserEcho \}\);/, "非流式没用回显语料剥头");
  assert.match(src, /const pdg = detectRepetition\(content\);/, "非流式没判重复死循环");
  assert.match(src, /if \(pdg\.degenerate\) content = pdg\.kept \|\| "模型这一轮陷进了重复输出（没有产出可用的正文），已截断；请重试一次。";/, "非流式退化没换兜底话术");
});

test("共享护栏模块：判定链与 chat route 同口径（闸 + 行边界 + isDegenerate）", () => {
  const src = read("src/lib/desk/head-guard-core.ts");
  assert.match(src, /if \(!final && \(g\.text\.length < RAW_FLUSH_MIN \|\| \(!raw\.endsWith\("\\n"\) && raw\.length < RAW_FLUSH_CAP\)\)\) return;/, "过早收口闸丢了");
  assert.match(src, /if \(raw\.length >= RAW_FLUSH_CAP \|\| \/\\n\\s\*\\n\/\.test\(raw\) \|\| raw\.length >= RAW_FLUSH_MIN\) decide\(false\);/, "攒帧触发条件丢了");
  assert.match(src, /isDegenerate\(\): boolean \{ return degen !== null; \}/, "上游轮询的退化标志丢了");
  assert.match(src, /d\.fullText = fg\.text \|\| \(fg\.stripped \? SCAFFOLD_ONLY_NOTICE : finalRaw\);/, "done 留底口径丢了");
  assert.match(src, /const fg = stripScaffoldEcho\(finalRaw, opts\);/, "done 留底缺终检（中段清理）");
});

// ---------------------------------------------------------------- 5. 判据钉在纯核里（防被绕过）

test("answer-guard-core：回显判据在 isScaffoldBlock 里生效（单行 + 多行两条路）", () => {
  const src = read("src/lib/desk/answer-guard-core.ts");
  assert.match(src, /export function isEchoLine\(line: string, corpus: string\): boolean/, "isEchoLine 没导出");
  assert.match(src, /const corpus = echoCorpusOf\(opts\);/, "多行块没建语料");
  assert.match(src, /if \(corpus && nonEmpty\.every\(\(l\) => isEchoLine\(l, corpus\)\)\) return true;/, "多行块回显判据没接");
  assert.match(src, /return isEchoLine\(l, echoCorpusOf\(opts\)\);/, "单行块回显判据没接");
});

// ---------------------------------------------------------------- 6. q10 残留（退化 kept 的第一份本身是回显）

test("字段自报行（用户持仓周期/偏好/当前关注标的）→ 单行块认、多行块整块认", () => {
  assert.equal(isScaffoldBlock(["用户持仓周期：超短（1 天以内，日内或隔夜）"], OPTS), true);
  assert.equal(
    isScaffoldBlock([
      "用户持仓周期：超短（1 天以内，日内或隔夜）",
      "用户持仓偏好：日内分批，入场条件看分时/5 分钟 K 线级别的突破与回踩，仓位以日内为周期分批",
      "用户当前关注标的：688256.SH（寒武纪）",
    ], OPTS),
    true,
  );
});

test("误伤回归：正常答案说「你的偏好是超短…」不剥（行首不是字段自报）", () => {
  const g = stripScaffoldEcho("你的偏好是超短（1 天以内，日内或隔夜）。这个尺度下先观望。", OPTS);
  assert.equal(g.text, "你的偏好是超短（1 天以内，日内或隔夜）。这个尺度下先观望。");
});

test("两条路由的退化 kept 都再剥一次头（q10 残留的修法钉在源码上）", () => {
  const chat = read("src/app/api/ai/chat/route.ts");
  const shared = read("src/lib/desk/head-guard-core.ts");
  const pin = /const kg = stripScaffoldEcho\(v\.kept \|\| "", opts\);/;
  assert.match(chat, pin, "chat route 的退化 kept 没有复剥");
  assert.match(shared, pin, "共享护栏的退化 kept 没有复剥");
  const donePin = /head = kg\.text \|\| \(kg\.stripped \? "" : head\);/;
  assert.match(chat, donePin, "chat route 的 done 留底没有复剥 kept");
  assert.match(shared, donePin, "共享护栏的 done 留底没有复剥 kept");
});

// ---------------------------------------------------------------- 7. q11 残留（裸数字字段行 / 理由段 / 英文独白）

test("单字段裸数字自报（置信度：0.62）→ 认；文字值（交易周期：中线）→ 放行", () => {
  assert.equal(isScaffoldBlock(["置信度：0.62"], OPTS), true);
  assert.equal(isScaffoldBlock(["情绪温度：42.2"], OPTS), true);
  assert.equal(isScaffoldBlock(["交易周期：中线"], OPTS), false);
});

test("「理由：…」论证段 + 字段行整块 → 认", () => {
  assert.equal(isScaffoldBlock([
    "置信度：0.62",
    "理由：寒武纪当前处于高位震荡，量能萎缩，主力资金小幅净流入但力度有限，市场整体偏弱，建议观望等待更明确信号。",
  ], OPTS), true);
});

test("英文内心独白（Let me analyze this. The user wants…）→ 认", () => {
  assert.equal(isScaffoldBlock(["Let me analyze this. The user wants to know if they can buy 寒武纪 now."], OPTS), true);
  assert.equal(isScaffoldBlock(["Let me gather the data. I already have snapshot, kline, fund flow, news."], OPTS), true);
});

test("误伤回归：q9 真答案在全部新判据下仍一字不动", () => {
  const g = stripScaffoldEcho(Q9_BODY, OPTS);
  assert.equal(g.text, Q9_BODY);
  assert.equal(g.stripped, "");
});

// ---------------------------------------------------------------- 8. 截图第二轮（加粗管道行 / 方头括号注入头 / 改字回显）

test("加粗管道来源标注行（寒武纪（**688256.SH**）报价 | REAL |…）→ 认（在 ** 放行之前判）", () => {
  const line = "寒武纪（**688256.SH**）报价 | REAL | 真实数据：本机直连到的原始值，可当场真实引用 最新价 1091.48 元（-1.05%）";
  assert.equal(isScaffoldBlock([line], OPTS), true);
  assert.equal(isScaffoldBlock(["寒武纪（**688256.SH**）技术 | DERIVED | 派生数据：本机引擎对真实数据的计算，可引用但要说明是算出来的 多周期趋势：15 分＝下行，60 分＝上行"], OPTS), true);
});

test("方头括号注入头（【用户持仓周期偏好】/【系统注入_实时行情快照】）→ 认", () => {
  assert.equal(isScaffoldBlock(["【用户持仓周期偏好】超短（1 天以内，日内或隔周）。入场条件看分时/5 分钟 K 线级别的突破与回踩，仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。"], OPTS), true);
  assert.equal(isScaffoldBlock(["【系统注入_实时行情快照】行情快照·逐条标注来源分层 【行情上下文】（逐条标注来源分层：真实 2 条 / 派生 2 条）取数时刻（本机）：2026-09-27 06:44:51"], OPTS), true);
});

test("改字回显（隔夜→隔周、加【】壳）→ 连续两窗（≥48 字逐字）命中仍认", () => {
  const corpus = "用户的持仓周期偏好：超短（1 天以内，日内或隔夜）。入场条件看分时/5 分钟 K 线级别的突破与回踩、仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。";
  const line = "【用户持仓周期偏好】超短（1 天以内，日内或隔周）。入场条件看分时/5 分钟 K 线级别的突破与回踩，仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。";
  assert.equal(isEchoLine(line, corpus), true);
});

test("误伤回归：答案只复用短语（「跌破关键位再进场」）不认回显", () => {
  const corpus = "用户的持仓周期偏好：超短（1 天以内，日内或隔夜）。入场条件看分时/5 分钟 K 线级别的突破与回踩、仓位以日内为周期分批、失效条件是当日收盘跌破关键位，不要按数日的短线口径答。";
  assert.equal(isEchoLine("跌破关键位就先离场，别跟它耗。短线口径下仓位轻一点。", corpus), false);
});

test("两条路的回显语料都补了服务端注入件（模式口径 / 周期口径）", () => {
  const chat = read("src/app/api/ai/chat/route.ts");
  // 2026-09-29：链路研究档下服务端发的不是 MODE_NOTES[mode] 而是 CHAIN_MODE_OVERRIDE（见 modes.ts），
  // 所以语料必须跟着「实际下发的那份」走（modeNote = modeNoteFor(mode, chainResearch)）——
  // 语义从「一定含 MODE_NOTES」改成「含的必须是真下发的那一份」，否则命中链路档时护栏认不出被复述的注入件。
  assert.match(chat, /const modeNote = modeNoteFor\(mode, chainResearch\)/, "模式口径没走 modeNoteFor（链路档替换件下不来）");
  assert.match(chat, /const lastUserEcho = \[[\s\S]*?\bmodeNote\b[\s\S]*?HORIZON_NOTES\[horizon\][\s\S]*?\.filter\(\(s\) => s\.trim\(\)\)/, "chat route 语料缺注入件");
  const proxy = read("src/app/api/ai/proxy/route.ts");
  assert.match(proxy, /if \(md\?\.trim\(\)\) base\.push\(md\);[\s\S]*?if \(hz\) base\.push\(HORIZON_NOTES\[hz\]\);/, "proxy 语料缺注入件");
});

// ---------------------------------------------------------------- 9. q13 残留（指令回述句 / 竖线字段残段）

test("指令回述句（请用七维框架…/需要调用工具…/注意：用户持仓偏好…）→ 认", () => {
  assert.equal(isScaffoldBlock(["请用七维框架全面分析寒武纪（688256.SH），并给出可执行的入场计划。"], OPTS), true);
  assert.equal(isScaffoldBlock(["需要调用工具获取真实数据，不要凭印象。请按七维框架输出，每部分列出关键数据证明结论。"], OPTS), true);
  assert.equal(isScaffoldBlock(["注意：用户持仓偏好为超短（1天以内），入场条件为分时/5分钟K线级别的突破与回踩（具体价位等实盘数据）"], OPTS), true);
});

test("竖线字段残段（｜信号：观望）→ 认；误伤回归（「信号：观望」不带竖线的正文起段仍放行由别处判）", () => {
  assert.equal(isScaffoldBlock(["｜信号：观望"], OPTS), true);
});

test("误伤回归：q9 真答案在 q13 新判据下仍一字不动", () => {
  const g = stripScaffoldEcho(Q9_BODY, OPTS);
  assert.equal(g.text, Q9_BODY);
  assert.equal(g.stripped, "");
});

// ---------------------------------------------------------------- 10. q14 残留（信号块压缩成【维度】行）

test("信号块维度行（【市场环境】/【个股】/【资金】/【技术】/【消息面】）→ 认", () => {
  assert.equal(isScaffoldBlock([
    "【市场环境】上证 3888.37（-1.22%），深证 13316.97（-2.34%），创业板 3288.95（-2.68%）",
    "【个股】寒武纪（688256.SH）现价 688.00，涨跌幅 -4.00%，换手 2.5%，量比 1.2，主力净额 -2.1 亿",
    "【资金】近14日主力净额：-12.5 亿",
    "【技术】MACD 死叉，KDJ 死叉，RSI 42，均线空头排列",
    "【消息面】暂无相关新闻",
  ], OPTS), true);
});

test("「注意：用户问题里…系统已自动解析为…」系统注记回述 → 认", () => {
  assert.equal(isScaffoldBlock(["注意：用户问题里提到的「寒武纪」是公司简称，需要先解析成代码。系统已自动解析为 688256.SH，请按此代码分析。"], OPTS), true);
});

test("误伤回归：q9 真答案在 q14 新判据下仍一字不动", () => {
  const g = stripScaffoldEcho(Q9_BODY, OPTS);
  assert.equal(g.text, Q9_BODY);
  assert.equal(g.stripped, "");
});

// ---------------------------------------------------------------- 11. q17 拼接事故（兜底话术被拼在真正文前面）

test("两条护栏的兜底话术都押后（pendingNotice），不许中途拼在真正文前面", () => {
  const pin = /let pendingNotice = false;/;
  const pinDecide = /if \(emitted === SCAFFOLD_ONLY_NOTICE\) \{ pendingNotice = true; emitted = ""; \}/;
  const pinCancel = /if \(pendingNotice\) \{ pendingNotice = false; emitted = ""; \}/;
  const pinDone = /if \(pendingNotice\) \{ pendingNotice = false; emitted = SCAFFOLD_ONLY_NOTICE; emit\(\{ type: "delta", data: \{ content: emitted \} \}\); \}/;
  for (const f of ["src/app/api/ai/chat/route.ts", "src/lib/desk/head-guard-core.ts"]) {
    const src = read(f);
    assert.match(src, pin, `${f} 缺 pendingNotice 声明`);
    assert.match(src, pinDecide, `${f} decide 没押后兜底话术`);
    assert.match(src, pinCancel, `${f} 首个真正文没取消兜底话术`);
    assert.match(src, pinDone, `${f} done 时兜底话术没落地`);
  }
});

// ---------------------------------------------------------------- 12. q20 残留（周期置信度行 / 信号块摘要行）

test("压缩字段行（中期 1-3 周｜置信度：中）与信号摘要行（信号块摘要：…）→ 认", () => {
  assert.equal(isScaffoldBlock([
    "中期 1-3 周｜置信度：中",
    "信号块摘要：趋势强度偏弱，资金面偏弱，市场环境偏弱，整体信号偏弱，建议观望。",
  ], OPTS), true);
});

test("误伤回归：q9 真答案在 q20 新判据下仍一字不动", () => {
  const g = stripScaffoldEcho(Q9_BODY, OPTS);
  assert.equal(g.text, Q9_BODY);
  assert.equal(g.stripped, "");
});

// ---------------------------------------------------------------- 13. q23 截图（快讯清单整段抄回，头被改写 + 多编一条）

test("快讯清单回显：改写头（【最新短线快讯】）+ 语料内 bullet + 多编的 bullet → 整块剥", () => {
  const corpus = [
    "请用七维框架全面分析寒武纪。",
    "【最新财经快讯】（本机直连实时获取）",
    "- 07:30 系统谋划充实金融强国根基",
    "- 07:18 大摩指「平价」福耀「已超越其美」",
  ].join("\n");
  const echo = (j: string) =>
    [
      "【最新短线快讯】(本机直连实时获取)",
      "- 07:30 系统谋划充实金融强国根基",
      "- 07:18 大摩指「平价」福耀「已超越其美」",
      "- 06:30 伊麻亨利：雷尔木兹商谈开放取决于伊方条件是否满足",
    ].join(j);
  for (const j of ["\n", "\n\n"]) {
    const g = stripScaffoldEcho(echo(j), { echoes: [corpus] });
    assert.equal(g.text, "", `joiner=${JSON.stringify(j)} 没剥干净`);
  }
  const g2 = stripScaffoldEcho(echo("\n\n") + "\n\n### 🎯 核心判断\n\n观望。", { echoes: [corpus] });
  assert.equal(g2.text, "### 🎯 核心判断\n\n观望。");
});

test("误伤闸：时间轴交易计划 bullet（句末带。）不剥；正文引用一条快讯不剥", () => {
  const plan = "📌 **可执行的观察方案：**\n- **09:30 开盘观察量能。**\n- **10:00 首次回踩确认。**\n- **14:30 尾盘定方向。**";
  const g = stripScaffoldEcho(plan, OPTS);
  assert.equal(g.text, plan);
  const corpus = "- 07:30 系统谋划充实金融强国根基";
  const g2 = stripScaffoldEcho("📌 **一句话定性：** 观望。\n\n消息面上，07:30 系统谋划充实金融强国根基这一条与板块相关，但力度有限。", { echoes: [corpus] });
  assert.ok(g2.text.includes("一句话定性") && g2.stripped === "");
});

// ---------------------------------------------------------------- 14. q24 残留（编造注入块 + 行情字段段 + 重复 kept）

test("编造注入块（【系统注入·个股快照】+ 行情字段段）→ 整块剥；正文行情段一字不动", () => {
  const fabricated = [
    "【系统注入·个股快照】",
    "寒武纪（688256.SH）最新行情：收盘 588.00 元，当日 -4.58%，换手率 2.12%，成交额约 57.6 亿元，总市值约 2455 亿元。",
  ].join("\n");
  const g = stripScaffoldEcho(fabricated, { echoes: ["请用七维框架全面分析寒武纪。"] });
  assert.equal(g.text, "");
  const legit = "📌 **一句话定性：** 观望。\n\n最新行情行为 2026-09-24 收盘数据：收盘 1091.48 元，当日 -1.05%，换手率 1.04%，成交额约 72.1 亿元，总市值约 6863.8 亿元。";
  const g2 = stripScaffoldEcho(legit, { echoes: ["请用七维框架全面分析寒武纪。"] });
  assert.equal(g2.text, legit);
});
