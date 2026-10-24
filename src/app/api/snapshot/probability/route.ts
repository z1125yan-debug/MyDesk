// POST /api/snapshot/probability — 条件概率结果的每日留档（P5 第五阶段）
//
// 概率页与另两页的差别：结果取决于「哪一组筛选条件」。所以留档必须连条件一起存，
// 请求体里只放行 conditions / universe / symbols / lookback / trade_date 五类字段（sanitizeProbabilityRequest），
// 计算仍在服务端调用页面同源的 POST /api/quant/probability 完成 —— 前端传上来的任何胜率数字都不入库。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiStamp } from "@/lib/desk/session";
import { POST as computeProbability } from "@/app/api/quant/probability/route";
import { probabilityColumnsFrom, probabilityHeadline, sanitizeProbabilityRequest, snapshotBasis } from "@/lib/quant/screener/snapshot-core";
import { insertProbabilitySnapshot } from "@/lib/quant/screener/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 200;

export async function POST(req: Request) {
  quantBootstrap();
  try {
    const body = await req.json().catch(() => null);
    const clean = sanitizeProbabilityRequest(body);
    if (typeof clean === "string") {
      return NextResponse.json({ ok: false, error: clean, basis: snapshotBasis("probability") }, { status: 400 });
    }
    const computedAt = shanghaiStamp();
    const resp = await computeProbability(new Request("http://127.0.0.1/api/quant/probability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clean),
    }));
    const payload = await resp.json() as Record<string, unknown>;
    const extracted = probabilityColumnsFrom(payload, clean, computedAt);
    if (!extracted.ok) {
      return NextResponse.json({ ok: false, error: extracted.error, basis: snapshotBasis("probability") }, { status: 502 });
    }
    const row = await insertProbabilitySnapshot(db, computedAt, extracted.columns, payload);
    return NextResponse.json({
      market: "A", market_label: "A股",
      ok: true,
      kind: "probability",
      id: String(row.id),
      trade_date: extracted.columns.tradeDate,
      computed_at: computedAt,
      headline: probabilityHeadline(payload, computedAt),
      scope: extracted.columns.scope,
      missing: extracted.columns.missing,
      source: extracted.columns.source,
      basis: snapshotBasis("probability"),
      note: "留档会真的重算一次历史条件概率（拉指数/自定义池 K 线 + 全A快照），耗时与页面点「计算」同量级；同日多条各自保留。",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `概率留档失败：${(e as Error).message}` }, { status: 502 });
  }
}
