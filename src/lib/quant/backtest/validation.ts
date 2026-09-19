// Quant Research Lab — 反过拟合验证（Phase 5/6 附属，纯逻辑）
// Walk-forward / 留出 OOS / 市场环境分段 / 参数稳定性 / 过拟合检查清单
import type { BacktestConfig, ValidationConfig, ValidationReport, StrategyMetrics } from "../types.ts";
import { runBacktestEngine, splitRanges, type BacktestPanel, type PositionSelector } from "./engine.ts";
import { computeMetrics } from "../strategies/evaluation.ts";

// 在子区间上运行回测（复用同一 selector，窗口受 start/end 限制）
function runOnRange(
  panel: BacktestPanel,
  selector: PositionSelector,
  config: BacktestConfig,
  startIdx: number,
  endIdx: number, // 含
  benchmark?: number[] | null,
): { metrics: StrategyMetrics; annual: number } {
  const sub: BacktestPanel = {
    dates: panel.dates.slice(startIdx, endIdx + 1),
    symbols: panel.symbols,
    names: panel.names ? panel.names.slice() : undefined,
    fields: new Map([...panel.fields.entries()].map(([k, mat]) => [k, mat.map((row) => row.slice(startIdx, endIdx + 1))])),
  };
  const engine = runBacktestEngine(sub, selector, { ...config, startDate: sub.dates[0], endDate: sub.dates[sub.dates.length - 1] }, { benchmarkSeries: benchmark ? benchmark.slice(startIdx, endIdx + 1) : null });
  const metrics = computeMetrics(engine, config.initialCash);
  return { metrics, annual: metrics.annualReturn ?? 0 };
}

export function validateStrategy(
  panel: BacktestPanel,
  selector: PositionSelector,
  config: BacktestConfig,
  vcfg: ValidationConfig = {},
): ValidationReport {
  const folds = Math.min(6, Math.max(2, vcfg.walkForwardFolds ?? 4));
  const trainRatio = vcfg.walkForwardTrainRatio ?? 0.6;
  const n = panel.dates.length;

  // ---------- Walk-forward ----------
  const walkForward: ValidationReport["walkForward"] = [];
  const foldLen = Math.floor((n * (1 - trainRatio)) / folds);
  if (foldLen >= 15) {
    for (let f = 0; f < folds; f++) {
      const trainStart = Math.floor(n * trainRatio * (f / folds));
      const trainEnd = Math.floor(n * trainRatio) + f * foldLen - 1;
      const testStart = trainEnd + 1;
      const testEnd = testStart + foldLen - 1;
      if (testEnd >= n || testStart <= trainStart) break;
      const oos = runOnRange(panel, selector, config, testStart, Math.min(n - 1, testEnd));
      walkForward.push({
        fold: f + 1,
        trainRange: `${panel.dates[trainStart]}~${panel.dates[trainEnd]}`,
        testRange: `${panel.dates[testStart]}~${panel.dates[Math.min(n - 1, testEnd)]}`,
        oosAnnual: oos.annual,
        sharpe: oos.metrics.sharpe,
      });
    }
  }

  // ---------- 留出 OOS ----------
  const oosRatio = vcfg.oosRatio ?? 0.3;
  const splitIdx = Math.floor(n * (1 - oosRatio));
  const isRun = runOnRange(panel, selector, config, 0, splitIdx - 1);
  const oosRun = runOnRange(panel, selector, config, splitIdx, n - 1);
  const isAnnual = isRun.annual;
  const oosAnnual = oosRun.annual;
  const decayRatio = Math.abs(isAnnual) > 0.01 ? oosAnnual / isAnnual : 0;

  // ---------- 市场环境分段（基准均线判牛熊） ----------
  const regimes: ValidationReport["regimes"] = [];
  const benchmarkSeries = panel.fields.get("c")?.[0] ?? null; // 以池内第一只股票为代理基准（或外部基准）
  if (benchmarkSeries) {
    const maLen = 60;
    let segStart = maLen;
    let currentRegime: "up" | "down" | null = null;
    for (let t = maLen; t < n; t++) {
      const window: number[] = [];
      for (let k = t - maLen; k < t; k++) if (benchmarkSeries[k] !== null) window.push(benchmarkSeries[k]!);
      if (window.length < maLen * 0.8) continue;
      const ma = window.reduce((s, v) => s + v, 0) / window.length;
      const px = benchmarkSeries[t];
      if (px === null) continue;
      const regime: "up" | "down" = px >= ma ? "up" : "down";
      if (currentRegime === null) currentRegime = regime;
      if (regime !== currentRegime || t === n - 1) {
        if (t - segStart >= 30) {
          const r = runOnRange(panel, selector, config, segStart, t);
          regimes.push({ name: currentRegime === "up" ? "上行市" : "下行市", range: `${panel.dates[segStart]}~${panel.dates[t]}`, annual: r.annual, sharpe: r.metrics.sharpe });
        }
        segStart = t;
        currentRegime = regime;
      }
    }
  }

  // ---------- 参数稳定性 ----------
  const paramStability: ValidationReport["paramStability"] = [];

  // ---------- 过拟合检查清单 ----------
  const overfitFlags: string[] = [];
  if (walkForward.length >= 2) {
    const positiveFolds = walkForward.filter((f) => (f.oosAnnual ?? 0) > 0).length;
    if (positiveFolds / walkForward.length < 0.5) overfitFlags.push(`Walk-forward 仅 ${positiveFolds}/${walkForward.length} 折样本外为正 → 过拟合嫌疑`);
  }
  if (isAnnual > 0 && oosAnnual < 0) overfitFlags.push(`样本内年化 ${(isAnnual * 100).toFixed(1)}% 为正但样本外 ${(oosAnnual * 100).toFixed(1)}% 为负 → 疑似过拟合`);
  else if (decayRatio < 0.3 && isAnnual > 0.1) overfitFlags.push(`OOS/IS 衰减比 ${(decayRatio * 100).toFixed(0)}% < 30% → 明显衰减`);
  if ((oosRun.metrics.tradeCount ?? 0) < 10) overfitFlags.push(`样本外交易次数 ${(oosRun.metrics.tradeCount ?? 0)} 过少 → 统计不可信（样本偏差）`);
  if (regimes.length >= 2) {
    const downRegimes = regimes.filter((r) => r.name === "下行市");
    if (downRegimes.length && downRegimes.every((r) => (r.annual ?? 0) < -0.5)) overfitFlags.push("下行市场环境内全为深度亏损 → 抗跌性缺失");
  }

  const wfPass = walkForward.length === 0 || walkForward.filter((f) => (f.oosAnnual ?? 0) > 0).length / walkForward.length >= 0.5;
  const oosPass = !(isAnnual > 0 && oosAnnual < 0);
  const verdict: "pass" | "warn" | "fail" = overfitFlags.length === 0 ? "pass" : (wfPass && oosPass && overfitFlags.length <= 2 ? "warn" : "fail");

  return {
    walkForward,
    oos: { isMetrics: isRun.metrics, oosMetrics: oosRun.metrics, decayRatio },
    regimes,
    paramStability,
    overfitFlags,
    verdict,
  };
}

// 参数稳定性扫描：对单一数值参数逐值回测，判断绩效是否对参数敏感
export function scanParameterStability(
  panel: BacktestPanel,
  config: BacktestConfig,
  makeSelector: (paramValue: number) => PositionSelector,
  paramName: string,
  values: number[],
): ValidationReport["paramStability"][number] {
  const entries = values.map((value) => {
    const r = runOnRange(panel, makeSelector(value), config, 0, panel.dates.length - 1);
    return { value, annual: r.annual, sharpe: r.metrics.sharpe ?? 0 };
  });
  const sharpes = entries.map((e) => e.sharpe);
  const maxSharpe = Math.max(...sharpes);
  const minSharpe = Math.min(...sharpes);
  const positiveRatio = entries.filter((e) => e.annual > 0).length / entries.length;
  // 稳定判定：大多数参数值为正收益，且 Sharpe 极差可控（非爆炸式敏感）
  const medianSharpe = [...sharpes].sort((a, b) => a - b)[Math.floor(sharpes.length / 2)] || 0;
  const stable = positiveRatio >= 0.7 && maxSharpe - minSharpe <= Math.max(1.5, Math.abs(medianSharpe) * 2);
  return {
    param: paramName,
    values: entries.map((e) => ({ value: e.value, annual: e.annual, sharpe: e.sharpe })),
    verdict: stable ? "stable" : "unstable",
  };
}
