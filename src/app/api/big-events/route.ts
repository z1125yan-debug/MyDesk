// GET /api/big-events — 实时判定一次大事件（不落档、不记账，只返回本次判定出的提醒）。
// POST /api/big-events — 检查 + 按 dedupeKey 去重 + 归档新增提醒 + task_run 记账（与调度器共用 runBigEventCheck）。
//   同日同类同主体只发一次；重复检查不再产生新提醒。
// 触发条件（见 weekly-report-core.ts）：美联储议息、重磅政策、板块突然暴涨/暴跌（≥5%）、
//   某只重点票突然涨停/跌停（主线龙头 / AI 选的票 / 20cm 真封板）、大盘暴涨/暴跌（收盘后 ≥3%）。
// 提醒格式：事件是什么、方向、影响、重点看什么。只报重点，日常首板/普通新闻不触发。

import { NextResponse } from "next/server";
import { checkBigEvents, runBigEventCheck } from "@/lib/desk/weekly-report";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const alerts = await checkBigEvents();
    return NextResponse.json({ ok: true, date: shanghaiDate(), alerts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `大事件判定失败：${(e as Error).message}` }, { status: 502 });
  }
}

export async function POST() {
  try {
    const r = await runBigEventCheck({ trigger: "manual" });
    return NextResponse.json({ ok: true, date: r.date, alerts: r.alerts, new_alerts: r.newAlerts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `大事件检查失败：${(e as Error).message}` }, { status: 502 });
  }
}
