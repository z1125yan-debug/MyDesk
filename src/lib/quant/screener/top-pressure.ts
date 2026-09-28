// P15-R20b 见顶压力分 —— 取数组合层（仅服务端）：把六组读数凑齐，交给 top-pressure-core 那份纯核打分。
//
// 分工照 R20a 那条纪律：这里只回答「哪读数从哪儿取」，一分一档都不在这一层产生。
// 页面、接口、日志因此不可能各长出一套刻度。
//
// 六组读数的来源与它们的「时间」不一样，这一层要负责把时间说清楚（纯核不看钟）：
//   炸板/涨跌停、主力净额 —— 全 A 快照（盘中就是盘中）
//   接力、龙头梯队 —— market_limit_up 里库内最新一天（通常不等于今天：没收盘沉淀就没有今天）
//   宽度骤降 —— stock_daily_close 逐票收盘价自算的那条三市全A序列（与大盘页同一条线，见下）
//   外盘与 A50 —— 腾讯/新浪实时，美股那几条是上一段美东收盘
//
// 每一组各自 try/catch：一路取失败只让那一格退出并写明原因，绝不让整份压力分变成 502。
import { db } from "@/lib/db";
import { fetchQuotesReal, type RealQuote } from "@/lib/desk/em";
import { shanghaiStamp, marketSession } from "@/lib/desk/session";
import { addBeijingDays } from "@/lib/quant/scheduler/rules";
import { fetchOverseas } from "../data/overseas";
import { computeBreadthSeries, breadthCalendarLookback, DEFAULT_BREADTH_SCOPE } from "./breadth-core";
import { judgeDivergence, type Divergence, type OverseasSnapshot } from "../data/overseas-core.ts";
import { leaderStall, topTierOf } from "./limit-up-roster-core.ts";
import { latestRosterDay, readPromotionBlock } from "./limit-up-roster";
import { topPressure, type PressureInputs, type TopPressure } from "./top-pressure-core.ts";

export type { TopPressure, PressureComponent, PressureInputs } from "./top-pressure-core.ts";
export { PRESSURE_WEIGHTS, PRESSURE_BANDS, tierOfPressureScore } from "./top-pressure-core.ts";

/** `/api/market/sentiment` 里那一块的结构（这里只声明要用的字段，不引整个 SentimentResult 以免类型循环） */
export interface SentimentSlice {
  as_of: string;
  live: boolean;
  total: number;
  limit_up: number;
  limit_down: number;
  touched_limit: number;
  limit_up_broken: number;
  break_rate: number | null;
  main_net_sum_yi: number;
  main_net_known: number;
  median_pct: number;
  risk: { level: string };
}

/** 通达信那一路的主力净额合计（口径不同，只做说明，不参与打分） */
export interface MainNetTdxSlice {
  sum_yi: number | null;
  known: number;
  universe: number;
  complete?: number;
  as_of?: string;
  note?: string;
}

export interface PressureRead {
  pressure: TopPressure;
  /** 外盘背离判定原样带出去（板块页那一行直接用它的 line） */
  divergence: Divergence;
  /** 外盘那几条的原样读数，页面用来摆「谁的行情时刻是几时」 */
  overseas: OverseasSnapshot;
  /** 龙头梯队这一格的原始读数，页面想单独摆时用 */
  leader: ReturnType<typeof leaderStall>;
}

const err = (e: unknown): string => ((e as Error)?.message ?? String(e)).slice(0, 160);

/**
 * 宽度骤降：**跟大盘页那条线用同一条序列**——`stock_daily_close` 的真实收盘价自算（三市全A），
 * 取最近 5 个能出数的统计日，用「最新一天 vs 能拿到的最早那天」的差。
 *
 * 为什么不直接读 `market_daily_stats.aboveMa5Pct`（那是原先的写法）：那一列在 09-24 之前是
 * 外部同步种子照抄的（票池两市）、09-24 之后是我们自己三市自产的，**同一列里两种口径**。
 * 单日读数看不出来，但「4 日落差」是把两个日子相减——跨过 09-24 就把两种票池混在一次减法里，
 * 正是 R19c 定案要避免的那种错标（用户已两次纠正同类问题：R17 的 unitLabel、R19c 的 bDrawn）。
 * 页面那条线既然已经按三市自算画，压力分这条就必须吃同一条，否则「图上 23%」和「分数里的 27.6%」
 * 会在同一屏上打架。缺就是缺：这条序列没攒够天数时该分量整块退出，不回落到种子那一列。
 *
 * 逐票收盘价一天只变一次，所以本函数自带 10 分钟缓存（与 `/api/market/breadth` 同一个理由）：
 * 情绪接口是 30 秒 TTL 的盘中轮询，每次都扫十几万行会把整页拖慢。
 */
const BREADTH_TTL_MS = 10 * 60_000;
/** 这一格取最近 5 个「能出数」的统计日，用最新一天减最早一天；序列首行自己要 4 根历史收盘价，
 *  所以往回要取 5+4=9 个交易日。交易日→日历日的换算走 breadth-core 那条 `breadthCalendarLookback`
 *  （大盘页宽度接口吃的同一个分母），不在这里另立一套口径。 */
const BREADTH_PRESSURE_WINDOW_DAYS = 5;
const BREADTH_PRESSURE_STAT_DAYS = BREADTH_PRESSURE_WINDOW_DAYS + 4;
let breadthCache: { at: number; today: string; value: PressureInputs["breadth"] } | null = null;

async function breadthInput(today: string): Promise<PressureInputs["breadth"]> {
  if (breadthCache && breadthCache.today === today && Date.now() - breadthCache.at < BREADTH_TTL_MS) return breadthCache.value;
  const value = await computeBreadthInput(today);
  breadthCache = { at: Date.now(), today, value };
  return value;
}

async function computeBreadthInput(today: string): Promise<PressureInputs["breadth"]> {
  const none = (reason: string): PressureInputs["breadth"] =>
    ({ slope_pt: null, from_pct: null, to_pct: null, from_date: null, to_date: null, reason });
  const lookback = breadthCalendarLookback(BREADTH_PRESSURE_STAT_DAYS);
  try {
    const from = addBeijingDays(today, -lookback);
    const rows = await db.stockDailyClose.findMany({
      where: { tradeDate: { gte: from, lte: today } },
      select: { symbol: true, tradeDate: true, close: true },
    });
    if (!rows.length) {
      return none(`${from} 之后库里没有任何逐票收盘价行：这条序列要先跑历史回填（POST /api/market/breadth/backfill），当日之后等收盘后调度器自产`);
    }
    const series = computeBreadthSeries(
      rows.map((r) => ({ symbol: r.symbol, date: r.tradeDate, close: r.close })),
      DEFAULT_BREADTH_SCOPE,
    ).filter((s) => s.above_ma5_pct !== null);
    if (!series.length) return none(`近 ${lookback} 个日历日里没有任何一天满 5 根收盘价：MA5 占比要 5 根才出数，不拿 4 根凑`);
    const tail = series.slice(-BREADTH_PRESSURE_WINDOW_DAYS);
    const latest = tail[tail.length - 1];
    const to = latest.above_ma5_pct as number;
    const gapDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest.date}T00:00:00Z`)) / 864e5);
    const caliber = "本库真实收盘价自算（三市全A），与大盘页那条线同源";
    // 太陈的收盘位不进打分：它量的是「上周的形状」，摆在今天的档位上是骗人
    if (gapDays > 7) {
      return { slope_pt: null, from_pct: to, to_pct: to, from_date: latest.date, to_date: latest.date,
        reason: `库里最新的收盘位是 ${latest.date}（距今 ${gapDays} 天，超过 7 天的窗口）：这条量的是上周的形状，不进今天的打分` };
    }
    if (tail.length < 2) {
      return { slope_pt: null, from_pct: null, to_pct: to, from_date: null, to_date: latest.date,
        reason: `只有 ${latest.date} 一天满 5 根，单个点位谈不上「骤降」（${caliber}）` };
    }
    const base = tail[0];
    const from2 = base.above_ma5_pct as number;
    const span = tail.length - 1;
    return {
      slope_pt: to - from2,
      from_pct: from2,
      to_pct: to,
      from_date: base.date,
      to_date: latest.date,
      reason: [
        span < BREADTH_PRESSURE_WINDOW_DAYS - 1
          ? `满 5 根的宽度读数只攒到 ${tail.length} 天，实际跨度是 ${span} 个交易日（不是 ${BREADTH_PRESSURE_WINDOW_DAYS - 1} 日）` : "",
        gapDays > 0 ? `今日（${today}）收盘位还没入库，这条读的是 ${latest.date} 的收盘价` : "",
        caliber,
      ].filter(Boolean).join("；"),
    };
  } catch (e) {
    return none(`读宽度失败：${err(e)}`);
  }
}


/**
 * 龙头滞涨：库里最新一天的涨停名单取最高板梯队（`topTierOf` 往下带一档，样本不够再带一档），
 * 今日涨跌幅走 `fetchQuotesReal`（通达信→腾讯→东财），基准是全 A 快照的中位涨跌幅。
 * 名单日期由纯核带出来——它不等于「今天」，这一点必须写在 as_of 上。
 */
async function leaderInput(benchmark: number | null, roster: Awaited<ReturnType<typeof latestRosterDay>>): Promise<ReturnType<typeof leaderStall>> {
  if (!roster) {
    return leaderStall(null, [], new Map(), benchmark);
  }
  const group = topTierOf(roster.rows);
  let pct = new Map<string, number | null>();
  try {
    const quotes = await fetchQuotesReal(group.rows.map((r) => r.symbol));
    pct = new Map<string, number | null>();
    (quotes ?? []).forEach((q: RealQuote | null) => {
      if (q && typeof q.changePct === "number" && Number.isFinite(q.changePct)) pct.set(q.symbol, q.changePct);
    });
  } catch (e) {
    // 取不到今日涨幅：把空表交给纯核，它按「读到 0 只」判不可用，不拿昨日的板数涨幅冒充今日
    pct = new Map();
    return leaderStall(roster.date, roster.rows, pct, benchmark, err(e));
  }
  return leaderStall(roster.date, roster.rows, pct, benchmark);
}

/**
 * 算一份见顶压力分。任何一路取数失败都只让对应分量退出（`dropped` 里有原因），本函数不抛错。
 */
export async function computeTopPressure(
  sentiment: SentimentSlice,
  mainNetTdx?: MainNetTdxSlice | null,
  now = new Date(),
): Promise<PressureRead> {
  const asOf = shanghaiStamp(now);
  const today = asOf.slice(0, 10);
  // 时段词直接取 `marketSession` 的 label（交易中/集合竞价/午间休市/已收盘/周末休市），
  // 不在这一层另立一套「盘中 / 非交易时段」：午间 11:30 之后拿到的其实是上午收盘的那一帧，
  // 说「非交易时段」会让人以为数是从昨天搬来的，而 label 已经把这帧到底是什么时候讲清了。
  const sess = marketSession(now);
  const sessionTag = sess.open ? "盘中" : sess.label;

  const [prom, roster, breadth, overseas] = await Promise.all([
    readPromotionBlock(now).catch((e): null => { void err(e); return null; }),
    latestRosterDay().catch((): null => null),
    breadthInput(today),
    fetchOverseas(now).catch((): null => null),
  ]);

  const median = Number.isFinite(sentiment.median_pct) ? sentiment.median_pct : null;
  const divergence = judgeDivergence(overseas ?? {
    rows: [], a50: null, today, us_age_days: null, missing: ["外盘与 A50 这一路整个没取到（网络/编码/上游形状变化）"],
    basis: "腾讯 qt.gtimg.cn + 新浪 hf_CHA50CFD",
  }, median);
  const leader = await leaderInput(median, roster);

  const inputs: PressureInputs = {
    as_of: asOf,
    breaker: {
      break_rate: sentiment.break_rate,
      touched: sentiment.touched_limit,
      limit_up: sentiment.limit_up,
      limit_down: sentiment.limit_down,
      as_of: `${sessionTag} · 全 A 快照 ${sentiment.as_of}`,
    },
    relay: {
      promotion: prom?.promotion ?? null,
      ladder: prom?.ladder ?? null,
      roster_date: prom?.today_date ?? roster?.date ?? null,
    },
    leader,
    breadth,
    flow: {
      main_net_yi: sentiment.main_net_known > 0 ? sentiment.main_net_sum_yi : null,
      known: sentiment.main_net_known,
      universe: sentiment.total,
      as_of: `${sessionTag} · 全 A 快照 ${sentiment.as_of}`,
      alt: mainNetTdx && typeof mainNetTdx.sum_yi === "number" && Number.isFinite(mainNetTdx.sum_yi)
        ? { sum_yi: mainNetTdx.sum_yi, universe: mainNetTdx.universe, known: mainNetTdx.known, note: mainNetTdx.note ?? "" }
        : null,
    },
    overseas: {
      divergence: overseas ? divergence : null,
      us_age_days: overseas?.us_age_days ?? null,
      a50_as_of: overseas?.a50 ? `${overseas.a50.date} ${overseas.a50.time}（上游原样）`
        : overseas?.rows.length ? "A50 无读数，用隔夜美股" : "外盘这一路没取到",
    },
    threshold_level: sentiment.risk?.level ?? null,
  };

  return { pressure: topPressure(inputs), divergence, overseas: overseas ?? {
    rows: [], a50: null, today, us_age_days: null, missing: ["外盘与 A50 没取到：这一路的压力分整格退出"], basis: "腾讯 qt.gtimg.cn + 新浪 hf_CHA50CFD" }, leader };
}
