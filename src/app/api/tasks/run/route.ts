// POST 手动触发一次后台任务（P2-自动化 11/12：补跑、失败重试、验证链路）
// body: { kind: "radar" | "events", force?: boolean }
// 默认不强制：走与调度器完全相同的幂等判定（当日已有成功结果 → 返回 skipped(already_success)，不重复打数据源）。
// force=true 才跳过该拦截（仍受 running 互斥限制），用于人工补跑；每次执行都写 task_run，trigger=manual。
// 只允许跑「今天」：扫描器读的是当前实时行情/快讯，把结果标成历史日期会造出对不上的记录（REAL_DATA_ONLY）。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runTask, type TaskKind } from "@/lib/quant/scheduler/index";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: Request) {
  let body: { kind?: string; force?: boolean; trade_date?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* 允许空 body */
  }
  const kind = body.kind === "events" ? "events" : body.kind === "radar" ? "radar" : null;
  if (!kind) {
    return NextResponse.json({ ok: false, error: "kind 只能是 radar 或 events" }, { status: 400 });
  }
  if (body.trade_date && body.trade_date !== shanghaiDate()) {
    return NextResponse.json(
      { ok: false, error: `只支持执行当日（${shanghaiDate()}）；历史日期需要增量扫描链路，不能用当前行情冒充那天的结果` },
      { status: 400 },
    );
  }
  try {
    const outcome = await runTask(kind as TaskKind, "manual", { force: body.force === true });
    const rows = await db.taskRun.findMany({
      where: { kind, tradeDate: outcome.tradeDate },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    return NextResponse.json({
      ok: outcome.status === "success",
      outcome,
      runs: rows.map((r) => ({
        id: r.id, kind: r.kind, trade_date: r.tradeDate, status: r.status, trigger: r.trigger,
        started_at: r.startedAt.toISOString(),
        finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
        scanned: r.scanned, results: r.results, error: r.error, basis: r.basis, note: r.note,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
