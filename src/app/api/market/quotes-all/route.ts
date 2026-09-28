// 全市场实时快照 API（P3：接入 stock-sdk batch.cn）
// 作为 emProvider 快照的第三条兜底通道：当东财+腾讯双挂时仍可返回 3000+ A 股行情。
// 契约：走本机 stock-sdk（TickFlow 已适配的第三方回退）；不冒充。
import { NextResponse } from "next/server";
import { fetchQuotesSdkAll, fetchQuotesSdk } from "@/lib/desk/stock-sdk";
import { shanghaiStamp } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(request: Request) {
  const url = new URL(request.url);
  // 单只或多只
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (symbol) {
    const result = await fetchQuotesSdk([symbol]);
    if (result.size === 0) {
      return NextResponse.json({ ok: false, error: "stock-sdk 未返回该股票快照" });
    }
    return NextResponse.json({
      ok: true,
      symbol,
      data: result.get(symbol)!,
    }, { headers: { "Cache-Control": "no-store, max-age=10" } });
  }
  // 全市场
  const market = (url.searchParams.get("market") ?? "").toLowerCase();
  const valid = ["sh", "sz", "bj", "kc", "cy"] as const;
  const marketArg = valid.includes(market as typeof valid[number]) ? market as typeof valid[number] : undefined;
  const result = await fetchQuotesSdkAll({ market: marketArg, concurrency: 7, batchSize: 500 });
  if (result.count === 0) {
    return NextResponse.json({ ok: false, error: "stock-sdk batch.cn 未返回数据（上游故障）", source: result.source });
  }
  return NextResponse.json({
    ok: true,
    source: result.source,
    count: result.count,
    // 这是取数完成时刻（快照是实时口径）：用北京时间，原来 toISOString() 是 UTC，差 8 小时
    as_of: shanghaiStamp(),
    // 只返回关键指标；全量字段太重
    data: result.data.map((d) => ({
      symbol: d.symbol, code: d.code, name: d.name,
      price: d.price, changePct: d.changePct,
      amountYi: d.amountYi, turnoverRate: d.turnoverRate,
      peTtm: d.peTtm, pb: d.pb,
      totalMarketCapYi: d.totalMarketCapYi,
      limitUp: d.limitUp, limitDown: d.limitDown,
    })),
  }, { headers: { "Cache-Control": "no-store, max-age=15" } });
}
