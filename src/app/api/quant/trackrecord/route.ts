// GET /api/quant/trackrecord —— 战绩页数据源（P36-C）
//
// 回答一个问题：**跟着推荐走，到底赚没赚**。所以只报已经发生的、可逐条对账的事实：
//   - 哪天推的、什么档位、哪条策略、推了哪几只票
//   - 每只票第二天开盘买第三天开盘卖、扣掉手续费之后的净收益（买不进的剔除并写明原因）
//   - 同期「全A中位个股」的净收益作及格线
//
// P39 / #75 两层漏斗：战绩按「来源层」拆开报，不混在一起——
//   - 策略选股层（layer1）：StrategyPick source ∈ {gate, regime}，被稀释的「平均」；
//   - AI优选层（layer2）：StrategyPick source = "ai_pick"，从 layer1 候选里收窄出的聚焦子集。
//   每层独立给汇总 / 净值 / 明细；AI优选层当天没有行时据实说「未运行」，不拿 layer1 的数字冒充。
//
// 纪律：
// - 没到天数就如实说没到（enough=false），不许拿回测数字凑；
// - 一个数字都不能是「预测」，全是已经走完的行情算出来的；
// - 明细给到票级，用户能拿日期+代码去自己的行情软件里逐条对。

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { navSeriesOf, parseSymbols } from "@/lib/quant/strategy/pick-fill-core.ts";
import { roundTripDragOf } from "@/lib/quant/backtest/event-core.ts";
import { getServerLlm } from "@/lib/llm/model-config";
import { AI_PICK_SOURCE } from "@/lib/quant/strategy/ai-pick-core.ts";

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

/** 某一层（策略选股 / AI优选）的聚合：汇总 + 净值 + 待回填 + 明细。零依赖，纯算术。 */
function aggregateLayer(rows: PickRow[]) {
  const withSymbols = rows.filter((r) => parseSymbols(r.symbols).length > 0);
  const filled = rows.filter((r) => r.symBackfilledAt && r.nextDaySymWin != null);
  const symCount = filled.reduce((a, r) => a + (r.nextDaySymCount ?? 0), 0);
  const symUp = filled.reduce((a, r) => a + (r.nextDaySymUp ?? 0), 0);
  const weightedNet = filled.reduce((a, r) => a + (r.nextDaySymWin ?? 0) * (r.nextDaySymCount ?? 0), 0);
  const avgNet = symCount ? weightedNet / symCount : null;
  const benchs = filled.map((r) => r.nextDayBenchNet).filter((x): x is number => x != null && Number.isFinite(x));
  const benchAvg = benchs.length ? benchs.reduce((a, b) => a + b, 0) / benchs.length : null;

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
  return {
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
  };
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

    // 分层
    const layer1Rows = rows.filter((r) => r.source !== AI_PICK_SOURCE);
    const layer2Rows = rows.filter((r) => r.source === AI_PICK_SOURCE);
    const strategy = aggregateLayer(layer1Rows);
    const aiPick = aggregateLayer(layer2Rows);

    // AI优选层「当天没有行」的诚实状态：配了通道但还没生成 = empty；没配通道 = not_configured（没法自动跑）
    const aiPickStatus: "ok" | "empty" | "not_configured" =
      layer2Rows.length > 0 ? "ok"
        : getServerLlm().available ? "empty" : "not_configured";

    return NextResponse.json({
      ok: true,
      as_of: new Date().toISOString(),
      // 顶层保持「全部层合并」老形状，向后兼容其他可能读 summary/nav/pending/rows 的消费方
      summary: strategy.summary,
      nav: strategy.nav,
      pending: strategy.pending,
      rows: strategy.rows,
      // P39 / #75：按层拆开
      layers: {
        strategy: { ...strategy, status: "ok" as const },
        aiPick: { ...aiPick, status: aiPickStatus },
      },
      aiPickStatus,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `战绩读取失败：${(e as Error).message}` },
      { status: 500 },
    );
  }
}
