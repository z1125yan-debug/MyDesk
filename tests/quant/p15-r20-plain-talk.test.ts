// P15-R20「说人话 + 说两面」钉测（用户反馈：AI 输出太黑话、分析太片面）。
//
// 钉的是三条最容易漂的东西：
//  1. 两份口径句的内容——黑话替换表真的给了对照（只说「避免术语」模型不知道换成什么），
//     片面那四条封的是四种典型形态（顺边挑数 / 单因推论 / 没有失效条件 / 缺失当利空）；
//  2. 三条下发口（chat 工具端点、proxy 纯对话端点、客户端直连 assistantSystemPrompt）
//     都真的挂了同一常量——漏一处，那一处的用户就永远看不到改善；
//  3. proxy 那处的生效条件仍是「只认带 scene 的对话轮」：研究页/自检那种一次一问的转发
//     不能被塞进一堆交易口径（这条是 P11 就钉死的边界，加内容不许把它放开）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOTH_SIDES_NOTE, PLAIN_AND_BALANCED_NOTE, PLAIN_TALK_NOTE } from "../../src/lib/desk/plain-talk.ts";

const CHAT_ROUTE = readFileSync(new URL("../../src/app/api/ai/chat/route.ts", import.meta.url), "utf8");
const PROXY_ROUTE = readFileSync(new URL("../../src/app/api/ai/proxy/route.ts", import.meta.url), "utf8");
const AI_LIB = readFileSync(new URL("../../src/lib/desk/ai.ts", import.meta.url), "utf8");

test("说人话：给的是黑话替换对照表，不是一句空泛的「请说人话」", () => {
  // 实测：只写「避免专业术语」模型不知道该换成什么，给了对照它才照做。
  for (const jargon of ["量比", "换手率", "委比", "内外盘", "主力净额", "筹码集中度", "多头排列", "缩量回踩", "背离", "支撑", "压力", "板块轮动"]) {
    assert.ok(PLAIN_TALK_NOTE.includes(jargon), `替换表缺「${jargon}」`);
  }
  // 每条对照都得真的写出「它是什么意思」，不能只列个词
  assert.match(PLAIN_TALK_NOTE, /量比 → 今天到现在成交的量/);
  assert.match(PLAIN_TALK_NOTE, /主力净额 → 按单笔成交金额分档粗算/);
});

test("说人话：术语不许当结论；不可验证的词不许当论据；白话翻译行不许有术语", () => {
  assert.match(PLAIN_TALK_NOTE, /术语不许当结论/);
  assert.match(PLAIN_TALK_NOTE, /情绪 \/ 分歧 \/ 承接 \/ 修复 \/ 退潮/, "这几个词无法用数字验证，要单独点名");
  assert.match(PLAIN_TALK_NOTE, /翻译成白话：……」里一个术语都不许出现/);
  assert.match(PLAIN_TALK_NOTE, /每段不超过 2 个/, "术语密度要有上限，否则等于没换");
});

test("说两面：四种片面形态逐条封死", () => {
  assert.match(BOTH_SIDES_NOTE, /反对它的证据/, "①只报顺边");
  assert.match(BOTH_SIDES_NOTE, /不许只靠一个维度下结论/, "②单因推论");
  assert.match(BOTH_SIDES_NOTE, /就说明我这个判断错了/, "③没有失效条件＝不可证伪");
  assert.match(BOTH_SIDES_NOTE, /把「没查到」和「没有」分开/, "④缺失被当成利空/利多");
  assert.match(BOTH_SIDES_NOTE, /时间尺度要写清/, "用一天数据下中线结论也算以偏概全");
});

test("两条口径一起拼：一份常量，不留「只挂了其中一条」的缝", () => {
  assert.equal(PLAIN_AND_BALANCED_NOTE, `${PLAIN_TALK_NOTE}\n\n${BOTH_SIDES_NOTE}`);
  assert.ok(PLAIN_AND_BALANCED_NOTE.length > 800, "内容被改短了多半是被误删");
});

test("接线：三条下发口都挂了同一常量", () => {
  for (const [name, src] of [
    ["/api/ai/chat", CHAT_ROUTE],
    ["/api/ai/proxy", PROXY_ROUTE],
    ["assistantSystemPrompt", AI_LIB],
  ] as const) {
    assert.match(src, /PLAIN_AND_BALANCED_NOTE/, `${name} 没挂说人话/说两面`);
    assert.match(src, /from\s+"[^"]*plain-talk/, `${name} 没从 plain-talk 引入（别本地再抄一份）`);
  }
});

test("proxy：说人话/说两面只给带 scene 的对话轮（P11 边界不许因为加内容而放开）", () => {
  assert.match(PROXY_ROUTE, /body\?\.scene \? PLAIN_AND_BALANCED_NOTE : ""/, "生效条件必须是带 scene 的对话轮");
  // FOLLOWUP_NOTE 的老口径没被顺手改掉
  assert.match(PROXY_ROUTE, /body\?\.scene \? FOLLOWUP_NOTE : ""/);
});

test("chat 端点：说人话/说两面挂在格式段之前（模型对 system 中后部的遵循度更高，别丢在最末尾）", () => {
  const iPlain = CHAT_ROUTE.indexOf("PLAIN_AND_BALANCED_NOTE,");
  const iFormat = CHAT_ROUTE.indexOf("【输出格式（固定）】");
  assert.ok(iPlain > 0 && iFormat > 0, "两处锚点都要在");
  assert.ok(iPlain < iFormat, "说人话/说两面应在输出格式段之前");
  // 也不能早到被【数据纪律】盖过去：挂在【禁止复述】之后
  assert.ok(iPlain > CHAT_ROUTE.indexOf("【禁止复述】"), "应在【禁止复述】之后");
});

test("决策骨架本身也要求两侧证据（光靠通用口径不够，骨架里不写模型会漏）", async () => {
  const { MODE_NOTES } = await import("../../src/lib/desk/modes.ts");
  assert.match(MODE_NOTES.decision, /强的一面和弱的一面/);
  assert.match(MODE_NOTES.decision, /它在全市场\/所属板块里的相对位置/, "至少覆盖哪些维度要写清");
  assert.match(MODE_NOTES.decision, /2~3 个 ## 分节/, "分节数从 1~2 提到 2~3，避免一段就收工");
});
