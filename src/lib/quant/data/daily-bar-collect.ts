// P36-C：粮仓增量落库（收盘后跑）。
//
// 为什么必须做成调度任务而不是继续靠手工：
// 战绩链是「粮仓当天K线 → picksym 补出命中的票 → pickfill 次日回填」三段。
// 第一段不在调度里，后两段收盘后跑就是空转——粮仓没有当天数据，picksym 一只票都算不出来，
// pickfill 自然也没什么可回填。战绩页会一直显示 0/20，看上去像"代码没做完"，其实是数据没跟上。
//
// 口径与 scripts/backfill-daily-bars.ts 完全一致（同源同函数）：
// 只拉前复权、只写 stock_daily_bar、INSERT OR REPLACE 幂等、失败重试 2 次、单一写者（SQLite 写锁）。
//
// 用相对导入而不是 @/ 别名：scripts/ 下的脚本也要用 node --experimental-strip-types 直跑。
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db.ts";
import { batchIdOf, toSymbol, barRowsOf, type RawBar } from "./daily-bar-core.ts";

const GW = process.env.TDX_GATEWAY ?? "http://127.0.0.1:8756";
/** 指数不在全A名单里，但分档判档要用上证 MA20，一并落库 */
const EXTRA_CODES = ["sh000001", "sz399001", "sz399006"];
const CHUNK_ROWS = 80; // 11 列 × 80 = 880 绑定变量，卡在 SQLite 常见上限 999 以内

export interface DailyBarIngestResult {
  status: "success" | "failed" | "skipped";
  reason?: string;
  scanned: number;
  results: number;
  basis: string;
  note?: string;
}

async function rpc<T = unknown>(method: string, params: unknown, timeoutMs = 20000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GW}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method, params }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const j = (await res.json()) as { ok?: boolean; result?: T };
    if (!res.ok || !j.ok) return null;
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBars(code: string, count: number, retries = 2): Promise<RawBar[] | null> {
  for (let i = 0; i <= retries; i++) {
    const r = await rpc<{ bars?: RawBar[] }>("bars.get", { code, period: "day", count, adjust: "qfq" });
    if (Array.isArray(r?.bars) && r.bars.length) return r.bars;
    if (i < retries) await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  return null;
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 收盘后增量：每只拉最近 N 根（默认 3 根，够覆盖今天 + 前复权重算的边界），
 * INSERT OR REPLACE 覆盖写，重复跑不会翻倍。
 */
export async function ingestDailyBars(opts: { bars?: number; concurrency?: number } = {}): Promise<DailyBarIngestResult> {
  const bars = opts.bars ?? 3;
  const concurrency = opts.concurrency ?? 4;
  const batch = batchIdOf(new Date(), "qfq", bars);
  const basis = `全A前复权日K增量：每只最近 ${bars} 根，网关 ${GW}，INSERT OR REPLACE 幂等`;

  const rank = await rpc<{ rows?: { full_code?: string }[] }>("helpers.stock_realtime_rank", { sort_by: "成交额", count: 6000 }, 30000);
  const list = (rank?.rows ?? []).map((r) => String(r.full_code ?? ""));
  if (!list.length) {
    return {
      status: "failed",
      reason: "gateway_unreachable",
      scanned: 0,
      results: 0,
      basis,
      note: `全A名单取不到（网关 ${GW} 没起？）。粮仓没更新到今天，后面 picksym/pickfill 会空转`,
    };
  }
  const codes = [...new Set([...list, ...EXTRA_CODES])].filter((c) => /^(sh|sz|bj)\d{6}$/.test(c));

  await db.$queryRawUnsafe("PRAGMA busy_timeout=30000");
  type Row = ReturnType<typeof barRowsOf>[number];
  let pending: Row[] = [];
  let producing = true;
  let written = 0;
  let okSyms = 0;
  let failed = 0;

  const writeChunk = async (chunk: Row[]) => {
    const vals = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)").join(",");
    const args = chunk.flatMap((r) => [r.symbol, r.tradeDate, r.adjust, r.open, r.high, r.low, r.close, r.volume, r.amount, r.batch]);
    await db.$executeRawUnsafe(
      `INSERT OR REPLACE INTO stock_daily_bar (symbol,tradeDate,adjust,open,high,low,close,volume,amount,batch,updatedAt) VALUES ${vals}`,
      ...args,
    );
    written += chunk.length;
  };

  // 多 worker 只负责拉、单一写者负责写：4 个 worker 同时 flush 实测直接 database is locked
  const writer = (async () => {
    for (;;) {
      if (pending.length >= CHUNK_ROWS) await writeChunk(pending.splice(0, CHUNK_ROWS));
      else if (!producing) {
        while (pending.length) await writeChunk(pending.splice(0, CHUNK_ROWS));
        return;
      } else await new Promise((s) => setTimeout(s, 20));
    }
  })();

  await mapPool(codes, concurrency, async (code) => {
    const symbol = toSymbol(code);
    if (!symbol) { failed++; return; }
    const raw = await fetchBars(code, bars);
    if (!raw) { failed++; return; }
    const rows = barRowsOf(raw, symbol, batch);
    if (!rows.length) { failed++; return; }
    okSyms++;
    pending.push(...rows);
  });
  producing = false;
  await writer;

  // 批次留痕：这批什么时候拉的、拉了多少，可追溯
  try {
    const logPath = path.join(process.cwd(), "data", "bar-ingest-log.json");
    const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : { batches: [] };
    log.batches = Array.isArray(log.batches) ? log.batches : [];
    log.batches.push({
      batch, at: new Date().toISOString(), gateway: GW, adjust: "qfq", mode: "incremental",
      barsRequested: bars, symbolsQueued: codes.length, symbolsOk: okSyms, rowsWritten: written,
      note: "收盘后增量（调度 kind=dailybars）；指数 amount/volume 为成分股汇总口径，与个股不可比",
    });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  } catch {
    /* 留痕失败不影响主流程 */
  }

  if (okSyms === 0) {
    return { status: "failed", reason: "no_data", scanned: codes.length, results: 0, basis, note: `一只都没拉到（网关 ${GW}），粮仓没更新` };
  }
  return {
    status: "success",
    scanned: codes.length,
    results: okSyms,
    basis,
    note: `写入 ${written} 行，覆盖 ${okSyms} 只${failed ? `，失败 ${failed} 只` : ""}`,
  };
}
