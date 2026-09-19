"use client";
// 前端 → 新 P0 后端接口的类型化封装
import type { ScreenerCond, WinProbStats } from "@/lib/quant/factors/probability";
import { MODE_TEXT, modeFromBasis } from "@/lib/quant/screener/incremental-core";

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
