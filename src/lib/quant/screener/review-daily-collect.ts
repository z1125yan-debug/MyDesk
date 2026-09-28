// R21 收盘后复盘统计沉淀（服务端）：把当日的涨跌停家数 / 连板梯队 / 下跌家数 / 宽度三列钉成一行 market_daily_stats。
//
// 为什么要这个：首页「涨跌停板分布对比」「连板梯队结构」两张图此前只有一份写死的离线种子
// （review-stats-seed.json，止于 2026-09-24，不会自己长）。种子一落后再开多少天盘，图就停在哪天。
// 这份采集器让**种子覆盖终点之后的新日期由本地自产**，图才会往前长。
// P15-R19c 起宽度三列（站上5日线占比 / 跌破MA5 / 跌破MA3）也在这里自产：
// 库里 2026-04-20 之后有逐票真实收盘价，没有理由让这三列一直 null（「本地有数据」）。
// 微盘/中盘/大盘那三列**自产不了**——要按市值分层，库里的收盘价行没有市值字段，缺就留 null。
//
// 三道硬闸（与 breadth-collect 同源，口径一致）：
// 1) 北京 15:05 之前拒跑：盘中的涨停家数不是收盘数，钉进历史就是造假；
// 2) 周末拒跑：周六的行情是周五的，按周六入库等于造了个不存在的交易日；
// 3) 每个字段只写真读到的数：取不到写 null，不回填、不拿前一天顶替（缺就是缺）。
//
// 与种子的分工（重要，别搞反）：
//   seed = 历史底子（覆盖 2026-04-20~2026-09-24）；本表 = 种子终点之后的新日期。
//   同日两者都有时**以种子为准**（见 review-stats 路由），本表行照样留档供口径核对，
//   这样图上不会出现「同一天数字一会儿 51 一会儿 55」的跳变。
//   宽度那几列额外记一笔：种子是**两市**票池、自产是**三市全A**（我们的默认口径），
//   两个口径还各自平滑不同——所以页面把「同步·两市」那条线截在种子终点，不接我们的数。
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { computeLimitUp } from "@/lib/quant/screener/limitup";
import { beijingParts, weekdayOf, addBeijingDays } from "@/lib/quant/scheduler/rules";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { splitBoards } from "@/lib/quant/review/review-daily-core";
import {
  widthColsForDate, breadthCalendarLookback, BREADTH_PAGE_DAYS, type BreadthWidthCols, type StockBar,
} from "@/lib/quant/screener/breadth-core";
import type { ArchiveResult, ScanMode } from "./persist.ts";

/** 收盘时刻下限：北京 15:05（给收盘集合竞价/快照落定留 5 分钟缓冲） */
const CLOSE_MINUTE = 15 * 60 + 5;

/**
 * 本交易日的宽度三列：读 stock_daily_close 里这段收盘价，交给 breadth-core 的纯核算。
 * 窗口用 `breadthCalendarLookback(BREADTH_PAGE_DAYS)` ——跟页面那条序列同一个公式，
 * 同一天两边才是同一个分母（差一个窗口，占比就差几只停牌票，说不清谁对）。
 * 依赖调度顺序：KINDS 里 breadth 在 review 之前，当天的收盘价这一刻已经落库；
 * 万一那一路没跑成，这里就是「库里没当天的行」→ 三列 null + 一句原因，不拿昨天的数顶。
 */
async function widthColsForTradeDate(tradeDate: string): Promise<{ cols: BreadthWidthCols | null; reason: string }> {
  try {
    const from = addBeijingDays(tradeDate, -breadthCalendarLookback(BREADTH_PAGE_DAYS));
    const rows = await db.stockDailyClose.findMany({
      where: { tradeDate: { gte: from, lte: tradeDate } },
      select: { symbol: true, tradeDate: true, close: true },
    });
    if (!rows.length) return { cols: null, reason: `窗口 ${from}~${tradeDate} 在 stock_daily_close 里一行都没有（宽度那一路没跑）` };
    const bars: StockBar[] = rows.map((r) => ({ symbol: r.symbol, date: r.tradeDate, close: r.close }));
    const cols = widthColsForDate(bars, tradeDate);
    return cols
      ? { cols, reason: "" }
      : { cols: null, reason: `库里没有 ${tradeDate} 的收盘价行（当日宽度未沉淀），不拿上一天的数顶替` };
  } catch (e) {
    return { cols: null, reason: `读 stock_daily_close 失败：${(e as Error).message}` };
  }
}

export async function archiveReviewScan(now = new Date()): Promise<ArchiveResult<never>> {
  const p = beijingParts(now);
  const wd = weekdayOf(p.date);
  if (wd === 0 || wd === 6) {
    throw new Error(`复盘统计拒绝在周末执行（${p.date}）：周六日的行情是周五的，按周六入库就是造假交易日`);
  }
  if (p.minuteOfDay < CLOSE_MINUTE) {
    const hh = String(Math.floor(p.minuteOfDay / 60)).padStart(2, "0");
    const mm = String(p.minuteOfDay % 60).padStart(2, "0");
    throw new Error(`复盘统计拒绝在收盘前执行（北京 ${p.date} ${hh}:${mm} < 15:05）：盘中的涨停家数不是收盘数`);
  }

  quantBootstrap();
  const tradeDate = shanghaiDate(now);
  const [sent, lu] = await Promise.all([computeSentiment(), computeLimitUp()]);

  const missing: string[] = [];
  const limitUp = typeof sent?.limit_up === "number" && isFinite(sent.limit_up) ? sent.limit_up : null;
  const limitDown = typeof sent?.limit_down === "number" && isFinite(sent.limit_down) ? sent.limit_down : null;
  const decliners = typeof sent?.decliners === "number" && isFinite(sent.decliners) ? sent.decliners : null;
  if (limitUp === null) missing.push("涨停家数：全A快照未给出有效读数，本行记 null（不拿 0 顶替）");
  if (limitDown === null) missing.push("跌停家数：全A快照未给出有效读数，本行记 null");
  if (decliners === null) missing.push("下跌家数：全A快照未给出有效读数，本行记 null");

  // 连板梯队：只用「3连板+」这一桶（首板/2连板不进种子的 t3/t4/t5 口径）
  const tier3 = (lu?.tiers ?? []).find((t) => t.label === "3连板+");
  const boards = (tier3?.stocks ?? []).map((s) => (s as { boards?: number | null }).boards);
  const { t3, t4, t5 } = splitBoards(boards);
  const maxBoards = typeof lu?.max_boards === "number" && isFinite(lu.max_boards) ? lu.max_boards : null;
  if (!boards.length) missing.push("连板梯队：本次未取到「3连板+」名单，t3/t4/t5 记 null");
  if (maxBoards === null) missing.push("最高板：本次未取到有效读数，记 null");

  // 宽度三列（P15-R19c）：种子终点之后的 by 本地逐票收盘价自算——库里 2026-04-20 起就有真实日K，
  // 没有理由继续留 null。票池跟默认口径一致（三市全A），窗口用 breadth 那条序列同一个公式，
  // 这样同一天页面那条线与这里落库的数是同一个分母。缺就是缺：库里没当天的行 → 三列 null。
  const width = await widthColsForTradeDate(tradeDate);
  missing.push(width.cols
    ? `宽度三列自产：站上5日线 ${width.cols.aboveMa5Pct === null ? "数据不足（分母 0）" : `${width.cols.aboveMa5Pct.toFixed(2)}%`}、`
      + `跌破MA5 ${width.cols.belowMa5 ?? "数据不足"} 家、跌破MA3 ${width.cols.belowMa3 ?? "数据不足"} 家（三市全A）；`
      + "微盘/中盘/大盘分组要按市值分层，库里只有收盘价，自产不了，这三列继续留空"
    : `宽度三列记 null：${width.reason}`);

  const existing = await db.marketDailyStats.findUnique({ where: { tradeDate } });
  const basis = "本地自产：全A快照（涨跌停/下跌家数）+ 涨停梯队（连板分布/最高板）"
    + " + 逐票收盘价（宽度三列，三市全A；微/中/大盘分组缺）";
  await db.marketDailyStats.upsert({
    where: { tradeDate },
    create: {
      tradeDate, limitUp, limitDown, t3, t4, t5, maxBoards, decliners,
      aboveMa5Pct: width.cols?.aboveMa5Pct ?? null,
      belowMa5: width.cols?.belowMa5 ?? null,
      belowMa3: width.cols?.belowMa3 ?? null,
      microPct: null, midPct: null, largePct: null,
      basis,
    },
    update: {
      limitUp, limitDown, t3, t4, t5, maxBoards, decliners,
      aboveMa5Pct: width.cols?.aboveMa5Pct ?? null,
      belowMa5: width.cols?.belowMa5 ?? null,
      belowMa3: width.cols?.belowMa3 ?? null,
      basis,
    },
  });

  return {
    as_of: shanghaiStamp(now),
    trade_date: tradeDate,
    missing,
    scanned: boards.length,
    results: 1,
    items: [],
    unmatched: null,
    source: "全A快照 + 涨停梯队（本地自产）",
    mode: "full" as ScanMode,
    delta: {
      scanned: boards.length,
      inserted: existing ? 0 : 1,
      updated: existing ? 1 : 0,
      unchanged: 0,
      skippedByCursor: 0,
      superseded: 0,
      kept: 0,
      collapsed: 0, // 一天只有一行，不存在同批撞键合并
    },
  };
}
