// GET /api/market/themes — 主线发现（P2-3）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { discoverThemes } from "@/lib/quant/screener/themes";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  quantBootstrap();
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const data = await discoverThemes({ force });
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
