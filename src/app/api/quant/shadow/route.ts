// 影子版接口（2026-10-24 规格书）：
//   POST {date?} —— 生成某交易日影子名单（不传 date = 最近一个已沉淀交易日）并顺手回填到期的 h1/h5/h20；
//   GET —— 列出全部影子行（原始字段，战绩页的加工在 trackrecord 接口里做）。
// 纪律：生成失败如实回 ok:false + 原因，不编名单、不拿旧日顶替。

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateShadowPick, fillShadowHorizons } from "@/lib/quant/strategy/shadow-collect";
import { SHADOW_SOURCE } from "@/lib/quant/strategy/shadow-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const rows = await db.strategyPick.findMany({
      where: { source: SHADOW_SOURCE },
      orderBy: { tradeDate: "desc" },
      select: {
        tradeDate: true, regime: true, strategyName: true, symbols: true, symbolsNote: true,
        h1Stat: true, h5Stat: true, h20Stat: true, shadowDetail: true,
      },
    });
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `影子行读取失败：${(e as Error).message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { date?: string };
    let date = typeof body.date === "string" ? body.date.trim() : "";
    if (!date) {
      const rows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
        `SELECT tradeDate FROM stock_daily_bar WHERE adjust = 'qfq'
         GROUP BY tradeDate HAVING COUNT(*) >= 1000 ORDER BY tradeDate DESC LIMIT 1`,
      );
      date = rows[0]?.tradeDate ?? "";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: `日期不对：「${date}」` }, { status: 400 });
    }
    const gen = await generateShadowPick(date);
    const fill = await fillShadowHorizons();
    return NextResponse.json({ ok: gen.ok, gen, fill });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `影子生成失败：${(e as Error).message}` }, { status: 500 });
  }
}
