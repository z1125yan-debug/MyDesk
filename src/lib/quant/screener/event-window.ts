// 事件「最近窗口」：从**最近有数据的那一天**起，按新→旧**整日**累加，直到条数 ≥ min（默认 20）。
//
// 为什么需要它：事件按「日历今天」落桶（`shanghaiDate()`），一旦过了午夜，页面就会翻到只有凌晨
// 一两条快讯的新一天——用户看着「只有一条新闻」，而真正那一批（29 条）在昨天。这里把「最近一天」
// 扩展成一个跨日窗口：最近那天不足 20 条时，自动把更早的日子（整日）补进来，凑够 20 条为止。
//
// 只做**整日累加**、不做半日截断：每条事件都带自己的日期，页面/AI 理解都能如实标出它属于哪天。
// 列表（/api/events）与 AI 理解提示词（loadEventFacts）共用这一份窗口，保证「看到什么就理解什么」。
import { db } from "@/lib/db";

/** 窗口下限：最近那天不足这么多条，就补更早的日子（用户口径：「不满二十条自动补昨日的」） */
export const EVENT_WINDOW_MIN = 20;
/** 窗口上限：跨日累加的硬顶，避免极端情况下把很多天的数据一次性拉出来 */
export const EVENT_WINDOW_MAX = 80;

export interface EventWindow {
  /** 参与窗口的日期，新→旧（dates[0] = 最近有数据的那天） */
  dates: string[];
  rows: Awaited<ReturnType<typeof db.globalEvent.findMany>>;
  /** true = 窗口跨了不止一天（最近那天不足 min 条、补了更早的日子） */
  supplemented: boolean;
}

export async function recentEventWindow(opts: { min?: number; max?: number } = {}): Promise<EventWindow> {
  const min = Math.max(1, Math.floor(opts.min ?? EVENT_WINDOW_MIN));
  const max = Math.max(min, Math.floor(opts.max ?? EVENT_WINDOW_MAX));
  // 库里有哪些天、各多少条（新→旧）
  const groups = await db.globalEvent.groupBy({
    by: ["asOf"],
    _count: { _all: true },
    orderBy: { asOf: "desc" },
  });
  const dates: string[] = [];
  let total = 0;
  for (const g of groups) {
    if (total >= min) break;
    dates.push(g.asOf);
    total += g._count?._all ?? 0;
  }
  if (!dates.length) return { dates: [], rows: [], supplemented: false };
  const rows = await db.globalEvent.findMany({
    where: { asOf: { in: dates } },
    orderBy: [{ asOf: "desc" }, { time: "desc" }],
    take: max,
  });
  return { dates, rows, supplemented: dates.length > 1 };
}
