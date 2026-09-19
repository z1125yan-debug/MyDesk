// GET /api/market/limitup — 涨停梯队/连板池（P0补齐·任务B）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeLimitUp } from "@/lib/quant/screener/limitup";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET() {
  quantBootstrap();
  try {
    const data = await computeLimitUp();
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `涨停梯队计算失败：${(e as Error).message}` }, { status: 502 });
  }
}
