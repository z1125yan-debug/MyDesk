"use client";
// 量化选股工作台（S3 稳智 /screener 复刻）：四栏条件卡 + 自定义条件 + 已选条件 + 筛选 + AI 优选 + 策略存取。
// 全部功能走本站真引擎：POST /api/quant/screener（真筛选）、/api/ai/chat（真 AI 优选）、
// 因子目录 GET /api/quant/factors?catalog=1（只列 implemented 字段，不做假因子）。策略存 localStorage。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, X } from "lucide-react";
import { useDesk, type ChatHorizon, type FrozenPool } from "@/lib/desk/store";
import { normalizeSectorKeyword } from "@/lib/quant/screener/sector-keyword-core";
import { plainCode, codeTitle } from "@/lib/desk/code-format";
// P36-D 因子真相：条件卡片要当场说清这个条件历史上有没有用、是不是反着走的
import { condAuditOf, truthDetailOf, type FactorTruth } from "@/lib/quant/factors/factor-truth-core";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
// P36-E6 档位切换条：强势 / 震荡 / 弱势（不用「牛市/熊市」，判的是最近几周的方向）
import RegimeSwitchBar from "@/components/desk/pages/RegimeSwitchBar";

type CatalogField = { key: string; zh: string; category: string; source?: string; implemented?: boolean; unit?: string; truth?: FactorTruth | null };
type CondType = "single" | "rolling_return" | "rolling_sum" | "rolling_any";
type Cond = { field: string; zh: string; op: string; value: string; type?: CondType; window?: number; min_match_days?: number };
// 社区策略库（稳智「我的策略」，条件字段已映射为本站因子 key）
type LibCond = { field: string; op: string; value: number | string | (number | string)[]; type?: CondType; window?: number; min_match_days?: number };
type LibStrategy = {
  id: number; name: string; owner?: string; like: number; dislike: number; vote: number;
  n_total: number; n_mapped: number; conds: LibCond[];
  unmapped: { raw: Record<string, unknown>; reason: string }[]; approx: string[];
};
// 「预测」按钮（P33）：/api/quant/strategy-forecast 的返回形状（服务端 packForecast 纯核打包）
type ForecastItem = {
  kind: "combo" | "single"; key: string; name: string; memberIds: number[];
  source: string; reason: string; record: null;
};
// P34-2 分档回测推荐：按大盘档位（强/震/弱）给该档历史表现最好的几条。
// 与上面 items（过闸推荐）是两条独立的线——items 靠社区门槛，正常市况恒空；这条靠历史成绩，任何档位都有。
// P36-B：stat 是「扣掉手续费后」的成绩；oos = 没参与挑选的那段行情单独验出来的成绩。
// 界面主展示 oos（有的话），并且每个数字旁必须带口径标签——裸数字不许出门。
type RegimeItem = {
  id: number; name: string;
  stat: {
    n: number; win: number; avg: number; avg5: number; winCi?: string;
    oos?: { n: number; win: number; net1: number; net5: number | null; winCi: string } | null;
  };
  win1: number; n1: number;
  basis?: string;
};
type ForecastRegime = {
  regime: string | null; asOf: string | null; isReplay: boolean; items: RegimeItem[];
  method: string; window: string; note: string; error: string;
  /** 口径说明（成交价/手续费/时间切分），人话，直接展示 */
  basis?: { entry?: string; exit?: string; cost?: string; costAdjusted?: boolean; untradeable?: string; split?: string; caveat?: string };
};
type ForecastData = {
  ok: boolean; as_of: string;
  tier: { score: number | null; tier: string; line: string; error: string; components: { name: string; score: number | null; available: boolean; reading: string }[] };
  counts: { total: number; gated: number; pass: number; blocked: number; unknown: number };
  gates: Record<string, { pass: boolean; unknown: boolean; threshold: number }>;
  items: ForecastItem[];
  marketProb: { state: "accumulating"; n: number; target: number; note: string };
  tierOk: boolean;
  regime: ForecastRegime;
};

const OPS = [">=", "<=", ">", "<", "=", "!="];

/* ---------------- 稳智「交给稳智AI优选」弹窗的参数（源码实证：StockScreener-*.js 的 at()） ---------------- */
// 分析周期：稳智给的是英文 value（ultra_short / short_mid_term / mid_term），文案逐字照搬。
// 本地请求只认 5 档 ChatHorizon，这里做一次显式映射（对齐稳智「payload 带 trading_horizon」的口径）：
//   超短线（1-3个交易日） → short（短线 1-3 天，最接近）
//   短中期（1-3周）        → mid  （中线 5-20 天 ≈ 1-4 周）
//   中期波段（1-8周）      → long （长线 20 天以上）
const POOL_HORIZONS: { value: string; label: string; local: ChatHorizon }[] = [
  { value: "ultra_short", label: "超短线（1-3个交易日）", local: "short" },
  { value: "short_mid_term", label: "短中期（1-3周）", local: "mid" },
  { value: "mid_term", label: "中期波段（1-8周）", local: "long" },
];
// 风险偏好的 value 就是中文串本身（稳智 radio-button 的 value 口径，逐字）
const POOL_RISKS = ["稳健", "均衡", "激进"] as const;
const POOL_COUNTS = [3, 5, 10] as const;
// 预设条件芯片（稳智同款：每颗 chip=一条带阈值的完整条件，两列排布）。
// fieldZh 必须与因子目录 zh 一致才渲染——目录没有的字段不摆假牌。
type ChipPreset = { chip: string; conds: { field: string; op: string; value: number }[] };
const p = (chip: string, field: string, op: string, value: number): ChipPreset => ({ chip, conds: [{ field, op, value }] });
// 区间型 chip（稳智「总市值50亿-200亿」这类）：一条 chip = 两个边界条件
const pr = (chip: string, field: string, lo: number, hi: number): ChipPreset => ({ chip, conds: [{ field, op: ">=", value: lo }, { field, op: "<=", value: hi }] });
const PRESET_CARDS: { title: string; sections: { section: string; chips: ChipPreset[] }[] }[] = [
  { title: "基础与板块", sections: [
    { section: "估值与市值", chips: [p("市盈率≤30","pe_ttm","<=",30), p("市净率≤3","pb","<=",3), p("总市值≥500亿","market_cap_yi",">=",500), pr("总市值50亿-200亿","market_cap_yi",50,200), p("流通市值≥100亿","floatcap_yi",">=",100), p("流通市值≤50亿","floatcap_yi","<=",50)] },
    { section: "量能与活跃度", chips: [p("今日涨停","is_limit_up","=",1), p("换手率≥3%","turnover_rate",">=",3), p("换手率<1%(低)","turnover_rate","<",1), p("量比≥1.5","volume_ratio",">=",1.5), p("成交额≥1亿","amount_yi",">=",1), p("倍量信号","double_volume_signal","=",1), p("振幅≥8%(活跃)","amplitude",">=",8), p("量能信号","volume_signal","=",1)] },
    { section: "行业强度", chips: [p("行业整体RPS_50≥80","sector_rps_50",">=",80), p("行业整体RPS_120≥80","sector_rps_120",">=",80), p("行业RPS_50≥80","in_sector_rps_50",">=",80), p("行业RPS_120≥80","in_sector_rps_120",">=",80)] },
    { section: "趋势与均线", chips: [p("站上MA5","above_ma_5","=",1), p("站上MA10","above_ma_10","=",1), p("站上MA20","above_ma_20","=",1), p("站上MA60","above_ma_60","=",1), p("站上MA90","above_ma_90","=",1), p("站上MA144","above_ma_144","=",1), p("RPS50≥70","rps_50",">=",70), p("RPS120≥70","rps_120",">=",70), p("RPS综合≥80","rps_composite",">=",80), p("EMA14>EMA26","ema14_gt_ema26","=",1)] },
  ]},
  { title: "技术与资金", sections: [
    { section: "动量与形态", chips: [p("MACD金叉","macd_cross","=",1), p("KDJ金叉","kdj_cross","=",1), p("RSI超卖","rsi_14","<=",30), p("RSI超买","rsi_14",">=",70), p("长上影线","upper_shadow_ratio",">=",3), p("长下影线","lower_shadow_ratio",">=",3)] },
    { section: "主力资金与成本", chips: [p("庄家控盘>50","zsb_dealer",">=",50), p("主力吸筹","zsb_accum",">=",1), p("强势吸筹选股","strong_acc_pick","=",1), p("强势吸筹3+条件","strong_acc_conds_met",">=",3), p("主力攻击","zsb_attack",">=",1), p("主力触发","zsb_trigger",">=",1), p("资金RSI强(>50)","zsb_rsi_v",">=",50), p("突破20日成本","break_cost_20","=",1), p("突破60日成本","break_cost_60","=",1), p("RSI_V减仓信号","zsb_rsi_reduce","=",1)] },
    { section: "VWAP与高斯", chips: [p("VWAP趋势分≥5","vwap_score",">=",5), p("VWAP允许做多","allow_long","=",1), p("VWAP低吸回踩","vwap_lowpullback","=",1), p("VWAP突破放量","vwap_break_expand","=",1), p("VWAP加速","vwap_accel",">",0), p("VWAP位置","vwap_pos",">",0), p("入场信号","entry_signal","=",1), p("高斯趋势向上","gauss_trend_up","=",1), p("高斯趋势起航","gauss_entry","=",1), p("高斯拐头向上","gauss_trend_flip_up","=",1)] },
  ]},
  { title: "信号与形态", sections: [
    { section: "共振与转强", chips: [p("★超级共振★","super_resonance_signal","=",1), p("共振:主力拉升","super_resonance_main","=",1), p("共振:趋势起航","super_resonance_trend","=",1), p("★竞价弱转强★","bidding_reversal_signal","=",1)] },
    { section: "支撑阻力", chips: [p("60日支撑附近","support_near_60","=",1), p("144日支撑附近","support_near_144","=",1), p("突破60日压力","resistance_breakout_60","=",1), p("突破144日压力","resistance_breakout_144","=",1)] },
    { section: "缠论与形态", chips: [p("缠论底分型","chan_bottom_fractal","=",1), p("缠论顶分型","chan_top_fractal","=",1), p("缠论三买","chan_third_buy","=",1), p("缠论三卖","chan_third_sell","=",1), p("中枢开始","cz_start","=",1), p("中枢结束","cz_end","=",1), p("中枢向上突破","cz_break_up","=",1), p("江恩1:1支撑","gann_support_sig_1_1","=",1), p("江恩1:2支撑","gann_support_sig_1_2","=",1), p("江恩2:1支撑","gann_support_sig_2_1","=",1), p("看涨吞没","candle_bullish_engulf","=",1), p("早晨之星","candle_morning_star","=",1)] },
    { section: "TD序列", chips: [p("TD买入结构9","td_buy_seq","=",9), p("TD13买入优选","td13_buy_qualified","=",1), p("TD卖出结构9","td_sell_seq","=",9), p("TD13卖出优选","td13_sell_qualified","=",1)] },
  ]},
];

export default function ScreenerWorkbench() {
  const [fields, setFields] = useState<CatalogField[]>([]);
  const [conds, setConds] = useState<Cond[]>([]);
  const takeScreenerHandoff = useDesk((s) => s.takeScreenerHandoff);
  // 2026-09-26 稳智「AI优选」对齐：冻结候选池进 store.frozenPools（持久化、可回看），
  // 「前往 AI」走 askAiWithPool（跳对话页 + 预填，**不自动发送**）。
  const addFrozenPool = useDesk((s) => s.addFrozenPool);
  const dropFrozenPool = useDesk((s) => s.dropFrozenPool);
  const askAiWithPool = useDesk((s) => s.askAiWithPool);
  const frozenPools = useDesk((s) => s.frozenPools);
  // 「AI优选记录」= 冻结池里 source 为 AI优选 的那批（对齐稳智 GET /candidate-pools 的列表语义）
  const aiPools = useMemo(() => frozenPools.filter((p) => p.source === "AI优选"), [frozenPools]);
  // P48：板块页点板块名递过来的一棒（对齐稳智 /screener?sector=）：预置一条 `sector_concept like` 条件。
  // 挂载时取一次即清；取到后等这条就位再放开首屏自动筛选，避免「先跑了空条件、再补条件」的抖动。
  const [handoffNotice, setHandoffNotice] = useState("");
  const [handoffReady, setHandoffReady] = useState(false);
  useEffect(() => {
    const h = takeScreenerHandoff();
    if (h?.sectorLike) {
      // 对齐稳智：URL 里带的是**原始板块名**，选股页在消费时才规整成搜索关键词（含"人工智能→人工智"这类
      // 稳智原样裁剪）。这里同口径规整，保证「点板块名 → 命中集」与稳智一致。
      const kw = normalizeSectorKeyword(h.sectorLike) || h.sectorLike;
      setConds((cs) => [
        { field: "sector_concept", zh: `板块/概念: ${kw}`, op: "like", value: kw },
        ...cs.filter((c) => c.field !== "sector_concept"),
      ]);
      setHandoffNotice(`已按板块页跳转预置条件：板块/概念 like「${kw}」（口径=离线快照的申万行业串+概念串；原始板块名「${h.sectorLike}」按同源选股页规则规整）`);
    }
    setHandoffReady(true);
  }, [takeScreenerHandoff]);
  const [customField, setCustomField] = useState("");
  const [customOp, setCustomOp] = useState(">=");
  const [customValue, setCustomValue] = useState("");
  const [rollDays, setRollDays] = useState("7");
  const [rollOp, setRollOp] = useState("<=");
  const [rollValue, setRollValue] = useState("");
  const [orderBy, setOrderBy] = useState("change_pct");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  // 结果区（稳智同款）：历史交易日 + 可选显示列（引擎按 fields 回填 row.values）+ AI 优选记录
  const shDay = (offset: number) => {
    const d = new Date(Date.now() - offset * 864e5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // 交易日选择器：默认**留空**，表示「跟随行情源最新数据」。
  // 不能默认填今天——休市日（周末/节假日）会把 trade_date=今天 传上去，
  // 后端据此认为用户显式指定了日期，于是把上一交易日的行情标成今天（实测到的标注失实）。
  const [tradeDate, setTradeDate] = useState("");
  const [asOf, setAsOf] = useState("");
  /** 行情源最新数据实际所属交易日（休市日与 asOf 不同，页面据此如实标注） */
  const [quoteDate, setQuoteDate] = useState("");
  /** 滞后原因（服务端按交易日历+时段判定下发；页面只显示不推断） */
  const [quoteLag, setQuoteLag] = useState<{ lagging: boolean; badge: string; note: string } | null>(null);
  /** 因子缓存口径（服务端 warning 带回）：说清手上这批因子值是「盘中口径」还是「收盘口径」 */
  const [cacheNote, setCacheNote] = useState("");
  const [warmNotice, setWarmNotice] = useState("");
  const [selCols, setSelCols] = useState<CatalogField[]>([]);
  const [showAiRecords, setShowAiRecords] = useState(false);
  /** 正在展开查看的 AI优选记录（点记录展开它的冻结候选） */
  const [viewPool, setViewPool] = useState<FrozenPool | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 「交给稳智AI优选」弹窗（稳智同款 4 参；文案与控件形状逐字对齐） */
  const [poolDlg, setPoolDlg] = useState(false);
  const [poolBusy, setPoolBusy] = useState(false);
  const [poolError, setPoolError] = useState("");
  const [poolHorizon, setPoolHorizon] = useState<string>(POOL_HORIZONS[1].value);
  const [poolRisk, setPoolRisk] = useState<(typeof POOL_RISKS)[number]>("均衡");
  const [poolCount, setPoolCount] = useState<(typeof POOL_COUNTS)[number]>(5);
  const [poolNote, setPoolNote] = useState("");
  const [strategyName, setStrategyName] = useState("");
  const [strategies, setStrategies] = useState<{ name: string; conds: Cond[]; ts: number }[]>([]);
  const [showStrategies, setShowStrategies] = useState(false);
  // 社区策略库（稳智「我的策略」721 条）
  const [libTab, setLibTab] = useState<"mine" | "community">("mine");
  const [libAll, setLibAll] = useState<LibStrategy[] | null>(null);
  const [libQuery, setLibQuery] = useState("");
  const [libLoading, setLibLoading] = useState(false);
  const [libErr, setLibErr] = useState("");
  // 「预测」按钮（P33）：弹卡 + 推荐列表 + 组合名单状态
  const [fcOpen, setFcOpen] = useState(false);
  const [fcData, setFcData] = useState<ForecastData | null>(null);
  const [fcLoading, setFcLoading] = useState(false);
  const [fcErr, setFcErr] = useState("");
  // P34：历史回放日期（空=今天）。回填到服务端 ?date= 由 regime 判档 + 分档回测排名回放。
  const [fcDate, setFcDate] = useState("");
  /** 正在「选它」的推荐项 key（防连点） */
  const [fcPicking, setFcPicking] = useState("");
  /** 组合名单（并集）：点了推荐里的「组合」后，rows 被合并名单顶掉，「来自」列标注来源。
   *  任何一次普通筛选（runScreener）都会退出组合名单——它是展示层状态，不是筛选条件。 */
  const [comboRes, setComboRes] = useState<{ rows: Record<string, unknown>[]; names: string[]; note: string } | null>(null);
  /** 社区策略列表：被挡的默认收起（搜索时全量查） */
  const [showBlocked, setShowBlocked] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/quant/factors?catalog=1");
        const j = await r.json();
        const list: CatalogField[] = (j.fields ?? []).filter((f: CatalogField) => f.implemented !== false);
        setFields(list);
        // 默认显示列（稳智同款首屏列）：量能信号/MACD柱/流通市值/RPS50/RPS120/行业整体RPS_50/120/行业RPS_50/120 + 行业/K线形态/趋势压力线_60
        const want = ["volume_signal", "macd", "floatcap_yi", "rps_50", "rps_120", "sector_rps_50", "sector_rps_120", "in_sector_rps_50", "in_sector_rps_120"];
        const extras: CatalogField[] = [
          { key: "industry", zh: "行业", category: "" },
          { key: "kline_pattern", zh: "K线形态", category: "" },
          { key: "trend_pressure_60", zh: "趋势压力线_60", category: "" },
        ];
        setSelCols([...list.filter((f) => want.includes(f.key)), ...extras]);
      } catch { setFields([]); }
      try {
        setStrategies(JSON.parse(localStorage.getItem("mydesk-screener-strategies") ?? "[]"));
      } catch { /* 首次为空 */ }
    })();
  }, []);

  // P36-D：字段 → 历史检验真相。chip 渲染与结果区体检共用这一份，口径只有一处。
  const truthMap = useMemo(() => {
    const m: Record<string, FactorTruth> = {};
    for (const f of fields) if (f.truth) m[f.key] = f.truth;
    return m;
  }, [fields]);
  // 本次筛选用到的条件体检：真实计数（几个没验过、几个历史上反着走），不是写死的提示
  const audit = useMemo(
    () => condAuditOf(conds.map((c) => ({ field: c.field, zh: c.zh })), truthMap),
    [conds, truthMap],
  );

  const addPreset = (p: ChipPreset) => {
    const newConds: Cond[] = p.conds.map((c) => ({ field: c.field, zh: p.chip, op: c.op, value: String(c.value) }));
    setConds((cs) => [...cs.filter((x) => x.zh !== p.chip), ...newConds]);
  };

  const addCond = (f: CatalogField, op?: string, value?: string) => {
    const c: Cond = { field: f.key, zh: f.zh, op: op ?? ">=", value: value ?? "" };
    if (c.value === "") { setCustomField(f.key); setCustomOp(c.op); return; }
    setConds((cs) => [...cs.filter((x) => x.field !== f.key), c]);
  };
  // 首屏自动筛选（稳智同款：进页即出全量候选，不用手点）
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !fields.length || !handoffReady) return;
    autoRan.current = true;
    void runScreener(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, handoffReady]);

  const addCustom = () => {
    const f = fields.find((x) => x.key === customField);
    if (!f || customValue === "") return;
    setConds((cs) => [...cs.filter((x) => x.field !== f.key), { field: f.key, zh: f.zh, op: customOp, value: customValue }]);
  };
  const addRolling = () => {
    const f = fields.find((x) => x.key === customField) ?? fields[0];
    if (!f || rollValue === "") return;
    setConds((cs) => [...cs, { field: f.key, zh: `近${rollDays}日${f.zh}`, op: rollOp, value: rollValue, type: "rolling_return", window: Number(rollDays) }]);
  };

  const [page, setPage] = useState(1);
  // 请求体抽成 bodyFrom(condsArg)：「预测·选它」要用**刚选的策略条件**直接跑筛选，
  // 不能等 setConds 异步落地后再跑（那会拿到旧条件）——runScreener 也从这里出请求体。
  const bodyFrom = useCallback((cs: Cond[], pg: number, limit = 20) => JSON.stringify({
    universe: "all_a",
    conditions: cs.map((c) => ({
      type: c.type ?? "single", field: c.field, op: c.op,
      // in/not in：值是逗号分隔的多值串 → 拆回数组（稳智多值口径）；其余按数值/字符串原样
      value: (c.op === "in" || c.op === "not in")
        ? String(c.value).split(",").map((s) => s.trim()).filter(Boolean)
        : (isNaN(Number(c.value)) ? c.value : Number(c.value)),
      window: c.window,
      min_match_days: c.min_match_days ?? (c.type === "rolling_return" ? Math.max(1, Math.floor((c.window ?? 7) / 2)) : undefined),
    })),
    fields: selCols.map((f) => f.key),
    trade_date: tradeDate || undefined,
    sort: { order_by: orderBy, order_dir: dir },
    // 列表页按 20/页翻页；建池时按稳智口径一次拿「页面排序前 300」再冻结
    pagination: { limit, offset: (pg - 1) * limit },
    maxKlineSymbols: 6000, // K线类因子列按流动性 Top-600 现场计算；全量 5152 家待 S2 盘后预计算
  }), [orderBy, dir, selCols, tradeDate]);
  const buildBody = useCallback((pg: number, limit = 20) => bodyFrom(conds, pg, limit), [bodyFrom, conds]);

  // condsOverride：「预测·选它（单条）」用刚选的策略条件立即筛选（不走异步的 conds state）。
  // 任何一次普通筛选都会退出组合名单（comboRes 只是展示层状态）。
  const runScreener = useCallback(async (gotoPage = 1, condsOverride?: Cond[]) => {
    setPage(gotoPage);
    setBusy(true); setError(""); setComboRes(null);
    try {
      const r = await fetch("/api/quant/screener", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: bodyFrom(condsOverride ?? conds, gotoPage),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "筛选失败");
      const list: Record<string, unknown>[] = j.rows ?? j.list ?? [];
      setRows(list);
      setTotal(j.total ?? list.length);
      setAsOf(j.as_of_trade_date ?? "");
      setQuoteDate(j.quote_date ?? "");
      setQuoteLag(j.quote_lag ?? null);
      // 缓存口径 warning 存下来（角标用）；服务端文案是唯一出处，前端不再自己拼
      const warns: string[] = Array.isArray(j.warnings) ? j.warnings : [];
      setCacheNote(warns.find((w) => w.startsWith("全市场因子值来自预计算缓存")) ?? "");
    } catch (e) {
      setError(String((e as Error).message || e));
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, [bodyFrom, conds]);

  /**
   * 每天第一次进页面：确保当日因子缓存存在；若手上那份是**盘中口径**而现在已经收盘，
   * 服务端会按收盘口径重算一遍（用户 2026-09-29：「收盘后需要再刷新一下，防止定在盘中」），
   * 算完这里自动重筛一次，用户不用管。
   * 只跑一次（ensureRan 闸）——预热是加速手段，失败或重复调用都不影响筛选本身。
   */
  const ensureRan = useRef(false);
  useEffect(() => {
    if (ensureRan.current) return;
    ensureRan.current = true;
    let stopped = false;
    void (async () => {
      try {
        const t0 = Date.now();
        const j = await (await fetch("/api/quant/factor-warm?ensure=1")).json();
        if (stopped || !j?.kicked) return;
        const closeRefresh = j.kickedBy === "ensure_close_refresh";
        const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
        const poll = async () => (await fetch("/api/quant/factor-warm")).json().catch(() => null);
        // 就绪判定不能只看「没在算」：runWarm 失败时 warming 也是 false，
        // 那会把「失败了」说成「已就绪」。必须同时看缓存真的有货、且 note 不是 error。
        const isReady = (s: { warming?: boolean; cached?: number; meta?: unknown; note?: string } | null): boolean =>
          !!s && !s.warming && ((s.cached ?? 0) > 0 || !!s.meta) && !(typeof s.note === "string" && s.note.startsWith("error"));

        // 先立刻查一次再决定说什么：整轮预热实测常常几秒就完（1.4s 也见过），
        // 原来上来就喊「正在后台预热」然后盲等 15s 才第一次查 —— 那 15 秒全是谎报。
        const first = await poll();
        if (isReady(first)) {
          setWarmNotice(closeRefresh
            ? `已按最新口径重算因子缓存（用时 ${secs()} 秒），正在重筛…`
            : `因子缓存已就绪（用时 ${secs()} 秒），下次筛选秒开`);
          if (closeRefresh) void runScreener(1);
          setTimeout(() => setWarmNotice(""), 6000);
          return;
        }
        setWarmNotice(closeRefresh
          ? "手上的因子缓存是盘中口径，正在按收盘口径重算（完成后本页自动重筛一次）…"
          : "当日因子缓存还没生成，正在后台算（这一轮可能慢些，之后秒开）…");
        // 3 秒起步逐步退避到 15 秒（比固定 15s 更快发现"其实已经好了"），最多约 9 分钟
        for (let i = 0, wait = 3000; i < 45 && !stopped; i++, wait = Math.min(Math.round(wait * 1.5), 15000)) {
          await new Promise((r) => setTimeout(r, wait));
          const s = await poll();
          if (!isReady(s)) continue;
          if (closeRefresh) {
            setWarmNotice(`已按最新口径重算因子缓存（用时 ${secs()} 秒），正在重筛…`);
            void runScreener(1);
          } else {
            setWarmNotice(`因子缓存已就绪（用时 ${secs()} 秒），下次筛选秒开`);
          }
          setTimeout(() => setWarmNotice(""), 8000);
          return;
        }
        // 等到超时仍没好：如实说没好，不要继续挂着"正在算"骗人
        if (!stopped) setWarmNotice(`因子缓存这一轮没算出来（已等 ${secs()} 秒），筛选照常可用，只是会慢一些`);
      } catch { /* 预热失败不影响筛选 */ }
    })();
    return () => { stopped = true; };
  }, [runScreener]);

  /** 从服务端 warning 里抽出「盘中口径 10:32 / 收盘口径 15:05」，做成角标 */
  const cachePhaseShort = useMemo(() => {
    const m = /（(盘中口径[^）]*|收盘口径[^）]*)）/.exec(cacheNote);
    return m?.[1] ?? "";
  }, [cacheNote]);

  /** 保证手上有候选：没筛过就先筛一轮（稳智同款：不要求先手点筛选——AI优选自带一次全量筛选）。
   *  · limit：页面列表 20/页；建池按稳智口径要「页面排序前 300」。
   *  · commit：建池用的那批（300 条）不写回页面 state，否则列表页会被撑成 300 行。
   *  返回 asOf/total 的**本次**读数，避免 setState 异步导致 createPoolAndGo 拿到旧值。 */
  const ensureRows = useCallback(async (limit = 20, commit = true): Promise<{ list: Record<string, unknown>[]; asOfDate: string; totalCount: number }> => {
    // 组合名单是并集语义，不能拿已选条件重跑覆盖它——AI优选建池直接冻结这份合并名单
    if (comboRes) return { list: comboRes.rows, asOfDate: asOf || quoteDate, totalCount: comboRes.rows.length };
    if (rows?.length && rows.length >= limit) return { list: rows, asOfDate: asOf || quoteDate, totalCount: total ?? rows.length };
    const sr = await fetch("/api/quant/screener", { method: "POST", headers: { "Content-Type": "application/json" }, body: buildBody(1, limit) });
    const sj = await sr.json();
    const list: Record<string, unknown>[] = sj.rows ?? sj.list ?? [];
    if (commit) { setRows(list); setTotal(sj.total ?? list.length); setAsOf(sj.as_of_trade_date ?? ""); setQuoteDate(sj.quote_date ?? ""); setQuoteLag(sj.quote_lag ?? null); }
    return { list, asOfDate: String(sj.as_of_trade_date ?? ""), totalCount: Number(sj.total ?? list.length) };
  }, [comboRes, rows, asOf, quoteDate, total, buildBody]);

  /**
   * 2026-09-26 稳智「交给稳智AI优选」对齐（源码实证 StockScreener-*.js 的 at()）：
   *   ① 冻结「当前交易日 + 当前筛选条件」的候选 → 写进 store.frozenPools（最多存前 300，对齐稳智 stored_count 上限）；
   *   ② 按稳智 5 行模板拼问句（逐字），另附**本地候选清单**——
   *      稳智的服务端能按 pool_id 取池（Agent 自己查），本地没有那个接口，清单必须随问句带过去；
   *   ③ 交棒给对话页：跳 copilot + 预填问句 + 候选池徽章 + 周期，**不自动发送**（对齐稳智 B.value=prompt）。
   */
  const createPoolAndGo = useCallback(async () => {
    setPoolError(""); setPoolBusy(true);
    try {
      const { list, asOfDate: fetchedAsOf, totalCount } = await ensureRows(300, false);
      if (!list.length) { setPoolError("当前交易日没有候选（可先调整筛选条件）"); return; }
      const asOfDate = fetchedAsOf || shDay(0);
      const name = strategyName.trim() || `量化候选池-${asOfDate}`;
      const numOrNull = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const stored = list.slice(0, 300);            // 冻结上限 300（稳智：最多保存页面排序前300只）
      const shown = stored.slice(0, 60);            // 进 prompt 的只放前 60——全量 300 条会把提示词挤爆
      const head = [
        `请从量化候选池中自主研究并优选，最多选出${poolCount}只；没有真正合格标的可以少选或不选。`,
        `我的风险偏好是${poolRisk}，交易周期按所选周期执行。`,
        "请自主决定评价维度、权重、需要补充的数据与工具调用，不要把页面原始排序当作推荐结果。",
        poolNote.trim(),
      ].filter(Boolean);
      const block = [
        `候选池（冻结于 ${asOfDate}，命中 ${totalCount} 只，以下为页面排序前 ${shown.length} 只；页面排序不是推荐）：`,
        ...shown.map((r, i) => {
          const pct = numOrNull(r.change_pct ?? r.pct);
          const amt = numOrNull(r.amount_yi);
          const to = numOrNull(r.turnover_rate);
          return `${i + 1}. ${String(r.symbol ?? r.code ?? "")} ${String(r.name ?? "")} 涨跌幅 ${pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`} 成交额 ${amt == null ? "—" : `${amt.toFixed(2)}亿`} 换手 ${to == null ? "—" : `${to.toFixed(2)}%`}`;
        }),
        stored.length > shown.length ? `（其余 ${stored.length - shown.length} 只按页面排序略去；页面顺序不推荐，需要时可自己调 factor_screener 换条件重筛）` : "",
      ].filter(Boolean);
      const prompt = [...head, "", ...block, "", "最终给出入选理由、入场条件、仓位节奏、失效条件和主要风险。"].join("\n");
      const pool: FrozenPool = {
        id: `aipool-${Date.now().toString(36)}`,
        createdAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        asOf: asOfDate,
        universe: "all_a",
        // 组合名单：组合是「满足任一」的并集语义，不是 AND 条件——这里只写一条**记录用**伪条件，
        // 候选池的真实名单在 rows 里（createPoolAndGo 冻结的就是 ensureRows 返回的组合名单）。
        conditions: comboRes
          ? [{ field: "__combo", op: "=", value: `组合（满足任一）：${comboRes.names.join(" + ")}` }]
          : conds.map((c) => ({ field: c.field, op: c.op, value: isNaN(Number(c.value)) ? c.value : Number(c.value) })),
        source: "AI优选",
        rows: stored.map((r) => ({
          symbol: String(r.symbol ?? r.code ?? ""),
          name: String(r.name ?? ""),
          close: numOrNull(r.close ?? r.price),
          changePct: numOrNull(r.change_pct ?? r.pct),
        })),
        prompt,
        label: `${name} · ${totalCount}只 · ${asOfDate}`,
      };
      addFrozenPool(pool);
      const hz = POOL_HORIZONS.find((h) => h.value === poolHorizon) ?? POOL_HORIZONS[1];
      setPoolDlg(false);
      // 交棒：跳对话页 + 预填（不发送）
      askAiWithPool({ poolId: pool.id, label: pool.label!, prompt, horizon: hz.local });
    } catch (e) {
      setPoolError(String((e as Error).message || e));
    } finally {
      setPoolBusy(false);
    }
  }, [ensureRows, strategyName, conds, comboRes, poolCount, poolRisk, poolNote, poolHorizon, addFrozenPool, askAiWithPool]);

  const saveStrategy = () => {
    const name = strategyName.trim() || `策略-${new Date().toLocaleDateString("zh-CN")}`;
    const next = [{ name, conds, ts: Date.now() }, ...strategies.filter((s) => s.name !== name)].slice(0, 30);
    setStrategies(next);
    localStorage.setItem("mydesk-screener-strategies", JSON.stringify(next));
    setStrategyName("");
  };

  // 社区策略库：打开面板时按需拉一次（本地静态库，721 条）
  const loadLibrary = useCallback(async () => {
    if (libAll || libLoading) return;
    setLibLoading(true);
    setLibErr("");
    try {
      const r = await fetch("/api/quant/strategy-library?limit=2000");
      const j = await r.json();
      setLibAll(Array.isArray(j.data) ? j.data : []);
    } catch (e) {
      setLibErr(String((e as Error).message || e));
      setLibAll([]);
    } finally {
      setLibLoading(false);
    }
  }, [libAll, libLoading]);

  // 把社区策略的条件映射为本站 Cond（补 zh 标签；缺 zh 的字段回退 key）。
  // 「预测·选它」也要用同一份映射——抽成 condsOfLib 供 applyLib / pickAndRun 共用。
  const condsOfLib = useCallback((s: LibStrategy): Cond[] => {
    const zhOf = (k: string) => fields.find((f) => f.key === k)?.zh ?? k;
    return s.conds.map((c) => ({
      // in/not in 的多值用逗号拼成展示串，buildBody 再按 op 拆回数组（板块/概念名不含逗号）
      field: c.field, zh: zhOf(c.field), op: c.op,
      value: Array.isArray(c.value) ? c.value.join(",") : String(c.value),
      ...(c.type && c.type !== "single" ? { type: c.type } : {}),
      ...(c.window ? { window: c.window } : {}),
      ...(c.min_match_days ? { min_match_days: c.min_match_days } : {}),
    }));
  }, [fields]);

  const applyLib = (s: LibStrategy) => {
    setComboRes(null);
    setConds(condsOfLib(s));
    setShowStrategies(false);
  };

  // 「预测」按钮（P33）：/api/quant/strategy-forecast（档位分 + 策略闸门 + 推荐打包 + 攒样本进度）。
  // 服务端自带 5 分钟 TTL；开策略面板也预取——「默认收起被挡策略」要吃这里的 gates。
  // date 非空 = 历史回放（看那天该用什么策略）；空 = 今天。两种结果各自缓存，不互相覆盖。
  const loadForecast = useCallback(async (date?: string | null) => {
    if (fcLoading) return;
    if (!date && fcData && !fcData.regime?.isReplay) return;
    setFcLoading(true); setFcErr("");
    try {
      const url = date
        ? `/api/quant/strategy-forecast?date=${encodeURIComponent(date)}`
        : "/api/quant/strategy-forecast";
      const r = await fetch(url);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "预测数据读取失败");
      setFcData(j as ForecastData);
    } catch (e) {
      setFcErr(String((e as Error).message || e));
    } finally {
      setFcLoading(false);
    }
  }, [fcLoading, fcData]);

  // 「选它」：单条 = 装条件立即筛选；组合 = 成员分别跑、按代码合并（并集），每只标「来自」。
  // 红线：选它只做筛选展示——不产出、不记录任何概率数字（使用台账是 P3 的事）。
  const pickAndRun = useCallback(async (it: ForecastItem) => {
    setFcPicking(it.key); setFcErr("");
    try {
      if (!libAll) await loadLibrary();
      const members = (libAll ?? []).filter((s) => it.memberIds.includes(s.id) && s.n_mapped > 0);
      if (!members.length) throw new Error("找不到这条策略的条件数据（或条件未映射到本站因子）");
      if (members.length === 1) {
        const c = condsOfLib(members[0]);
        setShowStrategies(false);
        await runScreener(1, c);
        setConds(c); // 同步已选条件 chips：之后的「筛选」/「AI优选」与刚才看到的是同一份条件
      } else {
        setBusy(true);
        let firstAsOf = ""; let firstQuote = "";
        const lists: Record<string, unknown>[][] = [];
        for (const m of members) {
          const r = await fetch("/api/quant/screener", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: bodyFrom(condsOfLib(m), 1, 100),
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `组合成员「${m.name}」筛选失败`);
          if (!firstAsOf) { firstAsOf = String(j.as_of_trade_date ?? ""); firstQuote = String(j.quote_date ?? ""); }
          lists.push((j.rows ?? j.list ?? []) as Record<string, unknown>[]);
        }
        // 并集合并：同一只票两个策略都命中 → 「两条都命中」；其余标首次命中的策略名
        const seen = new Map<string, Record<string, unknown>>();
        for (let i = 0; i < members.length; i++) {
          for (const r0 of lists[i]) {
            const sym = String(r0.symbol ?? r0.code ?? "");
            if (!sym) continue;
            const prev = seen.get(sym);
            if (prev) prev.__from = prev.__from === members[i].name ? prev.__from : "两条都命中";
            else seen.set(sym, { ...r0, __from: members[i].name });
          }
        }
        const merged = [...seen.values()];
        setRows(merged);
        setTotal(merged.length);
        setPage(1);
        setAsOf(firstAsOf); setQuoteDate(firstQuote); setQuoteLag(null); setCacheNote("");
        setComboRes({
          rows: merged, names: members.map((m) => m.name),
          note: `名单来自组合「${members.map((m) => m.name).join(" + ")}」：满足任一策略即入选（每条成员取排序前 100 只合并），「来自」列标了命中的策略；已选条件未改动，点「筛选」即退出组合名单。`,
        });
        setFcOpen(false);
      }
    } catch (e) {
      setFcErr(String((e as Error).message || e));
    } finally {
      setFcPicking(""); setBusy(false);
    }
  }, [libAll, condsOfLib, runScreener, bodyFrom]);

  // 社区列表展示集：无搜索时默认收起「带前提且今天被挡」的策略（搜索时全量查，方便找特定策略）。
  // 档位分没算出来（unknown）的不收——「没判」和「被挡」是两回事，页面如实分开显示。
  const libList = useMemo(() => {
    if (!libAll) return [];
    const q = libQuery.trim().toLowerCase();
    const matches = (s: LibStrategy) =>
      !q || String(s.name ?? "").toLowerCase().includes(q) || String(s.owner ?? "").toLowerCase().includes(q);
    if (q || showBlocked || !fcData) return libAll.filter(matches);
    return libAll.filter((s) => {
      const g = fcData.gates[String(s.id)];
      return matches(s) && (!g || g.pass || g.unknown);
    });
  }, [libAll, libQuery, showBlocked, fcData]);
  /** 被挡条数（unknown 不算被挡） */
  const libBlockedCount = useMemo(() => {
    if (!libAll || !fcData) return 0;
    return libAll.filter((s) => {
      const g = fcData.gates[String(s.id)];
      return g && !g.pass && !g.unknown;
    }).length;
  }, [libAll, fcData]);

  const cols = useMemo(() => {
    if (!rows?.length) return [];
    const first = rows[0];
    const zhOf: Record<string, string> = { symbol: "代码", code: "代码", name: "名称", close: "最新价", price: "最新价", change_pct: "涨跌幅" };
    const base = ["symbol", "code", "name", "close", "price", "change_pct"].filter((k) => k in first);
    // 引擎把 industry / kline_pattern / trend_pressure_60 放在**行顶层**（不在 values 里），
    // 只有因子目录类数值字段才在 values —— 取错层级会让这三列全显示「—」。
    const TOP_LEVEL = new Set(["industry", "kline_pattern", "trend_pressure_60", "__from"]);
    const valCols = selCols.map((f) => ({ key: f.key, zh: f.zh, fromValues: !TOP_LEVEL.has(f.key) }));
    const skip = new Set(["values", "fields", "industry", "kline_pattern", "trend_pressure_60", "__from", ...base, ...selCols.map((f) => f.key)]);
    const rawKeys = Object.keys(first).filter((k) => !skip.has(k));
    return [
      ...base.map((k) => ({ key: k, zh: zhOf[k] ?? k, fromValues: false })),
      // 组合名单：紧跟基础列插「来自」（标每只命中哪条策略），普通筛选下没有这一列
      ...(comboRes ? [{ key: "__from", zh: "来自", fromValues: false }] : []),
      ...valCols,
      ...rawKeys.slice(0, 3).map((k) => ({ key: k, zh: k, fromValues: false })),
    ];
  }, [rows, selCols, comboRes]);

  /**
   * 列宽（百分比，合计 100）。2026-09-29 用户：表格太宽「还得拉一下才能看完，参考稳智」。
   * 口径：base 列给固定小宽度，其余因子列平分剩余 —— 配 `table-fixed w-full` 后表格**恒等于容器宽**，
   * 无论用户加了多少列都不会再出现横向滚动条；表头允许换行（多行读得清，比拖滚动条强）。
   */
  const colWidth = useMemo(() => {
    const out: Record<string, string> = {};
    if (!cols.length) return out;
    const FIXED: Record<string, number> = {
      symbol: 6.5, code: 6.5, name: 8.5, close: 5.5, price: 5.5, change_pct: 6.5, __from: 8,
    };
    const fixedSum = cols.reduce((s, c) => s + (FIXED[c.key] ?? 0), 0);
    const rest = cols.filter((c) => !(c.key in FIXED));
    const share = rest.length ? Math.max(4, (100 - fixedSum) / rest.length) : 0;
    for (const c of cols) out[c.key] = `${c.key in FIXED ? FIXED[c.key] : share}%`;
    return out;
  }, [cols]);

  return (
    <div className="w-full space-y-4 px-3 py-6">
      <div className="text-center apple-slide-up">
        <h1 className="text-[25px] font-semibold tracking-tight">多因子量化模型</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">所示结果仅为模型筛选结果与历史数据分析，不构成任何投资建议。投资有风险，决策需谨慎。</p>
      </div>

      {/* P36-D 图例：两种标记什么意思，说人话（不许用「反向因子」「IC」这类词） */}
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        <span><span className="text-amber-300">⚠</span>　历史上是反着走的：数值越高，之后几天反而越容易跌，命中它更接近「该回避」</span>
        <span><span className="border-b border-dashed border-muted-foreground">虚线</span>　没通过历史检验：历史上看不出稳定效果，别把它当买入理由</span>
      </div>

      {/* P36-E6 档位切换条：强势 / 震荡 / 弱势。放在「基础与板块」正上方（用户 2026-09-30 要求的位
          置）；默认自动跟随今天实判档，手动切到别的档 = 回看，条上自己会出提示。 */}
      <RegimeSwitchBar
        onPick={(it, regime) => void pickAndRun({
          kind: "single", key: `regime-${it.id}`, name: it.name, memberIds: [it.id],
          source: "来源：分档回测榜（档位切换条）",
          reason: `${regime ? `【${regime}档】` : ""}试了 ${it.n} 次·第二天涨的比例 ${it.winCi || `${it.win.toFixed(0)}%`}·平均 ${it.net >= 0 ? "+" : ""}${it.net.toFixed(2)}%（${it.basis ?? "扣掉手续费后"}）`,
          record: null,
        })}
      />

      {/* 四栏条件卡（稳智同款版式；字段=本站已实现因子目录，点 chip 即加条件，带默认阈值） */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {PRESET_CARDS.map((card, ci) => (
          <div key={card.title} className="factor-card card-bounce-in rounded-xl border border-border/60 bg-overlay p-4 transition-all hover:border-sky-400/40" style={{ animationDelay: `${ci * 150}ms` }}>
            <div className="text-center text-[15.5px] font-semibold">{card.title}</div>
            <div className="mx-auto mb-2 mt-1 h-[3px] w-12 rounded bg-sky-500/80" />
            {card.sections.map((sec) => (
              <div key={sec.section} className="mb-3 last:mb-0">
                <div className="mb-1.5 text-center text-[13.5px] text-muted-foreground">{sec.section}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {sec.chips.map((p) => {
                    const active = conds.some((x) => x.zh === p.chip);
                    const known = p.conds.every((c) => fields.some((f) => f.key === c.field));
                    const tr = truthMap[p.conds[0]?.field ?? ""] ?? null;
                    const reverse = tr?.direction === "negative";
                    const unverified = !!tr && !tr.passed;
                    const tip = !known
                      ? "字段待本地实现：筛选时会自动剔除"
                      : reverse || unverified
                        ? (truthDetailOf(tr ?? undefined, p.chip) ?? "点击加入/更新已选条件")
                        : "点击加入/更新已选条件";
                    const cls = active
                      ? "border-sky-400/60 bg-sky-400/15 text-sky-200"
                      : !known
                        ? "border-border/40 bg-card/60 text-muted-foreground/60"
                        : reverse
                          ? "border-amber-500/60 bg-amber-500/10 text-amber-200 hover:border-amber-400/80"
                          : unverified
                            ? "border-dashed border-border/70 bg-card/50 text-muted-foreground/80 hover:border-sky-400/40"
                            : "border-border/60 bg-card text-muted-foreground hover:border-sky-400/40 hover:text-foreground";
                    return (
                      <button key={p.chip} onClick={() => addPreset(p)} title={tip}
                        className={`rounded-full border px-2 py-1.5 text-[13px] transition-colors ${cls}`}>
                        {reverse ? "⚠ " : ""}{p.chip}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
        <div className="apple-slide-up rounded-xl border border-border/60 bg-overlay p-4">
          <div className="mb-2 text-center text-[15px] font-semibold">自定义条件</div>
          <div className="space-y-2">
            <select value={customField} onChange={(e) => setCustomField(e.target.value)} className="w-full rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]">
              <option value="">选择字段</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.zh}</option>)}
            </select>
            <select value={customOp} onChange={(e) => setCustomOp(e.target.value)} className="w-full rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]">
              {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input value={customValue} onChange={(e) => setCustomValue(e.target.value)} placeholder="值" className="w-full rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]" />
            <button onClick={addCustom} className="w-full rounded-md bg-sky-600 py-1.5 text-[13px] font-medium text-white hover:bg-sky-500">添加</button>
            <div className="pt-1 text-[12px] text-muted-foreground">近N日累计涨跌幅</div>
            <div className="flex gap-1.5">
              <input type="number" value={rollDays} onChange={(e) => setRollDays(e.target.value)} className="w-16 rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]" />
              <select value={rollOp} onChange={(e) => setRollOp(e.target.value)} className="flex-1 rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]">
                {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input value={rollValue} onChange={(e) => setRollValue(e.target.value)} placeholder="值(%)" className="w-20 rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]" />
            </div>
            <button onClick={addRolling} disabled={!customField && !fields.length} className="w-full rounded-md bg-sky-600 py-1.5 text-[13px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">添加近N日条件</button>
          </div>
        </div>
      </div>

      {/* 已选条件 + 策略 */}
      <div className="rounded-xl border border-border/60 bg-overlay p-4">
        {handoffNotice && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-1.5 text-[12.5px] text-sky-200">
            <span className="flex-1">{handoffNotice}</span>
            <button onClick={() => setHandoffNotice("")} className="text-muted-foreground hover:text-sky-300">×</button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">已选条件</span>
          {conds.length ? conds.map((c, i) => (
            <span key={`${c.field}-${i}`} className="flex items-center gap-1 rounded-full border border-sky-400/40 bg-sky-400/10 px-2.5 py-1 text-[12.5px] text-sky-200">
              {c.zh} {c.op} {c.value}{c.window ? `(${c.window}日)` : ""}
              <button onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">×</button>
            </span>
          )) : <span className="text-[12.5px] text-muted-foreground">未添加条件（当前交易日全量候选）</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={strategyName} onChange={(e) => setStrategyName(e.target.value)} placeholder="策略名称" className="w-40 rounded-md border border-border/70 bg-card px-2 py-1.5 text-[13px] text-foreground [color-scheme:dark]" />
          <button onClick={saveStrategy} disabled={!conds.length} className="rounded-md bg-sky-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">保存策略</button>
          <button onClick={() => { setShowStrategies((v) => !v); void loadForecast(); }} className="rounded-md border border-border/70 bg-card px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">我的策略（{strategies.length}）</button>
          <button onClick={() => setShowAiRecords((v) => !v)} className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[13px] text-amber-200 hover:bg-amber-400/20">AI优选记录（{aiPools.length}）</button>
        </div>
        {showAiRecords && (
          <div className="mt-2 space-y-1">
            {aiPools.length === 0 && (
              <div className="px-1 py-1 text-[12.5px] text-muted-foreground">暂无 AI优选记录。配好条件后点「AI 优选」创建候选池。</div>
            )}
            {aiPools.map((pool) => (
              <div key={pool.id} className="rounded-md border border-border/50 px-2.5 py-1.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <button onClick={() => setViewPool(viewPool?.id === pool.id ? null : pool)}
                    className="min-w-0 flex-1 truncate text-left text-foreground hover:text-amber-300"
                    title={pool.label}>
                    {pool.label ?? `${pool.source} · ${pool.asOf}`}（冻结 {pool.rows.length} 只）
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => pool.prompt && askAiWithPool({ poolId: pool.id, label: pool.label ?? `候选池 · ${pool.asOf}`, prompt: pool.prompt, horizon: useDesk.getState().assistantHorizon ?? "mid" })}
                      disabled={!pool.prompt}
                      className="text-muted-foreground hover:text-amber-300 disabled:opacity-40">再次前往AI</button>
                    <button onClick={() => { if (viewPool?.id === pool.id) setViewPool(null); dropFrozenPool(pool.id); }}
                      className="text-muted-foreground hover:text-red-300"><Trash2 size={12} /></button>
                  </div>
                </div>
                {viewPool?.id === pool.id && (
                  <div className="mt-1.5 max-h-40 overflow-y-auto rounded border border-border/40 bg-card/40 p-1.5 font-mono text-[12px]">
                    {pool.rows.slice(0, 60).map((r, ri) => (
                      <div key={`${r.symbol}-${ri}`} className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{plainCode(r.symbol)} {r.name}</span>
                        <span className={r.changePct != null && r.changePct >= 0 ? "text-red-400" : "text-emerald-400"}>
                          {r.changePct == null ? "—" : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`}
                        </span>
                      </div>
                    ))}
                    {pool.rows.length > 60 && <div className="pt-1 text-muted-foreground/70">仅显示前 60 只（冻结共 {pool.rows.length} 只）</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {showStrategies && (
          <div className="mt-2 rounded-lg border border-border/50 bg-card/40 p-2">
            <div className="mb-2 flex items-center gap-2">
              <button onClick={() => setLibTab("mine")} className={`rounded-md px-2.5 py-1 text-[13px] ${libTab === "mine" ? "bg-sky-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>我的策略（{strategies.length}）</button>
              <button onClick={() => { setLibTab("community"); void loadLibrary(); }} className={`rounded-md px-2.5 py-1 text-[13px] ${libTab === "community" ? "bg-sky-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>社区策略（{libAll ? libAll.length : 721}）</button>
            </div>
            {libTab === "mine" ? (
              <div className="space-y-1">
                {strategies.length === 0 && <div className="px-1 py-1 text-[12.5px] text-muted-foreground">还没有保存的策略。配置条件后点「保存策略」。</div>}
                {strategies.map((s) => (
                  <div key={s.ts} className="flex items-center justify-between rounded-md border border-border/50 px-2.5 py-1.5 text-[13px]">
                    <button onClick={() => { setConds(s.conds); setShowStrategies(false); }} className="text-foreground hover:text-sky-300">{s.name}（{s.conds.length} 条件）</button>
                    <button onClick={() => { const n = strategies.filter((x) => x.ts !== s.ts); setStrategies(n); localStorage.setItem("mydesk-screener-strategies", JSON.stringify(n)); }} className="text-muted-foreground hover:text-red-300"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="搜索策略名/创建者" className="w-56 rounded-md border border-border/70 bg-card px-2 py-1 text-[13px] text-foreground [color-scheme:dark]" />
                  <span className="text-[12.5px] text-muted-foreground">
                    共 {libAll ? libList.length : "—"} 条{libQuery ? `（匹配）` : ""}
                    {!libQuery && libBlockedCount > 0 && !showBlocked ? ` · 已收起 ${libBlockedCount} 条今天被挡的` : ""}
                  </span>
                </div>
                {libErr && <div className="px-1 py-1 text-[12.5px] text-red-300">策略库读取失败：{libErr}</div>}
                {libLoading && <div className="flex items-center gap-2 px-1 py-1 text-[12.5px] text-muted-foreground"><Loader2 size={12} className="animate-spin" />加载策略库…</div>}
                <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                  {libList.slice(0, 200).map((s) => {
                    const g = fcData?.gates[String(s.id)];
                    return (
                    <div key={s.id} className="flex items-center justify-between rounded-md border border-border/40 px-2.5 py-1.5 text-[13px]">
                      <div className="min-w-0">
                        <div className="truncate text-foreground" title={s.name}>{s.name}</div>
                        <div className="truncate text-[12px] text-muted-foreground">
                          {s.owner || "—"} · 赞{s.like}/踩{s.dislike} · {s.n_mapped}/{s.n_total} 条件
                          {s.n_mapped < s.n_total && <span className="text-amber-300/80">（{s.n_total - s.n_mapped} 项本地暂不支持）</span>}
                          {s.approx.length > 0 && <span className="text-amber-300/80"> · 含近似映射</span>}
                        </div>
                      </div>
                      {/* 闸门小圆标（P33）：带前提的策略按今天档位分判定，来源=稳智口径的 backtest_params */}
                      {g && (
                        <span title={g.unknown ? "档位分没算出来，今天不判" : g.pass ? `前提门槛 ${g.threshold} 成立（稳智口径）` : `前提门槛 ${g.threshold}，今天档位分不够`}
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${g.pass ? "bg-emerald-500/15 text-emerald-400" : g.unknown ? "bg-muted text-muted-foreground" : "bg-red-500/10 text-red-300"}`}>
                          {g.pass ? "✓ 能用" : g.unknown ? "待判" : "✗ 挡"}
                        </span>
                      )}
                      <button onClick={() => applyLib(s)} disabled={!s.n_mapped} className="ml-2 shrink-0 rounded-md bg-sky-600 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-sky-500 disabled:opacity-40">应用</button>
                    </div>
                    );
                  })}
                  {libAll && libList.length > 200 && <div className="px-1 py-1 text-[12px] text-muted-foreground">仅显示前 200 条，请用搜索缩小范围。</div>}
                </div>
                {/* 被挡的默认收起（P33）：折叠行可复核「挡下了谁」——挡下可查，不是黑箱 */}
                {!libQuery && fcData && libBlockedCount > 0 && (
                  <button onClick={() => setShowBlocked((v) => !v)}
                    className="w-full rounded-md border border-dashed border-border/60 px-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
                    {showBlocked ? "收起被挡的策略" : `另有 ${libBlockedCount} 条今天条件不够，已收起 —— 点开查看`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 结果区 */}
      <div className="rounded-xl border border-border/60 bg-overlay p-4">
        {/* P36-D：本次筛选条件的体检，真实计数（不是写死的假提示）；全过检就不显示，不为了显得严谨乱报警 */}
        {audit.summary && (
          <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-relaxed text-amber-200">
            <div>{audit.summary}</div>
            {audit.lines.length > 0 && (
              <div className="mt-1">
                <DeskCollapse
                  title={`逐条看（${audit.lines.length} 条）`}
                  triggerClassName="text-[12px] text-amber-200/80 hover:text-amber-100"
                  contentClassName="text-[12px] text-amber-100/80"
                >
                  <ul className="space-y-0.5">
                    {audit.lines.map((l, i) => <li key={i}>· {l}</li>)}
                  </ul>
                </DeskCollapse>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-2 text-[13px]">
            <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)}
              title={tradeDate ? "历史交易日（仅K线口径条件可回溯）" : `留空=跟随行情源最新数据${quoteDate ? `（当前 ${quoteDate}）` : ""}；选日期可回看历史交易日`}
              placeholder={quoteDate || undefined}
              className="rounded-md border border-border/70 bg-card px-2 py-1.5 text-foreground [color-scheme:dark] [color-scheme:dark]" />
            {!tradeDate && (
              <span className="text-[12.5px] text-muted-foreground" title="留空表示跟随行情源最新数据，休市日自动落在上一交易日">
                跟随最新数据{quoteDate ? ` · ${quoteDate}` : ""}
              </span>
            )}
            <select value={orderBy} onChange={(e) => setOrderBy(e.target.value)} className="rounded-md border border-border/70 bg-card px-2 py-1.5 text-foreground [color-scheme:dark]">
              {fields.map((f) => <option key={f.key} value={f.key}>{f.zh}</option>)}
            </select>
            <select value={dir} onChange={(e) => setDir(e.target.value as "desc" | "asc")} className="rounded-md border border-border/70 bg-card px-2 py-1.5 text-foreground [color-scheme:dark]">
              <option value="desc">降序</option><option value="asc">升序</option>
            </select>
            <select value="" onChange={(e) => { const f = fields.find((x) => x.key === e.target.value); if (f && !selCols.some((x) => x.key === f.key)) setSelCols((s) => [...s, f]); }} className="rounded-md border border-border/70 bg-card px-2 py-1.5 text-foreground [color-scheme:dark]">
              <option value="">+ 显示列</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.zh}</option>)}
            </select>
          </div>
          {selCols.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {selCols.map((f) => (
                <span key={f.key} className="flex items-center gap-1 rounded-full bg-sky-500 px-2.5 py-1 text-[12.5px] font-medium text-white">
                  {f.zh}
                  <button onClick={() => setSelCols((s) => s.filter((x) => x.key !== f.key))} className="text-white/80 hover:text-white">×</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-center gap-3">
            {/* 「预测」按钮（P33）：弹卡推荐今天成立的策略/组合+来源，选它自动筛选。概率红线见弹卡底注。 */}
            <button onClick={() => { setFcOpen(true); void loadForecast(); }} disabled={fcLoading && !fcData}
              title="根据今天的市场环境，推荐今天前提成立的策略与组合（附来源）；选它自动筛选"
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-1.5 text-[13.5px] font-medium text-white hover:bg-violet-500 disabled:opacity-50">
              {fcLoading ? <Loader2 size={13} className="animate-spin" /> : <span aria-hidden>🔮</span>} 预测
            </button>
            <button onClick={() => void runScreener(1)} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-sky-600 px-5 py-1.5 text-[13.5px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : null} 筛选
            </button>
            {/* 稳智 /screener 的「稳智AI优选」按钮：点开 4 参弹窗 → 冻结候选池 → 前往 AI 对话。
                稳智在命中数=0 时禁用；本地不拦（没筛过会先自动筛一轮），真没候选时在弹窗里如实报错。 */}
            <button onClick={() => { setPoolError(""); setPoolDlg(true); }} disabled={poolBusy}
              className="flex items-center gap-1.5 rounded-md bg-amber-500 px-4 py-1.5 text-[13.5px] font-medium text-black hover:bg-amber-400 disabled:opacity-50">
              <Sparkles size={13} /> AI 优选
            </button>
            {total != null && <span className="text-[13px] text-muted-foreground" title="K线类因子列按流动性Top600现场计算；稳智的5152全量靠盘后预计算——S2接入后放开上限">共 {total} 条{asOf ? ` · ${asOf}` : ""}</span>}
            {/* 因子缓存口径角标：让用户一眼知道这批因子值是「盘中取的」还是「收盘后算的」
                （用户实测过「定在盘中」——不标口径就无从判断手上的价是几点钟的） */}
            {cachePhaseShort && (
              <span className={`rounded border px-1.5 py-0.5 text-[11.5px] ${cachePhaseShort.startsWith("盘中")
                ? "border-amber-400/30 bg-amber-400/10 text-amber-300/90"
                : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300/90"}`}
                title={cacheNote}>
                因子值：{cachePhaseShort}
              </span>
            )}
            {/* 数据日 ≠ 今天时的如实角标：文案由服务端按【交易日历 + 当前时段】判定后下发
                （quote_lag），前端不再自己拼「X 休市」——2026-09-29 09:25 集合竞价中曾被错标成
                「9/29 休市」，因为旧代码只要 quoteDate≠asOf 就写死「休市」。 */}
            {quoteLag?.lagging && (
              <span className="rounded border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[12.5px] text-amber-300/90"
                title={quoteLag.note}>
                {quoteLag.badge}
              </span>
            )}
          </div>
        </div>
        {error && <div className="mt-2 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[13.5px] text-red-300">{error}</div>}
        {/* 因子缓存预热/收盘重算进度：页面全自动，用户只需知道「在算」。 */}
        {warmNotice && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12.5px] text-amber-200/90">
            <Loader2 size={12} className="animate-spin" /> {warmNotice}
          </div>
        )}
        {/* 组合名单提示条：rows 被并集合并名单顶掉时如实说明口径与退出方式 */}
        {comboRes && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-purple-400/30 bg-purple-400/5 px-3 py-2 text-[12.5px] text-purple-200/90">
            <span className="flex-1">{comboRes.note}</span>
            <button onClick={() => void runScreener(1)} className="shrink-0 rounded border border-purple-400/40 px-2 py-0.5 text-[12px] hover:bg-purple-400/10">
              退出组合，按已选条件重筛
            </button>
          </div>
        )}
        {rows?.length ? (
          <div className="mt-3 max-h-[620px] overflow-y-auto overflow-x-hidden rounded-lg border border-border/50 bg-background">
            <table className="w-full table-fixed text-[12.5px]">
              <colgroup>
                {cols.map((c) => <col key={c.key} style={{ width: colWidth[c.key] }} />)}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface text-muted-foreground">
                <tr className="border-b border-border/60">
                  {/* 表头允许换行（leading-tight）：长列名不再把整列撑宽，这是「不用横向拖」的关键 */}
                  {cols.map((c) => <th key={c.key} className="break-words px-2 py-2 text-left align-bottom font-medium leading-tight">{c.zh}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border/30 transition-colors hover:bg-overlay">
                    {cols.map((c) => {
                      const v = c.fromValues ? (r.values as Record<string, number | null> | undefined)?.[c.key] : r[c.key];
                      const num = typeof v === "number";
                      const isCode = c.key === "symbol" || c.key === "code";
                      const isPct = c.key.includes("pct");
                      const isMacd = c.key === "macd";
                      const isPattern = c.key === "kline_pattern";
                      const disp = num
                        ? c.key.includes("floatcap") || c.key.includes("amount_yi")
                          // 列名已含单位（如「流通市值(亿)」）时不再重复后缀；否则补「亿」
                          ? `${(v as number).toFixed(2)}${/(亿|%)/.test(c.zh) ? "" : "亿"}`
                          // 涨跌幅统一两位小数：整数 20 也要显示 20.00，避免同列格式不一致
                          : isPct || c.key === "macd" ? (v as number).toFixed(2)
                            : Number.isInteger(v as number) ? v : (v as number).toFixed(2)
                        : String(v ?? "—");
                      // 形态可能是 "涨停板|看涨吞没" 这类组合：拆成小标签分别渲染，比一整串更好读
                      const patternTags = isPattern && typeof v === "string" && v !== "—" ? v.split("|").filter(Boolean) : null;
                      return (
                        <td key={c.key} title={isCode ? codeTitle(r.symbol ?? r.code) : undefined}
                          className={`overflow-hidden px-2 py-1.5 align-middle ${
                            num && isPct ? ((v as number) >= 0 ? "text-red-400" : "text-emerald-400") : ""
                          } ${num && isMacd ? "font-mono italic text-red-400" : ""}`}>
                          {/* 代码列走通达信口径：只显示 6 位数字，不带 .SH/.SZ/.BJ（数据层全码在 title 里） */}
                          {isCode ? <span className="block truncate font-mono text-sky-400">{plainCode(r.symbol ?? r.code)}</span>
                            : patternTags ? (
                              <span className="flex flex-wrap gap-1">
                                {patternTags.map((t, ti) => (
                                  <span key={ti} className="rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[11.5px] text-sky-200">{t}</span>
                                ))}
                              </span>
                            )
                              : num && isMacd
                                // MACD 走稳智同款：红色斜体，且数值固定两位小数（0 也写 0.00，避免与缺失的「—」混淆）
                                ? <span className="block truncate font-mono italic text-red-400">{(v as number).toFixed(2)}</span>
                                : <span className="block truncate" title={String(disp)}>{disp}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {total != null && total > 20 && !comboRes && (
              <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border/40 bg-surface px-3 py-2 text-[13px] text-muted-foreground">
                <button disabled={page <= 1} onClick={() => void runScreener(page - 1)} className="rounded-md border border-border/60 px-2.5 py-1 hover:text-foreground disabled:opacity-40">上一页</button>
                <span>第 {page} / {Math.ceil(total / 20)} 页</span>
                <button disabled={page >= Math.ceil(total / 20)} onClick={() => void runScreener(page + 1)} className="rounded-md border border-border/60 px-2.5 py-1 hover:text-foreground disabled:opacity-40">下一页</button>
              </div>
            )}
          </div>
        ) : rows && !rows.length ? <div className="mt-3 py-8 text-center text-[13px] text-muted-foreground">没有命中条件的候选</div> : null}

      </div>

      {/* 「预测」弹卡（P33）：今天档位+全市场概率（单独一行，全市场一个数）+ 推荐（组合/社区，带来源）
          +「选它 → 自动筛选」。红线：每条推荐的 record 恒空（还没建台账）→ 显示「还没记过账」，
          绝不把市场级概率复制到单条头上；AI 优选负责选股写理由，不产出概率。 */}
      {fcOpen && (
        <div className="fixed inset-0 z-[120] flex items-start justify-center bg-black/50 p-4 pt-[7vh]" role="dialog" aria-label="预测：今天选什么策略"
          onClick={() => setFcOpen(false)}>
          <div className="w-full max-w-[600px] rounded-2xl border border-border bg-popover p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <span aria-hidden>🔮</span>
              <span className="flex-1 text-[16px] font-semibold">预测 · 今天选什么</span>
              <button onClick={() => setFcOpen(false)} aria-label="关闭" className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
            </div>
            {/* P34 历史回放：选一个交易日，看那天的大盘档位 + 该档该看什么策略（六分量档位分无法历史重算，只回放分档这一路） */}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span>回放</span>
              <input
                type="date" value={fcDate} onChange={(e) => setFcDate(e.target.value)}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[12px] text-foreground"
              />
              <button
                onClick={() => fcDate && void loadForecast(fcDate)}
                disabled={!fcDate || fcLoading}
                className="rounded-md border border-emerald-400/40 px-2 py-0.5 text-[12px] text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-40"
              >
                看这天
              </button>
              <button
                onClick={() => { setFcDate(""); void loadForecast(null); }}
                disabled={fcLoading}
                className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:bg-muted disabled:opacity-40"
              >
                回到今天
              </button>
            </div>
            {fcErr && <div className="mb-2 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[13px] text-red-300">{fcErr}</div>}
            {fcLoading && !fcData && (
              <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> 正在读今天的市场环境与策略闸门（冷启动要算十几秒，之后 5 分钟内秒开）…
              </div>
            )}
            {fcData && (
              <div className="space-y-3">
                {/* 今天档位 + 攒样本进度 */}
                <div className="rounded-xl border border-violet-400/25 bg-violet-400/5 p-3">
                  {fcData.tier.error ? (
                    <div className="text-[13px] text-amber-300">{fcData.tier.error}——今天不判门槛，策略列表照常。</div>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[24px] font-bold leading-none">{Math.round(fcData.tier.score ?? 0)}<span className="text-[12px] font-normal text-muted-foreground">/100</span></span>
                        {fcData.tier.tier && <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[12px] text-amber-200">{fcData.tier.tier}</span>}
                        <span className="text-[12.5px] text-muted-foreground">今天的市场环境</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                        {fcData.tier.components.filter((c) => c.available).map((c) => (
                          <span key={c.name} title={c.reading}>{c.name.split("（")[0]} <b className="font-semibold text-foreground">{c.score == null ? "—" : Math.round(c.score)}分</b></span>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="mt-2 border-t border-dashed border-border/50 pt-2 text-[12.5px] text-muted-foreground">{fcData.marketProb.note}</div>
                </div>
                {/* P34-2 分档回测推荐：按大盘档位给该档历史表现最好的几条（治「非高风险日恒空」） */}
                <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-emerald-200">分档回测推荐</span>
                    {fcData.regime?.regime && (
                      <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11.5px] text-emerald-200">
                        大盘{fcData.regime.regime}期
                      </span>
                    )}
                    {fcData.regime?.asOf && (
                      <span className="text-[11.5px] text-muted-foreground">档位取自 {fcData.regime.asOf}</span>
                    )}
                    {fcData.regime?.isReplay && (
                      <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200">历史回放</span>
                    )}
                  </div>
                  {fcData.regime?.error ? (
                    <div className="mt-1.5 text-[12.5px] text-amber-300">{fcData.regime.error}</div>
                  ) : (fcData.regime?.items?.length ?? 0) > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      {fcData.regime!.items.map((it, idx) => {
                        // P36-B：主数字用「没参与挑选的那段行情」验出来的成绩；没有就退回落全期，
                        // 但口径标签会如实写「用同一段历史算的（可能只是运气好）」，不冒充。
                        const oos = it.stat.oos ?? null;
                        const n = oos ? oos.n : it.stat.n;
                        const winTxt = oos ? (oos.winCi || `${oos.win.toFixed(0)}%`) : (it.stat.winCi || `${it.stat.win.toFixed(0)}%`);
                        const avg = oos ? oos.net1 : it.stat.avg;
                        return (
                        <div key={it.id} className="flex items-center gap-2 text-[12.5px]">
                          <span className="w-4 shrink-0 text-center text-[11.5px] font-bold text-muted-foreground">{idx + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-foreground" title={it.name}>{it.name}</span>
                          <span className="shrink-0 text-[11.5px] text-muted-foreground">
                            试了 {n} 次 · 第二天涨的比例 {winTxt} · 平均 {avg >= 0 ? "+" : ""}{avg.toFixed(2)}%
                          </span>
                          <button
                            onClick={() => void pickAndRun({ kind: "single", key: `regime-${it.id}`, name: it.name, memberIds: [it.id], source: "来源：分档回测榜", reason: `试了 ${n} 次·第二天涨的比例 ${winTxt}·平均 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%（${it.basis ?? "扣掉手续费后"}）`, record: null })}
                            disabled={!!fcPicking}
                            className="shrink-0 rounded-md bg-emerald-600 px-2 py-0.5 text-[11.5px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            {fcPicking === `regime-${it.id}` ? <Loader2 size={11} className="animate-spin" /> : "选它"}
                          </button>
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[12.5px] text-muted-foreground">这个档位下没有够得上样本门槛的策略（{fcData.regime?.note || "每个档位都要够次数才上榜"}）。</div>
                  )}
                  <div className="mt-2 space-y-0.5 border-t border-dashed border-border/50 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    <div>
                      {fcData.regime?.items?.[0]?.basis
                        ? `口径：${fcData.regime.items[0].basis}`
                        : "口径：扣掉手续费后"}
                      {fcData.regime?.basis?.untradeable ? `；${fcData.regime.basis.untradeable}` : ""}
                    </div>
                    {fcData.regime?.basis?.cost && (
                      <div>每买卖一次要交的钱：{fcData.regime.basis.cost.replace("扣费后：", "")}</div>
                    )}
                    <div>
                      回放的是过去（{fcData.regime?.window || "全A历史日K"}），是历史统计不是预测，不构成投资建议。
                    </div>
                  </div>
                </div>
                {/* 推荐列表：组合在前、单条在后；每条带来源与真实理由 */}
                {fcData.tierOk && (
                  <div className="space-y-2">
                    {fcData.items.length ? fcData.items.map((it, idx) => (
                      <div key={it.key} className="rounded-lg border border-border/60 bg-card/60 p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="w-4 shrink-0 text-center text-[12px] font-bold text-muted-foreground">{idx + 1}</span>
                          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${it.kind === "combo" ? "border-purple-400/40 text-purple-300" : "border-sky-400/40 text-sky-300"}`}>
                            {it.kind === "combo" ? "组合" : "社区"}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={it.name}>{it.name}</span>
                          <span className="shrink-0 text-[12px] text-muted-foreground">还没记过账</span>
                          <button onClick={() => void pickAndRun(it)} disabled={!!fcPicking}
                            className="shrink-0 rounded-md bg-sky-600 px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                            {fcPicking === it.key ? <Loader2 size={11} className="animate-spin" /> : "选它 → 自动筛选"}
                          </button>
                        </div>
                        <div className="mt-0.5 pl-6 text-[11.5px] leading-relaxed text-muted-foreground">{it.source} · {it.reason}</div>
                      </div>
                    )) : (
                      <div className="text-[13px] text-muted-foreground">今天没有过闸的推荐（带前提的策略里没有成立的）——策略列表里的「✓ 能用」圆标同口径。</div>
                    )}
                  </div>
                )}
                <div className="border-t border-dashed border-border/50 pt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                  排名现在按「今天档位匹配 + 稳智赞/踩」；台账攒厚后按真实准头排。「还没记过账」= 这条策略/组合还没有可复核的使用记录——绝不拿市场级概率冒充单条的上涨概率。
                  AI 优选负责选股写理由，不产出概率。本卡只回答「今天哪些策略的前提成立」，不构成投资建议，不给仓位指令。
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 「交给稳智AI优选」弹窗：4 参 + 底部说明 + 「创建候选池并前往稳智AI」（稳智 StockScreener-*.js 逐字对齐） */}
      {poolDlg && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="交给稳智AI优选">
          <div className="w-full max-w-[560px] rounded-2xl border border-border bg-popover p-4 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={15} className="text-amber-300" />
              <span className="flex-1 text-[16px] font-semibold">交给稳智AI优选</span>
              <button onClick={() => setPoolDlg(false)} aria-label="关闭" className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-[12.5px] text-muted-foreground">分析周期</div>
                <select value={poolHorizon} onChange={(e) => setPoolHorizon(e.target.value)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[14px] outline-none [color-scheme:dark]">
                  {POOL_HORIZONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                </select>
              </div>
              <div>
                <div className="mb-1 text-[12.5px] text-muted-foreground">风险偏好</div>
                <div className="flex gap-1.5">
                  {POOL_RISKS.map((r) => (
                    <button key={r} onClick={() => setPoolRisk(r)}
                      className={`flex-1 rounded-lg border px-3 py-1.5 text-[14px] transition-colors ${poolRisk === r ? "border-amber-400/60 bg-amber-400/15 text-amber-200" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[12.5px] text-muted-foreground">期望最终数量（Agent可少选或不选）</div>
                <select value={poolCount} onChange={(e) => setPoolCount(Number(e.target.value) as typeof poolCount)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[14px] outline-none [color-scheme:dark]">
                  {POOL_COUNTS.map((n) => <option key={n} value={n}>最多{n}只</option>)}
                </select>
              </div>
              <div>
                <div className="mb-1 text-[12.5px] text-muted-foreground">补充要求（可选）</div>
                <textarea value={poolNote} onChange={(e) => setPoolNote(e.target.value)} rows={3}
                  placeholder="例如：更重视持续性，回避高位情绪股"
                  className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground/50 [color-scheme:dark]" />
              </div>
              <div className="rounded-lg border border-border/50 bg-card/40 px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                将冻结当前交易日与筛选条件的候选池；最多保存页面排序前300只。页面顺序不是推荐，最终维度、取数和入选由Agent自主决定。
              </div>
              {poolError && <div className="text-[13px] text-red-300">{poolError}</div>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setPoolDlg(false)} className="rounded-lg border border-border px-3.5 py-2 text-[14px] text-muted-foreground hover:text-foreground">取消</button>
              <button onClick={() => void createPoolAndGo()} disabled={poolBusy}
                className="apple-primary-btn flex items-center gap-1.5 rounded-lg px-4 py-2 text-[14px] disabled:opacity-50">
                {poolBusy ? <Loader2 size={13} className="animate-spin" /> : null} 创建候选池并前往稳智AI
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
