// 全市场因子预热（异步任务版）：?kick=1 触发后台计算（全A K线因子 → factor_cache），
// 无参查询进度（cached 行数）。预热完成后 /api/quant/screener 命中缓存即秒出全市场。
import { NextResponse } from "next/server";
import { runScreener } from "@/lib/quant/screener/run";
import { saveFactorCache, factorCacheWarm, ensureFactorCacheTable } from "@/lib/quant/screener/factor-cache";
import { factorCatalog } from "@/lib/quant/factors/fields";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function shanghaiDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

let warming = false;
let warmNote = "idle";

async function countCache(tradeDate: string): Promise<number> {
  await ensureFactorCacheTable();
  const rows = await db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) as n FROM factor_cache WHERE trade_date = ?`, tradeDate);
  // SQLite 的 COUNT(*) 经 prisma raw 回来可能是 BigInt，直接进 JSON 会抛
  // "Do not know how to serialize a BigInt"（实测 500）。统一转 Number。
  const n = rows[0]?.n ?? 0;
  return typeof n === "bigint" ? Number(n) : n;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const today = shanghaiDateStr(new Date());
  if (url.searchParams.get("kick") === "1") {
    if (warming) return NextResponse.json({ ok: true, warming: true, note: warmNote });
    warming = true; warmNote = "starting";
    void (async () => {
      try {
        const allFields = factorCatalog().fields.filter((f) => f.implemented !== false).map((f) => f.key);
        const res = await runScreener({
          universe: "all_a",
          conditions: [],
          fields: allFields,
          maxKlineSymbols: 6000,
          pagination: { limit: 6000 },
          // 预热必须重算：缓存里的 kline_pattern / trend_pressure_60 是展示列，
          // 若走缓存命中分支就会把旧值原样写回，口径修正永远生效不了。
          bypass_cache: true,
        });
        const rows = res.list.map((r) => ({
          symbol: r.symbol, name: r.name, industry: r.industry ?? null, values: r.values,
          kline_pattern: r.kline_pattern ?? null, trend_pressure_60: r.trend_pressure_60 ?? null,
        }));
        // 缓存按**数据实际所属交易日**归档：休市日 as_of_trade_date 仍是系统日期，
        // 若用它做 key，会把上一交易日的行情存成今天，之后按今天查缓存就会拿到旧数据。
        const cacheDate = res.quote_date ?? res.as_of_trade_date;
        await saveFactorCache(cacheDate, rows);
        warmNote = `saved ${rows.length} @ ${cacheDate}${cacheDate !== res.as_of_trade_date ? `（行情源日期，当日 ${res.as_of_trade_date} 休市）` : ""}`;
      } catch (e) {
        warmNote = `error: ${String((e as Error).message || e)}`;
      } finally {
        warming = false;
      }
    })();
    return NextResponse.json({ ok: true, started: true });
  }
  const cached = await countCache(today);
  const warm = await factorCacheWarm(today);
  return NextResponse.json({ ok: true, warming, trade_date: today, cached, warm, note: warmNote });
}
