// 个股评估矩阵数据源：读当日 factor_cache（全A因子预计算），供 LLM分析-个股评估矩阵 Tab。
import { NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS factor_cache (
      trade_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (trade_date, symbol)
    )`,
  );
  tableReady = true;
}

export async function GET() {
  // 全 A 因子矩阵冷算约 3 秒：30s 内只算一次
  return ttlCache("quant/factor-matrix", DEFAULT_TTL_MS, () => getHandler());
}
async function getHandler() {
  await ensureTable();
  const dateRows = await db.$queryRawUnsafe<{ trade_date: string }[]>(
    `SELECT MAX(trade_date) as trade_date FROM factor_cache`,
  );
  const tradeDate = dateRows[0]?.trade_date ?? null;
  if (!tradeDate) return NextResponse.json({ ok: true, trade_date: null, rows: [] });
  const raw = await db.$queryRawUnsafe<{ symbol: string; data: string }[]>(
    `SELECT symbol, data FROM factor_cache WHERE trade_date = ?`,
    tradeDate,
  );
  const rows = raw
    .map((r) => {
      try { return JSON.parse(r.data) as Record<string, unknown>; } catch { return null; }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
  return NextResponse.json({ ok: true, trade_date: tradeDate, rows });
}
