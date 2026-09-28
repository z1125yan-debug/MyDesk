// GET 当日事件 / POST 扫描并落库（P2-5）
// 手动点击扫描与后台调度共用 scheduler.runTaskTracked（落库实现见 screener/persist.ts）：幂等口径、任务记录只有一份实现
import { NextResponse } from "next/server";
import { ttlCache, invalidateServerCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { runTaskTracked, scanFailMessage } from "@/lib/quant/scheduler/index";
import { shanghaiDate } from "@/lib/desk/session";
import { recentEventWindow } from "@/lib/quant/screener/event-window";

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
  // 30s 短缓存：扫描/落库是 POST，成功会自动失效这里（见 server-cache 的调用方约定）
  return ttlCache("events", DEFAULT_TTL_MS, () => getHandler());
}
async function getHandler() {
  // 失败也必须返回可读 JSON（空 body 会让前端抛 "Unexpected end of JSON input"，掩盖真实原因）
  try {
    // 最近事件窗口：最近有数据的那天；不足 20 条时按新→旧自动补更早的日子（见 event-window.ts）。
    // 这样过午夜后不会只看到凌晨的一两条碎桶。每条 item 带自己的 date，页面跨日时如实标出。
    const win = await recentEventWindow();
    const dates = win.dates;
    const asOf = dates[0] ?? shanghaiDate();
    const items = win.rows.map((r) => ({ ...rowToItem(r), date: r.asOf }));
    return NextResponse.json({
      ok: true,
      as_of: asOf,
      window_dates: dates,
      supplemented: dates.length > 1,
      scanned: win.rows.length > 0,
      items,
    });
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
    invalidateServerCache("events"); // 扫描写库成功 → 让 GET 的 30s 短缓存失效，页面立刻能看到新行
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
