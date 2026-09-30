// B0 日K落库：把 eltdx 网关的全A前复权日K沉淀到本地 stock_daily_bar（六字段：开高低收量额）。
//
// 为什么要有这个脚本：分档回测每次现去网关拉一遍不落库 → 结果依赖外部接口，
// 数据源一更新（复权调整/补数据）跑出来的数就漂，谁也证明不了谁。
// 落库之后回测有固定粮仓，可重放、可对账、可离线复核。
//
// 用法：
//   node --experimental-strip-types scripts/backfill-daily-bars.ts --limit 50        # 试点
//   node --experimental-strip-types scripts/backfill-daily-bars.ts                   # 全量
//   node --experimental-strip-types scripts/backfill-daily-bars.ts --resume          # 断点续跑
//
// 参数：
//   --limit N        只处理前 N 只（默认全A）
//   --bars N         每只拉多少根日K（默认 800，网关实测上限约 800~1000）
//   --concurrency N  并发路数（默认 4；R20 经验：8 路会有约 10% 取空，4 路最稳）
//   --resume         跳过库里已有足够行数的票
//   --dry            只拉不写（测速用）

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { barRowsOf, batchIdOf, toSymbol, type DailyBarRow, type RawBar } from "../src/lib/quant/data/daily-bar-core.ts";

type Row = DailyBarRow;

const GW = process.env.TDX_GATEWAY ?? "http://127.0.0.1:8756";
const ROOT = process.cwd();
const LOG_PATH = path.join(ROOT, "data", "bar-ingest-log.json");

const argv = process.argv.slice(2);
const argOf = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const LIMIT = argOf("limit", 0);
const BARS = argOf("bars", 800);
const CONCURRENCY = argOf("concurrency", 4);
const RESUME = argv.includes("--resume");
const DRY = argv.includes("--dry");

// 指数不在 stock_realtime_rank 里，但分档回测要用上证 MA20，一并落库。
// 口径提示：指数的 amount/volume 是成分股汇总口径，跟个股不可比，只用于判档/画图。
const EXTRA_CODES = ["sh000001", "sz399001", "sz399006"];

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

/** 拉单只日K，失败重试 2 次（网关偶发超时，不重试会把缺口当成"这天没数据"） */
async function fetchBars(code: string, retries = 2): Promise<RawBar[] | null> {
  for (let i = 0; i <= retries; i++) {
    const r = await rpc<{ bars?: RawBar[] }>("bars.get", { code, period: "day", count: BARS, adjust: "qfq" });
    if (Array.isArray(r?.bars) && r.bars.length) return r.bars;
    if (i < retries) await new Promise((s) => setTimeout(s, 300 * (i + 1)));
  }
  return null;
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const db = new PrismaClient();
  const batch = batchIdOf(new Date(), "qfq", BARS);
  console.log(`批次号 ${batch} | 网关 ${GW} | 每只 ${BARS} 根 | 并发 ${CONCURRENCY}${DRY ? " | DRY" : ""}`);

  // ---- 1) 全A名单 ----
  const rank = await rpc<{ rows?: { full_code?: string; name?: string }[] }>(
    "helpers.stock_realtime_rank",
    { sort_by: "成交额", count: 6000 },
    30000,
  );
  const list = (rank?.rows ?? []).map((r) => String(r.full_code ?? ""));
  if (!list.length) {
    console.error("全A名单取不到（网关没起？）：eltdx-http --host 127.0.0.1 --port 8756");
    await db.$disconnect();
    process.exit(1);
  }
  const codes = [...new Set([...list, ...EXTRA_CODES])].filter((c) => /^(sh|sz|bj)\d{6}$/.test(c));
  const targets = LIMIT ? codes.slice(0, LIMIT) : codes;
  console.log(`全A ${list.length} 只 + 指数 ${EXTRA_CODES.length} → 待处理 ${targets.length} 只`);

  // ---- 2) 断点：已有行数的票跳过 ----
  const existing = new Map<string, number>();
  if (RESUME) {
    const rows = await db.$queryRawUnsafe<{ symbol: string; c: number | bigint }[]>(
      `SELECT symbol, COUNT(*) as c FROM stock_daily_bar WHERE adjust='qfq' GROUP BY symbol`,
    );
    for (const r of rows) existing.set(r.symbol, Number(r.c));
    console.log(`断点：库里已有 ${existing.size} 只，覆盖阈值 ${Math.floor(BARS * 0.9)} 行`);
  }

  const queue = RESUME ? targets.filter((c) => (existing.get(toSymbol(c) ?? "") ?? 0) < Math.floor(BARS * 0.9)) : targets;
  console.log(`实际拉取 ${queue.length} 只\n`);

  // ---- 3) 并发拉（多 worker）+ 单一写者（SQLite 只允许一个写事务）----
  // 为什么必须拆开：4 个 worker 同时 flush 会互相抢写锁，实测直接 `database is locked` 崩掉。
  // worker 只负责拉、把行丢进 pending；writer 独自消费，天然串行。
  const t0 = Date.now();
  let done = 0, okSyms = 0, emptySyms = 0, dropped = 0, written = 0;
  const failed: string[] = [];
  let pending: Row[] = [];
  let producing = true;

  const CHUNK_ROWS = 80; // 11 列 × 80 = 880 个绑定变量，卡在 SQLite 常见上限 999 以内

  // 写锁等待放宽到 30s：主库 130MB+，大批量写入时锁持有时间比默认的 5s 长
  await db.$queryRawUnsafe(`PRAGMA busy_timeout=30000`);

  const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

  async function writeChunk(chunk: Row[]) {
    const vals = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)").join(",");
    const args = chunk.flatMap((r) => [r.symbol, r.tradeDate, r.adjust, r.open, r.high, r.low, r.close, r.volume, r.amount, r.batch]);
    await db.$executeRawUnsafe(
      `INSERT OR REPLACE INTO stock_daily_bar (symbol,tradeDate,adjust,open,high,low,close,volume,amount,batch,updatedAt) VALUES ${vals}`,
      ...args,
    );
    written += chunk.length;
  }

  const writer = (async () => {
    if (DRY) return;
    for (;;) {
      if (pending.length >= CHUNK_ROWS) {
        await writeChunk(pending.splice(0, CHUNK_ROWS));
      } else if (!producing) {
        while (pending.length) await writeChunk(pending.splice(0, CHUNK_ROWS));
        return;
      } else {
        await sleep(20);
      }
    }
  })();

  await mapPool(queue, CONCURRENCY, async (code) => {
    const symbol = toSymbol(code);
    if (!symbol) { emptySyms++; return; }
    const raw = await fetchBars(code);
    done++;
    if (!raw) { emptySyms++; failed.push(code); return; }
    const rows = barRowsOf(raw, symbol, batch);
    dropped += raw.length - rows.length;
    if (!rows.length) { emptySyms++; failed.push(code); return; }
    okSyms++;
    if (!DRY) pending.push(...rows);
    if (done % 500 === 0) console.log(`  进度 ${done}/${queue.length} 只 · 已写 ${written} 行 · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });
  producing = false;
  await writer;

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n完成：成功 ${okSyms} 只 / 空或失败 ${emptySyms} 只（${failed.length ? "样本 " + failed.slice(0, 8).join(",") : "无"}）` +
      `\n丢弃坏行 ${dropped} 行 | ${DRY ? "DRY 未写入" : `写入 ${written} 行`} | 耗时 ${secs}s`,
  );

  // ---- 4) 批次留痕：这批数据什么时候拉的、拉了多少，可追溯 ----
  if (!DRY) {
    const log = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, "utf8")) : { batches: [] };
    log.batches = Array.isArray(log.batches) ? log.batches : [];
    log.batches.push({
      batch, at: new Date().toISOString(), gateway: GW, adjust: "qfq",
      barsRequested: BARS, symbolsQueued: queue.length, symbolsOk: okSyms,
      rowsWritten: written, droppedRows: dropped, seconds: Number(secs),
      note: "全A前复权日K；指数 amount/volume 为成分股汇总口径，与个股不可比",
    });
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
    console.log(`批次日志 → ${LOG_PATH}`);
  }
  await db.$disconnect();
}

main().catch((e) => { console.error("崩了：", e); process.exit(1); });
