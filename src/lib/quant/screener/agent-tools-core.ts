// P6-D Agent 工具登记表（Agent Tool Registry）纯内核 —— 任务书 §二十七 要的那份 registry。
//
// 三条设计口径（都是被前面的阶段钉死的，不是这里新发明的）：
// 1) 不重复建模（§二十六「先做 capability mapping，不要重新造一套相同工具」）：
//    工具逐条从 P6-A 的 CAPABILITIES 派生，name 与能力名 1:1，source / freshness / limitations /
//    fallbacks / data_status 全部沿用登记表原文。这里只补 registry 没有的三样东西：
//    机器可校验的 inputSchema（§二十七）、riskLevel/sideEffect（安全边界）、enabled + 执行器 id（哪些能当场跑）。
// 2) 只读边界（§二十八）：mutating=true 的能力一律不进 Agent 工具集（由 readOnlyCapabilities() 保证），
//    且本文件必须把「为什么这条不开放」写成 disabled_reason 留在表里 —— 让 Agent 知道这条路是死的，
//    否则它会反复试（同 P6-A 对 not_covered 的处理）。绝不允许出现下单/买卖/改账户/清库这类工具。
// 3) enabled=false ≠ 不存在，也 ≠ 可用：它表示「这条能力的声明在，但本阶段没有服务端只读执行器」。
//    失败时按 §十六 归到「capability 不支持」，Agent 必须据此回答「缺少 XXX 数据，因此无法验证 YYY」。
//
// 本文件是纯内核：不 import db、不发网络、不读环境变量，因此 tests/ 里可以用 node --test 直跑。
// 真正的取数派发给服务层（agent-tools.ts）里已有的引擎/provider，执行器 id 是唯一契约。
import {
  CAPABILITIES, capabilitiesForNeed, findCapability, readOnlyCapabilities, type CapabilityDef,
} from "./capability-core.ts";
import type { DataStatus, FreshnessClass, ObservationKind, SourceType } from "./datastatus-core.ts";

// ---------- §二十七 字段：JSON Schema 的最小可用子集 ----------

export type JsonType = "string" | "integer" | "boolean" | "array";

export interface ParamSpec {
  key: string;
  type: JsonType;
  required: boolean;
  /** 人类可读说明。与 CapabilityDef.input 同源（有测试逐条核对，两边不能各说一套） */
  description: string;
  enum_values?: string[];
  /** 字符串/数组元素的校验正则（写成正则原文，执行器不自己再解释一遍） */
  pattern?: string;
  /** 日期类参数：光看格式不够，2026-13-99 也匹配 \d{4}-\d{2}-\d{2} —— 必须是真实存在的日历日 */
  calendar?: boolean;
  item_pattern?: string;
  min?: number;
  max?: number;
  max_items?: number;
  default?: string | number | boolean;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, {
    type: JsonType | "string";
    description: string;
    enum?: string[];
    pattern?: string;
    items?: { type: "string"; pattern?: string };
    minimum?: number;
    maximum?: number;
    maxItems?: number;
    default?: string | number | boolean;
  }>;
  required: string[];
  /** 多传参数一定是模型编的：直接判参数错误，不让它悄悄进执行器 */
  additionalProperties: false;
}

/** read=只碰本地库/静态配置；upstream=会打外部数据源（可失败/超时）；gateway=本机 eltdx；
 *  compute=对已有数据现算；none=纯静态文本 */
export type SideEffect = "none" | "read" | "read_upstream" | "read_gateway" | "compute";
/** low=本地读数；medium=依赖外部上游或现算引擎（可能失败）；
 *  high 保留给「会改变系统状态/触发外部执行」的工具 —— 这类工具不进自主循环，所以本文件不会产出它，
 *  但类型上必须存在，readOnlyViolations() 才能挡住未来有人手滑加一条高风险工具。 */
export type RiskLevel = "low" | "medium" | "high";

export interface ToolDefinition {
  /** §二十七 要求的 11 个字段开始 */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: string;
  source: string;
  freshness: FreshnessClass;
  riskLevel: RiskLevel;
  enabled: boolean;
  fallbacks: string[];
  limitations: string[];
  examples: string[];
  /** §二十七 字段结束，以下是本层为了「可执行 + 可解释」补的派生字段 */
  /** = capability name（1:1 映射；出现不同名即视为重复建模，测试会拦） */
  capability: string;
  title: string;
  group: CapabilityDef["group"];
  source_type: SourceType;
  /** 结果属于哪一层（REAL/DERIVED/HISTORICAL/SNAPSHOT/AI_INTERPRETATION/MISSING）：Agent 引用时必须带 */
  data_status: DataStatus;
  availability: CapabilityDef["availability"];
  sideEffect: SideEffect;
  /** enabled=false 时必填：为什么不开放给自主循环（不开放也要说清，不能静默消失） */
  disabledReason: string | null;
  /** 服务层派发给哪条既有实现（不重复建模）；null=没有执行器 */
  executor: string | null;
  /** 与 CapabilityDef.input 同源的可读入参说明（直接沿用登记表原文） */
  inputNote: string;
  /** 单次调用的软超时（毫秒）。超时按 §十六「数据源失败」处理，不当成「没有数据」 */
  timeout_ms: number;
  params: ParamSpec[];
}

const SYMBOL = "^[0-9]{6}\\.(SH|SZ|BJ)$";
const DAY = "^\\d{4}-\\d{2}-\\d{2}$";
const BOARD = "^BK[0-9]{4}$";

/** YYYY-MM-DD 是不是真实存在的日历日（与 research-core 的 researchDateError 同一判据，不另立口径） */
function realCalendarDay(v: string): boolean {
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------- 执行器映射：工具 → 已有的服务端实现（id 由 agent-tools.ts 解释） ----------
// 每一个 id 都必须对应仓库里已经跑通的函数/路由，不在此发明新取数路径。
type Exec = { executor: string; side: SideEffect; risk: RiskLevel; timeout_ms: number };
type Spec = {
  /** null = 本阶段不开放给自主循环（必须给 reason） */
  exec: Exec | null;
  out: string;
  params?: ParamSpec[];
  reason?: string;
};

const UP = (executor: string, timeout_ms = 6000, risk: "low" | "medium" = "medium"): Exec =>
  ({ executor, side: executor.startsWith("gateway") ? "read_gateway" : "read_upstream", risk, timeout_ms });
const DB = (executor: string): Exec => ({ executor, side: "read", risk: "low", timeout_ms: 4000 });
const EN = (executor: string, timeout_ms = 20000): Exec => ({ executor, side: "compute", risk: "medium", timeout_ms });
const ST = (executor: string): Exec => ({ executor, side: "read", risk: "low", timeout_ms: 3000 });

// 逐条对齐能力登记表：下表缺项 = 该能力没有工具（编译期不会报错，所以文件末尾有覆盖率自检函数 + 测试）
const SPECS: Record<string, Spec> = {
  stock_quote: {
    exec: UP("gateway.quotes", 5000),
    out: "quotes[]: symbol/price/changePct/high/low/prevClose/amountYi/time + 每条的 source 与 degraded_from",
    params: [
      { key: "symbols", type: "array", required: true, description: "代码数组（.SH/.SZ/.BJ 后缀必填），最多 20 个", item_pattern: SYMBOL, max_items: 20 },
    ],
  },
  stock_kline: {
    exec: UP("gateway.bars", 8000),
    out: "bars[]: date/open/high/low/close/volume/amount + last_date + bars_count",
    params: [
      { key: "symbol", type: "string", required: true, description: "单个代码（后缀必填）", pattern: SYMBOL },
      { key: "tf", type: "string", required: false, description: "周期：day|1m|5m|15m|30m|60m（默认 day）", enum_values: ["day", "1m", "5m", "15m", "30m", "60m"], default: "day" },
      { key: "lookback", type: "integer", required: false, description: "根数（5~500，默认 60）", min: 5, max: 500, default: 60 },
      { key: "asOf", type: "string", required: false, description: "历史回放截止日 YYYY-MM-DD（可省=最新）", pattern: DAY, calendar: true },
    ],
  },
  market_snapshot: {
    exec: UP("em.universe", 30000),
    out: "rows[]: symbol/name/price/changePct/turnoverRate/volumeRatio/amplitude/amountYi/mainNetYi/marketCapYi/pe/pb/industry + rows_count",
  },
  sector_rank: {
    exec: UP("em.boards", 6000),
    out: "rows[]: code/name/changePct/mainYi/ratio/superBig/big/leader",
    params: [
      { key: "kind", type: "string", required: false, description: "industry|concept（默认 industry）", enum_values: ["industry", "concept"], default: "industry" },
      { key: "dir", type: "string", required: false, description: "in|out 主力净流入方向（默认 in）", enum_values: ["in", "out"], default: "in" },
      { key: "size", type: "integer", required: false, description: "取前几名（1~50，默认 20）", min: 1, max: 50, default: 20 },
    ],
  },
  sector_members: {
    exec: UP("em.board-members", 15000),
    out: "members[]: symbol/name/changePct/mainNetYi + members_count",
    params: [
      { key: "boardCode", type: "string", required: true, description: "板块代码 BKxxxx", pattern: BOARD },
    ],
  },
  fund_flow_stock: {
    exec: UP("em.fflow-daykline", 6000),
    out: "days[]: date/value(亿) + todayYi + days_count",
    params: [
      { key: "symbol", type: "string", required: true, description: "代码（后缀必填）", pattern: SYMBOL },
    ],
  },
  stock_depth: {
    exec: UP("gateway.depth", 5000),
    out: "bids[]/asks[]: price/volume + 内外盘手数（只有 eltdx 一条路，网关不在即失败）",
    params: [
      { key: "symbol", type: "string", required: true, description: "代码（后缀必填）", pattern: SYMBOL },
    ],
  },
  stock_trades_proxy: {
    exec: UP("gateway.trades-money", 5000),
    out: "逐笔分档成交代理（口径见 limitations，不是交易所官方逐笔）",
    params: [
      { key: "symbol", type: "string", required: true, description: "代码（后缀必填）", pattern: SYMBOL },
    ],
  },
  index_benchmark: {
    exec: UP("gateway.quotes", 5000),
    out: "indexes[]: symbol/name/price/changePct",
    params: [
      { key: "symbols", type: "array", required: false, description: "指数代码数组（默认 000001.SH,000300.SH,399006.SZ）", item_pattern: SYMBOL, max_items: 10 },
    ],
  },
  market_news: {
    exec: UP("em.news", 6000),
    out: "items[]: time/title/source + latest_time",
    params: [
      { key: "limit", type: "integer", required: false, description: "条数（1~30，默认 12）", min: 1, max: 30, default: 12 },
    ],
  },
  symbol_search: {
    exec: UP("em.search", 5000),
    out: "items[]: symbol/name/type（用于把名称转成代码；转不到就明确说没检索到）",
    params: [
      { key: "q", type: "string", required: true, description: "关键词（名称或代码片段）" },
    ],
  },
  sentiment: { exec: EN("engine.sentiment", 35000), out: "涨跌家数/涨停跌停/炸板率/成交额等情绪字段 + live 标记（收盘值不写成盘中）" },
  risk: { exec: EN("engine.risk", 35000), out: "风险分项读数（与 /api/market/risk 同一份实现）；similar_env 给 trade_date/sample/horizon + period_start/period_end（引用概率要带前三项口径，样本区间一并回显）" },
  themes: {
    exec: EN("engine.themes", 35000),
    out: "theme_id/name/strength/扩散度等主线判定读数",
    params: [
      { key: "force", type: "boolean", required: false, description: "true=绕开 45 秒缓存重算（默认 false）", default: false },
    ],
  },
  limitup: { exec: EN("engine.limitup", 35000), out: "涨停梯队分层名单（连板口径见 limitations）" },
  radar: {
    exec: DB("db.radar"),
    out: "items[]: finding_id/kind/title/detail/evidence + superseded_today",
    params: [
      { key: "state", type: "string", required: false, description: "all|live|superseded（默认 live=当前成立的那批）", enum_values: ["all", "live", "superseded"], default: "live" },
    ],
  },
  events: { exec: DB("db.events"), out: "items[]: event_id/as_of/title/summary/theme 关联 + rows_count" },
  event_interpret: {
    exec: DB("db.event-interpret"),
    out: "interpretations[]: event_id/AI 解读原文（AI_INTERPRETATION 层，不是事实）",
    params: [
      { key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=今天）", pattern: DAY, calendar: true },
    ],
  },
  market_research: {
    exec: DB("db.research"),
    out: "report 七分区 + evidence 台账 + missing（AI_INTERPRETATION 层）",
    params: [
      { key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=今天）", pattern: DAY, calendar: true },
      { key: "scope", type: "string", required: false, description: "研究范围，目前只支持 market", enum_values: ["market"], default: "market" },
    ],
  },
  factor_catalog: { exec: ST("static.factors"), out: "factors[]: factor_key/名称/口径/implemented 标记" },
  factor_verified: { exec: ST("static.verified-ledger"), out: "verified_keys / total_factors / ledger_path（只有正式验证流程能写这本账）" },
  factor_test: {
    exec: DB("db.factor-test"),
    out: "records[]: factor_key/IC/样本区间（HISTORICAL 层：过去样本不等于今天）",
    params: [
      { key: "factorKey", type: "string", required: false, description: "按信号键过滤（可省=全部）" },
    ],
  },
  // 计算量与口径都要人定：这三条不在自主循环里跑（§三十二 避免无意义地打满上游），
  // 但必须留在表里带原因，Agent 才知道「这条路存在但不由我走」，并按 §十六 报「无法验证」。
  // §二十 允许 AI「查询 backtest / probability」——本阶段按「查已入库的读数」实现（snapshot_probability / factor_test），
  // 「新跑一次全量回放」仍归人发起：口径写在这里，不靠事后解释。
  backtest: {
    exec: null, out: "（本阶段不由 Agent 触发）",
    reason: "需要明确的策略/条件与回放区间，且会重放全量历史；P6-A 探测层同样据此不自动执行（见 capability-service 的 backtest 分支）。§二十 允许的是「查询」：已有回测/IC 读数请用 factor_test；要新跑一次回测由人在回测页发起。",
  },
  probability: {
    exec: null, out: "（本阶段不由 Agent 触发新计算）",
    reason: "新算一次条件概率要对整个 universe 拉K线回放（数十秒以上），自主循环里放开会同时踩 §三十二（重复取数）与 §十七（预算）。§二十 的「查询 probability」在本阶段由 snapshot_probability 承接：读已入库留档并带 trade_date/sample/horizon 口径（§十九）；要新算由人在概率页发起。",
  },
  screener: {
    exec: null, out: "（本阶段不由 Agent 触发）",
    reason: "选股器是一次全量条件计算（conditions[] 由人给定并要在页面上复核），不属于「回答一个已有问题」的读数工具；Agent 需要名单时用 market_snapshot + radar/candidate_pool，需要因子有效性用 factor_test/factor_verified。",
  },
  candidate_pool: { exec: DB("db.candidate-pool"), out: "rows[]: 候选池条目（含冻结时的复权口径标记）" },
  history_radar: {
    exec: DB("db.history-radar"),
    out: "day items[]: finding_id/kind/title/detail（HISTORICAL 层，不等于今天）",
    params: [
      { key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=最近有归档的那天）", pattern: DAY, calendar: true },
      { key: "state", type: "string", required: false, description: "all|live|superseded（默认 live）", enum_values: ["all", "live", "superseded"], default: "live" },
    ],
  },
  history_events: {
    exec: DB("db.history-events"),
    out: "day items[]: 当日事件归档 + 可回看日期清单",
    params: [
      { key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=最近有归档的那天）", pattern: DAY, calendar: true },
    ],
  },
  snapshot_risk: {
    exec: DB("db.snapshot-risk"),
    out: "留档行：trade_date + 风险分项原文",
    params: [{ key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=最近一次留档）", pattern: DAY, calendar: true }],
  },
  snapshot_themes: {
    exec: DB("db.snapshot-themes"),
    out: "留档行：trade_date + 主线判定原文（SNAPSHOT 层）",
    params: [{ key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=最近一次留档）", pattern: DAY, calendar: true }],
  },
  snapshot_probability: {
    exec: DB("db.snapshot-probability"),
    out: "留档行：trade_date/sample/horizon + 概率读数（引用概率必须带这三项口径）",
    params: [{ key: "date", type: "string", required: false, description: "YYYY-MM-DD（可省=最近一次留档）", pattern: DAY, calendar: true }],
  },
  trade_dates: {
    exec: UP("engine.trade-dates", 8000),
    out: "dates[]: 真实交易日（来自上证指数日K，没有独立节假日表）",
    params: [{ key: "n", type: "integer", required: false, description: "取最近多少个交易日（1~250，默认 60）", min: 1, max: 250, default: 60 }],
  },
  task_status: { exec: DB("db.task-status"), out: "tasks[]: kind/status/started_at/mode/游标（服务未启动的时间段不会有条目）" },
  agent_run_history: {
    exec: DB("db.agent-run"),
    out: "runs[]: run_id/question/status/answer_status/steps/tool_calls/evidence_lines/started_at（带 run_id 时给那一次的调用时间线）",
    params: [
      { key: "run_id", type: "string", required: false, description: "某次运行（可省=最近若干次列表）" },
    ],
  },
  lifecycle_preview: { exec: DB("db.lifecycle-preview"), out: "过期候选读数 + plan 指纹（dry-run，不会真的清理）" },
  provider_health: { exec: EN("engine.health", 5000), out: "providers[]: id/coverage/configured（哪个源在服务端注册了）" },
  capability_registry: {
    exec: ST("static.registry-view"),
    out: "registry[] / matched[]：能力声明与按需求匹配结果（不含本次可得性）",
    params: [
      { key: "name", type: "string", required: false, description: "单条能力名（可省=全表）" },
      { key: "need", type: "string", required: false, description: "自然语言需求，返回按关键词匹配的能力" },
    ],
  },
  capability_probe: {
    exec: EN("probe.capabilities", 25000),
    out: "capabilities[]: kind/status/probed/reason/scope/evidence/as_of（本次到底取到了没有）",
    params: [
      { key: "live", type: "boolean", required: false, description: "true=真打上游小请求（默认 false，只读本地/账本）", default: false },
      { key: "force", type: "boolean", required: false, description: "true=绕开 20 秒缓存（默认 false）", default: false },
      { key: "only", type: "string", required: false, description: "只看某条能力（可省=全表）" },
    ],
  },
  // 三条「客户端才有」的路径：服务端没有可执行实现，写清楚而不是从表里删掉
  ai_context_layering: {
    exec: null, out: "（客户端组装，不是服务端取数）",
    reason: "这一层的实现位置在客户端页面（#/assistant、#/analysis 的上下文组装），服务端没有可派发的只读执行器；Agent 需要分层口径时读本表的 data_status 字段与 §三 纪律，而不是调用一个不存在的实现。",
  },
  mcp_tools: {
    exec: null, out: "（读能力声明可以，自主调用不开放）",
    reason: "登记格里 mcp_tools 的 mutating=true（POST /api/mcp/call 是外部执行通道），按 §二十八 只读边界不进 Agent 工具集。MCP 到底可用不可用不靠猜：capability_probe 的 mcp_tools 行会如实给出 ready 服务器数与工具数，不可用时原样带「MCP unavailable」，本层不会假装调用成功。",
  },
  northbound_flow: { exec: null, out: "（无可靠来源）" },
  stock_announcements: { exec: null, out: "（无可靠来源）" },
  board_day_streak: { exec: null, out: "（无可靠来源）" },
};

// not_covered 三条的 reason 直接取登记表原文（P6-A 已经写明为什么这条路是死的，不在这里改口径）
const NOT_COVERED_REASON = (cap: CapabilityDef) =>
  `当前没有可靠数据源（${cap.limitations[0] ?? "未覆盖"}）。按 §十六 这属于「capability 不支持」：要说「缺少 XXX 数据，因此无法验证 YYY」，不用估算值或 0 顶替。`;

function paramsOf(name: string): ParamSpec[] {
  return SPECS[name]?.params ?? [];
}

function schemaOf(params: ParamSpec[]): JsonSchema {
  const properties: JsonSchema["properties"] = {};
  for (const p of params) {
    const node: JsonSchema["properties"][string] = { type: p.type, description: p.description };
    if (p.enum_values) node.enum = [...p.enum_values];
    if (p.pattern) node.pattern = p.pattern;
    if (p.type === "array") node.items = { type: "string", ...(p.item_pattern ? { pattern: p.item_pattern } : {}) };
    if (p.min != null) node.minimum = p.min;
    if (p.max != null) node.maximum = p.max;
    if (p.max_items != null) node.maxItems = p.max_items;
    if (p.default != null) node.default = p.default;
    properties[p.key] = node;
  }
  return { type: "object", properties, required: params.filter((p) => p.required).map((p) => p.key), additionalProperties: false };
}

/** 登记表 input 原文里提到、但**故意不做成工具入参**的令牌：必须逐条写原因，
 *  否则「两处同源」的机检就只能靠人记着。测试会核对这里之外不允许出现漏项。 */
export const INPUT_ONLY_FLAGS: Record<string, { keys: string[]; reason: string }> = {
  factor_catalog: { keys: ["catalog"], reason: "路由层的展开开关，Agent 只需要目录本身，不开放给模型改返回粒度" },
  snapshot_risk: { keys: ["kind"], reason: "kind 由工具身份固定（snapshot_risk 就是 risk），开放给模型会出现工具与参数不一致" },
  snapshot_themes: { keys: ["kind"], reason: "kind 由工具身份固定（同 snapshot_risk）" },
  snapshot_probability: { keys: ["kind"], reason: "kind 由工具身份固定（同 snapshot_risk）" },
};

/** 只读白名单派生：mutating 的能力（今天就是 mcp_tools）在这里就被挡掉，不靠后面手写 if */
const AGENT_CAPABILITIES: CapabilityDef[] = readOnlyCapabilities();

export const TOOL_DEFS: ToolDefinition[] = AGENT_CAPABILITIES.map((cap) => {
  const spec: Spec = SPECS[cap.name] ?? { exec: null, out: cap.output };
  const params = paramsOf(cap.name);
  const exec = spec.exec;
  const notCovered = cap.availability === "not_covered";
  const disabledReason = exec
    ? null
    : (notCovered ? NOT_COVERED_REASON(cap) : (spec.reason ?? cap.limitations[0] ?? "本阶段没有服务端只读执行器"));
  return {
    name: cap.name,
    description: cap.description,
    inputSchema: schemaOf(params),
    outputSchema: spec.out,
    source: cap.source,
    freshness: cap.freshness,
    riskLevel: exec?.risk ?? "low",
    enabled: !!exec,
    fallbacks: cap.fallbacks,
    limitations: cap.limitations,
    examples: cap.examples,
    capability: cap.name,
    title: cap.title,
    group: cap.group,
    source_type: cap.source_type,
    data_status: cap.data_status,
    availability: cap.availability,
    sideEffect: exec?.side ?? "none",
    disabledReason,
    executor: exec?.executor ?? null,
    inputNote: cap.input,
    timeout_ms: exec?.timeout_ms ?? 0,
    params,
  } satisfies ToolDefinition;
});

export const TOOL_NAMES: string[] = TOOL_DEFS.map((t) => t.name);

export function findTool(name: string | null | undefined): ToolDefinition | null {
  const v = String(name ?? "").trim();
  return TOOL_DEFS.find((t) => t.name === v) ?? null;
}

export function enabledTools(): ToolDefinition[] {
  return TOOL_DEFS.filter((t) => t.enabled);
}

export function disabledTools(): ToolDefinition[] {
  return TOOL_DEFS.filter((t) => !t.enabled);
}

/** §三十四/§三十五 的护栏：登记表又加了能力但这里没给执行器/说明时，要能被机器发现而不是默默漏掉。
 *  返回「有声明但没有归属」的工具名（空数组=每条都处理过）。 */
export function unaccountedTools(): string[] {
  return AGENT_CAPABILITIES.filter((cap) => {
    const spec = SPECS[cap.name];
    if (!spec) return true;                                  // 登记了能力，本表完全没提
    if (spec.exec) return false;                              // 有执行器
    return !spec.reason && cap.availability !== "not_covered"; // 不开放 yet 没写原因
  }).map((cap) => cap.name);
}

/** 只读边界的自检（供测试与服务层启动时核对）：返回违规项，空数组=干净 */
export function readOnlyViolations(): string[] {
  const bad: string[] = [];
  const mutating = CAPABILITIES.filter((c) => c.mutating).map((c) => c.name);
  for (const t of TOOL_DEFS) {
    if (mutating.includes(t.name)) bad.push(`${t.name}：登记表中 mutating=true 的能力出现在工具集里（白名单失效）`);
    if (t.sideEffect === "none" && t.enabled) bad.push(`${t.name}：enabled=true 却没有取数口径（sideEffect=none 意味着它不产生任何读数）`);
    if (t.enabled && !t.executor) bad.push(`${t.name}：enabled=true 但 executor 为空`);
    if (!t.enabled && !t.disabledReason) bad.push(`${t.name}：enabled=false 但没写 disabled_reason（静默不可用等于伪装）`);
    if (t.riskLevel === "high") bad.push(`${t.name}：riskLevel=high 的工具不进自主循环，应改为 enabled=false`);
    // §二十八：研究系统不是交易系统。只扫标识符（name/executor），不扫中文散文——
    // event_interpret 的正文里「交易含义」是**被解释的内容**而不是本工具的动作，扫散文会误报成越界。
    const id = `${t.name} ${t.executor ?? ""}`;
    if (!/^(gateway|em|db|engine|static|probe)\./.test(t.executor ?? "")) {
      if (t.enabled) bad.push(`${t.name}：executor「${t.executor ?? "（空）"}」不属于已批准的只读前缀 gateway./em./db./engine./static./probe.`);
    }
    if (/write|insert|store|persist|delete|drop|purge|truncate|freeze|submit|order|buy|sell|cancel|transfer|exec|call/i.test(id)) {
      bad.push(`${t.name}：标识符里出现写入/执行类动词，越出只读研究边界（${id.trim()}）`);
    }
  }
  return bad;
}

// ---------- §十六「capability 不支持」的原文措辞（未知/不可执行要分开说） ----------

export function unsupportedToolReason(name: string | null | undefined): string {
  const v = String(name ?? "").trim();
  const tool = findTool(v);
  if (!tool) {
    const cap = findCapability(v);
    return cap
      ? `${v} 在能力登记表里（${cap.title}），但没进 Agent 工具集（登记表中 mutating=${cap.mutating}）：只读边界内的工具请查 /api/agent/tools。`
      : `登记表里没有名为 ${v || "（空）"} 的工具：这是「capability 不支持」，不是「查了没有数据」。可先用 capability_registry 查有哪些能力，不要把不支持说成没有数据。`;
  }
  if (tool.enabled) return "";
  return `${v} 当前不可由 Agent 执行：${tool.disabledReason ?? "未给出原因"}`;
}

// ---------- 参数校验：模型给什么就要判什么，不猜也不静默补数据 ----------

export interface ParamCheck {
  ok: boolean;
  /** 人类可读错误原文（会进 §十八 的 tool call log 与 §三十一 的错误结构） */
  errors: string[];
  /** 已填默认值并通过校验的参数（执行器只读这份，不读模型原文） */
  value: Record<string, string | number | boolean | string[]>;
  /** 被规范化过的入参（如逗号字符串 → 数组）：必须留痕，不能悄悄改 */
  coerced: string[];
}

const AS_STR = (v: unknown) => String(v);

function checkOne(p: ParamSpec, raw: unknown, out: Record<string, string | number | boolean | string[]>, errors: string[], coerced: string[]) {
  const label = `${p.key}`;
  let v = raw;
  if (v === undefined || v === null || v === "") {
    if (p.required) errors.push(`${label} 缺失：${p.description}`);
    else if (p.default !== undefined) out[p.key] = p.default;
    return;
  }
  if (p.type === "array") {
    // 模型常把数组写成逗号串（"688256.SH,000001.SH"）：拆开并记一笔 coerced，不假装它本来合法
    if (typeof v === "string") {
      const parts = v.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) { errors.push(`${label} 是空字符串：${p.description}`); return; }
      v = parts;
      coerced.push(`${label}: 逗号字符串已按分隔符转成数组（${parts.length} 项）`);
    }
    if (!Array.isArray(v)) { errors.push(`${label} 必须是数组：${p.description}`); return; }
    const items = v.map(AS_STR);
    if (!items.length) { errors.push(`${label} 为空数组：${p.description}`); return; }
    if (p.max_items && items.length > p.max_items) errors.push(`${label} 一次最多 ${p.max_items} 项（收到 ${items.length} 项）：超出会拖垮上游，请分批`);
    if (p.item_pattern) {
      const bad = items.filter((s) => !new RegExp(p.item_pattern as string).test(s));
      if (bad.length) errors.push(`${label} 里有不合规的取值：${bad.slice(0, 5).join("、")}${bad.length > 5 ? `…（共 ${bad.length} 项）` : ""}。${p.description}`);
    }
    if (!errors.some((e) => e.startsWith(label))) out[p.key] = [...new Set(items)];
    return;
  }
  if (p.type === "integer") {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!isFinite(n) || !Number.isInteger(n)) { errors.push(`${label} 必须是整数（收到「${AS_STR(raw)}」）：${p.description}`); return; }
    if (p.min != null && n < p.min) { errors.push(`${label} 小于下限 ${p.min}（收到 ${n}）：${p.description}`); return; }
    if (p.max != null && n > p.max) { errors.push(`${label} 超过上限 ${p.max}（收到 ${n}）：${p.description}`); return; }
    out[p.key] = n;
    return;
  }
  if (p.type === "boolean") {
    if (typeof v === "boolean") { out[p.key] = v; return; }
    const s = String(v).trim().toLowerCase();
    if (["true", "1", "yes"].includes(s)) { out[p.key] = true; coerced.push(`${label}: 「${s}」按 true 处理`); return; }
    if (["false", "0", "no"].includes(s)) { out[p.key] = false; coerced.push(`${label}: 「${s}」按 false 处理`); return; }
    errors.push(`${label} 必须是布尔值（收到「${AS_STR(raw)}」）：${p.description}`);
    return;
  }
  const s = String(v).trim();
  if (!s) { if (p.required) errors.push(`${label} 为空：${p.description}`); else if (p.default !== undefined) out[p.key] = p.default; return; }
  if (p.enum_values && !p.enum_values.includes(s)) {
    errors.push(`${label}「${s}」不在允许取值里（可选：${p.enum_values.join("|")}）：${p.description}`);
    return;
  }
  if (p.pattern && !new RegExp(p.pattern).test(s)) {
    errors.push(`${label}「${s}」不符合格式：${p.description}`);
    return;
  }
  if (p.calendar && !realCalendarDay(s)) {
    // 与 P6-C 的 researchDateError 同一口径：非法日期不会被当成「那天没有数据」，也不会偷偷回落到今天
    errors.push(`${label}「${s}」不是真实存在的日历日：这种日子没有归档可读，不会被当成「那天是空的」，也不会回落到今天再读一次`);
    return;
  }
  out[p.key] = s;
}

/** 校验一次工具调用的入参：错误原文可直读，且不会返回半成品 value 之外的东西 */
export function validateToolParams(name: string, raw: unknown): ParamCheck {
  const tool = findTool(name);
  if (!tool) return { ok: false, errors: [unsupportedToolReason(name)], value: {}, coerced: [] };
  if (!tool.enabled) {
    return { ok: false, errors: [unsupportedToolReason(name)], value: {}, coerced: [] };
  }
  if (raw === undefined || raw === null) {
    if (!tool.params.length) return { ok: true, errors: [], value: {}, coerced: [] };
    const errors = tool.params.filter((p) => p.required).map((p) => `${p.key} 缺失：${p.description}`);
    const value: Record<string, string | number | boolean | string[]> = {};
    for (const p of tool.params) if (!p.required && p.default !== undefined) value[p.key] = p.default;
    return errors.length ? { ok: false, errors, value: {}, coerced: [] } : { ok: true, errors: [], value, coerced: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`参数必须是 JSON 对象（收到 ${Array.isArray(raw) ? "数组" : typeof raw}）：${tool.inputNote}`], value: {}, coerced: [] };
  }
  const src = raw as Record<string, unknown>;
  const declared = new Set(tool.params.map((p) => p.key));
  const errors: string[] = [];
  for (const k of Object.keys(src)) {
    if (!declared.has(k)) errors.push(`多余参数 ${k}：本工具只接受 ${[...declared].join("、") || "（无参）"}。不认识的参数不会被塞给数据源`);
  }
  const value: Record<string, string | number | boolean | string[]> = {};
  const coerced: string[] = [];
  for (const p of tool.params) checkOne(p, src[p.key], value, errors, coerced);
  return { ok: errors.length === 0, errors, value: errors.length ? {} : value, coerced };
}

// ---------- 给模型看的目录文本（§十五「查询 Capability Registry → 选择工具」） ----------

const RISK_TEXT: Record<RiskLevel, string> = {
  low: "读数只来自本地库/静态配置（不会打外部源）",
  medium: "当场依赖外部数据源或现算引擎：可能失败/超时，失败必须按取数失败报告",
  high: "会改变系统状态或触发外部执行：不进自主循环（出现即视为越界，见 readOnlyViolations）",
};

function catalogLine(t: ToolDefinition): string {
  const props = Object.entries(t.inputSchema.properties)
    .map(([k, v]) => {
      const bits = [v.type === "array" ? `string[]${v.items?.pattern ? `（${v.items.pattern}）` : ""}` : v.type];
      if (v.enum) bits.push(v.enum.join("|"));
      if (v.minimum != null || v.maximum != null) bits.push(`${v.minimum ?? "-∞"}..${v.maximum ?? "+∞"}`);
      if (v.default !== undefined) bits.push(`默认 ${JSON.stringify(v.default)}`);
      return `${k}${t.inputSchema.required.includes(k) ? "*" : ""}: ${bits.join(" ")}`;
    }).join("；");
  return [
    `- ${t.name}（${t.title}）｜ ${t.description}`,
    `入参 ${props || "无"}`,
    `返回 ${t.outputSchema}`,
    `来源 ${t.source}｜新鲜度 ${t.freshness}｜分层 ${t.data_status}｜风险 ${t.riskLevel}（${RISK_TEXT[t.riskLevel]}）`,
    t.fallbacks.length ? `兜底 ${t.fallbacks.join("→")}` : "无兜底源",
    `局限 ${t.limitations.join("；") || "登记表中未列额外局限"}`,
    `例 ${t.examples.join(" / ") || "—"}`,
  ].join(" ‖ ");
}

/** 把 registry 压成提示词能读的目录文本；含「不可执行」段，模型才不会去调不存在的工具 */
export function agentToolCatalogText(): string {
  const on = enabledTools();
  const off = disabledTools();
  return [
    `【可用工具】共 ${on.length} 条（全部只读：不写库、不下单、不改账户。§二十八 这是研究系统不是交易系统）。`,
    "选择依据是每条的来源/新鲜度/分层/局限：同一问题优先 riskLevel=low 的已有读数与留档，再考虑打外部源的工具（§三十二）。",
    ...on.map(catalogLine),
    ``,
    `【明确不可由本 Agent 执行】共 ${off.length} 条。调用它们会被服务端直接判为「capability 不支持」，`,
    "所以不要试第二次；需要向用户解释缺什么时，引用下面的原文原因，不要改写成「没有数据」。",
    ...off.map((t) => `- ${t.name}（${t.title}）｜ ${t.disabledReason}`),
  ].join("\n");
}

/** 按问题文本先筛一轮（复用 P6-A 的 need 关键词表，不再抄一份同义词表）。
 *  这只是**提示**：最终选哪条由模型自己看目录决定，所以不足 limit 时补齐「市场环境四件套」
 *  （radar/events/themes/risk 都是本地读数，§三十二 的口径是先读已有再打外部源）。 */
const ALWAYS_ON_TOP = ["risk", "themes", "radar", "events"];

export function shortlistTools(question: string, limit = 8): ToolDefinition[] {
  const byName = new Map(TOOL_DEFS.map((t) => [t.name, t]));
  const picked: ToolDefinition[] = [];
  const seen = new Set<string>();
  const push = (t: ToolDefinition | null) => {
    // 只给可执行的：把「不可执行」的能力塞进初筛，等于叫模型去撞 §二十八 的墙
    if (!t || !t.enabled || seen.has(t.name) || picked.length >= limit) return;
    seen.add(t.name);
    picked.push(t);
  };
  for (const h of capabilitiesForNeed(question)) {
    if (findCapability(h.name)?.mutating) continue;   // 只读白名单：写类能力不因「关键词像」被推荐
    push(byName.get(h.name) ?? null);
  }
  for (const name of ALWAYS_ON_TOP) push(byName.get(name) ?? null);
  return picked;
}

/** §三十二 的第一道闸：同一工具+同一参数不得重复真取。缓存键在这里定义，循环内核与执行服务共用一份 */
export function canonicalCallKey(name: string, value: Record<string, unknown>): string {
  const keys = Object.keys(value ?? {}).sort();
  const parts = keys.map((k) => {
    const v = value[k];
    return `${k}=${Array.isArray(v) ? v.map((x) => String(x)).join(",") : String(v ?? "")}`;
  });
  return `${name}{${parts.join(",")}}`;
}

/** 兜底链上的「可用下一步」：按登记表 fallbacks 顺序给出仍可执行的工具 */
export function fallbackTools(name: string): ToolDefinition[] {
  const cap = findCapability(name);
  if (!cap) return [];
  return cap.fallbacks
    .map((f) => findTool(f))
    .filter((t): t is ToolDefinition => !!t && t.enabled);
}

/** 页面/提示词用的口径声明（与 registryBasis 同一句法：能力存在 ≠ 此刻取得数据） */
export function agentToolBasis(): string {
  const on = enabledTools().length;
  const byRisk = (r: RiskLevel) => TOOL_DEFS.filter((t) => t.enabled && t.riskLevel === r).length;
  return `Agent 工具集逐条派生自 P6-A 能力登记表（共 ${TOOL_DEFS.length} 条：${on} 条可执行、${TOOL_DEFS.length - on} 条明确不可执行并写了原因；登记表内 mutating=${CAPABILITIES.filter((c) => c.mutating).map((c) => c.name).join(",") || "无"} 的能力不进本工具集）。` +
    `按风险分：${byRisk("low")} 条只读本地、${byRisk("medium")} 条依赖外部源或现算引擎。` +
    "工具在表里 ≠ 这次取到数据：每次调用的 kind/as_of/scope/reason 以该次观测为准，缺失就报缺失。";
}

// ---------- 执行器契约：服务层每次取数只回一个「观测」（纯类型 + 纯构造器，本段不含 fetch/db/时钟） ----------
//
// 为什么把这个接口放在内核：执行器（agent-tools.ts）、循环（agent-loop-core.ts 的 recordCall）、
// 页面与落库（agent-run.ts）三方共用同一份字段清单。任何一边自己临时加个 ok/message 字段，
// 「空 / 失败 / 未覆盖 / 真 0」的区分就会在中间某层被压平——那正是任务书 §六 禁止的事。

export interface ToolObservation {
  /** 四态观测：value / real_zero / no_data / request_failed / not_covered（互不合并） */
  kind: ObservationKind;
  /** 进台账的那一行文本（kind 可用时才有意义）：服务端事实句，不带任何判断 */
  summary: string;
  /** 结构化读数：只用于抽业务主键（§十九 的 refs）与页面展开，不进提示词 */
  payload: unknown;
  /** 这一条实际走的是哪个源（不是登记表声明值：兜底成功时要写兜底源） */
  source: string;
  /** 服务端北京时间墙钟；取不到时刻时填空串，由落库层写成「未记录」 */
  as_of: string;
  /** 成功读数的分层（REAL/DERIVED/SNAPSHOT/HISTORICAL/AI_INTERPRETATION/DEGRADED）；不可用时恒为 MISSING */
  data_status: DataStatus;
  degraded_from?: string | null;
  /** 失败/空/未覆盖的原因原文（§三十一：要能贴出来，不允许只写「异常」） */
  reason?: string;
  /** 采集侧自报的补充口径（例如引擎的 missing[]） */
  notes?: string[];
  /** 执行器自己判定的超时：它和「请求成功但没内容」是两件事，必须分开（§十六） */
  timed_out?: boolean;
}

/** 台账一行的长度上限：一行说不完就截断，超长会把每轮提示词撑爆（与 P6-C 的 clip 同一思路） */
export const SUMMARY_MAX_LEN = 300;

export function clipText(raw: unknown, max = SUMMARY_MAX_LEN): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…（已截断）` : t;
}

interface OkObsInput {
  summary: string;
  payload?: unknown;
  source: string;
  as_of: string;
  data_status: DataStatus;
  degraded_from?: string | null;
  notes?: string[];
  kind?: ObservationKind;
}

/** 真取到了东西：kind 默认 value，只有「上游确实算了个 0」才允许显式传 real_zero */
export function okObs(o: OkObsInput): ToolObservation {
  return {
    kind: o.kind ?? "value",
    summary: clipText(o.summary),
    payload: o.payload ?? null,
    source: o.source,
    as_of: o.as_of,
    data_status: o.data_status,
    degraded_from: o.degraded_from ?? null,
    ...(o.notes?.length ? { notes: o.notes } : {}),
  };
}

/** 请求成功但没有内容：与失败分开，且绝不带 0 顶替 */
export function emptyObs(reason: string, source: string, notes?: string[]): ToolObservation {
  return { kind: "no_data", summary: "", payload: null, source, as_of: "", data_status: "MISSING", reason: clipText(reason, 200), ...(notes?.length ? { notes } : {}) };
}

/** 请求失败/超时/解析不出：kind 恒为 request_failed，超时另用 timed_out 标（timed_out 不改变 kind） */
export function failedObs(reason: string, source: string, opts: { timed_out?: boolean; degraded_from?: string | null } = {}): ToolObservation {
  return {
    kind: "request_failed", summary: "", payload: null, source, as_of: "", data_status: "MISSING",
    reason: clipText(reason, 200), ...(opts.timed_out ? { timed_out: true } : {}),
    ...(opts.degraded_from ? { degraded_from: opts.degraded_from } : {}),
  };
}

/** 登记表说这条路没有可靠来源：它既不是失败也不是「市场没数据」，按 §十六 归 capability 不支持 */
export function notCoveredObs(reason: string, source: string): ToolObservation {
  return { kind: "not_covered", summary: "", payload: null, source, as_of: "", data_status: "MISSING", reason: clipText(reason, 200) };
}

/** 观测里要不要带 notes 的统一出口（落库与页面都要读同一份，不要两处各自 filter） */
export function obsNotes(obs: ToolObservation): string[] {
  return (obs.notes ?? []).map((n) => clipText(n, 200)).filter(Boolean);
}
