// Quant Research Lab — Agent 自主研究 API（Phase 11）
// POST 启动全流程研究任务；GET 查询进度与结构化结果（含失败报告）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { registerStrategyRunners } from "@/lib/quant/jobs/runners/strategy-jobs";
import { getJob, listJobs, startJob } from "@/lib/quant/jobs/registry";

export const dynamic = "force-dynamic";

interface ResearchPayload {
  goal?: string; source?: string; asOf?: string; lookback?: number; maxSymbols?: number;
  mining?: Record<string, unknown>;
}

export async function POST(request: Request) {
  quantBootstrap();
  registerStrategyRunners();
  const body = (await request.json().catch(() => ({}))) as ResearchPayload;
  const { job } = startJob({
    kind: "quant_research",
    fingerprint: `research:${body.goal ?? "default"}:${body.source ?? "demo"}:${body.asOf ?? ""}`,
    payload: body as Record<string, unknown>,
  });
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
  return NextResponse.json({ jobs: listJobs({ kind: "quant_research" }).slice(0, 10) });
}
