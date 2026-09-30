// P7-⑩ 任务4「模型配置化层 + 全局系统 Prompt」的回归测试（纯内存：不 fetch、不碰库、不调模型）。
//
// 这一层的要害不在「能不能跑」，而在四条不许漂的口径：
//  1) 换模型只改 .env：解析结果是纯函数，默认值/双模式/免 Key 的线全在这里钉死；
//  2) Key 的走向：网关模式占位、官方模式必填、任何响应形状里都不许出现 Key 的值；
//  3) 本地网关只吃最后一条 user（README 6.5 实测），折叠层的形状错了等于历史凭空消失；
//  4) 50 个框架是全局系统 Prompt 的一部分：条数、首末条原文、以及「它属于对话层不属于模型层」
//     的分层纪律（内核文件零 import）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, FOLD_HEADERS, GATEWAY_PLACEHOLDER_KEY, LLM_ENV_KEYS,
  MAX_UPSTREAM_TIMEOUT_MS, MIN_UPSTREAM_TIMEOUT_MS,
  TEXT_BAD_BASE, TEXT_OFFICIAL_NO_KEY, clampUpstreamTimeoutMs, foldHistoryForGateway, gatewayUnreachableText,
  isLanBaseUrl, resolveServerLlm, shouldRetryNonStream,
} from "../../src/lib/llm/model-config-core.ts";
import {
  ANALYSIS_FRAME_CATEGORIES, allAnalysisFrames, renderAnalysisFrames,
} from "../../src/lib/llm/analysis-frames.ts";
import { assistantSystemPrompt } from "../../src/lib/desk/ai.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---------- 配置解析：双模式与默认值 ----------

test("零配置可跑：三个 LLM_* 全缺失时落在本地网关默认（7861 / doubao-pro / 占位 Key）", () => {
  const r = resolveServerLlm({});
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.channel.mode, "gateway");
  assert.equal(r.channel.baseUrl, DEFAULT_LLM_BASE_URL);
  assert.equal(r.channel.model, DEFAULT_LLM_MODEL);
  assert.equal(r.channel.apiKey, GATEWAY_PLACEHOLDER_KEY);
});

test("空串/满屏空格等于没配：默认值兜住，不把空串发给上游", () => {
  const r = resolveServerLlm({ LLM_BASE_URL: "  ", LLM_MODEL_NAME: "", LLM_API_KEY: "   " });
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.channel.baseUrl, DEFAULT_LLM_BASE_URL);
  assert.equal(r.channel.model, DEFAULT_LLM_MODEL);
});

test("官方 API 模式：非本机地址 + Key → 三元组原样通过，不塞占位 Key", () => {
  const r = resolveServerLlm({
    LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
    LLM_API_KEY: "sk-test-123",
    LLM_MODEL_NAME: "glm-4-plus",
  });
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.channel.mode, "official");
  assert.equal(r.channel.apiKey, "sk-test-123");
  assert.equal(r.channel.model, "glm-4-plus");
});

test("官方模式缺 Key 判不可用并指路 .env；本地网关缺 Key 永远可用（任务书：网关不校验随便填）", () => {
  const r = resolveServerLlm({ LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL_NAME: "deepseek-chat" });
  assert.equal(r.available, false);
  assert.equal(r.reason, TEXT_OFFICIAL_NO_KEY);
  for (const lan of ["http://localhost:7861/v1", "http://127.0.0.1:7861/v1", "http://192.168.1.20:7861/v1"]) {
    const g = resolveServerLlm({ LLM_BASE_URL: lan });
    assert.equal(g.available, true, lan);
    if (g.available) assert.equal(g.channel.mode, "gateway");
  }
});

test("非法地址早判：坏 URL 不带着去上游撞一次超时", () => {
  const r = resolveServerLlm({ LLM_BASE_URL: "localhost:7861/v1" });
  assert.equal(r.available, false);
  assert.equal(r.reason, TEXT_BAD_BASE);
});

test("三个键名钉死：改名等于默认值悄悄失效，测试必须先红", () => {
  assert.deepEqual(LLM_ENV_KEYS, ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL_NAME"]);
});

test("isLanBaseUrl：本机/内网/·local 一条不漏，公网一个不误伤", () => {
  for (const lan of ["http://localhost:7861/v1", "http://127.0.0.1:7861", "http://10.1.2.3:80/v1",
    "http://192.168.0.9:7861/v1", "http://172.16.5.4/v1", "http://172.31.9.9/v1", "http://mybox.local:7861/v1"]) {
    assert.equal(isLanBaseUrl(lan), true, lan);
  }
  for (const wan of ["https://api.openai.com/v1", "http://172.32.0.1/v1", "http://8.140.0.0/v1", "https://glm.example.cn/v4"]) {
    assert.equal(isLanBaseUrl(wan), false, wan);
  }
  assert.equal(isLanBaseUrl(":::bad"), false);
});

// ---------- 历史折叠（网关只收最后一条 user 的实测口径） ----------

test("折叠：system 进「系统要求」、既往轮次进「既往对话」、本轮问题原样在最后，结果只剩一条 user", () => {
  const out = foldHistoryForGateway([
    { role: "system", content: "S1" },
    { role: "user", content: "早先问题" },
    { role: "assistant", content: "早先回答" },
    { role: "system", content: "S2" },
    { role: "user", content: "本轮问题" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  const body = out[0].content;
  assert.ok(body.startsWith(FOLD_HEADERS.system), "系统要求段必须打头：模型先看到纪律再看对话");
  assert.ok(body.includes("S1") && body.includes("S2"));
  assert.ok(body.includes("用户：早先问题") && body.includes("助手：早先回答"));
  assert.ok(body.endsWith(`${FOLD_HEADERS.current}\n本轮问题`), "本轮问题必须原样出现在最后，不许被拼接吃掉");
});

test("折叠边界：单轮无历史不出现「既往对话」段；没有 user 发言原样交出不硬造", () => {
  const one = foldHistoryForGateway([{ role: "system", content: "S" }, { role: "user", content: "Q" }]);
  assert.equal(one.length, 1);
  assert.ok(!one[0].content.includes(FOLD_HEADERS.history));
  const noUser = foldHistoryForGateway([{ role: "system", content: "S" }, { role: "assistant", content: "A" }]);
  assert.equal(noUser.length, 2, "没有「本轮问题」可折时不发明一条 user");
});

test("折叠只认最后一条 user：其后的 assistant 残留（未完成轮）不冒充既往对话", () => {
  const out = foldHistoryForGateway([
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "这半截是流式残留" },
  ]);
  assert.equal(out[0].content.includes("流式残留"), false);
  assert.ok(out[0].content.endsWith("第二问"));
});

// ---------- SSE 降级判定 ----------

test("降级只在该降的时候降：吐过 delta 不重发、鉴权错不重发、连接断才重发一次", () => {
  assert.equal(shouldRetryNonStream("fetch failed", false), true);
  assert.equal(shouldRetryNonStream("connect ECONNREFUSED 127.0.0.1:7861", false), true);
  assert.equal(shouldRetryNonStream("socket hang up", false), true);
  assert.equal(shouldRetryNonStream("connect ECONNREFUSED 127.0.0.1:7861", true), false, "已吐字还重发 = 半截答案被重答一遍");
  assert.equal(shouldRetryNonStream("401 Unauthorized", false), false, "鉴权失败重试只会多等一次失败");
  assert.equal(shouldRetryNonStream("", false), false);
});

test("网关连不上要说病根：指向 .env 三元组与设置页出路，且不再引导豆包网关（P33 交接日口径）", () => {
  const t = gatewayUnreachableText("http://localhost:7861/v1");
  // 说清出路：.env 三元组 + 设置页凭据，用户照着就能自查
  assert.match(t, /LLM_BASE_URL/);
  assert.match(t, /LLM_API_KEY/);
  // 反钉：豆包网关已剔除，文案里不许再出现引导（防回归）
  assert.doesNotMatch(t, /豆包|doubao/i);
  assert.doesNotMatch(t, /start\.py/);
});

// ---------- 上游超时钳位（流式 / 非流式一份口径） ----------
//
// 背景：非流式 callOpenAI 原来写死 45s、完全不读请求体的 timeout_ms，事件理解这类结构化长生成
// （客户端传 120s）永远撞不到 120s，45s 一到就被判「连接上游超时」——「AI理解今日事件」点不动的根因之一。
// 这两条钉住：钳位口径是纯函数可回测；客户端确实把 timeoutMs 透传到了请求体。

test("上游超时钳位：只认 >=10s 的显式值，钳在 [10s,600s]，其余回落各自默认", () => {
  assert.equal(clampUpstreamTimeoutMs(120000, 45000), 120000);
  assert.equal(clampUpstreamTimeoutMs("120000", 45000), 120000);
  assert.equal(clampUpstreamTimeoutMs(9000, 45000), 45000, "低于 10s 视为没给，不替调用方缩短超时");
  assert.equal(clampUpstreamTimeoutMs(999999, 45000), MAX_UPSTREAM_TIMEOUT_MS);
  assert.equal(clampUpstreamTimeoutMs(undefined, 45000), 45000);
  assert.equal(clampUpstreamTimeoutMs(NaN, 120000), 120000);
  assert.equal(clampUpstreamTimeoutMs("abc", 120000), 120000);
  assert.equal(MIN_UPSTREAM_TIMEOUT_MS, 10000);
  assert.equal(MAX_UPSTREAM_TIMEOUT_MS, 600000);
});

test("非流式调用把客户端 timeoutMs 透传给 /api/ai/proxy（事件理解 120s 才能生效）", async () => {
  const { aiChatPlain } = await import("../../src/lib/desk/ai.ts");
  const orig = globalThis.fetch;
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/api/llm/config")) return new Response(JSON.stringify({ available: true }), { status: 200 });
    seen.push({ url: u, body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify({ content: "ok" }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const ai = { provider: "custom", baseUrl: "https://example.com/v1", apiKey: "k", model: "m" };
    await aiChatPlain(ai as never, [{ role: "user", content: "hi" }], { timeoutMs: 300000, maxTokens: 8192 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/ai/proxy");
    assert.equal(seen[0].body.timeout_ms, 300000, "不带这个键，服务端永远撞不到长超时（45s/120s 就断）");
    assert.equal(seen[0].body.max_tokens, 8192, "批量结构化输出要显式拉大生成预算（默认 2048 会截断 JSON）");
    // 不传 timeoutMs/maxTokens 时一个都不塞：不给服务端凭空加口径
    await aiChatPlain(ai as never, [{ role: "user", content: "hi" }]);
    assert.equal("timeout_ms" in seen[1].body, false);
    assert.equal("max_tokens" in seen[1].body, false);
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------- 50 框架：条数、原文、分层 ----------

test("框架总数恰为 50，分类数与附录一致（14 类）", () => {
  assert.equal(allAnalysisFrames().length, 50);
  assert.equal(ANALYSIS_FRAME_CATEGORIES.length, 14);
  assert.deepEqual(
    ANALYSIS_FRAME_CATEGORIES.map((c) => c.title),
    ["个股深度研究", "持仓诊断", "个股对比", "产业链挖掘", "主线与板块", "市场环境", "大跌与错杀",
      "事件驱动", "财报研究", "技术结构", "预期差研究", "寻找机会", "复盘型问题", "高阶研究问题"],
  );
});

test("首末条与任务书附录逐字一致（改动文案先过这条）", () => {
  assert.equal(
    allAnalysisFrames()[0],
    "全面分析这只股票，不要只看技术面。结合基本面、行业景气度、产业链、资金、估值和当前市场环境，告诉我现在市场到底在交易什么逻辑，最大的预期差在哪里。",
  );
  assert.equal(
    allAnalysisFrames()[49],
    "帮我建立这只股票的“跟踪清单”：未来哪些公司、行业数据、资金 / 政策变化一旦出现，就应该重新分析它。",
  );
});

test("renderAnalysisFrames：带总数与「不让用户选模板」纪律，分类小节齐全", () => {
  const s = renderAnalysisFrames();
  assert.ok(s.includes("【内置深度分析框架（共 50 个）】"));
  assert.ok(s.includes("界面不提供任何框架按钮"));
  for (const c of ANALYSIS_FRAME_CATEGORIES) assert.ok(s.includes(`### ${c.title}`));
});

test("全局 Prompt 落点：assistantSystemPrompt 尾部带框架段，所有对话入口一份同源", () => {
  const p = assistantSystemPrompt("（上下文）");
  assert.ok(p.includes("【内置深度分析框架（共 50 个）】"));
});

// ---------- 分层纪律（结构与奇门/回测轮同一套自查） ----------

/** 去掉整行注释后看代码本体：注释里出现 "fetch" 之类字样不该把纪律测试弄红，也不该被用来躲测试。 */
function codeOnly(src: string): string {
  return src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}

test("分层：内核零 import、不读 process.env、不 fetch、不取时钟；env 读取只发生在 model-config.ts", () => {
  const core = codeOnly(read("../../src/lib/llm/model-config-core.ts"));
  assert.ok(!/\bimport\b/.test(core), "内核一旦 import 别人，纯函数判定的边界就没了");
  assert.ok(!/process\.env/.test(core), "内核碰 process.env 就没法在 node/浏览器两侧同口径测");
  assert.ok(!/\bfetch\(/.test(core));
  assert.ok(!/new Date\(/.test(core));
  const cfg = codeOnly(read("../../src/lib/llm/model-config.ts"));
  assert.ok(cfg.includes("process.env.LLM_BASE_URL"), "读 env 的脏活只能在 model-config.ts 一处");
  const frames = codeOnly(read("../../src/lib/llm/analysis-frames.ts"));
  assert.ok(!/\bimport\b/.test(frames), "框架文件是纯文案，零 import：换模型不许牵动它");
});

test("Key 不外泄：状态端点与浏览器缓存的形状里没有 apiKey 字段", () => {
  const route = read("../../src/app/api/llm/config/route.ts");
  assert.ok(!/apiKey/.test(route), "GET /api/llm/config 只回模式/地址/模型名");
  const aits = read("../../src/lib/desk/ai.ts");
  assert.ok(!/serverLlm\w*[^\n]*apiKey/.test(aits), "浏览器侧的服务端通道状态里没有 Key，也不许打印");
});

test("请求头口径一份同源：浏览器没配凭据时只带 x-ai-server，一个凭据头都不发", async () => {
  const { aiRequestHeaders } = await import("../../src/lib/desk/ai.ts");
  const bare = { provider: "openai", baseUrl: "", apiKey: "", model: "" };
  const h = aiRequestHeaders(bare as never);
  assert.equal(h["x-ai-server"], "1");
  assert.equal(h["x-ai-base-url"], undefined);
  assert.equal(h["x-ai-api-key"], undefined);
  const full = { provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x", model: "deepseek-chat" };
  const h2 = aiRequestHeaders(full as never, { Accept: "text/event-stream" });
  assert.equal(h2["x-ai-base-url"], "https://api.deepseek.com");
  assert.equal(h2["x-ai-server"], undefined);
  assert.equal(h2.Accept, "text/event-stream");
});

test("端点选择：服务端通道未探明模式前不碰工具环；官方模式才放行 tools", async () => {
  const { resolveChatEndpoint } = await import("../../src/lib/desk/ai.ts");
  const bare = { provider: "openai", baseUrl: "", apiKey: "", model: "" };
  assert.equal(resolveChatEndpoint(bare as never, "auto"), "plain", "网关没有 function call，模式未知时宁可 plain");
  const full = { provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x", model: "deepseek-chat" };
  assert.equal(resolveChatEndpoint(full as never, "auto"), "tools");
  assert.equal(resolveChatEndpoint(full as never, "plain"), "plain");
});
