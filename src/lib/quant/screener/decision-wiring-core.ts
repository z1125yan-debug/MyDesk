// P7-⑦ 接线层（纯内核）：把「服务层从真实数据源取回来的读数」映射成三张打分表的输入。
//
// 为什么单独一层，而不是直接在 decision-service.ts 里写映射：
// 这一层的每一个判断都是 REAL_DATA_ONLY 的落点 —— 主力净额什么时候算「有读数」、中位数什么时候算「算不出」、
// 事件的相关性什么时候算「没判定」而不是「不相关」。这些判断必须能被测试钉住，而 decision-service.ts 要连库、
// 要打外部数据源，`node --test` 跑不动。所以本文件**不 import db、不 fetch、不取时钟**（除日期字符串比较外），
// 所有真实读数由调用方作为参数传进来。
//
// v3（P7-⑦）多出来的四件事，都是因为新表要读的东西项目里原本没人算过：
//   - M-IDX-MA20 ⇒ 本层用基准指数日K算 20 日均线（sma 来自 fields.ts，纯函数）；
//   - M-TURNOVER ⇒ 当日全 A 成交额来自 sentiment，近期均值只能来自**本项目的 risk_snapshot 留档**：
//     留档天数不够、或那些行的成交额本身没确认过 ⇒ 交 null，不拿一个自造基线凑「放量/缩量」；
//   - T-VOLUME / T-BREAKOUT ⇒ 从同一份标的日K里取量、最高价与前 20 根最高价（上游没给成交量字段就是 null）；
//   - 概率面的盈亏比与观察周期 ⇒ payoff 直接照抄引擎读数；primary_horizon 必传（本层默认 1 日并记账，
//     因为任务书的示例句式用的是「未来 1 日」，换周期等于换结论口径，所以它是个常量而不是临时决定）。
//
// 三条贯穿全层的口径：
// 1) **上游补过 0 的字段，本层负责还原成 null**。sentiment.ts 里的 `mainNetSum += m.mainNet ?? 0` 与
//    `median = pcts.length ? 中位数 : 0` 就是两个这样的地方：引擎在没有读数时会返回一个看起来像读数的 0。
//    （引用上游时写表达式而不是行号 —— 行号会随上游改动漂移，变成指错地方的注释。）
//    规则表（market-score-core）无从分辨，所以判断放在这里做，并且做在能被测试看到的地方。
// 2) **不替调用方选口径**。基准指数是哪一条、RSI 用哪个周期、概率面用哪个引擎与哪个观察周期，都由服务层显式声明
//    后传进来；本层只做「没声明 ⇒ 这一项不判定」，不会挑一个默认值让结论看起来完整。
// 3) 映射不出分数不是错误：MarketInput/EventInput/TechnicalInput 全部允许整面为空，
//    缺的部分由 market-score-core / event-score-core / decision-core 各自登记成 missing，本层不吞掉也不美化。
//
// 出处：用户 2026-09-20《P7开发文档核对回复》第 2 条「服务层把 computeSentiment / themes / event_interpretation
// 映射成 MarketInput / EventInput，调 buildDecision」；P7-⑦ 任务书的四条新读数由本次接线供上。

import { macdCalc, rsiCalc, sma, type BarsLike } from "../factors/fields.ts";
import {
  PRIOR_HIGH_WINDOW_DEFAULT, SUPPLEMENT_MARKER, VOLUME_AVG_WINDOW_DEFAULT,
  type Decision, type Horizon, type ProbabilityInput, type ProbabilityReading, type TechnicalInput,
} from "./decision-core.ts";
import type { MarketInput, MarketRiskLevel } from "./market-score-core.ts";
import type { EventInput, EventSignal } from "./event-score-core.ts";
import { EVENT_STALE_AFTER_DAYS_DEFAULT } from "./event-score-core.ts";
import type { SimilarEnvStats } from "./similar-env.ts";

/** 接线层版本：写进服务层响应，让页面上的结论能追回「用哪一版映射算出来的」 */
export const WIRING_VERSION = "p7.s7.wiring.v1";

/**
 * 基准指数由本层**固定声明**：指数这条分项（v3 的计分项 M-IDX-MA20 与判定依据 M-INDEX-PCT）不能接受裸数字（上证 +0.5% 与创业板 +0.5% 在血缘里会长得一模一样），
 * 也不能由打分表自己挑。选 000001.SH 的理由是项目里所有「大盘」口径（similar-env、市场风险）都以它为基准，
 * 换基准指数等于换结论口径，所以写成常量而不是散落在服务层的字符串字面量里。
 */
export const BASE_INDEX = { symbol: "000001.SH", label: "上证指数" } as const;

/** 概率面口径说明：这一维衡量的是「上证相似环境下的历史后续」，不是本标的的条件概率 */
export const PROBABILITY_SCOPE_NOTE =
  `概率面＝相似环境口径（在 ${BASE_INDEX.symbol} ${BASE_INDEX.label} 的历史日里按当日涨跌幅落在带宽内取样），` +
  `描述的是大盘环境而非这只股票的条件胜率：换股票不会改变这一维`;

/** RSI 周期：任务书 §六 只写「RSI」没写周期，本层选定 14 并在分项 raw 里记账（TechnicalInput.rsi_period） */
export const RSI_PERIOD_DEFAULT = 14;

/**
 * 概率面的观察周期：P7-⑦ 表只有「样本量 / 上涨比例 / 盈亏比」三条，没说 1/5/20 日各算什么，
 * 三个周期一起加就把同一维算三遍。本层选 **1 日**，理由写在这里而不是散在服务层：
 * 任务书给的概率句式示例就是「未来 1 日上涨概率 52.9%」，且决策卡的服务端窗口按日更新。
 * 换周期（例如改看 20 日）等于换结论口径，所以它是常量 + 页面必须显示（DecisionView.wiring.probability_horizon）。
 */
export const PRIMARY_HORIZON_DEFAULT: Horizon = 1;

/** 基准指数均线窗口（M-IDX-MA20）：任务书写的就是「20 日线」，本层不擅自改长度 */
export const INDEX_MA_WINDOW_DEFAULT = 20;

/** 成交额均值所需的最少历史留档天数：少于这个就不判「放量/缩量」，因为基数本身就是猜出来的 */
export const TURNOVER_MIN_PRIOR_DAYS = 5;

/**
 * 均量窗口（T-VOLUME 的成交量基准）与压力位窗口（T-BREAKOUT 的 20 日高点）：任务书写了「20 日压力」，
 * 均量窗口没写 ⇒ 由打分内核取 20 并记账。两个常量定义在 decision-core（它们与打分档同源），这里只转导，
 * 这样服务层与测试都只需要从一个地方拿窗口长度。
 */
export { VOLUME_AVG_WINDOW_DEFAULT, PRIOR_HIGH_WINDOW_DEFAULT };

/**
 * M-TURNOVER 的口径声明：当日值与历史均值必须来自**同一个算法**，否则「放大/缩量」是拿两把尺子比出来的。
 * 项目里唯一逐日留档的全 A 成交额就是 /api/market/risk 的响应落库（risk_snapshot.payload），
 * 它的 amount_total_yi 与今日这份 sentiment 是同一句 `amountSum += m.amount` ⇒ 同口径可比。
 */
export const TURNOVER_SCOPE = "全 A（东财榜单接口快照逐只成交额累加，与风险监控留档同源）";

// ---------- 市场面：computeSentiment + discoverThemes → MarketInput ----------

/** 服务层从 SentimentResult 里挑出来交给本层的读数（只声明用得到的字段，避免两条链路互相绑死） */
export interface SentimentWire {
  trade_date: string;
  live: boolean;
  /** 参与统计的家数（sentiment 的 total = 有有效涨跌幅的家数） */
  total: number;
  advancers: number;
  decliners: number;
  limit_up: number;
  limit_down: number;
  /** 炸板率：触板 0 家时引擎给的就是 null，原样传，不许换成 0 */
  break_rate: number | null;
  /** 全 A 主力净额（亿）：注意它是 `?? 0` 累加的结果，能不能信要看 main_net_known */
  main_net_sum_yi: number;
  /**
   * 全 A 快照里 mainNet **真实有值**的家数。
   * 0 或 null（服务层没能确认）⇒ 本层把 main_net_sum_yi 还原成 null：
   * 「一只都没抓到主力资金字段」和「今天主力净额正好 0 亿」是两件事，后者是个结论。
   */
  main_net_known: number | null;
  /** 全 A 成交额（亿）：同样来自 `?? 0` 累加，可信度看 amount_known（M-TURNOVER 的当日值） */
  amount_total_yi: number | null;
  /** 快照里 amount 真实有值的家数；null = 服务层没确认（旧版 sentiment 没有这一格） */
  amount_known: number | null;
  median_pct: number;
  indices: { symbol: string; changePct: number | null }[];
  risk_level: MarketRiskLevel | null;
}

/** discoverThemes 的读数；null = 本次没跑成（抛错/未接入），与「跑了但 0 条主线」是两件事 */
export interface ThemesWire {
  main_count: number | null;
  top_score: number | null;
  /** 榜首主线的板块 RPS 百分位（themes 的合并榜内百分位，不是全市场 RPS） */
  top_rps: number | null;
  /** RPS 的榜单口径原文（themes 自己在 missing 里写的那句）；不声明时打分表会登记「口径未知」 */
  rps_scope: string | null;
}

/** risk_snapshot 留档里的一日成交额读数（服务层从 payload 里取，本层只做「可信/不可信」的判断） */
export interface TurnoverDayWire {
  trade_date: string | null;
  amount_total_yi: number | null;
  /** 该日快照里 amount 真实有值的家数；旧留档没有这一格 ⇒ null（口径未确认） */
  amount_known: number | null;
}

export interface MarketWireResult {
  input: MarketInput;
  /** 本层做了哪些「还原成缺失」的判断，服务层要把它并进结论的缺口里 */
  notes: string[];
}

export interface MarketWireOpts {
  /** 基准指数日K（收盘价序列即可，本层只读 date/c）：M-IDX-MA20 用它算均线 */
  index_bars?: { date: string; c: number }[] | null;
  index_ma_window?: number;
  /** 近几日的全 A 成交额留档（risk_snapshot.payload）：M-TURNOVER 的均值基线 */
  prior_turnover?: TurnoverDayWire[] | null;
  /** 均值基线需要排除的那一日（一般是当日自己：不能拿今天当自己的历史） */
  exclude_trade_date?: string | null;
}

/** 均线只吃「形如 YYYY-MM-DD + 正有限收盘价」的读数，脏行直接丢掉而不是当 0 */
function cleanIndexBars(bars: { date: string; c: number }[] | null | undefined): { date: string; c: number }[] {
  const map = new Map<string, number>();
  for (const b of bars ?? []) {
    const date = String(b?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isNum(b?.c) || b.c <= 0) continue;
    map.set(date, b.c);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, c]) => ({ date, c }));
}

/** 成交额均值：只有「读数有值 + 家数确认过」的留档日才进基线 */
export function turnoverBaseline(
  days: TurnoverDayWire[] | null | undefined,
  opts: { exclude_trade_date?: string | null; min_days?: number } = {},
): { avg_yi: number | null; window: number; dropped_unconfirmed: number; note: string | null } {
  const min = opts.min_days ?? TURNOVER_MIN_PRIOR_DAYS;
  const ex = (opts.exclude_trade_date ?? "").slice(0, 10);
  const usable: number[] = [];
  let droppedUnconfirmed = 0;
  for (const d of days ?? []) {
    const date = String(d?.trade_date ?? "").slice(0, 10);
    if (date && date === ex) continue; // 当日不能当自己的基线
    const yi = d?.amount_total_yi;
    if (!isNum(yi) || yi <= 0) continue;
    // 旧留档没有 amount_known 这一格：它可能是 `?? 0` 全缺时补出来的 0 亿，也可能是真读数，本层无从分辨 ⇒ 不进基线
    if (d.amount_known === null || d.amount_known <= 0) { droppedUnconfirmed++; continue; }
    usable.push(yi);
  }
  if (usable.length < min) {
    const why = days === null || days === undefined
      ? "服务层本次没有读取成交额留档（risk_snapshot 未查或查询失败）"
      : `本层要求 ≥${min} 天${droppedUnconfirmed ? `，另有 ${droppedUnconfirmed} 天的留档没有确认过成交额口径，未采信` : ""}`;
    return {
      avg_yi: null, window: usable.length, dropped_unconfirmed: droppedUnconfirmed,
      note: `成交额基线只有 ${usable.length} 个可信用留档日（${why}）：M-TURNOVER 按缺失处理，不拿一天或自造基线判放量/缩量`,
    };
  }
  return { avg_yi: usable.reduce((a, b) => a + b, 0) / usable.length, window: usable.length, dropped_unconfirmed: droppedUnconfirmed, note: null };
}

export function marketFromWiring(
  s: SentimentWire | null,
  themes: ThemesWire | null,
  opts: MarketWireOpts = {},
): MarketWireResult {
  const notes: string[] = [];
  if (!s) {
    // 整面取数失败：给一个全 null 的输入，让 market-score-core 自己产「每个分项全部算不出」的登记，
    // 本层不在这里编一条「市场环境 0 分」。
    notes.push("市场面本次没有取到任何读数（computeSentiment 未返回或抛错）：市场环境这一维按缺失处理");
    return {
      input: {
        advancers: null, decliners: null, total: null, median_pct: null, index: null,
        index_ma20: null, turnover: null,
        limit_up: null, limit_down: null, break_rate: null, main_net_sum_yi: null,
        risk_level: null, themes: null, trade_date: null, live: null,
      },
      notes,
    };
  }

  // 中位数：sentiment 的 `pcts.length ? 中位数 : 0` 在 pcts 为空时返回 0。total===0 说明一条有效涨跌幅都没有，那个 0 是占位。
  const median = s.total > 0 ? s.median_pct : null;
  if (s.total <= 0) notes.push("全 A 快照本次没有一条有效涨跌幅（total=0）：引擎的中位涨跌幅会是补出来的 0，本层还原成缺失");

  // 主力净额：口径见 SentimentWire.main_net_known
  const known = s.main_net_known;
  const mainNet = known === null || known <= 0 ? null : s.main_net_sum_yi;
  if (known === null) notes.push("主力净额：服务层没能确认快照里有多少家真实带该字段（上游用 ?? 0 累加）⇒ 本项按缺失处理");
  else if (known === 0) notes.push(`主力净额：全 A ${s.total} 家里 0 家真实带 mainNet 字段，累加出来的 ${s.main_net_sum_yi} 亿是上游 \`?? 0\` 补出来的 ⇒ 按缺失处理，不宣称「今日主力净额 ${s.main_net_sum_yi} 亿」`);

  // 基准指数：只认 BASE_INDEX 那一条，取不到就带着名字交上去，让规则表区分「没指定」与「指定了但没读数」
  const hit = s.indices.find((i) => i.symbol === BASE_INDEX.symbol) ?? null;
  const idx = { symbol: BASE_INDEX.symbol, label: BASE_INDEX.label, change_pct: hit && typeof hit.changePct === "number" && Number.isFinite(hit.changePct) ? hit.changePct : null };
  if (!hit) notes.push(`${BASE_INDEX.label}（${BASE_INDEX.symbol}）本次不在指数读数里（实时源未返回）：M-INDEX-PCT（基准指数当日涨跌幅，判定依据项）按缺失处理，本层不会拿别的指数顶上`);

  // M-IDX-MA20：均线由本层从指数日K算（sma 是纯函数，长度不足就是 null，不拿收盘价凑均线）
  const maWindow = opts.index_ma_window ?? INDEX_MA_WINDOW_DEFAULT;
  const ibars = cleanIndexBars(opts.index_bars);
  const maSeries = ibars.length ? sma(ibars.map((b) => b.c), maWindow) : [];
  const idxMa = maSeries.length ? maSeries[maSeries.length - 1] : null;
  const indexMa = {
    symbol: BASE_INDEX.symbol, label: BASE_INDEX.label,
    close: ibars.length ? ibars[ibars.length - 1].c : null,
    ma20: isNum(idxMa) ? idxMa : null,
    window: maWindow,
  };
  if (!ibars.length) notes.push("基准指数日K本次没有可用读数：M-IDX-MA20 按缺失处理（本层不会拿当日涨跌幅代替均线位置）");
  else if (!isNum(idxMa)) notes.push(`${BASE_INDEX.label}日K只有 ${ibars.length} 根，不足 ${maWindow} 根均线窗口：M-IDX-MA20 按缺失处理，不缩短窗口`);

  // M-TURNOVER：当日值同样要过「家数确认」这一关，均值基线见 turnoverBaseline
  const amountKnown = s.amount_known;
  const amt = s.amount_total_yi;
  const todayAmount = !isNum(amt) || amountKnown === null || amountKnown <= 0 ? null : amt;
  if (isNum(amt) && todayAmount === null) {
    notes.push(amountKnown === null
      ? "成交额：服务层没能确认快照里有多少家真实带该字段（上游用 ?? 0 累加）⇒ 当日成交额按缺失处理"
      : `成交额：全 A ${s.total} 家里 0 家真实带 amount 字段 ⇒ 当日成交额按缺失处理，不写成「今日成交 ${amt} 亿」`);
  }
  const base = turnoverBaseline(opts.prior_turnover, { exclude_trade_date: (s.trade_date || "").slice(0, 10) });
  if (base.note) notes.push(base.note);

  return {
    input: {
      advancers: s.advancers, decliners: s.decliners, total: s.total,
      median_pct: median,
      index: idx,
      index_ma20: indexMa,
      turnover: { scope: TURNOVER_SCOPE, today_yi: todayAmount, avg_yi: base.avg_yi, window: base.window || null },
      limit_up: s.limit_up, limit_down: s.limit_down,
      break_rate: s.break_rate,
      main_net_sum_yi: mainNet,
      risk_level: s.risk_level,
      themes: themes ? { main_count: themes.main_count, top_score: themes.top_score, top_rps: themes.top_rps, rps_scope: themes.rps_scope } : null,
      trade_date: s.trade_date || null,
      live: s.live,
    },
    notes,
  };
}

/**
 * 主线榜首读数：main 是按 score 排的分组结果，但本层不假设它排过 —— 强度取真实最大值。
 * RPS 取**榜首那条主线自己的** rps（不是最大值）：M-RPS 问的是「今天领涨的板块有多强」，
 * 而 rps 与 score 是两套排序（score 还含扩散度/连续强势/资金），拿 max(rps) 会把「别的板块 RPS 高」
 * 说成「榜首板块 RPS 高」。榜首按 score 最大值那一条定位，定位不到（无有效 score）⇒ RPS 也给 null。
 */
export function themesWire(main: { score?: number; rps?: number }[] | null | undefined, rpsScope?: string | null): ThemesWire {
  const rows = main ?? [];
  let topIdx = -1;
  let topScore: number | null = null;
  rows.forEach((m, i) => {
    const v = typeof m?.score === "number" && Number.isFinite(m.score) ? m.score : null;
    if (v !== null && (topScore === null || v > topScore)) { topScore = v; topIdx = i; }
  });
  const topRpsRaw = topIdx >= 0 ? rows[topIdx]?.rps : undefined;
  const topRps = typeof topRpsRaw === "number" && Number.isFinite(topRpsRaw) ? topRpsRaw : null;
  return { main_count: rows.length, top_score: topScore, top_rps: topRps, rps_scope: rpsScope ?? null };
}

// ---------- 技术面：日K序列 → TechnicalInput ----------

export interface TechnicalWireResult {
  input: TechnicalInput;
  /** 参与计算的那根日K日期（序列最后一根）；没有K线时 null */
  bar_date: string | null;
  bars_used: number;
  notes: string[];
}

const isNum = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** 取最后一根的值：缺就返回 null，**不会**像 lastValues 那样回退到「上一个非 null」 */
function atLast(series: (number | null)[], t: number): number | null {
  const v = series[t];
  return isNum(v) ? v : null;
}

/**
 * 技术面读数。刻意不复用 buildFieldPanel/lastValues：
 * `lastValues` 给的是「最后一个非 null」，日线滞后或窗口不足时它会把 20 天前的值当今天用，
 * 而 T-MACD-CROSS 要的是**当日与前一日**两组值 —— 回退一步就等于把旧结构当新结构打分。
 * 这里按序列位置取 t=last 与 t=last-1，取不到就是 null（分项不判定）。
 *
 * v3 补的三条（T-VOLUME / T-BREAKOUT）沿用同一条纪律：均量与压力位都只看**当日之前**的那 N 根，
 * 不把自己算进自己的基准里（20 日均量含今日时，一次放量会同时抬高分子和分母，比值被压向 1）。
 */
export function technicalFromBars(
  bars: BarsLike[] | null | undefined,
  opts: { rsi_period?: number; volume_window?: number; prior_high_window?: number } = {},
): TechnicalWireResult {
  const rsiPeriod = opts.rsi_period ?? RSI_PERIOD_DEFAULT;
  const volWindow = opts.volume_window ?? VOLUME_AVG_WINDOW_DEFAULT;
  const highWindow = opts.prior_high_window ?? PRIOR_HIGH_WINDOW_DEFAULT;
  const notes: string[] = [];
  const empty: TechnicalInput = {
    ma5: null, ma10: null, ma20: null, close: null,
    dif: null, dea: null, dif_prev: null, dea_prev: null, bar: null, bar_prev: null,
    rsi: null, rsi_period: rsiPeriod,
  };
  const seq = (bars ?? [])
    .filter((b) => b && typeof b.date === "string" && isNum(b.c))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 同一天的重复行（增量补抓/多通道拼接）只保留最后一行，否则 MA/MACD 的窗口会数到两根同价日
  const dedup = new Map<string, BarsLike>();
  for (const b of seq) dedup.set(b.date, b);
  const clean = [...dedup.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (clean.length !== seq.length && seq.length > 0) notes.push(`日K序列里有 ${seq.length - clean.length} 根重复日期，已按同一天只留一根处理`);
  if (!clean.length) {
    notes.push("技术面没有任何可用日K（取数失败或该标的无历史）：五项技术规则全部按缺失处理，不会用昨收价凑一个结构分");
    return { input: empty, bar_date: null, bars_used: 0, notes };
  }
  const t = clean.length - 1;
  const closes = clean.map((b) => b.c as number);
  const c: (number | null)[] = closes;
  const ma5 = sma(c, 5), ma10 = sma(c, 10), ma20 = sma(c, 20);
  const { dif, dea, bar } = macdCalc(c);
  const rsi = rsiCalc(c, rsiPeriod);
  if (clean.length < 20) notes.push(`日K只有 ${clean.length} 根：MA20 与 MACD 需要更长窗口，取不出值的分项会记为缺失而不是补值`);

  // ---- T-VOLUME 的两端：当日量与前 N 根均量（不含当日）----
  const volTodayRaw = clean[t]?.v;
  const priorVols = clean.slice(Math.max(0, t - volWindow), t).map((b) => b?.v).filter((v): v is number => isNum(v) && v > 0);
  const volAvg = priorVols.length ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : null;
  const volume = isNum(volTodayRaw) && volTodayRaw > 0 ? volTodayRaw : null;
  if (priorVols.length === 0) {
    notes.push("成交量：基准窗口内没有一根有效的正成交量读数（上游未给 v 字段或全是 0）⇒ T-VOLUME 按缺失处理。注意这与「今日无量」是两件事，0 不是一个放量/缩量结论");
  } else if (priorVols.length < volWindow) {
    notes.push(`成交量基准只用到 ${priorVols.length} 根（窗口 ${volWindow} 根里有 ${volWindow - priorVols.length} 根没有有效量读数）：均量按实际用得到的这些根算，raw 里记的是这个真实窗口`);
  }

  // ---- T-BREAKOUT 的两端：当日最高与前 N 根最高（不含当日）----
  const highTodayRaw = clean[t]?.h;
  const priorHighs = clean.slice(Math.max(0, t - highWindow), t).map((b) => b?.h).filter((v): v is number => isNum(v) && v > 0);
  const priorHigh = priorHighs.length ? Math.max(...priorHighs) : null;
  const high = isNum(highTodayRaw) && highTodayRaw > 0 ? highTodayRaw : null;
  if (priorHighs.length === 0) {
    notes.push("压力位：前若干根日K没有一根有效最高价 ⇒ T-BREAKOUT 按缺失处理，本层不会拿收盘价当 20 日压力");
  } else if (priorHighs.length < highWindow) {
    notes.push(`压力位只用到 ${priorHighs.length} 根（窗口 ${highWindow} 根里有 ${highWindow - priorHighs.length} 根没有有效最高价）：这条「20 日压力」实际是 ${priorHighs.length} 日压力，窗口记在 raw 里`);
  }

  return {
    input: {
      ma5: atLast(ma5, t), ma10: atLast(ma10, t), ma20: atLast(ma20, t),
      close: atLast(c, t),
      close_prev: t > 0 ? (isNum(clean[t - 1]?.c) ? (clean[t - 1].c as number) : null) : null,
      dif: atLast(dif, t), dea: atLast(dea, t),
      dif_prev: t > 0 ? atLast(dif, t - 1) : null, dea_prev: t > 0 ? atLast(dea, t - 1) : null,
      bar: atLast(bar, t), bar_prev: t > 0 ? atLast(bar, t - 1) : null,
      rsi: atLast(rsi, t), rsi_period: rsiPeriod,
      volume, volume_avg: volAvg, volume_window: priorVols.length || null,
      high, prior_high_20: priorHigh, prior_high_window: priorHighs.length || null,
    },
    bar_date: clean[t].date.slice(0, 10),
    bars_used: clean.length,
    notes,
  };
}

// ---------- 概率面：similarReturnForward → ProbabilityInput ----------

/**
 * 相似环境统计 → 概率面输入。只取 1/5/20 三个期限（decision-core 的 PROBABILITY_BANDS 只有这三档），
 * 其余期限原样丢弃并登记 —— 本层不擅自插值或改档。
 *
 * v3 多带两件事：① 引擎新算的盈亏比四格（payoff_ratio/avg_win/avg_loss/win·loss_samples）原样透传，
 * 本层不重算、不换算；② **primary_horizon 必须显式声明**（默认 1 日，理由见 PRIMARY_HORIZON_DEFAULT 的注释），
 * 不声明的话打分内核会把整维判成缺失 —— 那是内核的护栏，本层选择「带默认值 + 记账」而不是把维度丢掉。
 */
export function probabilityFromSimilarEnv(
  stats: SimilarEnvStats | null,
  opts: { trade_date: string | null; scope_note?: string; primary_horizon?: Horizon },
): { input: ProbabilityInput | null; notes: string[] } {
  const notes: string[] = [opts.scope_note ?? PROBABILITY_SCOPE_NOTE];
  const ph = opts.primary_horizon ?? PRIMARY_HORIZON_DEFAULT;
  notes.push(`概率面按 ${ph} 日期限打分（任务书 §六 的示例句式用的是「未来 1 日」，多周期一起计会把同一维权重放大倍数）：${SUPPLEMENT_MARKER}`);
  if (!stats) {
    notes.push("概率面没有取到相似环境统计（上证日K不可用或引擎未返回）：这一维按缺失处理");
    return { input: null, notes };
  }
  const readings: ProbabilityReading[] = [];
  const dropped: number[] = [];
  for (const h of stats.horizons) {
    if (h.h !== 1 && h.h !== 5 && h.h !== 20) { dropped.push(h.h); continue; }
    readings.push({
      horizon: h.h,
      win_rate: isNum(h.win_rate) ? h.win_rate : null,
      sample_size: isNum(h.sample_size) ? h.sample_size : 0,
      trade_date: opts.trade_date,
      period: stats.period ?? null,
      payoff_ratio: isNum(h.payoff_ratio) ? h.payoff_ratio : null,
      avg_win: isNum(h.avg_win) ? h.avg_win : null,
      avg_loss: isNum(h.avg_loss) ? h.avg_loss : null,
      win_samples: isNum(h.win_samples) ? h.win_samples : null,
      loss_samples: isNum(h.loss_samples) ? h.loss_samples : null,
    });
  }
  if (dropped.length) notes.push(`相似环境引擎返回了 ${dropped.join("、")} 日期限，打分表没有这一档 ⇒ 未计入（不插值、不改档）`);
  if (!stats.period) notes.push("相似环境本次给不出样本区间（没有可用于前向统计的历史匹配日）：概率分数的窗口无法事后重建");
  if (!readings.some((r) => r.horizon === ph)) notes.push(`本次读数里没有 ${ph} 日这一档（引擎返回 ${readings.map((r) => `${r.horizon} 日`).join("、") || "空"}）：打分内核会判这一维缺失，本层不拿别的周期顶上`);
  if (!readings.length) notes.push("概率面的三个期限本次全部算不出：这一维不计分，权重让给可算维度");
  return {
    input: {
      engine: "similar_env",
      primary_horizon: ph,
      warnings: [...(stats.warnings ?? []), ...(stats.sample_ok ? [] : [`相似环境样本不足（${stats.sample_size}），本层照抄引擎的 sample_ok=false`])],
      readings,
      status: "HISTORICAL",
    },
    notes,
  };
}

// ---------- 事件面：event_interpretation 库行 → EventInput ----------

/** event_interpretation 的一行（payload 已解析成对象；解析失败的行由服务层计数后丢弃并登记） */
export interface InterpretationWire {
  /** 自然键 eventKey（= global_event.dedupeKey），不是自增 id */
  event_id: string;
  /** 该行落库的归档日 asOf（YYYY-MM-DD）；本层用它判新鲜度 */
  trade_date: string | null;
  title: string;
  impact_direction: string | null;
  impact_scope: string | null;
  importance: string | null;
  confidence: number | null;
  interpretation_status: string | null;
  /** 模型给出的受影响标的（P6-B 已按「标题/既有映射里确实出现」校验过，hypothesized_symbols 不在这里） */
  affected_symbols: string[];
  /** 解释里抽取的实体名，用于标的相关性匹配的第二个来源 */
  entities: string[];
}

export interface EventWireResult {
  input: EventInput;
  notes: string[];
}

/**
 * 标的相关性判定。规则（对应 event-score-core 的 E-SUBJECT 三种「不打分」措辞）：
 * - 没给标的 ⇒ 整分项不适用（relates_to_subject 一律 null）；
 * - 给了标的，但这条解释既没有 affected_symbols 也没有 entities ⇒ 「这条解释没给出任何标的」，
 *   不能记成「判定为不相关」（那是两个不同的事实）⇒ null；
 * - 有标的清单 ⇒ 命中 code 或名称为 true，否则 false。
 * 匹配只看这两列，**不拿标题去猜**：标题里出现公司简称是常态，用它判定会把无关事件算进 E-SUBJECT。
 */
export function relatesToSubject(row: Pick<InterpretationWire, "affected_symbols" | "entities">, subjectTokens: string[]): boolean | null {
  const lists = [...(row.affected_symbols ?? []), ...(row.entities ?? [])].map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!lists.length) return null;
  const tokens = subjectTokens.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (!tokens.length) return null;
  return lists.some((name) => tokens.some((tk) => name === tk || name.includes(tk) || tk.includes(name)));
}

export function eventsFromInterpretations(
  rows: InterpretationWire[] | null,
  opts: { ref_date: string; subject?: string | null; subject_tokens?: string[]; stale_after_days?: number },
): EventWireResult {
  const notes: string[] = [];
  const subject = (opts.subject ?? "").trim() || null;
  const tokens = (opts.subject_tokens ?? []).filter(Boolean);
  const signals: EventSignal[] = (rows ?? []).map((r) => ({
    event_id: r.event_id,
    trade_date: r.trade_date && /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date.slice(0, 10)) ? r.trade_date.slice(0, 10) : null,
    title: r.title,
    impact_direction: r.impact_direction,
    impact_scope: r.impact_scope,
    importance: r.importance,
    confidence: isNum(r.confidence) ? r.confidence : null,
    interpretation_status: r.interpretation_status,
    relates_to_subject: subject ? relatesToSubject(r, tokens.length ? tokens : [subject]) : null,
  }));
  if (subject && !tokens.length) notes.push("标的相关性只能用代码/名称清单匹配，服务层没传标的名称与代码 ⇒ E-SUBJECT 按无判定处理");
  if (!rows) notes.push("事件面读取失败（event_interpretation 查询未返回）：这一维按缺失处理，不当成「今天没有消息」");
  else if (!rows.length) notes.push(`${opts.ref_date} 起的窗口里没有任何已落库的事件解读：事件面按缺失处理（这一层只在有人点过「AI 理解今日事件」时才有内容，不会自动生成）`);
  return {
    input: {
      ref_date: opts.ref_date,
      events: signals,
      subject,
      stale_after_days: opts.stale_after_days ?? EVENT_STALE_AFTER_DAYS_DEFAULT,
    },
    notes,
  };
}

/** 新鲜度窗口起点：ref_date 往前 n 个日历日（YYYY-MM-DD 纯字符串算法，不引第三方日期库、不吃本地时区） */
export function windowStart(refDate: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(refDate.trim());
  if (!m) return refDate;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** event_interpretation 的库行形态（Prisma 返回的原始列，payload 还是 JSON 字符串） */
export interface InterpretationRow {
  eventKey: string;
  asOf: string | null;
  title: string | null;
  status: string | null;
  /** §九 完整结构的 JSON 文本；坏行按缺失处理，不当成「没有解释」也不猜内容 */
  payload: string | null;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];

/**
 * 库行 → 事件面读数。为什么解析放在这一层而不是服务层：
 * `impact_direction`/`impact_scope`/`importance` **只存在于 payload JSON 里**（schema 没有对应列），
 * 「解析不出来就算缺失、解析出来是 null 就传 null」这条判断必须可测。
 * 状态列优先于 payload 里的同名字段：它由服务端复校验后写入，payload 是模型原文的存档。
 */
export function interpretationWireFromRow(row: InterpretationRow): { wire: InterpretationWire | null; broken: string | null } {
  // payload 为空列必须单独拦下来：`JSON.parse(null ?? "{}")` 会得到一个合法的空对象，
  // 于是「解释内容压根没落库」会被解析成一条字段全 null 的读数，看起来像「模型判定为无方向」——
  // 那是三种不同的事实（没落库 / 落库但坏 / 落库且字段稀疏），本层只把最后一种当成读数。
  const raw = typeof row.payload === "string" ? row.payload.trim() : "";
  if (!raw) return { wire: null, broken: `${row.eventKey}：payload 列为空（解释内容没有落库，按缺失处理，不生成一条字段全空的读数）` };
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(raw) as unknown;
    parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { wire: null, broken: `${row.eventKey}：payload 解析不出对象（按缺失处理，不猜内容）` };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    wire: {
      event_id: row.eventKey,
      trade_date: str(row.asOf) ?? str(parsed.trade_date),
      title: str(row.title) ?? str(parsed.title) ?? "",
      impact_direction: str(parsed.impact_direction),
      impact_scope: str(parsed.impact_scope),
      importance: str(parsed.importance),
      confidence: num(parsed.confidence),
      interpretation_status: str(row.status) ?? str(parsed.interpretation_status),
      affected_symbols: strList(parsed.affected_symbols),
      entities: strList(parsed.entities),
    },
    broken: null,
  };
}

// ---------- 结论卡响应契约（页面 ↔ 服务层共用的形状） ----------
//
// 为什么这两个类型写在纯内核里而不是 decision-service.ts：客户端封装（src/lib/desk/quant-api.ts）
// 要 import 它，而 decision-service 连着 Prisma/数据源，一旦被拉进客户端图就是构建期事故。
// 放在这里，页面拿到的字段名与接线层记账的字段名天然是同一份定义，不会各写一套再漂移。

/** 一路来源的取数结果：页面按 used 显示「本次未取到」，不允许把失败渲染成 0 或空白 */
export interface DecisionSourceBadge {
  id: string;
  label: string;
  /** 用了哪个上游/多少家/什么口径，原样显示在来源标签里 */
  detail: string;
  used: boolean;
  /** 这路读数自己的所属日（日K取最后一根、快照取 trade_date、事件取窗口内最新一条） */
  as_of: string | null;
}

export interface DecisionView {
  ok: true;
  subject: string;
  /** 标的名称：来自当日全A快照，取不到就是 null（不拿代码凑） */
  subject_name: string | null;
  /** 服务端时钟（上海时区）：本层是这条结论的取数时刻 */
  as_of: string;
  trade_date: string;
  decision: Decision;
  /** decisionToText 的原文：页面与 AI 上下文共用同一份解释，不在两处各写一套 */
  text: string;
  wiring: {
    wiring_version: string;
    base_index: { symbol: string; label: string };
    /** 技术面最后一根日K的日期：与决策日不等时页面必须写出来（休市/滞后要说得出口） */
    technical_bar_date: string | null;
    technical_bars: number;
    rsi_period: number;
    /** T-VOLUME 的均量窗口与 T-BREAKOUT 的压力位窗口：实际用了几根（不是声明值）由接线层记账 */
    volume_window: number | null;
    prior_high_window: number | null;
    probability_scope: string;
    /** 概率面按哪个观察周期打分：换周期等于换结论口径，页面必须显示 */
    probability_horizon: number | null;
    event_window: { start: string; end: string; rows: number; payload_broken: number; stale_after_days: number };
    /** 成交额基线用了几个留档日（null = 本次没读到可信留档）：M-TURNOVER 的可信度全看这个数 */
    turnover_baseline_days: number | null;
    /** 接线层的口径声明与「还原成缺失」记录，与各维度的 missing 并列展示 */
    notes: string[];
  };
  sources: DecisionSourceBadge[];
}
