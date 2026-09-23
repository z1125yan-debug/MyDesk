// POST /api/quant/probability — 历史条件概率独立计算（P2-2）
// §二 补：trade_date 历史交易日回放；§六 补：基准（沪深300）同期收益 + 命中样本净值最大回撤
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import { outcomeWarning } from "@/lib/quant/data/hybrid-core";
import { getProvider } from "@/lib/quant/data/index";
import { historicalWinProbability, type ScreenerCond } from "@/lib/quant/factors/probability";
import type { BarsLike } from "@/lib/quant/factors/fields";
import { BENCHMARK_NAME, BENCHMARK_SYMBOL } from "@/lib/quant/screener/run";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const INDEX_POOL = [
  { symbol: "000001.SH", name: "上证指数" },
  { symbol: "399001.SZ", name: "深证成指" },
  { symbol: "399006.SZ", name: "创业板指" },
];

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => null)) as {
    conditions?: ScreenerCond[];
    symbols?: string[];
    universe?: "index" | "custom";
    lookback?: number;
    trade_date?: string;
  } | null;
  if (!body?.conditions?.length) {
    return NextResponse.json({ ok: false, error: "需要 conditions 数组" }, { status: 400 });
  }
  const lookback = Math.min(800, Math.max(120, body.lookback ?? 520));
  let targets = INDEX_POOL;
  if (body.universe === "custom" || (body.symbols && body.symbols.length)) {
    const symbols = (body.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
    if (!symbols.length) return NextResponse.json({ ok: false, error: "自定义池 symbols 为空" }, { status: 400 });
    targets = symbols.map((symbol) => ({ symbol, name: symbol }));
  }

  try {
    // §二 交易日选择器：只接受不晚于当日的 YYYY-MM-DD（K线口径按该日及以前回放）
    const today = shanghaiDate();
    const reqDate = typeof body.trade_date === "string" ? body.trade_date.trim().slice(0, 10) : "";
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(reqDate);
    const asOf = dateOk && reqDate <= today ? reqDate : today;
    const isHistorical = asOf < today;

    const wantSymbols = [...new Set([...targets.map((t) => t.symbol), BENCHMARK_SYMBOL])];
    const barsResult = await fetchBarsHybridTracked(wantSymbols, asOf, lookback);
    const barsMap = barsResult.bars;
    // P6-A：把「K线取数失败」和「这只票确实没这么多K线」分开——前者是数据源问题，不能算进样本不足
    const outcomeOf = new Map(barsResult.outcomes.map((o) => [o.symbol, o] as const));
    const benchBars = (barsMap.get(BENCHMARK_SYMBOL) ?? []) as BarsLike[];
    const provider = await getProvider("em");
    const metas = await provider.listUniverse({ kind: "all" }, asOf).catch(() => []);
    const metaOf = new Map(metas.map((m) => [m.symbol, m] as const)); // as const：元组推断，避免 Map<unknown,unknown>

    const per = targets.map((t) => {
      const bars = barsMap.get(t.symbol) ?? [];
      const stats = bars.length >= 40
        ? historicalWinProbability({
          symbol: t.symbol, bars, meta: metaOf.get(t.symbol), conditions: body.conditions!,
          benchmarkBars: benchBars, benchmarkName: BENCHMARK_NAME,
        })
        : null;
      const oc = outcomeOf.get(t.symbol);
      const skipReason = oc?.kind === "request_failed"
        ? "K线取数失败（通达信网关与腾讯都没成功返回）：本次不纳入统计，不是样本不足"
        : oc?.kind === "no_data"
          ? "K线无返回（请求成功但上游没有这只股票的日K，例如代码不存在）：本次不纳入统计"
          : bars.length < 40 ? "K线不足，跳过" : null;
      return {
        symbol: t.symbol,
        name: metaOf.get(t.symbol)?.name ?? t.name,
        bars: bars.length,
        stats,
        error: bars.length < 40 ? skipReason : stats ? null : "无K线口径条件可匹配",
      };
    });

    const pooledHorizons = [1, 5, 20].map((h) => {
      let w = 0, n = 0, avg = 0, samples = 0, bw = 0, bn = 0;
      let worstDd = 0;
      for (const p of per) {
        const row = p.stats?.horizons.find((x) => x.h === h);
        if (!row || row.sample_size <= 0 || row.win_rate === null) continue;
        w += row.win_rate * row.sample_size;
        avg += (row.avg_return ?? 0) * row.sample_size;
        n += row.sample_size;
        samples += 1;
        if (row.benchmark_return !== null) { bw += row.benchmark_return * row.sample_size; bn += row.sample_size; }
        if (row.max_drawdown !== null && row.max_drawdown < worstDd) worstDd = row.max_drawdown;
      }
      const bench = bn ? bw / bn : null;
      const meanRet = n ? avg / n : null;
      return {
        h,
        win_rate: n ? w / n : null,
        avg_return: meanRet,
        sample_size: n,
        symbols_used: samples,
        benchmark_return: bench,                                  // §六 沪深300 同期
        excess_return: meanRet !== null && bench !== null ? meanRet - bench : null,
        max_drawdown: n ? worstDd : null,                         // 各标的中最深（保守口径）
      };
    });

    const warnings = per.flatMap((p) => p.stats?.warnings ?? (p.error ? [p.error] : []));
    const benchOc = outcomeOf.get(BENCHMARK_SYMBOL);
    if (!benchBars.length) {
      warnings.push(`基准 ${BENCHMARK_NAME}（${BENCHMARK_SYMBOL}）${benchOc?.kind === "request_failed" ? "K线取数失败" : "本次无K线返回"}：基准/超额收益不可用（不以0代替）`);
    }
    const klineWarn = outcomeWarning(barsResult.outcomes);
    if (klineWarn) warnings.push(klineWarn);
    if (isHistorical) warnings.push(`历史交易日回放 ${asOf}：仅K线口径条件参与匹配，快照口径条件无历史时点数据`);

    return NextResponse.json({
      ok: true,
      as_of_trade_date: asOf,
      trade_date_is_historical: isHistorical,
      /** P5 留档口径：把「本次真正生效的回看天数」回显出来（请求里的值会被 120..800 夹取），
       *  留档接口据此存列，避免页面显示一个、库里记另一个。纯新增字段，不改任何计算。 */
      lookback,
      benchmark: { symbol: BENCHMARK_SYMBOL, name: BENCHMARK_NAME, bars: benchBars.length },
      universe: body.symbols?.length ? "custom" : "index",
      per_symbol: per,
      pooled: pooledHorizons,
      sample_ok: pooledHorizons.some((x) => (x.sample_size ?? 0) >= 30),
      warnings: [...new Set(warnings)],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
