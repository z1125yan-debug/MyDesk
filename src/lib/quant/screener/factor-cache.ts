// 因子值缓存（S2 预计算的现场版）：全A K线因子按 (trade_date, symbol) 落 SQLite（raw SQL 建表，
// 不动 prisma schema/client）。筛选请求命中缓存 → 不拉 K 线直接出全市场；未命中由
// /api/quant/factor-warm 预热（冷启动 2-4 分钟，之后秒开）。
// values 内只存因子目录类的数值字段；kline_pattern/趋势压力线等展示列由引擎在行装配方上加。
import { db } from "@/lib/db";

export interface CachedFactorRow {
  symbol: string;
  name: string;
  industry: string | null;
  values: Record<string, number | null>;
  kline_pattern: string | null;
  trend_pressure_60: number | null;
}

let tableReady = false;
export async function ensureFactorCacheTable(): Promise<void> {
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

export async function loadFactorCache(tradeDate: string): Promise<Map<string, CachedFactorRow>> {
  await ensureFactorCacheTable();
  const rows = await db.$queryRawUnsafe<{ symbol: string; data: string }[]>(
    `SELECT symbol, data FROM factor_cache WHERE trade_date = ?`,
    tradeDate,
  );
  const out = new Map<string, CachedFactorRow>();
  for (const r of rows) {
    try { out.set(r.symbol, JSON.parse(r.data) as CachedFactorRow); } catch { /* 坏行跳过 */ }
  }
  return out;
}

export async function saveFactorCache(tradeDate: string, rows: CachedFactorRow[]): Promise<void> {
  await ensureFactorCacheTable();
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.$transaction(chunk.map((r) =>
      db.$executeRawUnsafe(
        `INSERT OR REPLACE INTO factor_cache (trade_date, symbol, data) VALUES (?, ?, ?)`,
        tradeDate, r.symbol, JSON.stringify(r),
      ),
    ));
  }
}

/** 今日是否已有当日全量缓存（行数 ≥ 4000 视为全市场口径） */
export async function factorCacheWarm(tradeDate: string): Promise<boolean> {
  await ensureFactorCacheTable();
  const rows = await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) as n FROM factor_cache WHERE trade_date = ?`,
    tradeDate,
  );
  return (rows[0]?.n ?? 0) >= 4000;
}
