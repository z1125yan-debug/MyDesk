// Quant Research Lab — 因子挖掘：启动任务 / 查询进度与结果
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { registerMiningRunner } from "@/lib/quant/jobs/runners/mining";
import { findByFingerprint, getJob, startJob } from "@/lib/quant/jobs/registry";
import type { MiningJobPayload } from "@/lib/quant/jobs/runners/mining";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  quantBootstrap();
  registerMiningRunner();
  const body = (await request.json().catch(() => ({}))) as MiningJobPayload;
  if (body.source === "em" && (body.kind ?? "all") === "all" && (body.maxSymbols ?? 120) > 200) {
    return NextResponse.json({ error: "真实数据源挖掘单次样本 ≤ 200 只（防限流）" }, { status: 400 });
  }
  const fp = miningFingerprint(body);
  const existing = findByFingerprint("quant_mining", fp, ["queued", "running", "paused"]);
  if (existing) {
    return NextResponse.json({ jobId: existing.id, duplicate: true, message: "相同参数的挖掘任务已在进行中" });
  }
  const { job, duplicate } = startJob({ kind: "quant_mining", fingerprint: fp, payload: body as Record<string, unknown> });
  return NextResponse.json({ jobId: job.id, duplicate, job });
}

export async function GET(request: Request) {
  quantBootstrap();
  registerMiningRunner();
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (jobId) {
    const job = getJob(jobId);
    if (!job) return NextResponse.json({ error: `任务不存在：${jobId}` }, { status: 404 });
    return NextResponse.json({ job });
  }
  // 未指定 id：返回最近的任务列表
  const { listJobs } = await import("@/lib/quant/jobs/registry");
  return NextResponse.json({ jobs: listJobs({ kind: "quant_mining" }).slice(0, 20) });
}

function miningFingerprint(p: MiningJobPayload): string {
  const norm = {
    s: p.source ?? "em", k: p.kind ?? "all", b: p.boardCode ?? "", y: p.symbols ?? [],
    a: p.asOf ?? "", l: p.lookback ?? 240, m: p.maxSymbols ?? 120, lim: p.limit ?? 40,
    h: p.config?.horizon ?? 5,
  };
  return "mining:" + Buffer.from(JSON.stringify(norm)).toString("base64url");
}
