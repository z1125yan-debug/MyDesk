// GET 最新发现 / POST 立即扫描并落库（P2-4）
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { buildRadarFindings } from "@/lib/quant/screener/radar";
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

export async function POST() {
  quantBootstrap();
  try {
    const scan = await buildRadarFindings();
    await db.radarFinding.deleteMany({ where: { asOf: scan.trade_date } });
    if (scan.items.length) {
      await db.radarFinding.createMany({
        data: scan.items.map((it) => ({
          asOf: scan.trade_date,
          kind: it.kind,
          title: it.title,
          detail: it.detail,
          evidence: JSON.stringify(it.evidence),
        })),
      });
    }
    const rows = await db.radarFinding.findMany({ where: { asOf: scan.trade_date }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({
      ok: true,
      as_of: scan.as_of,
      trade_date: scan.trade_date,
      missing: scan.missing,
      items: rows.map((r) => ({
        id: r.id, kind: r.kind, title: r.title, detail: r.detail,
        evidence: JSON.parse(r.evidence || "{}"),
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
