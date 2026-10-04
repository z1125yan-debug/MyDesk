// Quant Research Lab — 数据探测：K线样本（严格 asOf 截断，绝不返回未来数据）
import { NextResponse } from "next/server";
import { shanghaiDate } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import type { Timeframe } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

const TFS: Timeframe[] = ["day", "m1", "m5", "m15", "m30", "m60"];

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "000001.SH";
  const tf = (url.searchParams.get("tf") ?? "day") as Timeframe;
  const asOf = url.searchParams.get("asOf") ?? shanghaiDate();
  const lookback = Math.min(500, parseInt(url.searchParams.get("lookback") ?? "30", 10) || 30);
  const source = url.searchParams.get("source") ?? "em";

  if (!TFS.includes(tf)) {
    return NextResponse.json({ error: `非法周期：${tf}` }, { status: 400 });
  }
  try {
    const provider = await getProvider(source);
    const bars = await provider.getBars({ symbols: [symbol], tf, asOf, lookback });
    const rows = bars.get(symbol) ?? [];
    return NextResponse.json({
      symbol, tf, asOf, source,
      count: rows.length,
      first: rows[0]?.date ?? null,
      last: rows[rows.length - 1]?.date ?? null,
      coverage: provider.coverage(),
      bars: rows,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
