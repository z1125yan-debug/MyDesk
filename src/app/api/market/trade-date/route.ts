// 最近交易日（行情源日历真值）· 只读接口
//
// 为什么单独一个接口：前端需要把两个不同口径的日期分开摆，不能混着说。
//   · 复盘统计种子有自己的覆盖终点（range.to，当前止于 2026-09-24，回答的是"数据到哪一天"）；
//   · 这里的 tradeDate 是行情源给的"最近交易日"（回答"日历走到哪一天"，会跟着往前走）。
// 两者一致时才能说"按最新交易日归档"；种子落后时必须改口说"数据止于 X"，
// 不能拿一个冻结的覆盖终点冒充实时日历 —— 这是 P63 修的那处口径谎报。
//
// 200ms 级成本：数据层自带 cached("kline", …) 的 TTL 缓存，这里再叠一层 60s 服务端缓存。
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { resolveTradeDate } from "@/lib/desk/trade-date";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return ttlCache("market/trade-date", 60_000, getHandler);
}

async function getHandler() {
  const today = shanghaiDate();
  const info = await resolveTradeDate().catch(() => null);
  const tradeDate = info?.date ?? today;
  return NextResponse.json({
    market: "A", market_label: "A股",
    ok: true,
    today,
    tradeDate,
    isTradingToday: tradeDate === today,
    // 日期来自行情源还是本地日历算的：false 时前端不说"最新交易日"，只说"按工作日推算"
    fromMarketData: info?.fromMarketData ?? false,
    source: info?.source ?? "unknown",
  });
}
