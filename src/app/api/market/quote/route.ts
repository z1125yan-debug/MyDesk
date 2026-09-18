import { NextResponse } from "next/server";
import { fetchQuotesReal, fetchSparkReal } from "@/lib/desk/em";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const symbols = (new URL(req.url).searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (!symbols.length) return NextResponse.json({ quotes: [] });
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
    return NextResponse.json({ quotes: withSpark });
  } catch {
    return NextResponse.json({ quotes: symbols.map(() => null), error: "数据源暂不可用" });
  }
}
