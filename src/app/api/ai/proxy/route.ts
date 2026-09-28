import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";
import {
  injectSceneContext, type ChatRequestMessage, type ContextMsg, type StepInfo,
  type WzDecisionPayload,
} from "@/lib/desk/chat-core";
import { contractWarningOf, prepareSceneTurn, type SceneTurn } from "@/lib/desk/scene-dispatch";
import { TOOLS, findTool, type ToolCtx } from "@/lib/desk/chat-tools";
// R14 网关文本协议工具环：协议解析/结果拼装住纯核，本层只做接线与执行
import {
  createFetchStreamFilter, GATEWAY_LOOP_STEP_LABELS, GATEWAY_LOOP_STEP_REASON, gatewayFetchLoopBrief, isBlockedTool,
  MAX_FETCH_ROUNDS, parseFetchRequests, renderFetchResultsBlock, renderToolCatalog, splitRequests,
  type FetchResult, type FetchStreamFilter, type ParsedFetch,
} from "@/lib/desk/gateway-loop-core";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiDate } from "@/lib/desk/session";
import {
  createSseScanner, encodeStreamEvent, isEventStream, notStreamedWarning, parseUpstreamFrame,
  stepDetailOf, stepLabelFor,
  type StreamEvent, type StreamStep,
} from "@/lib/desk/chat-stream-core";
import { RUNS } from "@/lib/desk/run-bus";
import { debugFramesFromSteps } from "@/lib/desk/debug-core";
import { asChatMode, asHorizon, HORIZON_NOTES, MODE_NOTES } from "@/lib/desk/modes";
import { HOLD_USAGE_NOTE } from "@/lib/desk/hold-core";
import { holdNoteOf } from "@/lib/desk/hold-note";
import { FOLLOWUP_NOTE } from "@/lib/desk/followups-core";
// R20 说人话 / 说两面：与 /api/ai/chat、客户端 assistantSystemPrompt 共用同一份
import { PLAIN_AND_BALANCED_NOTE } from "@/lib/desk/plain-talk";
import { runWzIntentClassifier } from "@/lib/desk/intent-llm-fetch";
import {
  clampUpstreamTimeoutMs, foldHistoryForGateway, gatewayUnreachableText, isLanBaseUrl, shouldRetryNonStream,
  GATEWAY_BRAIN_BRIEF, type ServerLlmChannel,
} from "@/lib/llm/model-config-core";
import { getServerLlm } from "@/lib/llm/model-config";
// P55 输出边界护栏：这条路由此前一条护栏都没接（chat route 那份被源码钉钉住不动），
// 实测上游把注入的快讯行/周期口径/行情快照整段抄回正文、原样流给用户（2026-09-27 截图事故）。
// 判定链与 /api/ai/chat 的 createHeadGuard 同口径（head-guard-core 共享版）。
import { createHeadGuard } from "@/lib/desk/head-guard-core";
import { stripScaffoldEcho, SCAFFOLD_ONLY_NOTICE } from "@/lib/desk/answer-guard-core";
import { detectRepetition, degenWarning, type DegenVerdict } from "@/lib/desk/degen-core";

export const dynamic = "force-dynamic";
// 长报告流式生成可能跑 3-5 分钟（产业链研报 ~6000 字）；自托管 Node 不强制这个值，
// 但平台化部署（如 Vercel）会按它掐断，所以跟 streamTimeoutMs 的上限对齐到 600s。
export const maxDuration = 600;

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
  /**
   * 回答风格（决策/研判/深度/搜索）。与 /api/ai/chat 的 body.mode 同一份口径：
   * 只在带 scene 的对话轮生效（研究页/自检那类「一次一问」不吃风格，见 withScene 的注释）；
   * 外部输入先过 asChatMode 白名单，认不出的按默认口径答、不静默丢风格说明。
   */
  mode?: string;
  /**
   * P11：持仓周期（短/中/长线）。与 /api/ai/chat 的 body.horizon 同一份口径：
   * 只在带 scene 的对话轮生效、先过 asHorizon 白名单；没带/认不出＝未选，一个字都不注入。
   */
  horizon?: string;
  /**
   * 持仓条件（标的/成本价/仓位/建仓日期）。与 /api/ai/chat 的 body.hold 同一份口径：
   * 只在带 scene 的对话轮生效、先过 hold-core 的白名单清洗；没带/认不出＝一个字都不注入。
   */
  hold?: unknown;
  /**
   * P8-⑥：客户端生成的本轮留底号（外部输入，非空字符串才认）。带上＝这轮进 RunBus，
   * 断线/刷新后可按序号续传；且断连不再取消上游（grace=跑完或显式停止）——细则 §5-3 拍板项。
   */
  run?: string;
  /** P8-⑤：调试开关（只认布尔 true，"true"/1 一概忽略——与网关 enable_kairo_engine 同一严格度） */
  debug?: boolean;
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
  // P7-⑩：口径收进 model-config-core 一处（局域网=直连、可免 Key 的判定和模型通道共用同一条线），
  // 这里只留转发，避免路由与内核各写一份、哪天判歪一边都没人发现。
  return isLanBaseUrl(base);
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

async function callOpenAI(base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null, maxTokens = 2048, ms = 45000) {
  const url = apiBase(base) + "/v1/chat/completions";
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    },
    agent,
    ms,
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
  base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null, maxTokens = 2048,  emit: (ev: StreamEvent) => void, signal?: AbortSignal, timeoutMs = 120_000,
  /** P55：护栏判到重复死循环时把上游 body 掐掉，不再白烧到超时（q2 实测同一句刷 440 次） */
  shouldStop?: () => boolean,
): Promise<string> {
  const url = apiBase(base) + "/v1/chat/completions";
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true }),
    },
    agent,
    timeoutMs,
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
      // P55：退化判定命中就掐上游——护栏不再转发循环尾巴，上游也没必要继续烧
      if (shouldStop?.()) { try { body.destroy?.(); } catch { /* 已断开 */ } break; }
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
function sseResponse(run: (emit: (ev: StreamEvent) => void) => Promise<void>, runId?: string | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: StreamEvent) => {
        // P8-⑥：带 run 的轮次先进 RunBus（拿序号、同时推给重挂上来的订阅者），再写本连接；
        // 无 run 时走的就是原来那条 encode——帧与字节数和 A/B 轮完全一致。
        let line: string;
        try {
          const pub = runId ? RUNS.publish(runId, ev) : null;
          line = pub ? pub.line : encodeStreamEvent(ev);
        } catch {
          line = encodeStreamEvent(ev); // 留底层挂了就裸发，不谎称留了底
        }
        try {
          controller.enqueue(encoder.encode(line));
        } catch { /* 客户端已断开 */ }
      };
      try {
        await run(emit);
      } finally {
        // 封卷放在 close 之前：订阅者（续传连接）收到收尾信号才会结束，不会挂死
        if (runId) {
          try {
            RUNS.seal(runId);
          } catch { /* 留底挂了不拖累关流 */ }
        }
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

let maxTokens = 2048;

export async function POST(req: NextRequest) {
  let body: ProxyBody | null = null;
  // 给最外层 catch 用的两份信息：非流式分支的网关连不上也要指到「先启动网关」这个病根
  let serverChannelMode: "gateway" | "official" | null = null;
  let serverChannelBase = "";
  try {
    const clientProvider = req.headers.get("x-ai-provider") ?? "openai";
    let baseUrl = req.headers.get("x-ai-base-url") ?? "";
    let apiKey = req.headers.get("x-ai-api-key") ?? "";
    let model = req.headers.get("x-ai-model") ?? "";

    // P7-⑩ 任务4：服务端 .env 模型通道。浏览器没填凭据（或显式带 x-ai-server:1）时走这里，
    // 三元组全部来自 resolveServerLlm 的默认值口径 —— .env 什么都不配也能直接跑本地网关模式。
    // 优先级写死为「浏览器凭据优先」：设置页填过的人行为一字不变（验收标准 2），
    // .env 通道是浏览器未配置时的默认大脑，不是覆盖用户手填配置的暗道。
    let serverChannel: ServerLlmChannel | null = null;
    const wantsServer = !baseUrl.trim() || req.headers.get("x-ai-server") === "1";
    if (wantsServer) {
      const r = getServerLlm();
      if (!r.available) {
        return NextResponse.json({ error: `服务端模型通道不可用：${r.reason}` }, { status: 400 });
      }
      serverChannel = r.channel;
      serverChannelMode = r.channel.mode;
      serverChannelBase = r.channel.baseUrl;
      baseUrl = serverChannel.baseUrl;
      apiKey = serverChannel.apiKey;
      model = serverChannel.model;
    } else {
      if (!apiKey && clientProvider !== "ollama") {
        return NextResponse.json({ error: "缺少 x-ai-api-key（Ollama 可免）" }, { status: 400 });
      }
      if (!model) return NextResponse.json({ error: "缺少 x-ai-model" }, { status: 400 });
    }
    const provider = serverChannel ? "openai" : clientProvider;

    body = (await req.json().catch(() => null)) as ProxyBody | null;
    // 长报告（产业链研报等）需要更大的生成预算：由请求体传入，默认 2048
    maxTokens = Number((body as { max_tokens?: number } | null)?.max_tokens) > 0 ? Number((body as { max_tokens?: number }).max_tokens) : 2048;
    // 长报告（产业链研报等）生成时间可达 3-5 分钟，会超过流式路径原本写死的 120s 上游超时。
    // 只认请求体里的正整数，钳在 [10s, 600s]；没带/认不出就维持 120s —— 对话轮行为一字不变。
    const rawTimeoutMs = Number((body as { timeout_ms?: number } | null)?.timeout_ms);
    // 流式与非流式共用同一份钳位口径（见 model-config-core.clampUpstreamTimeoutMs）。
    // 非流式 callOpenAI 原来写死 45s、完全不读请求体的 timeout_ms：事件理解这类结构化长生成
    // 客户端传了 120s，却因为这里漏接而被 45s 掐断（谎称「连接上游超时」）。默认仍 45s
    // （不动其它非流式调用方的行为），只有显式带 timeout_ms 的（如事件理解）才拉长。
    const streamTimeoutMs = clampUpstreamTimeoutMs(rawTimeoutMs, 120_000);
    const nonStreamTimeoutMs = clampUpstreamTimeoutMs(rawTimeoutMs, 45_000);
    const messages = body?.messages ?? [];
    // P55：本轮用户原话（含注入的快照后缀——客户端把行情快照/快讯拼在最后一条 user 件里），
    // 交给护栏做「回显行」比对：上游把注入的快讯行/周期口径/行情快照抄回正文时按回显剥掉。
    const lastUserEcho = (() => {
      const u = [...messages].reverse().find((m) => m.role === "user");
      const base = u && typeof u.content === "string" && u.content.trim() ? [u.content] : [];
      // P55-B：模式/周期口径是服务端注入的（不在客户端消息里），同样进回显语料（与 /api/ai/chat 同口径）
      if (body?.scene) {
        const md = MODE_NOTES[asChatMode(body.mode)];
        const hz = asHorizon(body.horizon);
        if (md?.trim()) base.push(md);
        if (hz) base.push(HORIZON_NOTES[hz]);
      }
      return base;
    })();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages 为空" }, { status: 400 });
    }

    const agent = await resolveProxy(req, baseUrl);
    const via = agent ? "（已走本机代理）" : "（直连）";
    const wantStream = body?.stream === true || /text\/event-stream/i.test(req.headers.get("accept") ?? "");
    const openaiCompat = !["anthropic", "gemini"].includes(provider);

    // P8-⑤⑥ 的两个外部输入：run 只认非空字符串、debug 只认布尔 true（都不猜）。
    // 续传是流式独有能力，非流式 JSON 路径不碰 RunBus（细则 §2.6）；撞号/满员如实退回无 run 的普通轮。
    let runId: string | null = wantStream && typeof body?.run === "string" && body.run ? body.run : null;
    if (runId && !RUNS.start(runId).ok) runId = null;
    const debugOn = body?.debug === true;
    // P8-⑥：仅带 run 的轮次换 cancel 源（grace=跑到自然结束或显式停止，细则 §5-3 拍板项）；
    // 不带 run 的请求保持 req.signal.aborted 逐字不变——断连即 notRun 的旧语义原样。
    // R14：网关文本协议环的每轮之间也查同一把刀——客户端已断连就不该再代取一条数据。
    const isCancelled = () => (runId ? RUNS.cancelled(runId) : req.signal.aborted);

    /**
     * 判场景 + 按场景预取真实数据（emit 只在流式下给，非流式靠返回值带出去）。
     * 没带 scene 就是「一次一问的转发请求」（研究页、事件理解、Agent 循环、连通性自检都算），
     * 它们要的是一句原文回答，给它们注入交易场景提示词只会污染口径 —— 所以这里按调用方显式声明才做。
     */
    // R14：工具执行上下文整轮一份（自选清单口径与 /api/ai/chat 相同：服务端不读浏览器存档，只认请求体）。
    const toolCtx = { watchlist: Array.isArray(body?.watchlist) ? body.watchlist : [] } as ToolCtx;
    const prepare = async (emit?: (ev: StreamEvent) => void): Promise<SceneTurn | null> => {
      if (!body?.scene) return null;
      // 取数工具和 /api/ai/chat 是同一份注册表，量化引擎那套初始化也必须在这里做一次（幂等）
      quantBootstrap();
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return prepareSceneTurn({
        userContent: typeof lastUser?.content === "string" ? lastUser.content : "",
        ctx: toolCtx,
        focusSymbol: body.scene.focusSymbol ?? null,
        sessionSymbol: body.scene.sessionSymbol ?? null,
        prevScene: body.scene.prevScene ?? null,
        today: shanghaiDate(),
        // 回测工具在这条路上真的没有：预取环不带它，R14 文本环也把它拉进黑名单（gateway-loop-core）——
        // 所以必须显式按「未接入」说，否则提示词会让模型去调一个它根本调不动的工具。
        backtestReady: false,
        emit,
        // P8-⑥：仅带 run 的轮次换 cancel 源（grace=跑到自然结束或显式停止，细则 §5-3 拍板项）；
        // 不带 run 的请求保持 req.signal.aborted 逐字不变——断连即 notRun 的旧语义原样。
        isCancelled: () => (runId ? RUNS.cancelled(runId) : req.signal.aborted),
      });
    };
    // 官方口径注：Anthropic/Gemini 原生协议这一路仍是「预取唯一取数」（连 tools 字段都不认）；
    // OpenAI 兼容的网关对话轮自 R14 起多一条文本协议环（见下方 gatewayLoop），
    // 除此之外数据仍由系统取好、随提示词一起给模型。
    const modeNote = body?.scene ? MODE_NOTES[asChatMode(body.mode)] : "";
    // P11 持仓周期：与风格件同一消费路（只认带 scene 的对话轮）、同一张表（modes.ts）、同一道白名单门。
    // 没选就是一个字都不加——「未选」不能被解释成任何周期口径。
    const horizon = body?.scene ? asHorizon(body.horizon) : null;
    // P17-① 稳智对齐：LLM 兜底分类器 —— 规则引擎判 general 时才让 LLM 出来补决策信号。
    // 只对带 scene 的对话轮生效，与 styleNote 同口径；无 scene 时一个字都不注入（研究页/自检不吃）。
    // 分类失败（超时/解析失败/JSON 无效）静默降级，绝不让用户因为 LLM 挂了看不到常规回答。
    const wzDecisionBlock = await runWzIntentClassifier({
      enabled: !!body?.scene,
      horizon,
      lastUser: [...messages].reverse().find((m) => m.role === "user"),
      prevScene: body?.scene?.prevScene,
      model,
      baseUrl,
      apiKey,
      agent,
      signal: req.signal,
    });
    // P59 追问推荐：与 /api/ai/chat 同一条收尾纪律（同一常量，两端不各写一份）。
    // 口径跟 modeNote 完全一致：只认带 scene 的对话轮，研究页/自检那种一次一问的转发不掺。
    // 持仓那一句同口径进 styleNote：它和周期一样是「长期条件」，不是某一句的问题。
    const holdNote = body?.scene ? await holdNoteOf(body.hold) : null;
    // R20 说人话 / 说两面：与 modeNote 同一口径（只认带 scene 的对话轮，研究页/自检不掺），
    // 与 /api/ai/chat、客户端直连那份同一常量（@/lib/desk/plain-talk）。
    const styleNote = [
      modeNote,
      horizon ? HORIZON_NOTES[horizon] : "",
      holdNote?.line ?? "",
      holdNote ? HOLD_USAGE_NOTE : "",
      body?.scene ? PLAIN_AND_BALANCED_NOTE : "",
      body?.scene ? FOLLOWUP_NOTE : "",
    ].filter(Boolean).join("\n");
    // ---------- R14 网关文本协议工具环（开关口径与身份卡同门：gateway + 带 scene 的对话轮） ----------
    // 官方 API 模式在 /api/ai/chat 有真 function-call 环，不需要也不该再套一层文本环；
    // 一次一问的转发调用（研究页/自检）不吃协议卡，自然也没有请求块。
    const gatewayLoop = serverChannel?.mode === "gateway" && !!body?.scene && openaiCompat;
    // 协议卡的工具目录直接由注册表渲染（黑名单除外）——卡上清单和能执行的清单永远一张表
    const fetchCatalog = renderToolCatalog(TOOLS);
    // 每一轮「请求→执行→回料」的累加器：步骤号接在场景预取之后，两套步骤不能都从 1 开始
    interface LoopState { stepNo: number; steps: StepInfo[]; trace: { name: string; args: Record<string, unknown>; ms: number; status: "ok" | "error"; summary: string }[]; roundsUsed: number }
    const makeLoop = (turn: SceneTurn | null): LoopState => ({ stepNo: turn?.nextStep ?? 0, steps: [], trace: [], roundsUsed: 0 });
    /**
     * 执行一轮取数请求，返回要拼回对话的续答消息（assistant 前文 + user 结果块）。
     * 与工具调用环同一份 findTool 注册表执行——不开第二条数据管道；
     * 未知工具/黑名单工具不抛错，回「未开放」并如实进时间线（缺数据不是失败，两者在界面上必须分开）。
     */
    const runFetchRound = async (
      loop: LoopState, parsed: ParsedFetch, emitEv?: (ev: StreamEvent) => void,
    ): Promise<MsgIn[]> => {
      loop.roundsUsed++;
      const { executed, skipped } = splitRequests(parsed.requests);
      const results: FetchResult[] = [];
      for (const r of executed) {
        const step = ++loop.stepNo;
        const label = GATEWAY_LOOP_STEP_LABELS[r.tool] ?? stepLabelFor(r.tool, r.args);
        emitEv?.({ type: "step", data: { step, label, status: "running", tool: r.tool, source: "model", reason: GATEWAY_LOOP_STEP_REASON } });
        const started = Date.now();
        let out: unknown;
        let status: "ok" | "error" = "ok";
        try {
          const blocked = isBlockedTool(r.tool);
          const fn = blocked ? undefined : findTool(r.tool);
          if (blocked) out = { missing: "该工具未开放给网关文本协议（回测请走 AI 交易员页或量化门户）" };
          else if (!fn) out = { missing: `未知工具 ${r.tool}：不在文本协议开放清单内，未执行` };
          else out = await (fn.fn as (args: Record<string, unknown>, c: ToolCtx) => Promise<unknown>)(r.args, toolCtx);
        } catch (e) {
          out = { missing: `工具执行失败：${(e as Error).message}` };
          status = "error";
        }
        const ms = Date.now() - started;
        const text = JSON.stringify(out);
        loop.trace.push({ name: r.tool, args: r.args, ms, status, summary: text.length > 120 ? text.slice(0, 120) + "…" : text });
        const judged = stepDetailOf(out);
        const finalStatus: StepInfo["status"] = status === "error" ? "error" : judged.status;
        loop.steps.push({ step, label, tool: r.tool, ms, status: finalStatus, detail: judged.detail, source: "model", reason: GATEWAY_LOOP_STEP_REASON });
        emitEv?.({ type: "step", data: { step, label, tool: r.tool, ms, status: finalStatus as StreamStep["status"], detail: judged.detail, source: "model", reason: GATEWAY_LOOP_STEP_REASON } });
        results.push({ tool: r.tool, args: r.args, status: finalStatus === "running" ? "ok" : finalStatus, ms, text: text.slice(0, 6000), reason: r.reason });
      }
      for (const s of skipped) {
        results.push({ tool: s.tool, args: s.args, status: "refused", ms: null, text: `本轮请求数超过上限，未执行这条；确有必要请留到下一次机会或如实告知缺口。`, reason: s.reason });
      }
      const block = renderFetchResultsBlock(results, loop.roundsUsed, parsed.malformed);
      return [
        { role: "assistant", content: parsed.preText || "（本轮只发出了取数请求，未输出正文。）" },
        { role: "user", content: block },
      ];
    };
    // 折叠在注入之后（顺序不能反）：doubao2API 实测只取最后一条 user 消息（README 6.5），
    // 先折叠会把注入的 system 件丢在折叠范围外，模型就拿不到本轮场景数据了。
    // 折叠层把 system + 既往轮次 + 本轮问题拼成一条 user，理由与形状见 foldHistoryForGateway。
    // 回答风格：纯对话这一路的消费方就是这条 system 件（工具环那路在 /api/ai/chat 的 systemPrompt 里，
    // 两处查的是 modes.ts 同一份 MODE_NOTES，不会出现「chip 同名、两端口径不同」）。
    // 只对带 scene 的对话轮生效——研究页/事件理解/自检那些一次一问的调用要的是原口径，
    // 给它们塞交易风格句和给它们塞场景提示词是同一类污染（见 prepare 上方的注释）。
    const foldForSend = (raw: MsgIn[]): MsgIn[] =>
      serverChannel?.mode === "gateway" ? (foldHistoryForGateway(raw) as MsgIn[]) : raw;
    const withSceneRaw = (turn: SceneTurn | null): MsgIn[] => {
      const merged = injectSceneContext(messages, turn ? { prompt: turn.prompt, block: turn.block } : {}, (role, content) => ({ role, content }));
      // 风格件放整份消息的最前：场景提示词由 injectSceneContext 接在「开头 system 串」之后，两者顺序稳定；
      // 无 scene 时 styleNote 为空串，一个 system 件都不多插（p7 钉测：原消息一条不改）；
      // 带 scene 但没选周期时 styleNote 只有风格句——与 P10 之前的请求体逐字节一致。
      // R12 网关身份卡：排最前（先立身份再谈风格），且只在「网关模式 + 对话轮」出现——
      // 官方 API 模式有真工具环，对它说「你没有工具」就是谎话；一次一问的转发调用（研究页/自检）
      // 不吃场景提示词，也不该被交易纪律污染（与上面 styleNote 同口径）。
      const brief: MsgIn[] = serverChannel?.mode === "gateway" && body?.scene ? [{ role: "system", content: GATEWAY_BRAIN_BRIEF }] : [];
      // P17-①：稳智决策信号块跟在 styleNote 之后、身份卡之后——先立身份、再讲风格/周期、
      // 然后摆"参考口径"，最后是场景提示词与数据块。顺序稳定，模型能一眼看到参考结论。
      const wzNote: MsgIn[] = wzDecisionBlock.block.length ? [{ role: "system" as const, content: wzDecisionBlock.block.join("\n") }] : [];
      const out: MsgIn[] = [...brief, ...(styleNote ? [{ role: "system" as const, content: styleNote }] : []), ...wzNote, ...merged];
      // R14 协议卡紧跟身份卡：先立「你没有工具」的身份，再讲唯一例外怎么走——
      // 只在文本环开着的轮次附加，环没接线的轮次一个字都不多插（那张卡说了也不成立）。
      return gatewayLoop ? [out[0], { role: "system" as const, content: gatewayFetchLoopBrief(fetchCatalog) }, ...out.slice(1)] : out;
    };
    const withScene = (turn: SceneTurn | null): MsgIn[] => foldForSend(withSceneRaw(turn));

    // 流式：只有 OpenAI 兼容协议有逐字能力。其余服务商走整体返回，
    // 客户端会因为拿不到 event-stream 而如实登记「本机节奏」。
    if (wantStream && openaiCompat) {
      return sseResponse(async (rawEmit) => {
        // P55：所有出帧都过头部护栏（判定链与 /api/ai/chat 的 sseResponse 同口径）。
        // 护栏只拦 delta；step/stage/warning/error 原样放行，done.fullText 以本层累计为准。
        const guard = createHeadGuard(rawEmit, { echoes: lastUserEcho });
        const emit = guard.emit;
        try {
        let turn: SceneTurn | null = null;
        try {
          turn = await prepare(emit);
        } catch (e) {
          turn = null;
          emit({ type: "warning", data: { text: `场景自动调度未完成，本轮按「无自动取数」继续回答：${(e as Error).message}` } });
        }
        // P8-⑤：轮末把带上了 args/summary 的终态帧按同序号重发一遍。
        // applyEvent 按步骤号字段合并（B 轮前就有的语义），所以富化不会产生第二条步骤、不撞步骤号断言——
        // 这是「scene-dispatch / dispatch-core 零改动」的落点：它们一个字都不用认识 debug。
        // R14：富化范围并入文本环步骤（同一条拼接口径），预取/环两侧零改动。
        const loop = gatewayLoop ? makeLoop(turn) : null;
        const allSteps = (): StepInfo[] => [...(turn?.steps ?? []), ...(loop?.steps ?? [])];
        const allTrace = () => [...(turn?.trace ?? []), ...(loop?.trace ?? [])];
        const emitDebugSteps = () => {
          if (!debugOn || !allSteps().length) return;
          for (const f of debugFramesFromSteps(allSteps(), allTrace())) {
            if (f.args || f.summary) emit({ type: "step", data: { ...f, status: f.status as StreamStep["status"], ms: f.ms ?? null } });
          }
        };
        const baseRaw = withSceneRaw(turn);
        let emittedDelta = false;
        const emitCounted = (ev: StreamEvent) => {
          if (ev.type === "delta") emittedDelta = true;
          emit(ev);
        };
        const modelStart = Date.now();
        // done 的结论留底只给 debug=true 的请求发（细则 §1.3）；transport 如实记本轮走的传输
        const doneDebug = () => (debugOn ? { debug: { modelMs: Date.now() - modelStart, transport: "stream" as const } } : {});
        // 一轮模型调用：流式逐帧外发；文本环开着时过一道过滤器（协议块不上屏）。
        // 返回值是整轮原文（含块）——解析一律用原文，过滤器只管展示。
        const callRoundStream = async (raw: MsgIn[], filter: FetchStreamFilter | null): Promise<string> =>
          await callOpenAIStream(baseUrl, apiKey, model, foldForSend(raw), agent, maxTokens, (ev) => {
            if (ev.type === "delta" && filter) {
              const piece = filter.push(ev.data.content ?? "");
              if (piece) emitCounted({ type: "delta", data: { content: piece } });
            } else {
              emitCounted(ev);
            }
          }, runId ? undefined : req.signal, streamTimeoutMs,
          // P55：护栏判到重复死循环就掐上游（不再白烧到 60s 超时）
          () => guard.isDegenerate());
        /**
         * R14 流式多轮驱动：回答→（若发请求）执行→回料→续答，最多 MAX_FETCH_ROUNDS 轮。
         * 返回用户看到的全部正文（各轮请求块之前文字的拼接）；超上限的新请求不执行、如实 warning。
         */
        const runStreamTurn = async (): Promise<string> => {
          let raw = baseRaw;
          let outAll = "";
          for (;;) {
            const filter = loop ? createFetchStreamFilter() : null;
            const roundText = await callRoundStream(raw, filter);
            const tail = filter ? filter.flush() : "";
            if (tail) emitCounted({ type: "delta", data: { content: tail } });
            if (!loop) return roundText;
            const parsed = parseFetchRequests(roundText);
            outAll += parsed.preText;
            if (!parsed.markerFound) return outAll;
            if (loop.roundsUsed >= MAX_FETCH_ROUNDS) {
              emit({ type: "warning", data: { text: `补数轮次已达上限（${MAX_FETCH_ROUNDS} 轮），这条新请求未执行，按已取到的数据作答。` } });
              return outAll;
            }
            if (isCancelled()) return outAll;
            const cont = await runFetchRound(loop, parsed, emit);
            raw = [...raw, ...cont];
          }
        };
        try {
          // P8-⑥：带 run 的轮次不再把客户端断连接进上游 fetch（grace=跑完或停止键）；无 run 逐字不变
          const content = await runStreamTurn();
          if (!content) {
            emit({ type: "error", data: { message: `上游未返回内容${via}` } });
            return;
          }
          // P8-②：回答完成后拿结论契约核对引用的数字。对不上只补一条 warning，
          // 不改模型原文、不自动重答（风险点 4）——而且只有本轮真有契约才核（风险点 3）。
          const cw = turn ? contractWarningOf(turn, content) : null;
          if (cw) emit({ type: "warning", data: { text: cw } });
          emitDebugSteps();
          emit({ type: "done", data: { fullText: content, ...(turn ? { intent: turn.badge } : {}), ...(wzDecisionBlock.signal ? { wzDecision: wzDecisionBlock.signal } : {}), ...doneDebug() } });
        } catch (e) {
          const raw = (e as Error).message || "";
          // 任务书「网关不支持 SSE 自动切轮询，不直接报错」的落地形态：对同一上游补发一次
          // **非流式**请求（一次性取全量）。两条铁理由纯函数判定：吐过 delta 不重发（会看到
          // 半截答案被重答）、鉴权类错误不重发（只会多等一次失败）。降级也失败就落回原文报错。
          // R14 加一条：文本环已经执行过取数的轮次不整轮重来——降级补发只走一次、不跑环
          //（屏幕没字但工具已跑过的事实 filter 反映不出来，看 steps 才准）。
          if (shouldRetryNonStream(raw, emittedDelta || (loop?.steps.length ?? 0) > 0)) {
            try {
              const c2raw = await callOpenAI(baseUrl, apiKey, model, foldForSend(baseRaw), agent, maxTokens, nonStreamTimeoutMs);
              const c2Parsed = parseFetchRequests(String(c2raw ?? ""));
              const c2 = c2Parsed.preText;
              if (c2) {
                emit({ type: "warning", data: { text: "流式未走通，已自动降级为一次性非流式请求取回全文；本轮回答整体到达，不是上游逐字流。" } });
                // 降级这一发不走文本环：模型若又发了请求块，块被剥下、缺口如实说，不给第二轮
                if (c2Parsed.markerFound) {
                  emit({ type: "warning", data: { text: "降级为一次性请求后不再走补数：回答里若有按请求待补的维度，是那轮没取到，不是取错。" } });
                }
                // 降级路径同样要核契约：两条传输不能一个查一个不查
                const cw2 = turn ? contractWarningOf(turn, c2) : null;
                if (cw2) emit({ type: "warning", data: { text: cw2 } });
                emit({ type: "delta", data: { content: c2 } });
                emitDebugSteps();
                emit({ type: "done", data: { fullText: c2, ...(turn ? { intent: turn.badge } : {}), ...(wzDecisionBlock.signal ? { wzDecision: wzDecisionBlock.signal } : {}), ...doneDebug() } });
                return;
              }
            } catch { /* 保持下面按原始流式错误说话 */ }
          }
          emit({
            type: "error",
            data: {
              message: serverChannel?.mode === "gateway" && /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(raw)
                ? gatewayUnreachableText(baseUrl)
                : proxyErrorMessage(e),
            },
          });
        }
        } finally {
          // 收尾兜底：run 结束仍没决定过就补一次（整篇都是脚手架时换兜底话术）
          try { guard.flush(); } catch { /* 护栏自身不许把关流拖挂 */ }
        }
      }, runId);
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
    const loopSteps: StepInfo[] = [];
    let cappedWarn = "";
    if (provider === "anthropic") {
      content = await callAnthropic(baseUrl, apiKey, model, upstreamMessages, agent);
    } else if (provider === "gemini") {
      content = await callGemini(baseUrl, apiKey, model, upstreamMessages, agent);
    } else if (gatewayLoop) {
      // R14 非流式 JSON 路：同一个文本环（展示无逐字节奏，取数判定与流式一字不差）
      const loop = makeLoop(turn);
      let raw = withSceneRaw(turn);
      let outAll = "";
      for (;;) {
        const roundText = String(await callOpenAI(baseUrl, apiKey, model, foldForSend(raw), agent, maxTokens, nonStreamTimeoutMs) ?? "");
        const parsed = parseFetchRequests(roundText);
        outAll += parsed.preText;
        if (!parsed.markerFound) break;
        if (loop.roundsUsed >= MAX_FETCH_ROUNDS) {
          cappedWarn = `补数轮次已达上限（${MAX_FETCH_ROUNDS} 轮），最后一条新请求未执行，回答按已取到的数据作答。`;
          break;
        }
        const cont = await runFetchRound(loop, parsed);
        loopSteps.push(...loop.steps.slice(loopSteps.length));
        raw = [...raw, ...cont];
      }
      loopSteps.push(...loop.steps.slice(loopSteps.length));
      content = outAll;
    } else {
      // openai / deepseek / moonshot / openrouter / ollama / custom 全部 OpenAI 兼容
      content = await callOpenAI(baseUrl, apiKey, model, upstreamMessages, agent, maxTokens, nonStreamTimeoutMs);
    }

    if (!content) return NextResponse.json({ error: `上游未返回内容${via}` }, { status: 502 });
    // P55 输出边界护栏（非流式同口径）：剥回显/脚手架开头 + 判重复死循环，与 /api/ai/chat 的 JSON 路一条判据。
    // 命中即留痕（并进 warning），不静默丢内容；整篇都是脚手架时换兜底话术。
    // 就地重写 content（p15/p8 钉住「契约核对三处都吃 content」的形状，口径不变）。
    const pg = stripScaffoldEcho(content, { echoes: lastUserEcho });
    content = pg.text || (pg.stripped ? SCAFFOLD_ONLY_NOTICE : content);
    const pdg = detectRepetition(content);
    if (pdg.degenerate) content = pdg.kept || "模型这一轮陷进了重复输出（没有产出可用的正文），已截断；请重试一次。";
    const guardWarn = [
      pg.stripped ? "已过滤模型复述的内部信号字段、自述与思维链，正文从结论开始。" : "",
      pdg.degenerate ? degenWarning(pdg) : "",
    ].filter(Boolean).join("；");
    const steps: StepInfo[] = [...(turn?.steps ?? []), ...loopSteps];
    // P8-②：非流式同样核一遍契约引用；只并进 warning 字段，content 一个字符都不动（风险点 4）
    const contractWarn = turn ? contractWarningOf(turn, content) : null;
    const warn = [sceneFailure ? `本轮未做场景自动取数：${sceneFailure}` : "", cappedWarn, guardWarn, contractWarn ?? ""].filter(Boolean).join("；");
    return NextResponse.json({
      content,
      // 非流式没有 step 事件可走，徽章与步骤只能随 JSON 一起回（客户端把它们并成同一种时间线）
      ...(turn ? { intent: turn.badge } : {}),
      ...(wzDecisionBlock.signal ? { wzDecision: wzDecisionBlock.signal } : {}),
      ...(steps.length ? { steps } : {}),
      ...(warn ? { warning: warn } : {}),
    });
  } catch (e) {
    const raw = (e as Error).message || "";
    const gwDown = serverChannelMode === "gateway" && /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(raw);
    return NextResponse.json({ error: gwDown ? gatewayUnreachableText(serverChannelBase) : proxyErrorMessage(e) }, { status: 502 });
  }
}

/** 错误文案：原来只有一处用得上，抽出来让流式分支说同一套话 */
function proxyErrorMessage(e: unknown): string {
  const raw = (e as Error).message || "代理请求失败";
  if (/timeout|abort/i.test(raw)) return "连接上游超时（境外网络可能需要中转或代理）";
  // 403 不等于「地域限制」：限额/配额/权限不足也会回 403。原来一句话全推给「代理没绕过地域限制」，
  // 把用户往错误方向带（真病根常是限流或 Key/模型名不匹配）。这里按上游原文分流。
  if (/\b403\b/.test(raw)) {
    if (/rate|limit|quota|frequency|too many|频率|限流|额度|配额/i.test(raw)) {
      return "上游拒绝 403（请求被限流或额度/配额不足，请稍后重试或更换模型通道）";
    }
    return "上游拒绝访问 403（可能是地域限制或上游拒收；若已走代理仍失败，请核对 Key 与模型名是否匹配）";
  }
  if (/\b401\b/.test(raw)) return "鉴权失败 401（请检查 API Key 与模型名是否匹配）";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR/i.test(raw)) {
    return "无法连接上游（本机代理未开或网络不通，可在设置里指定代理地址）";
  }
  return raw;
}

// ---------- P19-② 稳智 LLM 意图分类器（共享模块） ----------
// 分类器的网络调用逻辑抽到 @/lib/desk/intent-llm-fetch：
// 让 /api/ai/proxy 和 /api/ai/chat 走同一份 prompt、同一份解析、同一份超时纪律——
// 三个入口（助手页 / 小窗 / AI 交易员页）看到的决策卡必须来自同一次 LLM 判定，
// 否则用户在不同页问同一句会得到不同的决策信号。
//
// 调用规则（与 P17-① 时代一致）：
//   - 只对带 scene 的对话轮生效（研究页/事件理解/自检那类「一次一问」不吃 LLM 分类）；
//   - 6 秒超时静默降级：分类器挂了就返回空，主回答链路照旧，不让用户等第二次超时；
//   - 解析失败静默降级：LLM 输出的 JSON 不合契约就当没判过，绝不让用户看到坏 JSON 泄漏进提示词；
//   - LLM 请求体不带 history——分类器不需要上下文，只要本轮 user 那一句话就够，省 token。
