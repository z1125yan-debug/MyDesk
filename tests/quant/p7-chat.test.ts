// P7-⑤①：会话内核 + 流式契约内核的回归测试（纯内存，不 fetch、不碰库、不依赖 DOM）。
//
// 这一层要挡住的不是「功能没做」，而是三类会静默发生口径漂移的地方：
//  1) 窗口按条数裁会切碎对话（旧代码各处 slice(-12)），窗口以助手消息开头时模型会把上文当成用户在说；
//  2) 「旧对话压缩」很容易被写成「AI 摘要」——这里必须是忠实截断 + 声明非实时，不能凭空改写；
//  3) 流式与否必须如实：上游整体返回时不得画成逐字流；残帧/中断不得补字；tool_calls 分片必须能归并回可执行的调用。
// 另外把「旧存档迁移无损」钉住：用户浏览器里已有的 chats 不能升级后消失。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_TURNS, appendMessage, applyEvent, buildPromptMessages, emptySession, isFollowUp,
  migrateLegacyChats, normalizeMessage, removeSession, settleRunningSteps, splitWindow,
  summarizeDropped, titleFromMessages, trimDialog, typewriterSlices, updateMessage, upsertSession,
  type ChatMessage, type ChatRequestMessage,
} from "../../src/lib/desk/chat-core.ts";
import {
  asStreamEvent, createSseScanner, createToolCallAssembler, decodeStreamEvent, encodeStreamEvent,
  isEventStream, notStreamedWarning, parseUpstreamFrame, scanSse, stepDetailOf, stepLabelFor, stepsFromTrace,
  type StreamEvent,
} from "../../src/lib/desk/chat-stream-core.ts";

function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: extra.id ?? `${role}-${content.slice(0, 6)}`, role, content, ts: Date.now(), ...extra };
}

// ---------- 会话结构与旧存档迁移 ----------

test("旧存档 chats[][] → 会话列表：消息一条不少，id/标题补齐", () => {
  const legacy = [
    [{ role: "assistant" as const, content: "好的，已生成结论", ts: 100 },
     { role: "user" as const, content: "688256 现在的主力资金怎么样？帮忙看下结构", ts: 200 }],
    [{ role: "user" as const, content: "今天大盘情绪如何", ts: 300 }],
    [],
  ];
  const sessions = migrateLegacyChats(legacy, 1_700_000_000_000);
  assert.equal(sessions.length, 3);
  assert.equal(sessions.reduce((n, s) => n + s.messages.length, 0), 3, "消息总数必须与旧存档一致");
  // 标题取第一条「用户」消息，不是第一条消息（旧存档可能以助手消息开头）
  assert.equal(sessions[0].title, "688256 现在的主力资金怎么样？…");
  assert.ok(sessions.every((s) => s.id));
  assert.ok(sessions[0].messages.every((m) => m.id && typeof m.ts === "number"));
  // 空会话保留，不丢容器
  assert.deepEqual(sessions[2].messages, []);
});

test("migrateLegacyChats：undefined / 空数组 → 恰好一个空会话（不会把界面搞成无会话态）", () => {
  for (const input of [undefined, null, []]) {
    const out = migrateLegacyChats(input as undefined, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].messages.length, 0);
    assert.equal(out[0].title, "新会话");
  }
});

test("normalizeMessage：缺 id / 缺 ts / 非法 role 的脏数据都能读入", () => {
  const n = normalizeMessage({ content: "hi" } as any, "seed", 999);
  assert.equal(n.id, "m_seed");
  assert.equal(n.ts, 999);
  assert.equal(n.role, "user");
  assert.equal(normalizeMessage({ role: "system", content: "x" } as any, "s2", 1).role, "user");
  assert.equal(normalizeMessage({ role: "assistant", content: "x" } as any, "s3", 1).role, "assistant");
});

test("会话列表操作：首条提问生成标题；删除到空会自动补一个会话", () => {
  let s = emptySession(1);
  assert.equal(s.title, "新会话");
  s = appendMessage(s, msg("user", "寒武纪的关键支撑位在哪"));
  assert.equal(s.title, "寒武纪的关键支撑位在哪");
  s = appendMessage(s, msg("assistant", "支撑位参考 …"));
  assert.equal(s.title, "寒武纪的关键支撑位在哪", "已有标题不被后续消息覆盖");
  const again = appendMessage(s, msg("user", "那阻力位呢"));
  assert.equal(again.title, s.title);
  assert.equal(again.messages.length, 3);

  const list = [s, emptySession(2)];
  assert.equal(removeSession(list, s.id).length, 1);
  const emptied = removeSession([s], s.id);
  assert.equal(emptied.length, 1);
  assert.notEqual(emptied[0].id, s.id, "删空后补的是新会话，不是复用被删的那个");
  assert.deepEqual(emptied[0].messages, []);

  const updated = updateMessage(s, s.messages[0].id, { content: "改后的问题" });
  assert.equal(updated.messages[0].content, "改后的问题");
  assert.equal(s.messages[0].content, "寒武纪的关键支撑位在哪", "不可变更新：原对象不能动");
  assert.equal(upsertSession([s], updated)[0].messages[0].content, "改后的问题");
  assert.equal(upsertSession([s], { ...updated, id: "other" }).length, 2);
});

// ---------- 上下文窗口与压缩 ----------

function dialog(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= turns; i++) {
    out.push(msg("user", `第 ${i} 问`));
    out.push(msg("assistant", `第 ${i} 答`));
  }
  return out;
}

test("窗口按轮裁：12 轮上限，被挤掉的进 dropped，且窗口一定以用户消息开头", () => {
  const { sent, dropped } = splitWindow(dialog(20));
  assert.equal(sent.length, DEFAULT_MAX_TURNS * 2);
  assert.equal(sent[0].content, "第 9 问");
  assert.equal(sent.at(-1)!.content, "第 20 答");
  assert.equal(dropped.length, 16);
  assert.equal(dropped[0].content, "第 1 问");

  // 一轮内多条助手消息不会各占一轮
  const multi = [msg("user", "问1"), msg("assistant", "答1a"), msg("assistant", "答1b"), msg("user", "问2"), msg("assistant", "答2")];
  const w2 = splitWindow(multi, 1);
  assert.deepEqual(w2.sent.map((m) => m.content), ["问2", "答2"]);
  assert.deepEqual(w2.dropped.map((m) => m.content), ["问1", "答1a", "答1b"]);
});

test("窗口开头的助手孤儿消息会被丢掉（旧存档可能以助手消息起头）", () => {
  const withOrphan = [msg("assistant", "上一轮遗留的回答"), ...dialog(1)];
  const { sent } = splitWindow(withOrphan, 5);
  assert.equal(sent[0].role, "user");
  assert.equal(sent.length, 2);
  // maxTurns 非法也不能崩
  assert.equal(splitWindow(dialog(3), 0).sent.length, 2);
});

test("压缩摘要是忠实截断 + 标明说话人 + 声明非实时，不是 AI 总结", () => {
  const long = "这是一条很长很长的历史消息，用来验证按字符截断而不是按语义改写。".repeat(3);
  const { dropped } = splitWindow([msg("user", long), ...dialog(DEFAULT_MAX_TURNS)], DEFAULT_MAX_TURNS);
  assert.equal(dropped.length, 1);
  const text = summarizeDropped(dropped, { perMessageChars: 30, maxLines: 5 });
  assert.ok(text.includes("本机存档摘要"));
  assert.ok(text.includes("非实时数据"), "必须声明不是实时数据");
  assert.ok(text.includes("不得当作当前行情引用"));
  assert.ok(text.startsWith("【"));
  assert.ok(text.includes("- 用户：这是一条很长很长的历史消息，用来"), "原文开头必须逐字保留");
  assert.ok(text.includes("…"));
  // 不出现改写痕迹：摘要里除了抬头说明，正文行必须是原文前缀
  const bodyLine = text.split("\n").find((l) => l.startsWith("- 用户："))!;
  assert.ok(long.replace(/\s+/g, " ").startsWith(bodyLine.slice("- 用户：".length).replace(/…$/, "")));
  assert.equal(summarizeDropped([]), "");
  // 超出 maxLines 的只报条数
  const many = summarizeDropped(dialog(10), { maxLines: 3 });
  assert.ok(many.includes("更早还有 17 条未列出"), `实际：${many}`);
});

test("buildPromptMessages：摘要走 system、快照只贴本轮新提问、空内容消息不进窗口", () => {
  // 结尾那条空白助手消息必须被滤掉，否则窗口里会出现 content:"" 的发言
  const session = { messages: [...dialog(DEFAULT_MAX_TURNS), msg("assistant", "  ")] };
  const pieces = buildPromptMessages(session, { snapshot: "SNAP-行情上下文", maxTurns: 3 });
  assert.equal(pieces[0].role, "system");
  assert.ok(pieces[0].content.includes("更早还有"), "窗口外的走压缩摘要");
  assert.ok(pieces.every((p) => p.content.trim()), "不允许把空消息发给模型");
  // 窗口结尾是上一轮的回答 → 快照不能塞进助手发言，只能作为 system 附带
  assert.equal(pieces.at(-1)!.role, "assistant");
  assert.ok(pieces.filter((p) => p.role !== "system").every((p) => !p.content.includes("SNAP")), "对话里不得混入快照");
  assert.ok(pieces.some((p) => p.role === "system" && p.content === "SNAP-行情上下文"), "无新提问时快照走 system");

  // 正常情形：新提问已经追加为最后一条用户消息，快照贴它
  const userLast = { messages: [...dialog(2), msg("user", "现在还能进场吗")] };
  const p2 = buildPromptMessages(userLast, { maxTurns: 3, snapshot: "SNAP" });
  assert.equal(p2.at(-1)!.role, "user");
  assert.ok(p2.at(-1)!.content.endsWith("\n\nSNAP"));
  assert.equal(p2.filter((x) => x.content.includes("SNAP")).length, 1, "快照只出现一次");
  // 结尾是上一轮回答时，即便同一轮里有用户消息，也不许把行情塞进旧发言
  const p4 = buildPromptMessages({ messages: [msg("user", "问 A"), msg("assistant", "答 A")] }, { snapshot: "SNAP" });
  assert.equal(p4.at(-1)!.role, "assistant");
  assert.ok(p4.at(-1)!.content === "答 A", "助手发言必须原样");
  assert.ok(p4.some((x) => x.role === "system" && x.content === "SNAP"));
  // 空会话有快照时不能凭空造一条用户消息
  assert.deepEqual(buildPromptMessages({ messages: [] }, { snapshot: "SNAP" }), [{ role: "system", content: "SNAP" }]);
  // withSummary:false 时不得带摘要
  const p3 = buildPromptMessages({ messages: dialog(20) }, { maxTurns: 2, withSummary: false });
  assert.ok(p3.every((x) => !x.content.includes("更早对话")));
  assert.equal(p3.length, 4);
});

// ---------- 追问识别 ----------

test("追问触发词：省略主语的追问判 true，带 6 位代码的新问题判 false", () => {
  for (const t of ["那它呢", "继续说", "再详细点", "刚才那个结论的样本数是多少", "为什么是震荡"]) {
    assert.equal(isFollowUp(t), true, `${t} 应判为追问`);
  }
  for (const t of ["688256 现在怎么样", "帮我看下 300750 的资金面", "今天大盘情绪如何"]) {
    assert.equal(isFollowUp(t), false, `${t} 应判为新对象`);
  }
  assert.equal(isFollowUp(""), false);
  assert.equal(isFollowUp("   "), false);
});

// ---------- 流事件 reducer / 打字机 ----------

test("applyEvent：delta 累加、step 按序号覆盖状态、done 定稿、error 不丢已有内容", () => {
  let m = msg("assistant", "", { streaming: true });
  m = applyEvent(m, { type: "delta", data: { content: "结论：" } });
  m = applyEvent(m, { type: "delta", data: { content: "缩量整理" } });
  assert.equal(m.content, "结论：缩量整理");
  m = applyEvent(m, { type: "step", data: { step: 1, label: "取快照", status: "running" } });
  m = applyEvent(m, { type: "step", data: { step: 2, label: "取K线", status: "running" } });
  m = applyEvent(m, { type: "step", data: { step: 1, label: "取快照", status: "ok", ms: 120 } });
  assert.equal(m.steps?.length, 2);
  assert.equal(m.steps?.[0].status, "ok");
  assert.equal(m.steps?.[0].ms, 120);
  m = applyEvent(m, { type: "warning", data: { text: "上游未流式" } });
  m = applyEvent(m, { type: "warning", data: { text: "连接提前结束" } });
  assert.equal(m.warning, "上游未流式；连接提前结束");
  const done = applyEvent(m, { type: "done", data: { fullText: "最终全文" } });
  assert.equal(done.content, "最终全文");
  assert.equal(done.streaming, false);
  const errored = applyEvent(m, { type: "error", data: { message: "上游 502" } });
  assert.equal(errored.content, m.content, "已有正文不能被错误事件清空");
  assert.ok(errored.warning!.includes("已中断：上游 502"));
  assert.equal(errored.streaming, false);
  // 一个字都没有时，error 必须有可见说明，而不是留个空气泡
  const empty = applyEvent(msg("assistant", "", { streaming: true }), { type: "error", data: { message: "上游 502" } });
  assert.ok(empty.content.includes("上游 502"));
  // 已有部分正文时 delta 空串不该改变内容
  const partial = applyEvent(applyEvent(msg("assistant", "已有半句"), { type: "error", data: { message: "断了" } }), { type: "delta", data: { content: "" } });
  assert.equal(partial.content, "已有半句");
});

test("settleRunningSteps：中断后不留永远转圈的步骤", () => {
  const m = applyEvent(applyEvent(msg("assistant", ""), { type: "step", data: { step: 1, label: "取快照", status: "ok" } }), { type: "step", data: { step: 2, label: "跑选股", status: "running" } });
  const settled = settleRunningSteps(m);
  assert.equal(settled.steps?.[0].status, "ok");
  assert.equal(settled.steps?.[1].status, "error");
  assert.ok(settled.steps?.[1].detail);
  assert.equal(settleRunningSteps(settled).steps?.[1].detail, settled.steps?.[1].detail, "已收尾的不二次改写");
});

test("typewriterSlices：切的是原文前缀，段数有上限，拼出的最后一帧等于全文", () => {
  const text = "a".repeat(1000);
  const slices = typewriterSlices(text, { sliceChars: 6, maxSlices: 50 });
  assert.ok(slices.length <= 51, `段数 ${slices.length}`);
  assert.equal(slices.at(-1), text);
  assert.ok(slices.every((s, i) => i === 0 || s.length > slices[i - 1].length), "长度单调递增");
  assert.ok(slices.every((s) => text.startsWith(s)), "每帧都是原文前缀");
  const small = typewriterSlices("短", { sliceChars: 6 });
  assert.deepEqual(small, ["短"]);
  assert.deepEqual(typewriterSlices(""), []);
});

// ---------- SSE 编解码 ----------

test("encodeStreamEvent / decodeStreamEvent 往返一致，脏帧一律 null", () => {
  const evs: StreamEvent[] = [
    { type: "step", data: { step: 1, label: "取快照", status: "ok", ms: 12, tool: "stock_snapshot" } },
    { type: "delta", data: { content: "你好\n世界" } },
    { type: "warning", data: { text: "本机节奏展示" } },
    { type: "done", data: { fullText: "你好\n世界" } },
    { type: "error", data: { message: "上游 502" } },
  ];
  for (const e of evs) {
    const frame = encodeStreamEvent(e);
    assert.ok(frame.endsWith("\n\n"));
    assert.equal(frame.startsWith("data: "), true);
    assert.deepEqual(decodeStreamEvent(frame.slice(6)), e);
  }
  assert.equal(decodeStreamEvent(""), null);
  assert.equal(decodeStreamEvent("{坏 JSON"), null);
  assert.equal(decodeStreamEvent(JSON.stringify({ type: "delta" })), null);
  assert.equal(decodeStreamEvent(JSON.stringify({ type: "未知", data: {} })), null);
  assert.equal(decodeStreamEvent(JSON.stringify({ type: "delta", data: { content: 3 } })), null);
  // 非法 status 收紧为 ok，缺 label 的 step 丢弃
  const tightened = asStreamEvent({ type: "step", data: { step: 1, label: "x", status: "随便写的" } });
  assert.ok(tightened && tightened.type === "step", "step 事件应被识别");
  assert.equal(tightened.data.status, "ok");
  assert.equal(asStreamEvent({ type: "step", data: { step: 1 } }), null);
});

test("SSE 扫描器：跨 chunk 半截帧、\\r\\n、多行 data、注释保活、flush 取残帧", () => {
  const sc = createSseScanner();
  const a = encodeStreamEvent({ type: "delta", data: { content: "第一段" } });
  // 切成两半喂，前半不能出帧
  assert.deepEqual(sc.push(a.slice(0, 12)), []);
  let frames = sc.push(a.slice(12));
  assert.equal(frames.length, 1);
  assert.deepEqual(decodeStreamEvent(frames[0].data), { type: "delta", data: { content: "第一段" } });
  // \r\n 行尾 + 注释 + 一次多帧
  frames = sc.push(": ping\r\ndata: {\"type\":\"warning\",\"data\":{\"text\":\"a\"}}\r\n\r\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '{"type":"warning","data":{"text":"a"}}');
  // 多行 data 合并
  frames = sc.push("data: 1\ndata: 2\n\n");
  assert.equal(frames[0].data, "1\n2");
  // 结尾无空行的残帧靠 flush 交出
  assert.deepEqual(sc.flush(), []);
  frames = sc.push("data: {\"type\":\"done\",\"data\":{\"fullText\":\"\"}}");
  assert.deepEqual(frames, []);
  const tail = sc.flush();
  assert.equal(tail.length, 1);
  assert.deepEqual(decodeStreamEvent(tail[0].data), { type: "done", data: { fullText: "" } });
  assert.deepEqual(scanSse("data: {\"type\":\"delta\",\"data\":{\"content\":\"x\"}}\n\n").length, 1);
});

test("isEventStream / notStreamedWarning：非 SSE 必须留下可展示的实话", () => {
  assert.equal(isEventStream("text/event-stream; charset=utf-8"), true);
  assert.equal(isEventStream("application/json"), false);
  assert.equal(isEventStream(null), false);
  const w = notStreamedWarning("application/json");
  assert.ok(w.includes("application/json") && w.includes("不是逐字流"));
});

// ---------- 上游 OpenAI 兼容流增量 ----------

test("parseUpstreamFrame：正文增量、tool_calls 分片、[DONE]、finish_reason、坏帧", () => {
  const text = parseUpstreamFrame({ data: '{"choices":[{"delta":{"content":"市场"}}]}' });
  assert.equal(text.text, "市场");
  assert.equal(text.recognized, true);
  assert.equal(text.done, false);
  assert.equal(parseUpstreamFrame({ data: "[DONE]" }).done, true);
  assert.equal(parseUpstreamFrame({ data: "" }).recognized, false);
  assert.equal(parseUpstreamFrame({ data: "not json" }).recognized, false);
  const fin = parseUpstreamFrame({ data: '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}' });
  assert.equal(fin.finishReason, "tool_calls");
  assert.equal(fin.text, "");
  const tc = parseUpstreamFrame({ data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"stock_","arguments":"{\\"sym"}}]}}]}' });
  assert.equal(tc.toolCalls[0].index, 0);
  assert.equal(tc.toolCalls[0].id, "c1");
  assert.equal(tc.toolCalls[0].name, "stock_");
  assert.equal(tc.toolCalls[0].argsFragment, '{"sym');
});

test("createToolCallAssembler：分片按 index 归并成可执行的调用，缺 id 时补稳定占位", () => {
  const asm = createToolCallAssembler();
  asm.push([{ index: 0, id: "call_a", name: "factor_screener", argsFragment: '{"conditions":' }]);
  asm.push([{ index: 1, name: "market_sentiment", argsFragment: "{}" }]);
  asm.push([{ index: 0, argsFragment: '[{"field":"rps_50","op":">","value":80}]}' }]);
  const out = asm.result();
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "factor_screener");
  assert.deepEqual(JSON.parse(out[0].argsText), { conditions: [{ field: "rps_50", op: ">", value: 80 }] });
  assert.equal(out[1].id, "call_1");
  assert.equal(asm.size(), 2);
});

// ---------- 步骤文案 ----------

test("stepLabelFor / stepDetailOf：中文一句话 + 标的，缺失结果判 missing 不判 0", () => {
  assert.equal(stepLabelFor("stock_kline_summary", { symbol: "688256.SH" }), "取日 K 并计算技术状态 · 688256.SH");
  assert.equal(stepLabelFor("factor_screener", { conditions: [{}, {}] }), "跑全 A 条件选股（2 个条件）");
  assert.equal(stepLabelFor("sector_rank", { kind: "concept" }), "取板块资金榜（概念）");
  assert.equal(stepLabelFor("mystery_tool"), "调用 mystery_tool");
  assert.deepEqual(stepDetailOf({ missing: "五档盘口暂无数据（eltdx 网关未运行）" }), { status: "missing", detail: "缺失：五档盘口暂无数据（eltdx 网关未运行）" });
  assert.equal(stepDetailOf(null).status, "missing");
  assert.equal(stepDetailOf({ 现价: 1234.56 }).status, "ok");
  assert.ok(stepDetailOf({ 现价: 1234.56 }).detail!.includes("1234.56"));
  const longText = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => i) });
  assert.ok(stepDetailOf(longText).detail!.endsWith("…"));
});

test("stepsFromTrace：降级路径的 trace 与流式 step 事件是同一套步骤口径", () => {
  const steps = stepsFromTrace([
    { name: "stock_snapshot", args: { symbol: "688256.SH" }, ms: 40, status: "ok", summary: '{"symbol":"688256.SH","现价":1234.5}' },
    { name: "stock_depth", args: { symbol: "688256.SH" }, ms: 3, status: "ok", summary: '{"missing":"五档盘口暂无数据（eltdx 网关未运行）"}' },
    { name: "factor_screener", args: { conditions: [] }, ms: 800, status: "error", summary: '{"missing":"工具执行失败：boom"}' },
  ]);
  assert.deepEqual(steps.map((s) => s.step), [1, 2, 3]);
  assert.equal(steps[0].status, "ok");
  assert.equal(steps[1].status, "missing", "工具没抛错但返回 missing → 缺数据，不是失败也不是 0");
  assert.equal(steps[1].detail, "缺失：五档盘口暂无数据（eltdx 网关未运行）");
  assert.equal(steps[2].status, "error");
  assert.equal(steps[1].label, "取五档盘口 · 688256.SH");
  assert.equal(steps[0].ms, 40);
  assert.deepEqual(stepsFromTrace([]), []);
});

test("titleFromMessages：取首条提问、压掉换行、超长截断、无提问用占位", () => {
  assert.equal(titleFromMessages([]), "新会话");
  assert.equal(titleFromMessages([{ role: "assistant", content: "先说话的是助手" }]), "新会话");
  assert.equal(titleFromMessages([{ role: "user", content: "  多行\n问题  " }]), "多行 问题");
  assert.equal(titleFromMessages([{ role: "user", content: "问".repeat(30) }]), `${"问".repeat(18)}…`);
  assert.equal(titleFromMessages([{ role: "user", content: "“带引号的问题”" }]), "带引号的问题");
  assert.equal(titleFromMessages([{ role: "user", content: "   " }], "未命名"), "未命名");
});

test("trimDialog：服务端兜底只丢最早的用户/助手消息，system 件（摘要、快照说明）不静默丢", () => {
  const msgs: ChatRequestMessage[] = [
    { role: "system", content: "【更早对话摘要】…" },
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "a2" },
  ];
  // 只留最近 2 条对话：丢掉 q1/a1，摘要那条例子在裁剪里被保留
  assert.deepEqual(trimDialog(msgs, 2), [msgs[0], msgs[3], msgs[4]]);
  // 传 0 / 负数也不能把对话清空（至少留最新一条），否则模型连本轮问题都看不到
  assert.equal(trimDialog(msgs, 0).filter((m) => m.role !== "system").length, 1);
  // 不超长时原样返回，不重排、不改内容
  assert.deepEqual(trimDialog(msgs, 99), msgs);
});
