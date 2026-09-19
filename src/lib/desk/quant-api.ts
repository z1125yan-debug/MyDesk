"use client";
// 前端 → 新 P0 后端接口的类型化封装
import type { ScreenerCond, WinProbStats } from "@/lib/quant/factors/probability";

export type { ScreenerCond, WinProbStats };

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
}

export async function runScreenerApi(body: {
  universe?: "all_a" | "hs_a" | { kind: "watchlist"; symbols: string[] };
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
  messages: { role: "user" | "assistant"; content: string }[],
  opts?: { mode?: string; focusSymbol?: string; timeoutMs?: number },
): Promise<{ content: string; trace: AiChatTrace[] }> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-provider": ai.provider,
      "x-ai-base-url": ai.baseUrl,
      "x-ai-api-key": ai.apiKey,
      "x-ai-model": ai.model,
      ...(ai.proxy?.trim() ? { "x-ai-proxy": ai.proxy.trim() } : {}),
    },
    body: JSON.stringify({ messages, mode: opts?.mode ?? "decision", focusSymbol: opts?.focusSymbol }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `AI 请求失败（${res.status}）`);
  return { content: j.content ?? "", trace: j.trace ?? [] };
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
export async function fetchRadar(): Promise<{ as_of: string; scanned: boolean; items: RadarItemClient[] }> {
  const res = await fetch("/api/radar");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "雷达读取失败");
  return j;
}
export async function scanRadar(): Promise<{ as_of: string; trade_date: string; missing?: string[]; items: RadarItemClient[] }> {
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
  trade_date: string; unmatched?: number; missing?: string[]; items: EventItemClient[];
}> {
  const res = await fetch("/api/events", { method: "POST" });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "事件扫描失败");
  return j;
}

// ---- 后台任务运行记录（P2-自动化 13）：只读 /api/tasks/status，展示真实落库的 task_run 行 ----
export interface TaskRunClient {
  id: string; kind: string; trade_date: string; status: string; trigger: string;
  started_at: string; finished_at: string | null; duration_ms: number | null;
  scanned: number; results: number; missing: string[]; error: string; basis: string; note: string;
}
export interface TaskStatusClient {
  as_of: string; enabled: boolean; running: boolean; tick_seconds: number;
  config: { closeMinute: number; delayMinutes: number; maxAttempts: number };
  today: string; due_now: boolean; slot_at: string | null;
  next: { trade_date: string; at: string };
  last_outcome: string; last_tick_at: string | null;
  today_summary: { kind: string; settled: boolean; attempts: number; last_status: string; last_trigger: string; last_finished_at: string | null; last_error: string }[];
  today_runs: TaskRunClient[]; recent_runs: TaskRunClient[];
  boundary: string;
}
export async function fetchTaskStatus(): Promise<TaskStatusClient> {
  const res = await fetch("/api/tasks/status");
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || "任务记录读取失败");
  return j;
}
