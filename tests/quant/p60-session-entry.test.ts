// P60 会话入口语义（2026-09-27 用户拍板）：「首页提问一定要开新对话，点侧栏旧对话才继续旧的」
//
// 用户原话：每次在 AI 对话首页重新提问，就直接在旧对话里开启新对话；上下文堆得太长。
// 我可以自己在旧对话里聊（点侧栏「最近」），但首页点击时必须是新对话。
//
// 病灶实测：askInAssistant 只写 pendingAsk + 跳页，不动会话，而 use-chat 只在
// 「activeSessionId 指向的会话不存在」时才 newSession()（store.ts 那行 if 判断），
// 于是首页的第 2、3、4 个问题全落在同一条旧会话里越堆越长。
//
// 口径：入口决定语义 —— 跨页交接（首页 / 扫描页 / 选股台）= 新会话；
// 侧栏点旧会话 = 回到那条继续；对话页自己的输入框 = 在当前会话里续问。
//
// 尺子沿用本仓纪律：store 的 type 导入不带 .ts，node 直跑 import 不动它，
// 所以这里钉源码形状（与 p10 / p20 同一套），零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const store = () => read("src/lib/desk/store.ts");

/** 取出某个 action 的函数体（从 `name: (` 到它自己的收尾 `},`），用来判「这个动作里到底调没调」 */
function actionBody(src: string, name: string): string {
  const at = src.indexOf(`      ${name}: `);
  assert.ok(at >= 0, `store.ts 里找不到 action ${name}`);
  const end = src.indexOf("\n      },", at);
  assert.ok(end > at, `action ${name} 的函数体收不住`);
  return src.slice(at, end);
}

test("askInAssistant：交接前先 newSession()，且顺序在写 pendingAsk 之前", () => {
  const body = actionBody(store(), "askInAssistant");
  const rot = body.indexOf("get().newSession()");
  const pend = body.indexOf("pendingAsk: question");
  assert.ok(rot >= 0, "首页/扫描页的跨页交接必须先转新会话（否则问题落在旧会话尾巴上）");
  assert.ok(pend >= 0, "仍然要写 pendingAsk（对话页唯一的发送入口不变）");
  assert.ok(rot < pend, "先转会话再交接：反了会让 pendingAsk 先被上一轮消费掉");
});

test("askInAssistant：空问句仍然一个字都不交接、也不转会话", () => {
  const body = actionBody(store(), "askInAssistant");
  const guard = body.indexOf("if (!question) return;");
  assert.ok(guard >= 0, "空正文早退这条纪律不能丢");
  assert.ok(guard < body.indexOf("get().newSession()"), "早退要在新会话之前：空问句不该凭空多出一条会话");
});

test("askAiWithPool：选股台交接同样先转新会话（与首页同口径）", () => {
  const body = actionBody(store(), "askAiWithPool");
  const guard = body.indexOf("if (!h?.prompt.trim()) return;");
  const rot = body.indexOf("get().newSession()");
  assert.ok(rot >= 0, "候选池交接的是一句新问题，不该续在旧会话里");
  assert.ok(guard >= 0 && guard < rot, "空问句不转会话");
  assert.ok(body.indexOf("aiPoolHandoff: h") > rot, "转完会话再落交接");
});

test("newSession 自带「空会话复用」：连着从首页提问不会刷出一排空壳", () => {
  const body = actionBody(store(), "newSession");
  assert.match(body, /current && current\.messages\.length === 0\) return current\.id/,
    "当前会话还是空的就原地复用——这是「首页连问三次只多一条会话」的依据");
});

test("侧栏「最近」不转会话：点旧对话是回去继续，不是开新的", () => {
  const sidebar = read("src/components/desk/Sidebar.tsx");
  assert.match(sidebar, /switchSession\(r\.id\)/, "点击旧会话 = switchSession");
  assert.equal(/newSession\(/.test(sidebar), false, "侧栏绝不碰 newSession（P10 定的：点导航不清会话）");
});

test("对话页自己的输入框不转会话：在 copilot 里续问就是接着聊", () => {
  const page = read("src/components/desk/pages/AssistantPage.tsx");
  // 页面里 newSession 只允许出现在「新对话」按钮上；askInAssistant / pendingAsk 消费路径不得偷偷转会话。
  // 先剔掉整行注释再数：P8 那段「旧行为是挂载即 newSession()」的历史说明里带着这个调用名，
  // 把它当成调用点会误报（第一次写这测就栽在这儿）。
  const codeOnly = page
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  const calls = codeOnly.match(/newSession\(\)/g) ?? [];
  assert.equal(calls.length, 1, `AssistantPage 只该在「新对话」按钮上调 newSession()，实际 ${calls.length} 处`);
  assert.match(page, /onClick=\{\(\) => \{ newSession\(\); \}\}/, "「新对话」按钮仍然是显式动作，由用户点");
});
