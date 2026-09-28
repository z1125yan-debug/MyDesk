// POST /api/market/breadth/backfill —— 逐票收盘价历史回填（P15-R19，用户口径：种子没有的「在网上搜一下接进去」）。
//
// 为什么要有这一步：stock_daily_close 自建成起 0 行，而它只能「从今天起攒」——
// 收盘后自产（kind=breadth）拿不到昨天的快照价，见顶预警要的晋级率/龙头滞涨/宽度自校验
// 全是历史序列，没有历史就只能是样本一天。种子里只有市场级读数（涨跌停/梯队/宽度占比），没有逐票价，
// 所以这一段的真实数据只能从日线源接：**新浪日K（不复权原始价）**。
// 为什么不用腾讯那路：em-provider 的日K走 fqkline=qfq（前复权），除权日会把历史价改小，
// 与本表「close = 当日价格读数」的口径不是一回事；混一列进去就是两种口径谁也不认谁。
//
// 口径（写死，别绕）：
//   1) 只补库里没有的键：(symbol, tradeDate) 已有行一律不写，收盘自产行永远优先；
//      同键不同价不做静默覆盖，只把差异条数与样例报出来（见 price_mismatch）。
//   2) 当日不归它：to 上限夹到「昨日」。今天的收盘价由 15:05 后的自产任务写（盘中价不进历史）。
//   3) 只写真实读到的价：坏价/窗口外/同票同日重复都不写，条数如实进 outcome 计数。
//   4) 分批可续跑：一次只处理 universe 的一个 offset/limit 切片，跑挂或限流了从下次接着来，
//      已经写进去的不会因为重跑而重写。
//   5) 出身可查：本表没有 basis 列（不动地基不加列），回填行与自产行的区别看 createdAt 与 tradeDate
//      的间隔——回填行的 createdAt 全挤在同一天（本次执行日），自产行的 createdAt 就在其交易日当天。
//   6) 只 POST、只增不删：不改 schema、不删行、不碰别的表。dry_run=1 只取数不写库。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/quant/data/index";
import { sinaDayBars } from "@/lib/quant/data/sina-kline";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { addBeijingDays } from "@/lib/quant/scheduler/rules";
import {
  BACKFILL_CALIBER, rowsFromBars, splitFreshRows, type BarEntry,
} from "@/lib/quant/screener/breadth-backfill-core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FROM = "2026-04-20"; // 与复盘统计种子同期起点：有市场级读数的日子都配上逐票价，两边才可比
const CHUNK = 500; // sqlite 单语句参数上限保守分块（与 breadth-collect 同风格）
const POOL = 4; // 并发 4：单只 ~0.13s，全A 一次切片 200 只约 8s；再高就是在压公共接口

/** 简易并发池：保持结果与入参同序，失败项由 fn 自己吞成 null */
async function mapPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "这是写库接口，要用 POST 明确触发；只想看宽度结果请读 /api/market/breadth" },
    { status: 405 },
  );
}

export async function POST(req: Request) {
  let body: { from?: string; to?: string; offset?: number; limit?: number; dry_run?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    /* 空 body / 非 JSON：全按默认切片 */
  }

  const today = shanghaiDate();
  const cap = addBeijingDays(today, -1); // 当日行归收盘后自产，回填最多写到昨天
  const from = DATE_RE.test(String(body.from ?? "")) ? String(body.from) : DEFAULT_FROM;
  const requestedTo = DATE_RE.test(String(body.to ?? "")) ? String(body.to) : cap;
  const to = requestedTo > cap ? cap : requestedTo;
  if (from > to) {
    return NextResponse.json({ ok: false, error: `窗口反了（from ${from} > to ${to}）：一条都不写` }, { status: 400 });
  }

  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const limit = Math.min(400, Math.max(1, Math.floor(Number(body.limit) || 200)));
  const dryRun = body.dry_run === true;

  const provider = await getProvider("em");
  const metas = await provider.listUniverse({ kind: "all" }, today);
  if (!metas.length) {
    return NextResponse.json({ ok: false, error: "全A名单为空（数据源无返回）——本次一条都不写" }, { status: 502 });
  }
  const slice = metas.slice(offset, offset + limit);

  // 需要的根数：窗口自然日 × 0.78 折算交易日，再垫 12 根给首尾对齐
  const calendarDays = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
  const barsNeeded = Math.min(1000, Math.max(60, Math.ceil(calendarDays * 0.78) + 12));

  const failed: string[] = [];
  const entries: BarEntry[] = await mapPool(slice, POOL, async (m) => {
    try {
      const bars = await sinaDayBars(m.symbol, barsNeeded);
      return { symbol: m.symbol, name: m.name ?? "", bars };
    } catch (e) {
      failed.push(`${m.symbol}：${(e as Error).message}`);
      return { symbol: m.symbol, name: m.name ?? "", bars: null };
    }
  });

  const outcome = rowsFromBars(entries, from, to);

  const symbols = slice.map((m) => m.symbol);
  const existing = symbols.length
    ? await db.stockDailyClose.findMany({
        where: { symbol: { in: symbols }, tradeDate: { gte: from, lte: to } },
        select: { symbol: true, tradeDate: true, close: true },
      })
    : [];
  const { fresh, existingKeys, priceMismatch } = splitFreshRows(outcome.rows, existing);

  let inserted = 0;
  if (!dryRun) {
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const r = await db.stockDailyClose.createMany({ data: fresh.slice(i, i + CHUNK) });
      inserted += r.count;
    }
  }

  const missing: string[] = [];
  if (dryRun) missing.push("dry_run：只取数与算行，本次一条都没写");
  if (requestedTo > to) missing.push(`请求的 to=${requestedTo} 夹到了 ${to}：当日行归 15:05 后的收盘自产，回填不写今天`);
  if (outcome.noBars) missing.push(`${outcome.noBars} 只本切片没取到窗口内日K（网络失败/新上市/长期停牌）——不写行，宽度分母不含它们`);
  if (outcome.dirty) missing.push(`${outcome.dirty} 个格子价格或日期不合格被丢弃`);
  if (outcome.duplicate) missing.push(`${outcome.duplicate} 个同票同日重复格子取首条`);
  if (existingKeys) missing.push(`${existingKeys} 个键库里已有——不重写（其中 ${priceMismatch.length} 个同键不同价，见 price_mismatch）`);
  if (failed.length) missing.push(`取数失败样例：${failed.slice(0, 3).join("；")}`);

  const done = Math.min(offset + slice.length, metas.length);
  return NextResponse.json({
    ok: true,
    as_of: shanghaiStamp(),
    dry_run: dryRun,
    window: { from, to, requested_to: requestedTo, calendar_days: calendarDays, bars_per_symbol: barsNeeded },
    universe: { total: metas.length, offset, slice: slice.length, done, remaining: metas.length - done },
    fetch: { had_bars: outcome.hadBars, no_bars: outcome.noBars, failed_samples: failed.slice(0, 5) },
    rows: {
      candidates: outcome.rows.length,
      fresh: fresh.length,
      inserted,
      skipped_existing_key: existingKeys,
      dates_covered: outcome.dates.length,
      first_date: outcome.dates[0] ?? null,
      last_date: outcome.dates[outcome.dates.length - 1] ?? null,
    },
    price_mismatch: priceMismatch.slice(0, 10),
    price_mismatch_total: priceMismatch.length,
    table_rows_after: await db.stockDailyClose.count(),
    source: "sina 日K getKLineData（不复权原始价，scale=240）",
    caliber: BACKFILL_CALIBER,
    missing,
    boundary: "只写 stock_daily_close，只增不删不改 schema；已有键与收盘自产行一律不重写，当日行由 15:05 后的 kind=breadth 写",
  });
}
