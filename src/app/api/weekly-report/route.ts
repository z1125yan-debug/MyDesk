// GET /api/weekly-report?week=YYYY-MM-DD — 周报（周日晚上发的那份）
//   week 缺省 = 本周的周日；归档存在先读归档（data/weekly-reports/<周日>.json），
//   没有则现算（不落档；落档走 POST / 调度器）。
// POST /api/weekly-report { week?, force? } — 手动生成 + 归档 + task_run 记账（与调度器共用 runWeeklyReportTask）。
//   force=true 才重跑本周已有 success 的周报。
// 只报重点：主线 + AI 选的 + 风险 + 涨停龙头；缺数据写“没取到”，不编。

import { NextResponse } from "next/server";
import {
  fetchWeeklyReport,
  loadArchivedWeeklyReport,
  runWeeklyReportTask,
} from "@/lib/desk/weekly-report";
import { weekRangeOf } from "@/lib/desk/weekly-report-core";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const week = new URL(req.url).searchParams.get("week") ?? undefined;
  if (week !== undefined && !DATE_RE.test(week)) {
    return NextResponse.json({ ok: false, error: `week 非法：${week}，应为 YYYY-MM-DD` }, { status: 400 });
  }
  const sunday = weekRangeOf(week ?? shanghaiDate()).sunday;
  try {
    const archived = loadArchivedWeeklyReport(sunday);
    if (archived) {
      return NextResponse.json({ ok: true, archived: true, generated_at: archived.generatedAt, report: archived.report });
    }
    const report = await fetchWeeklyReport(sunday);
    return NextResponse.json({ ok: true, archived: false, report });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `周报读取失败：${(e as Error).message}` }, { status: 502 });
  }
}

export async function POST(req: Request) {
  let body: { week?: string; force?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* 允许空 body */
  }
  if (body.week !== undefined && !DATE_RE.test(body.week)) {
    return NextResponse.json({ ok: false, error: `week 非法：${body.week}，应为 YYYY-MM-DD` }, { status: 400 });
  }
  try {
    const r = await runWeeklyReportTask({ sunday: body.week, force: body.force === true, trigger: "manual" });
    return NextResponse.json({ ok: r.status === "success", status: r.status, reason: r.reason ?? null, file: r.file ?? null, report: r.report });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `周报生成失败：${(e as Error).message}` }, { status: 502 });
  }
}
