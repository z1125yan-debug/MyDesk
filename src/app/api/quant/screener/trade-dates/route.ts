// GET /api/quant/screener/trade-dates — 真实交易日列表（§二 历史交易日选择器数据源）
// 口径：上证指数（000001.SH）日线实际存在的交易日，倒序返回；不生成日历、不补假日期。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const count = Math.max(20, Math.min(500, Number(url.searchParams.get("count") ?? 120)));
  try {
    const asOf = shanghaiDate();
    const barsMap = await fetchBarsHybrid(["000001.SH"], asOf, Math.ceil(count * 1.6));
    const bars = barsMap.get("000001.SH") ?? [];
    const dates = bars.map((b) => b.date).filter(Boolean).sort().reverse().slice(0, count);
    if (!dates.length) {
      return NextResponse.json({ ok: false, error: "交易日列表获取失败：指数K线无返回（数据源不可用）" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, as_of_trade_date: asOf, dates });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
