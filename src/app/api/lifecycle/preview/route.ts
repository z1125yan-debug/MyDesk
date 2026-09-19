// GET /api/lifecycle/preview — 数据生命周期的 dry-run 预览（P5 第五阶段，全程只读）
//
// 本路由只做三件事：数一遍库里有哪些天已满 180 天、把这些天的行「列出来」不动它们、给一个执行闸门用的指纹。
// 真正会删数据的是 POST /api/lifecycle/purge，它必须带回本接口返回的 plan_hash 才可能执行。
//
// 保留天数不提供查询参数：180 是用户在 2026-09-19 定下的数据策略，接口能随手改天数就等于任何一次调用
// 都能替用户改写这个决定（见 lifecycle-core 的 RETENTION_DECISION）。
import { NextResponse } from "next/server";
import {
  noCandidateNote, policyNotes, runTablesNote, stateAgnosticNote,
} from "@/lib/quant/screener/lifecycle-core";
import { currentPlan } from "@/lib/quant/screener/lifecycle-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { plan, totalRows, expired } = await currentPlan();
    const missing: string[] = [];
    if (!plan.candidates.length) missing.push(noCandidateNote(plan, totalRows));
    return NextResponse.json({
      ok: true,
      kind: "lifecycle",
      today: plan.today,
      retention_days: plan.retention_days,
      cutoff: plan.cutoff,
      basis: plan.basis,
      policy_notes: policyNotes(plan),
      state_note: stateAgnosticNote(),
      totals: plan.totals,
      candidates: plan.candidates,
      protected_days: plan.protected_days,
      plan_hash: plan.plan_hash,
      can_execute: plan.candidates.length > 0,
      detail_rows_in_db: totalRows,
      run_tables: { expired, note: runTablesNote(expired) },
      missing,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `生命周期预览失败：${(e as Error).message}` }, { status: 502 });
  }
}
