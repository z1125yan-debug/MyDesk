import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";
import {
  injectSceneContext, type ChatRequestMessage, type ContextMsg, type StepInfo,
} from "@/lib/desk/chat-core";
import { prepareSceneTurn, type SceneTurn } from "@/lib/desk/scene-dispatch";
import type { ToolCtx } from "@/lib/desk/chat-tools";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiDate } from "@/lib/desk/session";
import {
  createSseScanner, encodeStreamEvent, isEventStream, notStreamedWarning, parseUpstreamFrame,
  type StreamEvent,
} from "@/lib/desk/chat-stream-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 通用境外 AI 代理：支持 OpenAI 兼容 / Anthropic 原生 / Gemini 原生
// Key 仅通过请求头传递，不落盘、不打日志。
// 出网自动经本机代理（解决 CloudFront 等对中国 IP 的地域封锁）：
//   优先级 = 请求头 x-ai-proxy（设置页可填） > 环境变量（启动.bat 已设 HTTPS_PROXY）
//          > Windows 系统代理（注册表自动探测，缓存 5 分钟）
// 本机/内网上游（Ollama、局域网中转）始终直连。

// P7-⑤①：OpenAI 兼容协议支持 SSE 逐字返回（body.stream=true 或 Accept: text/event-stream）。
// Anthropic、Gemini 原生协议这一版仍整体返回：路由照实返回 JSON，客户端据此发 warning 并改用本机节奏展示——
// 「看起来在打字」和「上游在流式」是两件事，不能混为一谈。

// 入参契约与 /api/ai/chat 同一份（见 chat-core.ChatRequestMessage）：两个端点收到的是同一种消息件，
// 校验、裁窗口径就不会各说各话。
type MsgIn = ChatRequestMessage;

/** 只有对话入口会带这个字段：其余 /api/ai/proxy 的调用方是「一次一问的取数请求」，不该被塞交易场景提示词 */
interface SceneReq {
  focusSymbol?: string | null;
  sessionSymbol?: string | null;
  prevScene?: string | null;
}

interface ProxyBody {
  messages?: MsgIn[];
  stream?: boolean;
  /** P7-⑥④：本机自选清单（和 /api/ai/chat 同一份口径：服务端不读浏览器存档） */
  watchlist?: { symbol: string; name?: string | null }[];
  /** P7-⑥⑤：带上＝这一轮是对话，要做意图识别 + 场景自动调度；不带＝原样转发 */
  scene?: SceneReq;
}

// ---------- 代理解析 ----------

const agentCache = new Map<string, ProxyAgent>();
function proxyAgent(url: string): ProxyAgent {
  let a = agentCache.get(url);
  if (!a) {
    a = new ProxyAgent(url);
    agentCache.set(url, a);
  }
  return a;
}

let sysProxyCache: { at: number; url: string | null } | null = null;

async function windowsSystemProxy(): Promise<string | null> {
  if (sysProxyCache && Date.now() - sysProxyCache.at < 300_000) return sysProxyCache.url;
  sysProxyCache = { at: Date.now(), url: null };
  try {
    const { exec } = await import("node:child_process");
    const run = (cmd: string) =>
      new Promise<string>((resolve) => {
        exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
      });
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const [enOut, svOut] = await Promise.all([
      run(`reg query "${key}" /v ProxyEnable`),
      run(`reg query "${key}" /v ProxyServer`),
    ]);
    if (!/0x1\b/.test(enOut)) return null;
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(svOut);
    if (!m) return null;
    let v = m[1].trim();
    if (v.includes(";")) {
      // http=…;https=… 分协议写法，优先 https 条目
      const pick = /(?:^|;)https?=([^;]+)/.exec(v);
      v = pick ? pick[1] : v.split(";")[0].split("=")[1] ?? "";
    }
    if (!v || !/[\w.]+:\d+/.test(v)) return null;
    if (!/^https?:\/\//.test(v)) v = `http://${v}`;
    sysProxyCache.url = v;
  } catch {
    // 非 Windows 或读取失败：保持直连
  }
  return sysProxyCache.url;
}

function isLanUrl(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return (
      h === "localhost" || h === "::1" ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local")
    );
  } catch {
    return false;
  }
}

async function resolveProxy(req: NextRequest, baseUrl: string): Promise<ProxyAgent | null> {
  if (isLanUrl(baseUrl)) return null;
  const manual = (req.headers.get("x-ai-proxy") ?? "").trim();
  let url: string | null;
  if (manual) {
    if (/^(direct|off|none)$/i.test(manual)) url = null;
    else if (/^system$/i.test(manual)) url = await windowsSystemProxy();
    else url = manual;
  } else {
    url =
      process.env.AI_PROXY_URL ||
      process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.HTTP_PROXY || process.env.http_proxy ||
      (await windowsSystemProxy());
  }
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return proxyAgent(url);
}

// ---------- 上游调用 ----------

function upstream(url: string, init: UndiciInit, agent: ProxyAgent | null, ms = 45000) {
  return undiciFetch(url, { ...init, dispatcher: agent ?? undefined, signal: AbortSignal.timeout(ms) });
}

 
async function jsonOf(res: { json(): Promise<unknown> }): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// 兼容 Base URL 填不填 /v1 的两种写法：https://api.xxx.com 与 https://api.xxx.com/v1 等价
function apiBase(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// 各家协议对「system 发言」的入口不一样：P7-⑤ 的上下文压缩摘要要走 system 角色，
// 所以这里统一把 system 抽出来按各家口径传，而不是混进对话数组让上游自己报错。
function splitSystem(messages: MsgIn[]): { system: string; turns: MsgIn[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).filter(Boolean).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  return { system, turns };
}

async function callOpenAI(base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null) {
  const url = apiBase(base) + "/v1/chat/completions";
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 2048 }),
    },
    agent,
  );
  const json = await jsonOf(res);
  if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
  return json?.choices?.[0]?.message?.content ?? "";
}

/**
 * OpenAI 兼容协议的流式版：逐帧把增量交给 emit，同时把全文攒下来返回。
 * 上游不认 stream 参数（返回 application/json）时：结果是真的，但节奏是本机的 —— 必须发 warning，
 * 让界面写明「本机节奏展示」，不能把一次拿全画成逐字流。
 */
async function callOpenAIStream(
  base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null,
  emit: (ev: StreamEvent) => void, signal?: AbortSignal,
): Promise<string> {
  const url = apiBase(base) + "/v1/chat/completions";
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 2048, stream: true }),
    },
    agent,
    120_000,
  );
  const ct = res.headers.get("content-type");
  if (!isEventStream(ct)) {
    const json = await jsonOf(res);
    if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
    const content = String(json?.choices?.[0]?.message?.content ?? "");
    emit({ type: "warning", data: { text: notStreamedWarning(ct) } });
    if (content) emit({ type: "delta", data: { content } });
    return content;
  }
  let full = "";
  let sawDone = false;
  const scanner = createSseScanner();
  const decoder = new TextDecoder();
   
  const body: any = res.body;
  if (body) {
    for await (const chunk of body) {
      if (signal?.aborted) { try { body.destroy?.(); } catch { /* 已断开 */ } break; }
      for (const f of scanner.push(decoder.decode(chunk as Uint8Array, { stream: true }))) {
         
        const errText = frameError(f.data);
        if (errText) throw new Error(errText);
        const d = parseUpstreamFrame(f);
        if (d.text) { full += d.text; emit({ type: "delta", data: { content: d.text } }); }
        if (d.done) sawDone = true;
      }
      if (sawDone) break;
    }
  }
  for (const f of scanner.flush()) {
    const d = parseUpstreamFrame(f);
    if (d.text) { full += d.text; emit({ type: "delta", data: { content: d.text } }); }
  }
  if (!sawDone && !signal?.aborted) {
    emit({ type: "warning", data: { text: "上游流未正常收尾（没有 [DONE]），以上内容到此处为止，未补全。" } });
  }
  return full;
}

/** 上游在 SSE 里回错误帧时（鉴权失败常见这种），得把话带出去而不是静默少一段 */
function frameError(rawData: string): string | null {
  const s = rawData.trim();
  if (!s || s === "[DONE]") return null;
  try {
     
    const o = JSON.parse(s) as any;
    const msg = o?.error?.message ?? o?.message ?? o?.error;
    return typeof msg === "string" && msg ? msg : null;
  } catch {
    return null;
  }
}

async function callAnthropic(base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null) {
  const url = apiBase(base) + "/v1/messages";
  const { system, turns } = splitSystem(messages);
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 2048, messages: turns, ...(system ? { system } : {}) }),
    },
    agent,
  );
  const json = await jsonOf(res);
  if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
  const parts = json?.content ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

async function callGemini(base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null) {
  const url =
    `${apiBase(base)}/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(key)}`;
  const { system, turns } = splitSystem(messages);
  const contents = turns.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) }),
    },
    agent,
  );
  const json = await jsonOf(res);
  if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

/** 与 /api/ai/chat 同一种 SSE 骨架：ReadableStream 逐帧 flush，客户端按五类事件解析 */
function sseResponse(run: (emit: (ev: StreamEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeStreamEvent(ev)));
        } catch { /* 客户端已断开 */ }
      };
      try {
        await run(emit);
      } finally {
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: NextRequest) {
  let body: ProxyBody | null = null;
  try {
    const provider = req.headers.get("x-ai-provider") ?? "openai";
    const baseUrl = req.headers.get("x-ai-base-url") ?? "";
    const apiKey = req.headers.get("x-ai-api-key") ?? "";
    const model = req.headers.get("x-ai-model") ?? "";

    if (!baseUrl) return NextResponse.json({ error: "缺少 x-ai-base-url" }, { status: 400 });
    if (!apiKey && provider !== "ollama") {
      return NextResponse.json({ error: "缺少 x-ai-api-key（Ollama 可免）" }, { status: 400 });
    }
    if (!model) return NextResponse.json({ error: "缺少 x-ai-model" }, { status: 400 });

    body = (await req.json().catch(() => null)) as ProxyBody | null;
    const messages = body?.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages 为空" }, { status: 400 });
    }

    const agent = await resolveProxy(req, baseUrl);
    const via = agent ? "（已走本机代理）" : "（直连）";
    const wantStream = body?.stream === true || /text\/event-stream/i.test(req.headers.get("accept") ?? "");
    const openaiCompat = !["anthropic", "gemini"].includes(provider);

    /**
     * 判场景 + 按场景预取真实数据（emit 只在流式下给，非流式靠返回值带出去）。
     * 没带 scene 就是「一次一问的转发请求」（研究页、事件理解、Agent 循环、连通性自检都算），
     * 它们要的是一句原文回答，给它们注入交易场景提示词只会污染口径 —— 所以这里按调用方显式声明才做。
     */
    const prepare = async (emit?: (ev: StreamEvent) => void): Promise<SceneTurn | null> => {
      if (!body?.scene) return null;
      // 取数工具和 /api/ai/chat 是同一份注册表，量化引擎那套初始化也必须在这里做一次（幂等）
      quantBootstrap();
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return prepareSceneTurn({
        userContent: typeof lastUser?.content === "string" ? lastUser.content : "",
        ctx: { watchlist: Array.isArray(body.watchlist) ? body.watchlist : [] } as ToolCtx,
        focusSymbol: body.scene.focusSymbol ?? null,
        sessionSymbol: body.scene.sessionSymbol ?? null,
        prevScene: body.scene.prevScene ?? null,
        today: shanghaiDate(),
        // 回测工具在这条路上真的没有：这一路连工具调用环都不走（数据全靠系统预取），
        // 所以必须显式按「未接入」说，否则提示词会让模型去调一个它根本调不动的工具。
        backtestReady: false,
        emit,
        isCancelled: () => req.signal.aborted,
      });
    };
    // 这一路没有工具调用环（Anthropic/Gemini 原生协议更是连 tools 字段都不认），
    // 所以预取就是本轮唯一的取数途径：数据由系统取好、随提示词一起给模型，模型不再自己调接口。
    const withScene = (turn: SceneTurn | null): MsgIn[] =>
      injectSceneContext(messages, turn ? { prompt: turn.prompt, block: turn.block } : {}, (role, content) => ({ role, content }));

    // 流式：只有 OpenAI 兼容协议有逐字能力。其余服务商走整体返回，
    // 客户端会因为拿不到 event-stream 而如实登记「本机节奏」。
    if (wantStream && openaiCompat) {
      return sseResponse(async (emit) => {
        let turn: SceneTurn | null = null;
        try {
          turn = await prepare(emit);
        } catch (e) {
          turn = null;
          emit({ type: "warning", data: { text: `场景自动调度未完成，本轮按「无自动取数」继续回答：${(e as Error).message}` } });
        }
        try {
          const content = await callOpenAIStream(baseUrl, apiKey, model, withScene(turn), agent, emit, req.signal);
          if (!content) {
            emit({ type: "error", data: { message: `上游未返回内容${via}` } });
            return;
          }
          emit({ type: "done", data: { fullText: content, ...(turn ? { intent: turn.badge } : {}) } });
        } catch (e) {
          emit({ type: "error", data: { message: proxyErrorMessage(e) } });
        }
      });
    }

    let turn: SceneTurn | null = null;
    let sceneFailure: string | null = null;
    try {
      turn = await prepare();
    } catch (e) {
      turn = null;
      sceneFailure = (e as Error).message || "场景自动调度失败";
    }
    const upstreamMessages = withScene(turn);

    let content = "";
    if (provider === "anthropic") {
      content = await callAnthropic(baseUrl, apiKey, model, upstreamMessages, agent);
    } else if (provider === "gemini") {
      content = await callGemini(baseUrl, apiKey, model, upstreamMessages, agent);
    } else {
      // openai / deepseek / moonshot / openrouter / ollama / custom 全部 OpenAI 兼容
      content = await callOpenAI(baseUrl, apiKey, model, upstreamMessages, agent);
    }

    if (!content) return NextResponse.json({ error: `上游未返回内容${via}` }, { status: 502 });
    const steps: StepInfo[] = turn?.steps ?? [];
    return NextResponse.json({
      content,
      // 非流式没有 step 事件可走，徽章与步骤只能随 JSON 一起回（客户端把它们并成同一种时间线）
      ...(turn ? { intent: turn.badge } : {}),
      ...(steps.length ? { steps } : {}),
      ...(sceneFailure ? { warning: `本轮未做场景自动取数：${sceneFailure}` } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: proxyErrorMessage(e) }, { status: 502 });
  }
}

/** 错误文案：原来只有一处用得上，抽出来让流式分支说同一套话 */
function proxyErrorMessage(e: unknown): string {
  const raw = (e as Error).message || "代理请求失败";
  if (/timeout|abort/i.test(raw)) return "连接上游超时（境外网络可能需要中转或代理）";
  if (/\b403\b/.test(raw)) return "上游拒绝访问 403（地域限制未绕过，请检查代理是否可用）";
  if (/\b401\b/.test(raw)) return "鉴权失败 401（请检查 API Key 与模型名是否匹配）";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR/i.test(raw)) {
    return "无法连接上游（本机代理未开或网络不通，可在设置里指定代理地址）";
  }
  return raw;
}
