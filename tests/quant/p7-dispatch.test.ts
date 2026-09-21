// P7-⑥④ 自动调度：执行编排内核（dispatch-core）+ 服务层接线（scene-dispatch）的回归测试。
//
// 这一段是 P7-⑥ 里最容易「说谎」的地方，所以每条断言都对着一个具体的含糊说法：
//  - 一个工具抛错 ≠ 整轮失败：其余取到的数据必须还能被模型用上，不然自动调度比手动还差；
//  - 取到空 / 接口回 missing ≠ 数值为 0：必须进「本轮未取到」清单，让模型写「暂无数据」；
//  - 客户端断开后没执行的调用 ≠ 取过了：只能记 notRun；
//  - 预取步骤与模型自己的工具调用共用一份序号，两套都从 1 开始就会在界面上互相覆盖。
// 服务层本身 import 了真实工具（不可测），所以用源码文本断言钉住「判定不外溢到服务层」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDispatchPlan, DISPATCH_RESULT_MAX_CHARS } from "../../src/lib/desk/dispatch-core.ts";
import { classifyIntent, planDispatch, renderDispatchBlock, type DispatchCall, type Intent } from "../../src/lib/desk/intent-core.ts";
import type { StepInfo } from "../../src/lib/desk/chat-core.ts";

function intent(question: string, extra: Partial<Intent> = {}): Intent {
  return classifyIntent({ question, ...extra });
}

function call(tool: string, args: Record<string, unknown> = {}): DispatchCall {
  return { tool, args, reason: `按场景预取 ${tool}` };
}

test("按计划顺序分配步骤号：running 与终态都吐给 onStep，且标明是系统预取和取它的原因", async () => {
  const seen: StepInfo[] = [];
  const r = await runDispatchPlan({
    calls: [call("market_sentiment"), call("stock_snapshot", { symbol: "688256.SH" })],
    execute: async () => ({ 涨跌: { 上涨: 3000 }, 数据源: "test-fixture" }),
    onStep: (s) => seen.push(s),
    stepStart: 3,
  });
  assert.deepEqual(r.steps.map((s) => s.step), [4, 5], "预取占了 4、5 号，模型的工具调用从 6 号接着编");
  assert.ok(r.steps.every((s) => s.status !== "running"));
  assert.ok(r.steps.every((s) => s.source === "prefetch"), "步骤必须区分系统预取与模型自取");
  assert.deepEqual(r.steps.map((s) => s.reason), ["按场景预取 market_sentiment", "按场景预取 stock_snapshot"]);
  assert.match(r.steps[1].label, /688256\.SH/, "标签里要带标的，否则并列两只票看不出哪步是哪只");
  // running 先出、终态后出：界面靠这个序列画出「正在等这一步」
  assert.equal(seen.filter((s) => s.status === "running").length, 2);
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((s) => s.step), [4, 5, 4, 5], "终态按计划顺序落，不按谁先返回");
});

test("单个工具抛错不拖垮整轮：该步 error 并进未取到清单，其余结果照样注入", async () => {
  const r = await runDispatchPlan({
    calls: [call("stock_snapshot", { symbol: "688256.SH" }), call("stock_fund_flow", { symbol: "688256.SH" })],
    execute: async (c) => {
      if (c.tool === "stock_fund_flow") throw new Error("东财接口超时");
      return { 现价: 1234.5 };
    },
  });
  assert.equal(r.steps[0].status, "ok");
  assert.equal(r.steps[1].status, "error");
  assert.match(r.steps[1].detail ?? "", /调用失败：东财接口超时/, "抛错要写成调用失败，不能写成「没有数据」");
  assert.equal(r.rows.filter((x) => x.ok).length, 1, "取到的那块必须还能给模型用");
  assert.deepEqual(r.missing, [{ tool: "stock_fund_flow", why: "调用失败：东财接口超时" }]);
  const block = renderDispatchBlock(r.rows, r.missing);
  assert.ok(block.includes("stock_snapshot"), "取到的照常注入");
  assert.ok(!/### stock_fund_flow/.test(block), "没取到的不得有数据块");
  assert.match(block, /本轮未取到的数据/);
  assert.match(block, /stock_fund_flow：调用失败/);
  assert.match(block, /暂无数据/, "必须明确指示模型写暂无数据，而不是凭印象补");
});

test("接口正常返回但没给值：判 missing 不判 error、不判 0，原因用工具自己写的那句", async () => {
  const r = await runDispatchPlan({
    calls: [call("stock_depth", { symbol: "688256.SH" })],
    execute: async () => ({ missing: "当前非交易时段，盘口未返回数据" }),
  });
  assert.equal(r.steps[0].status, "missing");
  assert.match(r.steps[0].detail ?? "", /缺失：当前非交易时段/);
  assert.equal(r.trace[0].status, "ok", "接口正常返回＝调用本身成功，缺数据是另一回事");
  assert.deepEqual(r.missing, [{ tool: "stock_depth", why: "缺失：当前非交易时段，盘口未返回数据" }]);
  // 一条都没取到时不注入空块：没有真实数据可说，交给场景提示词回「暂无数据」
  assert.equal(renderDispatchBlock(r.rows, r.missing), "");
});

test("结果按字数上限截断，并且如实说明截了多少", async () => {
  const big = "数".repeat(DISPATCH_RESULT_MAX_CHARS + 500);
  const r = await runDispatchPlan({ calls: [call("factor_screener")], execute: async () => ({ 全部结果: big }) });
  const text = r.rows[0].text;
  assert.ok(text.length < DISPATCH_RESULT_MAX_CHARS + 60, `实际 ${text.length} 字`);
  assert.match(text, /已截断，共 \d+ 字/, "截断必须留痕：不然模型会把前 N 只当成全部命中");
  assert.equal(r.rows[0].ok, true, "截断不是失败，数据是真的");
});

test("客户端断开：一个工具都不执行，全部记 notRun（既不谎称取到，也不谎称失败）", async () => {
  let executed = 0;
  const r = await runDispatchPlan({
    calls: [call("market_sentiment"), call("market_news")],
    execute: async () => { executed++; return {}; },
    isCancelled: () => true,
  });
  assert.equal(executed, 0);
  assert.equal(r.steps.length, 0);
  assert.deepEqual(r.notRun, ["market_sentiment", "market_news"]);
  assert.equal(r.trace.length, 0);
});

test("结果无法序列化成 JSON：按无数据处理，不谎称取到，也不让整轮挂掉", async () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  const r = await runDispatchPlan({ calls: [call("sector_rank")], execute: async () => circular });
  assert.equal(r.steps[0].status, "missing");
  assert.match(r.steps[0].detail ?? "", /无法序列化/, "要说是代码问题，不能糊成「今天没有板块数据」");
  assert.equal(r.rows[0].ok, false);
  assert.equal(renderDispatchBlock(r.rows, r.missing), "", "没有真数据就不注入，宁可让模型回「暂无数据」");
});

test("并发返回顺序乱掉也要按计划顺序落：步骤、注入块、trace 三处顺序一致", async () => {
  const r = await runDispatchPlan({
    calls: [call("market_sentiment"), call("stock_snapshot", { symbol: "688256.SH" }), call("market_news")],
    execute: async (c) => {
      // 第一个最慢、最后一个最快：按完成顺序装配就会错位
      await new Promise((res) => setTimeout(res, c.tool === "market_sentiment" ? 25 : c.tool === "market_news" ? 1 : 12));
      return { 是谁: c.tool };
    },
  });
  assert.deepEqual(r.steps.map((s) => s.tool), ["market_sentiment", "stock_snapshot", "market_news"]);
  assert.deepEqual(r.rows.map((x) => x.tool), ["market_sentiment", "stock_snapshot", "market_news"]);
  assert.deepEqual(r.trace.map((x) => x.name), ["market_sentiment", "stock_snapshot", "market_news"]);
  assert.match(renderDispatchBlock(r.rows, r.missing), /market_sentiment[\s\S]*stock_snapshot[\s\S]*market_news/);
});

test("trace 与非流式降级同一口径：名字/参数/耗时/摘要都在，摘要限长", async () => {
  const long = JSON.stringify({ 明细: "结".repeat(300) });
  const r = await runDispatchPlan({ calls: [call("watchlist_overview")], execute: async () => long });
  assert.equal(r.trace[0].name, "watchlist_overview");
  assert.deepEqual(r.trace[0].args, {});
  assert.equal(r.trace[0].status, "ok");
  assert.ok(r.trace[0].ms >= 0);
  assert.ok(r.trace[0].summary.length <= 121, `摘要必须短到能进界面一行：${r.trace[0].summary.length}`);
});

test("执行的是计划里的每一项：预取数量与 planDispatch 的结果一一对应", async () => {
  const planned = planDispatch({ intent: intent("688256 和 300750 明天怎么看"), watchlistCount: 0 });
  const done: string[] = [];
  const r = await runDispatchPlan({ calls: planned.calls, execute: async (c) => { done.push(c.tool); return { ok: 1 }; } });
  assert.deepEqual(done, planned.calls.map((c) => c.tool));
  assert.equal(r.steps.length, planned.calls.length);
  assert.ok(planned.calls.length >= 2, "这只票至少要预取两组数据，否则用例失去意义");
});

// ---------- 服务层接线：判定不许外溢 ----------

const sceneSrc = readFileSync(new URL("../../src/lib/desk/scene-dispatch.ts", import.meta.url), "utf8");
const dispatchSrc = readFileSync(new URL("../../src/lib/desk/dispatch-core.ts", import.meta.url), "utf8");

test("分层不破：编排内核不碰 IO，服务层不写判定", () => {
  // dispatch-core 是纯层：node --test 能直跑的前提就是它不 import 服务层、不 fetch
  assert.ok(!/@\/lib\/desk\/chat-tools|from "\.\/chat-tools/.test(dispatchSrc), "编排内核不得依赖工具服务层");
  assert.ok(!/\bfetch\(/.test(dispatchSrc), "编排内核不发请求");
  assert.ok(!/use client/.test(dispatchSrc));
  // 服务层只做接线：计划与说法必须来自纯层，出现第二套判定就会和测试里的口径分叉
  assert.ok(/planDispatch\(/.test(sceneSrc) && /renderDispatchBlock\(/.test(sceneSrc), "服务层必须复用纯层的计划与注入块");
  assert.ok(/findTool\(/.test(sceneSrc), "取数动作必须走 chat-tools 的注册表（与工具调用环同一份实现）");
  assert.ok(!/\bfetch\(/.test(sceneSrc) && !/@\/lib\/quant/.test(sceneSrc), "服务层不自己发请求、不自己算指标");
  assert.ok(!/case "sentiment"|SCENE_LABELS|toolsForScene\(/.test(sceneSrc), "场景判定不许在服务层重抄一遍");
});

// ---------- 一轮对话的接线（scene-dispatch + 两个聊天端点 + 三个入口） ----------

const chatRouteSrc = readFileSync(new URL("../../src/app/api/ai/chat/route.ts", import.meta.url), "utf8");
const proxyRouteSrc = readFileSync(new URL("../../src/app/api/ai/proxy/route.ts", import.meta.url), "utf8");
const useChatSrc = readFileSync(new URL("../../src/lib/desk/use-chat.ts", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("../../src/lib/desk/store.ts", import.meta.url), "utf8");
const assistantSrc = readFileSync(new URL("../../src/components/desk/pages/AssistantPage.tsx", import.meta.url), "utf8");
const homeSrc = readFileSync(new URL("../../src/components/desk/pages/AiHomePage.tsx", import.meta.url), "utf8");

test("prepareSceneTurn 只做接线：判定、拆快照、造徽章全部来自纯层", () => {
  assert.ok(/splitSnapshotMessage\(/.test(sceneSrc), "判场景只看用户原话：快照里的「涨停/成交额」会把闲聊判成大盘情绪");
  assert.ok(/classifyIntent\(/.test(sceneSrc) && /asScene\(opts\.prevScene\)/.test(sceneSrc), "场景判定必须走 intent-core，且外部传来的 prevScene 先过白名单");
  assert.ok(/intentBadgeOf\(/.test(sceneSrc), "徽章字段由 chat-core 造，服务层不另写一份字段表");
  assert.ok(!/SCENE_RULES|sceneHits\(|function classify/.test(sceneSrc), "服务层里出现第二套判定就是漂移的开始");
});

test("两个聊天端点共用同一份场景接线：同一句话判同一个场景、注入同一批数据", () => {
  for (const [name, src] of [["/api/ai/chat", chatRouteSrc], ["/api/ai/proxy", proxyRouteSrc]] as const) {
    assert.ok(/prepareSceneTurn\(/.test(src), `${name} 必须走 prepareSceneTurn，自己判一套迟早和另一边对不上`);
    assert.ok(/injectSceneContext\(/.test(src), `${name} 的插入位置必须由纯层定，两边各排一次顺序就会有两种口径`);
    assert.ok(!/classifyIntent\(|planDispatch\(|scenePrompt\(/.test(src), `${name} 不碰判定与计划`);
    assert.ok(/intent: turn\.badge/.test(src), `${name} 要把徽章交出去（流式与非流式两条出口都得有）`);
    // 场景层自己出错不能拖垮整轮：降级成「本轮无自动取数」并留下说法
    assert.ok(/场景自动调度未完成/.test(src) && /本轮未做场景自动取数/.test(src), `${name} 缺少降级留痕`);
  }
});

test("proxy 只服务被声明为对话的请求：没带 scene 就原样转发，一句提示词都不加", () => {
  assert.match(proxyRouteSrc, /if \(!body\?\.scene\) return null/, "scene 是对话轮的唯一凭据；漏掉这道门，研究页/事件理解/Agent 循环都会被注入场景提示词");
  assert.match(proxyRouteSrc, /const baseMessages|injectSceneContext\(messages/, "无场景轮次走原消息");
});

test("预取的步骤号交给工具调用环接着编：两套步骤不能都从 1 开始", () => {
  assert.match(chatRouteSrc, /stepStart: turn\?\.nextStep \?\? 0/, "流式与非流式两条路都要接上号");
  assert.equal((chatRouteSrc.match(/stepStart: turn\?\.nextStep/g) ?? []).length, 2, "非流式与流式各一次，少一处就是那条路上序号从 1 重来");
});

test("发送入口只剩两处，且都走同一份 useChatSend + auto 端点", () => {
  const senders = [
    "../../src/components/desk/pages/AssistantPage.tsx",
    "../../src/components/desk/AssistantWidget.tsx",
  ];
  for (const p of senders) {
    const src = readFileSync(new URL(p, import.meta.url), "utf8");
    assert.match(src, /useChatSend\(/, `${p} 必须走共用发送逻辑`);
    assert.ok(!/\bstreamChat\(/.test(src), `${p} 不该自己发流：那等于把窗口/降级/价位校验再抄一遍`);
    // 端点按服务商能力选；写死 "plain"/"tools" 会让同一个问题在不同入口拿到不同能力
    assert.match(src, /endpoint: "auto"/, `${p} 要用 auto 端点，而不是自己钉死一条`);
    // 兜底（非流式那一路）的参数集中在 use-chat 的 defaultFallback：页面各写一套就会漏带 scene
    assert.ok(!/fallback:/.test(src), `${p} 不该自带兜底：降级参数只允许有一处定义`);
    assert.ok(!/\baiChatPlain\(|\baiChatTools\(/.test(src), `${p} 不再直接调服务层聊天函数`);
    assert.match(src, /SceneBadge/, `${p} 要显示场景徽章：徽章只在一处画会出现「这页有、那页没有」`);
  }
  // 追问要能沿用上一轮的标的与场景：这两份输入由上一条助手消息的徽章给出
  assert.match(useChatSrc, /sessionSymbol/, "会话标的得随请求带上");
  assert.match(useChatSrc, /prevScene/, "上一轮场景得随请求带上");
  // 沿用标的要往前找「最近一条带标的的徽章」，不能跟着场景一起只看上一条：
  // 浏览器实测（3014）先问 688256 现价、中间点一句没带标的的快捷问、再问「那它明天怎么看」，
  // 只看上一条徽章等于把标的清空，退到分析页当前品种 600519.SH —— 一个「它」答成了另一只票。
  assert.match(useChatSrc, /m\.intent\?\.symbol/, "会话标的要跳过没有标的的那几轮往前找");
  assert.ok(!/sessionSymbol: prevIntent\?\.symbol/.test(useChatSrc), "上一条徽章可以没有标的，直接拿它就等于清空上下文");
  assert.match(useChatSrc, /intent: cur\.intent/, "徽章得写回消息，否则下一轮无从沿用、界面也不显示场景");
  // 浏览器实测抓到的坑：流式那一轮 done 带的全文与已攒内容相同，去重逻辑把「整件事件」丢了，
  // 徽章跟着一起没 —— 于是出现「有步骤、没场景徽章」。去重只能丢全文，不能丢徽章。
  assert.match(useChatSrc, /if \(!ev\.data\?\.intent\) return;/, "done 去重时必须先确认徽章，没徽章才整件丢掉");
  assert.match(useChatSrc, /cur = \{ \.\.\.cur, intent: ev\.data\.intent \}/, "全文回放被丢掉时，徽章要单独并回消息");
  // 兜底参数集中在一处，且两条端点各自的字段形状由纯层/服务层函数负责
  assert.match(useChatSrc, /function defaultFallback/, "降级路径的唯一实现");
  // P7-⑩：入口从 pickChatEndpoint 换成 resolveChatEndpoint（多了「服务端通道按模式定」这一层判），
  // 钉的仍是原口径 —— 端点选择在纯层一处，页面里不判服务商。
  assert.match(useChatSrc, /resolveChatEndpoint\(|pickChatEndpoint\(/, "端点选择走纯层，不在页面里判服务商");
});

test("首页收敛为纯入口：交接那一句话，自己不发请求、不画会话", () => {
  const src = readFileSync(new URL("../../src/components/desk/pages/AiHomePage.tsx", import.meta.url), "utf8");
  assert.match(src, /askInAssistant\(/, "首页提问只能交给唯一的对话页去发");
  // 回答风格是「同一个设置的两种画法」：读 store，不在首页另存一份
  assert.match(src, /s\.assistantMode/, "首页的模式读自 store");
  assert.match(src, /s\.setAssistantMode/, "首页改模式写回 store");
  for (const [needle, why] of [
    [/useChatSend\(/, "首页再挂一套发送逻辑就是本轮要拆掉的东西"],
    [/\bstreamChat\(|\baiChatPlain\(|\baiChatTools\(/, "首页不直接发请求"],
    [/StepTimeline|Markdown/, "会话渲染只属于对话页，两处画就会两处漂移"],
    [/newSession|switchSession|dropSession/, "会话管理只有一处入口（对话页顶栏）"],
    [/useState<ChatMode>|\{ key: Mode; label/, "模式清单只能有一份（modes.ts），页面各自抄就会漂"],
  ] as const) {
    assert.ok(!needle.test(src), `${why}（首页里出现了 ${needle}）`);
  }
});

test("交接是一次性的：只写 pendingAsk + 跳对话页，且不落盘、取一次即清", () => {
  // 落点必须是唯一的对话页（PageKey 里它叫 copilot，写错成一个不存在的页就会静默停在原页）
  assert.match(storeSrc, /set\(\{ pendingAsk: question, page: "copilot" \}\)/,
    "askInAssistant 要同时写 pendingAsk 并跳到 copilot");
  assert.match(storeSrc, /if \(!question\) return;/, "空正文不交接、也不跳页");
  assert.match(storeSrc, /pendingAsk: null,/, "初值为空：首屏不该有待发问题");
  assert.match(storeSrc, /if \(pending\) set\(\{ pendingAsk: null \}\)/, "取走即清：StrictMode 双跑/刷新都不能重发");
  // 一次性交接属于「导航状态」，不是会话内容：进存档的话刷新页面就会把上一次那句重问一遍
  const partialize = storeSrc.slice(storeSrc.indexOf("partialize: (s) => ({"));
  assert.ok(partialize.length > 0 && !/pendingAsk/.test(partialize), "pendingAsk 不得出现在 partialize 白名单里");
  // 模式是长期偏好，和 ai/watchlist 一样要落盘（否则刷新就回到决策模式，而界面刚显示的是研判）
  assert.match(partialize, /assistantMode: s\.assistantMode/, "assistantMode 要进存档");
  // 只有对话页消费它
  assert.match(assistantSrc, /takePendingAsk\(\)/, "对话页进页取走那一句并发送");
});

test("回答风格只有 modes.ts 一份定义，两个画法都从它出", () => {
  const modesSrc = readFileSync(new URL("../../src/lib/desk/modes.ts", import.meta.url), "utf8");
  assert.ok(!/use client/.test(modesSrc) && !/@\//.test(modesSrc), "modes.ts 保持纯层，测试可直跑");
  for (const p of [
    ["../../src/components/desk/pages/AiHomePage.tsx", homeSrc],
    ["对话页", assistantSrc],
  ] as const) {
    assert.match(p[1], /from "@\/lib\/desk\/modes"|import \{ CHAT_MODES/, `${p[0]} 要用同一份模式清单`);
  }
});

test("mode 是浏览器带来的外部输入：进提示词之前先过白名单", () => {
  assert.match(chatRouteSrc, /const mode = asChatMode\(body\?\.mode\)/, "路由不得把 body.mode 当合法值直接用");
  assert.ok(!/body\?\.mode \?\? "decision"/.test(chatRouteSrc), "旧写法（认不出也照样当决策）不该回来");
  assert.match(chatRouteSrc, /function systemPrompt\(mode: ChatMode/, "查表键收成四个合法值，加模式漏登记编译期就报");
  assert.ok(!/modeNote\[mode\] \?\? ""/.test(chatRouteSrc), "合法性由 asChatMode 保证，不再靠 ?? 静默兜一个不声明的空缺");
});
