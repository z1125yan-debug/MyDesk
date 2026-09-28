// GET 最新发现 / POST 立即扫描并落库（P2-4）
// 手动点击扫描与后台调度共用 scheduler.runTaskTracked（内部落库实现见 screener/persist.ts），保证幂等口径与任务记录只有一份实现
import { NextResponse } from "next/server";
import { ttlCache, invalidateServerCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { runTaskTracked, scanFailMessage } from "@/lib/quant/scheduler/index";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  return ttlCache("radar", DEFAULT_TTL_MS, () => getHandler());
}
async function getHandler() {
  // 失败也必须返回可读 JSON（空 body 会让前端抛 "Unexpected end of JSON input"，掩盖真实原因）
  try {
    const asOf = shanghaiDate();
    // state:"live"：增量口径下「本次算不出来的旧信号」只被标记消失、不删除（留给第四阶段复盘），
    // 因此页面读的是当前成立的那批；历史行仍在库里可查。
    const rows = await db.radarFinding.findMany({ where: { asOf, state: "live" }, orderBy: { createdAt: "asc" } });
    // 如实回报被标记消失的行数（不展示内容，只让页面知道「今日曾成立、本次没算出来」不是被删了）
    const supersededToday = await db.radarFinding.count({ where: { asOf, state: "superseded" } });
    return NextResponse.json({
      ok: true,
      as_of: asOf,
      scanned: rows.length > 0,
      superseded_today: supersededToday,
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
// force 同时意味着口径=全量（当日先删后插重刷）：点了就要真跑一遍，不允许被游标跳过；游标仍会写入，供收盘后自动那次走增量。
export async function POST() {
  quantBootstrap();
  try {
    const { outcome, result } = await runTaskTracked("radar", "manual", { force: true });
    if (!result) {
      return NextResponse.json({ ok: false, error: scanFailMessage(outcome), task: outcome }, { status: 502 });
    }
    invalidateServerCache("radar"); // 扫描写库成功 → 让 GET 的 30s 短缓存失效
    return NextResponse.json({
      ok: true,
      as_of: result.as_of,
      trade_date: result.trade_date,
      mode: outcome.mode ?? null,
      delta: outcome.delta ?? null,
      // 与 GET 同一口径：本次扫描后当日还剩多少条「曾成立、未再算出」的行（标记消失，不删除）
      superseded_today: await db.radarFinding.count({ where: { asOf: result.trade_date, state: "superseded" } }),
      missing: result.missing,
      items: result.items,
      task: outcome,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
