// P7-⑩ 任务4「模型配置化层」的纯内核：不读 process.env、不 fetch、不碰时钟。
//
// 为什么 env 要作为参数传进来（而不是这里直接读 process.env）：
//  1) 这一层要同时被服务端（proxy/chat 路由）和单测使用，纯函数才能把「默认值/双模式」
//     的所有边界钉死在测试里，不需要伪造运行时环境；
//  2) 它和 QimenPanel 一样会被浏览器侧代码间接引用（判断「该走服务端通道还是浏览器配置」
//     的文案在内核里），内核一 import process.env 就会把 Node 依赖拖进浏览器包。
// 读 process.env 的脏活留在 model-config.ts（仅服务端 import）。
//
// 口径来源（任务书《KairoTrend P7 下一阶段开发任务书》第五节 任务4）：
//  - 三个配置项：LLM_BASE_URL（默认 http://localhost:7861/v1）、LLM_API_KEY（本地网关模式
//    网关不校验，随便填）、LLM_MODEL_NAME（默认 doubao-pro）；
//  - 两种模式由 .env 切换：本地网关模式（豆包大脑）/ 官方 API 模式（OpenAI 兼容 Key 直连）；
//  - 换 GLM/DeepSeek 等任何 OpenAI 兼容模型只改 .env，不改业务代码 —— 所以这里不许出现
//    任何按模型名分支的逻辑，baseUrl+model+key 三元组就是全部。
//
// 模式判定为什么用「局域网地址 = 网关」而不是再加一个 LLM_MODE 开关：多一个开关就多一个
// 和 baseUrl 打架的状态。任务书自己给的默认值就是 localhost:7861，本地/官方的区别在网关
// 上不校验 Key、官方上要 Key —— 这恰好是「地址是否本机/内网」能推出的唯一那条线。

// R14 补数协议卡不住在这张文件里：它有 gateway-loop-core 的单源常量依赖，而本内核的口径是
// 零 import（纯函数才能被 node --test 直跑的钉测引用）。协议卡见 gateway-loop-core 尾部。

/** 网关不校验 Key，但请求头总得有个 Bearer 值；README 通篇用 admin，占位沿用它。 */
export const GATEWAY_PLACEHOLDER_KEY = "admin";

export const DEFAULT_LLM_BASE_URL = "http://localhost:7861/v1";
export const DEFAULT_LLM_MODEL = "doubao-pro";

/** .env 能出现的三个键（单测钉住，防止改名后默认值悄悄失效） */
export const LLM_ENV_KEYS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL_NAME"] as const;

export interface LlmEnvLike {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL_NAME?: string;
}

/** 解析成功：拿到可直接转发的三元组。mode 只影响两处行为：Key 可否为空、历史要不要折叠。 */
export interface ServerLlmChannel {
  mode: "gateway" | "official";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ServerLlmResult =
  | { available: true; channel: ServerLlmChannel }
  | { available: false; reason: string };

/**
 * GET /api/llm/config 的响应形状（也是浏览器侧缓存的那份）：
 * 只有模式/地址/模型名与不可用原因，Key 的值永不出现在这里。
 */
export interface ServerLlmPublic {
  available: boolean;
  mode?: "gateway" | "official";
  baseUrl?: string;
  model?: string;
  reason?: string;
}

export const TEXT_BAD_BASE = "LLM_BASE_URL 不是合法的 http(s) 地址（需要形如 http://127.0.0.1:7861/v1 的完整地址；漏了 scheme 的 localhost:7861 会被 URL 解析器当成名为 localhost 的协议）";
export const TEXT_OFFICIAL_NO_KEY =
  "官方 API 模式下必须填 LLM_API_KEY（非本机/内网地址不做无 Key 直连）；想用免 Key 的本地豆包大脑，把 LLM_BASE_URL 指回 http://localhost:7861/v1 即可";

/** 本机与内网判定：与 proxy 路由原有 isLanUrl 同一份口径（这里成为唯一实现，路由改为引用它）。 */
export function isLanBaseUrl(base: string): boolean {
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

export function resolveServerLlm(env: LlmEnvLike): ServerLlmResult {
  const baseUrl = (env.LLM_BASE_URL ?? "").trim() || DEFAULT_LLM_BASE_URL;
  const model = (env.LLM_MODEL_NAME ?? "").trim() || DEFAULT_LLM_MODEL;
  const key = (env.LLM_API_KEY ?? "").trim();
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { available: false, reason: TEXT_BAD_BASE };
  } catch {
    return { available: false, reason: TEXT_BAD_BASE };
  }
  if (isLanBaseUrl(baseUrl)) {
    return { available: true, channel: { mode: "gateway", baseUrl, apiKey: key || GATEWAY_PLACEHOLDER_KEY, model } };
  }
  if (!key) return { available: false, reason: TEXT_OFFICIAL_NO_KEY };
  return { available: true, channel: { mode: "official", baseUrl, apiKey: key, model } };
}

// ---------- 上游超时钳位 ----------
//
// 为什么要有这个纯函数：/api/ai/proxy 的流式与非流式两条路都要把「客户端想要的上游超时」钳到
// [10s, 600s]。原来这段逻辑只写在流式一处（非流式 callOpenAI 写死 45s），事件理解这类结构化长
// 生成（客户端传 120s）因此永远撞不到 120s、45s 一到就被判「连接上游超时」——这是「AI理解今日
// 事件」点不动的根因之一。把钳位收成一处纯函数，两条路共用同一份口径，也能被 node --test 直跑钉死。
//
// 只认 >= 10s 的显式数字：低于 10s / 非数字 / 缺失一律回落各自默认（流式 120s、非流式 45s）——
// 不替调用方猜一个「更短」的超时，那只会把慢上游误判成失败。
export const MIN_UPSTREAM_TIMEOUT_MS = 10_000;
export const MAX_UPSTREAM_TIMEOUT_MS = 600_000;

export function clampUpstreamTimeoutMs(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_UPSTREAM_TIMEOUT_MS) return fallback;
  return Math.min(Math.trunc(n), MAX_UPSTREAM_TIMEOUT_MS);
}

// ---------- 历史折叠（只对网关模式做） ----------
//
// doubao2API README 6.5 实测口径：OpenAI 兼容请求里它**只取最后一条 user 消息**，多轮上下文由
// 豆包服务端按自己的 conversation 管理。这对我们是功能性伤害：本项目每轮都带完整历史与 system
// 提示词，模型会「看不见前文、也看不见我们的纪律」。所以网关模式下把 system + 既往轮次 + 本轮
// 问题折成一条 user 消息发出去 —— 不改上游代码、不猜网关的私有接口，OpenAI 兼容层内自救。

export interface FoldableMsg {
  role: "user" | "assistant" | "system";
  content: string;
}

const FOLD_SYSTEM_HEADER = "【系统要求（须全部遵守）】";
const FOLD_HISTORY_HEADER = "【既往对话（前端存档，按时间顺序）】";
const FOLD_CURRENT_HEADER = "【本轮问题】";

export function foldHistoryForGateway(messages: FoldableMsg[]): FoldableMsg[] {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUserIdx === -1) return messages; // 没有 user 发言就没有「本轮问题」可折，原样交出去让上游报错
  const systems = messages.filter((m) => m.role === "system" && m.content.trim()).map((m) => m.content.trim());
  const prior = messages.slice(0, lastUserIdx).filter((m) => m.role !== "system");
  const last = messages[lastUserIdx];
  // 本轮问题之后的 assistant 残留（理论上不该有）不参与折叠，避免把未完成的一轮当成已发生
  const parts: string[] = [];
  if (systems.length) parts.push(`${FOLD_SYSTEM_HEADER}\n${systems.join("\n\n")}`);
  if (prior.length) {
    parts.push(`${FOLD_HISTORY_HEADER}\n${prior.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n")}`);
  }
  parts.push(`${FOLD_CURRENT_HEADER}\n${last.content}`);
  return [{ role: "user", content: parts.join("\n\n") }];
}

/** 折叠段的三个标题暴露给单测与面板文案：拼出来的形状变了要能被发现。 */
export const FOLD_HEADERS = { system: FOLD_SYSTEM_HEADER, history: FOLD_HISTORY_HEADER, current: FOLD_CURRENT_HEADER };

// ---------- 网关通道身份卡（R12 专属大脑） ----------
//
// 为什么要这张卡：网关这条路每轮都是豆包的**全新会话**（实测 v1_chat.py 不传 conversation_id，
// 豆包侧没有我们的任何前文记忆），模型既不知道自己在 Kairo 工作台里、也不知道自己根本没有工具——
// R11 走查实抓的事故就是它对着我们回答「我调用了 candidate_pool，失败了」（没调过＝编过程）。
// 折叠层负责把纪律**送达到** user 文本里，这张卡负责纪律**内容本身**：一份定义，钉测直跑。
// 只在 mode==="gateway" 且有 scene 的对话轮注入——官方 API 模式有真工具环，说「你没有工具」就成谎话了。

export const GATEWAY_BRAIN_BRIEF = [
  "【Kairo 工作台·接入须知（系统随每轮附上，不是用户说的）】",
  "你是 Kairo 工作台（本地 A 股量化工作台）里的分析大脑。你的脑子是你的，但行情数据全部在工作台手里：",
  "1) 这条通道是一次一答的纯文字对话：你没有任何工具，也不具备直接调用接口的能力。回答里绝不允许出现「我调用了某工具 / 调用失败 / 系统反馈查询为空」这类过程描述——没做过的事不能说自己做过，编过程和编数字一样是事故。（唯一合法例外见本轮若附上的「补数协议卡」。）",
  "2) 真实数据由系统放在本消息的「[系统按场景自动取数]」段里（每块自带来源：东财/腾讯/同花顺/通达信/本机引擎等），没取到的维度列在「[本轮未取到的数据]」。这两处之外你本轮没有数据：缺的就说「工作台本轮没取到」，不许凭记忆补数字、补公告、补市场事实。",
  "3) 「没取到」不等于「不存在」：查不到某公司、某读数，只能说没查到，不能反推成「未上市 / 没有代码 / 没有这回事」——这是硬纪律。",
  "4) 工作台有冻结候选池（AI 实时选股存的，池号形如 2026-09-22-全A-101）：用户点名池号时系统会把该池的条件与名单放进数据块（行键已是人话：代码/名称/收盘价/涨跌幅%/入池时条件）；数据块里没有该池时，请用户给完整池号，别自己编池。",
  "5) 说话像人：先给结论再给论据，数字带来源和日期，最后用白话收一句口；不确定就说不确定，别用含糊话假装全知。",
].join("\n");

// ---------- 流式降级判定 ----------
//
// 任务书要求「网关不支持 SSE 就自动切轮询，不直接报错」。可落地的形态：同一地址重发一次
// **非流式**请求（对上游就是一次性取全量结果；本项目没有第二条私有轮询协议可查，
// 假装知道网关有 job 接口才是虚构）。两条铁律：
//  1) 已经吐出过 delta 就不许重发 —— 否则用户会看到半截答案被同轮重答一遍；
//  2) 只有连接类错误才降级。鉴权 401/参数 400 重试一次只会多等一次失败。

const RETRYABLE_STREAM_FAIL = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|UND_ERR|fetch failed|Premature close|terminated: i\/o error/i;

export function shouldRetryNonStream(errMessage: string, emittedAnyDelta: boolean): boolean {
  if (emittedAnyDelta) return false;
  return RETRYABLE_STREAM_FAIL.test(errMessage || "");
}

/** 本地网关连不上时的指路文案：指向真正的病根（网关没启动），而不是笼统的「无法连接上游」。 */
export function gatewayUnreachableText(baseUrl: string): string {
  return `无法连接模型通道 ${baseUrl}：本地豆包网关未启动或端口不对。先启动 D:\\doubao2API-main（python start.py，默认监听 7861），或在 .env 里改 LLM_BASE_URL 切到官方 API 模式`;
}
