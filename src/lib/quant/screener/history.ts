// P4 第四阶段 历史复盘的读取层：只按 asOf 从既有表里 SELECT，不做任何计算、不写库。
//
// 与 P3 的边界（严格遵守用户约定）：dedupeKey / contentHash / state / scan_cursor / 增量游标 / 幂等机制
// 一套都没动，也没调用扫描链路 —— 历史查询 ≠ 历史重算。这里读的就是那些机制已经写进库的真实行。
//
// 客户端由调用方注入（routes 传 @/lib/db 的单例），本文件不 import 任何带 @/ 别名的模块：
// 这样 node --test 才能用隔离库副本对「按日期取数、跨日不串、live/superseded 过滤」做真实断言，
// 而不必把这些判定复制一份到测试里（复制一份就等于没有验收）。
import type { PrismaClient } from "@prisma/client";
import type { StateFilter } from "./history-core";

export type HistoryDb = Pick<PrismaClient, "radarFinding" | "globalEvent" | "taskRun">;

export interface DayCountBucket { date: string; rows: number; live: number; superseded: number | null }
export interface DayCounts { rows: number; live: number; superseded: number }

export async function radarDayCounts(db: HistoryDb, date: string): Promise<DayCounts> {
  const grouped = await db.radarFinding.groupBy({ by: ["state"], where: { asOf: date }, _count: { _all: true } });
  const out: DayCounts = { rows: 0, live: 0, superseded: 0 };
  for (const g of grouped) {
    const n = Number(g._count?._all ?? 0);
    out.rows += n;
    const state = String((g as { state?: string }).state ?? "");
    if (state === "superseded") out.superseded += n;
    else out.live += n; // 与 P3 的读法一致：非 superseded 即视为当前成立（含历史遗留空值）
  }
  return out;
}

export async function eventDayCounts(db: HistoryDb, date: string): Promise<DayCounts> {
  // 事件表没有 state 列，superseded 如实返回 null 语义 ⇒ 这里给 0，页面用 has_state=false 决定是否显示该栏
  const rows = await db.globalEvent.count({ where: { asOf: date } });
  return { rows, live: rows, superseded: 0 };
}

/** 全库可查询日期（radar 按 state 分开计数）；groupBy 在库里聚合，不把行读进内存 —— 常驻低内存口径不变 */
export async function radarDateBuckets(db: HistoryDb): Promise<DayCountBucket[]> {
  const grouped = await db.radarFinding.groupBy({ by: ["asOf", "state"], _count: { _all: true } });
  const byDate = new Map<string, DayCountBucket>();
  for (const g of grouped) {
    const date = String((g as { asOf?: string }).asOf ?? "");
    const n = Number(g._count?._all ?? 0);
    const cur = byDate.get(date) ?? { date, rows: 0, live: 0, superseded: 0 };
    cur.rows += n;
    if (String((g as { state?: string }).state ?? "") === "superseded") cur.superseded = (cur.superseded ?? 0) + n;
    else cur.live += n;
    byDate.set(date, cur);
  }
  return [...byDate.values()];
}

export async function eventDateBuckets(db: HistoryDb): Promise<DayCountBucket[]> {
  const grouped = await db.globalEvent.groupBy({ by: ["asOf"], _count: { _all: true } });
  return grouped.map((g) => {
    const n = Number(g._count?._all ?? 0);
    return { date: String((g as { asOf?: string }).asOf ?? ""), rows: n, live: n, superseded: null };
  });
}

export async function dayCounts(db: HistoryDb, kind: "radar" | "events", date: string): Promise<DayCounts> {
  return kind === "radar" ? radarDayCounts(db, date) : eventDayCounts(db, date);
}

export async function dateBuckets(db: HistoryDb, kind: "radar" | "events"): Promise<DayCountBucket[]> {
  return kind === "radar" ? radarDateBuckets(db) : eventDateBuckets(db);
}

/**
 * 取某天的雷达信号：state=live / superseded / all。
 * 排序沿用写入顺序（createdAt 升序），和 GET /api/radar 的今日读法保持同一条规则，
 * 这样「今天」在历史接口与实时接口里看到的顺序一致，不会出现两套页面口径。
 */
export async function readRadarDay(db: HistoryDb, date: string, filter: StateFilter) {
  const where = { asOf: date, ...(filter === "all" ? {} : filter === "superseded" ? { state: "superseded" } : { state: { not: "superseded" } }) };
  return db.radarFinding.findMany({
    where,
    select: { id: true, asOf: true, kind: true, title: true, detail: true, evidence: true, state: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/** 取某天的全球事件（时间倒序，与 GET /api/events 同一条规则） */
export async function readEventDay(db: HistoryDb, date: string) {
  return db.globalEvent.findMany({
    where: { asOf: date },
    orderBy: { createdAt: "desc" },
  });
}

/** 某天的扫描运行记录：回答「这天的数据是谁、用什么口径写进库的」（P2/P3 已落库的 task_run 行） */
export async function readDayRuns(db: HistoryDb, kind: "radar" | "events", date: string, take = 20) {
  return db.taskRun.findMany({
    where: { kind, tradeDate: date },
    orderBy: { startedAt: "desc" },
    take,
  });
}

/**
 * 当天 task_run 总条数（库里 COUNT，不把行读进内存）。
 * 有了它，页面才能说清「列出的只是最近若干条」——否则一次全量重扫 + 重试就会把真正落库的那次挤出可见范围，
 * 用户会误以为「这天从没扫出过数据」。
 */
export async function countDayRuns(db: HistoryDb, kind: "radar" | "events", date: string): Promise<number> {
  return db.taskRun.count({ where: { kind, tradeDate: date } });
}
