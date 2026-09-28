// R21 收盘后复盘统计沉淀（服务端）：把当日的涨跌停家数 / 连板梯队 / 下跌家数钉成一行 market_daily_stats。
//
// 为什么要这个：首页「涨跌停板分布对比」「连板梯队结构」两张图此前只有一份写死的离线种子
// （review-stats-seed.json，止于 2026-09-24，不会自己长）。种子一落后再开多少天盘，图就停在哪天。
// 这份采集器让**种子覆盖终点之后的新日期由本地自产**，图才会往前长。
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
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { computeLimitUp } from "@/lib/quant/screener/limitup";
import { beijingParts, weekdayOf } from "@/lib/quant/scheduler/rules";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { splitBoards } from "@/lib/quant/review/review-daily-core";
import type { ArchiveResult, ScanMode } from "./persist.ts";

/** 收盘时刻下限：北京 15:05（给收盘集合竞价/快照落定留 5 分钟缓冲） */
const CLOSE_MINUTE = 15 * 60 + 5;

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

  // 站上5日线占比那几列要等 stock_daily_close 攒够 5 个交易日才有数——现在一律 null，不猜
  if (!missing.length) missing.push("站上5日线占比/低于5日线家数：需逐票收盘价攒满 5 个交易日后自产，当前记 null");

  const existing = await db.marketDailyStats.findUnique({ where: { tradeDate } });
  await db.marketDailyStats.upsert({
    where: { tradeDate },
    create: {
      tradeDate, limitUp, limitDown, t3, t4, t5, maxBoards, decliners,
      belowMa5: null, belowMa3: null, aboveMa5Pct: null, microPct: null, midPct: null, largePct: null,
      basis: "本地自产：全A快照（涨跌停/下跌家数）+ 涨停梯队（连板分布/最高板）",
    },
    update: {
      limitUp, limitDown, t3, t4, t5, maxBoards, decliners,
      basis: "本地自产：全A快照（涨跌停/下跌家数）+ 涨停梯队（连板分布/最高板）",
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
