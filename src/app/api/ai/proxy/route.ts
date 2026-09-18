import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 通用境外 AI 代理：支持 OpenAI 兼容 / Anthropic 原生 / Gemini 原生
// Key 仅通过请求头传递，不落盘、不打日志
interface MsgIn {
  role: "user" | "assistant";
  content: string;
}

function timeoutFetch(url: string, init: RequestInit, ms = 45000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// 兼容 Base URL 填不填 /v1 的两种写法：https://api.xxx.com 与 https://api.xxx.com/v1 等价
function apiBase(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function callOpenAI(base: string, key: string, model: string, messages: MsgIn[]) {
  const url = apiBase(base) + "/v1/chat/completions";
  const res = await timeoutFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens: 2048 }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
  return json?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(base: string, key: string, model: string, messages: MsgIn[]) {
  const url = apiBase(base) + "/v1/messages";
  const res = await timeoutFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 2048, messages }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
  const parts = json?.content ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

async function callGemini(base: string, key: string, model: string, messages: MsgIn[]) {
  const url =
    `${apiBase(base)}/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(key)}`;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await timeoutFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}

export async function POST(req: NextRequest) {
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

    const { messages } = (await req.json()) as { messages: MsgIn[] };
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages 为空" }, { status: 400 });
    }

    let content = "";
    if (provider === "anthropic") {
      content = await callAnthropic(baseUrl, apiKey, model, messages);
    } else if (provider === "gemini") {
      content = await callGemini(baseUrl, apiKey, model, messages);
    } else {
      // openai / deepseek / moonshot / openrouter / ollama / custom 全部 OpenAI 兼容
      content = await callOpenAI(baseUrl, apiKey, model, messages);
    }

    if (!content) return NextResponse.json({ error: "上游未返回内容" }, { status: 502 });
    return NextResponse.json({ content });
  } catch (e) {
    const msg = (e as Error).message || "代理请求失败";
    // 超时提示更友好
    const friendly = /timeout|abort/i.test(msg) ? "连接上游超时（境外网络可能需要中转地址）" : msg;
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
}
