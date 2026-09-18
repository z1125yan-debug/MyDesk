// 客户端 AI 调用辅助：所有请求走本地 /api/ai/proxy，
// Key 只放在请求头里转发给所选服务商，不写入数据库、不打印日志。
import type { AiProvider, AiSettings } from "./types";

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

export async function aiChat(
  ai: AiSettings,
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  opts?: { timeoutMs?: number }
): Promise<string> {
  const res = await fetch("/api/ai/proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-provider": ai.provider,
      "x-ai-base-url": ai.baseUrl,
      "x-ai-api-key": ai.apiKey,
      "x-ai-model": ai.model,
    },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string })?.error || `请求失败（${res.status}）`);
  return (json as { content?: string }).content ?? "";
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

// 智能助手统一系统提示词（各入口共用；context 为注入的实时行情快照文本）
export function assistantSystemPrompt(context: string): string {
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  return [
    "你是 MyDesk 个人工作台的智能助理：既懂行情分析，也能像正常 AI 一样回答生活、学习、写作等任何问题。",
    `今天是 ${today}。`,
    "",
    "【实时行情上下文】（来自本机直连的真实行情接口，视为当前事实）",
    context || "（本次会话暂未取得行情数据）",
    "",
    "【回答规则】",
    "1. 行情 / 持仓类问题：按「结论 → 结构 / 关键位 / 思路参考 / 风险提示」结构回答；价位只引用上下文数字，数量级必须一致；单位用「元」。",
    "2. 新闻类问题：优先引用【最新财经快讯】里的事实作答，注明「来自实时快讯」；快讯未覆盖的部分明确说明，不要编造。",
    "3. 宏观、政策类问题：知识有截止时间，先声明「基于历史公开信息，非实时数据」，再作答。",
    "4. 生活、学习、写作等一般问题：像正常 AI 一样自然、友好、详细地回答，不套用行情模板，不加投资风险提示。",
    "5. 简体中文，简洁 markdown；输出克制：最多一个表格，要点不超过 4 条。",
  ].join("\n");
}

// 价格数量级校验：回答里至少要有一个接近现价的数字，否则视为幻觉
export function priceBandOk(reply: string, price: number | null): boolean {
  if (!price || price <= 0) return true;
  const nums = [...reply.matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  return nums.some((v) => v >= price * 0.5 && v <= price * 1.5);
}
