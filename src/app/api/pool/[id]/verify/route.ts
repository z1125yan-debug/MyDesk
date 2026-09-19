// POST /api/pool/[id]/verify — 次日验证（取 asOf 之后真实日K，回填 ret1d/ret5d/mfe/mae）
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface PoolRow {
  symbol: string;
  name: string;
  close: number | null;
  changePct: number | null;
}

interface VerifySymbol {
  open: number;
  high: number;
  low: number;
  close: number;
  ret1d: number | null;
  ret5d: number | null;
  mfe: number;
  mae: number;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  quantBootstrap();
  const { id } = await params;

  const pool = await db.candidatePool.findUnique({ where: { poolId: id } });
  if (!pool) {
    return NextResponse.json({ error: `候选池不存在：${id}` }, { status: 404 });
  }

  let rows: PoolRow[] = [];
  try { rows = JSON.parse(pool.rows); } catch { /* ignore */ }
  if (!rows.length) {
    return NextResponse.json({ error: "池内无候选" }, { status: 400 });
  }

  const symbols = rows.map((r) => r.symbol);
  const today = shanghaiDate();
  // fetchBarsHybrid 内部按 <=asOf 截断 → 必须传「今天」才能取到 asOf 之后的日K（否则历史池永远验证不出）
  const barsMap = await fetchBarsHybrid(symbols, today, 60);

  const perSymbol: Record<string, VerifySymbol> = {};
  let anyVerified = false;

  for (const row of rows) {
    const allBars = barsMap.get(row.symbol) ?? [];
    // 只保留 asOf 之后的日K（严格大于）
    const afterBars = allBars.filter((b) => b.date > pool.asOf);

    if (afterBars.length === 0) continue;

    anyVerified = true;
    const first = afterBars[0];
    const entryPrice = first.o;

    // 1日收益：第一根 bar 收盘
    const ret1d = afterBars.length >= 1
      ? ((afterBars[0].c - entryPrice) / entryPrice) * 100
      : null;

    // 5日收益：第5根 bar 收盘（不足5根用最后一根）
    const lastBar = afterBars.length >= 5 ? afterBars[4] : afterBars[afterBars.length - 1];
    const ret5d = ((lastBar.c - entryPrice) / entryPrice) * 100;

    // MFE / MAE（基于开盘价 vs 最高/最低价）
    let maxHigh = -Infinity;
    let minLow = Infinity;
    const barsForExtremes = afterBars.length >= 5 ? afterBars.slice(0, 5) : afterBars;
    for (const b of barsForExtremes) {
      if (b.h > maxHigh) maxHigh = b.h;
      if (b.l < minLow) minLow = b.l;
    }
    const mfe = ((maxHigh - entryPrice) / entryPrice) * 100;
    const mae = ((minLow - entryPrice) / entryPrice) * 100;

    perSymbol[row.symbol] = {
      open: first.o,
      high: first.h,
      low: first.l,
      close: first.c,
      ret1d,
      ret5d,
      mfe,
      mae,
    };
  }

  if (!anyVerified) {
    return NextResponse.json({
      status: "pending",
      message: "待下一交易日",
      pool_id: id,
      as_of: pool.asOf,
      today,
    });
  }

  const verifiedDate = today;
  const verifyResult = { verifiedDate, perSymbol };

  // 回填 verify（可重算覆盖），rows 永不覆盖
  await db.candidatePool.update({
    where: { poolId: id },
    data: { verify: JSON.stringify(verifyResult) },
  });

  return NextResponse.json({
    status: "verified",
    pool_id: id,
    verify: verifyResult,
  });
}
