// Quant Research Lab — 回测 API（Phase 5/6）：启动回测任务 / 查询
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { registerStrategyRunners } from "@/lib/quant/jobs/runners/strategy-jobs";
import { findByFingerprint, getJob, listJobs, startJob } from "@/lib/quant/jobs/registry";
import { experimentFingerprint } from "@/lib/quant/research/experiments";
import type { BacktestPayload } from "@/lib/quant/jobs/runners/strategy-jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  quantBootstrap();
  registerStrategyRunners();
  const body = (await request.json().catch(() => ({}))) as BacktestPayload;
  if (!body.factors?.length && !body.strategyKey) {
    return NextResponse.json({ error: "需要 factors 或 strategyKey" }, { status: 400 });
  }
  const fp = experimentFingerprint({
    kind: "backtest",
    dataRange: `${body.asOf ?? ""} 前 ${body.periodDays ?? 240} 交易日`,
    stockPool: { kind: body.kind ?? "all", boardCode: body.boardCode ?? "", maxSymbols: body.maxSymbols ?? 80 },
    factorVersions: (body.factors ?? []).map((f) => `${f.factorKey}@${f.version ?? 0}`).join(","),
    strategyVersion: body.strategyKey ?? "",
    parameters: { topN: body.topN ?? 10, rebalanceEvery: body.rebalanceEvery ?? 5 },
    backtestParameters: { periodDays: body.periodDays ?? 240, split: body.split ?? null },
    transactionCost: body.cost ?? {},
  });
  const existing = findByFingerprint("quant_backtest", fp, ["queued", "running", "paused"]);
  if (existing) return NextResponse.json({ jobId: existing.id, duplicate: true, message: "相同回测任务已在进行中" });
  const { job } = startJob({ kind: "quant_backtest", fingerprint: fp, payload: body as Record<string, unknown> });
  return NextResponse.json({ jobId: job.id });
}

export async function GET(request: Request) {
  quantBootstrap();
  registerStrategyRunners();
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (jobId) {
    const job = getJob(jobId);
    if (!job) return NextResponse.json({ error: `任务不存在：${jobId}` }, { status: 404 });
    return NextResponse.json({ job });
  }
  return NextResponse.json({ jobs: listJobs({ kind: "quant_backtest" }).slice(0, 20) });
}
