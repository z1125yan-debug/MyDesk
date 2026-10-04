// Quant Research Lab — 选股 API（Phase 7）：实时选股与历史回放共用 Selection Engine
import { NextResponse } from "next/server";
import { shanghaiDate } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { registerStrategyRunners } from "@/lib/quant/jobs/runners/strategy-jobs";
import { getJob, startJob } from "@/lib/quant/jobs/registry";
import type { SelectionJobPayload } from "@/lib/quant/jobs/runners/strategy-jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  quantBootstrap();
  registerStrategyRunners();
  const body = (await request.json().catch(() => ({}))) as SelectionJobPayload;
  if (body.mode === "strategy" && !body.strategyKey) {
    return NextResponse.json({ error: "strategy 模式需要 strategyKey" }, { status: 400 });
  }
  if (body.replay && (!body.asOf || body.asOf >= shanghaiDate())) {
    return NextResponse.json({ error: "历史回放需要指定早于今天的 asOf" }, { status: 400 });
  }
  const { job } = startJob({
    kind: "quant_selection",
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
  return NextResponse.json({ error: "需要 jobId" }, { status: 400 });
}
