// R14 网关文本协议工具环：模型经 [[KAIRO_FETCH]] 请求补数 → 工作台真跑工具 → 带出身折回续答。
//
// 背景（对应用户所见）：R12/R13 收口后网关通道仍缺「自主取数」——doubao2API 实测只吃最后一条
// user 文本、不走 function call，官方工具环这条路用不了。本轮与用户拍板的思路：约定纯文字协议，
// 模型在回答末尾发取数请求块，系统解析后调 chat-tools 同一份注册表真取数，把结果折回对话续答。
// 钉什么：
//  - 协议解析/流式拦截/结果渲染/截断的纯函数边界（坏 JSON、开了没闭、超条数、超轮次都要有明确回法）；
//  - 接线只认「网关 + 带 scene 的对话轮」，官方模式与一次一问转发调用一个字都不多插；
//  - 执行走同一份 findTool 注册表（不开第二条数据管道），回测拉黑（proxy 通路 backtestReady:false）；
//  - 步骤进时间线带 source=model 与环专用 reason（预取/自取必须分得开）；
//  - 降级补发不整轮重来（工具已跑过的轮次不静默重取）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FETCH_CLOSE, FETCH_OPEN, GATEWAY_LOOP_BLOCKED, GATEWAY_LOOP_STEP_LABELS, GATEWAY_LOOP_STEP_REASON,
  MAX_FETCH_ROUNDS, MAX_REQUESTS_PER_ROUND, createFetchStreamFilter, gatewayFetchLoopBrief, isBlockedTool,
  parseFetchRequests, renderFetchResultsBlock, renderToolCatalog, splitRequests, stripFetchBlocks,
  type FetchResult,
} from "../../src/lib/desk/gateway-loop-core.ts";
import { GATEWAY_BRAIN_BRIEF } from "../../src/lib/llm/model-config-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const block = (json: string) => `${FETCH_OPEN}${json}${FETCH_CLOSE}`;

// ---------- 纯核：请求块解析 ----------

test("parseFetchRequests：标记前的正文归用户，块内 JSON 归系统；多块按出现顺序收", () => {
  const t = `我先看下盘面。[[KAIRO_FETCH]]{"tool":"stock_fund_flow","args":{"symbol":"600977.SH"},"reason":"要主力净额"}[[/KAIRO_FETCH]]还想要K线${block('{"tool":"stock_kline_summary","args":{"symbol":"600977.SH"}}')}`;
  const p = parseFetchRequests(t);
  assert.equal(p.markerFound, true);
  assert.equal(p.preText, "我先看下盘面。");
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[0].tool, "stock_fund_flow");
  assert.deepEqual(p.requests[0].args, { symbol: "600977.SH" });
  assert.equal(p.requests[0].reason, "要主力净额");
  assert.equal(p.requests[1].reason, ""); // 没给理由不编
  assert.deepEqual(p.malformed, []);
});

test("parseFetchRequests：没发请求块就是正常回答（markerFound=false，原文一字不动当 preText）", () => {
  const p = parseFetchRequests("今天缩量震荡，没有异常。");
  assert.equal(p.markerFound, false);
  assert.equal(p.preText, "今天缩量震荡，没有异常。");
  assert.deepEqual(p.requests, []);
});

test("parseFetchRequests：坏 JSON / 缺工具名 / 数组形状都落 malformed，不抛错也不猜", () => {
  const p = parseFetchRequests(`好。${block('{"tool": 坏掉的json')}还缺参数`);
  assert.equal(p.requests.length, 0);
  assert.equal(p.malformed.length, 1);
  const q = parseFetchRequests(block('{"args":{"symbol":"x"}}')); // 没有 tool
  assert.equal(q.malformed.length, 1);
  const r = parseFetchRequests(block("[1,2]")); // 不是对象
  assert.equal(r.malformed.length, 1);
});

test("parseFetchRequests：开标记没闭（断流/忘收尾）→ 整段尾巴吞进协议区记 malformed，不当正文回显", () => {
  const t = `等我查下${FETCH_OPEN}{"tool":"stock_news"`;
  const p = parseFetchRequests(t);
  assert.equal(p.markerFound, true);
  assert.equal(p.preText, "等我查下");
  assert.deepEqual(p.requests, []);
  assert.equal(p.malformed.length, 1);
  assert.match(p.malformed[0], /stock_news/);
});

test("parseFetchRequests：闭块后又冒出一个没跟闭标记的开块，同样如实记（不按正文外发）", () => {
  const t = `${block('{"tool":"a"}')}${FETCH_OPEN}{"tool":"b"`;
  const p = parseFetchRequests(t);
  assert.equal(p.requests.length, 1);
  assert.equal(p.malformed.length, 1);
});

test("stripFetchBlocks：从第一个开标记整段截干净（降级路径最后一道防线，宁剥不误显示）", () => {
  assert.equal(stripFetchBlocks(`结论在前。${block('{"tool":"x"}')}尾巴也不留`), "结论在前。");
  assert.equal(stripFetchBlocks("没有标记的正常回答"), "没有标记的正常回答");
  assert.equal(stripFetchBlocks(`${FETCH_OPEN}开了没闭`), "");
});

// ---------- 纯核：流式拦截（协议块绝不上屏） ----------

test("createFetchStreamFilter：标记被分片切开也拦得住——前缀扣住待发，拼出开标记后全吞", () => {
  const f = createFetchStreamFilter();
  assert.equal(f.push("先看盘面[[KAI"), "先看盘面"); // 疑似前缀扣住，之前的字照常外发
  assert.equal(f.push("RO_FETCH]]{\"too"), ""); // 拼成开标记：扣住的头也不吐，整段进协议区
  assert.equal(f.push('l":"stock_news"}[[/KAIRO_FETCH]]'), ""); // 标记后全吞
  assert.equal(f.flush(), ""); // 吞掉的不回流
  assert.equal(f.swallowed(), true);
  assert.equal(f.emittedLen(), "先看盘面".length);
});

test("createFetchStreamFilter：误扣的正常文字在 flush 时如数奉还（不吞用户该看的字）", () => {
  const f = createFetchStreamFilter();
  let out = f.push("今天缩量震");
  out += f.push("荡，[[不像标记"); // 扣住 [[
  out += f.push("。");
  assert.match(out, /今天缩量震荡，\[\[不像标记。/);
  assert.equal(f.swallowed(), false);
});

test("createFetchStreamFilter：开标记之前的文字原样外发，之后的一个字不漏出", () => {
  const f = createFetchStreamFilter();
  assert.equal(f.push(`我查下数据。${FETCH_OPEN}`), "我查下数据。");
  assert.equal(f.push('{"tool":"x"}'), "");
  assert.equal(f.emittedLen(), "我查下数据。".length);
});

// ---------- 纯核：结果块渲染（出身跟着数据走） ----------

const okResult: FetchResult = { tool: "stock_fund_flow", args: { symbol: "600977.SH" }, status: "ok", ms: 123, text: '{"主力净流入":123}', reason: "要主力净额" };

test("renderFetchResultsBlock：轮次抬头、逐条工具/参数/状态/耗时/理由自报，缺≠不存在的话术在册", () => {
  const b = renderFetchResultsBlock([okResult, { ...okResult, tool: "stock_news", status: "missing", ms: 45, text: '{"missing":"暂无"}' }], 1);
  assert.match(b, /【系统补数结果（第 1\/2 轮）】/);
  assert.match(b, /stock_fund_flow \{"symbol":"600977\.SH"\} —— 已取到（123ms）（你要的理由：要主力净额）/);
  assert.match(b, /没取到（工具回了缺失，不是不存在）/);
  assert.match(b, /还缺关键数据可以再发一轮/);
  assert.match(b, /不要向用户提「工具\/调用\/请求块」/);
});

test("renderFetchResultsBlock：refused/stale/error 各有独立人话状态；malformed 条目回「未执行」并截样", () => {
  const b = renderFetchResultsBlock(
    [
      { tool: "x", args: {}, status: "refused", ms: null, text: "超额未执行" },
      { tool: "y", args: {}, status: "stale", ms: 9, text: "{}" },
      { tool: "z", args: {}, status: "error", ms: 9, text: "{}" },
    ],
    2,
    ["坏掉的{json"],
  );
  assert.match(b, /—— 未执行/);
  assert.match(b, /取到了但不是新数/);
  assert.match(b, /取数失败/);
  assert.match(b, /不是合法的 JSON 请求块/);
  assert.match(b, /补数机会（2 轮）已用完/);
  assert.doesNotMatch(b, /还缺关键数据可以再发一轮/);
});

test("splitRequests：超过单轮上限的不执行（executed/skipped 两段都在案，不静默丢）", () => {
  const reqs = Array.from({ length: MAX_REQUESTS_PER_ROUND + 2 }, (_, i) => ({ tool: `t${i}`, args: {}, reason: "" }));
  const { executed, skipped } = splitRequests(reqs);
  assert.equal(executed.length, MAX_REQUESTS_PER_ROUND);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].tool, `t${MAX_REQUESTS_PER_ROUND}`);
});

// ---------- 协议卡与目录（一张注册表，不开第二份文案） ----------

test("协议卡：格式样例用常量原文、轮次/条数上限与纯核同源、『不许说已经查到』纪律在册", () => {
  const card = gatewayFetchLoopBrief("- stock_news：取个股新闻与公告");
  assert.ok(card.includes(`${FETCH_OPEN}{"tool"`), "样例里的标记就是协议认的那对");
  assert.ok(card.includes(`最多补 ${MAX_FETCH_ROUNDS} 轮`));
  assert.ok(card.includes(`一次回复最多 ${MAX_REQUESTS_PER_ROUND} 块`));
  assert.match(card, /你请求过的数据就是还没取到/);
  assert.match(card, /不许说「已经查到」/);
  assert.match(card, /stock_news：取个股新闻与公告/);
  assert.match(card, /对用户永远只说人话/);
});

test("协议卡只与身份卡搭用：身份卡第 1 条仍说『你没有任何工具』且写明唯一例外在协议卡", () => {
  assert.match(GATEWAY_BRAIN_BRIEF, /你没有任何工具/);
  assert.match(GATEWAY_BRAIN_BRIEF, /唯一合法例外见本轮若附上的「补数协议卡」/);
});

test("renderToolCatalog + 黑名单：回测不开放给文本环（proxy 通路 backtestReady:false 的同一口径）", () => {
  assert.deepEqual(GATEWAY_LOOP_BLOCKED, ["run_backtest"]);
  assert.equal(isBlockedTool("run_backtest"), true);
  assert.equal(isBlockedTool("stock_news"), false);
  const cat = renderToolCatalog([{ name: "run_backtest", desc: "回测" }, { name: "stock_snapshot", desc: "快照" }]);
  assert.doesNotMatch(cat, /run_backtest/);
  assert.match(cat, /- stock_snapshot：快照/);
});

test("时间线标签与 chat 工具环 STEP_LABELS 同步：共享键的值必须一字不差（两端口径不各说各话）", () => {
  const chatSrc = readSrc("src/app/api/ai/chat/route.ts");
  const m = /const STEP_LABELS_OVERRIDE: Record<string, string> = \{([\s\S]*?)\};/.exec(chatSrc);
  assert.ok(m, "chat 路由的 STEP_LABELS_OVERRIDE 在册");
  for (const [, key, val] of m[1].matchAll(/(\w+): "([^"]+)"/g)) {
    if (GATEWAY_LOOP_STEP_LABELS[key] !== undefined) {
      assert.equal(GATEWAY_LOOP_STEP_LABELS[key], val, `${key} 两处标签漂移`);
    }
  }
});

// ---------- 路由接线（只钉形状，不搬逻辑） ----------

test("proxy 接线：环只给「网关 + 带 scene 的对话轮 + OpenAI 兼容」，协议卡紧跟身份卡且只在环开着时出现", () => {
  const routeSrc = readSrc("src/app/api/ai/proxy/route.ts");
  assert.match(routeSrc, /const gatewayLoop = serverChannel\?\.mode === "gateway" && !!body\?\.scene && openaiCompat;/);
  assert.match(routeSrc, /return gatewayLoop \? \[out\[0\], \{ role: "system" as const, content: gatewayFetchLoopBrief\(fetchCatalog\) \}, \.\.\.out\.slice\(1\)\] : out;/);
  assert.match(routeSrc, /const fetchCatalog = renderToolCatalog\(TOOLS\);/);
});

test("proxy 接线：执行走同一份 findTool 注册表 + 环专用 reason 进步骤，回测工具执行前拦下", () => {
  const routeSrc = readSrc("src/app/api/ai/proxy/route.ts");
  assert.match(routeSrc, /const fn = blocked \? undefined : findTool\(r\.tool\);/);
  assert.match(routeSrc, /该工具未开放给网关文本协议（回测请走 AI 交易员页或量化门户）/);
  assert.match(routeSrc, /source: "model", reason: GATEWAY_LOOP_STEP_REASON/);
  assert.match(GATEWAY_LOOP_STEP_REASON, /网关工具环·工作台代取执行/);
});

test("proxy 接线：流式多轮驱动带轮次上限与断连收刀；降级补发不整轮重来、剥块后不外泄协议文本", () => {
  const routeSrc = readSrc("src/app/api/ai/proxy/route.ts");
  assert.match(routeSrc, /if \(loop\.roundsUsed >= MAX_FETCH_ROUNDS\) \{/);
  assert.match(routeSrc, /if \(isCancelled\(\)\) return outAll;/);
  assert.match(routeSrc, /shouldRetryNonStream\(raw, emittedDelta \|\| \(loop\?\.steps\.length \?\? 0\) > 0\)/);
  assert.match(routeSrc, /const c2 = c2Parsed\.preText;/);
  assert.match(routeSrc, /降级为一次性请求后不再走补数/);
});

test("proxy 接线：契约核对仍是三处（流式收口 / 降级补发 / 非流式），content 一个字符都不动", () => {
  const routeSrc = readSrc("src/app/api/ai/proxy/route.ts");
  const hits = routeSrc.match(/contractWarningOf\(turn, (content|c2)\)/g) ?? [];
  assert.equal(hits.length, 3);
});

test("chat 路由拒口话术更新：网关对话轮已能经文本环补数，但工具调用环仍需官方兼容模式", () => {
  const chatSrc = readSrc("src/app/api/ai/chat/route.ts");
  assert.match(chatSrc, /智能助手页的对话自 R14 起可经工作台文本协议补取/);
});
