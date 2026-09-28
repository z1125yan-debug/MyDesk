// POST /api/lifecycle/purge — 执行清理：先导出 JSON 快照，再物理删除（P5 第五阶段）
//
// 这是整个项目里唯一会删正式库明细行的入口，所以四道闸门全部在服务端，且顺序不可调换：
//   ① confirm 必须逐字等于 PURGE_CONFIRM_TEXT（把「点了按钮」和「确认要删真实数据」分开）；
//   ② 当前库里必须真的有候选（0 候选时明确拒绝，不写空导出文件、不返回「清理成功」）；
//   ③ plan_hash 必须与「此刻重算的」计划一致（预览后被扫描重刷过 ⇒ 409，一行都不删）；
//   ④ 导出行数必须等于计划行数、文件写盘并回读复核通过 —— 任一步失败就抛错终止，不进入删除。
// 删除按「整天」执行：一天要么完整留在库里，要么完整进导出文件，不会出现半天的归档。
//
// 不做的事：不挂调度器（没有「到点自动删」）、不改 task_run/scan_cursor（授权范围只有明细行）、
// 不宣称一键回滚（恢复只能按导出文件的列名重新写回，restore_note 里就是这么写的）。
import path from "path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import {
  PURGE_CONFIRM_TEXT, buildExportEnvelope, exportCountCheck, exportFileName, purgeGate,
} from "@/lib/quant/screener/lifecycle-core";
import { deleteRowsForPlan, readRowsForPlan, totalDetailRows, writeExportFileSync } from "@/lib/quant/screener/lifecycle";
import { currentPlan } from "@/lib/quant/screener/lifecycle-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 导出目录：仓库内的 data/lifecycle/（与 data/factor-verified.json 同级；文件是否入库由用户决定，本阶段不擅自加 .gitignore） */
function exportDir(): string {
  return path.join(process.cwd(), "data", "lifecycle");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { confirm?: unknown; plan_hash?: unknown } | null;
    const { plan, totalRows } = await currentPlan();
    const gate = purgeGate(body, plan, totalRows);
    if (!gate.ok) {
      return NextResponse.json({
        ok: false, deleted: 0, rows_deleted: 0, export: null,
        plan_hash: plan.plan_hash, candidates: plan.candidates.length,
        error: gate.error,
        note: `本次未删除任何行：确认串要求逐字为 "${PURGE_CONFIRM_TEXT}"，且必须带回 GET /api/lifecycle/preview 的 plan_hash。`,
      }, { status: gate.status });
    }

    // 第二道保险：即使内核改动放过，路由这一层也绝不接受「当天」进入删除清单
    const today = shanghaiDate();
    const unsafe = gate.plan.candidates.filter((c) => !c.date || c.date >= today);
    if (unsafe.length) {
      return NextResponse.json({
        ok: false, deleted: 0, rows_deleted: 0, export: null,
        error: `清理计划里出现了不安全的日期（asOf 为空或不早于今天 ${today}）：${unsafe.map((u) => `${u.table}@${u.date}`).join("、")}。未删除任何行。`,
      }, { status: 409 });
    }

    const rows = await readRowsForPlan(db, gate.plan);
    const countOk = exportCountCheck(gate.plan, rows.length);
    if (!countOk.ok) {
      return NextResponse.json({ ok: false, deleted: 0, rows_deleted: 0, export: null, error: countOk.error }, { status: 409 });
    }

    const envelope = buildExportEnvelope(gate.plan, shanghaiStamp(), rows);
    let written: { path: string; bytes: number; readback_rows: number };
    try {
      written = writeExportFileSync(exportDir(), exportFileName(shanghaiStamp()), envelope);
    } catch (e) {
      return NextResponse.json({
        ok: false, deleted: 0, rows_deleted: 0, export: null,
        error: `导出快照写盘失败，因此一行都没有删除：${(e as Error).message}`,
      }, { status: 500 });
    }

    const deleted = await deleteRowsForPlan(db, gate.plan);
    const rowsDeleted = deleted.reduce((s, d) => s + d.count, 0);
    const remaining = await totalDetailRows(db);
    const stillThere = deleted.filter((d) => d.count !== gate.plan.candidates.find((c) => c.table === d.table && c.date === d.date)?.rows);

    return NextResponse.json({
      ok: true,
      deleted: deleted.filter((d) => d.count > 0).length,
      rows_deleted: rowsDeleted,
      per_day: deleted,
      export: { path: written.path.replace(process.cwd() + path.sep, ""), abs_path: written.path, bytes: written.bytes, row_count: written.readback_rows },
      detail_rows_in_db_before: totalRows,
      detail_rows_in_db_after: remaining,
      plan_hash: gate.plan.plan_hash,
      cutoff: gate.plan.cutoff,
      retention_days: gate.plan.retention_days,
      today,
      note: `已按「先导出再删除」清理 ${rowsDeleted} 行（涉及 ${deleted.filter((d) => d.count > 0).length} 个归档日），` +
        `导出快照：${written.path}（${written.readback_rows} 行，${written.bytes} 字节，已回读复核）。` +
        (stillThere.length ? `注意：有 ${stillThere.length} 个日期的实际删除条数与预览计数不一致（预览与执行之间库被改过），逐日明细见 per_day。` : `逐日删除条数与预览计划完全一致。`) +
        `task_run 与 scan_cursor 未触碰；恢复只能按导出文件的列名重新写回，项目没有一键回滚。`,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, deleted: 0, rows_deleted: 0, error: `清理执行失败：${(e as Error).message}` }, { status: 502 });
  }
}
