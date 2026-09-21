#!/usr/bin/env node
// P8 子轮 B 独立代理网关 —— HTTP 服务层（零 npm 依赖，只用 node 内置）。
//
// 它只做三件事：读 enable_kairo_engine 布尔 → 分流（true 转 3014 /api/ai/proxy，false 直透 LLM）
// → 按 conversation_id 记会话，两条分支共用同一份存档。判定全在 router-core.mjs（纯层、可单测），
// 这里只有 IO。3014 内核不改动：它对外已有的 scene 门 / x-ai-* 头 / 五类 SSE 帧就是本文件的消费契约。
//
// 启动：node gateway/kairo-router.mjs
// 环境变量：
//   KAIRO_ROUTER_PORT        监听端口，默认 7900
//   KAIRO_WORKBENCH_URL      工作台地址，默认 http://127.0.0.1:3014
//   KAIRO_BACKENDS_JSON      大脑清单（内联 JSON）
//   KAIRO_BACKENDS_FILE      大脑清单（文件路径，优先于上一项之外的兜底）
//   KAIRO_DEFAULT_BACKEND    缺省大脑名，默认 doubao
//   KAIRO_UPSTREAM_TIMEOUT_MS 上游超时，默认 120000
// 清单形状：{ default_backend?, backends: { 名字: { base_url, api_key?, model?, gateway? } } }
// gateway:true 表示该大脑经本地协议转换（不支持 tools、只吃最后一条 user），true 分支将走 3014 的
// .env 通道 + 网关折叠来保住记忆，而不是把它的地址塞进 x-ai-base-url。

import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  readEngineFlag, resolveBackend, apiBase, mergeMessages, nextTranscript,
  createTranscriptStore, stripRouterFields, buildWorkbenchPayload, workbenchHeaders,
  makeChunkCtx, createKairoFrameScanner, kairoEventToSse, decodeKairoFrame,
  wrapWorkbenchJson, openaiError, sanitizeMessages,
} from "./router-core.mjs";

const MAX_BODY = 2 * 1024 * 1024; // 2MB：对话轮用不到这么多，超了按坏请求处理，不陪它耗内存

const BUILTIN_BACKENDS = {
  doubao: { base_url: "http://127.0.0.1:7861/v1", model: "doubao", gateway: true },
  deepseek: {
    base_url: "https://api.deepseek.com/v1",
    api_key: process.env.DEEPSEEK_API_KEY || "",
    model: "deepseek-chat",
  },
  siliconflow: {
    base_url: "https://api.siliconflow.cn/v1",
    api_key: process.env.SILICONFLOW_API_KEY || "",
    model: process.env.SILICONFLOW_MODEL || "Qwen/Qwen2.5-72B-Instruct",
  },
};

export function loadConfig(env = process.env) {
  let cfg = { default_backend: env.KAIRO_DEFAULT_BACKEND || "doubao", backends: { ...BUILTIN_BACKENDS } };
  let raw = env.KAIRO_BACKENDS_JSON || null;
  if (!raw && env.KAIRO_BACKENDS_FILE) {
    try {
      raw = readFileSync(env.KAIRO_BACKENDS_FILE, "utf8");
    } catch (e) {
      // 清单文件读不到不静默用内置：配了却没生效和没配是两件事，启动期如实说
      console.error(`[kairo-router] KAIRO_BACKENDS_FILE 读取失败（${e.message}），退回内置大脑清单`);
    }
  }
  if (raw) {
    try {
      const o = JSON.parse(raw);
      cfg = {
        default_backend: o.default_backend ?? cfg.default_backend,
        backends: { ...cfg.backends, ...(o.backends ?? {}) },
      };
    } catch (e) {
      console.error(`[kairo-router] 大脑清单不是合法 JSON（${e.message}），退回内置清单`);
    }
  }
  return cfg;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体超过 2MB 上限"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

async function fetchUpstream(url, init, envMs) {
  const ms = Number(envMs) > 0 ? Number(envMs) : 120_000;
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** 累积一条上游 SSE：边转发给客户端边把正文攒出来（供会话记账）。onFrame 由分支决定翻译口径。 */
async function pipeSse(upstreamRes, res, onFrame) {
  const dec = new TextDecoder();
  for await (const chunk of upstreamRes.body) {
    const txt = typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
    if (onFrame) onFrame(txt);
    else res.write(txt);
  }
}

/** true 分支：转发 3014 /api/ai/proxy（完整量化业务：场景取数、Agent 补充轮、契约、新鲜度） */
async function runWorkbench({ req, res, body, effective, resolved, cfg }) {
  const workbench = (process.env.KAIRO_WORKBENCH_URL || "http://127.0.0.1:3014").replace(/\/+$/, "");
  const payload = buildWorkbenchPayload(body, effective);
  const headers = { "Content-Type": "application/json", ...workbenchHeaders(body, resolved) };
  const upstream = await fetchUpstream(`${workbench}/api/ai/proxy`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, process.env.KAIRO_UPSTREAM_TIMEOUT_MS);

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (payload.stream && isSse) {
    sseHead(res);
    const ctx = makeChunkCtx(body?.model ?? "kairo-router");
    const scanner = createKairoFrameScanner();
    const feed = (txt) => {
      for (const frame of scanner.push(txt)) {
        const ev = decodeKairoFrame(frame);
        if (ev) for (const line of kairoEventToSse(ev, ctx)) res.write(line);
      }
    };
    await pipeSse(upstream, res, feed);
    for (const frame of scanner.flush()) {
      const ev = decodeKairoFrame(frame);
      if (ev) for (const line of kairoEventToSse(ev, ctx)) res.write(line);
    }
    // 上游没发 done 就断了：如实留注释再说结束——不给客户端挂一条永不收口的流
    if (!ctx.finished) {
      res.write(`: kairo-error 工作台流在未发 done 的情况下断开\n\ndata: [DONE]\n\n`);
      ctx.finished = true;
    }
    res.end();
    return ctx.text;
  }

  // 非流式（或上游没按流回）：整体 JSON → OpenAI chat.completion，量化附加信息在 kairo 字段
  const text = await upstream.text();
  if (!upstream.ok) {
    sendJson(res, upstream.status, openaiError(`工作台返回 ${upstream.status}：${text.slice(0, 400)}`));
    return "";
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    sendJson(res, 502, openaiError(`工作台返回的不是 JSON：${text.slice(0, 200)}`));
    return "";
  }
  const wrapped = wrapWorkbenchJson(json, body?.model ?? "kairo-router");
  sendJson(res, 200, wrapped, { "x-kairo-backend": resolved?.name ?? "" });
  return String(json?.content ?? "");
}

/** false 分支：直透对应 LLM，全程不碰 3014（这是本轮口径里最要钉死的一条） */
async function runDirect({ res, body, effective, resolved }) {
  const b = resolved.backend;
  const url = `${apiBase(b.base_url)}/v1/chat/completions`;
  const payload = stripRouterFields(body);
  payload.messages = effective;
  const headers = { "Content-Type": "application/json" };
  if (b.api_key) headers.Authorization = `Bearer ${b.api_key}`;

  const upstream = await fetchUpstream(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, process.env.KAIRO_UPSTREAM_TIMEOUT_MS);

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (payload.stream === true && isSse) {
    // 原样透传上游 OpenAI 帧，同时旁路攒正文（只为会话记账，不改写转发内容）
    sseHead(res);
    let collected = "";
    const scanner = createKairoFrameScanner();
    const feed = (txt) => {
      res.write(txt);
      for (const frame of scanner.push(txt)) {
        const line = String(frame).split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const o = JSON.parse(line.slice(5).trim());
          const d = o?.choices?.[0]?.delta?.content;
          if (typeof d === "string") collected += d;
        } catch { /* 非 JSON 帧（如 [DONE]）不参与记账 */ }
      }
    };
    await pipeSse(upstream, res, feed);
    res.end();
    return collected;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8" });
  res.end(text);
  if (!upstream.ok) return "";
  try {
    return String(JSON.parse(text)?.choices?.[0]?.message?.content ?? "");
  } catch {
    return "";
  }
}

export function createKairoRouter(opts = {}) {
  const cfg = opts.config ?? loadConfig();
  const store = opts.store ?? createTranscriptStore();
  const fetchWorkbench = opts.fetchWorkbench ?? runWorkbench;
  const fetchDirect = opts.fetchDirect ?? runDirect;

  return http.createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && (path === "/healthz" || path === "/")) {
        sendJson(res, 200, {
          ok: true,
          role: "kairo-router",
          workbench: process.env.KAIRO_WORKBENCH_URL || "http://127.0.0.1:3014",
          default_backend: cfg.default_backend ?? null,
          backends: Object.keys(cfg.backends ?? {}),
          conversations: store.size(),
        });
        return;
      }
      if (req.method !== "POST" || !(path === "/v1/chat/completions" || path === "/chat/completions")) {
        sendJson(res, 404, openaiError(`kairo-router 只暴露 POST /v1/chat/completions 与 GET /healthz（收到 ${req.method} ${path}）`));
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
        if (!body || typeof body !== "object") throw new Error("body 不是对象");
      } catch (e) {
        sendJson(res, e.statusCode ?? 400, openaiError(`请求体解析失败：${e.message}`, "invalid_request_error"));
        return;
      }

      // 分流判定：纯字段读取，不做任何 LLM 推理（用户口径原话）
      const flag = readEngineFlag(body);
      const conv = typeof body.conversation_id === "string" && body.conversation_id ? body.conversation_id : null;
      const merged = mergeMessages(conv ? store.get(conv) : [], sanitizeMessages(body.messages));

      const resolved = resolveBackend(body, cfg);
      if (!resolved.ok) {
        // 两条分支都要认大脑：名字不认识时透传会打错地址、转发会答非所问，一律 400 如实报错
        sendJson(res, 400, openaiError(resolved.error, "invalid_request_error"));
        return;
      }

      const args = { req, res, body, effective: merged.effective, resolved, cfg };
      const assistantText = flag.enabled
        ? await fetchWorkbench(args)
        : await fetchDirect(args);

      // 有会话号且拿到了正文才记账：拿不到正文（错误/空答）时保留上一版存档，不拿空回答覆历史
      if (conv && assistantText) store.set(conv, nextTranscript(merged.effective, assistantText), { backend: resolved.name });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 502, openaiError(`上游调用失败：${e.message}`));
      else {
        res.write(`: kairo-error ${String(e.message).replace(/\n/g, " ")}\n\n`);
        res.end();
      }
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.KAIRO_ROUTER_PORT) || 7900;
  createKairoRouter().listen(port, "127.0.0.1", () => {
    console.log(`[kairo-router] :${port} → 工作台 ${process.env.KAIRO_WORKBENCH_URL || "http://127.0.0.1:3014"}`);
  });
}
