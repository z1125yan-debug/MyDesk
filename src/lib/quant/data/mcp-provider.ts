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

// ---------- 直接暴露给上层 API 使用的 MCP 工具调用（不经 DataProvider 抽象） ----------
// 这两个函数只依赖 mcp 客户端已配置（configureMcpProvider 已调用）；未配置时返回 null，
// 调用方负责把 null 归入 missing，不冒充实数。

export interface McpStockBasic {
  公司名称?: string | null;
  A股代码?: string | null;
  A股简称?: string | null;
  所属行业?: string | null;
  所属市场?: string | null;
  法人代表?: string | null;
  注册资金?: number | null;
  成立日期?: string | null;
  上市日期?: string | null;
  官方网站?: string | null;
  联系电话?: string | null;
  电子邮箱?: string | null;
  注册地址?: string | null;
  办公地址?: string | null;
  邮政编码?: string | null;
  主营业务?: string | null;
  入选指数?: string | null;
  H股代码?: string | null;
  H股简称?: string | null;
  B股代码?: string | null;
  B股简称?: string | null;
  英文名称?: string | null;
  曾用简称?: string | null;
  // 其他字段原样透出，让前端按需展示
  [k: string]: unknown;
}

export interface McpStockNewsItem {
  title?: string | null;
  content?: string | null;
  time?: string | null;
  source?: string | null;
  url?: string | null;
  stock_code?: string | null;
  stock_name?: string | null;
  [k: string]: unknown;
}

/** 个股基本面：调 get_stock_basic_info（东财/交易所公告口径；无鉴权，静态表） */
export async function fetchMcpStockBasic(code6: string): Promise<{ data: McpStockBasic; source: string } | null> {
  if (!mcpConfigured()) return null;
  try {
    const sc = await requireClient().callTool("get_stock_basic_info", { symbol: code6, output_format: "json" });
    const rows = unwrapRows(sc);
    const row = rows[0] ?? (sc && typeof sc === "object" && !Array.isArray(sc) ? (sc as Record<string, unknown>) : null);
    if (!row) return null;
    return { data: row as McpStockBasic, source: "china-stock-mcp · get_stock_basic_info" };
  } catch {
    return null;
  }
}

/** 个股新闻：调 get_news_data（MCP 上游也走东财；挂了返回 null 让调用方走 missing） */
export async function fetchMcpStockNews(code6: string, limit = 6): Promise<{ data: McpStockNewsItem[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  try {
    const sc = await requireClient().callTool("get_news_data", { symbol: code6, output_format: "json" });
    const rows = unwrapRows(sc);
    if (rows.length === 0) return null;
    const items = rows.slice(0, limit).map((r) => {
      const title = pickStr(r, ["title", "标题", "新闻标题"]);
      const time = pickStr(r, ["publish_time", "pub_time", "时间", "日期"]);
      const source = pickStr(r, ["source", "来源", "媒体"]);
      const url = pickStr(r, ["url", "链接"]);
      const content = pickStr(r, ["content", "内容", "摘要"]);
      return { title, time, source, url, content } as McpStockNewsItem;
    }).filter((x) => x.title);
    if (items.length === 0) return null;
    return { data: items, source: "china-stock-mcp · get_news_data" };
  } catch {
    return null;
  }
}

// ---------- MCP 全能力封装（补齐项目未消费的工具：财务、股东、研报、板块、宏观、指标等） ----------
// 所有函数：mcp 未配置或上游报错都返回 null，让调用方归入 missing，不冒充实数。

/** 通用：调 symbol 类工具，返回行数组 + source（缓存 5 分钟） */
async function cachedMcpRows(
  code6: string,
  toolName: string,
  sourceLabel: string,
  ttlMs = 300_000,
): Promise<{ data: Record<string, unknown>[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  const key = `mcp:${toolName}:${code6}`;
  return cached(key, ttlMs, async () => {
    try {
      await throttle(200);
      const sc = await requireClient().callTool(toolName, { symbol: code6, output_format: "json" });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      return { data: rows, source: sourceLabel };
    } catch {
      return null;
    }
  }) as Promise<{ data: Record<string, unknown>[]; source: string } | null>;
}

export interface McpBoardRow {
  name: string | null;
  code: string | null;
  changePct: number | null;
  turnoverYi: number | null;
  leader: string | null;
  count: number | null;
  /** 板块内上涨家数（get_stock_board_industry_summary 的「上涨家数」） */
  upCount: number | null;
  /** 板块内下跌家数（同上的「下跌家数」） */
  downCount: number | null;
  [k: string]: unknown;
}

/** 板块/行业资金流榜：get_stock_board_industry_summary（不依赖东财 push2，走 CNI 榜单口径） */
export async function fetchMcpIndustryBoard(): Promise<{ data: McpBoardRow[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  return cached("mcp:board:industry", 120_000, async () => {
    try {
      const sc = await requireClient().callTool("get_stock_board_industry_summary", { output_format: "json" });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      const data: McpBoardRow[] = rows.map((r) => {
        const name = pickStr(r, ["板块名称", "name", "board_name", "板块"]);
        const code = pickStr(r, ["板块代码", "code", "board_code"]);
        const changePct = pickNum(r, ["涨跌幅", "change_percent", "pct", "changePct", "涨幅"]);
        const turnover = pickNum(r, ["成交额", "amount", "turnover", "成交金额"]);
        const leader = pickStr(r, ["领涨股", "leader_stock", "涨幅最大股"]);
        const count = pickNum(r, ["成分股数量", "stock_count", "成分股"]);
        // 板块广度：get_stock_board_industry_summary 直接给「上涨家数/下跌家数」（2026-09-25 实测）
        const upCount = pickNum(r, ["上涨家数", "up_count", "upCount"]);
        const downCount = pickNum(r, ["下跌家数", "down_count", "downCount"]);
        return { name, code, changePct, turnoverYi: turnover != null ? turnover / 1e8 : null, leader, count, upCount, downCount } as McpBoardRow;
      }).filter((x) => x.name);
      if (data.length === 0) return null;
      return { data: data.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity)), source: "china-stock-mcp · get_stock_board_industry_summary" };
    } catch {
      return null;
    }
  }) as Promise<{ data: McpBoardRow[]; source: string } | null>;
}

// 财务三表 + 财务指标 + 估值
export const fetchMcpBalanceSheet = (c: string) => cachedMcpRows(c, "get_balance_sheet", "china-stock-mcp · get_balance_sheet", 300_000);
export const fetchMcpIncomeStatement = (c: string) => cachedMcpRows(c, "get_income_statement", "china-stock-mcp · get_income_statement", 300_000);
export const fetchMcpCashFlow = (c: string) => cachedMcpRows(c, "get_cash_flow", "china-stock-mcp · get_cash_flow", 300_000);
export const fetchMcpFinancialMetrics = (c: string) => cachedMcpRows(c, "get_financial_metrics", "china-stock-mcp · get_financial_metrics", 300_000);
export const fetchMcpStockValue = (c: string) => cachedMcpRows(c, "get_stock_value", "china-stock-mcp · get_stock_value", 300_000);

// 股东/高管/分红/解禁/研报/业绩预测/产品/龙虎榜
export const fetchMcpShareholder = (c: string) => cachedMcpRows(c, "get_shareholder_info", "china-stock-mcp · get_shareholder_info", 600_000);
export const fetchMcpCirculateHolder = (c: string) => cachedMcpRows(c, "get_stock_circulate_stock_holder", "china-stock-mcp · get_stock_circulate_stock_holder", 600_000);
export const fetchMcpInnerTrade = (c: string) => cachedMcpRows(c, "get_inner_trade_data", "china-stock-mcp · get_inner_trade_data", 600_000);
export const fetchMcpManagementChange = (c: string) => cachedMcpRows(c, "get_stock_management_change", "china-stock-mcp · get_stock_management_change", 600_000);
export const fetchMcpFhps = (c: string) => cachedMcpRows(c, "get_stock_fhps_detail", "china-stock-mcp · get_stock_fhps_detail", 600_000);
export const fetchMcpRestrictedRelease = (c: string) => cachedMcpRows(c, "get_stock_restricted_release_queue", "china-stock-mcp · get_stock_restricted_release_queue", 300_000);
export const fetchMcpProfitForecast = (c: string) => cachedMcpRows(c, "get_profit_forecast", "china-stock-mcp · get_profit_forecast", 300_000);
export const fetchMcpResearchReport = (c: string) => cachedMcpRows(c, "get_stock_research_report", "china-stock-mcp · get_stock_research_report", 300_000);
export const fetchMcpProductInfo = (c: string) => cachedMcpRows(c, "get_product_info", "china-stock-mcp · get_product_info", 600_000);
export const fetchMcpFundFlow = (c: string) => cachedMcpRows(c, "get_fund_flow", "china-stock-mcp · get_fund_flow", 120_000);
export const fetchMcpCyq = (c: string) => cachedMcpRows(c, "get_stock_cyq", "china-stock-mcp · get_stock_cyq", 300_000);

// ---------- 技术指标选股（get_stock_technical_rank 一次一个 indicator，串行避免打爆会话） ----------

export interface McpTechnicalSignalName {
  indicator: string;
  count: number;
  stocks: { code: string; name: string }[];
}

const SIGNAL_INDICATORS = [
  "创新高-创月新高", "创新高-半年新高", "创新高-一年新高", "创新高-历史新高",
  "创新低-创月新低", "创新低-半年新低", "创新低-一年新低", "创新低-历史新低",
  "连续上涨", "连续下跌",
  "持续放量", "持续缩量",
  "向上突破-20日均线", "向上突破-60日均线",
  "向下突破-20日均线", "向下突破-60日均线",
  "量价齐升", "量价齐跌", "险资举牌",
] as const;

// 并发 worker-pool 跑：把 indicators 分发到 N 个 worker 同时调用，N 可配
// MCP 上游支持并发（无内部锁），实测 8 并发不触发限流；总时长从串行 ~60s 压到 ~8-12s
export async function fetchMcpTechnicalSignals(
  indicators: readonly string[] = SIGNAL_INDICATORS,
  perLimit = 30,
): Promise<{ data: McpTechnicalSignalName[]; source: string; failed: string[] } | null> {
  if (!mcpConfigured()) return null;
  const cacheKey = `mcp:tech:v6:${indicators.join(",")}:${perLimit}`;
  return cached(cacheKey, 300_000, async () => {
    const client = requireClient();
    const results: (McpTechnicalSignalName | null)[] = new Array(indicators.length).fill(null);
    const failed: string[] = [];
    const callOne = async (idx: number, indicator: string) => {
      try {
        const sc = await client.callTool("get_stock_technical_rank", { indicator_name: indicator, output_format: "json" });
        const rows = unwrapRows(sc);
        const stocks = rows.slice(0, perLimit).map((r) => ({
          code: pickStr(r, ["代码", "code", "股票代码"]) ?? "",
          name: pickStr(r, ["名称", "name", "股票简称"]) ?? "",
        })).filter((x) => x.code);
        results[idx] = { indicator, count: rows.length, stocks };
      } catch {
        failed.push(indicator);
      }
    };
    // worker-pool：MCP 上游硬限制并发（19 并发 → 一半失败）。
    // 实测 N=2 稳定不失败；19 指标 × 3s / 2 ≈ 30s（比串行 60s 快一半）
    const CONCURRENCY = 2;
    let nextIdx = 0;
    const worker = async () => {
      while (nextIdx < indicators.length) {
        const i = nextIdx++;
        await callOne(i, indicators[i]);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const data = results.filter((x): x is McpTechnicalSignalName => x !== null);
    if (data.length === 0) return null;
    return { data, source: "china-stock-mcp · get_stock_technical_rank", failed };
  }) as Promise<{ data: McpTechnicalSignalName[]; source: string; failed: string[] } | null>;
}

// ---------- 宏观 & 情绪 ----------

export interface McpMacroSeries {
  name: string;
  points: { date: string; value: number }[];
}

export async function fetchMcpMacroData(indicators: string[] = ["gdp", "cpi", "ppi", "shibor_on"]): Promise<{ data: McpMacroSeries[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  return cached(`mcp:macro:${indicators.join(",")}`, 3600_000, async () => {
    try {
      const sc = await requireClient().callTool("get_macro_data", { indicators, output_format: "json" });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      const byName = new Map<string, { date: string; value: number }[]>();
      for (const r of rows) {
        const name = pickStr(r, ["indicator", "指标", "name", "指标名称"]) ?? "unknown";
        const date = pickStr(r, ["date", "日期", "time", "时间"]);
        const value = pickNum(r, ["value", "数值", "值"]);
        if (date === null || value === null) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push({ date, value });
      }
      const data: McpMacroSeries[] = [];
      for (const [name, points] of byName) {
        data.push({ name, points: points.sort((a, b) => (a.date < b.date ? -1 : 1)) });
      }
      if (data.length === 0) return null;
      return { data, source: "china-stock-mcp · get_macro_data" };
    } catch {
      return null;
    }
  }) as Promise<{ data: McpMacroSeries[]; source: string } | null>;
}

export async function fetchMcpInvestorSentiment(code6: string): Promise<{ data: Record<string, unknown>[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  return cached(`mcp:sentiment:${code6}`, 600_000, async () => {
    try {
      const sc = await requireClient().callTool("get_investor_sentiment", { symbol: code6, output_format: "json" });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      return { data: rows, source: "china-stock-mcp · get_investor_sentiment" };
    } catch {
      return null;
    }
  }) as Promise<{ data: Record<string, unknown>[]; source: string } | null>;
}

// ---------- 指数 ----------

export interface McpIndexMeta { code: string; name: string; [k: string]: unknown }

export async function fetchMcpIndexList(): Promise<{ data: McpIndexMeta[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  return cached("mcp:index:list", 3600_000, async () => {
    try {
      const sc = await requireClient().callTool("get_all_cni_indices", { output_format: "json" });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      const data = rows.map((r) => ({
        code: pickStr(r, ["代码", "code", "index_code"]) ?? "",
        name: pickStr(r, ["名称", "name", "index_name"]) ?? "",
      })).filter((x) => x.code);
      if (data.length === 0) return null;
      return { data, source: "china-stock-mcp · get_all_cni_indices" };
    } catch {
      return null;
    }
  }) as Promise<{ data: McpIndexMeta[]; source: string } | null>;
}

export async function fetchMcpIndexDetail(indexCode: string): Promise<{ data: Record<string, unknown>[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  return cached(`mcp:index:detail:${indexCode}`, 1800_000, async () => {
    try {
      const sc = await requireClient().callTool("get_cni_index_detail", { symbol: indexCode, output_format: "json" });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      return { data: rows, source: "china-stock-mcp · get_cni_index_detail" };
    } catch {
      return null;
    }
  }) as Promise<{ data: Record<string, unknown>[]; source: string } | null>;
}

export async function fetchMcpIndexHist(indexCode: string, startDate: string, endDate: string): Promise<{ data: Record<string, unknown>[]; source: string } | null> {
  if (!mcpConfigured()) return null;
  return cached(`mcp:index:hist:${indexCode}:${startDate}:${endDate}`, 600_000, async () => {
    try {
      const sc = await requireClient().callTool("get_cni_index_hist", {
        symbol: indexCode, start_date: startDate, end_date: endDate, output_format: "json",
      });
      const rows = unwrapRows(sc);
      if (rows.length === 0) return null;
      return { data: rows, source: "china-stock-mcp · get_cni_index_hist" };
    } catch {
      return null;
    }
  }) as Promise<{ data: Record<string, unknown>[]; source: string } | null>;
}
