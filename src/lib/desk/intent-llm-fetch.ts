// P19-② 稳智 LLM 意图分类器 · 网络调用层
//
// 从 /api/ai/proxy 的 runWzIntentClassifier 抽出，供 /api/ai/chat（AI 交易员页 tools 端点）复用。
// 两个端点走的是同一份分类器、同一份 prompt、同一份解析——决策信号卡在三处入口（助手页 / 小窗 /
// AI 交易员页）看到的结论必须来自同一次 LLM 判定，不能一处走一处不走。
//
// 与 intent-llm-core.ts 的分工：
//   intent-llm-core.ts = 纯核（prompt 模板、JSON 解析、决策块渲染）
//   本文件            = 网络调用层（undici fetch + 超时 + 静默降级）
//
// 静默降级纪律（三条路径全验）：
//   1. enabled=false 直接返回空
//   2. 6 秒超时 / 上游非 200 / LLM 返回空内容 → 空
//   3. JSON 解析失败或 ok=false → 空
// 全都不阻塞主回答：分类器挂了，用户看到的还是常规回答（可能少一个决策卡）。
import type { ProxyAgent } from "undici";
import { fetch as undiciFetch } from "undici";
import { WZ_INTENT_PROMPT, parseWzDecisionLlmOutput, renderWzDecisionBlock, type WzDecisionSignal } from "./intent-llm-core.ts";

/** 超时 6 秒：分类器不能抢了主回答的时间——超过就直接降级 */
export const WZ_CLASSIFIER_TIMEOUT_MS = 6000;

export interface WzClassifierArgs {
  /** 只带 scene 的对话轮才启用；研究页/自检那类「一次一问」不吃 LLM 分类 */
  enabled: boolean;
  /** 用户显式选的持仓周期（Kairo 3 档）：不覆盖用户的显式选择，但仍让 LLM 补 signalType/stance */
  horizon: string | null;
  /** 本轮最后的 user 消息（分类器只需要这一句，不发 history 省 token） */
  lastUser: { role: string; content: string } | undefined;
  /** 规则引擎判到的场景：LLM 判不一致时记进 sceneDivergence */
  prevScene: string | null | undefined;
  /** OpenAI 兼容接口的 model/baseUrl/apiKey */
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 出网代理（与主请求共用，境外上游必须经中转） */
  agent: ProxyAgent | null;
  /** 客户端断开信号：一旦 aborted 就同步取消分类请求 */
  signal: AbortSignal;
}

export interface WzClassifierResult {
  /** 渲染成中文提示词块的字符串数组（注入 system 提示词用） */
  block: string[];
  /** 结构化决策信号（回传给前端渲染决策卡用；null = 未判出）
   *  注意：类型是 WzDecisionSignal（服务端判定层），前端接收时会通过
   *  chat-stream-core.asWzDecision 白名单解码成 chat-core.WzDecisionPayload（展示层）。
   *  两处字段口径完全对齐，只是所在层不同——服务端判定，前端展示。 */
  signal: WzDecisionSignal | null;
}

/**
 * 执行 LLM 分类。任何环节失败都静默降级返回空结果——绝不让用户因为 LLM 挂了看不到常规回答。
 * 客户端断开时通过 AbortController 同步取消上游请求。
 */
export async function runWzIntentClassifier(args: WzClassifierArgs): Promise<WzClassifierResult> {
  const empty: WzClassifierResult = { block: [], signal: null };
  if (!args.enabled) return empty;
  const userContent = typeof args.lastUser?.content === "string" ? args.lastUser.content : "";
  if (!userContent.trim()) return empty;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), WZ_CLASSIFIER_TIMEOUT_MS);
  const abortOnClient = () => ctrl.abort();
  if (args.signal) {
    if (args.signal.aborted) { clearTimeout(timeout); return empty; }
    args.signal.addEventListener("abort", abortOnClient, { once: true });
  }

  try {
    const base = args.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const url = `${base}/v1/chat/completions`;
    const resp = await undiciFetch(url, {
      method: "POST",
      dispatcher: args.agent ?? undefined,
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: WZ_INTENT_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        // 2026-09-27 换 Inception mercury-2 后实测：400 的预算会被它的内部 reasoning 全部吃光
        // （reasoning 296~388 token，正文回来 null、finish_reason=length），三条真问句里两条直接空转，
        // 决策信号静默降级成「没有决策卡」。抬到 1200 后同样三条问句全部 finish=stop 且 JSON 完整，
        // 单次 1.5~2.8s，仍在 6s 超时预算内。写推理预算的模型（thinking/reasoning 类）都吃这个亏，
        // 所以这里给的是「正文 + 思考」的总预算，不是正文预算。
        max_tokens: 1200,
      }),
    });
    if (!resp.ok) return empty;
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return empty;

    // 规则引擎判到的场景（通过 prevScene 传递，虽不完全准确但够用）
    const ruleScene = (args.prevScene && args.prevScene !== "general" && args.prevScene) || null;
    const parsed = parseWzDecisionLlmOutput(raw, ruleScene);
    if (!parsed.ok) return empty;
    return {
      block: renderWzDecisionBlock(parsed.signal),
      signal: parsed.signal,
    };
  } catch {
    return empty;
  } finally {
    clearTimeout(timeout);
    if (args.signal) args.signal.removeEventListener("abort", abortOnClient);
  }
}
