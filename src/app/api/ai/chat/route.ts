// AI 交易员对话后端（需求文档 六/二十五/二十六/二十七 + P7-⑤ §2.3 流式）
// 流程：用户问题 → LLM 生成 Tool Plan → 并行执行工具（真实数据）→ 结果回填 → LLM 生成回答。
// 硬规则：
//  - AI 不得编造数据：所有市场数据一律由工具返回的真实接口数据提供；
//  - 数据缺失 → 工具返回 {missing:...}，提示词要求显式写「暂无数据」，禁止推测；
//  - 输出必须区分【事实】/【模型推断】/【风险】；不给买卖建议；
//  - 证据链：每次工具调用记录名称/参数/耗时/状态，随响应返回前端展示。
// 仅支持 OpenAI 兼容接口（tools 能力）；Anthropic/Gemini 原生协议请用「智能助手」页。
//
// P7-⑤① 加了 SSE 传输：body.stream=true（或 Accept: text/event-stream）时逐帧发
// step / delta / warning / done / error 五类事件，否则维持原来的 {content, trace, mode} JSON。
// 两种传输跑的是同一份 runToolLoop —— 事件只是「什么时候告诉前端」，不改变任何取数与判定，
// 所以不会出现「流式的答案和非流式的答案口径不同」（模型在工具调用前的过渡语除外，见下面的注释）。
import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiDate } from "@/lib/desk/session";
import { TOOLS, FACTOR_KEYS, findTool, type ToolCtx } from "@/lib/desk/chat-tools";
import { backtestClaimWarning } from "@/lib/desk/backtest-core";
import { contractWarningOf, prepareSceneTurn, type SceneTurn } from "@/lib/desk/scene-dispatch";
import {
  createSseScanner, createToolCallAssembler, encodeStreamEvent, isEventStream, notStreamedWarning,
  parseUpstreamFrame, stepDetailOf, stepLabelFor, supportsToolCalling, type StreamEvent, type StreamStep,
} from "@/lib/desk/chat-stream-core";
import { RUNS } from "@/lib/desk/run-bus";
import { debugFramesFromSteps } from "@/lib/desk/debug-core";
import { injectSceneContext, trimDialog, clampTurns, type ChatRequestMessage, type ContextMsg, type StepInfo } from "@/lib/desk/chat-core";
import { asChatMode, MODE_NOTES, type ChatMode } from "@/lib/desk/modes";
import { getServerLlm } from "@/lib/llm/model-config";
import { renderAnalysisFrames } from "@/lib/llm/analysis-frames";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ---------- 代理（与 /api/ai/proxy 同规则，简化版） ----------

let sysProxyCache: { at: number; url: string | null } | null = null;
async function windowsSystemProxy(): Promise<string | null> {
  if (sysProxyCache && Date.now() - sysProxyCache.at < 300_000) return sysProxyCache.url;
  sysProxyCache = { at: Date.now(), url: null };
  try {
    const { exec } = await import("node:child_process");
    const run = (cmd: string) => new Promise<string>((resolve) => exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout))));
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const [enOut, svOut] = await Promise.all([run(`reg query "${key}" /v ProxyEnable`), run(`reg query "${key}" /v ProxyServer`)]);
    if (!/0x1\b/.test(enOut)) return null;
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(svOut);
    if (!m) return null;
    let v = m[1].trim();
    if (v.includes(";")) { const pick = /(?:^|;)https?=([^;]+)/.exec(v); v = pick ? pick[1] : v.split(";")[0].split("=")[1] ?? ""; }
    if (!v || !/[\w.]+:\d+/.test(v)) return null;
    if (!/^https?:\/\//.test(v)) v = `http://${v}`;
    sysProxyCache.url = v;
  } catch { /* 保持直连 */ }
  return sysProxyCache.url;
}

function isLanUrl(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
}

async function resolveProxy(req: NextRequest, baseUrl: string): Promise<ProxyAgent | null> {
  if (isLanUrl(baseUrl)) return null;
  let url: string | null = (req.headers.get("x-ai-proxy") ?? "").trim() || null;
  if (!url) url = process.env.AI_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || (await windowsSystemProxy());
  if (!url || /^(direct|off|none)$/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return new ProxyAgent(url);
}

// ---------- 工具实现 ----------

// P7-⑥①：十个取数工具连同 TOOLS / FACTOR_KEYS 一起搬到 @/lib/desk/chat-tools（服务层）。
// 搬动而不是复制：自动调度（scene-dispatch）与工具调用环必须共用同一份实现，
// 否则同一个「今天大盘情绪」在两条链路上可能算出两个数。本层数据纪律也集中在那一处写。

function systemPrompt(mode: ChatMode, focusSymbol?: string): string {
  // 服务端日期只走 shanghaiDate()：new Date() 直接格式化在跨时区机器上会把今天算错一天
  const today = shanghaiDate();
  // 风格句的正文在 modes.ts 的 MODE_NOTES 一处定义：纯对话端点（/api/ai/proxy）现在也消费
  // mode，两条链路查同一张表，不会出现「chip 同名、两端口径不同」的漂移。
  return [
    `你是 MyDesk 的 AI 交易员分析引擎。今天是 ${today}。${MODE_NOTES[mode]}`,
    focusSymbol ? `用户当前关注标的：${focusSymbol}。` : "",
    "",
    "【数据纪律（最高优先级）】",
    "1. 所有市场数据必须通过工具获取真实数据，绝不编造数字。",
    "2. 工具返回 missing 或数据为 null 时，必须写「XX：暂无数据」，禁止根据涨跌幅推测「主力流入」等无数据结论。",
    "3. 相关个股问题并行调用：stock_snapshot + stock_depth + stock_trades + stock_kline_summary + stock_fund_flow。",
    "4. 选股类问题用 factor_screener（field 只能取：" + FACTOR_KEYS + "）。",
    // P7-⑧④：回测接进来了，但它的口径和选股不一样——因子必须来自场景提示词里那份白名单，
    // 表达式由引擎从库里带，模型不许现写一个；没跑成都算「没有结果」，不算「结果不好」。
    "5. 回测类问题用 run_backtest：factors 只能取「可回测因子白名单」里的 factorKey（不得自写表达式、不得凭印象编因子名）；" +
      "该工具返回 missing 时，说明这一轮没有回测结果，直接转述它给的原因，不得给出任何收益数字。",
    "",
    "【输出格式（固定）】",
    "开口第一句就给**加粗结论**（🎯 结论：你的判断或现在该怎么做），像一位懂行的朋友当面讲，不要写「根据提供的数据/结合相关信息/以下是具体分析」这类机器人开场白；多用「我建议/更合理的节奏是/现在不宜」这样的人话。",
    "结论之后用带 emoji 的小节标题分节，每节之间空一行：📊 盘面与环境、✅ 结论与标的（或关键位/操作节奏）、⚠️ 风险与失效点。",
    "论据只引用工具返回的数据，并带上数字和来源（数据源与时间）；关键事实后面用（来源：xx）标注；工具缺数据的块直接写「暂无数据」，不要推测。",
    "选股类：先用 factor_screener 跑出候选池，再从池里择优给出 2~3 只，每只讲清为什么选、观察位/买点在哪；池里没有合适的就直说「按当前条件没筛出符合的」，不要凭空编股票代码。",
    "可以给操作节奏和关键位参考，但不说死「必涨必跌」、不给目标价；所有概率必须带样本数。",
    "简体中文，简洁 markdown，表格最多 1 个，别堆太多要点，让页面干净好读。",
    // P7-⑩ 任务4：50 个深度研究框架随系统 Prompt 全局下发（文案与客户端那份同源于
    // analysis-frames.ts，一处改动两条链路同步，不存在「首页有框架、交易员页没有」的漂移）。
    "",
    renderAnalysisFrames(),
  ].filter(Boolean).join("\n");
}

interface ToolCallMsg { id: string; type: "function"; function: { name: string; arguments: string } }

interface ChatTraceItem { name: string; args: Record<string, unknown>; ms: number; status: "ok" | "error"; summary: string }

interface ChatBody {
  messages?: ChatRequestMessage[];
  mode?: string;
  focusSymbol?: string;
  /** 本会话上一轮用到的标的（客户端从上一条助手消息的场景徽章里取，不新增会话字段） */
  sessionSymbol?: string | null;
  /** 上一轮判到的场景；服务端按外部输入校验（不认就当没判过） */
  prevScene?: string | null;
  /** 开发文档 §2.2 的多轮上下文口径：客户端内核按轮裁窗 + 压缩旧对话；路由只兜底，且从不静默丢 system 件 */
  contextWindow?: number;
  /** P7-⑤①：走 SSE 传输 */
  stream?: boolean;
  /**
   * P7-⑥④：用户本机自选清单（浏览器存档随请求带上）。服务端不读浏览器存档，也不查任何账号库；
   * 清单只当「要取哪些代码」的用，行情一律本层现取。
   */
  watchlist?: { symbol: string; name?: string | null }[];
  /** P8-⑥：客户端生成的本轮留底号（只认非空字符串）。带上＝这轮进 RunBus、断连不再即刻取消（grace），可续传 */
  run?: string;
  /** P8-⑤：调试开关（只认布尔 true）：step 帧轮末富化 args/summary、done 帧带结论留底 */
  debug?: boolean;
}

/**
 * 校验配置。非流式沿用原来的「400 + JSON 错误」口径；流式下头已经发出去了，只能走 error 事件。
 */
function validateConfig(provider: string, baseUrl: string, model: string, body: ChatBody | null): string | null {
  if (!supportsToolCalling(provider)) {
    return "AI 交易员的工具调用需要 OpenAI 兼容接口（DeepSeek/OpenAI/Moonshot/OpenRouter/Ollama/自定义中转），请在设置中切换";
  }
  if (!baseUrl || !model) return "AI 未配置：请到「设置 → AI 接口」填写接口地址与模型";
  if (!(body?.messages ?? []).length) return "消息为空";
  return null;
}

/**
 * 工具调用环（流式 / 非流式共用）。
 * emit 只在流式下真的往队列里塞事件；非流式下传一个空函数，判定与取数一字不差。
 */
async function runToolLoop(opts: {
  url: string;
  apiKey: string;
  model: string;
  messages: Record<string, unknown>[];
  agent: ProxyAgent | null;
  emit: (ev: StreamEvent) => void;
  /** 前端断开或超时后停止推进：不再取数、不再发事件，也不谎称回答完成 */
  isCancelled: () => boolean;
  /** P7-⑥④：工具执行上下文（本机自选清单随请求带来，服务端不读浏览器存档） */
  ctx: ToolCtx;
  /** P7-⑥⑤：场景预取已经占用的步骤号，模型自取的动作接着往下编，两套步骤不能都从 1 开始 */
  stepStart?: number;
}): Promise<{ content: string; trace: ChatTraceItem[]; steps: StepInfo[]; cancelled: boolean }> {
  const { url, apiKey, model, messages, agent, emit, isCancelled, ctx } = opts;
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.desc, parameters: t.params } }));
  const trace: ChatTraceItem[] = [];
  // 非流式没有 step 事件可发，终态步骤得随 JSON 一起回去（流式下这份只是冗余，事件已经发过了）
  const steps: StepInfo[] = [];
  let content = "";
  let stepNo = Math.max(0, Math.trunc(opts.stepStart ?? 0) || 0);
  // 是不是「五轮都用完还没拿到结论」：只有这种情况才能说轮次达上限，模型回了空正文不能算在它头上
  let roundsExhausted = true;

  for (let round = 0; round < 5; round++) {
    if (isCancelled()) return { content, trace, steps, cancelled: true };
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.3, stream: true }),
      dispatcher: agent ?? undefined,
      signal: AbortSignal.timeout(90_000),
    });

    // 上游拒绝流式（不认识 stream 参数）时按整体返回处理：结果是真的，只是没有逐字节奏 —— 必须如实登记
    let roundText = "";
    const assembler = createToolCallAssembler();
    let finishReason: string | null = null;
    let upstreamErr: string | null = null;

    if (isEventStream(res.headers.get("content-type"))) {
      const scanner = createSseScanner();
      const decoder = new TextDecoder();
      let sawDone = false;
       
      const body: any = res.body;
      if (body) {
        for await (const chunk of body) {
          if (isCancelled()) {
            try { body.destroy?.(); } catch { /* 已经断了 */ }
            return { content, trace, steps, cancelled: true };
          }
          const frames = scanner.push(decoder.decode(chunk as Uint8Array, { stream: true }));
          for (const f of frames) {
            const d = parseUpstreamFrame(f);
            if (d.text) {
              roundText += d.text;
              emit({ type: "delta", data: { content: d.text } });
            }
            if (d.toolCalls.length) assembler.push(d.toolCalls);
            if (d.finishReason) finishReason = d.finishReason;
            if (d.done) sawDone = true;
          }
          if (sawDone) break;
        }
      }
      for (const f of scanner.flush()) {
        const d = parseUpstreamFrame(f);
        if (d.text) { roundText += d.text; emit({ type: "delta", data: { content: d.text } }); }
        if (d.toolCalls.length) assembler.push(d.toolCalls);
        if (d.finishReason) finishReason = d.finishReason;
      }
      if (!sawDone && !finishReason) {
        emit({ type: "warning", data: { text: "上游流未正常收尾（没有 [DONE] 也没有 finish_reason），以上内容到此处为止，未补全。" } });
      }
    } else {
       
      const j = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) upstreamErr = j?.error?.message || `上游返回 ${res.status}`;
      const msg = j?.choices?.[0]?.message;
      roundText = String(msg?.content ?? "");
      finishReason = j?.choices?.[0]?.finish_reason ?? null;
      for (const tc of (msg?.tool_calls ?? []) as ToolCallMsg[]) {
        assembler.push([{ index: 0, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments }]);
      }
      if (!upstreamErr) {
        emit({ type: "warning", data: { text: notStreamedWarning(res.headers.get("content-type")) } });
        if (roundText) emit({ type: "delta", data: { content: roundText } });
      }
    }
    if (upstreamErr) throw new Error(upstreamErr);
    if (!res.ok) throw new Error(`上游返回 ${res.status}`);

    const calls = assembler.result();
    if (!calls.length) {
      content = roundText;
      roundsExhausted = false;
      break;
    }
    // 工具调用轮里模型偶尔先说一句过渡语：流式下它已经发出去了，如实留着，不回滚也不谎称是结论。
    messages.push({ role: "assistant", content: roundText, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsText } })) });
    const results = await Promise.all(calls.map(async (c) => {
      const step = ++stepNo;
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(c.argsText || "{}"); } catch { /* 参数坏 → 下面按未知/失败处理 */ }
      const label = stepLabelFor(c.name, parsedArgs);
      // source=model：这一条是模型自己要调的，不是系统按场景预取的。界面必须分开，
      // 否则用户会以为「所有数据都是模型自己取的」，而预取那批其实一句提示词都没给它下过命令。
      emit({ type: "step", data: { step, label, status: "running", tool: c.name, source: "model", reason: "模型判断需要该数据，自行调用" } });
      const started = Date.now();
      let out: unknown;
      let status: "ok" | "error" = "ok";
      try {
        const fn = findTool(c.name);
        if (!fn) out = { missing: `未知工具 ${c.name}` };
        // 各工具入参形状不同（TS 把联合函数的参数取成交集），运行时传的就是模型给的那份 JSON：
        // 每个工具体内自己 normalizeSymbol / 判空并回 missing，所以这里按通用形状转发，不在这里替模型猜参数。
        // ctx 是「用户本机自选清单」这类非模型参数能给的输入，只有 watchlist_overview 用得到。
        else out = await (fn.fn as (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>)(parsedArgs, ctx);
      } catch (e) {
        out = { missing: `工具执行失败：${(e as Error).message}` };
        status = "error";
      }
      const ms = Date.now() - started;
      const text = JSON.stringify(out);
      trace.push({ name: c.name, args: parsedArgs, ms, status, summary: text.length > 120 ? text.slice(0, 120) + "…" : text });
      const judged = stepDetailOf(out);
      const finalStatus: StepInfo["status"] = status === "error" ? "error" : judged.status;
      // P7-⑧④：回测工具会把任务 id 带回来。步骤里只存 id，结果由前端按现成的回测查询接口去取，
      // 于是对话里画的就是量化页那张卡（同一套渲染、同一份数据），而不是在这儿再抄一份回测读数。
      const outJobId = (out as { jobId?: unknown } | null)?.jobId;
      const jobId = typeof outJobId === "string" && outJobId ? outJobId : undefined;
      steps.push({
        step, label, tool: c.name, ms, status: finalStatus, detail: judged.detail,
        source: "model", reason: "模型判断需要该数据，自行调用",
        ...(jobId ? { jobId } : {}),
      });
      emit({
        type: "step",
        data: {
          step, label, tool: c.name, ms,
          // 工具本身抛错＝error；返回 missing 字段＝missing（缺数据不是失败，两者在界面上必须分开）
          status: finalStatus,
          detail: judged.detail,
          ...(jobId ? { jobId } : {}),
        },
      });
      return { role: "tool", tool_call_id: c.id, content: text.slice(0, 6000) };
    }));
    messages.push(...results);
    if (isCancelled()) return { content, trace, steps, cancelled: true };
  }
  // 两种「没有正文」必须分开说：轮次用满 ≠ 模型没话说，混为一谈就是把系统的限制写成模型的表现。
  if (!content) {
    content = roundsExhausted
      ? "（工具调用轮次已达上限，未能生成结论；请缩小问题范围后重试）"
      : "（上游这次没有返回正文，只回了空的回答；请把问题拆细后重试）";
  }
  return { content, trace, steps, cancelled: false };
}

export async function POST(req: NextRequest) {
  quantBootstrap();
  let provider = req.headers.get("x-ai-provider") ?? "";
  let baseUrl = (req.headers.get("x-ai-base-url") ?? "").trim();
  let apiKey = req.headers.get("x-ai-api-key") ?? "";
  let model = (req.headers.get("x-ai-model") ?? "").trim();
  const body = (await req.json().catch(() => null)) as ChatBody | null;
  const wantStream = body?.stream === true || /text\/event-stream/i.test(req.headers.get("accept") ?? "");

  // P8-⑤⑥ 的两个外部输入：run 只认非空字符串、debug 只认布尔 true（都不猜）。
  // 续传是流式独有能力：非流式 JSON 路径不认 run、不碰 RunBus（细则 §2.6，口径一字不动）。
  // 撞号/满员如实退回无 run 的普通轮——轮次照旧跑完，只是不谎称可续传。
  let runId: string | null = wantStream && typeof body?.run === "string" && body.run ? body.run : null;
  if (runId && !RUNS.start(runId).ok) runId = null;
  const debugOn = body?.debug === true;

  // P7-⑩ 任务4：浏览器未配置凭据时落服务端 .env 通道 —— 但工具环只放官方 API 模式过去。
  // 本地网关（doubao2API）实测只取最后一条 user 消息、不执行 function call，把 tools 发过去
  // 等于让模型在没有工具的世界里硬编「我调过了」—— 这条路上宁可少一条工具链，不能多一批假数据。
  // 对话层的网关通路在 /api/ai/proxy（系统按场景预取数据），不损失回答能力，只损失「模型自己补数」。
  if (!baseUrl || req.headers.get("x-ai-server") === "1") {
    const r = getServerLlm();
    if (!r.available) {
      const invalid = `服务端模型通道不可用：${r.reason}`;
      if (!wantStream) return NextResponse.json({ error: invalid, trace: [] }, { status: 400 });
      return sseResponse(async (emit) => { emit({ type: "error", data: { message: invalid } }); });
    }
    if (r.channel.mode === "gateway") {
      const invalid = "本地豆包网关不支持工具调用环（只收最后一条提问、不走 function call），AI 交易员这条路需要 OpenAI 兼容的工具能力：请在 .env 把 LLM_BASE_URL 指向官方 API 模式，或到设置页填写浏览器侧凭据；普通对话与奇门解盘不受影响，走网关照常可用。";
      if (!wantStream) return NextResponse.json({ error: invalid, trace: [] }, { status: 400 });
      return sseResponse(async (emit) => { emit({ type: "error", data: { message: invalid } }); });
    }
    provider = "openai";
    baseUrl = r.channel.baseUrl;
    apiKey = r.channel.apiKey;
    model = r.channel.model;
  }

  const invalid = validateConfig(provider, baseUrl, model, body);
  if (invalid) {
    if (!wantStream) return NextResponse.json({ error: invalid }, { status: 400 });
    return sseResponse(async (emit) => { emit({ type: "error", data: { message: invalid } }); });
  }

  // 上下文窗口：客户端内核（chat-core.splitWindow）已按轮裁好、并把旧对话压成一条 system 摘要。
  // 这里再兜一道，但规则要说清楚：只从最早的用户/助手消息开始丢，system 件（摘要、快照说明）永不静默丢弃——
  // 从尾部无脑 slice 会正好把摘要挤掉，等于「压缩白做」。
  const keepTurns = clampTurns(body?.contextWindow);
  const history = trimDialog(body?.messages ?? [], keepTurns * 2);
  const agent = await resolveProxy(req, baseUrl);
  const apiBase = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = `${apiBase}/v1/chat/completions`;
  // mode 是浏览器带来的外部输入：过一遍 modes.ts 的白名单，认不出的按默认口径答，
  // 而不是带着一个不存在的模式名去查表（查不到就静默少一段风格说明，用户看不出来）
  const mode = asChatMode(body?.mode);
  // P8-⑥：仅带 run 的轮次换 cancel 源（grace=跑到自然结束或显式停止，细则 §5-3 拍板项）；
  // 不带 run 的请求保持「断连即停」旧语义逐字不变（P7 口径）。
  const isCancelled = () => (runId ? RUNS.cancelled(runId) : req.signal.aborted);
  // 自选清单：服务端不读浏览器存档，只认请求体里带来的这份。
  // 非数组一律当没带（工具层会如实回「自选清单为空」，不会拿别的来源冒充）；
  // 代码识别、去重与条数上限在工具层的 watchlist_overview 内做，本层不替它猜。
  const ctx: ToolCtx = { watchlist: Array.isArray(body?.watchlist) ? body.watchlist : [] };
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  // 场景层自己出错时用它把原因带到响应里：这轮照样要回答，但不能让用户以为「只是没取到数据」
  let sceneFailure: string | null = null;

  /** 入口固定提示词 + 场景提示词 + 本轮预取数据，拼成发给模型的消息数组（顺序规则见 chat-core.injectSceneContext） */
  const baseMessages: ContextMsg[] = [{ role: "system", content: systemPrompt(mode, body?.focusSymbol) }, ...history];
  // 交给工具调用环时换成 Record 形状：它还要往同一批消息里追加 tool_calls / tool_call_id
  const buildMessages = (turn: SceneTurn | null): Record<string, unknown>[] =>
    injectSceneContext(baseMessages, turn ?? {}, (role, content) => ({ role, content })).map((m) => ({ ...m }));

  if (!wantStream) {
    let turn: SceneTurn | null = null;
    try {
      turn = await prepareSceneTurn({
        userContent: typeof lastUser?.content === "string" ? lastUser.content : "",
        ctx,
        focusSymbol: body?.focusSymbol ?? null,
        sessionSymbol: body?.sessionSymbol ?? null,
        prevScene: body?.prevScene,
        today: shanghaiDate(),
        isCancelled,
      });
    } catch (e) {
      // 场景层出问题不能让整轮问答挂掉：按「本轮没有场景提示词、也没有自动取数」继续，并如实留痕
      turn = null;
      sceneFailure = (e as Error).message || "场景自动调度失败";
    }
    try {
      const r = await runToolLoop({
        url, apiKey, model, messages: buildMessages(turn), agent, emit: () => {}, isCancelled, ctx,
        stepStart: turn?.nextStep ?? 0,
      });
      const steps = [...(turn?.steps ?? []), ...r.steps];
      // 「正文给了回测数字、这一轮却没真跑成」的护栏：数字对不对看步骤，不看正文（口径在 backtest-core）
      const btWarn = backtestClaimWarning(steps, r.content);
      // P8-②：结论契约校验同样只出警告，不改正文、不重答（风险点 4）；且只有本轮真注入了契约才核（风险点 3）
      const cw = turn ? contractWarningOf(turn, r.content) : null;
      const warn = [
        sceneFailure ? `本轮未做场景自动取数：${sceneFailure}` : "",
        btWarn ?? "", cw ?? "",
      ].filter(Boolean).join("；");
      return NextResponse.json({
        content: r.content,
        trace: [...(turn?.trace ?? []), ...r.trace],
        mode,
        ...(turn ? { intent: turn.badge } : {}),
        // 非流式没有 step 事件可走，步骤与「本轮没做成什么」只能随 JSON 一起回
        ...(steps.length ? { steps } : {}),
        ...(warn ? { warning: warn } : {}),
      });
    } catch (e) {
      return NextResponse.json({ error: `AI 调用失败：${(e as Error).message}`, trace: [] }, { status: 502 });
    }
  }

  return sseResponse(async (emit) => {
    let turn: SceneTurn | null = null;
    try {
      turn = await prepareSceneTurn({
        userContent: typeof lastUser?.content === "string" ? lastUser.content : "",
        ctx,
        focusSymbol: body?.focusSymbol ?? null,
        sessionSymbol: body?.sessionSymbol ?? null,
        prevScene: body?.prevScene,
        today: shanghaiDate(),
        emit,
        isCancelled,
      });
    } catch (e) {
      turn = null;
      emit({ type: "warning", data: { text: `场景自动调度未完成，本轮按「无自动取数」继续回答：${(e as Error).message}` } });
    }
    // P8-⑤：轮末把带上了 args/summary 的终态帧按同序号重发一遍（applyEvent 按步骤号字段合并，
    // 不产生第二条步骤）——预取侧配 turn.trace、模型自取侧配 r.trace，两段拼接后一次富化。
    const emitDebugSteps = (steps: StepInfo[], trace: ChatTraceItem[]) => {
      if (!debugOn || !steps.length) return;
      for (const f of debugFramesFromSteps(steps, trace)) {
        if (f.args || f.summary) emit({ type: "step", data: { ...f, status: f.status as StreamStep["status"], ms: f.ms ?? null } });
      }
    };
    const loopStart = Date.now();
    try {
      const r = await runToolLoop({
        url, apiKey, model, messages: buildMessages(turn), agent, emit, isCancelled, ctx,
        stepStart: turn?.nextStep ?? 0,
      });
      if (r.cancelled) {
        // 带 run 的轮次 isCancelled 只会被「显式停止」置真（断连不算）——话术必须分开，不把用户自己的停止说成掉线
        emit({ type: "error", data: { message: runId ? "已按停止请求提前结束本轮，已收到的内容保留在时间线上" : "客户端已断开，本次回答提前结束（结束后不会再取数）" } });
        return;
      }
      // 同一条护栏在两条传输上都要成立：降级路径与非降级路径不能一个查一个不查
      const btWarn = backtestClaimWarning([...(turn?.steps ?? []), ...r.steps], r.content);
      if (btWarn) emit({ type: "warning", data: { text: btWarn } });
      // P8-②：流式路径同口径核契约——只补 warning 帧，r.content 原样进 done，不做任何改写/重试
      const cw = turn ? contractWarningOf(turn, r.content) : null;
      if (cw) emit({ type: "warning", data: { text: cw } });
      emitDebugSteps([...(turn?.steps ?? []), ...r.steps], [...(turn?.trace ?? []), ...r.trace]);
      emit({
        type: "done",
        data: {
          fullText: r.content,
          ...(turn ? { intent: turn.badge } : {}),
          // P8-⑤：结论留底只给 debug=true 的请求发；耗时是整个模型环（含工具轮）的真实时间
          ...(debugOn ? { debug: { modelMs: Date.now() - loopStart, transport: "stream" as const } } : {}),
        },
      });
    } catch (e) {
      emit({ type: "error", data: { message: `AI 调用失败：${(e as Error).message}` } });
    }
  }, runId);
}

/**
 * SSE 响应骨架。
 * 这里不用 NextResponse.json 那种「先拿全再返回」的写法，ReadableStream 会真的逐帧 flush；
 * 是否真的逐帧到达以 next build + next start 下 `curl -N` 的时间戳为准（见 worklog），不看代码想当然。
 */
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
        } catch { /* 客户端已断开：enqueue 抛错交给循环里的 isCancelled 收尾（带 run 轮次的 cancel 源是停止键） */ }
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
