// TEST-ONLY: 为扩大窗口池票补取流通股本（MCP get_stock_value，最新值，与 15 天跑同口径近似）。
// 单会话顺序调用，逐只追加写检查点文件（断点续跑跳过已取到的），只写 up-probability/valuation-expanded.json，
// 不碰生产缓存与 backtest-aipick/valuation.json。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const GOAL = "/home/hatch/workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files";
const OUT = path.join(GOAL, "up-probability", "valuation-expanded.json");

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
if (!mcpUrl) { console.error("no MCP URL"); process.exit(1); }

const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
let sessionId: string | null = null;
let nextId = 1;
async function post(body: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
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
  const envelope = jsonText ? JSON.parse(jsonText) as { result?: Record<string, unknown>; error?: { message?: string } } : {};
  return envelope;
}
async function initSession(): Promise<void> {
  sessionId = null;
  await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "backtest-mcp-fill", version: "1.0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
}
function unwrapRows(result: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!result) return [];
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
function parseRows(rows: Record<string, unknown>[]): { pe: number; pb: number; mktCap: number; floatShares: number | null } | null {
  let best: Record<string, unknown> | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const ms = numOr(r["数据日期"]);
    if (ms == null) continue;
    if (ms > bestMs) { bestMs = ms; best = r; }
  }
  if (!best) return null;
  const pe = numOr(best["PE(TTM)"]);
  const pb = numOr(best["市净率"]);
  const mv = numOr(best["总市值"]);
  const fmv = numOr(best["流通市值"]);
  if (pe == null || pb == null || mv == null || fmv == null || !(mv > 0) || !(fmv > 0)) return null;
  return { pe, pb, mktCap: mv, floatShares: numOr(best["流通股本"]) };
}

async function main(): Promise<void> {
  // 待取：扩大池里缺 floatShares 的 symbol
  const layer1 = JSON.parse(fs.readFileSync(path.join(GOAL, "up-probability", "layer1-expanded.json"), "utf-8")) as {
    days: { pool: { symbol: string }[] }[];
  };
  const poolSyms = new Set<string>();
  for (const d of layer1.days) for (const p of d.pool) poolSyms.add(p.symbol.toUpperCase());
  const known = new Set<string>();
  for (const p of [path.join(ROOT, "data", "valuation-cache.json"), path.join(GOAL, "backtest-aipick", "valuation.json")]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf-8")) as { entries?: Record<string, { floatShares?: number }> };
      const entries = v.entries ?? (v as unknown as Record<string, { floatShares?: number }>);
      for (const [k, e] of Object.entries(entries)) if (e?.floatShares) known.add(k.toUpperCase());
    } catch { /* ignore */ }
  }
  const existing: Record<string, { pe: number; pb: number; mktCap: number; floatShares: number | null }> =
    fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf-8")) : {};
  for (const k of Object.keys(existing)) known.add(k.toUpperCase());
  const missing = [...poolSyms].filter((s) => !known.has(s)).sort();
  console.log(`pool=${poolSyms.size} missing=${missing.length} existing_fill=${Object.keys(existing).length}`);
  if (!missing.length) { console.log("nothing to fetch"); return; }
  await initSession();
  let done = 0, failed = 0;
  for (const sym of missing) {
    const code6 = sym.split(".")[0];
    const t0 = Date.now();
    try {
      let env = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "get_stock_value", arguments: { symbol: code6, output_format: "json" } } });
      if (env.error) { // 会话可能过期，重建一次再试
        console.log(`[${sym}] session error, re-init: ${env.error.message}`);
        await initSession();
        env = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "get_stock_value", arguments: { symbol: code6, output_format: "json" } } });
      }
      const parsed = parseRows(unwrapRows(env.result));
      if (!parsed || parsed.floatShares == null) {
        console.log(`[${sym}] 无可用行（parsed=${JSON.stringify(parsed)}），记失败`);
        failed++;
      } else {
        existing[sym] = parsed;
        fs.writeFileSync(OUT, JSON.stringify(existing));
        done++;
        console.log(`[${sym}] floatShares=${parsed.floatShares} (${((Date.now() - t0) / 1000).toFixed(0)}s) done=${done} failed=${failed} left=${missing.length - done - failed}`);
      }
    } catch (e) {
      console.log(`[${sym}] 调用失败：${(e as Error).message}，记失败继续`);
      failed++;
      try { await initSession(); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`MCP fill done: ok=${done} failed=${failed} total=${missing.length}`);
}
main().catch((e) => { console.error("MCP FILL FAILED:", e); process.exit(1); });
