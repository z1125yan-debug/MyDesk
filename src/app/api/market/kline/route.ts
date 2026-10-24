import { NextResponse } from "next/server";
import { fetchKlinesReal } from "@/lib/desk/em";
import { macdCalc } from "@/lib/quant/factors/fields";
// 市场分流：本接口仅 A 股。港股/美股符号直接 400 指路，不进东财/TDX 的 A 股库。
import { classifySymbol } from "@/lib/desk/market-kind";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  const tf = url.searchParams.get("tf")?.trim() ?? "日线";
  // 复权口径：qfq 前复权（默认）/ hfq 后复权 / none 不复权
  const fqRaw = url.searchParams.get("fq")?.trim() ?? "qfq";
  const fq = fqRaw === "hfq" || fqRaw === "none" ? fqRaw : "qfq";
  if (!symbol) return NextResponse.json({ market: "A", market_label: "A股", candles: null });
  const symMarket = classifySymbol(symbol);
  if (symMarket === "HK" || symMarket === "US") {
    return NextResponse.json(
      { market: symMarket, market_label: symMarket === "HK" ? "港股" : "美股", error: `本接口仅 A 股；${symbol} 属${symMarket === "HK" ? "港股" : "美股"}，请用 /api/market/hk-us/kline?market=${symMarket}&symbol=${encodeURIComponent(symbol)}`, candles: null },
      { status: 400 },
    );
  }
  try {
    const candles = await fetchKlinesReal(symbol, tf, 160, fq);
    // MACD 副图数据：复用项目唯一一份 macdCalc（DIF=EMA12−EMA26 / DEA=EMA(DIF,9) / 柱=2×(DIF−DEA)），
    // 服务端算好随 K 线一起返回，前端不重造指标。
    const macd = candles && candles.length ? macdCalc(candles.map((c) => c.c)) : null;
    return NextResponse.json({ market: "A", market_label: "A股", candles, fq, macd });
  } catch {
    return NextResponse.json({ market: "A", market_label: "A股", candles: null, error: "数据源暂不可用" });
  }
}
