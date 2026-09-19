// P5 第五阶段 数据生命周期的库操作层：把 lifecycle-core 的判定落到真实库上。
//
// 与第四阶段的分层一致：本文件不 import 任何带 @/ 别名的模块，客户端由调用方注入 ——
// 这样 node --test 才能把运行时库复制到临时目录，在副本上真跑一遍「导出 → 删除 → 复核」，
// 而不是把判定复制进测试里。真实库在整个测试过程中只被读、不被写（用 size/mtime 未变来证明）。
//
// 唯一会删除正式库数据的路径就是这里：
//   1) 先按清理计划把候选行完整读出并写盘（data/lifecycle/expired-*.json），写盘后回读复核条数；
//   2) 复核通过后，按「整天」逐日 deleteMany；
//   3) 删完再 count 一次，把「库里现在还剩多少」如实返回。
// 任何一步失败都直接抛出，调用方（route）不得吞异常继续删。
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { DetailTable, DayBucket, ExportRow, LifecyclePlan } from "./lifecycle-core";

export type LifecycleDb = Pick<PrismaClient, "radarFinding" | "globalEvent" | "taskRun" | "scanCursor">;

/** 两张明细表按 asOf（雷达再按 state）分组计数：库里聚合，不把行读进内存 */
export async function detailDayBuckets(db: LifecycleDb): Promise<DayBucket[]> {
  const out: DayBucket[] = [];
  const radar = await db.radarFinding.groupBy({ by: ["asOf", "state"], _count: { _all: true } });
  const byDate = new Map<string, DayBucket>();
  for (const g of radar) {
    const date = String((g as { asOf?: string }).asOf ?? "");
    const n = Number(g._count?._all ?? 0);
    const state = String((g as { state?: string }).state ?? "");
    const cur = byDate.get(date) ?? { table: "radar_finding" as DetailTable, date, rows: 0, live: 0, superseded: 0 };
    cur.rows += n;
    if (state === "superseded") cur.superseded += n;
    else cur.live += n; // 与 P3/P4 的读法一致：非 superseded 即视为当前成立（含历史遗留空值）
    byDate.set(date, cur);
  }
  out.push(...byDate.values());

  const events = await db.globalEvent.groupBy({ by: ["asOf"], _count: { _all: true } });
  for (const g of events) {
    const n = Number(g._count?._all ?? 0);
    // 事件表没有 state 列：live=全部、superseded 如实给 0（口径见 lifecycle-core 的 stateAgnosticNote）
    out.push({ table: "global_event", date: String((g as { asOf?: string }).asOf ?? ""), rows: n, live: n, superseded: 0 });
  }
  return out;
}

export async function totalDetailRows(db: LifecycleDb): Promise<number> {
  const [r, e] = await Promise.all([db.radarFinding.count(), db.globalEvent.count()]);
  return r + e;
}

/** 运行记录表的「过期但不清理」条数（只报告） */
export async function runTablesExpired(db: LifecycleDb, cutoff: string) {
  const [taskRun, scanCursor] = await Promise.all([
    db.taskRun.count({ where: { tradeDate: { lt: cutoff } } }),
    db.scanCursor.count({ where: { tradeDate: { lt: cutoff } } }),
  ]);
  const out: { table: "task_run" | "scan_cursor"; rows: number }[] = [];
  if (taskRun) out.push({ table: "task_run", rows: taskRun });
  if (scanCursor) out.push({ table: "scan_cursor", rows: scanCursor });
  return out;
}

/**
 * 按清理计划取出候选行的完整内容（含 id、createdAt 等全部列），用于导出。
 * 只按 asOf 取，不附加 state 条件：整天都要走同一份导出文件。
 */
export async function readRowsForPlan(db: LifecycleDb, plan: LifecyclePlan): Promise<ExportRow[]> {
  const rows: ExportRow[] = [];
  for (const c of plan.candidates) {
    if (c.table === "radar_finding") {
      const found = await db.radarFinding.findMany({ where: { asOf: c.date }, orderBy: { createdAt: "asc" } });
      for (const r of found) rows.push({ ...(r as unknown as Record<string, unknown>), table: "radar_finding", id: String(r.id), asOf: String(r.asOf) } as ExportRow);
    } else {
      const found = await db.globalEvent.findMany({ where: { asOf: c.date }, orderBy: { createdAt: "asc" } });
      for (const r of found) rows.push({ ...(r as unknown as Record<string, unknown>), table: "global_event", id: String(r.id), asOf: String(r.asOf) } as ExportRow);
    }
  }
  return rows;
}

/** 按「整天」删除；返回每张表每天实际删掉的条数（deleteMany 的 count 由 Prisma 给出） */
export async function deleteRowsForPlan(db: LifecycleDb, plan: LifecyclePlan) {
  const deleted: { table: DetailTable; date: string; count: number }[] = [];
  for (const c of plan.candidates) {
    const res = c.table === "radar_finding"
      ? await db.radarFinding.deleteMany({ where: { asOf: c.date } })
      : await db.globalEvent.deleteMany({ where: { asOf: c.date } });
    deleted.push({ table: c.table, date: c.date, count: Number(res?.count ?? 0) });
  }
  return deleted;
}

/**
 * 写导出文件并回读复核：文件必须能 JSON.parse 且 row_count 与内存里的行数一致，
 * 否则抛错 —— 调用方据此拒绝删除。落盘位置由调用方给出（测试用临时目录，正式库用 data/lifecycle）。
 */
export function writeExportFileSync(dir: string, fileName: string, envelope: unknown): { path: string; bytes: number; readback_rows: number } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const text = JSON.stringify(envelope, null, 2);
  fs.writeFileSync(file, text, "utf8");
  const back = JSON.parse(fs.readFileSync(file, "utf8")) as { row_count?: number };
  const expected = (envelope as { row_count?: number }).row_count ?? -1;
  if (Number(back.row_count ?? -1) !== expected) {
    throw new Error(`导出文件回读复核失败：${file} 里 row_count=${String(back.row_count)} ≠ 写入时的 ${expected}`);
  }
  return { path: file, bytes: Buffer.byteLength(text, "utf8"), readback_rows: Number(back.row_count ?? 0) };
}
