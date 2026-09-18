// Quant Research Lab — 因子挖掘任务执行器（服务端）
// 组装面板 → 逐候选漏斗评估（断点续跑）→ 通过者按版本入库（Candidate 状态）。
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { buildPanel } from "@/lib/quant/factors/panel";
import { expandTemplates, type CandidateFactor } from "@/lib/quant/factors/templates";
import {
  evaluateCandidate, makeAcceptedTracker, DEFAULT_MINING_CONFIG,
  type MiningConfig, type CandidateResult,
} from "@/lib/quant/factors/mining";
import { parseExpression, evaluateAst } from "@/lib/quant/factors/expression";
import { registerRunner, type JobCtx } from "@/lib/quant/jobs/registry";
import { listLatestFactors, getFactor, saveFactorVersion } from "@/lib/quant/store";
import { toFactorMetrics } from "@/lib/quant/factors/mining";
import type { FactorMetrics } from "@/lib/quant/types";

export interface MiningJobPayload {
  source?: string; // em | demo
  kind?: "all" | "custom" | "industry" | "concept";
  boardCode?: string;
  symbols?: string[];
  asOf?: string; // 默认今天
  lookback?: number; // 交易日数，默认 240
  maxSymbols?: number; // 默认 120
  limit?: number; // 候选上限，默认 40（资源控制）
  config?: Partial<MiningConfig>;
  autoSave?: boolean; // 是否把通过者入库（默认 true）
}

function fingerprintOf(p: MiningJobPayload): string {
  const norm = {
    s: p.source ?? "em", k: p.kind ?? "all", b: p.boardCode ?? "", y: p.symbols ?? [],
    a: p.asOf ?? "", l: p.lookback ?? 240, m: p.maxSymbols ?? 120,
    lim: p.limit ?? 40, h: p.config?.horizon ?? DEFAULT_MINING_CONFIG.horizon,
  };
  return "mining:" + Buffer.from(JSON.stringify(norm)).toString("base64url");
}

let registered = false;

export function registerMiningRunner(): void {
  quantBootstrap();
  if (registered) return;
  registered = true;

  registerRunner("quant_mining", async (ctx: JobCtx) => {
    const payload = ctx.payload as MiningJobPayload;
    const asOf = payload.asOf ?? new Date().toISOString().slice(0, 10);
    const lookback = Math.min(500, payload.lookback ?? 240);
    const maxSymbols = Math.min(300, payload.maxSymbols ?? 120);
    const limit = Math.min(80, payload.limit ?? 40);
    const config: MiningConfig = { ...DEFAULT_MINING_CONFIG, ...payload.config };
    const autoSave = payload.autoSave !== false;

    ctx.progress(2, "面板", "加载已有因子库（冗余基准）…");
    const existingFactors = await listLatestFactors();
    const baselineKeys = existingFactors.slice(0, 40).map((f) => f.factorKey);

    ctx.progress(4, "面板", `构建研究面板（${payload.source ?? "em"} / ${payload.kind ?? "all"} / 截至 ${asOf}）…`);
    const provider = await getProvider(payload.source ?? "em");
    const panel = await buildPanel(provider, {
      universe: { kind: payload.kind ?? "all", boardCode: payload.boardCode, symbols: payload.symbols },
      asOf, lookback, maxSymbols,
    });
    if (panel.symbols.length < 15) {
      throw new Error(`样本股票过少（${panel.symbols.length} 只 < 15），截面统计不可靠，已中止`);
    }
    if (panel.dates.length < 60) {
      throw new Error(`样本时间过短（${panel.dates.length} 日 < 60），无法评估因子，已中止`);
    }

    // 冗余基准矩阵：把已有因子在当前面板上重新求值
    ctx.progress(6, "面板", `重算 ${baselineKeys.length} 个已有因子作相关性基准…`);
    const extraBaseline: { factorKey: string; mat: (number | null)[][] }[] = [];
    for (const f of existingFactors.slice(0, 40)) {
      try {
        const mat = evaluateAst(parseExpression(f.expression), panel);
        extraBaseline.push({ factorKey: f.factorKey, mat });
      } catch { /* 旧因子字段缺失等，忽略 */ }
    }

    // 候选生成
    const candidates: CandidateFactor[] = expandTemplates().slice(0, limit);
    ctx.progress(8, "评估", `共 ${candidates.length} 个候选因子，开始漏斗评估…`);

    // 断点恢复：已完成候选结果直接复用；accepted 需重算矩阵以重建相关性基准
    const cp = ctx.loadCheckpoint();
    const doneResults: CandidateResult[] = (cp?.results as CandidateResult[] | undefined) ?? [];
    const doneKeys = new Set(doneResults.map((r) => r.candidate.factorKey));
    const tracker = makeAcceptedTracker();
    for (const prev of doneResults) {
      if (prev.status === "accepted") {
        try {
          const mat = evaluateAst(parseExpression(prev.normalizedExpression), panel);
          tracker.chosen.push({ factorKey: prev.candidate.factorKey, mat });
        } catch { /* 忽略 */ }
      }
    }

    const results: CandidateResult[] = [...doneResults];
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (!doneKeys.has(cand.factorKey)) {
        const { result, mat } = evaluateCandidate(cand, panel, config, tracker, extraBaseline);
        if (mat) tracker.chosen.push({ factorKey: cand.factorKey, mat });
        results.push(result);
        ctx.saveCheckpoint({ payload, results });
      }
      const r = results.find((x) => x.candidate.factorKey === cand.factorKey)!;
      ctx.progress(
        8 + Math.round(((i + 1) / candidates.length) * 82),
        "评估",
        `[${i + 1}/${candidates.length}] ${cand.factorKey}: ${r.status}`,
      );
    }

    // 漏斗统计
    const funnel = {
      generated: candidates.length,
      auditFailed: results.filter((r) => r.status === "rejected_audit").length,
      preliminaryFailed: results.filter((r) => r.status === "rejected_preliminary").length,
      redundant: results.filter((r) => r.status === "rejected_redundant").length,
      fineFailed: results.filter((r) => r.status === "rejected_fine").length,
      accepted: results.filter((r) => r.status === "accepted").length,
    };
    const accepted = results.filter((r) => r.status === "accepted").slice(0, config.save);

    // 入库（版本化 insert-only；表达式未变化的因子不重复入库）
    const saved: { factorKey: string; version: number; existed: boolean }[] = [];
    if (autoSave) {
      for (const acc of accepted) {
        const existing = await getFactor(acc.candidate.factorKey);
        if (existing && existing.expression === acc.normalizedExpression) {
          saved.push({ factorKey: acc.candidate.factorKey, version: existing.version, existed: true });
          continue;
        }
        const rec = await saveFactorVersion({
          factorKey: acc.candidate.factorKey,
          name: acc.candidate.name,
          category: acc.candidate.category,
          expression: acc.normalizedExpression,
          params: acc.candidate.params,
          dataSource: payload.source ?? "em",
          dataRange: `${panel.dates[0]}~${panel.dates[panel.dates.length - 1]}`,
          metrics: toFactorMetrics(acc.metrics) as FactorMetrics,
          status: "Candidate",
          note: `挖掘漏斗入库：${acc.reason}`,
        });
        saved.push({ factorKey: rec.factorKey, version: rec.version, existed: false });
      }
    }

    ctx.progress(100, "完成", `漏斗：${funnel.generated} 生成 → ${funnel.accepted} 通过 → ${saved.length} 入库`);
    return {
      asOf, dataSource: payload.source ?? "em",
      panel: { symbols: panel.symbols.length, dates: panel.dates.length, coverageNotes: panel.coverageNotes },
      funnel, saved,
      accepted: accepted.map((a) => ({ ...a, metrics: a.metrics })),
      rejected: results.filter((r) => r.status !== "accepted").map((r) => ({
        factorKey: r.candidate.factorKey, status: r.status, reason: r.reason,
        rankIc: r.metrics?.rankIc, icIr: r.metrics?.icIr,
      })),
    };
  });
}
