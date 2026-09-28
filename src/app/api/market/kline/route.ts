import { NextResponse } from "next/server";
import { fetchKlinesReal } from "@/lib/desk/em";
import { macdCalc } from "@/lib/quant/factors/fields";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  const tf = url.searchParams.get("tf")?.trim() ?? "日线";
  // 复权口径：qfq 前复权（默认）/ hfq 后复权 / none 不复权
  const fqRaw = url.searchParams.get("fq")?.trim() ?? "qfq";
  const fq = fqRaw === "hfq" || fqRaw === "none" ? fqRaw : "qfq";
  if (!symbol) return NextResponse.json({ candles: null });
  try {
    const candles = await fetchKlinesReal(symbol, tf, 160, fq);
    // MACD 副图数据：复用项目唯一一份 macdCalc（DIF=EMA12−EMA26 / DEA=EMA(DIF,9) / 柱=2×(DIF−DEA)），
    // 服务端算好随 K 线一起返回，前端不重造指标。
    const macd = candles && candles.length ? macdCalc(candles.map((c) => c.c)) : null;
    return NextResponse.json({ candles, fq, macd });
  } catch {
    return NextResponse.json({ candles: null, error: "数据源暂不可用" });
  }
}
