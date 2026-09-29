// 因子值缓存（S2 预计算的现场版）：全A K线因子按 (trade_date, symbol) 落 SQLite（raw SQL 建表，
// 不动 prisma schema/client）。筛选请求命中缓存 → 不拉 K 线直接出全市场；未命中由
// /api/quant/factor-warm 预热（冷启动 2-4 分钟，之后秒开）。
// values 内只存因子目录类的数值字段；kline_pattern/趋势压力线等展示列由引擎在行装配方上加。
import { db } from "@/lib/db";
import type { WarmPhase } from "./warm-phase-core.ts";

export interface CachedFactorRow {
  symbol: string;
  name: string;
  industry: string | null;
  values: Record<string, number | null>;
  kline_pattern: string | null;
  trend_pressure_60: number | null;
}

/** 一份缓存是什么口径取出来的（见 warm-phase-core）：盘中那份收盘后必须重算 */
export interface FactorCacheMeta {
  trade_date: string;
  phase: WarmPhase;
  generated_at: string;
  rows: number;
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
  // 口径元数据（每个 trade_date 一行）：记录这份缓存是盘中还是收盘后生成的。
  // 没有它，判不出「手上这份数是不是上午 10 点的」——用户实测过「定在盘中」。
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS factor_cache_meta (
      trade_date TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      rows INTEGER NOT NULL
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

export async function saveFactorCache(tradeDate: string, rows: CachedFactorRow[], phase: WarmPhase = "closed"): Promise<void> {
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
  // 元数据在数据写完后再落：只有整份重算完成才敢把口径改成 closed——
  // 中途失败留下的还是旧 meta，下次仍会判定「需要重算」，不会出现「说收盘了其实是半份数据」。
  await db.$executeRawUnsafe(
    `INSERT OR REPLACE INTO factor_cache_meta (trade_date, phase, generated_at, rows) VALUES (?, ?, ?, ?)`,
    tradeDate, phase, new Date().toISOString(), rows.length,
  );
}

/** 读某日缓存的口径元数据（没有 = 老缓存或从未预热） */
export async function factorCacheMeta(tradeDate: string): Promise<FactorCacheMeta | null> {
  await ensureFactorCacheTable();
  const rows = await db.$queryRawUnsafe<{ trade_date: string; phase: string; generated_at: string; rows: number | bigint }[]>(
    `SELECT trade_date, phase, generated_at, rows FROM factor_cache_meta WHERE trade_date = ?`,
    tradeDate,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    trade_date: r.trade_date,
    phase: r.phase === "intraday" ? "intraday" : "closed",
    generated_at: r.generated_at,
    rows: typeof r.rows === "bigint" ? Number(r.rows) : r.rows,
  };
}

/** 最近一份缓存的口径（按 trade_date 倒序取第一条；供 ensure 判定「是否需要重算」） */
export async function latestFactorCacheMeta(): Promise<FactorCacheMeta | null> {
  await ensureFactorCacheTable();
  const rows = await db.$queryRawUnsafe<{ trade_date: string; phase: string; generated_at: string; rows: number | bigint }[]>(
    `SELECT trade_date, phase, generated_at, rows FROM factor_cache_meta ORDER BY trade_date DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    trade_date: r.trade_date,
    phase: r.phase === "intraday" ? "intraday" : "closed",
    generated_at: r.generated_at,
    rows: typeof r.rows === "bigint" ? Number(r.rows) : r.rows,
  };
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
