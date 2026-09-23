// Quant Research Lab — 策略/选股/回放/自主研究 任务执行器（服务端）
// 统一接入：实验跟踪（指纹去重）+ 知识库（研究前查询、失败沉淀）+ 生命周期门禁。
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { buildPanel, forwardReturns } from "@/lib/quant/factors/panel";
import { parseExpression, evaluateAst, auditExpression } from "@/lib/quant/factors/expression";
import { runBacktestEngine, splitRanges, type PositionSelector, type BacktestPanel } from "@/lib/quant/backtest/engine";
import { validateStrategy, scanParameterStability } from "@/lib/quant/backtest/validation";
import { computeMetrics, compareStrategies, compositeScore } from "@/lib/quant/strategies/evaluation";
import { assertStrategyTransition, canEnterOfficialSelection, transitionEvidence, LifecycleError } from "@/lib/quant/strategies/lifecycle";
import { runSelection, runSelectionReplay, type SelectionFactorRef } from "@/lib/quant/selection/engine";
import { experimentFingerprint, newExperimentRecord, type ExperimentParts } from "@/lib/quant/research/experiments";
import { buildResearchContext, contextToPrompt } from "@/lib/quant/research/knowledge";
import { expandTemplates, combineFactors, type CandidateFactor } from "@/lib/quant/factors/templates";
import { evaluateCandidate, makeAcceptedTracker, trimMetrics, DEFAULT_MINING_CONFIG, type MiningConfig } from "@/lib/quant/factors/mining";
import { registerRunner, type JobCtx, JOB_PAUSED } from "@/lib/quant/jobs/registry";
import {
  getFactor, listLatestFactors, getStrategy, updateStrategyState, saveFactorVersion, saveStrategyVersion,
  findExperimentByFingerprint, createExperiment, finishExperiment,
  listKnowledge, addKnowledge,
} from "@/lib/quant/store";
import type { ValidationReport } from "@/lib/quant/types";
import type { CandidateResult } from "@/lib/quant/factors/mining";

let registered = false;

export function registerStrategyRunners(): void {
  quantBootstrap();
  if (registered) return;
  registered = true;

  // ============ 回测任务（quant_backtest） ============
  registerRunner("quant_backtest", async (ctx: JobCtx) => {
    const p = ctx.payload as BacktestPayload;
    const asOf = p.asOf ?? new Date().toISOString().slice(0, 10);
    const periodDays = Math.min(500, p.periodDays ?? 240);
    const topN = Math.min(50, p.topN ?? 10);
    const rebalanceEvery = Math.max(1, p.rebalanceEvery ?? 5);
    const source = p.source ?? "em";

    // ---- 实验跟踪：指纹去重 ----
    const factorKeys = p.factors ?? [];
    const parts: ExperimentParts = {
      kind: "backtest",
      dataRange: `${asOf} 前 ${periodDays} 交易日`,
      stockPool: { kind: p.kind ?? "all", boardCode: p.boardCode ?? "", maxSymbols: p.maxSymbols ?? 80 },
      factorVersions: factorKeys.map((f) => `${f.factorKey}@${f.version}`).join(",") || "adhoc",
      strategyVersion: p.strategyKey ? `${p.strategyKey}@${p.strategyVersion ?? ""}` : "",
      parameters: { topN, rebalanceEvery, scoring: p.scoring ?? "rank" },
      backtestParameters: { periodDays, split: p.split ?? null },
      transactionCost: p.cost ?? {},
    };
    const fp = experimentFingerprint(parts);
    const existing = await findExperimentByFingerprint(fp);
    if (existing && (existing.status === "done" || existing.status === "running")) {
      return { skipped: true, reason: "完全相同的实验已完成或进行中（指纹去重）", experiment: existing };
    }
    let experiment = existing
      ? (await finishExperiment(existing.id, { status: "running" }), { ...existing, status: "running" as const })
      : await createExperiment({ ...newExperimentRecord(parts), jobId: ctx.jobId });

    ctx.progress(5, "面板", "构建回测面板…");
    const provider = await getProvider(source);
    const panel = await buildPanel(provider, {
      universe: { kind: p.kind ?? "all", boardCode: p.boardCode, symbols: p.symbols },
      asOf, lookback: periodDays, maxSymbols: Math.min(300, p.maxSymbols ?? 80),
    });
    if (panel.dates.length < 80) throw new Error(`回测区间太短（${panel.dates.length} 日 < 80）`);

    ctx.progress(15, "因子", `解析并求值 ${factorKeys.length} 个因子…`);
    const factorRefs: SelectionFactorRef[] = [];
    for (const ref of factorKeys) {
      const f = await getFactor(ref.factorKey, ref.version || undefined);
      if (!f) throw new Error(`因子不存在：${ref.factorKey}@${ref.version ?? "latest"}`);
      factorRefs.push({ factorKey: f.factorKey, version: f.version, weight: ref.weight ?? 1, direction: ref.direction ?? 1, expression: f.expression });
    }
    if (!factorRefs.length && p.strategyKey) {
      const st = await getStrategy(p.strategyKey, p.strategyVersion || undefined);
      if (!st) throw new Error(`策略不存在：${p.strategyKey}`);
      for (const ref of st.factorRefs) {
        const f = await getFactor(ref.factorKey, ref.version);
        if (f) factorRefs.push({ factorKey: f.factorKey, version: f.version, weight: ref.weight, direction: ref.direction, expression: f.expression });
      }
    }
    if (!factorRefs.length) throw new Error("未指定任何因子（factors 或 strategyKey）");

    const mats = factorRefs.map((ref) => ({ ref, mat: evaluateAst(parseExpression(ref.expression), panel) }));
    const btPanel: BacktestPanel = { dates: panel.dates, symbols: panel.symbols, names: panel.meta.map((m) => m.name), fields: panel.fields };

    // 选股器：每调仓日按因子综合分取 TopN（等权），只用 ≤ t-1 数据
    const selector: PositionSelector = {
      name: `multi_factor_top${topN}`,
      select: (view) => {
        const scores = new Map<string, number>();
        for (const { ref, mat } of mats) {
          const col = mat.map((row) => row[Math.min(view.t, row.length - 1)]);
          const nums = col.filter((v): v is number => v !== null);
          if (nums.length < 10) continue;
          const sorted = [...nums].sort((a, b) => a - b);
          const rankOf = (x: number | null): number | null => {
            if (x === null) return null;
            let lo = 0;
            for (const s of sorted) if (s < x) lo++;
            return lo / Math.max(1, sorted.length - 1);
          };
          col.forEach((val, si) => {
            const r = rankOf(val);
            if (r === null) return;
            scores.set(panel.symbols[si], (scores.get(panel.symbols[si]) ?? 0) + r * ref.direction * ref.weight);
          });
        }
        const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
        const out = new Map<string, number>();
        for (const [sym] of ranked) out.set(sym, 1 / Math.max(1, ranked.length));
        return out;
      },
    };

    ctx.progress(35, "回测", `回测 ${panel.dates.length} 个交易日（调仓周期 ${rebalanceEvery}）…`);
    const engine = runBacktestEngine(btPanel, selector, {
      mode: "universe", tf: "day", startDate: panel.dates[0], endDate: panel.dates[panel.dates.length - 1],
      universe: { kind: "custom", symbols: panel.symbols }, initialCash: 1_000_000,
      cost: p.cost ?? {}, constraints: p.constraints, split: p.split,
    }, { benchmarkSeries: null });
    const metrics = computeMetrics(engine, 1_000_000);

    // 分段
    const segments = splitRanges(panel.dates, p.split).map((seg) => {
      const idxStart = panel.dates.indexOf(seg.startDate);
      const idxEnd = panel.dates.indexOf(seg.endDate);
      const sub: BacktestPanel = {
        dates: panel.dates.slice(idxStart, idxEnd + 1), symbols: panel.symbols,
        names: panel.meta.map((m) => m.name),
        fields: new Map([...panel.fields.entries()].map(([k, m]) => [k, m.map((row) => row.slice(idxStart, idxEnd + 1))])),
      };
      const subEngine = runBacktestEngine(sub, selector, {
        mode: "universe", tf: "day", startDate: seg.startDate, endDate: seg.endDate,
        universe: { kind: "custom", symbols: panel.symbols }, initialCash: 1_000_000, cost: p.cost ?? {}, constraints: p.constraints,
      });
      return { name: seg.name, startDate: seg.startDate, endDate: seg.endDate, metrics: computeMetrics(subEngine, 1_000_000) };
    });

    // ---- 反过拟合验证（可选但强烈建议） ----
    let validation: ValidationReport | null = null;
    let paramStability: ValidationReport["paramStability"][number] | null = null;
    if (p.validate !== false) {
      ctx.progress(60, "验证", "Walk-forward / OOS / 市场环境分段…");
      validation = validateStrategy(btPanel, selector, {
        mode: "universe", tf: "day", startDate: panel.dates[0], endDate: panel.dates[panel.dates.length - 1],
        universe: { kind: "custom", symbols: panel.symbols }, initialCash: 1_000_000, cost: p.cost ?? {},
      }, vcfgFromPayload(p));
      ctx.progress(75, "验证", "参数稳定性扫描…");
      const topNValues = [...new Set([topN - 5, topN, topN + 5].map((x) => Math.max(3, Math.min(50, x))))];
      paramStability = scanParameterStability(btPanel, {
        mode: "universe", tf: "day", startDate: panel.dates[0], endDate: panel.dates[panel.dates.length - 1],
        universe: { kind: "custom", symbols: panel.symbols }, initialCash: 1_000_000, cost: p.cost ?? {},
      }, (v) => makeTopNSelector(mats, v), "topN", topNValues);
    }

    // ---- 写回策略库（如果指定了策略） ----
    if (p.strategyKey) {
      const st = await getStrategy(p.strategyKey, p.strategyVersion || undefined);
      if (st) {
        await updateStrategyState(st.id, { metrics: metrics as Record<string, unknown>, backtest: { experimentId: experiment.id, asOf, periodDays, validation } });
      }
    }

    ctx.progress(95, "收尾", "保存实验结果…");
    const result = {
      asOf, dataSource: source,
      panel: { symbols: panel.symbols.length, dates: panel.dates.length, coverageNotes: panel.coverageNotes },
      metrics, segments,
      blockedOrders: engine.blockedOrders,
      equityCurvePreview: engine.equityCurve.filter((_, i) => i % Math.max(1, Math.floor(engine.equityCurve.length / 120)) === 0),
      tradeCount: engine.trades.length,
      validation, paramStability,
      compositeScore: compositeScore(metrics),
    };
    await finishExperiment(experiment.id, { status: "done", result: { metrics, verdict: validation?.verdict ?? "skipped" } as Record<string, unknown> });
    ctx.progress(100, "完成", `年化 ${((metrics.annualReturn ?? 0) * 100).toFixed(1)}% Sharpe ${(metrics.sharpe ?? 0).toFixed(2)} MDD ${((metrics.maxDrawdown ?? 0) * 100).toFixed(1)}%`);
    return result;
  });

  // ============ 选股任务（quant_selection：live 或历史回放） ============
  registerRunner("quant_selection", async (ctx: JobCtx) => {
    const p = ctx.payload as SelectionJobPayload;
    const provider = await getProvider(p.source ?? "em");
    const request = await resolveSelectionRequest(p);

    ctx.progress(20, "选股", `执行${p.replay ? "历史回放" : "选股"}（留档日=${request.asOf}）…`);
    if (p.replay) {
      const outcome = await runSelectionReplay(provider, request, p.horizon ?? 5);
      // 回放实验记录
      const parts: ExperimentParts = {
        kind: "selection_replay", dataRange: request.asOf,
        stockPool: request.universe as Record<string, unknown>,
        factorVersions: (request.factors ?? []).map((f) => `${f.factorKey}@${f.version}`).join(","),
        strategyVersion: p.strategyKey ?? "",
        parameters: { replay: true, horizon: p.horizon ?? 5, selection: request },
      };
      const fp = experimentFingerprint(parts);
      const existing = await findExperimentByFingerprint(fp);
      if (!existing) {
        const exp = await createExperiment({ ...newExperimentRecord(parts), jobId: ctx.jobId });
        await finishExperiment(exp.id, { status: "done", result: { stats: outcome.stats, picks: outcome.picks.length } as Record<string, unknown> });
      }
      ctx.progress(100, "完成", `回放完成：${outcome.picks.length} 只，胜率 ${(outcome.stats.winRate ?? 0 * 100).toFixed(0)}%`);
      return outcome;
    }
    const result = await runSelection({ provider, request });
    ctx.progress(100, "完成", `选出 ${result.rows.length} 只`);
    return result;
  });

  // ============ Agent 自主研究（quant_research，Phase 11） ============
  registerRunner("quant_research", async (ctx: JobCtx) => {
    const p = ctx.payload as ResearchPayload;
    const goal = p.goal ?? "研究一个A股短线选股策略";
    const source = p.source ?? "demo";
    const asOf = p.asOf ?? new Date().toISOString().slice(0, 10);
    const lookback = Math.min(400, p.lookback ?? 320);
    const maxSymbols = Math.min(200, p.maxSymbols ?? (source === "demo" ? 60 : 100));
    const pipeline: { step: string; detail: string }[] = [];
    const step = async (n: number, name: string, detail: string, pct: number) => {
      pipeline.push({ step: `${n}`, detail: `${name}: ${detail}` });
      ctx.progress(pct, name, detail);
    };

    // 1-3 查询已有因子/实验/策略 + 知识库
    const knowledge = await listKnowledge({ activeOnly: true });
    const researchCtx = buildResearchContext(knowledge);
    await step(1, "知识库", `查询 ${knowledge.length} 条知识（${researchCtx.avoidNotes.length} 条避免重复项）`, 4);
    const existingFactors = await listLatestFactors();
    await step(2, "已有因子", `${existingFactors.length} 个`, 6);
    await step(3, "已有策略与实验", "查询完成", 8);

    // 4 研究空白判断（确定性版本：排除知识库标记无效的因子类别/键；LLM 增强见下）
    const avoidKeys = new Set(researchCtx.invalidFactors.map((s) => s.split(" — ")[0]));
    await step(4, "研究空白", `规避 ${avoidKeys.size} 个已证伪因子`, 10);

    // 5 生成候选因子
    const provider = await getProvider(source);
    const panel = await buildPanel(provider, { universe: { kind: "all" }, asOf, lookback, maxSymbols });
    if (panel.dates.length < 80) throw new Error(`样本时间过短（${panel.dates.length} 日）`);
    const candidates = expandTemplates().filter((c) => !avoidKeys.has(c.factorKey));
    await step(5, "候选生成", `${candidates.length} 个候选（面板 ${panel.symbols.length} 股 × ${panel.dates.length} 日）`, 14);

    // 6-8 初筛/验证/淘汰（漏斗）
    const config: MiningConfig = { ...DEFAULT_MINING_CONFIG, ...p.mining };
    const tracker = makeAcceptedTracker();
    const miningResults: CandidateResult[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (ctx.paused() || ctx.cancelled()) {
        ctx.saveCheckpoint({ pipeline, candidateIndex: i });
        return JOB_PAUSED; // 分片边界暂停（恢复后从知识库/因子库现状继续）
      }
      const { result } = evaluateCandidate(candidates[i], panel, config, tracker);
      miningResults.push(result);
      ctx.progress(14 + Math.round(((i + 1) / candidates.length) * 36), "因子漏斗", `[${i + 1}/${candidates.length}] ${result.candidate.factorKey}: ${result.status}`);
    }
    const passed = miningResults.filter((r) => r.status === "accepted");
    {
      // 挖掘实验（指纹去重，供后续研究避免重复）
      const mParts: ExperimentParts = {
        kind: "mining", dataRange: `${panel.dates[0]}~${panel.dates[panel.dates.length - 1]}`,
        stockPool: { kind: "all", maxSymbols, source },
        factorVersions: "funnel:" + candidates.length,
        parameters: { config, goal },
      };
      const mFp = experimentFingerprint(mParts);
      if (!(await findExperimentByFingerprint(mFp))) {
        const mExp = await createExperiment({ ...newExperimentRecord(mParts), jobId: ctx.jobId });
        await finishExperiment(mExp.id, {
          status: "done",
          result: { generated: candidates.length, accepted: passed.length, keys: passed.map((r) => r.candidate.factorKey) } as Record<string, unknown>,
        });
      }
    }
    await step(6, "初筛", `通过 ${passed.length}/${candidates.length}`, 52);
    await step(7, "因子验证", passed.map((r) => r.candidate.factorKey).slice(0, 6).join(", ") || "无通过因子", 54);
    await step(8, "淘汰", `${candidates.length - miningResults.filter((r) => r.status === "accepted").length} 个被淘汰，均有失败原因`, 56);

    // 知识库沉淀：无效因子
    for (const r of miningResults.filter((r) => r.status === "rejected_preliminary").slice(0, 10)) {
      await addKnowledge({
        kind: "invalid_factor", title: r.candidate.factorKey,
        content: `RankIC=${r.metrics?.rankIc.toFixed(4)} ICIR=${r.metrics?.icIr.toFixed(3)} — ${r.reason}`,
        tags: ["mining", source],
      });
    }

    if (!passed.length) {
      // 实验失败 → 必须给出结构化失败报告
      const failure = {
        reason: "所有候选因子未通过初筛/精筛",
        evidence: `共 ${candidates.length} 个候选；初筛阈值 |RankIC|≥${config.preliminary.minAbsRankIc}，ICIR≥${config.preliminary.minIcIr}`,
        failedMetric: "rankIc/icIr/stability",
        overfitPossible: miningResults.some((r) => r.metrics && Math.abs(r.metrics.rankIc) > 0.06 && r.metrics.icIr > 1.5 && r.metrics.stability < 0.4),
        nextSuggestions: [
          "放宽初筛阈值重跑（调整 preliminary.minAbsRankIc 至 0.01）",
          "扩大样本（maxSymbols/lookback）以降低截面噪声",
          "尝试因子组合（combineFactors）而非单因子",
          "检查市场环境：分段评估是否处于单边行情",
        ],
      };
      await addKnowledge({ kind: "market_env", title: `研究失败 ${asOf}`, content: JSON.stringify(failure), tags: ["failure"] });
      await step(21, "失败报告", JSON.stringify(failure.reason), 100);
      return { goal, pipeline, status: "failed", failure, funnel: { candidates: candidates.length, preliminary: 0, fine: 0, backtest: 0, validated: 0 } };
    }

    // 9-10 组合有效因子 → 生成策略
    const strategyKey = `research_${asOf.replaceAll("-", "")}_${Math.random().toString(36).slice(2, 6)}`;
    const factorRefs = passed.slice(0, 4).map((r) => ({ factorKey: r.candidate.factorKey, version: 1, weight: 1, direction: (r.metrics!.rankIc >= 0 ? 1 : -1) as 1 | -1 }));
    // 先入库通过因子（版本化）
    for (const r of passed.slice(0, 4)) {
      const existing = await getFactor(r.candidate.factorKey);
      if (!existing || existing.expression !== r.normalizedExpression) {
        const rec = await saveFactorVersion({
          factorKey: r.candidate.factorKey, name: r.candidate.name, category: r.candidate.category,
          expression: r.normalizedExpression, params: r.candidate.params, dataSource: source,
          dataRange: `${panel.dates[0]}~${panel.dates[panel.dates.length - 1]}`,
          metrics: trimToFactorMetrics(r.metrics), status: "Validated",
          note: `自主研究通过：${r.reason}`,
        });
        const idx = factorRefs.findIndex((f) => f.factorKey === r.candidate.factorKey);
        if (idx >= 0) factorRefs[idx].version = rec.version;
      } else {
        const idx = factorRefs.findIndex((f) => f.factorKey === r.candidate.factorKey);
        if (idx >= 0) factorRefs[idx].version = existing.version;
      }
    }
    const strategy = await saveStrategyVersion({
      strategyKey, name: `自主研究 ${goal}`.slice(0, 40), kind: "multi_factor",
      factorRefs,
      selection: { scoring: { method: "rank", topN: 10 }, universe: { kind: "all" }, filters: { excludeST: true, excludeSuspended: true, minListDays: 120 } },
      backtest: { periodDays: lookback, rebalanceEvery: 5, cost: {} },
      status: "Research",
      note: "Agent 自主研究生成",
    });
    await step(9, "因子组合", factorRefs.map((f) => f.factorKey).join(" + "), 58);
    await step(10, "策略生成", `${strategyKey}@${strategy.version}`, 60);

    // 11 历史选股回放（同一选股引擎）
    const replayAsOf = panel.dates[Math.max(0, panel.dates.length - 41)]; // 约 2 个月前
    const replayRequest = {
      mode: "multi_factor" as const, asOf: replayAsOf,
      universe: { kind: "all" as const }, filters: { excludeST: true, excludeSuspended: true },
      factors: factorRefs.map((f) => ({ ...f, expression: passed.find((r) => r.candidate.factorKey === f.factorKey)!.normalizedExpression })),
      scoring: { method: "rank" as const, topN: 10 },
    };
    const replay = await runSelectionReplay(provider, replayRequest, 5);
    await step(11, "历史回放", `留档日=${replayAsOf}，选中 ${replay.picks.length} 只，${replay.horizon} 日胜率 ${((replay.stats.winRate ?? 0) * 100).toFixed(0)}%`, 66);

    // 12-15 回测 + Walk-forward + OOS + 稳定性
    ctx.progress(68, "回测", "组合回测…");
    const btPanel: BacktestPanel = { dates: panel.dates, symbols: panel.symbols, names: panel.meta.map((m) => m.name), fields: panel.fields };
    const mats = factorRefs.map((ref) => ({
      ref,
      mat: evaluateAst(parseExpression(passed.find((r) => r.candidate.factorKey === ref.factorKey)!.normalizedExpression), panel),
    }));
    const selector = makeTopNSelector(mats, 10);
    const btConfig: import("@/lib/quant/types").BacktestConfig = {
      mode: "universe" as const, tf: "day" as const, startDate: panel.dates[0], endDate: panel.dates[panel.dates.length - 1],
      universe: { kind: "custom", symbols: panel.symbols }, initialCash: 1_000_000, cost: {}, split: { train: 0.6, validation: 0.2, test: 0.2 },
    };
    const engine = runBacktestEngine(btPanel, selector, btConfig);
    const metrics = computeMetrics(engine, 1_000_000);
    {
      const bParts: ExperimentParts = {
        kind: "backtest", dataRange: `${panel.dates[0]}~${panel.dates[panel.dates.length - 1]}`,
        stockPool: { kind: "all", maxSymbols, source },
        factorVersions: factorRefs.map((f) => `${f.factorKey}@${f.version}`).join(","),
        strategyVersion: `${strategyKey}@${strategy.version}`,
        parameters: { topN: 10, rebalanceEvery: 5 },
        backtestParameters: { periodDays: lookback },
      };
      const bFp = experimentFingerprint(bParts);
      if (!(await findExperimentByFingerprint(bFp))) {
        const bExp = await createExperiment({ ...newExperimentRecord(bParts), jobId: ctx.jobId });
        await finishExperiment(bExp.id, { status: "done", result: { metrics } as Record<string, unknown> });
      }
    }
    await step(12, "完整回测", `年化 ${((metrics.annualReturn ?? 0) * 100).toFixed(1)}% Sharpe ${(metrics.sharpe ?? 0).toFixed(2)} MDD ${((metrics.maxDrawdown ?? 0) * 100).toFixed(1)}% 交易 ${metrics.tradeCount} 次`, 76);
    const validation = validateStrategy(btPanel, selector, btConfig, { walkForwardFolds: 3, oosRatio: 0.3 });
    await step(13, "Walk-forward", `${validation.walkForward.length} 折，样本外为正 ${validation.walkForward.filter((f) => (f.oosAnnual ?? 0) > 0).length} 折`, 84);
    await step(14, "OOS", `IS 年化 ${((validation.oos.isMetrics.annualReturn ?? 0) * 100).toFixed(1)}% → OOS ${((validation.oos.oosMetrics.annualReturn ?? 0) * 100).toFixed(1)}%（衰减比 ${(validation.oos.decayRatio * 100).toFixed(0)}%）`, 88);
    const paramStab = scanParameterStability(btPanel, btConfig, (v) => makeTopNSelector(mats, v), "topN", [5, 10, 15, 20]);
    await step(15, "稳定性分析", `topN 参数：${paramStab.verdict === "stable" ? "稳定" : "不稳定"}`, 90);

    // 16-17 保存策略并按验证结论推进生命周期
    await updateStrategyState(strategy.id, {
      metrics: metrics as Record<string, unknown>,
      status: validation.verdict === "fail" ? "Research" : "Validated",
      backtest: { experiment: "auto", validation, paramStability: paramStab, replay: { asOf: replayAsOf, winRate: replay.stats.winRate } },
    });
    await step(16, "保存策略", `${strategyKey}@${strategy.version} → ${validation.verdict === "fail" ? "Research（验证未过）" : "Validated"}`, 93);
    await step(17, "策略库", "已加入策略库", 94);

    // 18 Live Selection（只有通过验证的策略才做正式选股）
    let liveSelection: Awaited<ReturnType<typeof runSelection>> | null = null;
    if (validation.verdict !== "fail" && canEnterOfficialSelection("Validated")) {
      const liveReq = { ...replayRequest, asOf: panel.dates[panel.dates.length - 1] };
      liveSelection = await runSelection({ provider, request: liveReq });
      await step(18, "实时选股", `选出 ${liveSelection.rows.length} 只：${liveSelection.rows.slice(0, 5).map((r) => r.code).join(", ")}`, 96);
    } else {
      await step(18, "实时选股", "验证未通过，跳过正式选股（Candidate/Research 不得进入正式流程）", 96);
    }

    // 19-20 Monitoring 与知识沉淀
    await addKnowledge({ kind: "current_strategy", title: strategyKey, content: `因子：${factorRefs.map((f) => f.factorKey).join(",")}；年化 ${((metrics.annualReturn ?? 0) * 100).toFixed(1)}%；Sharpe ${(metrics.sharpe ?? 0).toFixed(2)}；验证 ${validation.verdict}`, tags: ["research"] });
    await step(19, "监控", "策略纳入监控清单（Monitoring 定期复评，性能退化 → Degraded → 重新研究）", 98);
    await step(20, "知识沉淀", "有效因子/结论已写入知识库", 100);

    return {
      goal, pipeline, status: "done",
      strategy: { strategyKey, version: strategy.version, status: validation.verdict === "fail" ? "Research" : "Validated" },
      metrics, validation: { verdict: validation.verdict, flags: validation.overfitFlags },
      paramStability: paramStab,
      replay: { asOf: replayAsOf, winRate: replay.stats.winRate, avg: replay.stats.avgForwardReturn },
      liveSelection: liveSelection ? { rows: liveSelection.rows.slice(0, 20), warnings: liveSelection.warnings } : null,
      funnel: { candidates: candidates.length, preliminary: passed.length, fine: passed.length, backtest: 1, validated: validation.verdict === "fail" ? 0 : 1 },
    };
  });
}

// ---------- 辅助 ----------

export interface ResearchPayload {
  goal?: string; source?: string; asOf?: string; lookback?: number; maxSymbols?: number;
  mining?: Record<string, unknown>;
}

export interface BacktestPayload {
  source?: string; kind?: "all" | "custom" | "industry" | "concept"; boardCode?: string; symbols?: string[];
  asOf?: string; periodDays?: number; maxSymbols?: number;
  factors?: { factorKey: string; version?: number; weight?: number; direction?: 1 | -1 }[];
  strategyKey?: string; strategyVersion?: number;
  topN?: number; rebalanceEvery?: number; scoring?: string;
  cost?: Record<string, number>; constraints?: Record<string, unknown>; split?: { train: number; validation: number; test: number };
  validate?: boolean;
  walkForwardFolds?: number; oosRatio?: number;
}

function vcfgFromPayload(p: BacktestPayload): { walkForwardFolds?: number; oosRatio?: number } {
  return { walkForwardFolds: p.walkForwardFolds ?? 3, oosRatio: p.oosRatio ?? 0.3 };
}

function makeTopNSelector(mats: { ref: { factorKey: string; weight: number; direction: number }; mat: (number | null)[][] }[], topN: number): PositionSelector {
  return {
    name: `top${topN}`,
    select: (view) => {
      const scores = new Map<string, number>();
      for (const { ref, mat } of mats) {
        const col = mat.map((row) => row[Math.min(view.t, row.length - 1)]);
        const nums = col.filter((v): v is number => v !== null);
        if (nums.length < 10) continue;
        const sorted = [...nums].sort((a, b) => a - b);
        col.forEach((val, si) => {
          if (val === null) return;
          let lo = 0;
          for (const s of sorted) if (s < val) lo++;
          scores.set(view.symbols[si], (scores.get(view.symbols[si]) ?? 0) + (lo / Math.max(1, sorted.length - 1)) * ref.direction * (ref.weight || 1));
        });
      }
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      const out = new Map<string, number>();
      for (const [sym] of ranked) out.set(sym, 1 / Math.max(1, ranked.length));
      return out;
    },
  };
}

function trimToFactorMetrics(m: ReturnType<typeof trimMetrics> | undefined): Record<string, unknown> {
  if (!m) return {};
  return {
    ic: m.ic, rankIc: m.rankIc, icIr: m.icIr, icPositiveRatio: m.icPositiveRatio,
    groupReturn: m.groupReturn, longShortReturn: m.longShortReturn,
    turnover: m.turnover, stability: m.stability, decay: m.decay ?? undefined,
    correlation: m.correlation,
  };
}

export interface SelectionJobPayload {
  source?: string; replay?: boolean; horizon?: number;
  mode?: "rule" | "factor" | "multi_factor" | "strategy";
  asOf?: string; universe?: { kind: "all" | "custom" | "industry" | "concept"; boardCode?: string; symbols?: string[] };
  filters?: Record<string, unknown>; factors?: { factorKey: string; version?: number; weight?: number; direction?: 1 | -1 }[];
  scoring?: { method?: "rank" | "zscore" | "minmax"; topN?: number };
  rules?: { key: string; params: Record<string, unknown> }[];
  strategyKey?: string; strategyVersion?: number;
  enforceLifecycle?: boolean; // 默认 true：正式选股要求 Validated/Paper/Live
}

async function resolveSelectionRequest(p: SelectionJobPayload) {
  const base = {
    mode: p.mode ?? "multi_factor",
    asOf: p.asOf ?? new Date().toISOString().slice(0, 10),
    universe: p.universe ?? { kind: "all" as const },
    filters: p.filters ?? { excludeST: true, excludeSuspended: true },
    scoring: { method: p.scoring?.method ?? "rank", topN: p.scoring?.topN ?? 20 },
    rules: p.rules,
    strategyKey: p.strategyKey,
    strategyVersion: p.strategyVersion,
    dataSource: p.source ?? "em",
  };
  if (p.mode === "strategy" || p.strategyKey) {
    const st = await getStrategy(p.strategyKey!, p.strategyVersion || undefined);
    if (!st) throw new Error(`策略不存在：${p.strategyKey}`);
    // 生命周期门禁：Candidate/Research 只能研究和模拟；Retired 禁止正式信号
    if ((p.enforceLifecycle ?? true) && !canEnterOfficialSelection(st.status)) {
      throw new LifecycleError(`策略 ${st.strategyKey}@${st.version} 状态为 ${st.status}，不允许进入正式选股流程（需 Validated/Paper/Live）`);
    }
    const factors: SelectionFactorRef[] = [];
    for (const ref of st.factorRefs) {
      const f = await getFactor(ref.factorKey, ref.version);
      if (f) factors.push({ factorKey: f.factorKey, version: f.version, weight: ref.weight, direction: ref.direction, expression: f.expression });
    }
    return { ...base, mode: "multi_factor" as const, factors, ...({} as Record<string, unknown>) };
  }
  const factors: SelectionFactorRef[] = [];
  for (const ref of p.factors ?? []) {
    const f = await getFactor(ref.factorKey, ref.version || undefined);
    if (!f) throw new Error(`因子不存在：${ref.factorKey}@${ref.version ?? "latest"}`);
    factors.push({ factorKey: f.factorKey, version: f.version, weight: ref.weight ?? 1, direction: ref.direction ?? 1, expression: f.expression });
  }
  return { ...base, factors };
}

export { compareStrategies };
