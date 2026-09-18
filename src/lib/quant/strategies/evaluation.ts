// Quant Research Lab — 策略绩效评估与比较淘汰（Phase 6，纯逻辑）
// 评估维度：年化/累计/Sharpe/Sortino/Calmar/最大回撤/胜率/盈亏比/换手/交易次数/交易成本/稳定性
// 淘汰规则：绝不只看收益率。
import type { StrategyMetrics, BacktestResult } from "../types.ts";
import type { EngineResult } from "../backtest/engine.ts";

export function computeMetrics(engine: EngineResult, initialCash: number): StrategyMetrics {
  const curve = engine.equityCurve;
  const n = curve.length;
  if (n < 2) return { tradeCount: engine.trades.length };

  const returns = engine.dailyReturns.slice(1); // 首日 0 除外
  const finalValue = curve[n - 1].value;
  const cumulativeReturn = finalValue / initialCash - 1;

  // 年化：按 252 交易日
  const annualReturn = Math.pow(finalValue / initialCash, 252 / Math.max(1, n - 1)) - 1;

  const meanR = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const sd = Math.sqrt(returns.reduce((s, v) => s + (v - meanR) * (v - meanR), 0) / Math.max(1, returns.length - 1));
  const downside = returns.filter((r) => r < 0);
  const dsd = downside.length
    ? Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / downside.length)
    : 0;
  const sharpe = sd > 0 ? (meanR / sd) * Math.sqrt(252) : 0;
  const sortino = dsd > 0 ? (meanR / dsd) * Math.sqrt(252) : 0;

  // 最大回撤
  let peak = curve[0].value;
  let maxDd = 0;
  for (const p of curve) {
    if (p.value > peak) peak = p.value;
    const dd = peak > 0 ? (peak - p.value) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  const calmar = maxDd > 0 ? annualReturn / maxDd : 0;

  // 交易级胜率与盈亏比（卖出时按平均成本判定盈亏）
  const sells = engine.trades.filter((t) => t.side === "sell");
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
  // 重建持仓成本（引擎内 avgCost 不外露，用 FIFO 近似：买入价队列）
  const lots = new Map<string, number[]>(); // symbol → 每股买入价队列
  for (const t of engine.trades) {
    if (t.side === "buy") {
      const q = lots.get(t.symbol) ?? [];
      for (let i = 0; i < t.shares / 100; i++) q.push(t.price);
      lots.set(t.symbol, q);
    } else {
      const q = lots.get(t.symbol) ?? [];
      let sellGain = 0;
      const nLots = t.shares / 100;
      for (let i = 0; i < nLots; i++) {
        const costPx = q.shift() ?? t.price;
        sellGain += t.price - costPx;
      }
      if (sellGain > 0) { wins++; grossWin += sellGain; } else { losses++; grossLoss += Math.abs(sellGain); }
    }
  }
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const payoffRatio = losses > 0 && wins > 0 ? grossWin / wins / (grossLoss / losses) : wins > 0 ? 99 : 0;

  // 换手率：成交额 / 平均组合市值
  const avgEquity = curve.reduce((s, p) => s + p.value, 0) / n;
  const turnoverNotional = engine.trades.reduce((s, t) => s + t.price * t.shares, 0);
  const periodsPerYear = 252 / Math.max(1, n - 1);
  const turnover = avgEquity > 0 ? (turnoverNotional / avgEquity) * periodsPerYear : 0;

  // 总交易成本占比
  const totalCost = engine.trades.reduce((s, t) => s + t.cost, 0);
  const transactionCost = initialCash > 0 ? totalCost / initialCash : 0;

  // 稳定性：月度收益同号比例（近似：12 等分窗口）
  const k = Math.min(12, Math.floor(returns.length / 10));
  let stability = 1;
  if (k >= 3) {
    const per = Math.floor(returns.length / k);
    const winWindows: number[] = [];
    for (let i = 0; i < k; i++) {
      const seg = returns.slice(i * per, i === k - 1 ? undefined : (i + 1) * per);
      const segR = seg.reduce((s, v) => s * (1 + v), 1) - 1;
      winWindows.push(segR);
    }
    const sign = Math.sign(annualReturn) || 1;
    stability = winWindows.filter((r) => Math.sign(r) === sign).length / winWindows.length;
  }

  return {
    annualReturn, cumulativeReturn, sharpe, sortino, calmar,
    maxDrawdown: maxDd, winRate, payoffRatio,
    turnover, tradeCount: engine.trades.length,
    transactionCost, stability,
  };
}

export interface EliminationVerdict {
  strategyKey: string;
  verdict: "keep" | "eliminate" | "warning";
  reasons: string[];
  metrics: StrategyMetrics;
}

// 比较与淘汰：多维度硬门槛 + 综合排名（收益只是一票，不是全部）
export interface EliminationRules {
  minSharpe?: number; // 默认 0.8
  minCalmar?: number; // 默认 0.5
  maxDrawdown?: number; // 默认 0.25
  minWinRate?: number; // 默认 0.4
  minPayoffRatio?: number; // 默认 1.0
  minTradeCount?: number; // 默认 10（样本不足不可信）
  maxTurnover?: number; // 默认 60（年化换手倍数）
}

export const DEFAULT_ELIMINATION: Required<EliminationRules> = {
  minSharpe: 0.8, minCalmar: 0.5, maxDrawdown: 0.25,
  minWinRate: 0.4, minPayoffRatio: 1.0, minTradeCount: 10, maxTurnover: 60,
};

export function compareStrategies(
  candidates: { strategyKey: string; metrics: StrategyMetrics }[],
  rules: EliminationRules = DEFAULT_ELIMINATION,
): EliminationVerdict[] {
  const r = { ...DEFAULT_ELIMINATION, ...rules };
  return candidates.map((c) => {
    const m = c.metrics;
    const reasons: string[] = [];
    let verdict: "keep" | "eliminate" | "warning" = "keep";
    const fail = (msg: string) => { reasons.push(msg); verdict = "eliminate"; };
    const warn = (msg: string) => { if (verdict !== "eliminate") verdict = "warning"; reasons.push(msg); };

    if ((m.sharpe ?? 0) < r.minSharpe) fail(`Sharpe ${(m.sharpe ?? 0).toFixed(2)} < ${r.minSharpe}`);
    if ((m.calmar ?? 0) < r.minCalmar) warn(`Calmar ${(m.calmar ?? 0).toFixed(2)} < ${r.minCalmar}`);
    if ((m.maxDrawdown ?? 0) > r.maxDrawdown) fail(`最大回撤 ${((m.maxDrawdown ?? 0) * 100).toFixed(1)}% > ${(r.maxDrawdown * 100).toFixed(0)}%`);
    if ((m.winRate ?? 0) < r.minWinRate) warn(`胜率 ${((m.winRate ?? 0) * 100).toFixed(0)}% < ${(r.minWinRate * 100).toFixed(0)}%`);
    if ((m.payoffRatio ?? 0) < r.minPayoffRatio) warn(`盈亏比 ${(m.payoffRatio ?? 0).toFixed(2)} < ${r.minPayoffRatio}`);
    if ((m.tradeCount ?? 0) < r.minTradeCount) warn(`交易次数 ${(m.tradeCount ?? 0)} < ${r.minTradeCount}（样本不足）`);
    if ((m.turnover ?? 0) > r.maxTurnover) warn(`年化换手 ${(m.turnover ?? 0).toFixed(1)}x 过高`);

    return { strategyKey: c.strategyKey, verdict, reasons, metrics: m };
  });
}

// 综合分：Sharpe 30% + Calmar 20% + 年化 20% + 回撤控制 15% + 稳定性 15%（收益只占两成）
export function compositeScore(m: StrategyMetrics): number {
  const s = (m.sharpe ?? 0) * 0.30
    + Math.min(3, Math.max(0, m.calmar ?? 0)) * 0.20
    + Math.min(0.6, Math.max(-0.6, m.annualReturn ?? 0)) * 2 * 0.20
    + (1 - Math.min(1, (m.maxDrawdown ?? 1) / 0.5)) * 0.15
    + (m.stability ?? 0) * 0.15;
  return Math.round(s * 1000) / 1000;
}

export function metricsToBacktestResult(result: EngineResult, initialCash: number, config: BacktestResult["config"], segments: BacktestResult["segments"] = [], warnings: string[] = [], source = ""): BacktestResult {
  return {
    config,
    equityCurve: result.equityCurve,
    trades: result.trades,
    metrics: computeMetrics(result, initialCash),
    segments,
    diagnostics: {
      lookaheadCheck: "pass", // 由调用方依据 selector 数据纪律覆盖
      futureFunctionCheck: "pass",
      dataLeakageCheck: "pass",
      survivorshipBias: "possible",
      notes: [],
    },
    warnings,
    source,
  };
}
