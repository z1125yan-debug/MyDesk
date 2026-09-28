// P59 稳智对齐：流式展示的两块收尾 —— 本机节奏（代理对安全 + 积压自适应）与追问推荐芯片。
// 依据：D:\qoder-exports\稳智AI_试试这样问8卡与输出格式规格_2026-09-27.md §5（follow_up_suggestions）
//       与 §6（flushAnswer 的代理对保护、Cr() 按积压长度分档、To=96/Io=240）。
// 本地没有「答完再调一次模型生成推荐」的服务端字段（多一次调用、也没余额可验），
// 所以改成收尾纪律 + 前端切分：正文里那一行【追问推荐】a|b|c 是唯一事实来源，芯片由它派生。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FOLLOWUP_MARKER, FOLLOWUP_NOTE, splitFollowUps, followUpBody, followUpsOf, MAX_FOLLOW_UPS,
} from "../../src/lib/desk/followups-core.ts";
import { buildPromptMessages, type ChatMessage } from "../../src/lib/desk/chat-core.ts";
import { playTypewriter, safeCut } from "../../src/lib/desk/chat-stream-client.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("P59 追问推荐切分（纯层）", () => {
  test("基本形状：正文与推荐分开，标记行不留在正文里", () => {
    const { body, suggestions } = splitFollowUps(`📌 **一句话定性：** 先观察。\n\n${FOLLOWUP_MARKER}回踩位在哪|今天资金流向|按成本怎么分批`);
    assert.equal(body, "📌 **一句话定性：** 先观察。");
    assert.deepEqual(suggestions.map((s) => s.text), ["回踩位在哪", "今天资金流向", "按成本怎么分批"]);
    assert.deepEqual(suggestions.map((s) => s.send), suggestions.map((s) => s.text));
  });

  test("没有标记：正文一字不动，推荐为空（界面一颗都不画）", () => {
    const text = "## 寒武纪（688256）现在可以买吗\n📌 **一句话定性：** 不建议动手。";
    assert.deepEqual(splitFollowUps(text), { body: text, suggestions: [], markerSeen: false });
  });

  test(" markdown 包一层也算：加粗 / 列表符号 / 全角冒号 / 全角竖线", () => {
    for (const raw of [
      `**${FOLLOWUP_MARKER}**A问|B问|C问`,
      `- ${FOLLOWUP_MARKER}：A问｜B问｜C问`,
      `${FOLLOWUP_MARKER} A问 | B问 | C问`,
    ]) {
      const { body, suggestions } = splitFollowUps(`正文一段。\n${raw}`);
      assert.equal(body, "正文一段。", `${raw} 的正文没剥干净`);
      assert.equal(suggestions.length, 3, `${raw} 没切出三颗`);
    }
  });

  test("封顶 3 颗、去重、太长（>40 字）与太短（<2 字）的丢掉", () => {
    const long = "这句长得像一段分析而不是一个提问了".repeat(3);
    const { suggestions } = splitFollowUps(`${FOLLOWUP_MARKER}甲|甲|问题一|问题二|问题三|问题四|${long}`);
    assert.equal(suggestions.length, MAX_FOLLOW_UPS);
    assert.equal(new Set(suggestions.map((s) => s.text)).size, suggestions.length, "去重没生效");
    assert.ok(!suggestions.some((s) => s.text === "甲"), "单字（不成一句问）留下来了");
  });

  test("流式半截标记不能露出来：长成完整标记的每一个中间帧都没有脏尾巴", () => {
    const full = `结论在此。\n${FOLLOWUP_MARKER}问一|问二|问三`;
    // 一帧一字地喂（最坏情况：逐字流），每一帧的可见正文都必须是「结论在此。」，不许带半个标记
    for (let i = 1; i <= full.length; i++) {
      const { body, markerSeen } = splitFollowUps(full.slice(0, i));
      assert.ok(!body.includes("【"), `第 ${i} 帧把半个标记画给了用户：${body}`);
      assert.ok(!body.includes("问一"), `第 ${i} 帧把未收口的推荐项当正文画了：${body}`);
      if (i > full.indexOf(FOLLOWUP_MARKER)) assert.ok(markerSeen, `第 ${i} 帧该认出这是标记行`);
    }
  });

  test("正文里的「【风险提示】……」不是标记（不误吞正文）", () => {
    const text = "先观察。\n【风险提示】跌破 20 日线即失效。";
    const { body, suggestions, markerSeen } = splitFollowUps(text);
    assert.equal(body, text);
    assert.equal(suggestions.length, 0);
    assert.equal(markerSeen, false);
  });

  test("标记写两遍：切在最后一处，前面的正文尽量保住", () => {
    const { body, suggestions } = splitFollowUps(`${FOLLOWUP_MARKER}早问|中问|晚问\n\n补一段结论。\n${FOLLOWUP_MARKER}甲|乙|丙`);
    assert.equal(body, `${FOLLOWUP_MARKER}早问|中问|晚问\n\n补一段结论。`);
    assert.deepEqual(suggestions.map((s) => s.text), ["甲", "乙", "丙"].filter((t) => t.length >= 2));
  });

  test("followUpBody / followUpsOf 是同一份解析的两个投影（不各写一套正则）", () => {
    const text = `正文。\n${FOLLOWUP_MARKER}甲乙|丙丁|戊己`;
    assert.equal(followUpBody(text), "正文。");
    assert.equal(followUpsOf(text).length, 3);
    assert.equal(followUpBody(""), "");
    assert.deepEqual(followUpsOf(undefined as unknown as string), []);
  });

  test("提示词与解析器同源：把 FOLLOWUP_NOTE 里那句示例原样喂进去，正好切出 3 颗", () => {
    assert.ok(FOLLOWUP_NOTE.includes(FOLLOWUP_MARKER), "收尾纪律里没写标记本身，模型无从按锚输出");
    const example = FOLLOWUP_NOTE.split("\n").find((l) => l.includes(FOLLOWUP_MARKER) && l.includes("例")) ?? "";
    const line = example.slice(example.indexOf(FOLLOWUP_MARKER)).split(/[。]/)[0];
    const { suggestions } = splitFollowUps(line);
    assert.equal(suggestions.length, 3, `示例行切不出 3 颗：${line}`);
  });
});

describe("P59 上下文与渲染接线", () => {
  const msg = (over: Partial<ChatMessage>): ChatMessage =>
    ({ id: "m1", role: "assistant", content: "", ts: 1, ...over } as ChatMessage);

  test("送回首轮的助手正文里不带标记行（否则一轮一轮越抄越长）", () => {
    // 窗口必须以用户消息起头（chat-core 的轮次对齐口径），所以第一件是提问，不是回答
    const pieces = buildPromptMessages({ messages: [
      { ...msg({ id: "u0", role: "user", content: "688256 现在能买吗" }), role: "user" },
      msg({ content: `上一轮正文。\n${FOLLOWUP_MARKER}问一|问二|问三` }),
      { ...msg({ id: "u1", role: "user", content: "那明天怎么看" }), role: "user" },
    ] as ChatMessage[] }, { maxTurns: 5 });
    const assistant = pieces.find((p) => p.role === "assistant");
    assert.ok(assistant, "没拼出助手那一轮");
    assert.equal(assistant.content, "上一轮正文。");
    assert.ok(!assistant.content.includes("追问推荐"), "标记行还是进了上下文");
  });

  test("用户消息一个字都不剥（剥标记只针对助手正文）", () => {
    const raw = `请按${FOLLOWUP_MARKER}格式给我三颗推荐`;
    const pieces = buildPromptMessages({ messages: [
      { ...msg({ id: "u1", role: "user", content: raw }), role: "user" },
    ] as ChatMessage[] }, { maxTurns: 5 });
    assert.equal(pieces.find((p) => p.role === "user")?.content, raw);
  });

  test("两个画法都接了芯片与正文剥离（对话页 + 小窗，同一份组件）", () => {
    for (const rel of ["src/components/desk/pages/AssistantPage.tsx", "src/components/desk/AssistantWidget.tsx"]) {
      const src = read(rel);
      assert.match(src, /<FollowUpChips content=\{m\.content\} streaming=\{m\.streaming\} onAsk=/, `${rel} 没画推荐芯片`);
      assert.match(src, /Markdown content=\{followUpBody\(m\.content\)\}/, `${rel} 的正文没剥标记行`);
      assert.match(src, /content: followUpBody\(m\.content\)/, `${rel} 的步骤时间线还在吃带标记的正文`);
    }
    const chips = read("src/components/desk/ui/FollowUpChips.tsx");
    assert.match(chips, /if \(streaming\) return null/, "流式途中就该不画（半截标记会闪芯片）");
    assert.match(chips, /suggestions\.length < 2/, "少于两颗还画：多半是模型把标记截断了");
    assert.match(chips, /from "@\/lib\/desk\/followups-core"/, "芯片自己不许再写一份解析");
  });

  test("三处下发口都拼了同一条收尾纪律（少一处 = 那种配置下永远看不到芯片）", () => {
    for (const rel of ["src/app/api/ai/chat/route.ts", "src/app/api/ai/proxy/route.ts", "src/lib/desk/ai.ts"]) {
      assert.match(read(rel), /FOLLOWUP_NOTE/, `${rel} 没下发收尾纪律`);
    }
    // proxy 与风格件同闸：没带 scene 的转发轮（研究页/自检）一个字都不加
    assert.match(read("src/app/api/ai/proxy/route.ts"), /body\?\.scene \? FOLLOWUP_NOTE : ""/);
    // 护栏回显语料里刻意不放它：放了会把刚剥出来要画芯片的那一行提前吃掉
    // （路由源码里的注释会提这个名字，所以判的是「作为数组元素出现」，不是「出现过这个串」）
    const chat = read("src/app/api/ai/chat/route.ts");
    const echo = chat.slice(chat.indexOf("const lastUserEcho"), chat.indexOf("let sceneFailure"));
    assert.ok(!/^\s*FOLLOWUP_NOTE,?\s*$/m.test(echo), "收尾纪律进了回显语料，推荐行会被护栏当回显吃掉");
  });
});

describe("P59 本机打字机节奏（对齐稳智 flushAnswer/Cr）", () => {
  test("safeCut 永不把代理对切两半（📌 这类 emoji 不能出现半截）", () => {
    assert.equal(safeCut("📌正文", 1), 2, "切在高 surrogate 后面却没带上低位代理");
    assert.equal(safeCut("📌正文", 2), 2);
    assert.equal(safeCut("普通正文", 3), 3);
    assert.equal(safeCut("abc", 99), 3, "越界应收到文末");
  });

  test("逐帧画出的每个前缀都不含孤立高位代理，且最后一帧是全文", async () => {
    const text = "📌 一句话定性：先观察。".repeat(60) + `\n${FOLLOWUP_MARKER}问一|问二|问三`;
    const frames: string[] = [];
    await playTypewriter(text, (p) => frames.push(p), { tickMs: 0, sliceChars: 7 });
    assert.equal(frames[frames.length - 1], text, "收尾没把全文交出");
    for (const f of frames) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(f), `有一帧停在半个 emoji 上：${JSON.stringify(f.slice(-4))}`);
    }
  });

  test("积压越大切得越快：长文的帧数受 maxFrames 约束（不会一帧一字刷到天荒地老）", async () => {
    const short = await frames("短。".repeat(20), 1000);
    const long = await frames("长段落内容。".repeat(2000), 240);
    assert.ok(long <= 400, `一万三千字的正文画了 ${long} 帧，稳智同长度约 100 帧`);
    assert.ok(short <= 60, `短句画了 ${short} 帧`);
  });

  test("shouldStop 一置位就停手：不再多画一帧，也不补全文", async () => {
    const frames: string[] = [];
    await playTypewriter("很长".repeat(4000), (p) => frames.push(p), {
      tickMs: 0, maxFrames: 240, shouldStop: () => frames.length >= 3,
    });
    assert.equal(frames.length, 3, "停了之后还在画（或最后补了一次全文）");
  });
});

async function frames(text: string, maxFrames: number): Promise<number> {
  const seen: string[] = [];
  await playTypewriter(text, (p) => seen.push(p), { tickMs: 0, maxFrames });
  return seen.length;
}
