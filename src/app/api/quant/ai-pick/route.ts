// POST/GET /api/quant/ai-pick —— AI优选战绩层的生成入口（P39 / #75）
//
// POST { date?, candidates?: {symbol,name?,close?}[], picks?: {symbol,name?,close?}[] }
//   不传 picks → 服务端用已配置模型通道从「当日候选」自动收窄并落库（解决「用户不手动用也不会触发」）；
//   传 picks   → 直接落库前端已经收窄好的结果（用户在对话里做完 AI优选、点「计入战绩」）。
// GET  ?date=YYYY-MM-DD  取该日 AI优选战绩行；不传 → 最近 30 条。
//
// 纪律：任何一步走不通都如实回 200 + ok:true + missing[]（不落假数据、不谎称成功）；
//       只有入参非法才回 400。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { getServerLlm } from "@/lib/llm/model-config";
import { generateAiPickForDate } from "@/lib/quant/strategy/ai-pick-generate.ts";
import { AI_PICK_SOURCE, AI_PICK_STRATEGY_ID, AI_PICK_MAX } from "@/lib/quant/strategy/ai-pick-core.ts";
import { parseSymbols, type PickSym } from "@/lib/quant/strategy/pick-fill-core.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const date = sp.get("date") ?? undefined;
    const rows = await db.strategyPick.findMany({
      where: date ? { tradeDate: date, source: AI_PICK_SOURCE } : { source: AI_PICK_SOURCE },
      orderBy: { tradeDate: "desc" },
      take: date ? 5 : 30,
      select: { tradeDate: true, symbols: true, symbolsNote: true, symBackfilledAt: true, nextDaySymWin: true, nextDaySymUp: true, nextDaySymCount: true },
    });
    return NextResponse.json({
      market: "A", market_label: "A股",
      ok: true,
      as_of: new Date().toISOString(),
      serverLlmAvailable: getServerLlm().available,
      rows: rows.map((r) => ({
        tradeDate: r.tradeDate,
        count: parseSymbols(r.symbols).length,
        symbolsNote: r.symbolsNote,
        filled: !!r.symBackfilledAt,
        win: r.nextDaySymWin,
        up: r.nextDaySymUp,
        symCount: r.nextDaySymCount,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      date?: string;
      candidates?: { symbol: string; name?: string; close?: number | null }[];
      picks?: { symbol: string; name?: string; close?: number | null }[];
      topN?: number;
    };
    const date = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : shanghaiDate();

    let picks: PickSym[] | undefined;
    if (Array.isArray(body.picks)) {
      picks = body.picks
        .map((p) => ({ symbol: String(p?.symbol ?? "").trim().toUpperCase(), name: typeof p.name === "string" ? p.name : "", close: typeof p.close === "number" && Number.isFinite(p.close) ? p.close : null }))
        .filter((p) => /^\d{6}\.(SH|SZ|BJ)$/.test(p.symbol));
      if (!picks.length) return NextResponse.json({ ok: false, error: "picks 里没有合法代码（形如 600519.SH）" }, { status: 400 });
    }

    const out = await generateAiPickForDate(date, {
      candidates: Array.isArray(body.candidates)
        ? body.candidates.map((c) => ({ symbol: String(c?.symbol ?? "").trim().toUpperCase(), name: typeof c.name === "string" ? c.name : "", close: typeof c.close === "number" && Number.isFinite(c.close) ? c.close : null }))
        : undefined,
      picks,
      topN: typeof body.topN === "number" ? body.topN : AI_PICK_MAX,
    });

    return NextResponse.json({
      market: "A", market_label: "A股",
      ok: true,
      tradeDate: date,
      serverLlmAvailable: getServerLlm().available,
      count: out.results,
      missing: out.missing,
      basis: out.source,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
