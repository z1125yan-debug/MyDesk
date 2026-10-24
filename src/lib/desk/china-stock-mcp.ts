// china-stock-mcp（ModelScope）— 选股财务/估值/资金流适配层（仅服务端）
//
// 背景：选股 PE、PB、市值、流通市值长期 undefined（通达信网关快照不给、
// 东财 push2 502）。TDX MCP（tdx-mcp-fund.ts）已补：7709 finance_batch（市值/PB/换手，
// 批量快）+ F10 估值（PE，逐只 ~11s）。本模块是第二财务源：ModelScope
// china-stock-mcp（streamable_http），30 个工具，URL 由环境变量配（见下），
// 不硬编码、不写日志。
//
// 工具映射（实测 2026-10-16，tools/list 30 个，逐只拉）：
//   PE / PB / 市值 / 流通市值 ← get_stock_value（日度估值表，2129 行，
//     列：数据日期(ms)/当日收盘价/总市值/流通市值/总股本/流通股本/PE(TTM)/PE(静)/市净率/PEG；
//     取最大 数据日期 行即最新日。茅台 2026-10-15：PE(TTM) 20.16、PB 6.53、
//     总市值 1.641 万亿，与 TDX MCP F10（PE 20.16 / PB 6.53 / 市值 1.641 万亿）一致；
//     平安银行：PE(TTM) 5.09、PB 0.47、总市值 2214 亿，与 TDX（PE 5.09 / PB 0.47）一致。）
//   营收 / 净利润 / 净资产 / EPS / 每股净资产 / ROE ← get_financial_metrics（透视表，
//     80 行指标 × 日期列；最新报告期 20260630 = 2026 半年报。ROE 16.75 为报告期口径，
//     非年化，与 TDX MCP 口径一致。无 PE/PB——估值只从 get_stock_value 取。）
//   业绩预测 ← get_profit_forecast（6 行：3 年 × {预测年报净利润， 预测年报每股收益}；
//     净利润均值单位疑似亿元，上游未标注，返回原值并标注单位未确认，不换算。）
//   资金流 ← get_fund_flow（实测 2026-10-16：600519、000001 均 RemoteDisconnected，
//     上游断线，连续 3 次失败。解析函数保留（shape 未知时返回 null），
//     调用方必须回退同花顺，绝不因 MCP 资金流失败而记「无资金验证」。）
//   基本概要 ← get_stock_basic_info（公司名称/行业/上市日等，无市值/PE/PB，
//     市值不从这里取；本模块不封装它，复用 mcp-provider 的 fetchMcpStockBasic。）
//
// 配置：优先 CHINA_STOCK_MCP_URL，其次 QUANT_MCP_URL，最后 data/quant-config.json
// （quant-config.ts 的 mcpUrl() 已按此顺序）。未配置时所有函数返回 null，
// 调用方保持 undefined（缺就是缺，不编 0），不抛错。
// 限流：底层 mcp-provider 的 cachedMcpRows 已节流 200ms + 缓存；本模块批量
// 另加 200ms 间隔、上限 50 只，单只失败跳过，不阻塞。

import fs from "fs";
import path from "path";
import {
  configureMcpProvider,
  mcpConfigured,
  fetchMcpFinancialMetrics,
  fetchMcpStockValue,
  fetchMcpFundFlow,
  fetchMcpProfitForecast,
} from "@/lib/quant/data/mcp-provider";
import type { AssetMeta } from "@/lib/quant/types";

/** 确保 MCP 已配置（幂等）：未配置时按 CHINA_STOCK_MCP_URL → QUANT_MCP_URL 顺序配一次。 */
export function ensureChinaStockMcp(): boolean {
  if (mcpConfigured()) return true;
  const url = process.env.CHINA_STOCK_MCP_URL || process.env.QUANT_MCP_URL || "";
  if (!url) return false;
  try {
    configureMcpProvider(url);
  } catch {
    return false;
  }
  return mcpConfigured();
}

/** MyDesk 符号 → MCP 6 位代码："600519.SH" / "600519" → "600519"；非法返回 "" */
export function code6FromSymbol(symbol: string): string {
  const m = /(\d{6})/.exec(symbol.trim());
  return m ? m[1] : "";
}

function numOr(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function msToShanghaiDate(ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return "";
  }
}

function yyyymmddToDate(s: string): string {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "";
}

// ---------- 估值日级缓存（文件持久化 + 内存镜像） ----------

interface CachedValuationEntry extends ChinaStockValuation {
  cachedAt: number; // 拉取时刻 ms
}

interface ValuationCacheFile {
  valuationDate: string; // 缓存中最新估值日期 YYYY-MM-DD
  checkedDay: string; // 最近一次向 MCP 核验的上海日 YYYY-MM-DD
  entries: Record<string, CachedValuationEntry>;
}

const VALUATION_CACHE_FILE = path.join(process.cwd(), "data", "valuation-cache.json");
const TRADE_DATE_MEMO_FILE = path.join(process.cwd(), "data", "trade-date-last-good.json");

let memValuationCache: { valuationDate: string; checkedDay: string; entries: Map<string, CachedValuationEntry> } | null = null;

function shanghaiDay(d = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return "";
  }
}

/** 最近行情源确认的交易日（本地 memo 文件，快读，无网络）。读不到返回 null。 */
function readTradeDateMemo(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(TRADE_DATE_MEMO_FILE, "utf-8")) as { date?: string };
    return raw.date && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  } catch {
    return null;
  }
}

function loadValuationCache(): { valuationDate: string; checkedDay: string; entries: Map<string, CachedValuationEntry> } {
  if (memValuationCache) return memValuationCache;
  const empty = { valuationDate: "", checkedDay: "", entries: new Map<string, CachedValuationEntry>() };
  try {
    const raw = JSON.parse(fs.readFileSync(VALUATION_CACHE_FILE, "utf-8")) as ValuationCacheFile;
    const entries = new Map<string, CachedValuationEntry>();
    for (const [k, v] of Object.entries(raw.entries ?? {})) {
      if (v && typeof v.pe === "number" && typeof v.date === "string") entries.set(k.toUpperCase(), v as CachedValuationEntry);
    }
    memValuationCache = { valuationDate: raw.valuationDate ?? "", checkedDay: raw.checkedDay ?? "", entries };
    return memValuationCache;
  } catch {
    memValuationCache = empty;
    return memValuationCache;
  }
}

function persistValuationCache(): void {
  if (!memValuationCache) return;
  try {
    fs.mkdirSync(path.dirname(VALUATION_CACHE_FILE), { recursive: true });
    const out: ValuationCacheFile = {
      valuationDate: memValuationCache.valuationDate,
      checkedDay: memValuationCache.checkedDay,
      entries: Object.fromEntries(memValuationCache.entries),
    };
    fs.writeFileSync(VALUATION_CACHE_FILE, JSON.stringify(out), "utf-8");
  } catch {
    // 落盘失败不影响主路：内存缓存仍有效，下次成功写入会再写
  }
}

function toValuation(e: CachedValuationEntry): ChinaStockValuation {
  const { cachedAt: _cachedAt, ...v } = e;
  return v;
}

function storeValuationCache(key: string, v: ChinaStockValuation): void {
  const cache = loadValuationCache();
  cache.entries.set(key.toUpperCase(), { ...v, cachedAt: Date.now() });
  if (v.date > cache.valuationDate) cache.valuationDate = v.date;
  cache.checkedDay = shanghaiDay();
  persistValuationCache();
}

const bgRefreshingValuation = new Set<string>();

/** 后台刷新一只估值（去重）：拉 MCP 最新行写回缓存；失败则只更新 checkedDay，避免一天内重复拉。 */
function refreshValuationInBackground(key: string, code6: string): void {
  const upper = key.toUpperCase();
  if (bgRefreshingValuation.has(upper)) return;
  bgRefreshingValuation.add(upper);
  void (async () => {
    try {
      const res = await fetchMcpStockValue(code6);
      if (res?.data?.length) {
        const v = parseStockValueRows(res.data, upper, code6);
        if (v) storeValuationCache(upper, v);
      }
      // MCP 返回空/解析失败：仍标记今日已核验，避免一天内反复拉
      const cache = loadValuationCache();
      cache.checkedDay = shanghaiDay();
      persistValuationCache();
    } catch {
      const cache = loadValuationCache();
      cache.checkedDay = shanghaiDay();
      persistValuationCache();
    } finally {
      bgRefreshingValuation.delete(upper);
    }
  })();
}

// ---------- 估值（get_stock_value） ----------

export interface ChinaStockValuation {
  symbol: string; // 600519.SH
  code6: string;
  pe: number; // PE(TTM)
  peStatic: number | null; // PE(静)
  pb: number; // 市净率
  marketCap: number; // 总市值（元）
  floatCap: number; // 流通市值（元）
  totalShares: number | null; // 总股本（股）
  floatShares: number | null; // 流通股本（股）
  price: number | null; // 当日收盘价
  date: string; // 数据日期 YYYY-MM-DD（上海）
  source: string;
}

function parseStockValueRows(rows: Record<string, unknown>[], symbol: string, code6: string): ChinaStockValuation | null {
  let best: Record<string, unknown> | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const ms = numOr(r["数据日期"]);
    if (ms == null) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = r;
    }
  }
  if (!best) return null;
  const pe = numOr(best["PE(TTM)"]);
  const pb = numOr(best["市净率"]);
  const mv = numOr(best["总市值"]);
  const fmv = numOr(best["流通市值"]);
  if (pe == null || pb == null || mv == null || fmv == null) return null;
  if (!(mv > 0) || !(fmv > 0)) return null;
  return {
    symbol,
    code6,
    pe,
    peStatic: numOr(best["PE(静)"]),
    pb,
    marketCap: mv,
    floatCap: fmv,
    totalShares: numOr(best["总股本"]),
    floatShares: numOr(best["流通股本"]),
    price: numOr(best["当日收盘价"]),
    date: msToShanghaiDate(bestMs),
    source: "china-stock-mcp · get_stock_value",
  };
}

/** 单只估值：PE(TTM)/PB/总市值/流通市值。未配置/失败/无数据返回 null。
 *
 * 日级真实缓存（2026-10-16）：MCP get_stock_value 无“仅最新行”参数，每次返回
 * 自 2018 年起全量历史表（~2129 行，约 6.5 秒/只），20 只并行 5 并发 = 47 秒，
 * 选股器首屏等不起。故把解析后的最新行（真实值，非推算）落盘缓存：
 *   文件 data/valuation-cache.json：{ valuationDate, checkedDay, entries }。
 *   entries key = 大写符号（如 600519.SH），value = 最新估值行 + cachedAt。
 * 新鲜度（不猜、不内插、不按价格缩放 PE）：
 *   · entry.date >= memo（trade-date-last-good.json，最近行情源确认的交易日）→ 新鲜，直接回。
 *   · 否则若 checkedDay == 今天（上海日）→ 今天已向 MCP 核验过（MCP 尚未更新或失败），
 *     回缓存的真实旧值（带真实 date，不冒充今日值），不再重复拉。
 *   · 否则 → 立刻回缓存旧值 + 后台刷新（去重，一天每只最多一次），前台永不阻塞。
 *   · 无缓存条目时才阻塞拉 MCP（首次使用一次性成本，之后走缓存）。
 * MCP 失败时：有缓存回缓存（真实旧值），无缓存回 null。缺仍为 NULL，不编 0。
 */
export async function fetchChinaStockValuation(symbol: string): Promise<ChinaStockValuation | null> {
  if (!ensureChinaStockMcp()) return null;
  const code6 = code6FromSymbol(symbol);
  if (!code6) return null;
  const key = symbol.toUpperCase();
  const cache = loadValuationCache();
  const entry = cache.entries.get(key);
  const today = shanghaiDay();
  const memo = readTradeDateMemo();
  if (entry) {
    const freshByMemo = memo != null && entry.date >= memo;
    if (freshByMemo || cache.checkedDay === today) return toValuation(entry);
    // 旧值 + 后台刷新：前台立刻回真实旧值，不阻塞；后台拉到新行后写回缓存。
    refreshValuationInBackground(key, code6);
    return toValuation(entry);
  }
  try {
    const res = await fetchMcpStockValue(code6);
    if (!res?.data?.length) return null;
    const v = parseStockValueRows(res.data, key, code6);
    if (!v) return null;
    storeValuationCache(key, v);
    return v;
  } catch {
    return null;
  }
}

// ---------- 财务（get_financial_metrics，透视表） ----------

export interface ChinaStockFinancials {
  symbol: string;
  code6: string;
  revenue: number | null; // 营业总收入（元，最新报告期）
  netProfit: number | null; // 净利润（元，最新报告期；为空时用归母净利润兜底）
  parentNetProfit: number | null; // 归母净利润（元）
  netAssets: number | null; // 股东权益合计/净资产（元）
  eps: number | null; // 基本每股收益（元）
  netAssetsPerShare: number | null; // 每股净资产（元）
  roePeriod: number | null; // 净资产收益率 ROE（%，报告期口径，非年化）
  grossMargin: number | null; // 毛利率（%）
  reportDate: string; // 最新报告期 YYYY-MM-DD（由 YYYYMMDD 列名转换）
  source: string;
}

function parseFinancialMetricsRows(rows: Record<string, unknown>[], symbol: string, code6: string): ChinaStockFinancials | null {
  // 指标名 → 最新值（重复指标取首个非空，如 归母净利润 在 常用指标/成长能力 两处同值）
  const latest = new Map<string, number>();
  let latestDateKey = "";
  for (const r of rows) {
    const ind = typeof r["指标"] === "string" ? (r["指标"] as string) : "";
    if (!ind) continue;
    const dateKeys = Object.keys(r).filter((k) => /^\d{8}$/.test(k)).sort();
    if (!dateKeys.length) continue;
    const last = dateKeys[dateKeys.length - 1];
    if (last > latestDateKey) latestDateKey = last;
    if (latest.has(ind)) continue;
    const v = numOr(r[last]);
    if (v != null) latest.set(ind, v);
  }
  if (!latest.size) return null;
  const get = (name: string): number | null => latest.get(name) ?? null;
  const netProfit = get("净利润") ?? get("归母净利润");
  return {
    symbol,
    code6,
    revenue: get("营业总收入"),
    netProfit,
    parentNetProfit: get("归母净利润"),
    netAssets: get("股东权益合计(净资产)"),
    eps: get("基本每股收益"),
    netAssetsPerShare: get("每股净资产"),
    roePeriod: get("净资产收益率(ROE)"),
    grossMargin: get("毛利率"),
    reportDate: yyyymmddToDate(latestDateKey),
    source: "china-stock-mcp · get_financial_metrics",
  };
}

/** 单只财务：营收/净利润/净资产/EPS/每股净资产/ROE（报告期口径）。失败返回 null。 */
export async function fetchChinaStockFinancials(symbol: string): Promise<ChinaStockFinancials | null> {
  if (!ensureChinaStockMcp()) return null;
  const code6 = code6FromSymbol(symbol);
  if (!code6) return null;
  try {
    const res = await fetchMcpFinancialMetrics(code6);
    if (!res?.data?.length) return null;
    return parseFinancialMetricsRows(res.data, symbol.toUpperCase(), code6);
  } catch {
    return null;
  }
}

// ---------- 资金流（get_fund_flow；上游断线时返回 null，调用方回退同花顺） ----------

export interface ChinaStockFundFlow {
  symbol: string;
  code6: string;
  date: string; // 资金流日期 YYYY-MM-DD（上游字段不定，取不到则 ""）
  mainNetYi: number; // 主力净额（亿）
  superNetYi: number | null; // 超大单净额（亿，未知口径时 null）
  bigNetYi: number | null; // 大单净额（亿）
  source: string;
}

function parseFundFlowRows(rows: Record<string, unknown>[], symbol: string, code6: string): ChinaStockFundFlow | null {
  if (!rows.length) return null;
  // 上游报错行（{ error: ... }）→ 视为无数据，不抛错
  if (rows.length === 1 && typeof rows[0]["error"] === "string") return null;
  // 取最新行：按日期类列排序，取不到日期则取末行
  const dateKeys = ["日期", "date", "trade_date", "交易日期"];
  const sorted = [...rows].sort((a, b) => {
    const da = String(a[dateKeys.find((k) => a[k] != null) ?? ""] ?? "");
    const db = String(b[dateKeys.find((k) => b[k] != null) ?? ""] ?? "");
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const last = sorted[sorted.length - 1];
  const main = numOr(last["主力净流入"]) ?? numOr(last["主力净额"]) ?? numOr(last["主力净流"]) ?? numOr(last["main_net"]) ?? numOr(last["主力"]);
  if (main == null) return null; // shape 未知，不猜测列名
  // 上游单位未知：若 |main| > 1e6 视为元，换算为亿；否则视为亿
  const mainNetYi = Math.abs(main) > 1e6 ? main / 1e8 : main;
  const superRaw = numOr(last["超大单净流入"]) ?? numOr(last["超大单净额"]);
  const bigRaw = numOr(last["大单净流入"]) ?? numOr(last["大单净额"]);
  const conv = (v: number | null): number | null => (v == null ? null : Math.abs(v) > 1e6 ? v / 1e8 : v);
  const dateStr = (() => {
    for (const k of dateKeys) {
      const v = last[k];
      if (v != null && String(v).trim() !== "") {
        const s = String(v);
        if (/^\d{8}$/.test(s)) return yyyymmddToDate(s);
        return s.slice(0, 10);
      }
    }
    return "";
  })();
  return { symbol, code6, date: dateStr, mainNetYi, superNetYi: conv(superRaw), bigNetYi: conv(bigRaw), source: "china-stock-mcp · get_fund_flow" };
}

/** 单只资金流：主力净额（亿）。MCP 上游断线/shape 未知时返回 null，调用方回退同花顺。 */
export async function fetchChinaStockFundFlow(symbol: string): Promise<ChinaStockFundFlow | null> {
  if (!ensureChinaStockMcp()) return null;
  const code6 = code6FromSymbol(symbol);
  if (!code6) return null;
  try {
    const res = await fetchMcpFundFlow(code6);
    if (!res?.data?.length) return null;
    return parseFundFlowRows(res.data, symbol.toUpperCase(), code6);
  } catch {
    return null;
  }
}

// ---------- 业绩预测（get_profit_forecast） ----------

export interface ChinaStockForecast {
  symbol: string;
  code6: string;
  year: string; // 预测年度，如 "2026"
  forecastNetProfit: number | null; // 预测年报净利润 均值（原值，单位疑似亿元，上游未标注，不换算）
  forecastEps: number | null; // 预测年报每股收益 均值（元）
  institutions: number | null; // 预测机构数
  source: string;
}

function parseProfitForecastRows(rows: Record<string, unknown>[], symbol: string, code6: string): ChinaStockForecast | null {
  const thisYear = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date());
  // 取 >= 今年的最小年度；没有则取最大年度
  const years = [...new Set(rows.map((r) => String(r["年度"] ?? "")))].filter((y) => /^\d{4}$/.test(y)).sort();
  if (!years.length) return null;
  const target = years.find((y) => y >= thisYear) ?? years[years.length - 1];
  const pick = (indicator: string): { mean: number | null; inst: number | null } => {
    const row = rows.find((r) => String(r["indicator"] ?? "") === indicator && String(r["年度"] ?? "") === target);
    if (!row) return { mean: null, inst: null };
    return { mean: numOr(row["均值"]), inst: numOr(row["预测机构数"]) };
  };
  const profit = pick("预测年报净利润");
  const eps = pick("预测年报每股收益");
  if (profit.mean == null && eps.mean == null) return null;
  return {
    symbol,
    code6,
    year: target,
    forecastNetProfit: profit.mean,
    forecastEps: eps.mean,
    institutions: profit.inst ?? eps.inst,
    source: "china-stock-mcp · get_profit_forecast",
  };
}

/** 单只业绩预测：当年（或最近未来年）净利润/EPS 均值。失败返回 null。 */
export async function fetchChinaStockForecast(symbol: string): Promise<ChinaStockForecast | null> {
  if (!ensureChinaStockMcp()) return null;
  const code6 = code6FromSymbol(symbol);
  if (!code6) return null;
  try {
    const res = await fetchMcpProfitForecast(code6);
    if (!res?.data?.length) return null;
    return parseProfitForecastRows(res.data, symbol.toUpperCase(), code6);
  } catch {
    return null;
  }
}

// ---------- 批量（逐只、间隔 200ms、上限 50 只；单只失败跳过） ----------

const BATCH_LIMIT = 50;
const BATCH_GAP_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchChinaStockBatch<T>(
  symbols: string[],
  fn: (symbol: string) => Promise<T | null>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, BATCH_LIMIT);
  for (const s of uniq) {
    try {
      const r = await fn(s);
      if (r != null) out.set(s, r);
    } catch {
      // 单只失败跳过
    }
    await sleep(BATCH_GAP_MS);
  }
  return out;
}

// ---------- 富化 AssetMeta（选股用） ----------

/**
 * 用 MCP 估值富化候选池 meta：PE(TTM)/PB/总市值/流通市值（仅当 meta 缺失时填，
 * 不覆盖 TDX MCP 已填的真数；估值行缺失时保持 undefined）。
 * 返回 { enriched, roe, forecasts }：ROE/业绩预测 AssetMeta 无字段，随 Map 返回供调用方用。
 */
export async function enrichMetasWithChinaStockMcp(
  metas: AssetMeta[],
  opts: { valuation?: boolean; financials?: boolean; fundFlow?: boolean; forecast?: boolean; limit?: number } = {},
): Promise<{
  enriched: number;
  roe: Map<string, number>;
  forecasts: Map<string, ChinaStockForecast>;
  financials: Map<string, ChinaStockFinancials>;
}> {
  const { valuation = true, financials = false, fundFlow = false, forecast = false, limit = BATCH_LIMIT } = opts;
  const roe = new Map<string, number>();
  const forecasts = new Map<string, ChinaStockForecast>();
  const financialsMap = new Map<string, ChinaStockFinancials>();
  if (!metas.length || !ensureChinaStockMcp()) return { enriched: 0, roe, forecasts, financials: financialsMap };
  const uniq = [...new Set(metas.map((m) => m.symbol.toUpperCase()))].slice(0, limit);
  // 并行化（5 并发）+ 日级真实缓存：缓存命中时毫秒级回真实值；仅无缓存条目时
  // 才阻塞拉 MCP（首次使用一次性成本）。缓存逻辑见 fetchChinaStockValuation。
  const CONC = 5;
  let enriched = 0;
  const runOne = async (sym: string): Promise<boolean> => {
    const targets = metas.filter((m) => m.symbol.toUpperCase() === sym);
    if (!targets.length) return false;
    let filled = false;
    if (valuation) {
      const v = await fetchChinaStockValuation(sym);
      if (v) {
        for (const m of targets) {
          if (m.pe == null) { m.pe = v.pe; filled = true; }
          if (m.pb == null && v.pb > 0) { m.pb = v.pb; filled = true; }
          if (m.marketCap == null && v.marketCap > 0) { m.marketCap = v.marketCap; filled = true; }
          if (m.floatCap == null && v.floatCap > 0) { m.floatCap = v.floatCap; filled = true; }
        }
      }
    }
    if (financials) {
      const f = await fetchChinaStockFinancials(sym);
      if (f) {
        financialsMap.set(sym, f);
        if (f.roePeriod != null) roe.set(sym, f.roePeriod);
        if (f.roePeriod != null) filled = true;
      }
    }
    if (fundFlow) {
      const ff = await fetchChinaStockFundFlow(sym);
      if (ff) {
        const mainNetYuan = ff.mainNetYi * 1e8;
        for (const m of targets) {
          if (m.mainNet == null) { m.mainNet = mainNetYuan; filled = true; }
        }
      }
    }
    if (forecast) {
      const fc = await fetchChinaStockForecast(sym);
      if (fc) forecasts.set(sym, fc);
    }
    return filled;
  };
  for (let i = 0; i < uniq.length; i += CONC) {
    const wave = uniq.slice(i, i + CONC);
    const results = await Promise.allSettled(wave.map((s) => runOne(s)));
    for (const r of results) if (r.status === "fulfilled" && r.value) enriched++;
    await sleep(BATCH_GAP_MS);
  }
  return { enriched, roe, forecasts, financials: financialsMap };
}

/**
 * 候选池 PE 富化（对标 enrichMetasWithPe）：仅估值，PE 缺失时填 PE，
 * PB/市值/流通市值仅当缺失时兜底。上限 30 只（与 TDX F10 口径一致）。
 */
export async function enrichMetasWithMcpPe(metas: AssetMeta[], limit = 30): Promise<number> {
  const need = metas.filter((m) => m.pe == null);
  if (!need.length) return 0;
  const { enriched } = await enrichMetasWithChinaStockMcp(need, { valuation: true, limit });
  return enriched;
}
