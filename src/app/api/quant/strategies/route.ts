// Quant Research Lab — 策略实验室 API（Phase 4）
// GET  策略列表；POST 创建策略变体（版本化）；POST compare 比较与淘汰
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { registerStrategyRunners } from "@/lib/quant/jobs/runners/strategy-jobs";
import { listStrategies, saveStrategyVersion, getStrategy } from "@/lib/quant/store";
import { compareStrategies, compositeScore, DEFAULT_ELIMINATION, type EliminationRules } from "@/lib/quant/strategies/evaluation";
import { STRATEGY_STATUSES } from "@/lib/quant/types";
import type { StrategyStatus } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  quantBootstrap();
  registerStrategyRunners();
  const url = new URL(request.url);
  const strategyKey = url.searchParams.get("key") ?? undefined;
  const status = url.searchParams.get("status") as StrategyStatus | null;
  if (strategyKey) {
    const strategy = await getStrategy(strategyKey);
    return NextResponse.json({ strategy });
  }
  const strategies = await listStrategies({ status: status ?? undefined });
  return NextResponse.json({
    strategies: strategies.map((s) => ({ ...s, compositeScore: compositeScore(s.metrics) })),
    statuses: STRATEGY_STATUSES,
  });
}

export async function POST(request: Request) {
  quantBootstrap();
  registerStrategyRunners();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "create";
  const body = await request.json().catch(() => ({}));

  if (action === "compare") {
    const items = (body.strategies ?? []) as { strategyKey: string; metrics: Record<string, number> }[];
    const rules = { ...DEFAULT_ELIMINATION, ...(body.rules ?? {}) } as EliminationRules;
    const verdicts = compareStrategies(items, rules).sort((a, b) => {
      const rank = { keep: 0, warning: 1, eliminate: 2 } as Record<string, number>;
      return rank[a.verdict] - rank[b.verdict];
    });
    return NextResponse.json({ verdicts });
  }

  // create：创建策略变体（版本化 insert-only）
  const { strategyKey, name, kind, factorRefs, selection, backtest, status, note } = body as {
    strategyKey?: string; name?: string; kind?: "rule" | "factor" | "multi_factor" | "combo";
    factorRefs?: { factorKey: string; version?: number; weight?: number; direction?: 1 | -1 }[];
    selection?: Record<string, unknown>; backtest?: Record<string, unknown>;
    status?: StrategyStatus; note?: string;
  };
  if (!strategyKey || !factorRefs?.length) {
    return NextResponse.json({ error: "需要 strategyKey 与至少一个 factorRefs" }, { status: 400 });
  }
  try {
    const strategy = await saveStrategyVersion({
      strategyKey,
      name: name || strategyKey,
      kind: kind ?? "multi_factor",
      factorRefs: factorRefs.map((rf) => ({ factorKey: rf.factorKey, version: rf.version ?? 1, weight: rf.weight ?? 1, direction: rf.direction ?? 1 })),
      selection,
      backtest,
      status: status ?? "Candidate",
      note: note ?? "Strategy Lab 创建",
    });
    return NextResponse.json({ strategy });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
