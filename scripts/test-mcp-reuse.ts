// TEST-ONLY: MCP 会话复用测速（3 只，同一 session 连续调用）。
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
let sessionId: string | null = null;
let nextId = 1;
async function post(body: Record<string, unknown>) {
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
  return jsonText ? JSON.parse(jsonText) : undefined;
}
const t0 = Date.now();
await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-test", version: "1.0" } } });
await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
console.log(`init in ${Date.now() - t0}ms`);
for (const code6 of ["000428", "000507", "000513"]) {
  const s = Date.now();
  const { json } = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "get_stock_value", arguments: { symbol: code6, output_format: "json" } } });
  const result = (json as { result?: Record<string, unknown> })?.result ?? {};
  const sc = (result as { structuredContent?: unknown }).structuredContent !== undefined
    ? (result as { structuredContent: unknown }).structuredContent
    : (() => { const t = (result as { content?: { text?: string }[] }).content?.[0]?.text; if (t === undefined) return null; try { return JSON.parse(t); } catch { return t; } })();
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(sc)) rows = sc as Record<string, unknown>[];
  else if (sc && typeof sc === "object" && typeof (sc as { result?: unknown }).result === "string") {
    try { const p = JSON.parse((sc as { result: string }).result); rows = Array.isArray(p) ? p : []; } catch { rows = []; }
  }
  const best = rows.reduce((a, r) => {
    const ms = typeof r["数据日期"] === "number" ? r["数据日期"] : -Infinity;
    const ams = a ? (typeof a["数据日期"] === "number" ? a["数据日期"] : -Infinity) : -Infinity;
    return ms > ams ? r : a;
  }, null as Record<string, unknown> | null);
  console.log(`${code6}: rows=${rows.length} floatShares=${best?.["流通股本"]} in ${Date.now() - s}ms`);
}
