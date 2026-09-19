import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 通用境外 AI 代理：支持 OpenAI 兼容 / Anthropic 原生 / Gemini 原生
// Key 仅通过请求头传递，不落盘、不打日志。
// 出网自动经本机代理（解决 CloudFront 等对中国 IP 的地域封锁）：
//   优先级 = 请求头 x-ai-proxy（设置页可填） > 环境变量（启动.bat 已设 HTTPS_PROXY）
//          > Windows 系统代理（注册表自动探测，缓存 5 分钟）
// 本机/内网上游（Ollama、局域网中转）始终直连。

interface MsgIn {
  role: "user" | "assistant";
  content: string;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

async function callAnthropic(base: string, key: string, model: string, messages: MsgIn[], agent: ProxyAgent | null) {
  const url = apiBase(base) + "/v1/messages";
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 2048, messages }),
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
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const res = await upstream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    },
    agent,
  );
  const json = await jsonOf(res);
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

    const agent = await resolveProxy(req, baseUrl);
    const via = agent ? "（已走本机代理）" : "（直连）";

    let content = "";
    if (provider === "anthropic") {
      content = await callAnthropic(baseUrl, apiKey, model, messages, agent);
    } else if (provider === "gemini") {
      content = await callGemini(baseUrl, apiKey, model, messages, agent);
    } else {
      // openai / deepseek / moonshot / openrouter / ollama / custom 全部 OpenAI 兼容
      content = await callOpenAI(baseUrl, apiKey, model, messages, agent);
    }

    if (!content) return NextResponse.json({ error: `上游未返回内容${via}` }, { status: 502 });
    return NextResponse.json({ content });
  } catch (e) {
    const raw = (e as Error).message || "代理请求失败";
    let msg = raw;
    if (/timeout|abort/i.test(raw)) msg = "连接上游超时（境外网络可能需要中转或代理）";
    else if (/\b403\b/.test(raw)) msg = "上游拒绝访问 403（地域限制未绕过，请检查代理是否可用）";
    else if (/\b401\b/.test(raw)) msg = "鉴权失败 401（请检查 API Key 与模型名是否匹配）";
    else if (/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR/i.test(raw))
      msg = "无法连接上游（本机代理未开或网络不通，可在设置里指定代理地址）";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
