// Quant Research Lab — 共享类型词汇表
// 约定：本目录下的纯逻辑模块使用显式 .ts 相对导入（Node 内置测试运行器可直跑），
//       不使用 enum/namespace 等不可擦除语法；服务端专用模块可使用 @/ 别名。

// ---------- 数据层 ----------

export interface Bar {
  date: string; // "YYYY-MM-DD"（日线）或 "YYYY-MM-DD HH:mm"（分钟线）
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // 成交量（股）
  amount?: number; // 成交额（元）
}

export type Timeframe = "day" | "m1" | "m5" | "m15" | "m30" | "m60";

export interface AssetMeta {
  symbol: string; // 688256.SH
  name: string;
  industry?: string;
  listDate?: string; // YYYY-MM-DD
  marketCap?: number; // 总市值（元）
  floatCap?: number; // 流通市值（元）
  pe?: number;
  pb?: number;
  price?: number; // 最新快照价
  turnover?: number; // 换手率 %
  volume?: number; // 成交量
  amount?: number; // 成交额
  st?: boolean; // 名称含 ST/*ST
  suspended?: boolean; // 数据源标记当日无成交/停牌（仅快照口径）
}

export type UniverseKind = "all" | "custom" | "industry" | "concept";

export interface UniverseSpec {
  kind: UniverseKind;
  symbols?: string[]; // custom
  boardCode?: string; // industry/concept 的 BKxxxx
}

export interface BarsRequest {
  symbols: string[];
  tf: Timeframe;
  asOf: string; // YYYY-MM-DD：严格截断，绝不返回该日之后的数据
  lookback: number; // 最多取多少根
}

export interface DataCoverage {
  source: string;
  daily: boolean;
  minute: boolean;
  // 基本面能力：none=无；snapshot=仅当日快照字段（市值/PE/PB/换手）
  fundamentals: "none" | "snapshot" | "historical";
  // 成分股能力：current_only=仅有当前名单（历史回放存在幸存者偏差风险，须在结果中标注）
  universeMembership: "current_only" | "point_in_time";
}

export interface DataProvider {
  id: string; // em | demo
  coverage(): DataCoverage;
  listUniverse(spec: UniverseSpec, asOf: string): Promise<AssetMeta[]>;
  getBars(req: BarsRequest): Promise<Map<string, Bar[]>>;
  getQuotes(symbols: string[]): Promise<Map<string, { price: number; name?: string }>>;
}

// ---------- 因子 ----------

export const FACTOR_CATEGORIES = [
  "Price", "Volume", "Momentum", "Trend", "Reversal",
  "Volatility", "Fundamental", "Microstructure", "AI_Discovered",
] as const;
export type FactorCategory = (typeof FACTOR_CATEGORIES)[number];

export const FACTOR_STATUSES = [
  "Candidate", "Validated", "Paper", "Live", "Degraded", "Retired",
] as const;
export type FactorStatus = (typeof FACTOR_STATUSES)[number];

export interface FactorMetrics {
  ic?: number; // |IC| 均值
  rankIc?: number;
  icIr?: number;
  icPositiveRatio?: number;
  groupReturn?: number[]; // 分组单调性/分组年化（Q1..Qn）
  longShortReturn?: number; // 多空年化
  turnover?: number; // 换手率
  stability?: number; // 跨窗口 IC 稳定性
  decay?: number; // 半衰期（天数）
  correlation?: { factorKey: string; corr: number }[]; // 与已有因子相关性
}

export interface FactorRecord {
  id: string;
  factorKey: string;
  version: number;
  name: string;
  category: FactorCategory;
  expression: string; // 序列化 DSL
  params: Record<string, unknown>;
  dataSource: string;
  dataRange: string;
  metrics: FactorMetrics;
  status: FactorStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- 策略 ----------

export const STRATEGY_STATUSES = [
  "Candidate", "Research", "Validated", "Paper", "Live", "Monitoring", "Degraded", "Retired",
] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export interface FactorRef {
  factorKey: string;
  version: number;
  weight: number;
  direction: 1 | -1; // 1=因子值越大越好
}

export interface StrategyRecord {
  id: string;
  strategyKey: string;
  version: number;
  name: string;
  kind: "rule" | "factor" | "multi_factor" | "combo";
  factorRefs: FactorRef[];
  selection: Record<string, unknown>;
  backtest: Record<string, unknown>;
  metrics: StrategyMetrics;
  status: StrategyStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- 绩效评估（策略/回测共用） ----------

export interface StrategyMetrics {
  annualReturn?: number; // 年化
  cumulativeReturn?: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
  maxDrawdown?: number; // 正数，如 0.18
  winRate?: number;
  payoffRatio?: number;
  turnover?: number;
  tradeCount?: number;
  transactionCost?: number; // 累计成本占比
  stability?: number; // 收益稳定性（滚动窗口同向比例等）
  benchmarkAnnual?: number; // 基准（如沪深300）年化，便于相对评估
  excessAnnual?: number;
}

// ---------- 选股 ----------

export type ScoringMethod = "rank" | "zscore" | "minmax";

export interface SelectionFilters {
  excludeST?: boolean; // 默认 true
  excludeSuspended?: boolean; // 默认 true
  minListDays?: number; // 上市时间下限（自然日）
  minMarketCap?: number; // 元
  maxMarketCap?: number;
  minPrice?: number;
  maxPrice?: number;
  minAmount?: number; // 当日成交额（元）
  maxTurnover?: number; // 换手率上限 %
  minTurnover?: number;
  minVolume?: number;
}

export interface SelectionRequest {
  mode: "rule" | "factor" | "multi_factor" | "strategy";
  asOf: string; // 历史回放=指定日期；实时=当日
  universe: UniverseSpec;
  filters?: SelectionFilters;
  factors?: FactorRef[];
  scoring?: { method: ScoringMethod; topN: number };
  rules?: { key: string; params: Record<string, unknown> }[]; // 规则选股
  strategyKey?: string;
  strategyVersion?: number;
  dataSource?: string;
  maxKlineSymbols?: number; // 大池K线子集上限（默认 300，按快照成交额取流动性最好的一批）
}

export interface SelectionRow {
  code: string;
  name: string;
  timestamp: string; // asOf
  strategyVersion: string; // 选股配置版本串（strategy 或 selection 描述）
  factorVersions: string; // key@v 逗号分隔
  score: number;
  rank: number;
  triggeredFactors: string[]; // 触发的因子/规则
  reason: string; // 入选理由（人读）
  risk: string; // 风险标注（幸存者偏差/数据降级等）
}

export interface SelectionResult {
  request: SelectionRequest;
  rows: SelectionRow[];
  excluded: { st: number; suspended: number; listDays: number; filters: number; universe: number };
  warnings: string[]; // 数据覆盖降级提示
  source: string;
}

// ---------- 回测 ----------

export interface TransactionCost {
  commissionRate?: number; // 双边佣金率，默认 0.0003
  minCommission?: number; // 单笔最低佣金，默认 5 元
  stampDuty?: number; // 印花税（仅卖出），默认 0.0005
  slippageRate?: number; // 滑点，默认 0.001
}

export interface BacktestConstraints {
  respectLimitUpDown?: boolean; // 涨跌停不可成交（默认 true）
  respectSuspension?: boolean; // 停牌不可交易（默认 true）
  volumeCapRatio?: number; // 成交量约束：买单 ≤ 当日成交量×比例（默认 0.05）
  liquidityCapRatio?: number; // 流动性约束：≤ 当日成交额×比例（默认 0.01）
  marketImpactCoeff?: number; // 线性市场冲击系数（默认 0，可开启）
}

export interface BacktestConfig {
  mode: "single" | "multi" | "universe" | "portfolio";
  tf: Timeframe;
  startDate: string;
  endDate: string;
  universe: UniverseSpec;
  initialCash: number;
  cost: TransactionCost;
  constraints?: BacktestConstraints;
  // Train/Validation/Test 切分（比例，留空=全样本）
  split?: { train: number; validation: number; test: number };
  benchmark?: string; // 默认 000300.SH
}

export interface BacktestSegment {
  name: "train" | "validation" | "test" | "full";
  startDate: string;
  endDate: string;
  metrics: StrategyMetrics;
}

export interface BacktestResult {
  config: BacktestConfig;
  equityCurve: { date: string; value: number; benchmark: number }[];
  trades: { date: string; symbol: string; side: "buy" | "sell"; price: number; shares: number; cost: number; reason: string }[];
  metrics: StrategyMetrics;
  segments: BacktestSegment[];
  diagnostics: {
    lookaheadCheck: "pass" | "fail" | "skipped";
    futureFunctionCheck: "pass" | "fail" | "skipped";
    dataLeakageCheck: "pass" | "fail" | "skipped";
    survivorshipBias: "none" | "possible" | "likely";
    notes: string[];
  };
  warnings: string[];
  source: string;
}

// ---------- 反过拟合验证 ----------

export interface ValidationConfig {
  walkForwardFolds?: number; // 默认 4
  walkForwardTrainRatio?: number; // 默认 0.6
  oosRatio?: number; // 留出法 OOS 比例，默认 0.3
  regimeSplit?: { key: string; params?: Record<string, unknown> }[]; // 市场环境分段
  paramGrid?: Record<string, (number | string)[]>; // 参数稳定性扫描
}

export interface ValidationReport {
  walkForward: { fold: number; trainRange: string; testRange: string; oosIc?: number; oosAnnual?: number; sharpe?: number }[];
  oos: { isMetrics: StrategyMetrics; oosMetrics: StrategyMetrics; decayRatio: number };
  regimes: { name: string; range: string; annual?: number; sharpe?: number; ic?: number }[];
  paramStability: { param: string; values: { value: number | string; annual: number; sharpe: number }[]; verdict: "stable" | "unstable" }[];
  overfitFlags: string[]; // Look-ahead/Future/Leakage/Survivorship/ParamSnooping/SampleBias 检查结论
  verdict: "pass" | "warn" | "fail";
}

// ---------- 实验 / 知识库 / 任务 ----------

export interface ExperimentRecord {
  id: string;
  fingerprint: string;
  kind: "mining" | "validation" | "backtest" | "selection_replay" | "research";
  startedAt: string;
  dataRange: string;
  stockPool: Record<string, unknown>;
  factorVersions: string;
  strategyVersion: string;
  parameters: Record<string, unknown>;
  backtestParameters: Record<string, unknown>;
  transactionCost: Record<string, unknown>;
  status: "running" | "done" | "failed";
  result: Record<string, unknown>;
  failureReason: string;
  agentConclusion: string;
  jobId: string;
}

export type KnowledgeKind =
  | "valid_factor" | "invalid_factor" | "tested_param" | "failed_strategy"
  | "retired_strategy" | "experiment_note" | "market_env" | "current_strategy";

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  refs: string[];
  tags: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type JobStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  kind: string;
  fingerprint: string;
  status: JobStatus;
  progress: number; // 0-100
  stage: string;
  message: string;
  error: string;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Agent 自主研究：漏斗分级与失败归因
export interface ResearchFunnel {
  candidates: number;
  preliminary: number;
  fine: number;
  backtest: number;
  validated: number;
}

export interface ResearchFailureReport {
  reason: string; // 失败原因
  evidence: string; // 数据证据
  failedMetric: string; // 哪个指标失败
  overfitPossible: boolean; // 是否可能过拟合
  nextSuggestions: string[]; // 下一步建议实验
}

export function formatFactorVersion(factorKey: string, version: number): string {
  return `${factorKey}@${version}`;
}
