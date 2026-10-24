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
  // 市场分流：本接口仅 A 股。带 market=HK/US 直接 400 指路，不拿 A 股选股算港股/美股。
  const reqMarket = String((body as { market?: unknown }).market ?? "").trim().toUpperCase();
  if (reqMarket === "HK" || reqMarket === "US") {
    return NextResponse.json(
      { error: `本接口仅 A 股选股；${reqMarket} 选股请用 POST /api/market/hk-us/screener（同款五件套，数据用${reqMarket === "HK" ? "港股" : "美股"}自己的）`, market: reqMarket },
      { status: 400 },
    );
  }
  try {
    const data = await runScreener(body);
    return NextResponse.json({ ...data, market: "A", market_label: "A股", });
  } catch (e) {
    return NextResponse.json({ error: `选股失败：${(e as Error).message}` }, { status: 502 });
  }
}
