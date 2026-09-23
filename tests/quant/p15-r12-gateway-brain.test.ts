// R12 豆包专属大脑：网关通道身份卡 + 提问池号直读冻结池 回归测试。
//
// 背景（对应用户所见）：R11 走查实抓——网关通道（doubao2API 只转发最后一条 user 文本、
// 每轮都是豆包侧全新会话、没有任何 function call）里，模型对着回答编「我调用了
// candidate_pool，失败了」。用户拍板的方向：「用豆包的大脑，但数据在工作台」——
// 于是两件事：① 每轮把「工作台接入须知」折进发出文本（身份/无工具纪律/数据在哪/诚实口径）；
// ② 提问里点了完整池号时系统在预取侧就把那个冻结池读好送过去（不指望模型自取，它取不动）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyIntent, planDispatch, extractPoolIds, renderDispatchBlock } from "../../src/lib/desk/intent-core.ts";
import { foldHistoryForGateway, GATEWAY_BRAIN_BRIEF, FOLD_HEADERS } from "../../src/lib/llm/model-config-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

// ---------- 纯核：池号识别 ----------

test("extractPoolIds：只认完整池号（日期-universe-三位序号），universe 认中文/字母/下划线", () => {
  assert.deepEqual(extractPoolIds("帮我看看候选池 2026-09-22-全A-101 现在怎么样了"), ["2026-09-22-全A-101"]);
  assert.deepEqual(extractPoolIds("读 2026-09-11-all_a-901 这个池"), ["2026-09-11-all_a-901"]);
});

test("extractPoolIds：光提日期/说「那天的池」不算点号——宁可不读也不猜池（P13 同源纪律）", () => {
  assert.deepEqual(extractPoolIds("2026-09-22 复盘一下"), []);
  assert.deepEqual(extractPoolIds("昨天那个池子还行吗"), []);
  assert.deepEqual(extractPoolIds("2026-09-22-全A 这个池"), []); // 缺三位序号段不认
});

test("extractPoolIds：去重、按出现顺序、一轮最多两个（更多是刷屏不是提问）", () => {
  assert.deepEqual(extractPoolIds("2026-09-22-全A-101 和 2026-09-19-全A-104 都读一下"), [
    "2026-09-22-全A-101", "2026-09-19-全A-104",
  ]);
  assert.equal(extractPoolIds("2026-09-22-全A-101 和 2026-09-22-全A-101").length, 1);
  assert.equal(extractPoolIds("A 2026-01-01-x-001 B 2026-01-02-x-002 C 2026-01-03-x-003").length, 2);
});

// ---------- 纯核：预取计划把池读上 ----------

test("planDispatch：提问点了池号 → candidate_pool 进预取计划（带池号与理由，进步骤时间线）", () => {
  const intent = classifyIntent({ question: "帮我看看候选池 2026-09-22-全A-101 的名单" });
  const { calls } = planDispatch({ intent });
  const hit = calls.filter((c) => c.tool === "candidate_pool");
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].args, { pool_id: "2026-09-22-全A-101" });
  assert.match(hit[0].reason, /提问里点了池号/);
});

test("planDispatch：没点池号不白读（不带池号的提问一个 candidate_pool 步骤都不多）", () => {
  const intent = classifyIntent({ question: "今天大盘情绪怎么样" });
  const { calls } = planDispatch({ intent });
  assert.equal(calls.filter((c) => c.tool === "candidate_pool").length, 0);
});

test("planDispatch：奇门场景不掺池读——那条「本轮不取行情数」的纪律不因池号破例", () => {
  // 池号用 all_a 形态：全A 字样会命中「量化选股」触发词，场景先判成 screener 就测不到奇门口径了
  const intent = classifyIntent({ question: "奇门排盘看看这个局 2026-09-11-all_a-901" });
  assert.equal(intent.scene, "qimen", "奇门触发词在场，场景必须先判成奇门");
  const { calls, skipped } = planDispatch({ intent });
  assert.equal(calls.filter((c) => c.tool === "candidate_pool").length, 0);
  assert.ok(skipped.some((s) => s.includes("奇门排盘在「奇门解盘」面板本地实算")),"奇门 skip 留痕原样在");
});

test("注入块：candidate_pool 行按工具分块进「[系统按场景自动取数]」，缺池如实进未取到清单", () => {
  const block = renderDispatchBlock(
    [{ tool: "candidate_pool", ok: true, text: JSON.stringify({ 池号: "2026-09-22-全A-101", 名单: [{ 代码: "688825.SH" }] }) }],
    [{ tool: "candidate_pool", why: "候选池不存在：2026-01-01-全A-001" }],
  );
  assert.match(block, /\[系统按场景自动取数\][\s\S]*### candidate_pool/);
  assert.match(block, /\[本轮未取到的数据\][\s\S]*候选池不存在/);
});

// ---------- 网关身份卡：内容与送达 ----------

test("身份卡：无工具纪律/编过程=事故/没取到≠不存在/池号机制/人话收尾 五条全在册", () => {
  assert.match(GATEWAY_BRAIN_BRIEF, /你没有任何工具/);
  assert.match(GATEWAY_BRAIN_BRIEF, /「我调用了某工具 \/ 调用失败 \/ 系统反馈查询为空」/);
  assert.match(GATEWAY_BRAIN_BRIEF, /编过程和编数字一样是事故/);
  assert.match(GATEWAY_BRAIN_BRIEF, /\[系统按场景自动取数\]/); // 与 renderDispatchBlock 真实抬头一字不差
  assert.match(GATEWAY_BRAIN_BRIEF, /\[本轮未取到的数据\]/);
  assert.match(GATEWAY_BRAIN_BRIEF, /「没取到」不等于「不存在」/);
  assert.match(GATEWAY_BRAIN_BRIEF, /2026-09-22-全A-101/);
  assert.match(GATEWAY_BRAIN_BRIEF, /代码\/名称\/收盘价\/涨跌幅%\/入池时条件/); // R11 读法在卡里对账
});

test("折叠送达：身份卡作为 system 件排最前，折进网关唯一能吃的「最后一条 user」文本", () => {
  const msgs = [
    { role: "system" as const, content: GATEWAY_BRAIN_BRIEF },
    { role: "user" as const, content: "帮我看看候选池 2026-09-22-全A-101 的名单" },
  ];
  const folded = foldHistoryForGateway(msgs);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].role, "user");
  const text = folded[0].content;
  assert.ok(text.startsWith(FOLD_HEADERS.system), "system 段在折叠文本最前（先立身份）");
  assert.ok(text.indexOf("你没有任何工具") < text.indexOf("本轮问题"), "纪律先于问题到达");
});

test("proxy 接线：卡只给「网关模式 + 对话轮」，官方 API 模式一个字都不带（它对得上真工具）", () => {
  const routeSrc = readSrc("src/app/api/ai/proxy/route.ts");
  assert.match(routeSrc, /import \{[^}]*GATEWAY_BRAIN_BRIEF[^}]*\} from "@\/lib\/llm\/model-config-core"/);
  assert.match(routeSrc, /serverChannel\?\.mode === "gateway" && body\?\.scene \? \[\{ role: "system", content: GATEWAY_BRAIN_BRIEF \}\] : \[\]/);
});

test("时间线标签：candidate_pool 预取步有人话标签且带上池号（不是裸工具名）", () => {
  const dispatchSrc = readSrc("src/lib/desk/scene-dispatch.ts");
  assert.match(dispatchSrc, /candidate_pool: "读取已冻结候选池（择优素材，池序不是推荐）"/);
  assert.match(dispatchSrc, /call\.args\.pool_id/);
});
