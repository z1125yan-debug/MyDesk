"use client";
// 前端 → 新 P0 后端接口的类型化封装
import type { ScreenerCond, WinProbStats } from "@/lib/quant/factors/probability";
import type { EventFact, EventInterpretation, summarizeInterpretations } from "@/lib/quant/screener/event-interpret-core";
import type { EvidenceLine, ResearchReport, SourceProbe } from "@/lib/quant/screener/research-core";
import type { DecisionView } from "@/lib/quant/screener/decision-wiring-core";
import type { IntentBadge, StepInfo } from "@/lib/desk/chat-core";
import { aiRequestHeaders } from "./ai";
import type { AiSettings } from "./types";
import { MODE_TEXT, modeFromBasis } from "@/lib/quant/screener/incremental-core";

export type { ScreenerCond, WinProbStats };
/** P7-④ 结论卡响应契约：类型定义在纯接线内核里（服务端模块不能进客户端图） */
export type { DecisionView };

export interface FactorFieldDef {
  key: string;
  zh: string;
  category: string;
  source: "kline" | "snapshot";
  verified: boolean; // P1-4：因子测试台通过后运行时覆盖为 true
  unit?: string;
  description?: string;
  formula?: string;
  dependencies?: string[];
  data_requirements?: string;
  implemented?: boolean; // false=已登记未计算（如 高度控盘 需筹码分布）
  status?: "pending_dependency";
  param_n_pending?: boolean;
}

export async function fetchFactorCatalog(): Promise<{ fields: FactorFieldDef[]; category: Record<string, string[]> }> {
  const res = await fetch("/api/quant/factors?catalog=1");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "因子目录获取失败");
  return j;
}

export interface ScreenerRowClient {
  symbol: string;
  name: string;
  industry?: string | null;
  close: number | null;
  change_pct: number | null;
  values: Record<string, number | null>;
  win_prob?: WinProbStats | null;
}

export interface ScreenerRespClient {
  list: ScreenerRowClient[];
  total: number;
  page: { limit: number; offset: number };
  as_of_trade_date: string;
  /** §二 是否历史交易日回放（true=快照口径条件已剔除，仅K线口径参与） */
  trade_date_is_historical?: boolean;
  funnel: { universe: number; snapshot_pass: number; kline_subset: number; kline_pass: number };
  source: { provider: string; note: string; price_basis?: string };
  factors_verified?: boolean;
  factor_verify?: { total: number; enabled: number; verified: number; unverified: number };
  warnings: string[];
  /** P9-经验轮：因数据缺口被忽略的条件字段（非空=结果没按这些条件筛过，「无命中」要读作「字段缺失」） */
  unavailable_fields?: { field: string; zh: string; total: number }[];
}

export async function runScreenerApi(body: {
  // P12-②：行业/概念板成分池（板块页「去选股」带过来；与 screener run.ts 的 UniverseSpec 同形）
  universe?: "all_a" | "hs_a" | { kind: "watchlist"; symbols: string[] } | { kind: "industry" | "concept"; boardCode: string };
  conditions: ScreenerCond[];
  fields?: string[];
  sort?: { order_by?: string; order_dir?: "asc" | "desc" };
  pagination?: { limit?: number; offset?: number };
  include_stats?: boolean;
  maxKlineSymbols?: number;
  trade_date?: string;
}): Promise<ScreenerRespClient> {
  const res = await fetch("/api/quant/screener", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "选股失败");
  return j;
}

export interface SentimentClient {
  ok: boolean;
  as_of: string; trade_date: string; live: boolean;
  total: number; advancers: number; decliners: number; flat: number;
  limit_up: number; limit_down: number;
  touched_limit: number; // 触板数（含已封板）
  limit_up_broken: number; // 炸板数
  break_rate: number | null; // 炸板率 %（触板为0时 null）
  amount_total_yi: number; main_net_sum_yi: number; median_pct: number;
  /**
   * P14：全A快照里成交额真实有值的家数。与 main_net_known 同一纪律——
   * 合计 0 可能是「一家都没抓到」而不是「全市场成交 0 元」，万亿格式换算前必须先问这个数。
   */
  amount_known: number;
  /** 全 A 快照里主力净额真实有值的家数（P11 情绪温度必需：0 时合计是 ?? 0 累加的假 0，资金流分量必按缺读数处理） */
  main_net_known: number;
  indices: { symbol: string; name: string; price: number; changePct: number }[];
  risk: { level: string; triggers: string[] };
  missing: string[];
  source: { provider: string };
}

export async function fetchSentiment(): Promise<SentimentClient> {
  const res = await fetch("/api/market/sentiment");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "市场情绪获取失败");
  return j;
}

// P0补齐·任务B：涨停梯队/连板池
export interface LimitUpStockClient {
  symbol: string; name: string; industry: string | null;
  price: number | null; changePct: number | null;
  boards: number; capped: boolean;
}
export interface LimitUpClient {
  ok: boolean;
  as_of: string; trade_date: string;
  limit_up_count: number; touched_count: number; broken_count: number;
  break_rate: number | null; max_boards: number;
  tiers: { label: string; stocks: LimitUpStockClient[] }[];
  note: string;
  source: { provider: string; kline: string };
  error?: string;
}
export async function fetchLimitUp(): Promise<LimitUpClient> {
  const res = await fetch("/api/market/limitup");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "涨停梯队获取失败");
  return j;
}

// P15-R2a：大盘趋势（两市成交额按日 + vs昨日 + 指数区间累计涨跌）。
// 类型与 /api/market/trend 的返回一一对应；缺数走 missing/notes，界面照实画。
export interface TrendDayPoint { date: string; shYi: number | null; szYi: number | null; totalYi: number | null }
export interface TrendClient {
  ok: boolean;
  range: { from: string; to: string };
  days: TrendDayPoint[];
  delta: { yi: number | null; prev_date: string | null };
  cum: { sh: { date: string; pct: number }[]; sz: { date: string; pct: number }[]; cyb: { date: string; pct: number }[] };
  notes: string[];
  missing: string[];
  source: string;
  error?: string;
}
export async function fetchTrend(from: string, to: string): Promise<TrendClient> {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const res = await fetch(`/api/market/trend?${q.toString()}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "趋势数据获取失败");
  return j;
}

export interface AllStockRow {
  symbol: string; name: string; industry: string | null;
  price: number | null; change_pct: number | null; amount_yi: number | null;
  turnover_rate: number | null; volume_ratio: number | null; amplitude: number | null;
  market_cap_yi: number | null; pe_ttm: number | null; pb: number | null; main_net_yi: number | null;
  st: boolean; suspended: boolean;
}

export async function fetchAllStocks(params: {
  q?: string; industry?: string; order_by?: string; dir?: "asc" | "desc"; page?: number; page_size?: number;
}): Promise<{ list: AllStockRow[]; total: number; page: number; trade_date: string }> {
  const u = new URLSearchParams({ page: String(params.page ?? 1), page_size: String(params.page_size ?? 50) });
  if (params.q) u.set("q", params.q);
  if (params.industry) u.set("industry", params.industry);
  if (params.order_by) { u.set("order_by", params.order_by); u.set("dir", params.dir ?? "desc"); }
  const res = await fetch(`/api/market/allstocks?${u}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "全A列表获取失败");
  return j;
}

// ---------- 个股画像 ----------

export interface ProfileBlock<T> { data: T; source: string; status: string; note?: string }
export interface ProfileResp {
  ok: boolean;
  symbol: string; name: string | null; industry: string | null;
  market_cap_yi: number | null; floatcap_yi: number | null; pe_ttm: number | null; pb: number | null;
  as_of: string;
  session: { open: boolean; phase: string; label: string };
  blocks: {
    quote: ProfileBlock<{ price: number; changePct: number; high: number; low: number; prevClose: number; amountYi: number }> | null;
    depth: ProfileBlock<{
      bids: { price: number; volume: number }[]; asks: { price: number; volume: number }[];
      bidTotalHand: number; askTotalHand: number; insideHand: number; outerHand: number; activeHand: number;
    }> | null;
    trades: ProfileBlock<{ buyAmountYi: number; sellAmountYi: number; netYi: number; outerHand: number; insideHand: number; avgPrice: number; basis: string }> | null;
    fundflow: ProfileBlock<{ todayYi: number | null; spark: number[]; days: { date: string; value: number }[] }> | null;
    tech: ProfileBlock<Record<string, number | null>> | null;
    probability: ProfileBlock<WinProbStats> | null;
    sector: ProfileBlock<{ name: string; changePct: number; rank: number; mainYi: number; count: number }> | null;
    news: ProfileBlock<{ time: string; title: string }[]> | null;
    risk: ProfileBlock<{ level: string; triggers: string[] }> | null;
  };
  missing: string[];
}

export async function fetchStockProfile(symbol: string): Promise<ProfileResp> {
  const res = await fetch(`/api/stock/profile?symbol=${encodeURIComponent(symbol)}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "画像获取失败");
  return j;
}

// ---------- AI 对话（工具调用） ----------

export interface AiChatTrace { name: string; args: Record<string, unknown>; ms: number; status: "ok" | "error"; summary: string }

export async function aiChatTools(
  ai: { provider: string; baseUrl: string; apiKey: string; model: string; proxy?: string },
  messages: { role: "user" | "assistant" | "system"; content: string }[],
  opts?: {
    mode?: string; focusSymbol?: string; contextWindow?: number; timeoutMs?: number;
    /** P11：持仓周期（短/中/长线；未选传 null/不传）——与流式请求体同一份顶层 horizon 键 */
    horizon?: string | null;
    /** P7-⑥④：本机自选清单（服务端不读浏览器存档，自选股场景只能靠请求体里这份） */
    watchlist?: { symbol: string; name?: string | null }[];
    /** P7-⑥⑤：追问要沿用的标的与上一轮场景（都来自上一条助手消息的场景徽章，不是会话字段） */
    sessionSymbol?: string | null; prevScene?: string | null;
  },
): Promise<{ content: string; trace: AiChatTrace[]; steps?: StepInfo[]; intent?: IntentBadge; warning?: string }> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    // P7-⑩：请求头口径并进 ai.ts 的 aiRequestHeaders 一处 —— 流式走 chat-stream-client、
    // 非流式兜底走这里，两份若各判各的「要不要 x-ai-server」，同一次提问的两种传输就会走两个模型。
    // 这里的 ai 形参是历史上的窄结构（provider 是 string），结构上就是 AiSettings，转一次即可。
    headers: aiRequestHeaders(ai as unknown as AiSettings),
    // 非流式兜底用的老契约：一次拿回 {content, trace}，trace 由前端归一成步骤时间线
    body: JSON.stringify({
      messages,
      mode: opts?.mode ?? "decision",
      focusSymbol: opts?.focusSymbol,
      ...(opts?.horizon ? { horizon: opts.horizon } : {}),
      ...(opts?.sessionSymbol ? { sessionSymbol: opts.sessionSymbol } : {}),
      ...(opts?.prevScene ? { prevScene: opts.prevScene } : {}),
      ...(opts?.contextWindow ? { contextWindow: opts.contextWindow } : {}),
      ...(opts?.watchlist?.length ? { watchlist: opts.watchlist } : {}),
    }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `AI 请求失败（${res.status}）`);
  return {
    content: j.content ?? "",
    trace: j.trace ?? [],
    // P7-⑥⑤：非流式没有 step 事件可走，自动调度的步骤与场景徽章随 JSON 一起回，缺了就是界面上一片空白
    ...(Array.isArray(j.steps) && j.steps.length ? { steps: j.steps as StepInfo[] } : {}),
    ...(j.intent ? { intent: j.intent as IntentBadge } : {}),
    ...(j.warning ? { warning: String(j.warning) } : {}),
  };
}

// ---------- P1-1 候选池（服务端冻结 + 次日验证） ----------

export interface PoolRowClient {
  symbol: string;
  name: string;
  close: number | null;
  changePct: number | null;
  reason?: string;
  [k: string]: unknown;
}

export interface PoolSummaryClient {
  pool_id: string;
  created_at: string;
  as_of: string;
  universe: string;
  source: string;
  data_source?: string; // 数据来源口径；旧池未记录时为 ""
  row_count: number;
  has_verify: boolean;
}

export interface PoolVerifyClient {
  verifiedDate: string;
  perSymbol: Record<string, {
    open: number; high: number; low: number; close: number;
    ret1d: number | null; ret5d: number | null; mfe: number; mae: number;
  }>;
}

export interface PoolDetailClient {
  ok: boolean;
  pool_id: string;
  created_at: string;
  as_of: string;
  universe: string;
  conditions: unknown;
  source: string;
  data_source?: string;
  price_basis?: string; // §四：价格口径说明（真实价 vs K线序列口径）
  rows: PoolRowClient[];
  verify: PoolVerifyClient | null;
}

export async function freezePoolApi(body: {
  universe: string;
  conditions: unknown;
  source: string;
  data_source?: string; // screener 响应的 source.provider（数据来源口径）
  rows: PoolRowClient[];
}): Promise<{ pool_id: string; row_count: number }> {
  const res = await fetch("/api/pool/freeze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "冻结失败");
  return j;
}

export async function fetchPoolList(): Promise<PoolSummaryClient[]> {
  const res = await fetch("/api/pool/list");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "候选池列表获取失败");
  return j.list ?? [];
}

export async function fetchPoolDetail(id: string): Promise<PoolDetailClient> {
  const res = await fetch(`/api/pool/${encodeURIComponent(id)}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "候选池详情获取失败");
  return j;
}

export async function runPoolVerify(id: string): Promise<
  { status: "pending"; message: string } | { status: "verified"; verify: PoolVerifyClient }
> {
  const res = await fetch(`/api/pool/${encodeURIComponent(id)}/verify`, { method: "POST" });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "验证失败");
  return j;
}

// ---------- P1-4 因子有效性测试台 ----------

export interface FactorTestResultClient {
  field: string;
  fieldZh?: string;
  horizon: number;
  testedAt: string;
  passed: boolean;
  passRule: string;
  note?: string;
  metrics: {
    ic: number; rankIc: number; icIr: number;
    groupAnnual: number[]; monotonicity: number; turnover: number;
    monthlyWinRate: number; maxDrawdown: number;
    sample: { dates: number; stocks: number; validPairs: number };
    dataRange: string;
  };
  monthlyIc?: { month: string; rankIc: number }[];
  icSeriesLite?: { date: string; rankIc: number }[];
}

export async function runFactorTestApi(body: {
  field: string; horizon?: number; maxStocks?: number; lookback?: number;
}): Promise<FactorTestResultClient> {
  const res = await fetch("/api/quant/factor-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "因子测试失败");
  return j.result;
}

export async function fetchFactorTests(field?: string): Promise<{ tests: FactorTestResultClient[] }> {
  const res = await fetch(`/api/quant/factor-test${field ? `?field=${encodeURIComponent(field)}` : ""}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "因子测试记录获取失败");
  return j;
}

// ---------- P1-5 选股结果存为策略 ----------

export async function saveScanAsStrategyApi(body: {
  strategyKey: string;
  name: string;
  factorRefs: { factorKey: string }[];
  selection: Record<string, unknown>;
  note?: string;
}): Promise<{ strategyKey: string; version: number }> {
  const res = await fetch("/api/quant/strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, kind: "rule", status: "Candidate" }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || "存为策略失败");
  return { strategyKey: j.strategy?.strategyKey ?? body.strategyKey, version: j.strategy?.version ?? 1 };
}

// ---------- P2 ----------

/** §二 历史交易日选择器数据源：真实交易日（上证指数日线），倒序 */
export async function fetchTradeDates(count = 120): Promise<{ as_of_trade_date: string; dates: string[] }> {
  const res = await fetch("/api/quant/screener/trade-dates?count=" + count);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || '交易日列表获取失败');
  return { as_of_trade_date: j.as_of_trade_date, dates: j.dates };
}

export interface RiskClient extends SentimentClient {
  suggestions: string[];
  history_ref: {
    today_return: number | null;
    band: number;
    sample_size: number;
    sample_ok: boolean;
    period: { start: string; end: string } | null;
    horizons: { h: number; win_rate: number | null; sample_size: number; avg_return: number | null; median_return: number | null; worst_return: number | null }[];
    warnings: string[];
  } | null;
  history_ref_note: string;
}

export async function fetchRisk(): Promise<RiskClient> {
  const res = await fetch("/api/market/risk");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "风险数据获取失败");
  return j;
}

export interface ThemeRowClient {
  code: string; name: string; changePct: number; mainYi: number; rps: number;
  diffusion: number | null; streakPct: number | null; streakInflow: number | null;
  score: number; role: string; reasons: string[];
}
export interface ThemeDiscoveryClient {
  as_of: string; trade_date: string;
  main: ThemeRowClient[]; sub: ThemeRowClient[]; rotation: ThemeRowClient[]; watch: ThemeRowClient[];
  missing: string[];
  source: { provider: string; note: string };
}
export async function fetchThemes(force = false): Promise<ThemeDiscoveryClient> {
  const res = await fetch(`/api/market/themes${force ? "?force=1" : ""}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "主线发现失败");
  return j;
}

export interface ProbabilityResp {
  as_of_trade_date: string;
  /** §二 历史交易日回放标记 */
  trade_date_is_historical?: boolean;
  /** §六 基准指数（沪深300）实际取到的K线根数；0=数据缺失 */
  benchmark?: { symbol: string; name: string; bars: number };
  universe: string;
  sample_ok: boolean;
  warnings: string[];
  pooled: {
    h: number; win_rate: number | null; avg_return: number | null; sample_size: number; symbols_used: number;
    benchmark_return?: number | null; excess_return?: number | null; max_drawdown?: number | null;
  }[];
  per_symbol: {
    symbol: string; name: string; bars: number; error: string | null;
    stats: WinProbStats | null;
  }[];
}
export async function runProbabilityApi(body: {
  conditions: ScreenerCond[]; universe?: "index" | "custom"; symbols?: string[]; lookback?: number; trade_date?: string;
}): Promise<ProbabilityResp> {
  const res = await fetch("/api/quant/probability", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "概率计算失败");
  return j;
}

export interface RadarItemClient {
  id?: string; kind: string; title: string; detail: string; evidence?: Record<string, unknown>;
}
/** P3 增量口径：本次实际采用的写库方式与逐类计数（由服务端如实返回，不在前端推断） */
export type ScanModeClient = "full" | "incremental";
export interface ScanDeltaClient {
  scanned: number; inserted: number; updated: number; unchanged: number;
  skippedByCursor: number; superseded: number; kept: number; collapsed: number;
}
// 口径文案只有一份实现：incremental-core 是无依赖纯模块，前端直接复用，避免服务端/页面各写一句而对不上
export { MODE_TEXT, modeFromBasis };

/**
 * 手动扫描结果的一行如实说明（P3）：口径 + 本次写库明细。
 * 数值全部来自服务端返回的 delta，不在前端推断；只讲「写了多少行」，不讲「数据有多新」。
 */
export function scanResultNote(
  kind: "radar" | "events",
  mode?: ScanModeClient | null,
  delta?: ScanDeltaClient | null,
): string {
  if (!mode) return "";
  const head = kind === "radar" ? "候选信号" : "快讯窗口";
  const parts = delta ? [
    `${head} ${delta.scanned}`,
    `新增 ${delta.inserted}`,
    `更新 ${delta.updated}`,
    `未变 ${delta.unchanged}`,
    delta.skippedByCursor ? `游标跳过 ${delta.skippedByCursor}` : "",
    mode === "full" && delta.collapsed ? `同键合并 ${delta.collapsed}` : "",
    delta.superseded ? `标记消失 ${delta.superseded}` : "",
    delta.kept ? `保留 ${delta.kept}` : "",
  ].filter(Boolean).join("、") : "";
  return `本次口径：${MODE_TEXT[mode]}${parts ? `（${parts}）` : ""}`;
}
export async function fetchRadar(): Promise<{ as_of: string; scanned: boolean; superseded_today?: number; items: RadarItemClient[] }> {
  const res = await fetch("/api/radar");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "雷达读取失败");
  return j;
}
export async function scanRadar(): Promise<{
  as_of: string; trade_date: string; mode?: ScanModeClient | null; delta?: ScanDeltaClient | null;
  superseded_today?: number; missing?: string[]; items: RadarItemClient[];
}> {
  const res = await fetch("/api/radar", { method: "POST" });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "雷达扫描失败");
  return j;
}

export interface EventItemClient {
  id: string; title: string; time: string; level: string; category: string;
  mappedSectors: string[]; relatedStocks: string[];
  fundCheck: { stage?: string; note?: string; boards?: { name: string; changePct: number; mainYi: number; rank: number }[] };
  stage: string; source: string;
}
export async function fetchEvents(): Promise<{ as_of: string; items: EventItemClient[] }> {
  const res = await fetch("/api/events");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "事件列表失败");
  return j;
}
export async function scanEvents(): Promise<{
  trade_date: string; unmatched?: number; missing?: string[];
  mode?: ScanModeClient | null; delta?: ScanDeltaClient | null;
  items: EventItemClient[];
}> {
  const res = await fetch("/api/events", { method: "POST" });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "事件扫描失败");
  return j;
}

// ---------- P4 历史查询（只读归档：按 asOf 取 radar_finding / global_event 的真实库行） ----------

export interface RadarHistoryItemClient {
  id: string; as_of: string; kind: string; title: string; detail: string;
  evidence: Record<string, unknown>; evidence_broken: boolean;
  state: string; state_label: string; superseded: boolean;
  created_at: string; source: string; source_basis: string;
}
export interface EventHistoryItemClient {
  id: string; as_of: string; title: string; time: string; level: string; category: string;
  mapped_sectors: string[]; related_stocks: string[];
  fund_check: { stage?: string; note?: string; boards?: { name: string; changePct: number; mainYi: number; rank: number }[] } & Record<string, unknown>;
  stage: string; source: string; created_at: string;
  chain_mapped: boolean; broken_columns: string[];
}
/** 可查询日期（服务端 groupBy 聚合出来的真实行数，页面据此生成日期入口，不凭空列日期） */
export interface HistoryDateBucket { date: string; rows: number; live: number; superseded: number | null; is_today: boolean }
/** 某天的扫描运行记录（task_run 行）：回答「这批历史数据是谁、用什么口径写进库的」 */
export interface HistoryRunClient {
  id: string; status: string; trigger: string; trigger_label: string;
  started_at: string; finished_at: string | null; scanned: number; results: number;
  error: string; basis: string; note: string; mode: string; mode_label: string; missing: string[];
}
export interface HistoryCountsClient { rows: number; live: number; superseded: number | null }
export interface HistoryRespClient<T> {
  ok: boolean; error?: string;
  kind: "radar" | "events";
  /** null = 库里还没有任何归档日（此时 items 必为空，页面不得显示"今天"的数据冒充历史） */
  date: string | null;
  is_today: boolean; today: string;
  date_basis: string; view_basis: string;
  state_filter: string; state_filter_basis: string;
  counts: HistoryCountsClient;
  items: T[];
  available_dates: HistoryDateBucket[];
  runs: HistoryRunClient[];
  /** 当天 task_run 的总条数（库里 COUNT）；runs 只是倒序的最近若干条，页面必须据此说明「还有多少条没列出」 */
  runs_total: number;
  missing: string[];
}

async function fetchHistory<T>(path: string, params: { date?: string; state?: string }): Promise<HistoryRespClient<T>> {
  const u = new URLSearchParams();
  if (params.date) u.set("date", params.date);
  if (params.state) u.set("state", params.state);
  const qs = u.toString();
  const res = await fetch(`${path}${qs ? `?${qs}` : ""}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "历史查询失败");
  return j as HistoryRespClient<T>;
}
/** date 不传 = 库内最近有数据的归档日；查无此日返回空 items + missing 说明，不会回退到今天 */
export function fetchRadarHistory(params: { date?: string; state?: "all" | "live" | "superseded" } = {}) {
  return fetchHistory<RadarHistoryItemClient>("/api/radar/history", params);
}
export function fetchEventsHistory(params: { date?: string } = {}) {
  return fetchHistory<EventHistoryItemClient>("/api/events/history", params);
}

// ---------- P6-B AI 事件理解（服务端出事实 + 复校验落库；客户端只负责调模型） ----------
// 类型直接复用纯内核的接口定义，避免前后端各写一份字段清单而漂移（§九 的 17 字段以内核为准）。

/** GET /api/events/interpret/prompt 的返回（服务端从 global_event 现取事实组装） */
export interface InterpretPromptClient {
  ok: boolean; date: string; system: string; prompt: string; prompt_version: string;
  facts: EventFact[]; basis: string; missing: string[]; error: string | null;
  interpretation_status: string; how_to_use: string; note: string;
  total_rows: number; selected: number; limited: boolean;
}
/** GET /api/events/interpret 的单行（含服务端派生的 stale/orphan 对照结果） */
export type InterpretationViewClient = EventInterpretation & {
  row_id: string; stale: boolean; orphan: boolean; payload_broken: boolean;
};
export interface InterpretLoadClient {
  ok: true; as_of: string; today: string;
  items: InterpretationViewClient[];
  available_dates: { date: string; rows: number }[];
  counts: {
    rows: number; interpreted: number; partial: number; rejected: number;
    stale: number; orphan: number; violations: number; hypothesis_symbols: number;
  };
  layering: string; missing: string[];
  self_check: { broken_payload: string[]; missing_fields: string[] };
  basis: string; probed_at: string;
}
export interface InterpretStoreClient {
  ok: boolean; date: string; persisted: number; updated: number; inserted: number;
  items: EventInterpretation[];
  missing: { event_id: string; title: string; reason: string }[];
  unknown_ids: string[]; parse_failed: boolean; error: string | null;
  counts: ReturnType<typeof summarizeInterpretations>["counts"];
  layering: string; basis: string; interpretation_status?: string;
}

export async function fetchInterpretPrompt(params: { date?: string; ids?: string[]; limit?: number } = {}): Promise<InterpretPromptClient> {
  const u = new URLSearchParams();
  if (params.date) u.set("date", params.date);
  if (params.ids?.length) u.set("ids", params.ids.join(","));
  if (params.limit) u.set("limit", String(params.limit));
  const qs = u.toString();
  const res = await fetch(`/api/events/interpret/prompt${qs ? `?${qs}` : ""}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "没有可用于 AI 理解的真实事件（服务端会说明原因，不会去猜一条新闻）");
  return j as InterpretPromptClient;
}

export async function fetchInterpretations(date = ""): Promise<InterpretLoadClient> {
  const res = await fetch(`/api/events/interpret${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "事件理解结果读取失败");
  return j as InterpretLoadClient;
}

export async function storeInterpretationsApi(body: { raw: string; model?: string; date?: string; ids?: string[] }): Promise<InterpretStoreClient> {
  const res = await fetch("/api/events/interpret", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  // 这里不能用 !j.ok 抛错：ok=false 时服务端仍然带着「为什么一条都没落库」的原因与留痕，页面要原样显示
  return { ...j, __status: res.status } as InterpretStoreClient & { __status: number };
}

// ---------- P6-C AI Market Research（服务端出现场台账 + 复校验落库；客户端只负责调模型） ----------
// 类型同样复用纯内核：EvidenceLine/ResearchReport/SourceProbe 只有一份定义（§十三 的七层以它为准）。

/** GET /api/research/prompt：服务端从已有引擎与库里现取读数组装的台账 + 提示词 */
export interface ResearchPromptClient {
  ok: boolean; scope: string; date: string; as_of: string;
  lines: EvidenceLine[]; sources: SourceProbe[]; missing: string[];
  truncated: number; basis: string; question: string;
  system: string; prompt: string; prompt_version: string; error: string | null;
  report_status: string; how_to_use?: string; note?: string;
}
/** GET /api/research：只读回看已落库的报告（台账用落库时冻结的那一份回显） */
export interface ResearchLoadClient {
  ok: boolean; as_of: string; today: string; scope: string;
  report: (ResearchReport & { report_key: string; stale_evidence: boolean }) | null;
  evidence: EvidenceLine[]; sources: SourceProbe[]; missing: string[];
  available_dates: { date: string; status: string; question: string }[];
  counts: { rows: number; interpreted: number; partial: number; rejected: number };
  layering: string; self_check: { broken_payload: string[] }; basis: string; probed_at: string;
  error: string | null;
}
/** POST /api/research：服务端重新现取台账复校验后的落库结果 */
export interface ResearchStoreClient {
  ok: boolean; persisted: boolean; scope: string; date: string; report_key: string;
  report: ResearchReport | null; evidence_total: number; missing: string[]; sources: SourceProbe[];
  error: string | null; basis: string; report_status: string;
}

export async function fetchResearchPrompt(params: { question?: string; scope?: string } = {}): Promise<ResearchPromptClient> {
  const u = new URLSearchParams();
  if (params.question) u.set("question", params.question);
  if (params.scope) u.set("scope", params.scope);
  const qs = u.toString();
  const res = await fetch(`/api/research/prompt${qs ? `?${qs}` : ""}`);
  const j = await res.json();
  // 台账为空时服务端给的是 ok=false + 原因：这里不抛成「未知错误」，把原因原样交给页面显示
  if (!res.ok || !j.ok) throw new Error(j.error || "服务端没有取到可解释的真实读数（详见缺失口径）");
  return j as ResearchPromptClient;
}

export async function fetchResearchReport(date = "", scope = ""): Promise<ResearchLoadClient> {
  const u = new URLSearchParams();
  if (date) u.set("date", date);
  if (scope) u.set("scope", scope);
  const qs = u.toString();
  const res = await fetch(`/api/research${qs ? `?${qs}` : ""}`);
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "研究报告读取失败");
  return j as ResearchLoadClient;
}

export async function storeResearchApi(body: { raw: string; question?: string; model?: string; scope?: string }): Promise<ResearchStoreClient> {
  const res = await fetch("/api/research", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  // 422/400/413 都带着结构化的「为什么没落库」，页面必须原样显示，不能只报「请求失败」
  return { ...j, __status: res.status } as ResearchStoreClient & { __status: number };
}

// ---- 后台任务运行记录（P2-自动化 13）：只读 /api/tasks/status，展示真实落库的 task_run 行 ----
export interface TaskRunClient {
  id: string; kind: string; trade_date: string; status: string; trigger: string;
  started_at: string; finished_at: string | null; duration_ms: number | null;
  scanned: number; results: number; missing: string[]; error: string; basis: string; note: string;
}
/** P3 当日增量游标：exists=false 表示今天还没有成功扫描过，下一次执行会走全量口径（服务端如实返回） */
export interface TaskCursorClient {
  kind: string; trade_date: string; exists: boolean; watermark: string;
  done_keys: number; unmatched_keys: number; scanned: number; results: number;
  basis: string; note: string; updated_at: string | null;
}
export interface TaskStatusClient {
  as_of: string; enabled: boolean; running: boolean; tick_seconds: number;
  config: { closeMinute: number; delayMinutes: number; maxAttempts: number };
  today: string; due_now: boolean; slot_at: string | null;
  next: { trade_date: string; at: string };
  last_outcome: string; last_tick_at: string | null;
  today_summary: {
    kind: string; settled: boolean; attempts: number; last_status: string; last_trigger: string;
    last_finished_at: string | null; last_error: string; cursor?: TaskCursorClient;
  }[];
  today_runs: TaskRunClient[]; recent_runs: TaskRunClient[];
  boundary: string;
}
export async function fetchTaskStatus(): Promise<TaskStatusClient> {
  const res = await fetch("/api/tasks/status");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "任务记录读取失败");
  return j;
}

// ---------- P5 数据生命周期（dry-run 预览 + 人工确认后手动执行；保留天数 180 天由用户定，接口无参数） ----------

export interface LifecycleCandidateClient {
  table: "radar_finding" | "global_event"; date: string; rows: number;
  live: number; superseded: number; age_days: number;
}
export interface LifecycleProtectedClient extends Omit<LifecycleCandidateClient, "age_days"> { reason: string }
export interface LifecyclePreviewClient {
  ok: true; kind: "lifecycle"; today: string; retention_days: number; cutoff: string; basis: string;
  /** 「谁定的天数 / 怎么删 / 谁来触发」三条口径，页面原样显示 */
  policy_notes: string[];
  /** live/superseded 一起进候选的说明 */
  state_note: string;
  totals: { candidate_days: number; candidate_rows: number; protected_days: number; protected_rows: number };
  candidates: LifecycleCandidateClient[];
  protected_days: LifecycleProtectedClient[];
  /** 执行清理必须带回这个指纹；预览之后库里数据变了就失效（409），不会按旧计划删 */
  plan_hash: string;
  can_execute: boolean;
  detail_rows_in_db: number;
  /** 只报告、不清理的运行记录表 */
  run_tables: { expired: { table: "task_run" | "scan_cursor"; rows: number }[]; note: string };
  missing: string[];
}
export async function fetchLifecyclePreview(): Promise<LifecyclePreviewClient> {
  const res = await fetch("/api/lifecycle/preview");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "生命周期预览读取失败");
  return j as LifecyclePreviewClient;
}

export interface PurgePerDayClient { table: string; date: string; count: number }
export interface PurgeResultClient {
  ok: true; deleted: number; rows_deleted: number; per_day: PurgePerDayClient[];
  export: { path: string; abs_path: string; bytes: number; row_count: number } | null;
  detail_rows_in_db_before: number; detail_rows_in_db_after: number;
  plan_hash: string; cutoff: string; retention_days: number; today: string; note: string;
}
/**
 * 真正会删正式库明细行的唯一入口：confirm 必须逐字为 "PURGE_EXPIRED_ROWS"，
 * plan_hash 必须来自刚拿到的 dry-run 预览。失败时服务端保证「未删除任何行」，页面要把这句原样显示。
 */
export async function purgeLifecycleApi(body: { confirm: string; plan_hash: string }): Promise<PurgeResultClient> {
  const res = await fetch("/api/lifecycle/purge", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(`${j.error || "清理执行被拒绝"}${j.note ? `｜${j.note}` : ""}`);
  return j as PurgeResultClient;
}

// ---------- P5 每日留档（Risk / Themes / Probability 三页：服务端同源重算后落库，前端不传结果数字） ----------

export interface SnapshotItemClient {
  id: string; kind: SnapshotKindClient; trade_date: string; computed_at: string;
  /** 服务端按当次 payload 生成的人话摘要 */
  headline: string; missing: string[]; source: string;
  payload: unknown; payload_broken: boolean;
}
export interface SnapshotSaveClient {
  ok: true; kind: SnapshotKindClient; id: string; trade_date: string; computed_at: string;
  headline: string; scope?: string; missing: string[]; source: string; basis: string; note: string;
}
export interface SnapshotRespClient {
  ok: true; kind: SnapshotKindClient; table: string; label: string; today: string;
  /** null = 未指定日期（返回最近若干条） */
  date: string | null; date_basis: string; basis: string;
  counts: { total: number; days: number; returned: number };
  available_dates: { date: string; count: number }[];
  items: SnapshotItemClient[];
  missing: string[];
}
export type SnapshotKindClient = "risk" | "themes" | "probability";

/** 点「留档今天」：服务端当场重算一次（真的会拉行情，耗时同页面刷新），把当次结果写进快照表 */
export async function archiveSnapshotApi(kind: SnapshotKindClient, body?: unknown): Promise<SnapshotSaveClient> {
  const res = await fetch(`/api/snapshot/${kind}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "留档失败");
  return j as SnapshotSaveClient;
}
/** 留档回看：date 不传 = 最近若干条；那天没留过则返回空 items + missing 说明，不会拿别的日子顶上 */
export async function fetchSnapshots(kind: SnapshotKindClient, date = ""): Promise<SnapshotRespClient> {
  const u = new URLSearchParams({ kind });
  if (date) u.set("date", date);
  const res = await fetch(`/api/snapshot?${u.toString()}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "留档读取失败");
  return j as SnapshotRespClient;
}

// ---------- P6-A：数据能力登记表 / 能力探测（只读） ----------
// 面板自己不判定任何状态：kind / status / usable 全部照服务端探测结果原样显示，
// 服务端未探测的（probed:false）在这里也只能显示「未探测」，绝不允许显示成 0 或「暂无数据」以外的数值。
import type { CapabilityDef } from "@/lib/quant/screener/capability-core";

export interface CapabilityProbeClient {
  name: string; title: string; group: string; availability: string; mutating: boolean;
  freshness: "live" | "intraday" | "daily" | "static";
  /** false = 本次没测（不是「没数据」） */
  probed: boolean;
  kind: "value" | "real_zero" | "no_data" | "request_failed" | "not_covered" | null;
  usable: boolean;
  status: string;
  note: string; reason: string;
  /** direct=真取了该能力的数据 / channel=只验证同接口族可达 / db|static|local=读本地 */
  scope: string;
  evidence: Record<string, string | number | boolean | null>;
  as_of: string | null; freshness_s: number | null;
  /** true=口径内 / false=确认超上限 / null=无时刻可核对（未知，不能显示成「超出上限」） */
  fresh: boolean | null;
  display: string; degraded_from: string | null;
  fallbacks: string[]; limitations: string[];
}
export interface CapabilitiesProbeClient {
  ok: true; probed_at: string; today: string; live: boolean; cached: boolean; cache_age_s: number | null;
  basis: string; gateway_note: string; upstream_calls: number;
  probes: CapabilityProbeClient[]; counts: Record<string, number>;
  layering: string; missing: string[]; unprobed: string[];
  self_check: { rule: string; unusable_statuses: string[]; violations: string[] };
}
export interface CapabilitiesRegistryClient {
  ok: true; kind: "capabilities"; basis: string;
  groups: { group: string; items: CapabilityDef[] }[];
  group_order: string[];
  counts: { total: number; read_only: number; mutating: number; not_covered: number };
  not_covered: { name: string; title: string; why: string }[];
  answer: { 可用: string[]; 当前取不到: string[]; 无可靠来源: string[]; 说明: string };
  read_only_names: string[];
  total: number;
}

/** 登记表（不探测、不碰网络） */
export async function fetchCapabilitiesRegistry(): Promise<CapabilitiesRegistryClient> {
  const res = await fetch("/api/capabilities");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "能力登记表读取失败");
  return j as CapabilitiesRegistryClient;
}
/** 能力探测：live=true 才会真的打上游（固定几个小请求，20 秒内复用） */
export async function fetchCapabilityProbe(opts: { live?: boolean; force?: boolean } = {}): Promise<CapabilitiesProbeClient> {
  const u = new URLSearchParams();
  if (opts.live) u.set("live", "1");
  if (opts.force) u.set("force", "1");
  const q = u.toString();
  const res = await fetch(`/api/capabilities/probe${q ? `?${q}` : ""}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "能力探测失败");
  return j as CapabilitiesProbeClient;
}
/** 需求 → 候选能力（匹配不上返回空数组：这就是缺口，页面要原样说） */
export async function fetchCapabilitiesForNeed(need: string): Promise<{
  ok: true; need: string; matches: CapabilityDef[]; match_note: string;
  hits?: { name: string; matched: string[] }[];
  order_note?: string; gap_groups?: string[];
}> {
  const res = await fetch(`/api/capabilities?need=${encodeURIComponent(need)}`);
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "需求匹配失败");
  return j;
}

// ---------- P6-D Agent 自主工具调用（/api/agent/*） ----------
//
// 这些封装一律「不抛 4xx」：状态码背后的 body 就是页面要显示的事实（为什么没记账、为什么没落库），
// 抛成异常会让 §三十一 的「错误结构与成功同形」在页面上退化成一句「请求失败」。
// 只有真的没拿到 JSON（网关/HTML 错误页）才抛，并且抛的也是这件事本身。

/** 一次工具调用的日志行（§十八）。字段名与服务端 rowToLog 同一份：走一步的 call 与回看的 timeline 同形 */
export interface AgentCallRowClient {
  run_id?: string; step?: number; tool?: string; capability?: string; executor?: string;
  input?: Record<string, unknown>;
  output_status?: string; kind?: string | null; data_status?: string | null;
  source?: string; as_of?: string;
  /** null = 什么都没执行（被准入挡下）；0 也可能是「查本地缓存」的真实耗时，两者不许互相冒充 */
  latency_ms?: number | null;
  error?: string; fallback_of?: string; degraded_from?: string; attempt?: number;
  call_key?: string; cached_from?: string; evidence_id?: string;
  thought?: string; summary?: string;
  notes?: string[]; refs?: string[]; timestamp?: string;
}

export interface AgentLedgerRowClient {
  id: string; layer: string; text: string; capability: string; source: string;
  as_of: string; data_status: string; tool: string; step: number; refs: string[];
}

export interface AgentLineageRowClient {
  evidence_id: string; tool: string; executor: string | null; source: string; as_of: string;
  /** null = 那行的分层值不认识：页面按 data_status_raw 原样显示，不猜它算事实还是派生 */
  data_status: string | null; data_status_raw: string; step: number; call_key: string; refs: string[];
}

export interface AgentBudgetClient {
  max_steps: number; max_tool_calls: number; max_retries_per_tool: number; max_total_ms: number; max_evidence_lines: number;
}
export interface AgentBudgetLeftClient { steps: number; tool_calls: number; ms: number; retries_left: number; evidence_lines: number }
export interface AgentNextTurnClient { action: string; reason: string | null; detail: string }
export interface AgentObservationClient {
  kind: string | null; data_status: string | null; source: string | null; as_of: string | null;
  summary: string; reason: string | null; notes: string[]; degraded_from: string | null; timed_out: boolean; payload: unknown;
}
export interface AgentDeadEndClient {
  failure: string | null; reason: string; retryable: boolean; has_fallback: boolean;
  fallback_tools: string[]; next_action: string; user_note: string;
}
/** summarizeRun 的返回是宽对象：这里只声明页面上会读的那几项 */
export interface AgentSummaryClient {
  run_id?: string; question?: string; steps?: number; tool_calls?: number; distinct_tools?: number;
  evidence_lines?: number; missing_lines?: number; fallback_used?: number; cached_hits?: number;
  latency_total_ms?: number; stop_reason?: string | null; stop_detail?: string;
  answer_status?: string | null; log_status_counts?: string; protocol?: string;
}
/** 带状态码的返回：页面按 __status 区分「200 但没执行」与「409 已收尾」，不靠猜中文 */
export type AgentApi<T> = T & { __status: number };

async function agentJson<T>(res: Response): Promise<AgentApi<T>> {
  const j = (await res.json().catch(() => null)) as T | null;
  if (!j) throw new Error(`接口没有返回 JSON（HTTP ${res.status}）：本页面不猜结果，也不会把错误页当成「跑过了」`);
  return { ...j, __status: res.status } as AgentApi<T>;
}

export interface AgentStartResultClient {
  ok: boolean; error: string | null; run_id: string; resumed: boolean; status: string; question: string;
  budget: AgentBudgetClient | null; budget_notes: string[]; missing: string[];
  prompt: { system: string; turn: string; protocol: string };
  next_turn: AgentNextTurnClient; summary: AgentSummaryClient; basis: string;
}
/** POST /api/agent/run：开一次运行（同一 run_id 再提交是续开，不是重建） */
export async function agentRunApi(body: {
  run_id: string; question: string; budget?: Partial<AgentBudgetClient>; model?: string;
}): Promise<AgentApi<AgentStartResultClient>> {
  const res = await fetch("/api/agent/run", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return agentJson<AgentStartResultClient>(res);
}

export interface AgentStepResultClient {
  ok: boolean; error: string | null; run_id: string; admitted: boolean;
  call: AgentCallRowClient; params_effective: Record<string, unknown>;
  observation: AgentObservationClient; dead_end: AgentDeadEndClient | null;
  budget_left: AgentBudgetLeftClient; evidence_lines: number; missing: string[];
  next_turn: AgentNextTurnClient; prompt: { turn: string } | null;
  summary: AgentSummaryClient; basis: string;
}
/** POST /api/agent/tool：走一步。取数失败/没有数据/能力不支持都是 200——这一步真的记了账 */
export async function agentToolApi(body: {
  run_id: string; tool: string; args?: Record<string, unknown>; thought?: string; timeout_ms?: number;
}): Promise<AgentApi<AgentStepResultClient>> {
  const res = await fetch("/api/agent/tool", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return agentJson<AgentStepResultClient>(res);
}

export interface AgentAnswerCheckClient {
  status: string; answer: string; cites_valid: string[]; cites_invalid: string[];
  unsourced_numbers: { claim: string; value?: number; where?: string }[];
  historical_as_current: string[]; probability_gaps: string[]; unused_evidence: string[];
  violations: string[]; gaps: string[]; lineage: AgentLineageRowClient[];
}
export interface AgentFinalizeResultClient {
  ok: boolean; error: string | null; persisted: boolean; run_id: string;
  directive: { kind: string; thought: string } | null;
  check: AgentAnswerCheckClient | null; summary: AgentSummaryClient; missing: string[]; basis: string;
}
/** POST /api/agent/finalize：把模型**原文**交给服务端解析与复校验（前端解析结果只用于路由，不参与判定） */
export async function agentFinalizeApi(body: { run_id: string; raw: string; model?: string }): Promise<AgentApi<AgentFinalizeResultClient>> {
  const res = await fetch("/api/agent/finalize", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return agentJson<AgentFinalizeResultClient>(res);
}

export interface AgentRunListItemClient {
  run_id: string; question: string; status: string; answer_status: string; stop_reason: string;
  steps: number; tool_calls: number; evidence_lines: number; missing_lines: number; started_at: string; elapsed_ms: number;
}
export interface AgentRunListClient {
  ok: boolean; error: string | null; mode: string; runs: AgentRunListItemClient[]; take: number; basis: string;
}
/** GET /api/agent/run（不带 run_id）：最近若干次运行的摘要列表 */
export async function fetchAgentRunList(take = 20): Promise<AgentApi<AgentRunListClient>> {
  const res = await fetch(`/api/agent/run?take=${take}`);
  return agentJson<AgentRunListClient>(res);
}

export interface AgentRunViewClient {
  ok: boolean; error: string | null; run_id: string; mode: string;
  question?: string; status?: string; model?: string; protocol?: string; prompt_version?: string;
  budget?: AgentBudgetClient; budget_notes?: string[]; budget_left?: AgentBudgetLeftClient;
  timeline?: AgentCallRowClient[]; ledger?: AgentLedgerRowClient[]; evidence_snapshot?: unknown[];
  missing?: string[];
  answer_status?: string; answer_text?: string; answer_cites?: string[]; answer_cites_missing?: string[];
  answer_gaps?: string[]; violations?: string[]; unused_evidence?: string[]; lineage?: AgentLineageRowClient[];
  stop_reason?: string; stop_detail?: string;
  rebuild_check?: { stored: Record<string, number>; rebuilt: Record<string, number>; rows: number; consistent: boolean; unknown_layer_rows: unknown[] };
  summary?: AgentSummaryClient; started_at?: string; finished_at?: string; elapsed_ms?: number; basis?: string;
}
/** GET /api/agent/run?run_id=：完整回看（时间线 + 台账 + 血缘 + 预算 + 答案与违规项） */
export async function fetchAgentRunView(runId: string): Promise<AgentApi<AgentRunViewClient>> {
  const res = await fetch(`/api/agent/run?run_id=${encodeURIComponent(runId)}`);
  return agentJson<AgentRunViewClient>(res);
}

export interface AgentToolDefClient {
  name: string; title: string; description: string; capability: string; group: string; executor: string | null;
  input_schema: unknown; input_note: string; output_schema: string;
  source: string; source_type: string; freshness: string; data_status: string; availability: string;
  risk_level: string; side_effect: string; enabled: boolean; fallbacks: string[];
  limitations: string[]; examples: string[]; timeout_ms: number | null; disabled_reason: string | null;
}
export interface AgentToolsCatalogClient {
  ok: boolean; error: string | null; total: number; enabled: number; disabled: number;
  tools: AgentToolDefClient[]; catalog_text: string;
  budget: { default: AgentBudgetClient; hard_caps: AgentBudgetClient };
  self_check: { unimplemented_executors: string[]; read_only_violations: string[] };
  basis: string;
}
/** GET /api/agent/tools：工具目录 + 自检（假能力与越界条目由服务端点名，页面原样显示） */
export async function fetchAgentTools(): Promise<AgentApi<AgentToolsCatalogClient>> {
  const res = await fetch("/api/agent/tools");
  return agentJson<AgentToolsCatalogClient>(res);
}

/**
 * GET /api/quant/decision?symbol= — P7-④ 四维决策结论（只读：不写库、不扫描、不调模型）。
 * 失败时把服务端原文（含「为什么这一维没算进来」）抛给调用方显示，不静默回退成空结论。
 */
export async function fetchDecisionView(symbol: string): Promise<DecisionView> {
  const res = await fetch(`/api/quant/decision?symbol=${encodeURIComponent(symbol)}`);
  const j = (await res.json().catch(() => null)) as (DecisionView & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !j || j.ok !== true) throw new Error(j?.error || `决策结论获取失败（HTTP ${res.status}）`);
  return j;
}
