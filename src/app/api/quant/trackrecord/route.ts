// GET /api/quant/trackrecord —— 战绩页数据源（P36-C）
//
// 回答一个问题：**跟着推荐走，到底赚没赚**。所以只报已经发生的、可逐条对账的事实：
//   - 哪天推的、什么档位、哪条策略、推了哪几只票
//   - 每只票第二天开盘买第三天开盘卖、扣掉手续费之后的净收益（买不进的剔除并写明原因）
//   - 同期「全A中位个股」的净收益作及格线
//
// 纪律：
// - 没到天数就如实说没到（enough=false），不许拿回测数字凑；
// - 一个数字都不能是「预测」，全是已经走完的行情算出来的；
// - 明细给到票级，用户能拿日期+代码去自己的行情软件里逐条对。

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { navSeriesOf, parseSymbols } from "@/lib/quant/strategy/pick-fill-core.ts";
import { roundTripDragOf } from "@/lib/quant/backtest/event-core.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 任务书定 20 个交易日才算数（少于这个数，胜率的置信区间宽到没意义） */
const TARGET_DAYS = 20;

interface PickRow {
  id: string;
  tradeDate: string;
  regime: string;
  strategyName: string;
  source: string;
  symbols: string | null;
  symbolsNote: string | null;
  nextDaySymWin: number | null;
  nextDaySymUp: number | null;
  nextDaySymCount: number | null;
  nextDaySymSkip: number | null;
  nextDayBenchNet: number | null;
  nextDayBasis: string | null;
  nextDaySymDetail: string | null;
  symBackfilledAt: Date | null;
}

function detailOf(json: string | null): { symbol: string; net: number | null; reason: string | null }[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        symbol: String(o.symbol ?? ""),
        net: typeof o.net === "number" && Number.isFinite(o.net) ? o.net : null,
        reason: typeof o.reason === "string" ? o.reason : null,
      };
    });
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const rows = (await db.strategyPick.findMany({
      orderBy: { tradeDate: "asc" },
      select: {
        id: true, tradeDate: true, regime: true, strategyName: true, source: true,
        symbols: true, symbolsNote: true, nextDaySymWin: true, nextDaySymUp: true,
        nextDaySymCount: true, nextDaySymSkip: true, nextDayBenchNet: true,
        nextDayBasis: true, nextDaySymDetail: true, symBackfilledAt: true,
      },
    })) as PickRow[];

    // ---- 汇总 ----
    const withSymbols = rows.filter((r) => parseSymbols(r.symbols).length > 0);
    const filled = rows.filter((r) => r.symBackfilledAt && r.nextDaySymWin != null);
    const symCount = filled.reduce((a, r) => a + (r.nextDaySymCount ?? 0), 0);
    const symUp = filled.reduce((a, r) => a + (r.nextDaySymUp ?? 0), 0);
    // 按票加权：每天推的票数量不一样，直接对「每天的平均」再平均会偏
    const weightedNet = filled.reduce((a, r) => a + (r.nextDaySymWin ?? 0) * (r.nextDaySymCount ?? 0), 0);
    const avgNet = symCount ? weightedNet / symCount : null;
    const benchs = filled.map((r) => r.nextDayBenchNet).filter((x): x is number => x != null && Number.isFinite(x));
    const benchAvg = benchs.length ? benchs.reduce((a, b) => a + b, 0) / benchs.length : null;

    // 按日聚合成净值曲线（同日多行等权）
    const byDate = new Map<string, { nets: number[]; benches: number[] }>();
    for (const r of filled) {
      const cur = byDate.get(r.tradeDate) ?? { nets: [], benches: [] };
      if (r.nextDaySymWin != null) cur.nets.push(r.nextDaySymWin);
      if (r.nextDayBenchNet != null && Number.isFinite(r.nextDayBenchNet)) cur.benches.push(r.nextDayBenchNet);
      byDate.set(r.tradeDate, cur);
    }
    const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const nav = navSeriesOf(
      days.map(([d, v]) => ({
        tradeDate: d,
        net: v.nets.length ? v.nets.reduce((a, b) => a + b, 0) / v.nets.length : null,
        bench: v.benches.length ? v.benches.reduce((a, b) => a + b, 0) / v.benches.length : null,
      })),
    );

    const pending = rows
      .filter((r) => !r.symBackfilledAt)
      .slice(0, 20)
      .map((r) => ({
        tradeDate: r.tradeDate,
        strategyName: r.strategyName,
        reason: parseSymbols(r.symbols).length
          ? "后面两个交易日还没走完，走完自动补"
          : (r.symbolsNote ?? "当时没记具体票，补不出来"),
      }));

    const last = nav[nav.length - 1];
    return NextResponse.json({
      ok: true,
      as_of: new Date().toISOString(),
      summary: {
        rows: rows.length,
        withSymbols: withSymbols.length,
        filled: filled.length,
        pending: rows.length - filled.length,
        days: days.length,
        targetDays: TARGET_DAYS,
        enough: days.length >= TARGET_DAYS,
        symCount,
        symUp,
        symWinPct: symCount ? (symUp / symCount) * 100 : null,
        avgNet,
        benchAvgNet: benchAvg,
        navNow: last?.nav ?? null,
        benchNavNow: last?.benchNav ?? null,
        costPct: Math.round(roundTripDragOf() * 10000) / 100,
        basis:
          "第二天开盘价买入、第三天开盘价卖出，已扣手续费印花税滑点；第二天一字涨停或停牌的票剔除不算；" +
          "及格线是同一天全A个股的中位收益。全是已经走完的行情，不是预测。",
      },
      nav,
      pending,
      rows: rows
        .slice()
        .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || a.id.localeCompare(b.id))
        .slice(0, 120)
        .map((r) => ({
          tradeDate: r.tradeDate,
          regime: r.regime,
          strategyName: r.strategyName,
          source: r.source,
          symbols: parseSymbols(r.symbols).map((s) => s.symbol),
          symbolsNote: r.symbolsNote,
          filled: !!r.symBackfilledAt,
          win: r.nextDaySymWin,
          up: r.nextDaySymUp,
          count: r.nextDaySymCount,
          skipped: r.nextDaySymSkip,
          bench: r.nextDayBenchNet,
          basis: r.nextDayBasis,
          detail: detailOf(r.nextDaySymDetail),
        })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `战绩读取失败：${(e as Error).message}` },
      { status: 500 },
    );
  }
}
