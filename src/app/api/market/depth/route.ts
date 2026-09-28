// GET /api/market/depth — 个股五档盘口（通达信网关 eltdx，quotes.get_depth）。
// 买1~买5 / 卖1~卖5 + 内外盘/现手。网关未开时返回 depth:null，页面如实说「暂不可用」，不造数。
import { NextResponse } from "next/server";
import { tdxDepth } from "@/lib/desk/tdx";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol")?.trim() ?? "";
  if (!symbol) return NextResponse.json({ depth: null });
  try {
    const depth = (await tdxDepth([symbol]).catch(() => null))?.get(symbol) ?? null;
    return NextResponse.json({ depth, source: depth ? "tdx" : null });
  } catch {
    return NextResponse.json({ depth: null, error: "五档盘口暂不可用（本机通达信行情网关未开启）" });
  }
}
