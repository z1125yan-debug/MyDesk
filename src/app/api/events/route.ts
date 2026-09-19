// GET 当日事件 / POST 扫描并落库（P2-5）
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scanGlobalEvents } from "@/lib/quant/screener/events";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET() {
  // 失败也必须返回可读 JSON（空 body 会让前端抛 "Unexpected end of JSON input"，掩盖真实原因）
  try {
    const asOf = shanghaiDate();
    const rows = await db.globalEvent.findMany({ where: { asOf }, orderBy: { createdAt: "desc" } });
    return NextResponse.json({
      ok: true,
      as_of: asOf,
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        time: r.time,
        level: r.level,
        category: r.category,
        mappedSectors: JSON.parse(r.mappedSectors || "[]"),
        relatedStocks: JSON.parse(r.relatedStocks || "[]"),
        fundCheck: JSON.parse(r.fundCheck || "{}"),
        stage: r.stage,
        source: r.source,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `事件读取失败：${(e as Error).message}` }, { status: 502 });
  }
}

export async function POST() {
  try {
    const scan = await scanGlobalEvents();
    await db.globalEvent.deleteMany({ where: { asOf: scan.trade_date } });
    if (scan.items.length) {
      await db.globalEvent.createMany({
        data: scan.items.map((it) => ({
          asOf: scan.trade_date,
          title: it.title,
          time: it.time,
          level: it.level,
          category: it.category,
          mappedSectors: JSON.stringify(it.mappedSectors),
          relatedStocks: JSON.stringify(it.relatedLeaders),
          fundCheck: JSON.stringify(it.fund),
          stage: it.fund.stage,
          source: it.source,
        })),
      });
    }
    const rows = await db.globalEvent.findMany({ where: { asOf: scan.trade_date }, orderBy: { createdAt: "desc" } });
    return NextResponse.json({
      ok: true,
      as_of: scan.as_of,
      trade_date: scan.trade_date,
      unmatched: scan.unmatched,
      missing: scan.missing,
      source: scan.source,
      items: rows.map((r) => ({
        id: r.id, title: r.title, time: r.time, level: r.level, category: r.category,
        mappedSectors: JSON.parse(r.mappedSectors || "[]"),
        relatedStocks: JSON.parse(r.relatedStocks || "[]"),
        fundCheck: JSON.parse(r.fundCheck || "{}"),
        stage: r.stage, source: r.source,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
