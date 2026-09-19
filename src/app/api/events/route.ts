// GET 当日事件 / POST 扫描并落库（P2-5）
// 手动点击扫描与后台调度共用 scheduler.runTaskTracked（落库实现见 screener/persist.ts）：幂等口径、任务记录只有一份实现
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runTaskTracked, scanFailMessage } from "@/lib/quant/scheduler/index";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

interface EventRowRaw {
  id: string; title: string; time: string; level: string; category: string;
  mappedSectors: string; relatedStocks: string; fundCheck: string; stage: string; source: string;
}

const rowToItem = (r: EventRowRaw) => ({
  id: r.id,
  title: r.title,
  time: r.time,
  level: r.level,
  category: r.category,
  mappedSectors: JSON.parse(r.mappedSectors || "[]") as string[],
  relatedStocks: JSON.parse(r.relatedStocks || "[]") as string[],
  fundCheck: JSON.parse(r.fundCheck || "{}") as Record<string, unknown>,
  stage: r.stage,
  source: r.source,
});

export async function GET() {
  // 失败也必须返回可读 JSON（空 body 会让前端抛 "Unexpected end of JSON input"，掩盖真实原因）
  try {
    const asOf = shanghaiDate();
    const rows = await db.globalEvent.findMany({ where: { asOf }, orderBy: { createdAt: "desc" } });
    return NextResponse.json({ ok: true, as_of: asOf, scanned: rows.length > 0, items: rows.map(rowToItem) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `事件读取失败：${(e as Error).message}` }, { status: 502 });
  }
}

// POST 手动扫描：与后台调度共用 scheduler.runTaskTracked（落库实现见 screener/persist.ts），同时写一条 trigger=manual 的 task_run
// force=true → 口径=全量（当日先删后插重刷），用户点了就必须真跑一遍；mode/delta 如实回给前端。
export async function POST() {
  try {
    const { outcome, result } = await runTaskTracked("events", "manual", { force: true });
    if (!result) {
      return NextResponse.json({ ok: false, error: scanFailMessage(outcome), task: outcome }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      as_of: result.as_of,
      trade_date: result.trade_date,
      mode: outcome.mode ?? null,
      delta: outcome.delta ?? null,
      unmatched: result.unmatched,
      missing: result.missing,
      source: result.source,
      scanned: result.scanned,
      results: result.results,
      items: result.items,
      task: outcome,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
