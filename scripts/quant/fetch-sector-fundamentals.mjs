// 行业财务基本面聚合 —— 用户 2026-09-29 点题：「本地的 MCP 里面个股的都有」
// 用 china-stock-mcp 三表按行业成分股聚合出四分量真实数据：
//   earnings_yoy  = 归母净利润(累计)同比     ← get_income_statement.net_income_common_stock
//   orders_yoy    = 合同负债同比(订单前瞻)   ← get_balance_sheet.deferred_revenue
//   inventory_yoy = 存货同比                ← get_balance_sheet.inventory
//   capex_yoy     = 购建固定资产现金同比     ← get_cash_flow.capital_expenditure
// 采样：每行业市值前 8 名（tier 覆盖为主），行业值 = 市值加权均值；样本不足/分母异常 → 该分量 null（不硬编）。
// 财报是季度频率，本脚本手动/低频跑即可；输出 data/sector-fundamentals.json。
import fs from "node:fs";

const URL = JSON.parse(fs.readFileSync("data/quant-config.json", "utf8")).mcp.url;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const CONCUR = 3;
const TOP_N = 8;

let sid = null;
let seq = 1;
const pending = new Map();
function rpc(obj) {
  return new Promise((resolve, reject) => {
    const id = obj.id ?? null;
    fetch(URL, { method: "POST", headers: { ...H, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(obj) })
      .then(async (r) => {
        sid = r.headers.get("mcp-session-id") ?? sid;
        const t = await r.text();
        if (!t.trim()) return resolve(null);
        if (t.includes("data:")) {
          for (const l of t.split("\n")) if (l.startsWith("data:")) { try { return resolve(JSON.parse(l.slice(5).trim())); } catch {} }
        }
        try { resolve(JSON.parse(t)); } catch { resolve({ raw: t.slice(0, 200) }); }
      })
      .catch(reject);
    if (id != null) pending.set(id, { resolve, reject });
  });
}
async function tool(name, args) {
  const r = await rpc({ jsonrpc: "2.0", id: seq++, method: "tools/call", params: { name, arguments: { ...args, output_format: "json" } } });
  const c = r?.result?.content?.[0]?.text ?? "[]";
  try { const p = JSON.parse(c); return Array.isArray(p) ? p : p?.data ?? p?.rows ?? []; } catch { return []; }
}

const rowsByDateDesc = (arr) => [...arr].sort((a, b) => Number(b.report_date) - Number(a.report_date));
function yoyFromRows(rows, field) {
  const rs = rowsByDateDesc(rows).filter((r) => Number.isFinite(Number(r?.[field])));
  if (!rs.length) return { yoy: null, period: null };
  const latest = rs[0];
  const target = Number(latest.report_date);
  const prev = rs.find((r) => Math.abs(Number(r.report_date) - (target - 365 * 864e5)) < 20 * 864e5);
  const period = new Date(target).toISOString().slice(0, 10);
  if (!prev) return { yoy: null, period };
  const cur = Number(latest[field]);
  const base = Number(prev[field]);
  // 分母为负（扭亏/转亏）时同比无意义 → null
  if (!Number.isFinite(cur) || !Number.isFinite(base) || base === 0 || base < 0 || cur < 0) return { yoy: null, period };
  return { yoy: +(((cur / base - 1) * 100)).toFixed(1), period };
}

// 存货重要性：存货/总资产。服务型公司这个比例极小，同比是噪音，不该进解读和计分
function inventoryMateriality(rows) {
  const rs = rowsByDateDesc(rows).filter((r) => Number.isFinite(Number(r?.inventory)) && Number.isFinite(Number(r?.total_assets)) && Number(r.total_assets) > 0);
  if (!rs.length) return null;
  return +((Number(rs[0].inventory) / Number(rs[0].total_assets)) * 100).toFixed(2);
}

async function main() {
  const cons = JSON.parse(fs.readFileSync("data/sector-constituents.json", "utf8"));
  // 个股级缓存：财报是季度频率，重跑时跳过已拉过的股票（脚本改动/换季度时删掉缓存文件即可）
  const RAW_CACHE_PATH = "data/sector-fundamentals-raw.json";
  let rawCache = { generatedAt: new Date().toISOString(), stocks: {} };
  try { rawCache = JSON.parse(fs.readFileSync(RAW_CACHE_PATH, "utf8")); } catch {}
  const industries = cons.industries ?? {};
  const init = await rpc({ jsonrpc: "2.0", id: seq++, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sector-fundamentals", version: "1" } } });
  if (!init?.result) throw new Error("MCP initialize 失败");
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 每行业取市值前 N，构建任务池（同一股票只取一次，跨行业复用结果）
  const plans = {};
  const stockJobs = new Map();
  for (const [sector, info] of Object.entries(industries)) {
    const members = (info.members ?? []).slice().sort((a, b) => (b.mktCapYi ?? 0) - (a.mktCapYi ?? 0)).slice(0, TOP_N);
    plans[sector] = members;
    for (const m of members) if (!stockJobs.has(m.code)) stockJobs.set(m.code, m);
  }
  console.log(`行业 ${Object.keys(plans).length}，采样股票 ${stockJobs.size}，任务 ${stockJobs.size * 3} 条`);

  const results = {}; // code -> {earnings_yoy, orders_yoy, inventory_yoy, capex_yoy}
  const codes = [...stockJobs.keys()];
  let done = 0;
  async function worker() {
    while (codes.length) {
      const code = codes.shift();
      if (!code) break;
      const cached = rawCache.stocks[code];
      if (cached) { results[code] = cached; done++; continue; }
      const [inc, bal, cf] = await Promise.all([
        tool("get_income_statement", { symbol: code }),
        tool("get_balance_sheet", { symbol: code }),
        tool("get_cash_flow", { symbol: code }),
      ]);
      results[code] = {
        earnings: yoyFromRows(inc, "net_income_common_stock"),
        orders: yoyFromRows(bal, "deferred_revenue"),
        inventory: yoyFromRows(bal, "inventory"),
        inventory_ratio: inventoryMateriality(bal),
        capex: yoyFromRows(cf, "capital_expenditure"),
        fetchedAt: new Date().toISOString(),
      };
      rawCache.stocks[code] = results[code];
      done++;
      if (done % 40 === 0) {
        console.log(`  ${done}/${stockJobs.size} 股完成`);
        fs.writeFileSync(RAW_CACHE_PATH, JSON.stringify(rawCache));
      }
    }
  }
  await Promise.all(Array.from({ length: CONCUR }, worker));

  // 行业聚合：市值加权；period 取样本内最新报告期（引擎按 asOf 与报告期比较，防回放前视）
  const out = { generatedAt: new Date().toISOString(), source: "china-stock-mcp 三表（get_income_statement/get_balance_sheet/get_cash_flow）· 市值前8加权", frequency: "季度财报", sectors: {} };
  for (const [sector, members] of Object.entries(plans)) {
    let wsum = 0; const acc = { earnings: 0, orders: 0, inventory: 0, capex: 0, inventory_ratio: 0 }; const cnt = { earnings: 0, orders: 0, inventory: 0, capex: 0, inventory_ratio: 0 };
    let sampled = 0;
    for (const m of members) {
      const r = results[m.code];
      if (!r) continue;
      sampled++;
      const w = m.mktCapYi ?? 1;
      for (const k of ["earnings", "orders", "inventory", "capex"]) if (r[k]?.yoy != null) { acc[k] += r[k].yoy * w; cnt[k] += w; }
      if (r.inventory_ratio != null) { acc.inventory_ratio += r.inventory_ratio * w; cnt.inventory_ratio += w; }
    }
    const sectorOut = { sampled, total: members.length, inventory_ratio_pct: cnt.inventory_ratio > 0 ? +(acc.inventory_ratio / cnt.inventory_ratio).toFixed(2) : null };
    for (const k of ["earnings", "orders", "inventory", "capex"]) {
      sectorOut[`${k}_yoy`] = cnt[k] > 0 ? +(acc[k] / cnt[k]).toFixed(1) : null;
      sectorOut[`${k}_period`] = cnt[k] > 0 ? members.map((m) => results[m.code]?.[k]?.period).filter(Boolean).sort().slice(-1)[0] ?? null : null;
    }
    out.sectors[sector] = sectorOut;
  }
  fs.writeFileSync(RAW_CACHE_PATH, JSON.stringify(rawCache));
  fs.writeFileSync("data/sector-fundamentals.json", JSON.stringify(out, null, 2));
  const got = Object.values(out.sectors).filter((s) => s.earnings_yoy != null).length;
  console.log(`完成：${got}/${Object.keys(out.sectors).length} 行业有利润同比`);
  for (const s of ["消费电子", "贵金属", "半导体"]) console.log(s, JSON.stringify(out.sectors[s]));
}
main().catch((e) => { console.error(e); process.exit(1); });
