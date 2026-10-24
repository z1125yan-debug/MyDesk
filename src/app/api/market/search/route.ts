import { NextResponse } from "next/server";
import { searchReal } from "@/lib/desk/em";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ market: "A", market_label: "A股", items: [] });
  try {
    return NextResponse.json({ market: "A", market_label: "A股", items: await searchReal(q) });
  } catch {
    return NextResponse.json({ market: "A", market_label: "A股", items: [], error: "数据源暂不可用" });
  }
}
