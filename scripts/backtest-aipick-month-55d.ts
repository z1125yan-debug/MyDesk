// TEST-ONLY: MyDesk AI 优选整月回测（统一口径，不写 StrategyPick，不改 .env，不碰生产缓存）。
//
// 流程与生产服务端自动优选一致（generateAiPickForDate 的 ① 路径，减去落库/版本化）：
//   layer1（当日档位 Top5 策略，DB 日K 现算命中，按成交额每策略取前 10）
//   → 富化（DB 日K + 估值 + 财联社当日新闻 + 巨潮当日公告；历史日 THS 主力 = null，不冒充）
//   → 确定性硬过滤 applyHardFilter（代码层第一道）
//   → 模型（deepseek-v4.1-flash，temperature 0.1，max_tokens 6000，超时 120s）
//   → narrowChoices（第二道硬过滤）
//   → 评估（两个口径，均与战绩/策略层一致）：
//     T+1：T+1 开盘买、T+2 开盘卖（持 1 日）；5 日：T+1 开盘买、T+6 开盘卖（持 5 日）。
//     均扣 0.41% 成本；胜率 = 跑赢上证同期涨跌。只看这两个口径，不加 10 天 / 1 个月。
//
// 诚实边界：
//   - 估值（PE/PB/市值/流通股本）来自 10-15 估值缓存 + MCP 最新值，不是“决策日当时”的时点值
//     （MCP 只给最新行）。回测里如实标注此为“最新值近似”，不冒充时点值。
//   - 历史日没有盘中快照（10:30/11:30），不重建、不冒充，统一用盘后日 K。
//   - 历史日 THS 主力、盘中新闻不存在 → null，不拿今天的数据冒充。
//   - 次日一字涨停买不进 / 停牌无行情的票直接剔除，不计 0 收益。
//
// 用法：
//   node --experimental-strip-types scripts/backtest-aipick-month.ts [--only D1,D2] [--reuse-model] [--no-model] [--out PATH]
//   --reuse-model：复用 /tmp/backtest-aipick/day-<D>.json 里的模型原始输出，跳过模型调用
//     （仅当改动在模型之后阶段——narrowChoices/评估——时可用；改了模型之前阶段则无效，必须重跑）。
//   --no-model：只跑到硬过滤，不调模型（冒烟测试 layer1 速度）。

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db.ts";
import {
  AI_PICK_MAX, applyHardFilter, buildAiPickPrompt, narrowChoices, parseAiPickResponse,
  type AiPickCandidate,
} from "../src/lib/quant/strategy/ai-pick-core.ts";
import { regimeSeriesOf, type Regime } from "../src/lib/quant/strategy/regime-core.ts";
import { strategyLibrary } from "../src/lib/quant/data/strategy-library.ts";
import { FACTOR_FIELD_MAP, limitRatio, type BarsLike } from "../src/lib/quant/factors/fields.ts";
import { condKeyOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { scanHitsOnDate, topByAmountOf, type HitRow } from "../src/lib/quant/strategy/hit-scan-core.ts";
import { rpsSeedOf } from "../src/lib/quant/data/rps-seed.ts";
import { fetchClsDayItems, type ClsDayItem } from "../src/lib/desk/cls-telegraph.ts";
import {
  fetchCninfoStockAnnouncements, reductionPlainLine, reductionRiskOf,
} from "../src/lib/desk/cninfo.ts";
// 注意：不 import 生产 mcp-provider.ts——它内部 import "./mcp-http-client"（无后缀），
// 在 node --experimental-strip-types 下跑不起来。这里用最小 JSON-RPC 直调 MCP，
// 与生产 callTool("get_stock_value", { symbol, output_format: "json" }) 同口径。
import { getServerLlm } from "../src/lib/llm/model-config.ts";

const ROOT = process.cwd();
// 持久目录：VM 随时可能重启，/tmp 会清。所有回测输出写 goal hidden_files，做到断点续跑。
const CACHE_DIR = "/home/hatch/workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/backtest-aipick";
const COST = 0.41; // %，往返：佣金 0.03 + 印花税(卖) 0.05 + 滑点 0.10 + 点差 0.10
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);
const CHUNK = 120;

/** 读 .env（只读，不打印值），注入 process.env（不覆盖已有变量）。 */
function loadEnv(): void {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1];
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* 无 .env 则靠现成 env */ }
}

interface ChatMsg { role: "system" | "user" | "assistant"; content: string }

async function callServerChat(
  channel: { baseUrl: string; apiKey: string; model: string },
  messages: ChatMsg[],
  ms: number,
): Promise<string> {
  const base = channel.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify({ model: channel.model, messages, temperature: 0.1, max_tokens: 6000 }),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
    if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
    return json?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 最小 MCP 直调：initialize → tools/call(get_stock_value) → unwrapRows（与生产同口径）。 */
async function fetchMcpStockValueLocal(mcpUrl: string, code6: string): Promise<Record<string, unknown>[]> {
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (body: Record<string, unknown>): Promise<{ json?: { result?: Record<string, unknown>; error?: { message?: string } }; sid: string | null }> => {
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
    return { json: jsonText ? (JSON.parse(jsonText) as { result?: Record<string, unknown>; error?: { message?: string } }) : undefined, sid };
  };
  await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "backtest-aipick", version: "1.0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  const { json } = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "get_stock_value", arguments: { symbol: code6, output_format: "json" } } });
  if (json?.error) throw new Error(json.error.message ?? "MCP tool error");
  const result = json?.result ?? {};
  if ((result as { isError?: boolean }).isError) throw new Error("MCP tool isError");
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
function parseStockValueRows(rows: Record<string, unknown>[]): { pe: number; pb: number; mktCap: number; floatShares: number | null } | null {
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

/** matchNewsFor：与生产 ai-pick-generate.ts 同口径（标题匹配），逐字复制逻辑。 */
function matchNewsFor(name: string, sector: string | null | undefined, concept: string | null | undefined, items: ClsDayItem[]): string {
  const stockHits: string[] = [];
  const sectorHits: string[] = [];
  const keywords = new Set<string>();
  const SECTOR_ALIAS: Record<string, string> = { "医药生物": "医药", "基础化工": "化工", "建筑材料": "建材" };
  const GENERIC_CONCEPT = new Set([
    "高股息精选", "超级品牌", "证金持股", "MSCI中国", "富时罗素",
    "国企改革", "创投", "老字号", "数字经济", "互联网金融", "消费金融",
    "绿色电力", "养老概念", "海峡两岸", "人工智能", "华为概念", "鸿蒙概念",
    "DeepSeek概念", "AIGC概念", "虚拟数字人", "抖音小店", "共同富裕示范区",
    "长三角一体化", "西部大开发", "三胎概念", "网红经济", "无线耳机",
    "人民币贬值受益", "参股民营银行", "小额贷款", "医药电商", "猴痘概念",
    "保健品", "快递", "智能医疗", "足球概念", "拼多多概念",
  ]);
  if (sector) {
    for (const segRaw of sector.split(/[-|]/)) {
      const seg = segRaw.trim().replace(/[ⅠⅡⅢⅣ]+$/g, "");
      if (seg.length < 2 || seg === "电子") continue;
      keywords.add(seg);
      const alias = SECTOR_ALIAS[seg];
      if (alias) keywords.add(alias);
    }
  }
  if (concept) {
    for (const term of concept.split(/[,，、]/)) {
      const t = term.trim().replace(/概念$/, "");
      if (t.length >= 2 && !GENERIC_CONCEPT.has(term.trim()) && !GENERIC_CONCEPT.has(t)) keywords.add(t);
    }
  }
  for (const it of items) {
    const title = (it as { title: string }).title;
    if (name && name.length >= 2 && title.includes(name)) {
      if (stockHits.length < 2) stockHits.push(`个股新闻：${title}（${(it as { time: string }).time}）`);
      continue;
    }
    if (sectorHits.length < 1) {
      for (const kw of keywords) {
        if (title.includes(kw)) {
          sectorHits.push(`板块新闻：${title}（${(it as { time: string }).time}）`);
          break;
        }
      }
    }
    if (stockHits.length >= 2 && sectorHits.length >= 1) break;
  }
  return [...stockHits, ...sectorHits].join("；");
}

function blockReasonOf(conds: readonly { field?: string }[]): string | null {
  const snapshot: string[] = [];
  const pending: string[] = [];
  for (const c of conds) {
    const field = String(c.field ?? "");
    const def = FACTOR_FIELD_MAP.get(field);
    if (!def) { pending.push(field || "空字段"); continue; }
    if (def.implemented === false) pending.push(def.zh);
    else if ((def as { source?: string }).source === "snapshot") snapshot.push(def.zh);
  }
  const parts: string[] = [];
  if (snapshot.length) parts.push(`条件含当日快照字段「${[...new Set(snapshot)].join("、")}」，历史K线算不出`);
  if (pending.length) parts.push(`条件含未实现因子「${[...new Set(pending)].join("、")}」`);
  return parts.length ? parts.join("；") : null;
}

interface DayResult {
  decisionDate: string;
  regime: Regime | null;
  regimeNote: string;
  barsUsed: number;
  layer1ByStrategy: { id: number; name: string; hits: number; kept: number; blockedReason: string | null }[];
  layer1Count: number;
  enrichedCount: number;
  hardRejected: { symbol: string; reason: string }[];
  filteredCount: number;
  modelRaw: string | null;
  modelError: string | null;
  picks: string[];
  eval: { symbol: string; buyOpen: number; sellOpen: number; net: number; sseChg: number | null; win: boolean | null }[];
  skipped: { symbol: string; reason: string }[];
  avgNet: number | null;
  sseChg: number | null;
  winCount: number;
  winRate: number | null;
  // 5 日口径：T+1 开盘买、T+6 开盘卖（持 5 日），其余同 T+1 口径
  eval5: { symbol: string; buyOpen: number; sellOpen: number; net: number; sseChg: number | null; win: boolean | null }[];
  skipped5: { symbol: string; reason: string }[];
  avgNet5: number | null;
  sseChg5: number | null;
  winCount5: number;
  winRate5: number | null;
  t6Day: string | null;
  notes: string[];
}

interface ValEntry { pe: number; pb: number; mktCap: number; floatShares: number | null }

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const argVal = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const onlyArg = argVal("--only");
  const reuseModel = args.includes("--reuse-model");
  const noModel = args.includes("--no-model");
  const outPath = argVal("--out") ?? path.join(CACHE_DIR, `results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // --- 交易日轴（全市场行数 >=1000 的才算交易日） ---
  const dayRows = await db.$queryRawUnsafe<{ tradeDate: string; n: number }[]>(
    `SELECT tradeDate, COUNT(*) AS n FROM stock_daily_bar GROUP BY tradeDate HAVING n >= 1000 ORDER BY tradeDate ASC`,
  );
  const allDays = dayRows.map((r) => r.tradeDate);
  const tradingDays = allDays.filter((d) => d >= "2026-07-22" && d <= "2026-10-16");
  // 决策日：T+1、T+2 都在轴上（T+2 最晚 10-16）
  const decisionDays = tradingDays.filter((d) => {
    const i = tradingDays.indexOf(d);
    return i >= 0 && i + 2 < tradingDays.length;
  });
  const onlySet = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const days = onlySet ? decisionDays.filter((d) => onlySet.has(d)) : decisionDays;
  console.log(`交易日轴 ${tradingDays[0]}..${tradingDays[tradingDays.length - 1]}（${tradingDays.length} 天），决策日 ${days.join(",")}`);

  // --- 上证 160 根日K（TDX）→ 逐日档位 ---
  const tdxRes = await fetch("http://127.0.0.1:8756/rpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "bars.get", params: { code: "sh000001", period: "day", count: 160 } }),
  });
  const tdxJson = (await tdxRes.json()) as { ok?: boolean; result?: { bars?: { time: string; close: number; open: number }[] } };
  const sseBars = tdxJson?.result?.bars ?? [];
  const sseDates = sseBars.map((b) => String(b.time).slice(0, 10));
  const sseCloses = sseBars.map((b) => Number(b.close));
  // 上证基准用 TDX 日 K 的开盘价：库内 stock_daily_bar 根本没有 000001.SH 的行
  // （查过：DB 只有 399001.SZ 深证成指，没有上证指数），DB 查基准永远 null。
  // 用 TDX 同源数据做基准，不拿个股数据冒充；TDX 取不到某日开盘则基准 null，win 也记 null（不算输）。
  const sseOpenByDate = new Map<string, number>();
  for (const b of sseBars) {
    const o = Number(b.open);
    if (Number.isFinite(o)) sseOpenByDate.set(String(b.time).slice(0, 10), o);
  }
  const sseRegimes = regimeSeriesOf(sseCloses);
  const regimeOf = new Map<string, Regime | null>();
  sseDates.forEach((d, i) => regimeOf.set(d, sseRegimes[i] ?? null));
  console.log(`上证 TDX ${sseBars.length} 根，档位可算到 ${sseDates[sseDates.length - 1]}`);

  // --- 档位 Top5（strategy-regime.json 的 rank 顺序即生产口径） ---
  const rankJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategy-regime.json"), "utf-8")) as {
    rank: Record<string, { id: number; name: string }[]>;
  };
  const lib = strategyLibrary();
  const byId = new Map(lib.map((s) => [s.id, s]));

  // --- 估值：生产缓存只读 + MCP 补取（补取写 /tmp 自有缓存，不碰生产缓存） ---
  const prodCache = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "valuation-cache.json"), "utf-8")) as {
    entries: Record<string, ValEntry>;
  };
  const tmpValPath = path.join(CACHE_DIR, "valuation.json");
  const tmpVal: Record<string, ValEntry> = fs.existsSync(tmpValPath)
    ? (JSON.parse(fs.readFileSync(tmpValPath, "utf-8")) as Record<string, ValEntry>)
    : {};
  const mcpUrl = process.env.CHINA_STOCK_MCP_URL || process.env.QUANT_MCP_URL || "";
  const valCache = new Map<string, ValEntry>();
  for (const [k, v] of Object.entries(prodCache.entries ?? {})) valCache.set(k.toUpperCase(), v);
  for (const [k, v] of Object.entries(tmpVal)) valCache.set(k.toUpperCase(), v);
  const getVal = async (symbol: string): Promise<ValEntry | null> => {
    const key = symbol.toUpperCase();
    const hit = valCache.get(key);
    if (hit) return hit;
    if (!mcpUrl) return null;
    try {
      const code6 = symbol.split(".")[0];
      await new Promise((r) => setTimeout(r, 200)); // 与生产 cachedMcpRows 节流同口径
      const rows = await fetchMcpStockValueLocal(mcpUrl, code6);
      const parsed = parseStockValueRows(rows as Record<string, unknown>[]);
      if (!parsed || parsed.floatShares == null) return null;
      const entry: ValEntry = { pe: parsed.pe, pb: parsed.pb, mktCap: parsed.mktCap, floatShares: parsed.floatShares };
      valCache.set(key, entry);
      tmpVal[key] = entry;
      fs.writeFileSync(tmpValPath, JSON.stringify(tmpVal));
      return entry;
    } catch {
      return null;
    }
  };

  const llm = getServerLlm();
  console.log(`模型通道 available=${llm.available} model=${llm.available ? llm.channel.model : llm.reason}`);

  const results: DayResult[] = [];
  for (const D of days) {
    const t0 = Date.now();
    const notes: string[] = [];
    const cachePath = path.join(CACHE_DIR, `day-${D}.json`);
    const cached = fs.existsSync(cachePath) ? (JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Partial<DayResult> & { modelRaw?: string | null }) : null;
    const regime = regimeOf.get(D) ?? null;
    const di = tradingDays.indexOf(D);
    const t1Day = tradingDays[di + 1];
    const t2Day = tradingDays[di + 2];
    const t6Day = di + 6 < tradingDays.length ? tradingDays[di + 6] : null;
    if (!regime) {
      results.push({ decisionDate: D, regime: null, regimeNote: "档位算不出（上证 MA20 不足 20 根或方向判不出）", barsUsed: 0, layer1ByStrategy: [], layer1Count: 0, enrichedCount: 0, hardRejected: [], filteredCount: 0, modelRaw: null, modelError: "档位 null，跳过", picks: [], eval: [], skipped: [], avgNet: null, sseChg: null, winCount: 0, winRate: null, eval5: [], skipped5: [], avgNet5: null, sseChg5: null, winCount5: 0, winRate5: null, t6Day: null, notes: ["档位 null，跳过"] });
      console.log(`[${D}] 档位 null，跳过`);
      continue;
    }
    const top5 = (rankJson.rank[regime] ?? []).slice(0, 5);
    console.log(`[${D}] 档位=${regime} Top5=${top5.map((s) => s.id).join(",")}`);

    // --- layer1：DB 日K 现算命中 ---
    const universeRows = await db.$queryRawUnsafe<{ symbol: string }[]>(
      `SELECT symbol FROM stock_daily_bar WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol ASC`, D,
    );
    const universe = universeRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));
    const barRows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[]>(
      `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar WHERE tradeDate <= ? ORDER BY symbol ASC, tradeDate ASC`, D,
    );
    const barsBySym = new Map<string, BarsLike[]>();
    for (const r of barRows) {
      const arr = barsBySym.get(r.symbol) ?? [];
      arr.push({ date: r.tradeDate, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, amount: r.amount });
      barsBySym.set(r.symbol, arr);
    }
    const barsUsed = new Set(barRows.map((r) => r.tradeDate)).size;
    const stratInfo = top5.map((s) => {
      const st = byId.get(s.id);
      const conds = (st?.conds ?? []) as { field?: string }[];
      return { id: s.id, name: s.name, conds: conds.map((c) => ({ ...c, key: condKeyOf(c as never) }) as unknown as MatCond), blocked: conds.length ? blockReasonOf(conds) : "这条策略没有条件，无从算命中" };
    });
    // 与生产 pick-symbol-collect.ts 同口径：先按策略累积全市场命中，分块只是读数方式；
    // 全部块读完后，再按策略全局按成交额取前 10（不是每块各取 10）。
    const layer1ByStrategy: DayResult["layer1ByStrategy"] = [];
    const candMap = new Map<string, AiPickCandidate>();
    const hitsByStrategy = new Map<number, HitRow[]>();
    for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
      const chunk = universe.slice(c0, c0 + CHUNK);
      const syms = chunk.filter((s) => (barsBySym.get(s)?.length ?? 0) > 0);
      const barsList = syms.map((s) => barsBySym.get(s) as BarsLike[]);
      for (const si of stratInfo) {
        if (si.blocked) continue;
        const hits = scanHitsOnDate({ syms, barsList, conds: si.conds, targetDate: D });
        const rec = layer1ByStrategy.find((x) => x.id === si.id) ?? { id: si.id, name: si.name, hits: 0, kept: 0, blockedReason: null };
        rec.hits += hits.length;
        if (!layer1ByStrategy.find((x) => x.id === si.id)) layer1ByStrategy.push(rec);
        if (!hits.length) continue;
        const arr = hitsByStrategy.get(si.id) ?? [];
        arr.push(...hits);
        hitsByStrategy.set(si.id, arr);
      }
    }
    for (const si of stratInfo) {
      if (si.blocked) continue;
      const top = topByAmountOf(hitsByStrategy.get(si.id) ?? [], 10);
      const rec = layer1ByStrategy.find((x) => x.id === si.id);
      if (rec) rec.kept = top.length;
      for (const h of top) {
        const key = h.symbol.toUpperCase();
        if (!candMap.has(key)) candMap.set(key, { symbol: h.symbol, name: "", close: h.close ?? null, strategy: si.name });
      }
    }
    for (const si of stratInfo) {
      if (si.blocked && !layer1ByStrategy.find((x) => x.id === si.id)) {
        layer1ByStrategy.push({ id: si.id, name: si.name, hits: 0, kept: 0, blockedReason: si.blocked });
      }
    }
    const rawCands = [...candMap.values()];
    console.log(`[${D}] layer1=${rawCands.length} 只（${layer1ByStrategy.map((x) => `${x.id}:${x.kept}${x.blockedReason ? "( blocked)" : ""}`).join(" ")}），K线 ${barsUsed} 根`);

    // --- 富化 ---
    const barMap = new Map<string, { close: number; volume: number; amount: number }>();
    const prevMap = new Map<string, number>();
    {
      const inList = rawCands.map(() => "?").join(",");
      if (rawCands.length) {
        const rows = await db.$queryRawUnsafe<{ symbol: string; close: number; volume: number; amount: number }[]>(
          `SELECT symbol, close, volume, amount FROM stock_daily_bar WHERE tradeDate = ? AND adjust = 'qfq' AND symbol IN (${inList})`, D, ...rawCands.map((c) => c.symbol),
        );
        for (const r of rows) barMap.set(String(r.symbol).toUpperCase(), { close: Number(r.close), volume: Number(r.volume), amount: Number(r.amount) });
        const prevRows = await db.$queryRawUnsafe<{ symbol: string; close: number }[]>(
          `SELECT symbol, close FROM stock_daily_bar WHERE tradeDate = (SELECT MAX(tradeDate) FROM stock_daily_bar WHERE tradeDate < ?) AND adjust = 'qfq' AND symbol IN (${inList})`, D, ...rawCands.map((c) => c.symbol),
        );
        for (const r of prevRows) prevMap.set(String(r.symbol).toUpperCase(), Number(r.close));
      }
    }
    let dayNews: ClsDayItem[] | null = null;
    try { dayNews = await fetchClsDayItems(D); } catch { dayNews = null; }
    let annMap: Map<string, { lines: string }> | null = null;
    let redMap: Map<string, string> | null = null;
    try {
      const raw = await fetchCninfoStockAnnouncements(rawCands.map((c) => c.symbol), D);
      annMap = new Map();
      redMap = new Map();
      for (const [code, anns] of raw) {
        const lines = anns.map((a) => `${(a as { type: string }).type}：${(a as { title: string }).title}`).join("；");
        annMap.set(code, { lines });
        const reds = anns.map((a) => reductionRiskOf(a as never)).filter((r): r is NonNullable<typeof r> => !!r);
        redMap.set(code, reds.map((r) => reductionPlainLine(r)).join("；"));
      }
    } catch { annMap = null; redMap = null; }
    const enriched: AiPickCandidate[] = [];
    for (const c of rawCands) {
      const key = c.symbol.toUpperCase();
      const seed = rpsSeedOf(c.symbol);
      const name = c.name || seed?.name || "";
      const sector = seed?.sector || null;
      const bar = barMap.get(key);
      const prevClose = prevMap.get(key);
      const close = typeof c.close === "number" && Number.isFinite(c.close) ? c.close : bar?.close ?? null;
      const changePct = close != null && prevClose != null && prevClose !== 0 ? ((close - prevClose) / Math.abs(prevClose)) * 100 : null;
      const amountYi = bar ? bar.amount / 1e8 : null;
      const val = await getVal(c.symbol);
      const turnoverPct = bar && val && val.floatShares != null && val.floatShares > 0 && bar.volume > 0 ? (bar.volume / val.floatShares) * 100 : null;
      const news = dayNews == null ? null : matchNewsFor(name, sector, seed?.concept, dayNews);
      const annKey = key.replace(/\.(SH|SZ|BJ)$/i, "");
      const announcements = annMap == null ? null : (annMap.get(annKey)?.lines ?? "");
      const reductionRisk = redMap == null ? null : (redMap.get(annKey) ?? "");
      enriched.push({
        ...c, name, sector, close, changePct, amountYi,
        pe: val?.pe ?? null, pb: val?.pb ?? null, mktCapYi: val ? val.mktCap / 1e8 : null,
        fundNetYi: null, superNetYi: null, midNetYi: null, smallNetYi: null, // 历史日 THS = null，不冒充
        turnoverPct, news, announcements, reductionRisk,
      });
    }
    console.log(`[${D}] 富化 ${enriched.length} 只，新闻 ${dayNews == null ? "未取到" : `${dayNews.length} 条`}，估值缺失 ${enriched.filter((c) => c.pe == null).length} 只`);

    // --- 硬过滤 → 模型 → 第二道 ---
    const { kept: filteredCands, rejected: hardRejected } = applyHardFilter(enriched);
    let modelRaw: string | null = null;
    let modelError: string | null = null;
    let picks: AiPickCandidate[] = [];
    if (!filteredCands.length) {
      modelError = `硬过滤后无候选（${enriched.length} 只全被拦）`;
    } else if (noModel) {
      modelError = "--no-model：未调模型";
    } else if (reuseModel && cached?.modelRaw) {
      modelRaw = cached.modelRaw;
      const choices = parseAiPickResponse(modelRaw);
      picks = choices ? narrowChoices(choices, filteredCands, AI_PICK_MAX) : [];
      notes.push("模型输出复用缓存（未重调）");
    } else {
      if (!llm.available) {
        modelError = `未配置服务端模型通道（${llm.reason}）`;
      } else {
        try {
          modelRaw = await callServerChat(
            llm.channel,
            [{ role: "system", content: "你是 A 股量化工作台的 AI优选环节，只输出 JSON，绝不解释。" }, { role: "user", content: buildAiPickPrompt(filteredCands, D, AI_PICK_MAX) }],
            120_000,
          );
          const choices = parseAiPickResponse(modelRaw);
          if (!choices) modelError = "模型没返回可解析的优选清单";
          else picks = narrowChoices(choices, filteredCands, AI_PICK_MAX);
        } catch (e) {
          modelError = `模型调用失败：${(e as Error).message}`;
        }
      }
    }
    console.log(`[${D}] 过滤后 ${filteredCands.length} 只（拦 ${hardRejected.length}），模型选 ${picks.length} 只${modelError ? `（${modelError}）` : ""}`);

    // --- 评估：T+1 开盘买、T+2 开盘卖、扣 0.41% ---
    const evalRows: DayResult["eval"] = [];
    const skipped: DayResult["skipped"] = [];
    let sseChg: number | null = null;
    {
      const o1 = sseOpenByDate.get(t1Day) ?? null;
      const o2 = sseOpenByDate.get(t2Day) ?? null;
      if (o1 != null && o2 != null) sseChg = ((o2 - o1) / o1) * 100;
    }
    for (const p of picks) {
      const sym = p.symbol.toUpperCase();
      const bD = await db.$queryRawUnsafe<{ open: number; close: number }[]>(`SELECT open, close FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, p.symbol, D);
      const bT1 = await db.$queryRawUnsafe<{ open: number }[]>(`SELECT open FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, p.symbol, t1Day);
      const bT2 = await db.$queryRawUnsafe<{ open: number }[]>(`SELECT open FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, p.symbol, t2Day);
      const dClose = bD[0]?.close ?? p.close ?? null;
      const buy = bT1[0]?.open ?? null;
      const sell = bT2[0]?.open ?? null;
      if (dClose == null || buy == null || sell == null) { skipped.push({ symbol: sym, reason: "T+1/T+2 无行情（停牌或无 bar），剔除" }); continue; }
      const seed = rpsSeedOf(p.symbol);
      const nm = p.name || seed?.name || "";
      const lim = limitRatio(sym, nm);
      if (!/^[NC]/.test(nm) && buy >= dClose * (1 + lim) - 1e-9) { skipped.push({ symbol: sym, reason: `T+1 开盘一字涨停（${buy} >= ${dClose}×${1 + lim}），买不进，剔除` }); continue; }
      const net = ((sell - buy) / buy) * 100 - COST;
      evalRows.push({ symbol: sym, buyOpen: buy, sellOpen: sell, net, sseChg, win: sseChg != null ? net > sseChg : null });
    }
    const avgNet = evalRows.length ? evalRows.reduce((s, r) => s + r.net, 0) / evalRows.length : null;
    const winCount = evalRows.filter((r) => r.win === true).length;
    const winDenom = evalRows.filter((r) => r.win != null).length;
    const winRate = winDenom ? (winCount / winDenom) * 100 : null;
    console.log(`[${D}] 评估 ${evalRows.length} 只（剔 ${skipped.length}），平均净 ${avgNet?.toFixed(2) ?? "—"}%，上证同期 ${sseChg?.toFixed(2) ?? "—"}%，胜率 ${winRate?.toFixed(0) ?? "—"}%（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

    // --- 评估 5 日：T+1 开盘买、T+6 开盘卖（持 5 日），其余同 T+1 口径 ---
    // 独立于 T+1 评估：T+2 无行情的票仍可算 5 日（只要 T+6 有行情），反之亦然。
    const eval5Rows: DayResult["eval5"] = [];
    const skipped5: DayResult["skipped5"] = [];
    let sseChg5: number | null = null;
    if (t6Day) {
      const o1 = sseOpenByDate.get(t1Day) ?? null;
      const o6 = sseOpenByDate.get(t6Day) ?? null;
      if (o1 != null && o6 != null) sseChg5 = ((o6 - o1) / o1) * 100;
      for (const p of picks) {
        const sym = p.symbol.toUpperCase();
        const bD = await db.$queryRawUnsafe<{ open: number; close: number }[]>(`SELECT open, close FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, p.symbol, D);
        const bT1 = await db.$queryRawUnsafe<{ open: number }[]>(`SELECT open FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, p.symbol, t1Day);
        const bT6 = await db.$queryRawUnsafe<{ open: number }[]>(`SELECT open FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, p.symbol, t6Day);
        const dClose = bD[0]?.close ?? p.close ?? null;
        const buy = bT1[0]?.open ?? null;
        const sell = bT6[0]?.open ?? null;
        if (dClose == null || buy == null || sell == null) { skipped5.push({ symbol: sym, reason: "T+1/T+6 无行情（停牌或无 bar），剔除" }); continue; }
        const seed = rpsSeedOf(p.symbol);
        const nm = p.name || seed?.name || "";
        const lim = limitRatio(sym, nm);
        if (!/^[NC]/.test(nm) && buy >= dClose * (1 + lim) - 1e-9) { skipped5.push({ symbol: sym, reason: `T+1 开盘一字涨停（${buy} >= ${dClose}×${1 + lim}），买不进，剔除` }); continue; }
        const net = ((sell - buy) / buy) * 100 - COST;
        eval5Rows.push({ symbol: sym, buyOpen: buy, sellOpen: sell, net, sseChg: sseChg5, win: sseChg5 != null ? net > sseChg5 : null });
      }
    } else {
      notes.push("T+6 超出交易日轴，5 日评估跳过");
    }
    const avgNet5 = eval5Rows.length ? eval5Rows.reduce((s, r) => s + r.net, 0) / eval5Rows.length : null;
    const winCount5 = eval5Rows.filter((r) => r.win === true).length;
    const winDenom5 = eval5Rows.filter((r) => r.win != null).length;
    const winRate5 = winDenom5 ? (winCount5 / winDenom5) * 100 : null;
    console.log(`[${D}] 5日评估 ${eval5Rows.length} 只（剔 ${skipped5.length}），平均净 ${avgNet5?.toFixed(2) ?? "—"}%，上证同期 ${sseChg5?.toFixed(2) ?? "—"}%，胜率 ${winRate5?.toFixed(0) ?? "—"}%`);

    const dayResult: DayResult = {
      decisionDate: D, regime, regimeNote: "", barsUsed, layer1ByStrategy,
      layer1Count: rawCands.length, enrichedCount: enriched.length,
      hardRejected: hardRejected.map((x) => ({ symbol: x.symbol, reason: x.reason })),
      filteredCount: filteredCands.length, modelRaw, modelError,
      picks: picks.map((p) => p.symbol), eval: evalRows, skipped, avgNet, sseChg, winCount, winRate,
      eval5: eval5Rows, skipped5, avgNet5, sseChg5, winCount5, winRate5, t6Day, notes,
    };
    fs.writeFileSync(cachePath, JSON.stringify({ ...dayResult, enriched, filteredSymbols: filteredCands.map((c) => c.symbol) }, null, 2));
    results.push(dayResult);
  }

  const evaluated = results.filter((r) => r.eval.length > 0);
  const allEval = evaluated.flatMap((r) => r.eval.map((e) => ({ ...e, date: r.decisionDate, regime: r.regime })));
  const evaluated5 = results.filter((r) => r.eval5.length > 0);
  const allEval5 = evaluated5.flatMap((r) => r.eval5.map((e) => ({ ...e, date: r.decisionDate, regime: r.regime })));
  const byRegimeFn = (rows: { date: string; regime: Regime | null; net: number; win: boolean | null }[]) =>
    (["强势", "震荡", "弱势"] as Regime[]).map((reg) => {
      const rr = rows.filter((r) => r.regime === reg);
      const wd = rr.filter((r) => r.win != null);
      return { regime: reg, days: new Set(rr.map((r) => r.date)).size, picks: rr.length, avgNet: rr.length ? rr.reduce((s, r) => s + r.net, 0) / rr.length : null, winRate: wd.length ? (wd.filter((r) => r.win === true).length / wd.length) * 100 : null };
    });
  const summary = {
    days: results.length,
    evaluatedDays: evaluated.length,
    totalPicks: allEval.length,
    avgNet: allEval.length ? allEval.reduce((s, r) => s + r.net, 0) / allEval.length : null,
    winRate: (() => { const w = allEval.filter((r) => r.win != null); return w.length ? (w.filter((r) => r.win === true).length / w.length) * 100 : null; })(),
    evaluatedDays5: evaluated5.length,
    totalPicks5: allEval5.length,
    avgNet5: allEval5.length ? allEval5.reduce((s, r) => s + r.net, 0) / allEval5.length : null,
    winRate5: (() => { const w = allEval5.filter((r) => r.win != null); return w.length ? (w.filter((r) => r.win === true).length / w.length) * 100 : null; })(),
    byRegime: byRegimeFn(allEval),
    byRegime5: byRegimeFn(allEval5),
    caveats: [
      "估值（PE/PB/市值/流通股本）为 10-15 缓存 + MCP 最新值，不是决策日时点值（MCP 只给最新行），属最新值近似。",
      "历史日 THS 主力 = null（不冒充）；历史日无盘中快照，统一用盘后日 K。",
      "次日一字涨停/停牌剔除，不计 0 收益；胜率 = 净收益跑赢上证同期涨跌。",
      "5 日口径：T+1 开盘买、T+6 开盘卖（持 5 日），扣 0.41% 成本；只看 T+1 与 5 日两个口径，不加 10 天 / 1 个月。",
      "上证基准来自 TDX 上证日 K 开盘价（库内 stock_daily_bar 没有 000001.SH 的行，DB 查基准永远 null）；基准取不到时 win 记 null，不算输。",
      "layer1 回看用库内全部历史（09-16 之前已补 200 根/只，覆盖 MA144/RSV81/MACD 预热；与生产 syncPickSymbols 的 BARS=320 同口径方向）。",
    ],
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n汇总 T+1：${summary.evaluatedDays}/${summary.days} 天有评估，${summary.totalPicks} 只，平均净 ${summary.avgNet?.toFixed(2) ?? "—"}%，胜率 ${summary.winRate?.toFixed(1) ?? "—"}%`);
  console.log(`汇总 5日：${summary.evaluatedDays5}/${summary.days} 天有评估，${summary.totalPicks5} 只，平均净 ${summary.avgNet5?.toFixed(2) ?? "—"}%，胜率 ${summary.winRate5?.toFixed(1) ?? "—"}%`);
  for (const g of summary.byRegime) console.log(`  T+1 ${g.regime}：${g.days} 天 ${g.picks} 只，平均净 ${g.avgNet?.toFixed(2) ?? "—"}%，胜率 ${g.winRate?.toFixed(1) ?? "—"}%`);
  for (const g of summary.byRegime5) console.log(`  5日 ${g.regime}：${g.days} 天 ${g.picks} 只，平均净 ${g.avgNet?.toFixed(2) ?? "—"}%，胜率 ${g.winRate?.toFixed(1) ?? "—"}%`);
  console.log(`输出：${outPath}`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("BACKTEST FAILED:", e);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
