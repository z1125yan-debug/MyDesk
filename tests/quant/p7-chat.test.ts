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
  DEFAULT_MAX_TURNS, MAX_TURNS_LIMIT, applyCharBudget, appendMessage, applyEvent, buildPromptMessages, clampTurns,
  emptySession, injectSceneContext, intentBadgeOf, isFollowUp, markSnapshot, migrateLegacyChats, normalizeMessage,
  removeSession, renderStepsLine, settleRunningSteps, splitSnapshotMessage, splitWindow, SNAPSHOT_MARK,
  summarizeDropped, titleFromMessages, trimDialog, typewriterSlices, updateMessage, upsertSession,
  type ChatMessage, type ChatRequestMessage, type ContextMsg, type IntentBadge,
} from "../../src/lib/desk/chat-core.ts";
import {
  asStreamEvent, asStreamIntent, chatRequestBody, createSseScanner, createToolCallAssembler, decodeStreamEvent,
  encodeStreamEvent, isEventStream, notStreamedWarning, parseUpstreamFrame, pickChatEndpoint, scanSse,
  SCENE_KEYS, stepDetailOf, stepLabelFor, stepsFromTrace, supportsToolCalling, type StreamEvent,
} from "../../src/lib/desk/chat-stream-core.ts";
import { CHAT_MODES, asChatMode, chatModeLabel, isChatMode } from "../../src/lib/desk/modes.ts";

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

test("窗口按轮裁：默认 30 轮上限，被挤掉的进 dropped，且窗口一定以用户消息开头", () => {
  // P7-⑥③ 把默认窗口从 12 提到 30（连续追问要用得上文）。这里把常量本身钉住：
  // 悄悄调回去会让「帮我回测一下刚才说的策略」这类提问看不到第 13 轮之前的内容。
  assert.equal(DEFAULT_MAX_TURNS, 30);
  const total = DEFAULT_MAX_TURNS + 8;
  const { sent, dropped } = splitWindow(dialog(total));
  assert.equal(sent.length, DEFAULT_MAX_TURNS * 2);
  assert.equal(sent[0].content, `第 ${total - DEFAULT_MAX_TURNS + 1} 问`);
  assert.equal(sent.at(-1)!.content, `第 ${total} 答`);
  assert.equal(dropped.length, (total - DEFAULT_MAX_TURNS) * 2);
  assert.equal(dropped[0].content, "第 1 问");

  // 一轮内多条助手消息不会各占一轮
  const multi = [msg("user", "问1"), msg("assistant", "答1a"), msg("assistant", "答1b"), msg("user", "问2"), msg("assistant", "答2")];
  const w2 = splitWindow(multi, 1);
  assert.deepEqual(w2.sent.map((m) => m.content), ["问2", "答2"]);
  assert.deepEqual(w2.dropped.map((m) => m.content), ["问1", "答1a", "答1b"]);
});

test("轮数入参一律收进合法区间：0/负数/NaN/字符串都不能把上文清空或撑爆", () => {
  assert.equal(clampTurns(5), 5);
  assert.equal(clampTurns(0), DEFAULT_MAX_TURNS, "0 轮＝模型完全看不到上文，必须退回默认");
  assert.equal(clampTurns(-3), DEFAULT_MAX_TURNS);
  assert.equal(clampTurns(NaN), DEFAULT_MAX_TURNS);
  assert.equal(clampTurns(undefined), DEFAULT_MAX_TURNS);
  assert.equal(clampTurns(null, 8), 8, "带自定义兜底时按兜底走");
  assert.equal(clampTurns("4"), 4, "请求体里是字符串也要能用");
  assert.equal(clampTurns(9999), MAX_TURNS_LIMIT, "超出上限按上限截，不能由外部决定发多少");
  assert.equal(clampTurns(4.7), 4, "小数轮没有意义，向下取整");
  // 兜底本身也不能越过上限
  assert.equal(clampTurns(undefined, 10_000), MAX_TURNS_LIMIT);
});

test("窗口开头的助手孤儿消息会被丢掉（旧存档可能以助手消息起头）", () => {
  const withOrphan = [msg("assistant", "上一轮遗留的回答"), ...dialog(1)];
  const { sent } = splitWindow(withOrphan, 5);
  assert.equal(sent[0].role, "user");
  assert.equal(sent.length, 2);
  // maxTurns 非法也不能崩：0 是「没传对」，按默认窗口走，而不是当成「只留 1 轮」把上文砍没
  assert.equal(splitWindow(dialog(3), 0).sent.length, 6);
  assert.equal(splitWindow(dialog(3), NaN).sent.length, 6);
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
  assert.ok(pieces.some((p) => p.role === "system" && p.content === markSnapshot("SNAP-行情上下文")), "无新提问时快照走 system");

  // 正常情形：新提问已经追加为最后一条用户消息，快照贴它，并且带标记可被服务端摘出来
  const userLast = { messages: [...dialog(2), msg("user", "现在还能进场吗")] };
  const p2 = buildPromptMessages(userLast, { maxTurns: 3, snapshot: "SNAP" });
  assert.equal(p2.at(-1)!.role, "user");
  assert.ok(p2.at(-1)!.content.startsWith("现在还能进场吗\n\n" + SNAPSHOT_MARK), "快照必须带标记贴在提问后面");
  assert.equal(p2.filter((x) => x.content.includes("SNAP")).length, 1, "快照只出现一次");
  // 结尾是上一轮回答时，即便同一轮里有用户消息，也不许把行情塞进旧发言
  const p4 = buildPromptMessages({ messages: [msg("user", "问 A"), msg("assistant", "答 A")] }, { snapshot: "SNAP" });
  assert.equal(p4.at(-1)!.role, "assistant");
  assert.ok(p4.at(-1)!.content === "答 A", "助手发言必须原样");
  assert.ok(p4.some((x) => x.role === "system" && x.content === markSnapshot("SNAP")));
  // 空会话有快照时不能凭空造一条用户消息
  assert.deepEqual(buildPromptMessages({ messages: [] }, { snapshot: "SNAP" }), [{ role: "system", content: markSnapshot("SNAP") }]);
  // withSummary:false 时不得带摘要
  const p3 = buildPromptMessages({ messages: dialog(20) }, { maxTurns: 2, withSummary: false });
  assert.ok(p3.every((x) => !x.content.includes("更早对话")));
  assert.equal(p3.length, 4);
});

test("快照标记可逆：服务端剥完剩下的就是用户原话（意图识别吃的是原话，不是行情文本）", () => {
  const withSnap = buildPromptMessages({ messages: [msg("user", "688256 怎么看")] }, { snapshot: "现价 1234.5\n成交额 20 亿" }).at(-1)!.content;
  const { question, snapshot } = splitSnapshotMessage(withSnap);
  assert.equal(question, "688256 怎么看");
  assert.match(snapshot, /现价 1234\.5/);
  // 没有标记（用户在别处打的字、旧存档）时整条都是原话，不能把内容吃掉
  assert.deepEqual(splitSnapshotMessage("今天大盘怎么样"), { question: "今天大盘怎么样", snapshot: "" });
  assert.deepEqual(splitSnapshotMessage(""), { question: "", snapshot: "" });
});

test("助手上文带当时的取数记录：标明非实时、缺数据说缺、running 步骤不写", () => {
  const steps = [
    { step: 1, label: "取快照", status: "ok" as const, tool: "stock_snapshot" },
    { step: 2, label: "取资金", status: "missing" as const, tool: "stock_fund_flow" },
    { step: 3, label: "取快讯", status: "running" as const, tool: "market_news" },
  ];
  const line = renderStepsLine(steps);
  assert.match(line, /stock_snapshot=已取到/);
  assert.match(line, /stock_fund_flow=缺数据/);
  assert.doesNotMatch(line, /market_news/, "没跑完的步骤不能写进上文（否则模型以为数据已到手）");
  assert.match(line, /非实时/);
  assert.equal(renderStepsLine([]), "");
  assert.equal(renderStepsLine(undefined), "");

  const pieces = buildPromptMessages({ messages: [msg("user", "问 A"), msg("assistant", "答 A", { steps })] });
  assert.match(pieces.at(-1)!.content, /^答 A\n\n〔上一轮系统取数记录/);
  // 落盘的消息本身不动：只有发给模型的那份带记录，界面看到的还是原文
  assert.equal(pieces.length, 2);
});

test("字数预算：整轮收缩、system 件永不丢、最后一轮一定保留、并报告收缩了几轮", () => {
  const pieces = [
    { role: "system" as const, content: "摘" },
    { role: "user" as const, content: "x".repeat(50) },
    { role: "assistant" as const, content: "y".repeat(50) },
    { role: "user" as const, content: "z".repeat(50) },
  ];
  const tight = applyCharBudget(pieces, 60);
  assert.equal(tight.droppedTurns, 1);
  assert.equal(tight.pieces[0].content, "摘", "压缩摘要不得被预算挤掉");
  assert.deepEqual(tight.pieces.slice(1).map((p) => p.content), ["z".repeat(50)]);
  // 预算宽松时一位不动
  assert.equal(applyCharBudget(pieces, 10_000).droppedTurns, 0);
  // 只剩最后一轮时也绝不把当前提问丢掉：宁可超预算，也不让模型看不到用户在问什么
  const alone = applyCharBudget([{ role: "user", content: "q".repeat(500) }], 10);
  assert.equal(alone.droppedTurns, 0);
  assert.equal(alone.pieces.length, 1);

  // 收缩过就要留痕：不然模型会以为自己看到的是完整上文
  const fatTurns = (n: number): ChatMessage[] => {
    const out: ChatMessage[] = [];
    for (let i = 1; i <= n; i++) { out.push(msg("user", `问${i}${"字".repeat(30)}`), msg("assistant", `答${i}${"字".repeat(30)}`)); }
    return out;
  };
  const built = buildPromptMessages({ messages: fatTurns(4) }, { maxTurns: 4, budgetChars: 40, withSummary: false });
  assert.equal(built[0].role, "system");
  assert.match(built[0].content, /未发送（不是不存在）/);
  assert.match(built[0].content, /本会话最早的 \d+ 轮/);
  // 压缩摘要与收缩留痕是两条不同的 system 件，预算挤的是对话轮次，不挤这两条说明
  const withSum = buildPromptMessages({ messages: [...dialog(2), ...fatTurns(2)] }, { maxTurns: 3, budgetChars: 40 });
  const systems = withSum.filter((p) => p.role === "system").map((p) => p.content);
  assert.equal(systems.length, 2, `应同时有摘要与留痕两条 system：${JSON.stringify(systems.map((s) => s.slice(0, 12)))}`);
  assert.ok(systems.some((s) => s.includes("更早对话")), "窗口外的旧轮仍走压缩摘要");
  assert.ok(systems.some((s) => s.includes("未发送（不是不存在）")), "被预算砍掉的轮次要留痕");
  // 入口那份固定提示词也吃额度：不算进去就是「以为留了余量其实没有」
  const plain = buildPromptMessages({ messages: fatTurns(4) }, { maxTurns: 4, budgetChars: 200, withSummary: false });
  const reserved = buildPromptMessages({ messages: fatTurns(4) }, { maxTurns: 4, budgetChars: 200, reservedChars: 180, withSummary: false });
  assert.ok(reserved[0].content.includes("固定提示词已占 180 字"), `实际：${reserved[0].content}`);
  assert.ok(reserved.length < plain.length, `同样的预算，带固定提示词时必须少发几轮：${reserved.length} vs ${plain.length}`);
  // 固定提示词本身就把预算吃满了，也不能把当前提问砍没（至少留最后一轮）
  const full = buildPromptMessages({ messages: dialog(2) }, { maxTurns: 2, budgetChars: 10, reservedChars: 5_000, withSummary: false });
  assert.equal(full.at(-1)!.role, "assistant");
  assert.ok(full.at(-1)!.content.startsWith("第 2 答"), `实际：${full.at(-1)!.content}`);
  // 不传 budgetChars 时一律不收缩：再长的会话也原样发（老调用方行为不变，收缩必须由调用方显式要求）
  const noBudget = buildPromptMessages({ messages: [...fatTurns(20)] }, { maxTurns: 20, withSummary: false });
  assert.equal(noBudget.length, 40);
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
  // P23：error 事件携带 error_code，applyEvent 用 friendlyErrorMessage 映射成用户可读文案
  // 没传 error_code 时兜底到 unknown（"请求出错，请稍后重试"）
  const errored = applyEvent(m, { type: "error", data: { message: "上游 502" } });
  assert.equal(errored.content, m.content, "已有正文不能被错误事件清空");
  assert.ok(errored.warning!.includes("已中断：请求出错，请稍后重试"), "P23：warning 用映射后的文案而非原始 message");
  assert.equal(errored.streaming, false);
  // 一个字都没有时，error 必须有可见说明，而不是留个空气泡
  const empty = applyEvent(msg("assistant", "", { streaming: true }), { type: "error", data: { message: "上游 502", error_code: "upstream_error" } });
  assert.ok(empty.content.includes("AI 服务异常，请稍后重试"), "P23：空正文时显示映射文案");
  assert.ok(!empty.content.includes("502"), "P23：不暴露原始 message 给正常用户");
  // 已有部分正文时 delta 空串不该改变内容
  const partial = applyEvent(applyEvent(msg("assistant", "已有半句"), { type: "error", data: { message: "断了" } }), { type: "delta", data: { content: "" } });
  assert.equal(partial.content, "已有半句");
});

test("applyEvent：error_code 映射生效（P23 稳智对齐）", () => {
  // 带 error_code 时，文案用映射表
  const withCode = applyEvent(
    msg("assistant", "", { streaming: true }),
    { type: "error", data: { message: "upstream 502", error_code: "upstream_error" } },
  );
  assert.ok(withCode.content.includes("AI 服务异常，请稍后重试"));
  assert.ok(!withCode.content.includes("502"));

  // ai_not_configured
  const notConfig = applyEvent(
    msg("assistant", "", { streaming: true }),
    { type: "error", data: { message: "Bifrost 未启动", error_code: "ai_not_configured" } },
  );
  assert.ok(notConfig.content.includes("AI 服务暂不可用"));

  // model_timeout
  const timeout = applyEvent(
    msg("assistant", "", { streaming: true }),
    { type: "error", data: { message: "request timed out", error_code: "model_timeout" } },
  );
  assert.ok(timeout.content.includes("AI 服务繁忙"));

  // rate_limit_exceeded
  const rateLimit = applyEvent(
    msg("assistant", "", { streaming: true }),
    { type: "error", data: { message: "429 too many", error_code: "rate_limit_exceeded" } },
  );
  assert.ok(rateLimit.content.includes("请求过于频繁"));
});

test("applyEvent：未知 error_code 兜底到 unknown 文案（P23）", () => {
  // 后端发了新码或拼写错，前端不 crash，用 unknown 兜底
  const unknown = applyEvent(
    msg("assistant", "", { streaming: true }),
    { type: "error", data: { message: "some new error", error_code: "some_new_code" } },
  );
  assert.ok(unknown.content.includes("请求出错"));
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

// 生产实测（40 轮 + contextWindow=30 打 /api/ai/chat）抓到的第二条：假上游收到的第一句对话是「第11答」，
// 窗口以助手消息起头。原因不是裁多了，而是「轮数 ×2」只是近似——本轮新提问是多出来的那一条，
// 边界正好落在某一问与某一答之间，于是把某一轮的「问」裁掉了、只留下它的「答」。
test("trimDialog：裁完的窗口必须以 user 起头（条数对齐不等于轮次对齐）", () => {
  const msgs: ChatRequestMessage[] = [
    { role: "system", content: "【更早对话摘要】…" },
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "assistant", content: "a1 补答" },
    { role: "user", content: "q2" }, { role: "assistant", content: "a2" },
  ];
  // 留 3 条：按条数会切出 [a1 补答, q2, a2] —— 开头是助手，模型会把它当成自己说的话续下去
  const out = trimDialog(msgs, 3);
  assert.deepEqual(out.map((m) => m.content), ["【更早对话摘要】…", "q2", "a2"]);
  assert.equal(out.filter((m) => m.role !== "system")[0].role, "user", "窗口第一条对话必须是用户");

  // 工具调用环往同一批消息里塞的 tool 回执也算「非 user 的开头」，一样要丢到窗口外
  // （这一层的入参形状只有 role 是确定的，所以用结构化类型而不是 ChatRequestMessage）
  const withTool: { role: string; content: string }[] = [
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "tool", content: "回执" }, { role: "assistant", content: "a2" },
    { role: "user", content: "q2" }, { role: "assistant", content: "a3" },
  ];
  assert.deepEqual(trimDialog(withTool, 3).map((m) => m.content), ["q2", "a3"]);
});

test("trimDialog：整窗没有 user 时不动它（清空上下文比开头别扭更糟）", () => {
  const msgs: ChatRequestMessage[] = [
    { role: "assistant", content: "a1" }, { role: "assistant", content: "a2" }, { role: "assistant", content: "a3" },
  ];
  assert.deepEqual(trimDialog(msgs, 2), [msgs[1], msgs[2]]);
});

// ---------- P7-⑥⑤：场景件注入位置（两个聊天端点共用一条规则） ----------

const sys = (role: "system", content: string): ContextMsg => ({ role, content });

test("injectSceneContext：场景提示词接在开头 system 之后，数据块插到最后一条提问之前", () => {
  const msgs: ContextMsg[] = [
    { role: "system", content: "入口系统提示词" },
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
  ];
  const out = injectSceneContext(msgs, { prompt: "场景：行情查询", block: "[实时数据]\n最新价 100.00" }, sys);
  assert.deepEqual(
    out.map((m) => m.content),
    ["入口系统提示词", "场景：行情查询", "q1", "a1", "[实时数据]\n最新价 100.00", "q2"],
    "数据块必须在提问之前：放在数组末尾等于「先看到回答任务、再补数据」，某些上游会把它当无关说明忽略",
  );
  assert.equal(out.every((m) => m.role === "system" || m.role === "user" || m.role === "assistant"), true);
  assert.equal(msgs.length, 4, "不能原地改写调用方传进来的数组");
});

test("injectSceneContext：开头多条 system 前置件（摘要、快照说明）之后才是场景提示词", () => {
  const msgs: ContextMsg[] = [
    { role: "system", content: "入口" }, { role: "system", content: "【更早对话摘要】" },
    { role: "user", content: "q" },
  ];
  const out = injectSceneContext(msgs, { prompt: "场景提示词" }, sys);
  assert.deepEqual(out.map((m) => m.content), ["入口", "【更早对话摘要】", "场景提示词", "q"]);
});

test("injectSceneContext：空内容一律不插（一个空 system 件会把轻量模型的整轮口径带偏）", () => {
  const msgs: ContextMsg[] = [{ role: "system", content: "入口" }, { role: "user", content: "q" }];
  assert.deepEqual(injectSceneContext(msgs, {}, sys), msgs);
  assert.deepEqual(injectSceneContext(msgs, { prompt: "", block: "   \n " }, sys), msgs);
  assert.deepEqual(injectSceneContext(msgs, { prompt: undefined, block: undefined }, sys), msgs);
  // 只有一件时另一件也不能留下空位
  const only = injectSceneContext(msgs, { prompt: "  ", block: "数据" }, sys);
  assert.deepEqual(only.map((m) => m.content), ["入口", "数据", "q"]);
});

test("injectSceneContext：没有用户提问时插到末尾；只有首条提问时数据块紧挨在它前面", () => {
  const noUser: ContextMsg[] = [{ role: "system", content: "入口" }, { role: "assistant", content: "a1" }];
  assert.deepEqual(injectSceneContext(noUser, { prompt: "p", block: "b" }, sys).map((m) => m.content), ["入口", "p", "a1", "b"]);
  const firstOnly: ContextMsg[] = [{ role: "user", content: "q" }];
  assert.deepEqual(injectSceneContext(firstOnly, { prompt: "p", block: "b" }, sys).map((m) => m.content), ["p", "b", "q"]);
});

test("injectSceneContext：造什么形状的件由调用方给（两个端点的消息类型不同）", () => {
  type Msg = ContextMsg & { id: string };
  const out = injectSceneContext<Msg>(
    [{ role: "user", content: "q", id: "u1" }],
    { prompt: "p", block: "b" },
    (role, content) => ({ role, content, id: `sys:${content}` }),
  );
  assert.deepEqual(out.map((m) => m.id), ["sys:p", "sys:b", "u1"]);
  assert.equal(out[2].role, "user", "原消息件不受影响");
});

// ---------- P7-⑥⑤：场景徽章（服务端判 -> 事件 -> 会话存档，一条链上的三个关口） ----------

const rawIntent = {
  scene: "quote", label: "行情查询", hits: ["现价"], alternates: [] as string[],
  symbol: "688256.SH", symbolSource: "question", inherited: false, followUp: true,
};

test("intentBadgeOf：只带真实判定结果，没有的键不留空壳", () => {
  const b = intentBadgeOf(rawIntent);
  assert.deepEqual(b, {
    scene: "quote", label: "行情查询", hits: ["现价"], symbol: "688256.SH", symbolSource: "question",
    inherited: false, followUp: true, skipped: [],
  });
  assert.equal("alternates" in b, false, "空 alternates 不该出现一个空数组键");
  assert.equal("prefetchChars" in b, false, "本轮没注入数据就不写这个键（0 与「没说」不能混）");
  assert.equal("prefetchChars" in intentBadgeOf(rawIntent, { prefetchChars: 0 }), false);
  const withOpts = intentBadgeOf({ ...rawIntent, alternates: ["screener"] }, { skipped: ["watchlist：自选清单为空"], prefetchChars: 320 });
  assert.deepEqual(withOpts.alternates, ["screener"]);
  assert.equal(withOpts.prefetchChars, 320);
});

test("intentBadgeOf：数组是复制的，事后改判定层的数据不会改掉已经发出去的徽章", () => {
  const hits = ["现价"];
  const skipped = ["watchlist：自选清单为空"];
  const b = intentBadgeOf({ ...rawIntent, hits }, { skipped, prefetchChars: 10 });
  hits.push("成交额");
  skipped.push("又改了一次");
  b.skipped.push("改徽章本身");
  assert.deepEqual(intentBadgeOf({ ...rawIntent, hits }).hits, ["现价", "成交额"]);
  assert.equal(b.prefetchChars, 10);
});

test("徽章穿过 SSE 一帧不丢：编码 -> 解码 -> applyEvent -> 存档归一，四步之后字段完全一样", () => {
  const badge: IntentBadge = intentBadgeOf({ ...rawIntent, alternates: ["screener"] }, { skipped: ["watchlist：自选清单为空"], prefetchChars: 512 });
  const frame = encodeStreamEvent({ type: "done", data: { fullText: "结论", intent: badge } });
  const ev = decodeStreamEvent(frame.replace(/^data: /, ""));
  assert.equal(ev?.type, "done");
  if (ev?.type !== "done") return;
  assert.deepEqual(ev.data.intent, badge, "往返必须无损：漏一个键界面上就是一个假徽章");
  const applied = applyEvent(msg("assistant", "", { id: "a1" }), ev);
  assert.deepEqual(applied.intent, badge);
  assert.equal(applied.streaming, false);
  assert.deepEqual(normalizeMessage(applied, "s1").intent, badge, "重载存档后徽章不能丢");
  // 服务端没判场景（没带 scene）时不留空壳，界面就不会画一个「按通用问答处理」的假徽章
  assert.equal("intent" in applyEvent(msg("assistant", "", { id: "a2" }), { type: "done", data: { fullText: "x" } }), false);
});

test("asStreamIntent：判不出来就整体 null，绝不拼半个看着像真话的徽章", () => {
  for (const bad of [null, undefined, 0, "quote", {}, { scene: "" }, { scene: 42 }]) {
    assert.equal(asStreamIntent(bad), null, `${JSON.stringify(bad) ?? "undefined"} 不是徽章`);
  }
});

test("asStreamIntent：缺的字段按诚实默认补，类型不对的逐项丢弃", () => {
  assert.deepEqual(asStreamIntent({ scene: "sentiment" }), {
    scene: "sentiment", label: "sentiment", hits: [], symbol: null, symbolSource: "none",
    inherited: false, followUp: false, skipped: [],
  });
  const i = asStreamIntent({
    scene: "sector", label: "", hits: ["板块", 7, null], symbol: "", symbolSource: 3,
    inherited: "yes", followUp: true, skipped: "not-an-array", alternates: [], prefetchChars: -5,
  });
  assert.equal(i?.label, "sector", "label 缺失就用场景名兜底，不显示空白");
  assert.deepEqual(i?.hits, ["板块"], "非字符串的命中词丢掉");
  assert.equal(i?.symbol, null);
  assert.equal(i?.symbolSource, "none");
  assert.equal(i?.inherited, false, "只有真 true 才算沿用");
  assert.equal(i?.followUp, true);
  assert.deepEqual(i?.skipped, []);
  assert.equal("alternates" in i!, false);
  assert.equal(i?.prefetchChars, 0, "负数收成 0，不能留一个负字数");
  assert.equal(asStreamIntent({ scene: "q", prefetchChars: NaN })?.prefetchChars, undefined);
  assert.equal(asStreamIntent({ scene: "q", prefetchChars: Infinity })?.prefetchChars, undefined);
  assert.equal(asStreamIntent({ scene: "q", prefetchChars: 2.9 })?.prefetchChars, 2);
});

// ---------- P7-⑥⑤：请求体契约（两个端点对「这一轮是不是对话」的口径） ----------

test("chatRequestBody：plain 端点把 scene 三键搬进 body.scene，且始终声明", () => {
  const msgs = [{ role: "user" as const, content: "q" }];
  const body = chatRequestBody("plain", msgs, {
    focusSymbol: "688256.SH", sessionSymbol: null, prevScene: "quote", contextWindow: 30, watchlist: [],
  });
  assert.deepEqual(body.scene, { focusSymbol: "688256.SH", sessionSymbol: null, prevScene: "quote" });
  for (const k of SCENE_KEYS) assert.equal(k in body, false, `${k} 搬进 scene 后顶层不能再留一份（两份迟早对不上）`);
  assert.deepEqual(body.contextWindow, 30);
  assert.equal(body.stream, true);
  assert.equal(body.messages, msgs);
  // 三个字段一个都没有也要写 scene：这条声明本身就是「这一轮是对话」的凭据
  assert.deepEqual(chatRequestBody("plain", msgs).scene, {});
});

test("chatRequestBody：tools 端点保持平铺，并且不带 scene（那个路由本身就是对话端点）", () => {
  const body = chatRequestBody("tools", [{ role: "user", content: "q" }], {
    mode: "decision", focusSymbol: "600519.SH", sessionSymbol: null, prevScene: null,
  });
  assert.equal("scene" in body, false);
  assert.equal(body.mode, "decision");
  assert.equal(body.focusSymbol, "600519.SH");
  assert.equal(body.sessionSymbol, null);
});

// ---------- P7-⑥⑥：端点按服务商能力选 ----------

test("pickChatEndpoint：OpenAI 兼容族才有工具调用环，其余如实退回纯对话", () => {
  for (const p of ["openai", "deepseek", "moonshot", "openrouter", "ollama", "custom"]) {
    assert.equal(supportsToolCalling(p), true, p);
    assert.equal(pickChatEndpoint(p, "auto"), "tools", p);
  }
  // 大小写与首尾空格不影响判断：服务商 id 是从设置里的下拉来的，但手改过的存档也要认得
  assert.equal(pickChatEndpoint(" DeepSeek ", "auto"), "tools");
  for (const p of ["anthropic", "gemini", "", "  ", null, undefined, "unknown-relay"]) {
    assert.equal(supportsToolCalling(p), false, `${String(p)} 没有工具环`);
    assert.equal(pickChatEndpoint(p, "auto"), "plain");
  }
  // 显式指定优先于能力判断（页面钉死某条路时不被动改写）
  assert.equal(pickChatEndpoint("anthropic", "tools"), "tools");
  assert.equal(pickChatEndpoint("deepseek", "plain"), "plain");
  assert.equal(pickChatEndpoint("deepseek"), "tools", "want 省略＝auto");
});

// ---------- P7-⑥⑥：回答风格只有一份定义 ----------

test("CHAT_MODES：键唯一、四个模式、说法齐全（首页下拉与对话页 chip 共用这一份）", () => {
  assert.deepEqual(CHAT_MODES.map((m) => m.key), ["decision", "judge", "deep", "search"]);
  assert.equal(new Set(CHAT_MODES.map((m) => m.key)).size, CHAT_MODES.length, "键不能重复：重复会让选中态对不上");
  for (const m of CHAT_MODES) {
    assert.ok(m.label.trim() && m.desc.trim(), `${m.key} 的文案不能为空`);
    assert.equal(chatModeLabel(m.key), m.label);
  }
});

test("isChatMode / asChatMode / chatModeLabel：外部输入（被改坏的存档、乱来的请求体）不冒充合法值", () => {
  for (const v of ["decision", "judge", "deep", "search"]) assert.equal(isChatMode(v), true);
  for (const v of ["", "DECISION", " decision", "hackson", null, undefined, 42, { key: "deep" }]) {
    assert.equal(isChatMode(v), false, `${String(v)} 不该被认成模式`);
  }
  // 服务端拿 mode 当查表键之前先过这道门：认不出的按默认口径答，而不是静默少一段风格说明
  assert.equal(asChatMode("judge"), "judge");
  assert.equal(asChatMode("hackson"), "decision");
  assert.equal(asChatMode(undefined), "decision");
  assert.equal(asChatMode("", "deep"), "deep");
  // 认不出的值不套一个说法：写「未选」而不是默认显示「决策模式」，免得界面和实际发出去的值不一致
  assert.equal(chatModeLabel(undefined), "未选");
  assert.equal(chatModeLabel("hackson"), "未选");
  assert.equal(chatModeLabel("deep"), "深度思考");
});
