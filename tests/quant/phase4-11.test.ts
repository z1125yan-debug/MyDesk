// Phase 4-11 测试：回测引擎 / 绩效评估与淘汰 / 生命周期 / 实验指纹 / 知识库 / 选股与回放 / 验证
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider, DEMO_TRADING_DAYS } from "../../src/lib/quant/data/demo-provider.ts";
import { buildPanel } from "../../src/lib/quant/factors/panel.ts";
import { runBacktestEngine, splitRanges, type BacktestPanel, type PositionSelector } from "../../src/lib/quant/backtest/engine.ts";
import { computeMetrics, compareStrategies, compositeScore } from "../../src/lib/quant/strategies/evaluation.ts";
import {
  assertStrategyTransition, assertFactorTransition, canEnterOfficialSelection,
  canProduceLiveSignal, LifecycleError, transitionEvidence,
} from "../../src/lib/quant/strategies/lifecycle.ts";
import { experimentFingerprint, canonicalJson, newExperimentRecord } from "../../src/lib/quant/research/experiments.ts";
import { buildResearchContext, contextToPrompt } from "../../src/lib/quant/research/knowledge.ts";
import { runSelection, runSelectionReplay, compositeScores } from "../../src/lib/quant/selection/engine.ts";
import { shanghaiDate } from "../../src/lib/desk/session.ts";
import { validateStrategy, scanParameterStability } from "../../src/lib/quant/backtest/validation.ts";
import { evaluateAst, parseExpression } from "../../src/lib/quant/factors/expression.ts";

const AS_OF = "2025-09-30";

// ---------- 绩效评估 ----------

test("评估: 已知净值曲线的指标正确性", () => {
  // 100 万 → 每天 +0.1% 持续 250 天：年化 ≈ (1.001)^252-1 ≈ 28.6%，MDD=0
  const curve = Array.from({ length: 250 }, (_, i) => ({ date: `d${i}`, value: 1e6 * Math.pow(1.001, i), benchmark: 1 }));
  const engine = {
    equityCurve: curve, trades: [], blockedOrders: [],
    dailyReturns: curve.map((p, i) => (i === 0 ? 0 : p.value / curve[i - 1].value - 1)),
    finalEquity: curve[249].value,
  };
  const m = computeMetrics(engine as never, 1e6);
  assert.ok(Math.abs((m.annualReturn ?? 0) - (Math.pow(1.001, 252) - 1)) < 0.005);
  assert.equal(m.maxDrawdown, 0);
  assert.ok((m.sharpe ?? 0) > 10); // 恒定正收益 → 天文 sharpe
  assert.ok((m.cumulativeReturn ?? 0) > 0.25);
});

test("评估: 只看收益会被淘汰——高收益但高回撤低Sharpe", () => {
  const verdicts = compareStrategies([
    { strategyKey: "high_return_bad", metrics: { annualReturn: 0.8, sharpe: 0.4, maxDrawdown: 0.45, calmar: 1.7, winRate: 0.35, payoffRatio: 0.8, tradeCount: 100, turnover: 30, stability: 0.4 } },
    { strategyKey: "balanced_good", metrics: { annualReturn: 0.25, sharpe: 1.6, maxDrawdown: 0.1, calmar: 2.5, winRate: 0.55, payoffRatio: 1.5, tradeCount: 120, turnover: 12, stability: 0.8 } },
  ]);
  const bad = verdicts.find((v) => v.strategyKey === "high_return_bad")!;
  const good = verdicts.find((v) => v.strategyKey === "balanced_good")!;
  assert.equal(bad.verdict, "eliminate");
  assert.ok(bad.reasons.some((r) => r.includes("回撤")));
  assert.ok(bad.reasons.some((r) => r.includes("Sharpe")));
  assert.equal(good.verdict, "keep");
  assert.ok(compositeScore(good.metrics) > compositeScore(bad.metrics), "综合分应偏向均衡策略");
});

test("生命周期: 状态机铁律", () => {
  assert.doesNotThrow(() => assertStrategyTransition("Candidate", "Research"));
  assert.doesNotThrow(() => assertStrategyTransition("Research", "Validated"));
  assert.doesNotThrow(() => assertStrategyTransition("Degraded", "Research"));
  assert.throws(() => assertStrategyTransition("Degraded", "Live"), LifecycleError);
  assert.throws(() => assertStrategyTransition("Retired", "Live"), LifecycleError);
  assert.throws(() => assertStrategyTransition("Candidate", "Live"), LifecycleError);
  assert.equal(canEnterOfficialSelection("Validated"), true);
  assert.equal(canEnterOfficialSelection("Paper"), true);
  assert.equal(canEnterOfficialSelection("Live"), true);
  assert.equal(canEnterOfficialSelection("Candidate"), false);
  assert.equal(canEnterOfficialSelection("Research"), false);
  assert.equal(canProduceLiveSignal("Retired"), false);
  assert.equal(canProduceLiveSignal("Degraded"), false);
  assert.equal(transitionEvidence("Research", "Validated"), "validation_report");
  // 因子状态机
  assert.doesNotThrow(() => assertFactorTransition("Candidate", "Validated"));
  assert.throws(() => assertFactorTransition("Candidate", "Live"), LifecycleError);
});

// ---------- 实验指纹 ----------

test("实验指纹: 键序无关且内容敏感", () => {
  const a = experimentFingerprint({ kind: "backtest", dataRange: "x", stockPool: { kind: "all", max: 80 }, factorVersions: "f@1", parameters: { topN: 10, rebalance: 5 } });
  const b = experimentFingerprint({ kind: "backtest", dataRange: "x", stockPool: { max: 80, kind: "all" }, factorVersions: "f@1", parameters: { rebalance: 5, topN: 10 } });
  assert.equal(a, b, "键序不应影响指纹");
  const c = experimentFingerprint({ kind: "backtest", dataRange: "x", stockPool: { kind: "all", max: 90 }, factorVersions: "f@1", parameters: { topN: 10, rebalance: 5 } });
  assert.notEqual(a, c, "参数变化必须改变指纹");
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  const rec = newExperimentRecord({ kind: "backtest", dataRange: "x", stockPool: {}, factorVersions: "" });
  assert.ok(rec.id.startsWith("qe_"));
  assert.equal(rec.status, "running");
});

// ---------- 知识库上下文 ----------

test("知识库: 研究前上下文与避免重复清单", () => {
  const ctx = buildResearchContext([
    { id: "1", kind: "valid_factor", title: "roc_c_60", content: "RankIC 0.03", refs: [], tags: [], active: true, createdAt: "", updatedAt: "" },
    { id: "2", kind: "invalid_factor", title: "roc_c_5", content: "RankIC 0.001", refs: [], tags: [], active: true, createdAt: "", updatedAt: "" },
    { id: "3", kind: "failed_strategy", title: "strat_x", content: "OOS 亏损", refs: [], tags: [], active: true, createdAt: "", updatedAt: "" },
    { id: "4", kind: "invalid_factor", title: "已停用条目", content: "", refs: [], tags: [], active: false, createdAt: "", updatedAt: "" },
  ]);
  assert.equal(ctx.validFactors.length, 1);
  assert.equal(ctx.invalidFactors.length, 1); // 停用条目不计入
  assert.ok(ctx.avoidNotes.some((n) => n.includes("roc_c_5")));
  assert.ok(ctx.avoidNotes.some((n) => n.includes("strat_x")));
  const prompt = contextToPrompt(ctx);
  assert.ok(prompt.includes("避免重复清单"));
  assert.ok(prompt.includes("roc_c_60"));
});

// ---------- 回测引擎 ----------

async function demoBacktestPanel(): Promise<BacktestPanel> {
  const panel = await buildPanel(demoProvider, { universe: { kind: "all" }, asOf: AS_OF, lookback: 300, maxSymbols: 40 });
  return { dates: panel.dates, symbols: panel.symbols, fields: panel.fields };
}

function momentumSelector(topN: number, mats: { factorKey: string; mat: (number | null)[][] }[]): PositionSelector {
  return {
    name: `mom_top${topN}`,
    select: (view) => {
      const scores = new Map<string, number>();
      for (const { mat } of mats) {
        const col = mat.map((row) => row[Math.min(view.t, row.length - 1)]);
        const nums = col.filter((v): v is number => v !== null);
        if (nums.length < 10) continue;
        const sorted = [...nums].sort((a, b) => a - b);
        col.forEach((val, si) => {
          if (val === null) return;
          let lo = 0;
          for (const s of sorted) if (s < val) lo++;
          scores.set(view.symbols[si], (scores.get(view.symbols[si]) ?? 0) + lo / Math.max(1, sorted.length - 1));
        });
      }
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      const out = new Map<string, number>();
      for (const [sym] of ranked) out.set(sym, 1 / Math.max(1, ranked.length));
      return out;
    },
  };
}

test("回测引擎: 演示面板完整回测，成本/约束生效，净值曲线连续", async () => {
  const btPanel = await demoBacktestPanel();
  const mats = [{ factorKey: "roc20", mat: evaluateAst(parseExpression("roc(c, 20)"), btPanel as never) }];
  const engine = runBacktestEngine(btPanel, momentumSelector(10, mats), {
    mode: "universe", tf: "day", startDate: btPanel.dates[0], endDate: btPanel.dates[btPanel.dates.length - 1],
    universe: { kind: "custom", symbols: btPanel.symbols }, initialCash: 1_000_000, cost: {}, split: { train: 0.6, validation: 0.2, test: 0.2 },
  });
  assert.equal(engine.equityCurve.length, btPanel.dates.length);
  assert.ok(engine.trades.length > 50, `应有足量交易，实际 ${engine.trades.length}`);
  assert.ok(engine.finalEquity > 0);
  // 成本必然为正（每笔都有佣金+滑点）
  const totalCost = engine.trades.reduce((s, t) => s + t.cost, 0);
  assert.ok(totalCost > 0);
  const m = computeMetrics(engine, 1e6);
  assert.ok(m.tradeCount === engine.trades.length);
  assert.ok((m.maxDrawdown ?? 0) >= 0 && (m.maxDrawdown ?? 0) < 1);
  assert.ok(typeof m.sharpe === "number");
  // 分段
  const segs = splitRanges(btPanel.dates, { train: 0.6, validation: 0.2, test: 0.2 });
  assert.deepEqual(segs.map((s) => s.name), ["train", "validation", "test"]);
});

test("回测引擎: 涨跌停/停牌封锁会被记录", async () => {
  const btPanel = await demoBacktestPanel();
  const mats = [{ factorKey: "roc20", mat: evaluateAst(parseExpression("roc(c, 20)"), btPanel as never) }];
  const engine = runBacktestEngine(btPanel, momentumSelector(20, mats), {
    mode: "universe", tf: "day", startDate: btPanel.dates[0], endDate: btPanel.dates[btPanel.dates.length - 1],
    universe: { kind: "custom", symbols: btPanel.symbols }, initialCash: 1_000_000,
    cost: {}, constraints: { respectLimitUpDown: true, respectSuspension: true, volumeCapRatio: 0.00001, liquidityCapRatio: 0.00001 },
  });
  // 极小量/流动性约束下必然出现封锁
  assert.ok(engine.blockedOrders.length > 0, "极端约束下应有封锁记录");
});

test("选股引擎: 输出完整字段与TopN约束", async () => {
  const request = {
    mode: "multi_factor" as const,
    asOf: AS_OF,
    universe: { kind: "custom" as const, symbols: DEMO_TRADING_DAYS.length > 0 ? ["601000.SH", "601001.SH", "601002.SH", "601003.SH", "601004.SH", "601005.SH", "601006.SH", "601007.SH", "601008.SH", "601009.SH", "601010.SH", "601011.SH"] : [] },
    filters: { excludeST: true, excludeSuspended: true },
    factors: [{ factorKey: "roc_c_20", version: 1, weight: 1, direction: 1 as const, expression: "roc(c, 20)" }],
    scoring: { method: "rank" as const, topN: 5 },
  };
  const result = await runSelection({ provider: demoProvider, request });
  assert.ok(result.rows.length <= 5);
  assert.ok(result.rows.length > 0, "演示数据应能选出股票");
  for (const [i, row] of result.rows.entries()) {
    assert.ok(/^\d{6}\.(SH|SZ|BJ)$/.test(row.code));
    assert.equal(row.rank, i + 1);
    assert.equal(row.timestamp, AS_OF);
    assert.ok(row.strategyVersion.length > 0);
    assert.ok(row.factorVersions.includes("roc_c_20@1"));
    assert.ok(row.triggeredFactors.length > 0);
    assert.ok(row.reason.length > 0);
    assert.ok(typeof row.risk === "string");
  }
  // 排名单调
  for (let i = 1; i < result.rows.length; i++) {
    assert.ok(result.rows[i - 1].score >= result.rows[i].score);
  }
});

test("选股引擎: 规则模式（above_ma）", async () => {
  const result = await runSelection({
    provider: demoProvider,
    request: {
      mode: "rule", asOf: AS_OF,
      universe: { kind: "custom", symbols: ["601000.SH", "601001.SH", "601002.SH", "601003.SH", "601004.SH", "601005.SH", "601006.SH", "601007.SH", "601008.SH", "601009.SH"] },
      rules: [{ key: "above_ma", params: { window: 20 } }],
      scoring: { method: "rank", topN: 20 },
    },
  });
  assert.ok(result.rows.length > 0 && result.rows.length <= 10);
  assert.ok(result.rows.every((r) => r.triggeredFactors.includes("above_ma")));
});

test("选股引擎: compositeScores 方向与权重", () => {
  const { scores } = compositeScores(
    [
      { ref: { factorKey: "a", version: 1, weight: 1, direction: 1 }, values: new Map([["X", 10], ["Y", 20]]) },
      { ref: { factorKey: "b", version: 1, weight: 2, direction: -1 }, values: new Map([["X", 5], ["Y", 1]]) },
    ],
    ["X", "Y"], "rank",
  );
  assert.ok((scores.get("Y") ?? 0) > (scores.get("X") ?? 0), "Y 应排名更高（a 因子更优 + b 反向因子值更低）");
});

test("历史回放: 同一选股引擎 + 未来窗口标签，拒绝今天", async () => {
  const asOf = "2025-09-01";
  // 拒绝用例的 asOf 必须动态取「今天」（上海日），否则跨 UTC 零点后该硬编码日期会变成合法历史日期。
  await assert.rejects(
    () => runSelectionReplay(demoProvider, { mode: "multi_factor", asOf: shanghaiDate(), universe: { kind: "custom", symbols: ["601000.SH"] }, factors: [{ factorKey: "f", version: 1, weight: 1, direction: 1, expression: "roc(c, 20)" }], scoring: { method: "rank", topN: 5 } }, 5),
    /早于今天/,
  );
  const outcome = await runSelectionReplay(demoProvider, {
    mode: "multi_factor", asOf,
    universe: { kind: "custom", symbols: ["601000.SH", "601001.SH", "601002.SH", "601003.SH", "601004.SH", "601005.SH", "601006.SH", "601007.SH", "601008.SH", "601009.SH", "601010.SH", "601011.SH"] },
    factors: [{ factorKey: "roc_c_20", version: 1, weight: 1, direction: 1, expression: "roc(c, 20)" }],
    scoring: { method: "rank", topN: 5 },
  }, 5);
  assert.ok(outcome.picks.length > 0);
  assert.equal(outcome.horizon, 5);
  assert.ok(outcome.forwardWindow.end > asOf, "回放窗口必须在 asOf 之后");
  for (const p of outcome.picks) {
    assert.ok(p.forwardReturn === null || typeof p.forwardReturn === "number");
  }
  assert.ok(outcome.warnings.some((w) => w.includes("仅用于事后评估")));
});

// ---------- 验证 ----------

test("验证: Walk-forward + OOS + Regime 在演示面板可运行", async () => {
  const btPanel = await demoBacktestPanel();
  const mats = [{ factorKey: "roc20", mat: evaluateAst(parseExpression("roc(c, 20)"), btPanel as never) }];
  const selector = momentumSelector(10, mats);
  const config: import("../../src/lib/quant/types").BacktestConfig = {
    mode: "universe", tf: "day", startDate: btPanel.dates[0], endDate: btPanel.dates[btPanel.dates.length - 1],
    universe: { kind: "custom", symbols: btPanel.symbols }, initialCash: 1_000_000, cost: {},
  };
  const report = validateStrategy(btPanel, selector, config, { walkForwardFolds: 3, oosRatio: 0.3 });
  assert.ok(report.walkForward.length >= 1, "至少 1 折");
  assert.ok(report.walkForward.every((f) => f.testRange > f.trainRange));
  assert.ok(["pass", "warn", "fail"].includes(report.verdict));
  assert.ok(typeof report.oos.decayRatio === "number");
  const stab = scanParameterStability(btPanel, config, (v) => momentumSelector(v, mats), "topN", [5, 10, 20]);
  assert.ok(["stable", "unstable"].includes(stab.verdict));
  assert.equal(stab.values.length, 3);
});

test("交易日历覆盖回放所需未来窗口", () => {
  assert.ok(DEMO_TRADING_DAYS.some((d) => d > "2025-09-01"));
});
