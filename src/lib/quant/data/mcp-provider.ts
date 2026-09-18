// Quant Research Lab — china-stock-mcp（ModelScope streamable HTTP）数据源实现（仅服务端）
// 工具映射：
//   listUniverse ← get_stock_a_code_name（沪深京全A代码表；ST 由名称识别）
//   getBars      ← get_hist_data（interval=day，start/end 严格截至 asOf）
//   getQuotes    ← get_realtime_data
// 局限（诚实声明）：成分股名单为当前快照（current_only）；上市日期/市值/换手不可得 →
// 相关过滤器自动降级；行业/概念股票池本源不支持（用 em 或 custom）。
import { McpHttpClient, McpHttpError } from "./mcp-http-client";
import type { AssetMeta, Bar, BarsRequest, DataCoverage, DataProvider, Timeframe, UniverseSpec } from "../types.ts";

let client: McpHttpClient | null = null;
let mcpUrl = "";

export function configureMcpProvider(url: string): void {
  if (url && url !== mcpUrl) {
    mcpUrl = url;
    client = new McpHttpClient({ url });
  }
}

export function mcpConfigured(): boolean {
  return client !== null;
}

// ---------- 输出解包：structuredContent 形态不定，做宽容解析 ----------

function unwrapRows(sc: unknown): Record<string, unknown>[] {
  if (Array.isArray(sc)) return sc as Record<string, unknown>[];
  if (sc && typeof sc === "object") {
    const obj = sc as Record<string, unknown>;
    if (typeof obj.result === "string") {
      try {
        const parsed = JSON.parse(obj.result);
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  }
  return [];
}

function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    if (isFinite(n)) return n;
  }
  return null;
}
function pickStr(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "" && String(v) !== "-") return String(v);
  }
  return null;
}

// ---------- 符号映射：6 位代码 → 交易所后缀 ----------

function codeToSymbol(code: string): string {
  if (/^6/.test(code)) return `${code}.SH`;
  if (/^(0|3)/.test(code)) return `${code}.SZ`;
  if (/^(4|8|9)/.test(code)) return `${code}.BJ`;
  return `${code}.SZ`;
}

function symbolToCode(symbol: string): string {
  return symbol.trim().toUpperCase().split(".")[0];
}

// ---------- 缓存 + 节流 ----------

const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 1200) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function throttle(minGapMs = 200): Promise<void> {
  const gap = Date.now() - lastCall;
  if (gap < minGapMs) await sleep(minGapMs - gap);
  lastCall = Date.now();
}

function requireClient(): McpHttpClient {
  if (!client) throw new McpHttpError("MCP 数据源未配置（缺少 data/quant-config.json 或 QUANT_MCP_URL）");
  return client;
}

// ---------- DataProvider ----------

export const mcpProvider: DataProvider = {
  id: "mcp",
  coverage(): DataCoverage {
    return {
      source: `mcp(china-stock-mcp${mcpUrl ? "" : " 未配置"})`,
      daily: true,
      minute: false,
      fundamentals: "none", // 工具存在但按符号逐个拉取，v1 不用于面板
      universeMembership: "current_only",
    };
  },

  async listUniverse(spec: UniverseSpec, _asOf: string): Promise<AssetMeta[]> {
    const rows = await cached("universe", 300_000, async () => {
      const sc = await requireClient().callTool("get_stock_a_code_name", { output_format: "json" });
      return unwrapRows(sc);
    });
    let metas: AssetMeta[] = rows
      .map((r) => {
        const code = pickStr(r, ["code", "股票代码"]) ?? "";
        if (!/^\d{6}$/.test(code)) return null;
        const name = pickStr(r, ["name", "股票简称"]) ?? code;
        return { symbol: codeToSymbol(code), name, st: /ST/i.test(name) } as AssetMeta;
      })
      .filter((m): m is AssetMeta => m !== null);
    if (spec.kind === "custom" && spec.symbols?.length) {
      const set = new Set(spec.symbols.map((s) => s.toUpperCase()));
      metas = metas.filter((m) => set.has(m.symbol));
    } else if (spec.kind === "industry" || spec.kind === "concept") {
      throw new Error("mcp 数据源暂不支持行业/概念股票池（请用 em 或 custom）");
    }
    // 上市日期不可得：listDate 过滤自然降级（undefined 不被剔除）
    return metas;
  },

  async getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
    const out = new Map<string, Bar[]>();
    let consecutiveEmpty = 0;
    for (const sym of req.symbols) {
      try {
        await throttle();
        const bars = await cached(`bars:${sym}:${req.asOf}:${req.lookback}`, 600_000, async () => {
          const startMs = Date.parse(req.asOf) - Math.max(80, req.lookback * 2) * 86400000;
          const start = new Date(Math.max(0, startMs)).toISOString().slice(0, 10);
          const sc = await requireClient().callTool("get_hist_data", {
            symbol: sym, interval: "day", interval_multiplier: 1,
            start_date: start, end_date: req.asOf, adjust: "qfq", output_format: "json",
          });
          return parseHistRows(unwrapRows(sc));
        });
        const cut = bars.filter((b) => b.date.slice(0, 10) <= req.asOf).slice(-req.lookback);
        out.set(sym, cut);
        consecutiveEmpty = cut.length ? 0 : consecutiveEmpty + 1;
        if (consecutiveEmpty >= 10 && req.symbols.length > 10) {
          throw new McpHttpError("MCP 数据源连续 10 只无K线返回（上游数据源故障），已中止批量拉取");
        }
      } catch (e) {
        if ((e as Error).message.includes("中止")) throw e;
        out.set(sym, []);
      }
    }
    return out;
  },

  async getQuotes(symbols: string[]): Promise<Map<string, { price: number; name?: string }>> {
    const out = new Map<string, { price: number; name?: string }>();
    for (const sym of symbols) {
      try {
        await throttle();
        const sc = await requireClient().callTool("get_realtime_data", { symbol: sym, output_format: "json" });
        const rows = unwrapRows(sc);
        const row = rows[0] ?? (sc && typeof sc === "object" && !Array.isArray(sc) ? (sc as Record<string, unknown>) : null);
        if (!row) continue;
        const price = pickNum(row, ["最新价", "price", "current_price", "close"]);
        const name = pickStr(row, ["名称", "name", "stock_name"]);
        if (price !== null) out.set(sym, { price, name: name ?? undefined });
      } catch {
        // 单只失败不拖垮
      }
    }
    return out;
  },
};

// get_hist_data 行解析：兼容中文（akshare 口径）与英文列名
function parseHistRows(rows: Record<string, unknown>[]): Bar[] {
  const out: Bar[] = [];
  for (const r of rows) {
    const date = pickStr(r, ["日期", "date", "trade_date", "day"]);
    const o = pickNum(r, ["开盘", "open"]);
    const c = pickNum(r, ["收盘", "close"]);
    const h = pickNum(r, ["最高", "high"]);
    const l = pickNum(r, ["最低", "low"]);
    const v = pickNum(r, ["成交量", "volume"]);
    const amount = pickNum(r, ["成交额", "amount", "turnover_value"]);
    if (!date || o === null || c === null || h === null || l === null) continue;
    out.push({ date, o, h, l, c, v: v ?? 0, amount: amount ?? undefined });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export type { Timeframe };
