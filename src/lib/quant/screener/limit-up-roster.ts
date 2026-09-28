// P15-R20 涨停名单读侧（仅服务端）：把 market_limit_up 里的两份名单读成
// 「接力（晋级率）+ 梯队（断层）+ 昨日涨停股的今日表现」三组读数，交给 /api/market/risk 与风险页。
//
// 这一层只做「取哪两天的名单、涨幅从哪来」，判定口径全部在 limit-up-roster-core 那份纯核里，
// 页面/接口/日志因此不会各写一套拆法。
//
// 三处诚实：
// 1) 库里一天名单都没有 → 三组读数全 null，并说清「收盘后沉淀还没跑过」，不画一条 0% 的线；
// 2) 两份名单不是相邻交易日（中间那天没沉淀成功）→ 照样算，但把缺口写进 line/missing 里，
//    因为 boards 是池子给的连续涨停数，隔一天并不会把接力算成假晋级，只是「这两天不是连着看的」；
// 3) 涨幅用本地**不复权**收盘价前后两天相除：除权除息日会偏。这个偏是明写的，不装作是交易所口径涨跌幅。
import { db } from "@/lib/db";
import { shanghaiStamp } from "@/lib/desk/session";
import { localTradingDays } from "./limit-up-collect";
import {
  ladderOf, moneyEffect, promotionDayLine, promotionRates, rosterFromDb,
  type MoneyEffect, type PromotionBlock, type RosterRow,
} from "./limit-up-roster-core.ts";

/** 读侧带出的那一块的类型（定义在纯核，服务端与客户端共用一份） */
export type { PromotionBlock, RosterRow } from "./limit-up-roster-core.ts";
export type PromotionRead = PromotionBlock;

const NO_ROSTER_NOTE =
  "库里一天涨停名单都没有：收盘后 15:20 的沉淀还没跑成，或回填没成功。"
  + "接力率/梯队断层/昨日涨停表现这三组读数没有，不是「今天 0 只涨停」";

async function rowsForDate(date: string): Promise<RosterRow[]> {
  const rows = await db.marketLimitUp.findMany({ where: { tradeDate: date } });
  return rows.map((r) => rosterFromDb(r));
}

async function rosterDates(): Promise<string[]> {
  const rows = await db.marketLimitUp.findMany({
    where: {}, select: { tradeDate: true }, distinct: ["tradeDate"], orderBy: { tradeDate: "desc" }, take: 120,
  });
  return rows.map((r) => r.tradeDate);
}

/**
 * 昨日涨停股的今日表现：涨幅 = 本地收盘价（今日）/ 本地收盘价（昨日）− 1。
 * 任一天缺行就不参与统计（缺就是缺，不补 0），覆盖率由纯核判够不够出数。
 */
async function moneyEffectFor(prevRows: RosterRow[], prevDate: string, todayDate: string): Promise<MoneyEffect> {
  const symbols = [...new Set(prevRows.map((r) => r.symbol))];
  if (!symbols.length) return moneyEffect([], new Map());
  const closes = await db.stockDailyClose.findMany({
    where: { symbol: { in: symbols }, tradeDate: { in: [prevDate, todayDate] } },
    select: { symbol: true, tradeDate: true, close: true },
  });
  const byDay = new Map<string, Map<string, number>>();
  for (const c of closes) {
    if (typeof c.close !== "number" || !Number.isFinite(c.close) || c.close <= 0) continue;
    const m = byDay.get(c.tradeDate) ?? new Map<string, number>();
    m.set(c.symbol, c.close);
    byDay.set(c.tradeDate, m);
  }
  const prevCloses = byDay.get(prevDate) ?? new Map<string, number>();
  const todayCloses = byDay.get(todayDate) ?? new Map<string, number>();
  const pctMap = new Map<string, number | null>();
  for (const s of symbols) {
    const a = prevCloses.get(s);
    const b = todayCloses.get(s);
    pctMap.set(s, a && b ? (b / a - 1) * 100 : null);
  }
  return moneyEffect(prevRows, pctMap);
}

/** 读最近两天的名单并出三组读数（风险页 / 接口用） */
export async function readPromotionBlock(now = new Date()): Promise<PromotionRead> {
  const dates = await rosterDates();
  const base: PromotionRead = {
    as_of: shanghaiStamp(now),
    today_date: dates[0] ?? null,
    prev_date: dates[1] ?? null,
    roster_days: dates.length,
    earliest: dates.length ? dates[dates.length - 1] : null,
    promotion: null,
    ladder: null,
    money: null,
    line: "",
    adjacent: null,
    missing: [],
    source: "本地自产：market_limit_up（东财涨停池按日落档）+ stock_daily_close 收盘价",
  };
  if (!dates.length) {
    return { ...base, line: `接力：算不出——${NO_ROSTER_NOTE}`, missing: [NO_ROSTER_NOTE] };
  }
  const todayDate = dates[0];
  const todayRows = await rowsForDate(todayDate);
  const ladder = ladderOf(todayRows);
  const missing: string[] = [];
  if (ladder.unknownBoards) {
    missing.push(`${ladder.unknownBoards} 只当日没读到连板数：不进板数桶、不算进梯队，也当不了晋级率的分母`);
  }
  if (dates.length === 1) {
    missing.push(`库里只有 ${todayDate} 一天名单，接力率要比「昨天 vs 今天」，明天收盘后再看`);
    return {
      ...base, ladder,
      line: promotionDayLine(todayDate, "（无昨日名单）", promotionRates([], todayRows), ladder),
      missing,
    };
  }

  const prevDate = dates[1];
  const prevRows = await rowsForDate(prevDate);
  const promotion = promotionRates(prevRows, todayRows);
  const money = await moneyEffectFor(prevRows, prevDate, todayDate);

  const calendar = await localTradingDays();
  const idx = calendar.indexOf(todayDate);
  const adjacent = idx > 0 ? calendar[idx - 1] === prevDate : null;
  if (adjacent === false) {
    missing.push(`${prevDate} 与 ${todayDate} 之间在本地日历上不是相邻交易日（中间那天的名单没沉淀成功）：`
      + "接力照样按「今日仍在池且板数 +1」判，但要知道这两天不是连着两天看的");
  }
  if (!money.available) missing.push(`昨日涨停股今日表现：${money.reason}`);
  else if (money.reason) missing.push(`昨日涨停股今日表现：${money.reason}`);

  return {
    ...base, promotion, ladder, money,
    line: promotionDayLine(todayDate, prevDate, promotion, ladder),
    adjacent,
    missing,
  };
}
