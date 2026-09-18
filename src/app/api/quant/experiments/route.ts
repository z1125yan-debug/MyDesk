// Quant Research Lab — 实验跟踪 API（Phase 9）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { listExperiments } from "@/lib/quant/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50);
  try {
    const experiments = await listExperiments(limit);
    return NextResponse.json({ experiments });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
