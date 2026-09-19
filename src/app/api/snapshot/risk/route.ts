// POST /api/snapshot/risk — 风险监控的每日留档（P5 第五阶段）
//
// 留档内容从哪来：本路由在服务端直接调用页面读的那同一个处理函数（@/app/api/market/risk/route 的 GET），
// 拿到响应后才写库。前端只发一个「留档」意图，不传任何数字 —— 否则任何人都能 POST 一份假的市场结果进正式库。
// 副作用照实说明：风险接口是实时算的，留档会真的去拉一次全A快照与指数行情（不是读缓存）。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiStamp } from "@/lib/desk/session";
import { GET as computeRisk } from "@/app/api/market/risk/route";
import { riskColumnsFrom, riskHeadline, snapshotBasis } from "@/lib/quant/screener/snapshot-core";
import { insertRiskSnapshot } from "@/lib/quant/screener/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST() {
  quantBootstrap();
  try {
    const computedAt = shanghaiStamp();
    const resp = await computeRisk();
    const payload = await resp.json() as Record<string, unknown>;
    const extracted = riskColumnsFrom(payload, computedAt);
    if (!extracted.ok) {
      return NextResponse.json({ ok: false, error: extracted.error, basis: snapshotBasis("risk") }, { status: 502 });
    }
    const row = await insertRiskSnapshot(db, computedAt, extracted.columns, payload);
    return NextResponse.json({
      ok: true,
      kind: "risk",
      id: String(row.id),
      trade_date: extracted.columns.tradeDate,
      computed_at: computedAt,
      headline: riskHeadline(payload, computedAt),
      missing: extracted.columns.missing,
      source: extracted.columns.source,
      basis: snapshotBasis("risk"),
      note: "同一天再点一次会新增一条留档（各次都是当时的真实计算结果），不会覆盖上一条。",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `风险留档失败：${(e as Error).message}` }, { status: 502 });
  }
}
