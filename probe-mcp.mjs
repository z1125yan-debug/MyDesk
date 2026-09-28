import fs from "node:fs";
const url = JSON.parse(fs.readFileSync("data/quant-config.json", "utf8")).mcp.url;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let sid = null;
async function rpc(obj) {
  const r = await fetch(url, { method: "POST", headers: { ...H, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(obj) });
  sid = r.headers.get("mcp-session-id") ?? sid;
  const t = await r.text();
  if (!t.trim()) return null;
  if (t.includes("data:")) {
    for (const l of t.split("\n")) if (l.startsWith("data:")) { try { return JSON.parse(l.slice(5).trim()); } catch {} }
  }
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
console.log("server:", init?.result?.serverInfo?.name ?? JSON.stringify(init).slice(0, 120));
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
let n = 2;
async function tool(name, args) {
  const r = await rpc({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name, arguments: { ...args, output_format: "json" } } });
  const c = r?.result?.content?.[0]?.text ?? "[]";
  try { const p = JSON.parse(c); return Array.isArray(p) ? p : p?.data ?? p?.rows ?? p; } catch { return String(c).slice(0, 200); }
}
for (const [label, tname] of [["income", "get_income_statement"], ["balance", "get_balance_sheet"], ["cashflow", "get_cash_flow"]]) {
  const rows = await tool(tname, { symbol: "601138" });
  console.log(`=== ${label} type=${Array.isArray(rows) ? "arr" + rows.length : typeof rows}`);
  if (Array.isArray(rows) && rows.length) {
    console.log("cols:", Object.keys(rows[0]).join(","));
    console.log(JSON.stringify(rows.slice(0, 2), null, 1).slice(0, 1500));
  } else console.log(JSON.stringify(rows).slice(0, 400));
}
