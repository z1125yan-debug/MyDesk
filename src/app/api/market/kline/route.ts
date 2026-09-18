import { NextResponse } from "next/server";
import { fetchKlinesReal } from "@/lib/desk/em";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  const tf = url.searchParams.get("tf")?.trim() ?? "日线";
  if (!symbol) return NextResponse.json({ candles: null });
  try {
    const candles = await fetchKlinesReal(symbol, tf);
    return NextResponse.json({ candles });
  } catch {
    return NextResponse.json({ candles: null, error: "数据源暂不可用" });
  }
}
