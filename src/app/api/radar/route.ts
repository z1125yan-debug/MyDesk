// GET 最新发现 / POST 立即扫描并落库（P2-4）
// 手动点击扫描与后台调度共用 scheduler.runTaskTracked（内部落库实现见 screener/persist.ts），保证幂等口径与任务记录只有一份实现
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { runTaskTracked, scanFailMessage } from "@/lib/quant/scheduler/index";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  // 失败也必须返回可读 JSON（空 body 会让前端抛 "Unexpected end of JSON input"，掩盖真实原因）
  try {
    const asOf = shanghaiDate();
    const rows = await db.radarFinding.findMany({ where: { asOf }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({
      ok: true,
      as_of: asOf,
      scanned: rows.length > 0,
      items: rows.map((r) => ({
        id: r.id, kind: r.kind, title: r.title, detail: r.detail,
        evidence: JSON.parse(r.evidence || "{}"),
        created_at: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `雷达读取失败：${(e as Error).message}` }, { status: 502 });
  }
}

// POST 手动扫描：与后台调度共用 scheduler.runTaskTracked —— 既落 radar_finding，也落一条 task_run（trigger=manual），
// 这样「这次是谁跑的、跑成功没有、拿到多少条」在同一个地方能查到。force=true：用户点了就必须真跑，
// 唯一还会拦的情况是同类型任务正在执行（running），避免两个扫描同时改当日数据。
export async function POST() {
  quantBootstrap();
  try {
    const { outcome, result } = await runTaskTracked("radar", "manual", { force: true });
    if (!result) {
      return NextResponse.json({ ok: false, error: scanFailMessage(outcome), task: outcome }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      as_of: result.as_of,
      trade_date: result.trade_date,
      missing: result.missing,
      items: result.items,
      task: outcome,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
