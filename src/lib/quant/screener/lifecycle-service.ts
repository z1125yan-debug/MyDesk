// 生命周期计划的服务端组装点：把「注入 client 的只读层」和 @/lib/db 单例接起来，
// 让 preview / purge 两条路由读到的是同一份计划构建逻辑（两处各写一遍 = 预览与执行可能用不同口径）。
//
// 与 lifecycle.ts 的分工：lifecycle.ts 不 import 任何 @/ 模块、相对 import 带 .ts 后缀，
// 才能被 node --test 用临时库副本真跑；本文件就是「只有应用侧才有」的那一小段粘合层。
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { RETENTION_DAYS, buildPlan, type LifecyclePlan } from "./lifecycle-core.ts";
import { detailDayBuckets, runTablesExpired, totalDetailRows } from "./lifecycle.ts";

export interface CurrentPlan {
  plan: LifecyclePlan;
  totalRows: number;
  expired: { table: "task_run" | "scan_cursor"; rows: number }[];
}

export async function currentPlan(): Promise<CurrentPlan> {
  const today = shanghaiDate();
  const [buckets, totalRows] = await Promise.all([detailDayBuckets(db), totalDetailRows(db)]);
  const plan = buildPlan(today, buckets, RETENTION_DAYS);
  const expired = await runTablesExpired(db, plan.cutoff);
  return { plan, totalRows, expired };
}
