// GET /api/market/sectors/top-risk          — 全市场板块顶部风险扫描器（列表）
// GET /api/market/sectors/top-risk?sector=半导体 — 单板块诊断详情（四分数+状态+产业链诊断+证据）
// 引擎：src/lib/quant/screener/top-risk-engine.ts（读 data/sector-daily-snapshots.json + sector-industry-map.json）
import { NextResponse } from "next/server";
import { scanAll, analyzeSector } from "@/lib/quant/screener/top-risk-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const sector = new URL(req.url).searchParams.get("sector");
  try {
    if (sector) {
      const r = analyzeSector(sector);
      if (!r) return NextResponse.json({ ok: false, error: `未找到板块：${sector}` }, { status: 404 });
      return NextResponse.json({ ok: true, detail: r });
    }
    return NextResponse.json({ ok: true, scanner: scanAll() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `计算失败：${(e as Error).message}` }, { status: 500 });
  }
}
