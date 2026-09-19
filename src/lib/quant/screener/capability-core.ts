// P6-A 数据能力登记表（Data Capability Registry）的纯内核。
//
// 它要回答任务书 §七 的那一句「我现在能查什么」，并且是给 AI / Agent 读的（不是给人看的注释）：
// P6-D 的 Agent 只能靠这份表判断「缺什么 ⇒ 该调什么 ⇒ 有没有兜底源」，所以每条能力都必须写清
// input / output / source / freshness / availability / limitations / fallbacks。
//
// 纪律：
// - 登记表里**只写当前代码里真实存在**的能力（逐条对得上 route / 引擎函数），不写「设想中」的能力；
// - 没有可靠来源的能力照样登记，但 availability 填 not_covered 并写明原因（北向、公告、板块日K连续强势天数就是这种）：
//   让 Agent 知道「这条路是死的」同样是信息，否则它会反复试；
// - `mutating` 标出会写库/删库的能力，P6-D 的 Agent 只允许读能力（见 READ_ONLY_CAPABILITIES）。
import type { DataStatus, FreshnessClass, ObservationKind, SourceType } from "./datastatus-core.ts";

export interface CapabilityDef {
  /** Agent 调用时用的稳定名字（snake_case，与 /api/ai/chat 的既有工具名保持一致） */
  name: string;
  title: string;
  /** 归组，只用于呈现顺序 */
  group: "行情" | "信号" | "研究" | "历史" | "运维";
  description: string;
  /** 入参说明（人类可读；JSON Schema 由 tool-registry 侧给出，两处必须同源） */
  input: string;
  /** 返回什么（关键字段，不写全量表结构） */
  output: string;
  source: string;
  source_type: SourceType;
  freshness: FreshnessClass;
  /** 该能力当前的可得性：live=当场可取；db=读本地已入库；engine=对已有数据现算；not_covered=没有可靠来源 */
  availability: "live" | "db" | "engine" | "not_covered";
  /** 结果属于哪一层（REAL / DERIVED / HISTORICAL …），AI 层据此避免把派生当事实 */
  data_status: DataStatus;
  /** 已知局限与口径陷阱（原文会随接口回传给 Agent，不允许省略） */
  limitations: string[];
  /** 兜底链：主源失败时依次可换的实现 / 能力名 */
  fallbacks: string[];
  /** 是否会改变系统状态（写库、删库、调模型）。Agent 只允许 false */
  mutating: boolean;
  examples: string[];
}

export const CAPABILITIES: CapabilityDef[] = [
  // ---------- 行情 ----------
  {
    name: "stock_quote", title: "个股/指数实时报价", group: "行情",
    description: "取单个或一批代码的最新价、涨跌幅、高低、成交额、主力净额等快照字段。",
    input: "symbols=688256.SH,000001.SH（.SH/.SZ/.BJ 后缀必填）",
    output: "quotes[]: price/changePct/high/low/prevClose/amountYi/time；取不到的代码为 null",
    source: "eltdx 网关 quotes.get_snapshots → 腾讯 qt.gtimg.cn",
    source_type: "local_gateway", freshness: "live", availability: "live", data_status: "REAL",
    limitations: [
      "eltdx 网关不在本机运行时自动降级到腾讯，降级事实必须显式呈现",
      "腾讯路径不填 high/low/prevClose 之外的部分字段，缺的字段是 undefined 而不是 0",
      "非 A 股品种（黄金/加密货币等）没有真实源，属演示数据，不允许当行情引用",
    ],
    fallbacks: ["market_snapshot"], mutating: false,
    examples: ["688256.SH 现在多少钱"],
  },
  {
    name: "stock_kline", title: "历史 K 线（日/分钟）", group: "行情",
    description: "取某代码的历史 K 线序列，供指标计算与历史统计。",
    input: "symbol, tf=day|1m..., lookback, asOf(可选，历史回放用)",
    output: "bars[]: date/open/high/low/close/volume/amount",
    source: "eltdx dayBars → 腾讯 ifzq mkline / fqkline(前复权)",
    source_type: "local_gateway", freshness: "daily", availability: "live", data_status: "HISTORICAL",
    limitations: [
      "前复权(qfq)与真实成交价不是同一口径：冻结真实价与 QFQ 序列不能混用",
      "eltdx 与腾讯两条通道：走兜底时结果为 DEGRADED（fetchBarsHybridTracked 的 outcomes/degraded 逐只记录）",
      "选股器、历史条件概率与 AI 交易员的K线工具已按 outcomes 区分「取数失败」与「确实没有K线」并写进 warnings/missing；仍直接用 fetchBarsHybrid 的调用点（涨停梯队、候选池验证、因子测试台、调度器）只能看到空数组，不得据此下「不符合条件」结论",
    ],
    fallbacks: [], mutating: false,
    examples: ["寒武纪近一年走势"],
  },
  {
    name: "market_snapshot", title: "全 A 市场快照", group: "行情",
    description: "一次拉取全 A 的现价/涨跌幅/换手/量比/振幅/成交额/主力净额/市值/PE/PB/行业。",
    input: "无参（分页与排序在服务端内部处理）",
    output: "rows[]: symbol/name/price/changePct/turnoverRate/volumeRatio/amplitude/amountYi/mainNetYi/marketCapYi/pe/pb/industry",
    source: "东财 push2delay→push2 /api/qt/clist/get（f 字段表）",
    source_type: "http_direct", freshness: "live", availability: "live", data_status: "REAL",
    limitations: [
      "休市时段返回的是收盘值：sentiment/risk 会显式标 live=false（收盘/休市值），不能写成盘中实时",
      "新股（N/C 前缀）涨跌停幅度不适用，判定返回 null 而不是 false",
    ],
    fallbacks: [], mutating: false,
    examples: ["今天全市场涨跌分布"],
  },
  {
    name: "sector_rank", title: "板块资金/涨幅榜", group: "行情",
    description: "行业或概念板块按主力净流入排序的榜单。",
    input: "kind=industry|concept, dir=in|out, size",
    output: "rows[]: code/name/changePct/mainYi/ratio/superBig/big/leader",
    source: "东财 clist（板块 b:BKxxxx）",
    source_type: "http_direct", freshness: "live", availability: "live", data_status: "REAL",
    limitations: ["板块口径为东财行业+概念合并榜，不是证监会行业分类"],
    fallbacks: [], mutating: false,
    examples: ["今天哪个板块资金流入最多"],
  },
  {
    name: "sector_members", title: "板块成分股", group: "行情",
    description: "取某板块的当前成分名单。",
    input: "boardCode=BKxxxx",
    output: "members[]: symbol/name/changePct/mainNetYi",
    source: "东财 clist 过滤 b:BKxxxx",
    source_type: "http_direct", freshness: "daily", availability: "live", data_status: "REAL",
    limitations: ["只有当前名单（universeMembership=current_only）：历史回放存在幸存者偏差，结果必须标注"],
    fallbacks: [], mutating: false,
    examples: ["半导体设备板块里谁在涨"],
  },
  {
    name: "fund_flow_stock", title: "个股主力资金流", group: "行情",
    description: "个股近 14 个交易日的主力净额序列。",
    input: "symbol",
    output: "days[]: date/value(亿), spark, todayYi",
    source: "东财 push2his /api/qt/fflow/daykline",
    source_type: "http_direct", freshness: "daily", availability: "live", data_status: "REAL",
    limitations: ["「主力」是东财按单笔金额分档的口径，不是交易所官方统计"],
    fallbacks: ["stock_trades_proxy"], mutating: false,
    examples: ["这只票最近一周资金在进还是出"],
  },
  {
    name: "stock_depth", title: "五档盘口", group: "行情",
    description: "买五卖五挂单与委比相关数据。",
    input: "symbol",
    output: "bids[]/asks[]: price/volume + 内外盘手数",
    source: "eltdx quotes.get_depth",
    source_type: "local_gateway", freshness: "live", availability: "live", data_status: "REAL",
    limitations: ["只有 eltdx 一条路：网关未运行即 not_covered，绝不用别的口径冒充五档"],
    fallbacks: [], mutating: false,
    examples: ["现在的挂单结构"],
  },
  {
    name: "stock_trades_proxy", title: "主动买卖金额（代理指标）", group: "行情",
    description: "按内外盘×成交均价推算的主动买卖金额。",
    input: "symbol",
    output: "buyAmountYi/sellAmountYi/netYi + basis 说明",
    source: "eltdx quotes.get_snapshots（内外盘）",
    source_type: "local_gateway", freshness: "live", data_status: "DERIVED", availability: "live",
    limitations: ["是代理指标，不是交易所官方主力资金统计：引用时必须带上 basis 原文"],
    fallbacks: ["fund_flow_stock"], mutating: false,
    examples: ["今天主动性买盘多不多"],
  },
  {
    name: "index_benchmark", title: "指数与基准", group: "行情",
    description: "上证指数/深成/创业板指行情，以及条件概率与回测的基准 000300.SH。",
    input: "symbols=000001.SH,000300.SH,399006.SZ",
    output: "quotes + 基准 K 线条数 bars",
    source: "腾讯 qt.gtimg.cn / mkline",
    source_type: "http_direct", freshness: "live", availability: "live", data_status: "REAL",
    limitations: ["基准取不到 K 线时，概率接口的 benchmark_return/excess 返回 null 并写进 warnings，不以 0 代替"],
    fallbacks: [], mutating: false,
    examples: ["今天沪深300涨了多少"],
  },
  {
    name: "market_news", title: "宏观与财经快讯", group: "行情",
    description: "最新 7x24 快讯文本列表（时间+标题）。",
    input: "limit(默认 12)",
    output: "news[]: time/title",
    source: "东财 np-weblist → 新浪 zhibo（互为兜底）",
    source_type: "http_direct", freshness: "live", availability: "live", data_status: "REAL",
    limitations: ["快讯没有正文与个股关联：涉及个股影响时属于 AI 推断，不是事实"],
    fallbacks: [], mutating: false,
    examples: ["刚发生了什么"],
  },
  {
    name: "symbol_search", title: "代码/名称检索", group: "行情",
    description: "按名称拼音或代码片段找标的。",
    input: "q=关键词",
    output: "items[]: symbol/name/type",
    source: "东财 searchapi/api/suggest",
    source_type: "http_direct", freshness: "static", availability: "live", data_status: "REAL",
    limitations: ["接口不可用时前端回退本地目录，条目标注 type=演示"],
    fallbacks: [], mutating: false,
    examples: ["寒武纪代码是什么"],
  },
  // ---------- 信号 ----------
  {
    name: "sentiment", title: "大盘情绪", group: "信号",
    description: "涨跌家数、涨停/跌停、炸板率、主力净额、中位涨跌幅。",
    input: "无参",
    output: "advancers/decliners/limitUp/limitDown/break_rate/main_net_sum/median_pct/live/missing[]",
    source: "全 A 快照 + 腾讯指数（引擎计算）",
    source_type: "derived_engine", freshness: "live", availability: "engine", data_status: "DERIVED",
    limitations: ["触板数为 0 时炸板率是 null（算不出），不是 0%；判定跳过的个股写进 missing"],
    fallbacks: [], mutating: false,
    examples: ["今天情绪怎么样"],
  },
  {
    name: "risk", title: "风险监控", group: "信号",
    description: "市场风险等级 + 触发指标 + 相似历史环境参考统计。",
    input: "无参",
    output: "risk.level/triggers, suggestions, history_ref(样本数/胜率), missing[], live, as_of",
    source: "全 A 快照风险引擎 + 上证相似日统计",
    source_type: "derived_engine", freshness: "live", availability: "engine", data_status: "DERIVED",
    limitations: ["history_ref 是历史相似日统计，属于 HISTORICAL 层，不能表述为今天的概率"],
    fallbacks: ["snapshot_risk"], mutating: false,
    examples: ["今天风险在哪"],
  },
  {
    name: "themes", title: "主线发现（规则版）", group: "信号",
    description: "按涨幅/RPS/扩散/资金同步/连续强势判定主线、次主线、轮动、观察。",
    input: "无参（force=1 绕 45 秒缓存）",
    output: "main[]/sub[]/rotation[]/watch[]（score/reasons）, missing[], as_of",
    source: "东财板块榜 + 成分扩散 + 板块资金",
    source_type: "derived_engine", freshness: "live", availability: "engine", data_status: "DERIVED",
    limitations: ["不接 LLM；板块日K连续强势天数在东财无返回时为 null 并计入 missing（无可靠源时保持缺失）"],
    fallbacks: ["snapshot_themes"], mutating: false,
    examples: ["哪些板块值得继续研究"],
  },
  {
    name: "limitup", title: "涨停梯队", group: "信号",
    description: "涨停家数按连板高度分层。",
    input: "无参",
    output: "梯队分布 + 明细",
    source: "全 A 快照 + 涨跌停判定引擎",
    source_type: "derived_engine", freshness: "live", availability: "engine", data_status: "DERIVED",
    limitations: ["涨跌停判定优先用快照字段，缺 high/prevClose 时退回涨跌幅口径并说明"],
    fallbacks: [], mutating: false,
    examples: ["今天最高几连板"],
  },
  {
    name: "radar", title: "AI 主动发现（当日库行）", group: "信号",
    description: "读当前库里雷达规则命中的信号行（含 live / superseded 状态）。",
    input: "state=all|live|superseded",
    output: "items[]: kind/symbol/asOf/state/created_at/evidence",
    source: "SQLite radar_finding",
    source_type: "database", freshness: "intraday", availability: "db", data_status: "REAL",
    limitations: ["是「上一次扫描落库的结果」，不是实时推送；要新结果必须显式触发扫描（那是写操作）"],
    fallbacks: ["history_radar"], mutating: false,
    examples: ["现在有哪些候选信号"],
  },
  {
    name: "events", title: "全球事件雷达（当日库行）", group: "信号",
    description: "读当前库里的真实事件行及其板块映射与资金验证结果。",
    input: "无参",
    output: "items[]: time/title/mappedSectors/verified",
    source: "SQLite global_event（快讯来自东财/新浪）",
    source_type: "database", freshness: "intraday", availability: "db", data_status: "REAL",
    limitations: ["库里可能为 0 行（当日无命中）：那是真实状态，不允许补数据"],
    fallbacks: ["history_events"], mutating: false,
    examples: ["最近这条新闻可能影响哪些股票"],
  },
  {
    name: "event_interpret", title: "事件 AI 理解层（已落库解释）", group: "信号",
    description: "读 event_interpretation 里已落库的 AI 事件解释：摘要/实体/行业主题/影响方向/重要性/置信度/证据/待验证项，以及与服务端复校验相关的 dropped/violations。",
    input: "GET /api/events/interpret?date=YYYY-MM-DD（可省，省=今天）",
    output: "items[]: §九 17 字段 + mapping_agreement/dropped/violations/model/prompt_version/generated_at + row_id/stale/orphan; counts/available_dates/self_check",
    source: "SQLite event_interpretation（解释文本由客户端调用的模型产出，事实字段回填自 global_event）",
    source_type: "database", freshness: "intraday", availability: "db", data_status: "AI_INTERPRETATION",
    limitations: [
      "这一层全是 AI_INTERPRETATION：解释不是事实，事件事实只有 global_event 一份；引用时必须说明是哪条事件的解释",
      "confidence 是 AI 对**自己解释**的把握度（0..1），不是股票上涨概率；本层不产概率，模型给的概率与涨幅预测在落库前已被剔除并留痕于 dropped.probability_claims",
      "affected_symbols 只在标题/映射/关联名单里出现过才会留下；无出处的标的被降级进 hypothesized_symbols（AI_HYPOTHESIS），不是「已确认相关」",
      "表可能为 0 行：解释只在有人点「AI 理解今日事件」时产生，没做过就是空，不是失败也不会自动补；AI 未配置时页面显示 AI_NOT_CONFIGURED",
      "stale=true 表示对应事件行的 contentHash 已变化（映射/资金验证被重扫刷新）；orphan=true 表示原事件行已不在当天库里，只剩解释快照",
      "产出新解释是写操作（POST /api/events/interpret 会写本表）：不在只读白名单内，Agent 不得调用；提示词由 GET /api/events/interpret/prompt 从库里现取事实组装",
    ],
    fallbacks: ["events"], mutating: false,
    examples: ["这条新闻被 AI 理解成影响哪些板块", "今天的事件里哪些被判定利空"],
  },
  // ---------- 研究 ----------
  {
    name: "factor_catalog", title: "因子目录（137 项）", group: "研究",
    description: "全部已登记因子：key/中文/分类/数据来源(kline|snapshot)/是否已实现。",
    input: "无参（catalog=1）",
    output: "fields[]: key/zh/category/source/implemented, category 分组表",
    source: "src/lib/quant/factors/fields.ts",
    source_type: "static_config", freshness: "static", availability: "engine", data_status: "REAL",
    limitations: ["implemented=false 的条目只是登记，没有可算实现；条件选股会拒收未实现字段"],
    fallbacks: [], mutating: false,
    examples: ["这个因子是怎么算的"],
  },
  {
    name: "factor_verified", title: "因子验证账本（只读）", group: "研究",
    description: "data/factor-verified.json：哪些信号键经过正式批量 IC 验证。",
    input: "无参",
    output: "map<factorKey, boolean>",
    source: "data/factor-verified.json（批量 IC 验证流程写入）",
    source_type: "static_config", freshness: "static", availability: "db", data_status: "REAL",
    limitations: [
      "只有正式验证流程能改：AI / Agent 一律不得写这个账本，也不得把 verified=false 说成 verified=true",
      "账本只覆盖部分信号键，未列出的因子状态是 UNVERIFIED，不是「无效」",
    ],
    fallbacks: ["factor_test"], mutating: false,
    examples: ["这个因子过去有效吗"],
  },
  {
    name: "factor_test", title: "因子 IC 测试记录", group: "研究",
    description: "读因子测试台历史跑批记录（IC/RankIC/分层/样本区间）。",
    input: "GET /api/quant/factor-test（可按 factorKey 过滤）",
    output: "items[]: factor_key/ic/rank_ic/icir/sample/period/status",
    source: "SQLite factor_test",
    source_type: "database", freshness: "static", availability: "db", data_status: "HISTORICAL",
    limitations: ["记录是**过去某次跑批**的结果：区间外推必须显式说明"],
    fallbacks: [], mutating: false,
    examples: ["这个因子哪次测的，样本多少"],
  },
  {
    name: "backtest", title: "回测", group: "研究",
    description: "对策略/信号做历史回测，输出净值、回撤、分组表现。",
    input: "POST /api/quant/backtest（策略或条件 + 区间）",
    output: "equity/metrics（annual、maxDrawdown、turnover）",
    source: "本机回测引擎 + 腾讯/eltdx 日K",
    source_type: "derived_engine", freshness: "static", availability: "engine", data_status: "HISTORICAL",
    limitations: ["回测不等于未来表现；使用当前成分名单，存在幸存者偏差"],
    fallbacks: [], mutating: false,
    examples: ["这套条件历史上赚多少"],
  },
  {
    name: "probability", title: "历史条件概率", group: "研究",
    description: "给定 K 线口径条件，统计历史上命中后 1/5/20 日上涨概率、均值、最大回撤、基准与超额。",
    input: "conditions[] + universe + trade_date(可选历史回放)",
    output: "pooled[]/per_symbol[]: win_rate/sample_size/period, benchmark, warnings[], sample_ok",
    source: "本机历史回放引擎",
    source_type: "derived_engine", freshness: "daily", availability: "engine", data_status: "HISTORICAL",
    limitations: [
      "样本 < 30 标不足：只能写「仅供参考」，不得当结论",
      "「过去 n 个样本胜率 x%」≠「今天上涨概率 x%」：历史统计与当前预测必须分开表述",
      "快照口径条件不参与历史匹配，会被忽略并写进 warnings",
      "K线取数失败的标的在 per_symbol[].error 里写明「取数失败」，不与「K线不足」混为一类；基准取不到时基准/超额为 null",
    ],
    fallbacks: ["snapshot_probability"], mutating: false,
    examples: ["MACD 金叉后 5 日 historically 胜率"],
  },
  {
    name: "screener", title: "因子选股器", group: "研究",
    description: "按因子条件在全 A 里筛选，返回漏斗与结果行。",
    input: "conditions[] + fields[] + sort + pagination",
    output: "list[]/funnel/as_of_trade_date/warnings/source",
    source: "全 A 快照 + 日K 引擎",
    source_type: "derived_engine", freshness: "live", availability: "engine", data_status: "DERIVED",
    limitations: [
      "参与统计的个股数会随休市/停牌变化：口径提示在 warnings 里",
      "K线子集超出上限时按成交额取流动性 Top-K（其余不参与），漏斗只统计参与过的标的",
      "取数失败的标的会从K线条件里剔除并在 warnings 里单列只数：这不等于「它们不符合条件」",
    ],
    fallbacks: [], mutating: false,
    examples: ["帮我按 RPS 和资金流筛一批"],
  },
  {
    name: "candidate_pool", title: "候选池（冻结标的）", group: "研究",
    description: "读已冻结的选股候选及其验证状态。",
    input: "GET /api/pool/list",
    output: "items[]: symbol/frozen_price/price_basis/created_at/verify",
    source: "SQLite candidate_pool",
    source_type: "database", freshness: "static", availability: "db", data_status: "REAL",
    limitations: ["冻结价是当时的真实成交价口径，不与后复权序列混用"],
    fallbacks: [], mutating: false,
    examples: ["我之前冻结的那批还在吗"],
  },
  // ---------- 历史 ----------
  {
    name: "history_radar", title: "雷达历史归档回看", group: "历史",
    description: "按 asOf 日期只读回看某天的雷达信号行（含已消失的）。",
    input: "date=YYYY-MM-DD（可省，省=最近）, state",
    output: "items[]/counts/available_dates/missing[]/view_basis",
    source: "SQLite radar_finding（只读）",
    source_type: "database", freshness: "daily", availability: "db", data_status: "HISTORICAL",
    limitations: ["那天没留档就返回空 + 原因，绝不回退到别的日子或现算"],
    fallbacks: ["radar"], mutating: false,
    examples: ["上周三雷达里有什么"],
  },
  {
    name: "history_events", title: "事件历史归档回看", group: "历史",
    description: "按日期只读回看某天入库的全球事件。",
    input: "date=YYYY-MM-DD",
    output: "items[]/counts/available_dates/missing[]",
    source: "SQLite global_event（只读）",
    source_type: "database", freshness: "daily", availability: "db", data_status: "HISTORICAL",
    limitations: ["事件表没有逐行 state 列：superseded 恒为 null，不是「都没消失过」"],
    fallbacks: ["events"], mutating: false,
    examples: ["那天有什么事件入库"],
  },
  {
    name: "snapshot_risk", title: "风险每日留档", group: "历史",
    description: "回看风险页的历史留档行（当次完整响应原样存回）。",
    input: "GET /api/snapshot?kind=risk&date=",
    output: "items[]: computed_at/trade_date/headline/missing/source/payload",
    source: "SQLite risk_snapshot",
    source_type: "database", freshness: "daily", availability: "db", data_status: "SNAPSHOT",
    limitations: ["留档只在人工点击「留档今天」时产生：没点的那天不会有行"],
    fallbacks: ["risk"], mutating: false,
    examples: ["上周五的风险等级是多少"],
  },
  {
    name: "snapshot_themes", title: "主线每日留档", group: "历史",
    description: "回看主线发现页的历史留档行。",
    input: "GET /api/snapshot?kind=themes&date=",
    output: "items[]: computed_at/trade_date/headline/missing/payload",
    source: "SQLite theme_snapshot",
    source_type: "database", freshness: "daily", availability: "db", data_status: "SNAPSHOT",
    limitations: ["同上：留档不是自动的"],
    fallbacks: ["themes"], mutating: false,
    examples: ["上周主线是什么时候形成的"],
  },
  {
    name: "snapshot_probability", title: "条件概率每日留档", group: "历史",
    description: "回看某次条件概率计算（连同当时那组 conditions）的留档行。",
    input: "GET /api/snapshot?kind=probability&date=",
    output: "items[]: headline/missing/payload(含请求条件)",
    source: "SQLite probability_snapshot",
    source_type: "database", freshness: "daily", availability: "db", data_status: "SNAPSHOT",
    limitations: ["离开条件的胜率没有意义：留档必须连带当次 conditions 一起存"],
    fallbacks: ["probability"], mutating: false,
    examples: ["上次算的那组条件胜率是多少"],
  },
  {
    name: "trade_dates", title: "真实交易日历", group: "历史",
    description: "从上证指数真实日线取出的交易日序列（历史回放选日用）。",
    input: "GET /api/quant/screener/trade-dates?n=",
    output: "dates[]/as_of_trade_date",
    source: "腾讯 000001.SH 日K",
    source_type: "derived_engine", freshness: "daily", availability: "engine", data_status: "HISTORICAL",
    limitations: ["没有独立节假日表：取不到日K 时返回空，不猜哪天开市"],
    fallbacks: [], mutating: false,
    examples: ["上一个交易日是哪天"],
  },
  // ---------- 运维 ----------
  {
    name: "task_status", title: "扫描/调度运行记录", group: "运维",
    description: "读 task_run：每次扫描的模式、状态、落库条数、休市判定。",
    input: "GET /api/tasks/status",
    output: "runs[]/latest/cursors",
    source: "SQLite task_run + scan_cursor",
    source_type: "database", freshness: "intraday", availability: "db", data_status: "REAL",
    limitations: ["记录只说明「跑过、结果如何」：服务未启动的时间段不会有记录，不能推断为自动运行过"],
    fallbacks: [], mutating: false,
    examples: ["最近一次扫描是什么时候、成没成功"],
  },
  {
    name: "lifecycle_preview", title: "数据生命周期 dry-run", group: "运维",
    description: "按 180 天保留期预览哪些归档日将被清理（只读，不删）。",
    input: "GET /api/lifecycle/preview",
    output: "cutoff/candidates[]/protected_days[]/plan_hash/can_execute/policy_notes/missing",
    source: "SQLite radar_finding + global_event",
    source_type: "database", freshness: "daily", availability: "db", data_status: "DERIVED",
    limitations: ["真正的执行接口 POST /api/lifecycle/purge 会物理删除，Agent 不得调用（mutating=true，不在只读白名单内）"],
    fallbacks: [], mutating: false,
    examples: ["还有多少天的数据可以清"],
  },
  {
    name: "provider_health", title: "数据源健康与覆盖", group: "运维",
    description: "读已注册 Provider 的覆盖能力与本机网关是否在线。",
    input: "GET /api/quant/health",
    output: "providers[]: id/coverage(daily/minute/fundamentals/universeMembership)",
    source: "Provider 注册表 + eltdx /rpc 探活",
    source_type: "derived_engine", freshness: "live", availability: "engine", data_status: "REAL",
    limitations: ["coverage 只描述 Provider 接口能力，不代表某一时刻上游真的返回了数据"],
    fallbacks: [], mutating: false,
    examples: ["现在哪个源可用"],
  },
  {
    name: "capability_registry", title: "数据能力登记表（本表）", group: "运维",
    description: "GET /api/capabilities：全量登记表的机器可读视图，支持 ?name= 单条与 ?need= 需求匹配。",
    input: "无参 / name=能力名 / need=自然语言需求",
    output: "items[]: name/title/group/source/limitations/fallbacks, read_only_names[], basis, answer",
    source: "src/lib/quant/screener/capability-core.ts（静态登记）",
    source_type: "static_config", freshness: "static", availability: "engine", data_status: "REAL",
    limitations: [
      "登记的是「系统能做哪类事」，不是「此刻取到了什么」：要现状必须另调 capability_probe",
      "need 匹配只按关键词粗筛，匹配不到即承认为缺口，不会硬凑一个相近能力",
    ],
    fallbacks: ["capability_probe"], mutating: false,
    examples: ["你现在能查哪些数据"],
  },
  {
    name: "capability_probe", title: "能力可用性探测", group: "运维",
    description: "GET /api/capabilities/probe：逐条能力给四态观测（取到/真0/无内容/失败/未覆盖/未探测），?live=1 才打上游。",
    input: "live=1（打真实上游小请求）, force=1（绕 20 秒缓存）, only=能力名",
    output: "probes[]: kind/status/scope/evidence/freshness_s/note, counts, layering, missing[], self_check",
    source: "本机 SQLite 计数 + 上游接口实打（envelopeOf 强制自洽）",
    source_type: "derived_engine", freshness: "intraday", availability: "engine", data_status: "DERIVED",
    limitations: [
      "scope=channel 只证明「这条通道可达」，不代表该能力今天取到了完整数据",
      "probed=false 表示本次没探测，不是数据缺失；两者在面板上分列",
      "探测层永远不产出 VERIFIED：因子验证状态只能由正式批量 IC 流程写入",
    ],
    fallbacks: ["provider_health"], mutating: false,
    examples: ["现在哪些数据源是通的"],
  },
  {
    name: "ai_context_layering", title: "AI 上下文来源分层", group: "运维",
    description: "注入模型的每段行情上下文逐条标 REAL/DERIVED/DEMO/MISSING/DERIVED_ON_DEMO，并随文附数据纪律。",
    input: "客户端组装（#/assistant 助理页、#/analysis 图表分析页）",
    output: "【行情上下文】文本块：逐条「标签｜层级｜口径」+ 取数时刻 + 【数据纪律】",
    source: "src/lib/desk/ai-context-core.ts（纯内核）",
    source_type: "static_config", freshness: "live", availability: "engine", data_status: "AI_INTERPRETATION",
    limitations: [
      "分层只保证「AI 知道哪条是演示数据」，不改变上游取数结果：AI 的输出仍属解释，不是行情事实",
      "数量级防幻觉锚点只在 REAL 现价上生效：演示价/缺失价一律不参与校验，避免用假数据判真回答",
      "未标注来源的卡片按 MISSING 处理（宁可说没取到，不默认成真实）",
      "AI 交易员（POST /api/ai/chat）走的是另一套入口：它的纪律是「工具返回 missing 必须写暂无数据」，不经过本层文本",
    ],
    fallbacks: [], mutating: false,
    examples: ["你刚才那句结论用的是真数据还是演示数据"],
  },
  {
    name: "mcp_tools", title: "外部 MCP 工具", group: "运维",
    description: "列出/调用已配置 MCP 服务器暴露的工具（如 china-stock-mcp 的行情工具）。",
    input: "GET /api/mcp/tools；POST /api/mcp/call {server, tool, args}",
    output: "tools[] / 调用返回原样内容",
    source: "本机 MCP 服务器（stdio / QUANT_MCP_URL HTTP）",
    source_type: "mcp", freshness: "live", availability: "live", data_status: "REAL",
    limitations: [
      "服务器不可用时必须返回「MCP unavailable」并原样带上错误，禁止假装调用成功",
      "已配置的 demo-market 服务器脚本产出的是演示数据，不能作为真实行情来源",
      "未 trusted 的服务器需要人工确认后才执行",
    ],
    fallbacks: ["stock_quote", "stock_kline"], mutating: true,
    examples: ["有没有另一条能取行情的外部通道"],
  },
  // ---------- 明确未覆盖（让 Agent 知道这条路是死的） ----------
  {
    name: "northbound_flow", title: "北向资金净流入", group: "行情",
    description: "曾经可用的北向资金净流入。",
    input: "无（该口径已停止披露，没有可查询的入参）",
    output: "恒为缺失：missing + 原因，不返回 0",
    source: "交易所披露口径",
    source_type: "http_direct", freshness: "daily", availability: "not_covered", data_status: "MISSING",
    limitations: ["交易所自 2024-08-19 起不再披露官方数据：无可靠来源 ⇒ missing + 说明，绝不用 0 或估算值代替"],
    fallbacks: [], mutating: false,
    examples: ["北向今天买了多少（答：无法取得）"],
  },
  {
    name: "stock_announcements", title: "个股公告", group: "行情",
    description: "交易所/巨潮个股公告流。",
    input: "无（当前代码里没有公告源的取数路径）",
    output: "当前代码里没有该能力",
    source: "交易所/巨潮公告接口（本仓库未接入）",
    source_type: "http_direct", freshness: "daily", availability: "not_covered", data_status: "MISSING",
    limitations: ["未接入公告源：涉及「消息面」的判断只能标 AI_HYPOTHESIS，不能声称看过公告"],
    fallbacks: ["market_news"], mutating: false,
    examples: ["这只票最近有没有公告（答：当前无该数据源）"],
  },
  {
    name: "board_day_streak", title: "板块日K连续强势天数", group: "信号",
    description: "板块自身连续强势/连续流入的天数。",
    input: "boardCode",
    output: "streak 或 null",
    source: "东财板块日K（实测有批次无返回）",
    source_type: "http_direct", freshness: "daily", availability: "not_covered", data_status: "MISSING",
    limitations: ["东财板块日K 不稳定：无返回时保持 null 并计入 missing，已确认的口径是不用替代数据源硬凑"],
    fallbacks: [], mutating: false,
    examples: ["这个板块已经强势几天"],
  },
];

export const CAPABILITY_NAMES: string[] = CAPABILITIES.map((c) => c.name);

export function findCapability(name: string | null | undefined): CapabilityDef | null {
  const v = String(name ?? "").trim();
  return CAPABILITIES.find((c) => c.name === v) ?? null;
}

/** Agent 只允许使用只读能力：写库/删库/外部执行(mcp_tools) 一律排除，避免把研究系统做成会改状态的系统 */
export function readOnlyCapabilities(): CapabilityDef[] {
  return CAPABILITIES.filter((c) => !c.mutating);
}

export const GROUP_ORDER: CapabilityDef["group"][] = ["行情", "信号", "研究", "历史", "运维"];

/** 登记表自身的口径说明：明确「只列真实存在的能力」，以及未覆盖为什么也在表里 */
export function registryBasis(): string {
  const nc = CAPABILITIES.filter((c) => c.availability === "not_covered").length;
  return `登记表逐条对应代码里真实存在的路由/引擎（共 ${CAPABILITIES.length} 项，其中 ${nc} 项明确「当前无可靠来源」）：` +
    "能力存在 ≠ 此刻取得数据，可得性要看同一次探测返回的 kind；" +
    "mutating=true 的能力不在 Agent 可用范围内。";
}

/** 某能力不可用时对人说的话（区分「没跑起来」和「本来就没有这个数据源」）：
 *  只给原因、不带标题——标题由调用方（探测结果的 missing 行）加一次，避免出现「A：A：…」 */
export function unavailableNote(cap: CapabilityDef, kind: ObservationKind): string {
  if (cap.availability === "not_covered") {
    return `没有可靠数据源（${cap.limitations[0] ?? "未覆盖"}），本项目不用估算值或 0 顶替。`;
  }
  switch (kind) {
    case "request_failed": return "本次取数失败，已按失败处理（不显示为 0、也不沿用上一次结果）。";
    case "no_data": return `请求成功但本次没有内容（${OBS_KIND_NO_DATA_HINT}）。`;
    default: return "当前不可用。";
  }
}
const OBS_KIND_NO_DATA_HINT = "例如当日无命中、休市、库里那天没留档";

/**
 * 不可用行的完整措辞 = 四态分类的标准文案 + 本次探测给出的具体原因。
 * 只有标准文案会丢掉真实原因（例如 MCP「没有一个服务器 ready」被写成「休市」那种泛化解释），
 * 那不利于判断缺口；所以补上具体原因，但不重复能力标题（标题由 UI / missing 行各加一次）。
 */
export function unavailableNoteWith(cap: CapabilityDef, kind: ObservationKind, reason: string): string {
  const base = unavailableNote(cap, kind);
  const why = (reason ?? "").trim();
  if (!why || kind === "not_covered" || base.includes(why)) return base;
  return `${base} 具体原因：${why}`;
}

/** 「我现在能查什么」的一句话清单（任务书 §七），按组给出可用/降级/未覆盖三段计数 */
export function capabilitiesAnswer(): { 可用: string[]; 当前取不到: string[]; 无可靠来源: string[]; 说明: string } {
  return {
    可用: CAPABILITIES.filter((c) => c.availability !== "not_covered").map((c) => c.name),
    当前取不到: [],
    无可靠来源: CAPABILITIES.filter((c) => c.availability === "not_covered").map((c) => c.name),
    说明: registryBasis(),
  };
}

/**
 * 需求 → 候选能力的粗匹配（P6-D 的 Agent 用它把「我还缺什么」翻译成「该调什么」）。
 * 只做关键词映射，不做语义猜测：匹配不上就返回空，让调用方显式承认缺口。
 */
const NEED_KEYWORDS: Record<string, string[]> = {
  行情: ["stock_quote", "market_snapshot", "index_benchmark"],
  k线: ["stock_kline"],
  走势: ["stock_kline"],
  资金: ["fund_flow_stock", "sector_rank", "stock_trades_proxy"],
  板块: ["sector_rank", "sector_members"],
  主线: ["themes"],
  风险: ["risk"],
  情绪: ["sentiment"],
  涨停: ["limitup", "sentiment"],
  信号: ["radar"],
  事件: ["events"],
  解读: ["event_interpret"],
  理解: ["event_interpret"],
  摘要: ["event_interpret"],
  影响: ["event_interpret", "events"],
  新闻: ["market_news"],
  因子: ["factor_catalog", "factor_verified", "factor_test"],
  胜率: ["probability"],
  回测: ["backtest"],
  选股: ["screener"],
  历史: ["history_radar", "history_events"],
  留档: ["snapshot_risk", "snapshot_themes", "snapshot_probability"],
  盘口: ["stock_depth"],
  健康: ["provider_health", "task_status"],
  能力: ["capability_registry", "capability_probe"],
  探测: ["capability_probe"],
  可用: ["capability_probe", "provider_health"],
  缺口: ["capability_registry", "northbound_flow", "stock_announcements", "board_day_streak"],
  幻觉: ["ai_context_layering"],
  演示: ["ai_context_layering"],
  来源: ["ai_context_layering", "capability_registry"],
};

export interface NeedMatch { name: string; matched: string[] }

/** need → 能力：一个词命中多个能力时按「命中了多少个需求词」排序，命中多的排在前面 */
export function capabilitiesForNeed(need: string): NeedMatch[] {
  const q = String(need ?? "").toLowerCase();
  if (!q.trim()) return [];
  const hits = new Map<string, string[]>();
  for (const [k, v] of Object.entries(NEED_KEYWORDS)) {
    if (!q.includes(k.toLowerCase())) continue;
    for (const name of v) {
      const cap = findCapability(name);
      if (!cap || cap.mutating) continue; // 只读白名单：写操作能力不因「名字像」而被推荐
      hits.set(name, [...(hits.get(name) ?? []), k]);
    }
  }
  return [...hits.entries()]
    .map(([name, matched]) => ({ name, matched }))
    .sort((a, b) => b.matched.length - a.matched.length || a.name.localeCompare(b.name));
}

/** 需求没命中任何关键词时给的方向：只指登记过的入口，不猜一个不存在的能力 */
export function needHints(need: string): string[] {
  const q = String(need ?? "").toLowerCase();
  if (!q.trim()) return [];
  const groups = new Set<string>();
  for (const cap of CAPABILITIES) {
    const hay = `${cap.title} ${cap.description} ${cap.examples.join(" ")}`.toLowerCase();
    for (const word of q.split(/[\s,，、]+/).filter((w) => w.length >= 2)) {
      if (hay.includes(word)) groups.add(cap.group);
    }
  }
  return [...groups];
}

/** 兜底链：主源/主能力不可用时按登记顺序给出下一个只读候选（任务书 §十六「碰壁能力」的数据基础） */
export function fallbackChain(name: string): CapabilityDef[] {
  const cap = findCapability(name);
  if (!cap) return [];
  return cap.fallbacks.map((f) => findCapability(f)).filter((c): c is CapabilityDef => !!c && !c.mutating);
}
