// P8 子轮 B③ 独立代理网关回归测试（gateway/router-core.mjs 纯层 + kairo-router.mjs 服务层）。
//
// 每条断言都对着用户口径里一句会被问到的话：
//  - 「false 不访问 3014、不触发任何量化业务」→ e2e 拿假工作台数命中次数，必须是 0；
//  - 「同一会话切换任何模型大脑自动继承记忆」→ 同一 conversation_id 先走透传分支、再开引擎，
//    对面必须收到跨分支的完整时间线；
//  - 「分流仅做请求字段判断」→ readEngineFlag 只认布尔 true，"true"/1 一律不猜、按透传留痕；
//  - 「不改动 3014 内核」→ true 分支只消费 /api/ai/proxy 的既有契约（scene 门 + 五类帧）。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  readEngineFlag, apiBase, resolveBackend, sanitizeMessages, mergeMessages, nextTranscript,
  createTranscriptStore, stripRouterFields, buildWorkbenchPayload, workbenchHeaders,
  makeChunkCtx, createKairoFrameScanner, kairoEventToSse, decodeKairoFrame,
  wrapWorkbenchJson, openaiError,
} from "../../gateway/router-core.mjs";
import { createKairoRouter } from "../../gateway/kairo-router.mjs";

// ---------- 分流判定 ----------

test("引擎开关只认布尔 true：false/缺省/非布尔都走透传，且每种都给出不同的如实原因", () => {
  assert.equal(readEngineFlag({ enable_kairo_engine: true }).enabled, true);
  assert.equal(readEngineFlag({ enable_kairo_engine: false }).enabled, false);
  assert.equal(readEngineFlag({}).enabled, false);
  for (const bad of ["true", 1, {}, []]) {
    const r = readEngineFlag({ enable_kairo_engine: bad });
    assert.equal(r.enabled, false, `${JSON.stringify(bad)} 不是 true，不猜`);
    assert.match(r.reason, /不是布尔/);
  }
  assert.match(readEngineFlag({}).reason, /未声明/);
  assert.match(readEngineFlag({ enable_kairo_engine: false }).reason, /不访问工作台/);
});

test("大脑解析：缺省走 default_backend，名字大小写不敏感，认不出来如实报错（不静默换脑）", () => {
  const cfg = { default_backend: "doubao", backends: { doubao: { base_url: "http://x/v1", gateway: true }, deepseek: { base_url: "https://api.deepseek.com/v1" } } };
  assert.equal(resolveBackend({}, cfg).name, "doubao");
  assert.equal(resolveBackend({ kairo_backend: " DeepSeek " }, cfg).name, "deepseek");
  const bad = resolveBackend({ kairo_backend: "gpt9" }, cfg);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /不认识的大脑 "gpt9"/);
  assert.match(bad.error ?? "", /doubao、deepseek/, "报错要报出可用清单，否则用户只能瞎试");
  assert.equal(resolveBackend({}, { backends: {} }).ok, false, "没有缺省脑又没指定：如实拒，不编一个");
});

test("apiBase 兼容填不填 /v1 的两种写法", () => {
  assert.equal(apiBase("https://api.deepseek.com/v1/"), "https://api.deepseek.com");
  assert.equal(apiBase("https://api.deepseek.com"), "https://api.deepseek.com");
});

// ---------- 会话记忆 ----------

test("记忆合并只有一条规则：薄客户端由存档补全，带全量的客户端原样为准", () => {
  const stored = [{ role: "user", content: "第一问" }, { role: "assistant", content: "回答一" }];
  const thin = mergeMessages(stored, [{ role: "user", content: "那它呢" }]);
  assert.equal(thin.authoritative, "server");
  assert.deepEqual(thin.effective.map((m: { content: string }) => m.content), ["第一问", "回答一", "那它呢"]);
  const rich = mergeMessages(stored, [{ role: "user", content: "独立问题" }, { role: "assistant", content: "旧答" }, { role: "user", content: "新问" }]);
  assert.equal(rich.authoritative, "client");
  assert.deepEqual(rich.effective.map((m: { content: string }) => m.content), ["独立问题", "旧答", "新问"]);
  const fresh = mergeMessages([], [{ role: "user", content: "开场" }]);
  assert.equal(fresh.authoritative, "client", "没有存档时薄客户端就是它自己");
  // system 件在补全时保留在最前（客户端带的，不是存档脑补的）
  const withSys = mergeMessages(stored, [{ role: "system", content: "你是翻译" }, { role: "user", content: "hi" }]);
  assert.equal(withSys.effective[0].role, "system");
});

test("形状不对的消息件不进转发也不进存档（外部输入按不可信处理）", () => {
  assert.deepEqual(sanitizeMessages([{ role: "user", content: "ok" }, { role: "user" }, null, { content: 3 }, "x"] as never[]), [{ role: "user", content: "ok" }]);
  const t = nextTranscript([{ role: "system", content: "s" }, { role: "user", content: "u" }], "a");
  assert.deepEqual(t, [{ role: "user", content: "u" }, { role: "assistant", content: "a" }], "存档只记对话本体，system 每轮由客户端带");
  assert.deepEqual(nextTranscript([{ role: "user", content: "u" }], "   "), [{ role: "user", content: "u" }], "空回答不追加");
});

test("会话表：按 conversation_id 存取、非字符串键视为无会话、超上限先丢最旧", () => {
  const store = createTranscriptStore({ maxConversations: 2 });
  store.set("a", [{ role: "user", content: "1" }]);
  store.set("b", [{ role: "user", content: "2" }]);
  store.set("c", [{ role: "user", content: "3" }]);
  assert.equal(store.get("a").length, 0, "超上限先丢最旧的会话");
  assert.deepEqual(store.get("c"), [{ role: "user", content: "3" }]);
  store.set("", [{ role: "user", content: "x" }] as never);
  assert.equal(store.get(undefined as never).length, 0);
});

// ---------- 转发载荷 ----------

test("true 分支载荷：scene 门必须存在（不带＝3014 当非对话轮处理，量化链路整条哑掉）", () => {
  const p = buildWorkbenchPayload(
    { stream: true, focus_symbol: "688256.SH", session_symbol: "600519.SH", watchlist: [{ symbol: "600519.SH" }] },
    [{ role: "user", content: "那它呢" }],
  );
  assert.equal(p.stream, true);
  assert.equal(p.scene.focusSymbol, "688256.SH");
  assert.equal(p.scene.sessionSymbol, "600519.SH");
  assert.deepEqual(p.watchlist, [{ symbol: "600519.SH" }]);
  assert.deepEqual(buildWorkbenchPayload({}, []).scene, { focusSymbol: null }, "scene 永远在场，缺省字段留空");
});

test("true 分支大脑凭据：gateway 大脑不发头（走 3014 的 .env 通道+折叠，记忆继承靠它），API 大脑走 x-ai-*", () => {
  assert.deepEqual(workbenchHeaders({}, { ok: true, name: "doubao", backend: { base_url: "http://127.0.0.1:7861/v1", gateway: true } }), {});
  assert.deepEqual(workbenchHeaders({}, { ok: false, error: "x" } as never), {});
  const h = workbenchHeaders({ model: "deepseek-reasoner" }, { ok: true, name: "ds", backend: { base_url: "https://api.deepseek.com/v1", api_key: "k", model: "deepseek-chat" } });
  assert.equal(h["x-ai-base-url"], "https://api.deepseek.com/v1");
  assert.equal(h["x-ai-api-key"], "k");
  assert.equal(h["x-ai-model"], "deepseek-reasoner", "客户端点名的型号优先于清单缺省");
});

test("路由字段只属于网关：剥掉后原样交给 LLM，其余字段一个不动", () => {
  const rest = stripRouterFields({ model: "m", messages: [], enable_kairo_engine: false, kairo_backend: "x", conversation_id: "c", temperature: 0.7 });
  assert.deepEqual(Object.keys(rest).sort(), ["messages", "model", "temperature"]);
});

// ---------- 3014 五类帧 → OpenAI 帧 ----------

test("帧扫描按空行切、坏帧不污染流：解码只认带 type 的 JSON data 行", () => {
  const sc = createKairoFrameScanner();
  assert.deepEqual(sc.push('data: {"type":"de'), [], "半截帧不吐");
  const frames = sc.push('lta","data":{"content":"x"}}\n\ndata: {"type":"done"}\n\npartial-no-blank');
  assert.equal(frames.length, 2, "一次吐两帧，剩下的半截继续攒");
  assert.equal(decodeKairoFrame(frames[0]).data.content, "x");
  assert.equal(decodeKairoFrame(frames[1]).type, "done");
  const tail = sc.flush();
  assert.deepEqual(tail, ["partial-no-blank"], "流断开时把攒着的吐给调用方判一次");
  assert.equal(decodeKairoFrame('data: {"type":"delta","data":{"content":"x"}}').type, "delta");
  assert.equal(decodeKairoFrame("data: [DONE]"), null, "OpenAI 式裸 [DONE] 不是 3014 的帧形状，忽略");
  assert.equal(decodeKairoFrame('data: {"no_type":1}'), null);
  assert.equal(decodeKairoFrame(": comment"), null);
});

test("delta/warning/step/done/error 五类帧各有归位：正文成 chunk，警示与步骤走注释行，[DONE] 只发一次", () => {
  const ctx = makeChunkCtx("doubao");
  const d = kairoEventToSse({ type: "delta", data: { content: "你" } }, ctx);
  assert.match(d[0], /^data: \{"id":"chatcmpl-kairo/);
  assert.match(d[0], /"content":"你"/);
  assert.equal(ctx.text, "你");
  assert.equal(kairoEventToSse({ type: "warning", data: { text: "上游未流式" } }, ctx)[0], ": kairo-warning 上游未流式\n\n", "警示不得冒充正文");
  assert.match(kairoEventToSse({ type: "step", data: { label: "取快照", status: "ok" } }, ctx)[0], /: kairo-step 取快照 · ok/);
  const done = kairoEventToSse({ type: "done", data: { intent: { scene: "quote" }, fullText: "你好" } }, ctx);
  assert.match(done[0], /"finish_reason":"stop"/);
  assert.equal(done[1], "data: [DONE]\n\n");
  assert.deepEqual(kairoEventToSse({ type: "done", data: {} }, ctx), [], "第二个 done 帧不能重发收口（[DONE] 只发一次）");
  assert.equal((ctx.intent as { scene?: string } | null)?.scene, "quote");
  const e = makeChunkCtx("m");
  const err = kairoEventToSse({ type: "error", data: { message: "上游炸了" } }, e);
  assert.match(err[0], /: kairo-error 上游炸了/);
  assert.equal(err[1], "data: [DONE]\n\n", "错误也要收口，不能让客户端挂着一条永不结束的流");
  assert.deepEqual(kairoEventToSse({ type: "error", data: { message: "again" } }, e), []);
});

test("非流式包装：3014 的量化附加信息放 kairo 字段，OpenAI 形状不被污染", () => {
  const w = wrapWorkbenchJson({ content: "答", intent: { scene: "quote" }, steps: [{ step: 1 }], warning: null }, "m");
  assert.equal(w.object, "chat.completion");
  assert.equal(w.choices[0].message.content, "答");
  assert.equal(w.kairo.intent.scene, "quote");
  assert.equal(w.kairo.steps.length, 1);
  assert.equal("warning" in w.kairo, false, "没发生的事不占字段");
  assert.ok(openaiError("x").error.message.includes("x"));
});

// ---------- 端到端（进程内假上游，真 HTTP） ----------

async function withServer(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; handle(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits: () => hits, close: () => new Promise((r) => server.close(() => r())) };
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}

test("e2e false 分支：直透 LLM，3014 一次都不碰，路由字段剥干净，回答原样回", async () => {
  let seenBody: Record<string, unknown> = {};
  let seenAuth = "";
  const llm = await withServer(async (req, res) => {
    seenBody = await readJsonBody(req);
    seenAuth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "直透回答" } }] }));
  });
  const wb = await withServer((_req, res) => { res.writeHead(500).end("工作台被碰了"); });
  const prevEnv = process.env.KAIRO_WORKBENCH_URL;
  process.env.KAIRO_WORKBENCH_URL = wb.url;
  const router = createKairoRouter({ config: { default_backend: "ds", backends: { ds: { base_url: llm.url, api_key: "k1", model: "m" } } } });
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1/chat/completions`;
    const r = await postJson(url, { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], enable_kairo_engine: false, kairo_backend: "ds" });
    assert.equal(r.status, 200);
    assert.match(r.text, /直透回答/);
    assert.equal(wb.hits(), 0, "口径原话：false 不访问 3014、不触发任何量化业务");
    assert.equal(llm.hits(), 1);
    assert.equal(seenAuth, "Bearer k1");
    assert.equal("enable_kairo_engine" in seenBody, false);
    assert.equal("kairo_backend" in seenBody, false);
    assert.equal("scene" in seenBody, false, "透传分支不得把 scene 门塞给普通 LLM");
  } finally {
    if (prevEnv === undefined) delete process.env.KAIRO_WORKBENCH_URL;
    else process.env.KAIRO_WORKBENCH_URL = prevEnv;
    await new Promise((r) => router.close(r));
    await llm.close(); await wb.close();
  }
});

test("e2e true 分支非流式：3014 收到带 scene 的对话轮，回答包成 OpenAI 形状且 kairo 附加信息在", async () => {
  let seenBody: Record<string, unknown> = {};
  let seenHeaders: Record<string, unknown> = {};
  const wb = await withServer(async (req, res) => {
    seenBody = await readJsonBody(req);
    seenHeaders = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: "工作台回答", intent: { scene: "quote", symbol: "688256.SH" }, steps: [{ step: 1, tool: "stock_snapshot" }] }));
  });
  const llm = await withServer((_req, res) => { res.writeHead(500).end("LLM 被碰了"); });
  const prevEnv = process.env.KAIRO_WORKBENCH_URL;
  process.env.KAIRO_WORKBENCH_URL = wb.url;
  const router = createKairoRouter({ config: { default_backend: "db", backends: { db: { base_url: llm.url, gateway: true, model: "doubao" } } } });
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1/chat/completions`;
    const r = await postJson(url, { messages: [{ role: "user", content: "688256 现价" }], enable_kairo_engine: true, focus_symbol: "688256.SH" });
    const j = JSON.parse(r.text);
    assert.equal(j.choices[0].message.content, "工作台回答");
    assert.equal(j.kairo.intent.scene, "quote");
    assert.equal(j.kairo.steps.length, 1);
    assert.equal((seenBody.scene as { focusSymbol?: string } | undefined)?.focusSymbol, "688256.SH", "scene 门必须带上，否则 3014 当它是普通转发");
    assert.equal(seenHeaders["x-ai-base-url"], undefined, "gateway 大脑走 3014 自己的 .env 通道，不塞地址");
    assert.equal(wb.hits(), 1);
    assert.equal(llm.hits(), 0, "true 分支不该绕开工作台自己打 LLM");
  } finally {
    if (prevEnv === undefined) delete process.env.KAIRO_WORKBENCH_URL;
    else process.env.KAIRO_WORKBENCH_URL = prevEnv;
    await new Promise((r) => router.close(r));
    await wb.close(); await llm.close();
  }
});

test("e2e true 分支流式：3014 五类帧被翻成 OpenAI chunk + 注释行，正文逐字、结尾收口", async () => {
  const wb = await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "step", data: { step: 1, label: "取快照", status: "ok", source: "prefetch" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "delta", data: { content: "你" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "delta", data: { content: "好" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "warning", data: { text: "契约核对警告" } })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "done", data: { intent: { scene: "quote" } } })}\n\n`);
  });
  const prevEnv = process.env.KAIRO_WORKBENCH_URL;
  process.env.KAIRO_WORKBENCH_URL = wb.url;
  const router = createKairoRouter({ config: { default_backend: "db", backends: { db: { gateway: true } } } });
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1/chat/completions`;
    const r = await postJson(url, { stream: true, messages: [{ role: "user", content: "hi" }], enable_kairo_engine: true });
    assert.match(r.type, /text\/event-stream/);
    assert.match(r.text, /"content":"你"/);
    assert.match(r.text, /"content":"好"/);
    assert.match(r.text, /: kairo-step 取快照 · ok/);
    assert.match(r.text, /: kairo-warning 契约核对警告/);
    assert.match(r.text, /"finish_reason":"stop"/);
    assert.match(r.text.trimEnd(), /data: \[DONE\]$/, "必须收口，否则上层客户端挂着不返回");
    assert.ok(!/"content":"[^"]*kairo-warning/.test(r.text), "警示绝不进正文字段");
  } finally {
    if (prevEnv === undefined) delete process.env.KAIRO_WORKBENCH_URL;
    else process.env.KAIRO_WORKBENCH_URL = prevEnv;
    await new Promise((r) => router.close(r));
    await wb.close();
  }
});

test("e2e 记忆跨分支跨大脑继承：透传轮记账 → 开引擎时薄客户端拿到完整时间线（3014 侧只见最后一条的网关靠折叠兜底）", async () => {
  const llmBodies: Record<string, unknown>[] = [];
  const llm = await withServer(async (req, res) => {
    const b = await readJsonBody(req);
    llmBodies.push(b);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: `回答${llmBodies.length}` } }] }));
  });
  const wbBodies: Record<string, unknown>[] = [];
  const wb = await withServer(async (req, res) => {
    const b = await readJsonBody(req);
    wbBodies.push(b);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: "工作台回答" }));
  });
  const prevEnv = process.env.KAIRO_WORKBENCH_URL;
  process.env.KAIRO_WORKBENCH_URL = wb.url;
  const router = createKairoRouter({ config: { default_backend: "db", backends: { db: { gateway: true }, ds: { base_url: llm.url, model: "m" } } } });
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1/chat/completions`;
    // 第 1 轮：透传分支（DeepSeek 类大脑），带会话号
    await postJson(url, { model: "deepseek-chat", conversation_id: "conv-1", enable_kairo_engine: false, kairo_backend: "ds", messages: [{ role: "user", content: "第一问" }] });
    // 第 2 轮：仍在透传分支追问（薄客户端只带本句）
    await postJson(url, { model: "deepseek-chat", conversation_id: "conv-1", enable_kairo_engine: false, kairo_backend: "ds", messages: [{ role: "user", content: "第二问" }] });
    // 第 3 轮：切 true 分支（换豆包大脑、进量化链路），依然只带本句
    await postJson(url, { conversation_id: "conv-1", enable_kairo_engine: true, kairo_backend: "db", messages: [{ role: "user", content: "那它明天怎么看" }] });
    const m1 = llmBodies[0].messages as { content: string }[];
    assert.equal(m1.length, 1, "首轮无存档：原样转发");
    const m2 = llmBodies[1].messages as { content: string }[];
    assert.deepEqual(m2.map((x) => x.content), ["第一问", "回答1", "第二问"], "同分支第二轮就该继承存档");
    const m3 = (wbBodies[0].messages as { content: string }[]).map((x) => x.content);
    assert.deepEqual(m3, ["第一问", "回答1", "第二问", "回答2", "那它明天怎么看"],
      "口径原话：无论切换任何模型大脑，同一会话自动继承全部当前对话记忆——两条分支共用一份存档");
  } finally {
    if (prevEnv === undefined) delete process.env.KAIRO_WORKBENCH_URL;
    else process.env.KAIRO_WORKBENCH_URL = prevEnv;
    await new Promise((r) => router.close(r));
    await llm.close(); await wb.close();
  }
});

test("e2e 坏输入如实拒绝且不碰任何上游：不认识的脑 400、未知路径 404、非 JSON 体 400", async () => {
  const wb = await withServer((_req, res) => { res.writeHead(500).end("被碰了"); });
  const prevEnv = process.env.KAIRO_WORKBENCH_URL;
  process.env.KAIRO_WORKBENCH_URL = wb.url;
  const router = createKairoRouter({ config: { default_backend: "db", backends: { db: { gateway: true } } } });
  await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
    const r1 = await postJson(`${base}/v1/chat/completions`, { messages: [], enable_kairo_engine: true, kairo_backend: "gpt9" });
    assert.equal(r1.status, 400);
    assert.match(r1.text, /不认识的大脑/);
    const r2 = await fetch(`${base}/api/whatever`);
    assert.equal(r2.status, 404);
    const r3 = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{坏json" });
    assert.equal(r3.status, 400);
    assert.equal(wb.hits(), 0, "三条都没让任何量化业务发生");
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.deepEqual(h.backends, ["db"]);
  } finally {
    if (prevEnv === undefined) delete process.env.KAIRO_WORKBENCH_URL;
    else process.env.KAIRO_WORKBENCH_URL = prevEnv;
    await new Promise((r) => router.close(r));
    await wb.close();
  }
});
