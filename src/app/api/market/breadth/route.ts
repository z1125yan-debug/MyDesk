// 逐日宽度统计 API（P15-R2b）：读 stock_daily_close 的沉淀行，交给纯核 breadth-core 算序列。
// 只算不存：沉淀发生在收盘后调度器（kind=breadth）；这里回答的是「攒到哪天、攒了几天、数是多少」。
// 缺就是缺：没有行返回空序列 + 明说的 missing，不拿指数或快照猜个股历史。
// 历史从哪来（P15-R19）：2026-04-20~09-24 这 110 个交易日的逐票收盘价是用真实日K回填的
// （新浪 getKLineData，不复权原始价，见 /api/market/breadth/backfill），当日之后的行由收盘后调度器自产。
// 回填只补库里没有的键，绝不覆盖自产行——所以这一条序列的算法从头到尾只有一套。
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { db } from "@/lib/db";
import { computeBreadthSeries, storedTradingDays, BREADTH_CALIBER, type StockBar } from "@/lib/quant/screener/breadth-core";
import { addBeijingDays } from "@/lib/quant/scheduler/rules";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";

export const dynamic = "force-dynamic";

// 这张表 2026-09-28 回填后已有 60 万+ 行，本接口一次要扫 20 多万行、算 3~8 秒（30 秒默认 TTL 等于盘中每轮都重算）。
// 逐票收盘价一天只变一次（收盘后调度器落库），所以这里按「日更数据」给缓存：10 分钟内直接用上一次算完的结果。
export const BREADTH_TTL_MS = 10 * 60_000;

export async function GET(req: Request) {
  return ttlCache(`market/breadth?${new URL(req.url).search}`, BREADTH_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  const u = new URL(req.url);
  const raw = Number.parseInt(u.searchParams.get("days") ?? "90", 10);
  const days = Number.isFinite(raw) ? Math.min(250, Math.max(5, raw)) : 90; // 脏输入不设野值：回落默认 90
  const today = shanghaiDate();
  // 交易日→日历日粗略 0.6 上浮，再垫 10 天给序列首行的前 4 根窗口用
  const from = addBeijingDays(today, -(Math.ceil(days * 1.6) + 10));
  try {
    const rows = await db.stockDailyClose.findMany({
      where: { tradeDate: { gte: from, lte: today } },
      select: { symbol: true, tradeDate: true, close: true },
    });
    const bars: StockBar[] = rows.map((r) => ({ symbol: r.symbol, date: r.tradeDate, close: r.close }));
    const series = computeBreadthSeries(bars);
    const stored = storedTradingDays(bars);
    const latest = series.length ? series[series.length - 1] : null;

    const missing: string[] = [];
    if (!series.length) {
      missing.push("stock_daily_close 一行都没有：先跑历史回填（POST /api/market/breadth/backfill，真实日K），当日之后的行等收盘后调度器（kind=breadth，北京 15:05 后）自产");
    } else if (stored < 5) {
      missing.push(`目前只沉淀了 ${stored} 个交易日；站上5日线占比与创5日新低要满 5 天才出数（创3日新低满 3 天）——前几日留空是事实，不是漏算`);
    }

    return NextResponse.json({
      ok: true,
      as_of: shanghaiStamp(),
      window: { from, to: today },
      days_requested: days,
      stored_trading_days: stored,
      needed_days: 5,
      latest,
      series: series.slice(-days),
      caliber: BREADTH_CALIBER,
      missing,
      source: "stock_daily_close（历史 110 个交易日由真实日K回填、当日之后由收盘后调度器自产；(symbol,tradeDate) 唯一键不重写）",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `宽度统计计算失败：${(e as Error).message}` }, { status: 500 });
  }
}
