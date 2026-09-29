// P0 类型B预测数据底座：每日收盘后（接现有 15:20 窗口）沉淀一行 daily_snapshot（宽度/风险/次日涨跌）。
// 次日涨跌字段（nextDayMktChg / nextDayUp）在「下个交易日的这次运行」里回填——T 日不知 T+1，物理上只能回填。
// 这是类型B方向概率预测（forecasting-direction-unlock-plan.md）的训练/回测数据来源；当前只是攒数，不放行任何预测。
//
// 方向靶说明：stock_daily_close 只存个股收盘价（不含指数 000001.SH），故「次日市场方向」取
// 「T→T+1 全市场中位个股收盘涨跌幅」（等权中位，抗极端值），完全由已抓的全局 ~5571 只收盘价推导。
//
// 三道硬闸（与 breadth-collect / review-daily-collect 同源）：
// 1) 北京 15:05 之前拒跑（盘中快照价不是收盘价）；
// 2) 周末拒跑（周六快照是周五的，按周六入库即造假交易日）；
// 3) 只写真读到的数，取不到写 null，不回填、不拿前一天顶替——缺就是缺。
import { db } from "@/lib/db";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { beijingParts, weekdayOf, addBeijingDays } from "@/lib/quant/scheduler/rules";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { computeLimitUp } from "@/lib/quant/screener/limitup";
import { splitBoards } from "@/lib/quant/review/review-daily-core";
import {
  widthColsForDate, breadthCalendarLookback, BREADTH_PAGE_DAYS, type BreadthWidthCols, type StockBar,
} from "@/lib/quant/screener/breadth-core";
import { deriveRiskLevel, computeNextDayChg, medianOf, type RiskLevel } from "./daily-snapshot-core.ts";
import type { ArchiveResult, ScanMode } from "./persist.ts";

/** 收盘时刻下限：北京 15:05（给收盘集合竞价/快照落定留 5 分钟缓冲，与 breadth/review 同口径） */
const CLOSE_MINUTE = 15 * 60 + 5;

/** 当日宽度三列：读 stock_daily_close 这段收盘价，交给 breadth-core 的纯核算（与 review-daily-collect 同法） */
async function widthColsForTradeDate(tradeDate: string): Promise<BreadthWidthCols | null> {
  try {
    const from = addBeijingDays(tradeDate, -breadthCalendarLookback(BREADTH_PAGE_DAYS));
    const rows = await db.stockDailyClose.findMany({
      where: { tradeDate: { gte: from, lte: tradeDate } },
      select: { symbol: true, tradeDate: true, close: true },
    });
    if (!rows.length) return null;
    const bars: StockBar[] = rows.map((r) => ({ symbol: r.symbol, date: r.tradeDate, close: r.close }));
    return widthColsForDate(bars, tradeDate);
  } catch {
    return null;
  }
}

/**
 * 回填所有 nextDayMktChg 为空的行：每行的 T+1 = 库里「该交易日之后、最近一个有全A收盘价的交易日」。
 * 对 T 与 T+1 的收盘价按 symbol 取交集，逐只算 T→T+1 涨跌幅，取中位数作为「全市场次日方向」靶。
 * 每日运行只需填「上一交易日」（今天即其 T+1）；更早的空缺（如漏跑）也会在此补齐，保证训练样本连续。
 */
async function backfillNextDay(): Promise<{ filled: number }> {
  const pending = await db.dailySnapshot.findMany({ where: { nextDayMktChg: null }, orderBy: { tradeDate: "asc" } });
  let filled = 0;
  for (const row of pending) {
    const tRows = await db.stockDailyClose.findMany({
      where: { tradeDate: row.tradeDate },
      select: { symbol: true, close: true },
    });
    if (!tRows.length) continue;
    const next = await db.stockDailyClose.findFirst({
      where: { tradeDate: { gt: row.tradeDate } },
      orderBy: { tradeDate: "asc" },
      select: { tradeDate: true },
    });
    if (!next) continue;
    const t1Rows = await db.stockDailyClose.findMany({
      where: { tradeDate: next.tradeDate },
      select: { symbol: true, close: true },
    });
    if (!t1Rows.length) continue;

    const mapT = new Map(tRows.map((r) => [r.symbol, r.close]));
    const chgs: number[] = [];
    for (const r of t1Rows) {
      const c0 = mapT.get(r.symbol);
      if (c0 == null) continue;
      const chg = computeNextDayChg(c0, r.close);
      if (isFinite(chg)) chgs.push(chg);
    }
    if (!chgs.length) continue;
    const chg = medianOf(chgs);
    if (!isFinite(chg)) continue;

    await db.dailySnapshot.update({
      where: { tradeDate: row.tradeDate },
      data: {
        nextDayUp: chg >= 0,
        nextDayMktChg: chg,
        nextDayBasis: `T+1=${next.tradeDate} 全市场中位个股收盘涨跌幅（N=${chgs.length} 只，源 stock_daily_close）`,
      },
    });
    filled++;
  }
  return { filled };
}

export async function archiveDailySnapshot(now = new Date()): Promise<ArchiveResult<never>> {
  const p = beijingParts(now);
  const wd = weekdayOf(p.date);
  if (wd === 0 || wd === 6) {
    throw new Error(`每日留档拒绝在周末执行（${p.date}）：周六日的快照是周五的，按周六入库就是造假交易日`);
  }
  if (p.minuteOfDay < CLOSE_MINUTE) {
    const hh = String(Math.floor(p.minuteOfDay / 60)).padStart(2, "0");
    const mm = String(p.minuteOfDay % 60).padStart(2, "0");
    throw new Error(`每日留档拒绝在收盘前执行（北京 ${p.date} ${hh}:${mm} < 15:05）：盘中价不是收盘价`);
  }

  const tradeDate = shanghaiDate(now);
  const [sent, lu, width, countRow] = await Promise.all([
    computeSentiment(),
    computeLimitUp(),
    widthColsForTradeDate(tradeDate),
    db.stockDailyClose.aggregate({ where: { tradeDate }, _count: { _all: true } }),
  ]);

  const missing: string[] = [];

  const limitUp = typeof sent?.limit_up === "number" && isFinite(sent.limit_up) ? sent.limit_up : null;
  const limitDown = typeof sent?.limit_down === "number" && isFinite(sent.limit_down) ? sent.limit_down : null;
  const decliners = typeof sent?.decliners === "number" && isFinite(sent.decliners) ? sent.decliners : null;
  if (limitUp === null) missing.push("涨停家数：全A快照未给出有效读数，记 null");
  if (limitDown === null) missing.push("跌停家数：全A快照未给出有效读数，记 null");
  if (decliners === null) missing.push("下跌家数：全A快照未给出有效读数，记 null");

  const tier3 = (lu?.tiers ?? []).find((t) => t.label === "3连板+");
  const boards = (tier3?.stocks ?? []).map((s) => (s as { boards?: number | null }).boards);
  const { t3, t4, t5 } = splitBoards(boards);
  const maxBoards = typeof lu?.max_boards === "number" && isFinite(lu.max_boards) ? lu.max_boards : null;
  if (!boards.length) missing.push("连板梯队：本次未取到「3连板+」名单，t3/t4/t5 记 null");
  if (maxBoards === null) missing.push("最高板：本次未取到有效读数，记 null");

  const aboveMa5Pct = width?.aboveMa5Pct ?? null;
  const belowMa5 = width?.belowMa5 ?? null;
  const belowMa3 = width?.belowMa3 ?? null;
  if (!width) missing.push(`宽度三列记 null：库里没有 ${tradeDate} 的收盘价行（当日宽度未沉淀），不拿上一天的数顶替`);

  const breadthCount = countRow._count._all || 0;
  const riskLevel: RiskLevel = deriveRiskLevel(aboveMa5Pct, decliners, limitUp, limitDown);

  const existing = await db.dailySnapshot.findUnique({ where: { tradeDate } });
  const basis = "本地自产：全A快照（涨跌停/下跌家数）+ 涨停梯队（连板分布/最高板）+ 逐票收盘价（宽度三列，三市全A）";
  await db.dailySnapshot.upsert({
    where: { tradeDate },
    create: {
      tradeDate, aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners,
      t3, t4, t5, maxBoards, breadthCount, riskLevel, basis,
    },
    update: {
      aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners,
      t3, t4, t5, maxBoards, breadthCount, riskLevel, basis,
    },
  });

  // 回填上一交易日的次日涨跌（今天即其 T+1）；更早的空缺一并补齐
  const { filled } = await backfillNextDay();
  if (filled > 0) missing.push(`次日涨跌回填 ${filled} 行（方向靶=全市场中位个股次日收盘涨跌幅）`);

  return {
    as_of: shanghaiStamp(now),
    trade_date: tradeDate,
    missing,
    scanned: breadthCount,
    results: 1,
    items: [],
    unmatched: null,
    source: "全A快照 + 涨停梯队 + 逐票收盘价（本地自产）",
    mode: "full" as ScanMode,
    delta: {
      scanned: breadthCount,
      inserted: existing ? 0 : 1,
      updated: existing ? 1 : 0,
      unchanged: 0,
      skippedByCursor: 0,
      superseded: 0,
      kept: 0,
      collapsed: 0,
    },
  };
}
