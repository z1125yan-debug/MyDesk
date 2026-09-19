// Quant Screener API（需求文档 四：POST /api/quant/screener，含 include_stats 历史胜率）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { runScreener, type ScreenerRequestBody } from "@/lib/quant/screener/run";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => null)) as ScreenerRequestBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体非法（需要 JSON）" }, { status: 400 });
  }
  try {
    const data = await runScreener(body);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: `选股失败：${(e as Error).message}` }, { status: 502 });
  }
}
