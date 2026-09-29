// 全市场因子预热（异步任务版）：?kick=1 触发后台计算（全A K线因子 → factor_cache），
// 无参查询进度（cached 行数 / 口径 / 生成时刻）。预热完成后 /api/quant/screener 命中缓存即秒出全市场。
//
// 2026-09-29 用户指示：「量化因子选股确保每天点击之后有缓存；如果当天开盘能刷新出来，
// 那么收盘后需要再刷新一下，防止定在盘中」。
// 于是本路由多了一件事：**记住这份缓存是什么口径取的**（盘中 / 收盘），并提供 ?ensure=1
// 给页面自动调用——当天没缓存 → 自动预热；缓存是盘中那份、现在已经收盘 → 自动重算一遍。
import { NextResponse } from "next/server";
import { runScreener } from "@/lib/quant/screener/run";
import {
  saveFactorCache, factorCacheWarm, ensureFactorCacheTable, latestFactorCacheMeta, factorCacheMeta,
} from "@/lib/quant/screener/factor-cache";
import { decideRewarm, warmPhaseOf, warmPhaseLabel, type WarmPhase } from "@/lib/quant/screener/warm-phase-core";
import { marketSession } from "@/lib/desk/session";
import { factorCatalog } from "@/lib/quant/factors/fields";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function shanghaiDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

let warming = false;
let warmNote = "idle";
/** 本次预热的目标口径（供查询端如实回报「现在这份是什么口径」） */
let warmPhase: WarmPhase | null = null;
let warmKickedBy: "manual" | "ensure" | "ensure_close_refresh" | null = null;

async function countCache(tradeDate: string): Promise<number> {
  await ensureFactorCacheTable();
  const rows = await db.$queryRawUnsafe<{ n: number | bigint }[]>(`SELECT COUNT(*) as n FROM factor_cache WHERE trade_date = ?`, tradeDate);
  // SQLite 的 COUNT(*) 经 prisma raw 回来可能是 BigInt，直接进 JSON 会抛
  // "Do not know how to serialize a BigInt"（实测 500）。统一转 Number。
  const n = rows[0]?.n ?? 0;
  return typeof n === "bigint" ? Number(n) : n;
}

async function runWarm(kickedBy: "manual" | "ensure" | "ensure_close_refresh"): Promise<void> {
  warming = true; warmNote = "starting"; warmKickedBy = kickedBy;
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
    // 说明文案复用引擎给的 quote_lag（按交易日历+时段判定），本路由不再自己喊「休市」。
    const cacheDate = res.quote_date ?? res.as_of_trade_date;
    // 口径：数据属于上一交易日（就是那天的收盘值）/ 今天已收盘 → closed；今天盘中 → intraday
    const phase = warmPhaseOf({
      quoteDate: cacheDate, asOf: res.as_of_trade_date,
      sessionPhase: marketSession().phase,
    });
    warmPhase = phase;
    await saveFactorCache(cacheDate, rows, phase);
    const lag = res.quote_lag?.lagging ? `（${res.quote_lag.badge}）` : "";
    warmNote = `saved ${rows.length} @ ${cacheDate} · ${warmPhaseLabel(phase, new Date().toISOString())}${lag}`;
  } catch (e) {
    warmNote = `error: ${String((e as Error).message || e)}`;
  } finally {
    warming = false;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const today = shanghaiDateStr(new Date());
  const ensure = url.searchParams.get("ensure") === "1";
  if (url.searchParams.get("kick") === "1" || ensure) {
    if (warming) {
      return NextResponse.json({
        ok: true, warming: true, started: false, kicked: false,
        phase: warmPhase, note: warmNote, kickedBy: warmKickedBy,
      });
    }
    // ?ensure=1：只在「确实需要」时才动——当天没有缓存，或手上这份是盘中口径而现在已经收盘。
    // 页面进来自动调它，于是「每天点开就有缓存」+「收盘后自动换掉盘中那份」都不用人管。
    if (ensure) {
      const meta = await latestFactorCacheMeta();
      const want = {
        date: meta?.trade_date ?? today,
        phase: warmPhaseOf({ quoteDate: today, asOf: today, sessionPhase: marketSession().phase }),
      };
      const d = decideRewarm(meta, want);
      if (!d.rewarm) {
        const cached = await countCache(meta!.trade_date);
        return NextResponse.json({
          ok: true, warming: false, started: false, kicked: false, cached,
          trade_date: meta!.trade_date, phase: meta!.phase,
          phase_label: warmPhaseLabel(meta!.phase, meta!.generated_at),
          generated_at: meta!.generated_at, reason: d.reason, note: warmNote,
        });
      }
      const kickedBy = d.reason === "stale_intraday" ? "ensure_close_refresh" : "ensure";
      void runWarm(kickedBy);
      return NextResponse.json({
        ok: true, warming: true, started: true, kicked: true, kickedBy,
        trade_date: meta?.trade_date ?? null, phase: meta?.phase ?? null, reason: d.reason, note: warmNote,
      });
    }
    void runWarm("manual");
    return NextResponse.json({ ok: true, started: true, kicked: true, kickedBy: "manual" });
  }
  const cached = await countCache(today);
  const warm = await factorCacheWarm(today);
  const meta = (await factorCacheMeta(today)) ?? (await latestFactorCacheMeta());
  return NextResponse.json({
    ok: true, warming, trade_date: today, cached, warm, note: warmNote,
    meta, phase: meta?.phase ?? warmPhase,
    phase_label: meta ? warmPhaseLabel(meta.phase, meta.generated_at) : null,
    kickedBy: warmKickedBy,
  });
}
