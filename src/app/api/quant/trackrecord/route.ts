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
import { navSeriesOf, parseSymbols, type NavPoint } from "@/lib/quant/strategy/pick-fill-core.ts";
import { roundTripDragOf } from "@/lib/quant/backtest/event-core.ts";
import { getServerLlm } from "@/lib/llm/model-config";
import { AI_PICK_SOURCE } from "@/lib/quant/strategy/ai-pick-core.ts";
import { SHADOW_SOURCE, SHADOW_HOLD_DAYS, shadowNavSeriesOf, type HorizonStat } from "@/lib/quant/strategy/shadow-core.ts";

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
  h1Stat: string | null;
  h5Stat: string | null;
  h20Stat: string | null;
  shadowDetail: string | null;
}

function statOf(json: string | null): HorizonStat | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as HorizonStat;
    return typeof o?.mean === "number" && Number.isFinite(o.mean) ? o : null;
  } catch { return null; }
}

function shadowDetailOf(json: string | null): { symbol: string; net1: number | null; net5: number | null; net20: number | null }[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return raw.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { symbol: String(o.symbol ?? ""), net1: num(o.net1), net5: num(o.net5), net20: num(o.net20) };
    }).filter((s) => s.symbol);
  } catch { return []; }
}

function shadowSymbolsOf(json: string | null): { symbol: string; name: string; close: number | null; ret20: number | null; devMa20: number | null }[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        symbol: String(o.symbol ?? ""),
        name: typeof o.name === "string" ? o.name : "",
        close: typeof o.close === "number" ? o.close : null,
        ret20: typeof o.ret20 === "number" ? o.ret20 : null,
        devMa20: typeof o.devMa20 === "number" ? o.devMa20 : null,
      };
    }).filter((s) => s.symbol);
  } catch { return []; }
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

/** 影子层聚合：与正式版同表不同口径——收盘买、持有 1/5/20 日三档回填，主考核 h20。
 *  净值 = 1/20 滚动口径（每份占组合 1/20，到期结算），只由已到期份构成，不预支未到期收益。 */
async function aggregateShadow(rows: PickRow[]) {
  const sorted = rows.slice().sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  // 剩余天数：信号日之后已沉淀的交易日数（数日历，不猜日期）
  let settledAfter = new Map<string, number>();
  if (sorted.length) {
    const dates = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
      `SELECT tradeDate FROM stock_daily_bar WHERE adjust = 'qfq' AND tradeDate >= ?
       GROUP BY tradeDate HAVING COUNT(*) >= 1000 ORDER BY tradeDate ASC`,
      sorted[0].tradeDate,
    );
    const list = dates.map((d) => d.tradeDate);
    settledAfter = new Map(sorted.map((r) => [r.tradeDate, list.filter((d) => d > r.tradeDate).length]));
  }
  const outRows = sorted.slice().reverse().map((r) => {
    const after = settledAfter.get(r.tradeDate) ?? 0;
    return {
      tradeDate: r.tradeDate,
      regime: r.regime,
      strategyName: r.strategyName,
      symbols: shadowSymbolsOf(r.symbols),
      symbolsNote: r.symbolsNote,
      h1: statOf(r.h1Stat),
      h5: statOf(r.h5Stat),
      h20: statOf(r.h20Stat),
      detail: shadowDetailOf(r.shadowDetail),
      remainingDays: Math.max(0, SHADOW_HOLD_DAYS - after),
    };
  });
  const filled = (key: "h1Stat" | "h5Stat" | "h20Stat") =>
    sorted.map((r) => statOf(r[key])).filter((s): s is HorizonStat => s != null);
  const avgMean = (ss: HorizonStat[]) => (ss.length ? ss.reduce((a, s) => a + s.mean, 0) / ss.length : null);
  const h20s = filled("h20Stat");
  const matured = sorted
    .map((r) => ({ stat: statOf(r.h20Stat) }))
    .filter((x) => x.stat != null)
    .map((x) => ({ sellDate: (x.stat as HorizonStat).sellDate, netPct: (x.stat as HorizonStat).mean }));
  const navPts = shadowNavSeriesOf(matured);
  const benchPts = shadowNavSeriesOf(
    sorted.map((r) => statOf(r.h20Stat)).filter((s): s is HorizonStat => s != null && s.benchMean != null)
      .map((s) => ({ sellDate: s.sellDate, netPct: s.benchMean as number })),
  );
  const benchByDate = new Map(benchPts.map((p) => [p.tradeDate, p.nav]));
  const nav: NavPoint[] = navPts.map((p) => ({
    tradeDate: p.tradeDate, nav: p.nav, benchNav: benchByDate.get(p.tradeDate) ?? 1, hasSample: true,
  }));
  const byRegime = (["强势", "震荡", "弱势"] as const).map((regime) => {
    const rs = sorted.filter((r) => r.regime === regime);
    const pick = (key: "h1Stat" | "h5Stat" | "h20Stat") =>
      avgMean(rs.map((r) => statOf(r[key])).filter((s): s is HorizonStat => s != null));
    return {
      regime, batches: rs.length, empty: rs.filter((r) => shadowSymbolsOf(r.symbols).length === 0).length,
      h1Mean: pick("h1Stat"), h5Mean: pick("h5Stat"), h20Mean: pick("h20Stat"),
    };
  });
  return {
    summary: {
      days: sorted.length,
      emptyDays: sorted.filter((r) => shadowSymbolsOf(r.symbols).length === 0).length,
      matured: h20s.length,
      h1AvgMean: avgMean(filled("h1Stat")),
      h5AvgMean: avgMean(filled("h5Stat")),
      h20AvgMean: avgMean(h20s),
      h20BatchWinPct: h20s.length ? (h20s.filter((s) => s.mean > 0).length / h20s.length) * 100 : null,
      navNow: nav.length ? nav[nav.length - 1].nav : null,
      benchNavNow: nav.length ? nav[nav.length - 1].benchNav : null,
      basis: "信号日收盘买、持有到期日收盘卖，每档按「若当天卖出」扣满 0.41%；组合按每天一份、每份占 1/20 滚动，未到期的份不进净值。",
    },
    nav,
    byRegime,
    rows: outRows,
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
        h1Stat: true, h5Stat: true, h20Stat: true, shadowDetail: true,
      },
    })) as PickRow[];

    // 分层（影子行只进影子层，不许混进策略层稀释正式口径）
    const layer1Rows = rows.filter((r) => r.source === "gate" || r.source === "regime");
    const layer2Rows = rows.filter((r) => r.source === AI_PICK_SOURCE);
    const shadowRows = rows.filter((r) => r.source === SHADOW_SOURCE);
    const shadow = await aggregateShadow(shadowRows);
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
        shadow: { ...shadow, status: shadowRows.length ? ("ok" as const) : ("empty" as const) },
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
