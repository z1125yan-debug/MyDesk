import { NextResponse } from "next/server";
import { fetchQuotesReal, fetchSparkReal } from "@/lib/desk/em";
// 市场分流：本接口仅 A 股。港股/美股符号（00700/NVDA）直接 400 指路，不进东财/TDX 的 A 股库。
import { classifySymbol } from "@/lib/desk/market-kind";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (!symbols.length) return NextResponse.json({ market: "A", market_label: "A股", quotes: [] });
  const nonA = symbols.filter((s) => {
    const m = classifySymbol(s);
    return m === "HK" || m === "US";
  });
  if (nonA.length) {
    return NextResponse.json(
      { market: classifySymbol(nonA[0]), market_label: classifySymbol(nonA[0]) === "HK" ? "港股" : "美股", error: `本接口仅 A 股；${nonA.join("、")} 属港股/美股，请用 /api/market/hk-us（报价）或 /api/market/hk-us/kline（日 K）`, quotes: [] },
      { status: 400 },
    );
  }
  try {
    const quotes = await fetchQuotesReal(symbols);
    // 附带日内分时缩略序列（逐个失败可容忍）
    const withSpark = await Promise.all(
      quotes.map(async (q) => {
        if (!q) return null;
        const spark = await fetchSparkReal(q.symbol).catch(() => null);
        return { ...q, spark: spark ?? null };
      }),
    );
    return NextResponse.json({ market: "A", market_label: "A股", quotes: withSpark });
  } catch {
    return NextResponse.json({ market: "A", market_label: "A股", quotes: symbols.map(() => null), error: "数据源暂不可用" });
  }
}
