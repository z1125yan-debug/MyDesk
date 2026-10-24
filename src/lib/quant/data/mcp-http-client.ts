// Quant Research Lab — ModelScope china-stock-mcp 接入（streamable HTTP MCP 客户端，仅服务端）
// 协议：JSON-RPC over HTTP POST；会话经 Mcp-Session-Id 头维持；响应为 JSON（非 SSE）。
// 不修改现有 mcp-manager.ts（stdio 管理器）——这是 Quant Lab 私有的第二传输通道。
//
// 2026-10-16：增加可选 Bearer 鉴权（authToken），供长桥 MCP（OAuth 2.1，
// mcp.longbridge.cn）使用。china-stock-mcp 不传 authToken，行为不变。
export interface McpHttpOptions {
  url: string;
  timeoutMs?: number;
  clientName?: string;
  /** 可选：OAuth Bearer token（字符串或返回 token 的函数）。传了则每个请求带 Authorization 头。 */
  authToken?: string | (() => string | null);
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: {
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
    isError?: boolean;
    tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  };
  error?: { code: number; message: string };
}

export class McpHttpError extends Error {}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initPromise: Promise<void> | null = null;

  constructor(private opts: McpHttpOptions) {}

  /** 解析 Bearer token（字符串或函数返回值）；无 token 返回 null（不带 Authorization 头）。 */
  private authHeader(): string | null {
    const t = typeof this.opts.authToken === "function" ? this.opts.authToken() : this.opts.authToken;
    const token = typeof t === "string" ? t.trim() : "";
    return token ? `Bearer ${token}` : null;
  }

  private async raw(body: Record<string, unknown>): Promise<{ json?: JsonRpcResponse; sessionId: string | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60000);
    try {
      const res = await fetch(this.opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          ...(this.authHeader() ? { Authorization: this.authHeader() as string } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (res.status === 404) throw new McpHttpError("SESSION_EXPIRED");
      const text = await res.text();
      if (!res.ok) throw new McpHttpError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      // 兼容 SSE 单事件响应
      const jsonText = text.startsWith("event:") || text.startsWith("data:")
        ? (text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").replace(/^data:\s*/, "")
        : text;
      return { json: jsonText ? (JSON.parse(jsonText) as JsonRpcResponse) : undefined, sessionId: sid };
    } finally {
      clearTimeout(timer);
    }
  }

  async init(): Promise<void> {
    if (this.sessionId) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { json } = await this.raw({
          jsonrpc: "2.0", id: this.nextId++, method: "initialize",
          params: {
            protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: this.opts.clientName ?? "quant-lab", version: "1.0" },
          },
        });
        if (json?.error) throw new McpHttpError(`initialize 失败: ${json.error.message}`);
        await this.raw({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
      })().catch((e) => {
        this.initPromise = null; // 失败允许重试
        throw e;
      });
    }
    return this.initPromise;
  }

  // 带一次会话过期重试
  private async rpc(method: string, params: unknown): Promise<JsonRpcResponse["result"]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.init();
        const { json } = await this.raw({ jsonrpc: "2.0", id: this.nextId++, method, params });
        if (json?.error) throw new McpHttpError(json.error.message);
        return json?.result;
      } catch (e) {
        if (e instanceof McpHttpError && e.message === "SESSION_EXPIRED") {
          this.sessionId = null; // 重新握手后重试
          continue;
        }
        throw e;
      }
    }
    throw new McpHttpError("会话重试后仍失败");
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    const result = await this.rpc("tools/list", {});
    return result?.tools ?? [];
  }

  // 返回 structuredContent 优先，否则尝试把 content[0].text 解析为 JSON
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result?.isError) {
      const text = result.content?.[0]?.text ?? "tool 执行失败";
      throw new McpHttpError(text.slice(0, 500));
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.[0]?.text;
    if (text !== undefined) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return null;
  }
}
