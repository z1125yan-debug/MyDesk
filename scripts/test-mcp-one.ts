// TEST-ONLY: MCP get_stock_value 单只连通性测试（只读，不写生产缓存）。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
function loadEnv(): void {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* ignore */ }
}
loadEnv();
const mcpUrl = process.env.CHINA_STOCK_MCP_URL || process.env.QUANT_MCP_URL || "";
console.log("mcp configured:", !!mcpUrl);
const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
async function fetchOne(code6: string): Promise<Record<string, unknown>[]> {
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    const jsonText = text.startsWith("event:") || text.startsWith("data:")
      ? (text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "").replace(/^data:\s*/, "")
      : text;
    return { json: jsonText ? JSON.parse(jsonText) : undefined };
  };
  await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-test", version: "1.0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  const { json } = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "get_stock_value", arguments: { symbol: code6, output_format: "json" } } });
  const result = (json as { result?: Record<string, unknown> })?.result ?? {};
  const sc = (result as { structuredContent?: unknown }).structuredContent !== undefined
    ? (result as { structuredContent: unknown }).structuredContent
    : (() => { const t = (result as { content?: { text?: string }[] }).content?.[0]?.text; if (t === undefined) return null; try { return JSON.parse(t); } catch { return t; } })();
  if (Array.isArray(sc)) return sc as Record<string, unknown>[];
  if (sc && typeof sc === "object") {
    const obj = sc as Record<string, unknown>;
    if (typeof obj.result === "string") { try { const p = JSON.parse(obj.result); return Array.isArray(p) ? p : []; } catch { return []; } }
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  }
  return [];
}
const t0 = Date.now();
const rows = await fetchOne(process.argv[2] ?? "000301");
console.log(`rows=${rows.length} in ${Date.now() - t0}ms`);
let best: Record<string, unknown> | null = null;
let bestMs = -Infinity;
for (const r of rows) {
  const ms = numOr(r["数据日期"]);
  if (ms == null) continue;
  if (ms > bestMs) { bestMs = ms; best = r; }
}
console.log("best:", best ? { pe: best["PE(TTM)"], pb: best["市净率"], mv: best["总市值"], fmv: best["流通市值"], fs: best["流通股本"], date: best["数据日期"] } : null);
