// GET /api/market/depth — 个股五档盘口（通达信网关 eltdx，quotes.get_depth）。
// 买1~买5 / 卖1~卖5 + 内外盘/现手。网关未开时返回 depth:null，页面如实说「暂不可用」，不造数。
import { NextResponse } from "next/server";
import { tdxDepth } from "@/lib/desk/tdx";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol")?.trim() ?? "";
  if (!symbol) return NextResponse.json({ market: "A", market_label: "A股", depth: null });
  try {
    const depth = (await tdxDepth([symbol]).catch(() => null))?.get(symbol) ?? null;
    return NextResponse.json({ market: "A", market_label: "A股", depth, source: depth ? "tdx" : null });
  } catch {
    return NextResponse.json({
      market: "A", market_label: "A股",
      depth: null,
      error: "五档盘口暂不可用：本机 eltdx 行情网关（127.0.0.1:8756）未开启，或当前网关版本不带五档（quotes.get_depth）能力。启动方式：eltdx-http --host 127.0.0.1 --port 8756；启动后本提示自动消失，不造数",
    });
  }
}
