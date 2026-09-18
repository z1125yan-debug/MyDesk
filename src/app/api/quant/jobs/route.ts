// Quant Research Lab — 任务列表与控制
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { cancelJob, getJob, listJobs, pauseJob, resumeJob } from "@/lib/quant/jobs/registry";
import type { JobStatus } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? undefined;
  const status = (url.searchParams.get("status") ?? undefined) as JobStatus | undefined;
  const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50);
  const jobs = listJobs({ kind, status }).slice(0, limit);
  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!body.id || !body.action) {
    return NextResponse.json({ error: "需要 id 与 action（pause|resume|cancel）" }, { status: 400 });
  }
  if (!getJob(body.id)) {
    return NextResponse.json({ error: `任务不存在：${body.id}` }, { status: 404 });
  }
  let ok = false;
  if (body.action === "pause") ok = pauseJob(body.id);
  else if (body.action === "resume") ok = await resumeJob(body.id);
  else if (body.action === "cancel") ok = cancelJob(body.id);
  else return NextResponse.json({ error: `未知 action：${body.action}` }, { status: 400 });
  return NextResponse.json({ ok, job: getJob(body.id) ?? null });
}
