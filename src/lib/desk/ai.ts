// 客户端 AI 调用辅助：所有请求走本地 /api/ai/proxy，
// Key 只放在请求头里转发给所选服务商，不写入数据库、不打印日志。
// P7-⑩ 任务4：浏览器没填凭据时自动落「服务端 .env 模型通道」（默认＝本地豆包网关），
// 本文件里那套 serverLlm* 状态就是该通道的浏览器侧镜像 —— 只缓存 GET /api/llm/config 的
// 公开形状（模式/地址/模型名），Key 永不进这里；判定与默认值的正身在 model-config-core.ts。
import type { AiProvider, AiSettings } from "./types";
import type { ChatMode } from "./modes";
import type { IntentBadge, StepInfo } from "./chat-core";
import { pickChatEndpoint } from "./chat-stream-core.ts";
import { renderAnalysisFrames } from "../llm/analysis-frames.ts";
import type { ServerLlmPublic } from "../llm/model-config-core.ts";

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  hint?: string;
}

export const PROVIDER_PRESETS: Record<AiProvider, ProviderPreset> = {
  openai:     { label: "OpenAI",     baseUrl: "https://api.openai.com",                model: "gpt-4o-mini" },
  anthropic:  { label: "Claude",     baseUrl: "https://api.anthropic.com",             model: "claude-3-5-haiku-latest" },
  gemini:     { label: "Gemini",     baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash" },
  deepseek:   { label: "DeepSeek",   baseUrl: "https://api.deepseek.com",              model: "deepseek-chat" },
  moonshot:   { label: "Moonshot",   baseUrl: "https://api.moonshot.cn",               model: "moonshot-v1-8k" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api",             model: "deepseek/deepseek-chat", hint: "有免费模型可选" },
  ollama:     { label: "Ollama",     baseUrl: "http://localhost:11434",                model: "qwen2.5:7b", hint: "本机离线，无需 Key" },
  custom:     { label: "自定义中转",  baseUrl: "",                                      model: "", hint: "填 OpenAI 兼容的中转地址" },
};

export function aiConfigured(ai: AiSettings): boolean {
  if (!ai.baseUrl || !ai.model) return false;
  if (ai.provider === "ollama") return true;
  return !!ai.apiKey;
}

// ---------- P7-⑩ 服务端 .env 模型通道的浏览器侧状态 ----------
//
// 乐观可用的口径：resolveServerLlm 对默认配置（本地网关）恒判可用，所以「配置状态还没取回来」
// 不该把对话挡在门外；真正关门只有一种情况 —— 服务端明确回了 available:false
// （官方模式没填 Key / 地址非法），或这次 GET 就没通（.next 没起、路由 404，按可用试一把，
// 请求真发不出去时 400/网络错误会如实出现在气泡里，比提前灰掉整页更接近真相）。

let serverLlmInfo: ServerLlmPublic | null = null;
let serverLlmLoaded = false;
let serverLlmFetching = false;
const serverLlmSubs = new Set<() => void>();

function notifyServerLlm() {
  for (const cb of [...serverLlmSubs]) {
    try { cb(); } catch { /* 订阅方自己坏不掉这里 */ }
  }
}

/** 每次页面加载只探一次；重复调用是 no-op（组件挂载、aiReady 判定都可能是第一个触发者）。 */
export function ensureServerLlm(): void {
  if (serverLlmFetching || serverLlmLoaded || typeof fetch !== "function") return;
  serverLlmFetching = true;
  fetch("/api/llm/config")
    .then(async (res) => {
      const j = (await res.json().catch(() => null)) as Partial<ServerLlmPublic> | null;
      serverLlmInfo = j && typeof j.available === "boolean"
        ? { available: j.available, ...(j.mode ? { mode: j.mode } : {}), ...(j.baseUrl ? { baseUrl: j.baseUrl } : {}), ...(j.model ? { model: j.model } : {}), ...(j.reason ? { reason: j.reason } : {}) }
        : null;
      serverLlmLoaded = true;
    })
    .catch(() => { /* 探不到就维持「乐观可用」，不锁界面 */ })
    .finally(() => { serverLlmFetching = false; notifyServerLlm(); });
}

export function getServerLlmInfo(): ServerLlmPublic | null {
  return serverLlmLoaded ? serverLlmInfo : null;
}

export function subscribeServerLlm(cb: () => void): () => void {
  serverLlmSubs.add(cb);
  ensureServerLlm();
  return () => { serverLlmSubs.delete(cb); };
}

/** 服务端通道当前是否「不该被判定为不可用」—— 见上方乐观可用口径 */
export function serverChannelUsable(): boolean {
  return !(serverLlmLoaded && serverLlmInfo && serverLlmInfo.available === false);
}

/** 对话可用性的新口径：浏览器凭据齐 或 服务端通道没被明确判死。所有「AI 未配置」的门都换用它。 */
export function aiReady(ai: AiSettings): boolean {
  return aiConfigured(ai) || serverChannelUsable();
}

/** 这一轮是否走服务端通道（浏览器没填全凭据且通道可用）；请求头带不带 x-ai-server 由它定 */
export function usingServerChannel(ai: AiSettings): boolean {
  return !aiConfigured(ai) && serverChannelUsable();
}

/** 两条传输（非流式 aiChatPlain / 流式 streamChat）共用同一份请求头口径：谁该带 x-ai-server 只判一次 */
export function aiRequestHeaders(ai: AiSettings, extra: Record<string, string> = {}): Record<string, string> {
  if (usingServerChannel(ai)) {
    // 服务端通道：地址/模型/Key 全在 .env，浏览器一个都不带（也一个都不知道）。
    return { "Content-Type": "application/json", "x-ai-server": "1", ...extra };
  }
  return {
    "Content-Type": "application/json",
    "x-ai-provider": ai.provider,
    "x-ai-base-url": ai.baseUrl,
    "x-ai-api-key": ai.apiKey,
    "x-ai-model": ai.model,
    ...(ai.proxy?.trim() ? { "x-ai-proxy": ai.proxy.trim() } : {}),
    ...extra,
  };
}

/**
 * 端点选择的唯一入口（use-chat 与 AssistantPage 共用，同一轮流式/兜底/重生成都拿它定一次）。
 * 走服务端通道时 tools 端点只在官方 API 模式下可用：本地网关没有 function call 环，
 * 发过去只会被 /api/ai/chat 按口径拒（文案与服务端一致）；模式还没探明时按网关处理，
 * 宁可走 plain（场景预取照样在）也不让工具环吞一条红字。
 */
export function resolveChatEndpoint(ai: AiSettings, want: "auto" | "plain" | "tools" = "auto"): "plain" | "tools" {
  if (usingServerChannel(ai)) {
    ensureServerLlm(); // 顺带把模式探明一次：下一轮就能区分官方（可 tools）/网关（恒 plain）
    const info = getServerLlmInfo();
    if (info?.mode === "official") return want === "plain" ? "plain" : "tools";
    return "plain";
  }
  return pickChatEndpoint(ai.provider, want);
}

export async function aiChat(
  ai: AiSettings,
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  opts?: { timeoutMs?: number; watchlist?: { symbol: string; name?: string | null }[] }
): Promise<string> {
  return (await aiChatPlain(ai, messages, opts)).text;
}

// P7-⑥⑤：aiChat 只回一句正文，而对话的非流式兜底还要拿回「这一步是谁取的、按哪个场景答的」。
// 拆成两个函数而不是给 aiChat 加返回值：研究页/事件理解/Agent 循环/连通性自检都要的是一句话，
// 让它们各自去解构 {text} 只会多出噪声，两条路共用同一份实现又不会漂移。
export interface PlainChatResult {
  text: string;
  /** 场景自动调度取到的步骤（服务端已判好状态） */
  steps?: StepInfo[];
  /** 场景徽章；服务端没判（没带 scene）就没有，前端不画半个假徽章 */
  intent?: IntentBadge;
  /** 一次性返回里的留痕（例如「本轮未做场景自动取数：原因」） */
  warning?: string;
}

export async function aiChatPlain(
  ai: AiSettings,
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  opts?: {
    timeoutMs?: number;
    watchlist?: { symbol: string; name?: string | null }[];
    /** 带 scene＝这一轮是对话，服务端才做意图识别 + 自动取数；不带＝原样转发 */
    scene?: { focusSymbol?: string | null; sessionSymbol?: string | null; prevScene?: string | null };
    /** 回答风格：与流式请求体同一份顶层 mode 键，服务端只在带 scene 时消费（校验在 /api/ai/proxy） */
    mode?: ChatMode;
  }
): Promise<PlainChatResult> {
  ensureServerLlm();
  const res = await fetch("/api/ai/proxy", {
    method: "POST",
    headers: aiRequestHeaders(ai),
    body: JSON.stringify({
      messages,
      // P7-⑥④：与流式请求体同一份口径 —— 自选清单由浏览器带，服务端不读 localStorage
      ...(opts?.watchlist?.length ? { watchlist: opts.watchlist } : {}),
      ...(opts?.scene ? { scene: opts.scene } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
    }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string })?.error || `请求失败（${res.status}）`);
  const j = json as { content?: string; steps?: StepInfo[]; intent?: IntentBadge; warning?: string };
  return {
    text: j.content ?? "",
    ...(Array.isArray(j.steps) && j.steps.length ? { steps: j.steps } : {}),
    ...(j.intent ? { intent: j.intent } : {}),
    ...(j.warning ? { warning: j.warning } : {}),
  };
}

// 从模型回复里尽量解析出 JSON（兼容被 ```json 包裹的情况）
export function parseLooseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// 智能助手统一系统提示词（各入口共用；context 为注入的行情/快讯快照文本）
//
// P6-A 修掉的口径问题：这里原来写死「（来自本机直连的真实行情接口，视为当前事实）」，
// 可同一个 context 里可能混着非 A 股品种的演示数据、按现价合成的假分时、以及本次没取到的缺失行——
// 一句话就把它们全升级成了「事实」。现在改成：来源分层由上下文逐条自带，提示词只负责要求模型遵守分层。
export function assistantSystemPrompt(context: string): string {
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  return [
    "你是 MyDesk 个人工作台的智能助理：既懂行情分析，也能像正常 AI 一样回答生活、学习、写作等任何问题。",
    `今天是 ${today}。`,
    "",
    "【行情上下文】（下面每条数据自带来源分层：REAL=本机直连真实取到，DERIVED=引擎对真实数据的派生计算，DEMO=演示数据不是行情，MISSING=本次缺失。）",
    "只有 REAL 与 DERIVED 可以作为行情依据；DEMO/MISSING 不得引用为价格或资金事实；没有标注来源的内容按「来源未知」处理，不要替它宣称真实。",
    context || "（本次会话未取得任何行情数据：状态 MISSING。请先说明缺什么，不要凭记忆或印象给出价格、涨跌幅、资金数据。）",
    "",
    "【回答规则】",
    "0. 区分四类内容并各自措辞：真实数据（直接引用）、派生统计（说明怎么算的）、历史回测（说明是过去样本，不等于今天会怎样）、你的解读（写成「我认为/可能的解读」，不要写成市场事实）。",
    "1. 行情 / 持仓类问题：按「结论 → 结构 / 关键位 / 思路参考 / 风险提示」结构回答；价位只引用上下文数字，数量级必须一致；单位用「元」；上下文里没有的数字不要补。",
    "2. 新闻类问题：优先引用【最新财经快讯】里的事实作答，注明「来自实时快讯」；快讯未覆盖的部分明确说明，不要编造。",
    "3. 宏观、政策类问题：知识有截止时间，先声明「基于历史公开信息，非实时数据」，再作答。",
    "4. 生活、学习、写作等一般问题：像正常 AI 一样自然、友好、详细地回答，不套用行情模板，不加投资风险提示。",
    "5. 简体中文，简洁 markdown；输出克制：最多一个表格，要点不超过 4 条。",
    // P7-⑩ 任务4：50 个深度研究框架作为全局系统 Prompt 随每个对话入口下发（与 /api/ai/chat
    // 服务端那份同源），换模型不改这里 —— 它属于对话层，不属于模型接入层。
    "",
    renderAnalysisFrames(),
  ].join("\n");
}

// 价格数量级校验：回答里至少要有一个接近现价的数字，否则视为幻觉
export function priceBandOk(reply: string, price: number | null): boolean {
  if (!price || price <= 0) return true;
  const nums = [...reply.matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  return nums.some((v) => v >= price * 0.5 && v <= price * 1.5);
}
