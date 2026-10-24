// 影子版执行层（2026-10-24）：取数 + 落库 + 分档回填。纯核在 shadow-core.ts，这里只管 IO。
//
// 纪律（与 pick-fill-collect 同风格）：
// 1) 只用已沉淀完的交易日（当日全市场日K >= 1000 只才算数），没沉淀完就如实报缺，不拿旧数据顶替；
// 2) 已回填到 h20 的行绝不重写名单（重跑改名单 = 账本造假）；
// 3) 缺哪档留哪档 null，绝不记 0；
// 4) 指数（上证）本地粮仓没有行，走行情源 fetchKlinesReal（通达信优先、腾讯兜底，与档位条同源），
//    取到的指数日K顺手沉淀进 data/shadow-index.json，越攒越全，回填对照（bench）优先读这份沉淀。

// 用相对路径而不是 @/ 别名：scripts/ 下的脚本用 node --experimental-strip-types 直跑，别名解析不了
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "../../db.ts";
import { parseSymbols } from "./pick-fill-core.ts";
import {
  SHADOW_SOURCE, SHADOW_STRATEGY_ID, SHADOW_HOLD_DAYS,
  shadowRegimeOf, shadowFactorsOf, shadowPoolWithQuality, selectShadowPicks, shadowNetOf, horizonStatOf,
  type ShadowCandidate, type HorizonStat,
} from "./shadow-core.ts";

const ADJUST = "qfq";
const MIN_BAR_SYMBOLS = 1000;
const INDEX_SYMBOL = "000001.SH";
const INDEX_CACHE = path.join(process.cwd(), "data", "shadow-index.json");

interface IndexBar { date: string; close: number }

async function readIndexCache(): Promise<IndexBar[]> {
  try {
    const raw = JSON.parse(await fs.readFile(INDEX_CACHE, "utf8")) as { bars?: IndexBar[] };
    return Array.isArray(raw.bars) ? raw.bars.filter((b) => b?.date && Number.isFinite(b.close)) : [];
  } catch { return []; }
}

async function writeIndexCache(bars: IndexBar[]): Promise<void> {
  try {
    const sorted = bars.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-900);
    await fs.writeFile(INDEX_CACHE, JSON.stringify({ updatedAt: new Date().toISOString(), bars: sorted }, null, 1));
  } catch { /* 沉淀失败不阻塞主流程，下次再攒 */ }
}

/** 现拉上证日K：通达信网关（127.0.0.1:8756，与 em.fetchKlinesReal 同一优先源）→ 腾讯 ifzq 兜底。
 *  不 import em.ts：它依赖链里有无扩展名 import，scripts 的 strip-types 直跑解析不了；
 *  这里只用两个裸 fetch，API 路由与 CLI 共用同一实现。 */
async function fetchIndexFresh(count = 320): Promise<IndexBar[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("http://127.0.0.1:8756/rpc", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method: "bars.get", params: { code: "sh000001", period: "day", count, adjust: "qfq" } }),
      signal: ctrl.signal, cache: "no-store",
    }).finally(() => clearTimeout(timer));
    const j = (await res.json()) as { ok?: boolean; result?: { bars?: { time?: string; close?: number }[] } };
    const bars = j?.ok ? (j.result?.bars ?? []) : [];
    const out = bars.map((b) => ({ date: String(b.time ?? "").slice(0, 10), close: Number(b.close) }))
      .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.close) && b.close > 0);
    if (out.length >= 21) return out;
  } catch { /* 网关没起就走腾讯 */ }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,${count},qfq`, {
      signal: ctrl.signal, cache: "no-store",
    }).finally(() => clearTimeout(timer));
    const j = (await res.json()) as { data?: { sh000001?: { qfqday?: string[][]; day?: string[][] } } };
    const rows = j?.data?.sh000001?.qfqday ?? j?.data?.sh000001?.day ?? [];
    return rows.map((r) => ({ date: String(r[0]).slice(0, 10), close: Number(r[2]) }))
      .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.close) && b.close > 0);
  } catch { return []; }
}

/** 上证日K：行情源现拉 + 本地沉淀合并（升序）。现拉失败就只用沉淀，并在 source 里如实标注 */
export async function shadowIndexBars(): Promise<{ bars: IndexBar[]; source: string }> {
  const cached = await readIndexCache();
  let fresh: IndexBar[] = [];
  let freshOk = false;
  try {
    fresh = await fetchIndexFresh(320);
    freshOk = fresh.length >= 21;
  } catch { freshOk = false; }
  const merged = new Map<string, number>();
  for (const b of cached) merged.set(b.date, b.close);
  for (const b of fresh) merged.set(b.date, b.close);
  const bars = [...merged.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
  if (freshOk) await writeIndexCache(bars);
  return { bars, source: freshOk ? "行情源现拉+本地沉淀" : "仅本地沉淀（行情源这次没拉到）" };
}

/** 已沉淀完的交易日（升序，可指定截止日与条数） */
async function settledTradeDates(beforeOrOn?: string, limit = 60): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT tradeDate FROM stock_daily_bar WHERE adjust = ? ${beforeOrOn ? "AND tradeDate <= ?" : ""}
     GROUP BY tradeDate HAVING COUNT(*) >= ? ORDER BY tradeDate DESC LIMIT ?`,
    ...(beforeOrOn ? [ADJUST, beforeOrOn, MIN_BAR_SYMBOLS, limit] : [ADJUST, MIN_BAR_SYMBOLS, limit]),
  );
  return rows.map((r) => r.tradeDate).reverse();
}

async function tradeDatesAfter(date: string, limit = 25): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT tradeDate FROM stock_daily_bar WHERE adjust = ? AND tradeDate > ?
     GROUP BY tradeDate HAVING COUNT(*) >= ? ORDER BY tradeDate ASC LIMIT ?`,
    ADJUST, date, MIN_BAR_SYMBOLS, limit,
  );
  return rows.map((r) => r.tradeDate);
}

export interface ShadowGenerateResult {
  ok: boolean;
  tradeDate: string;
  regime: string | null;
  indexSlopeUp: boolean | null;
  strategyName: string | null;
  pickCount: number;
  note: string;
  missing: string[];
}

/** 生成某交易日的影子名单并落库（幂等：h20 已回填的行不重写；未回填完的重跑同口径同结果） */
export async function generateShadowPick(tradeDate: string): Promise<ShadowGenerateResult> {
  const missing: string[] = [];
  const fail = (note: string): ShadowGenerateResult => ({ ok: false, tradeDate, regime: null, indexSlopeUp: null, strategyName: null, pickCount: 0, note, missing });
  // 21 个交易日窗口（信号日 + 往前 20 日）
  const dates = await settledTradeDates(tradeDate, 21);
  if (!dates.length || dates[dates.length - 1] !== tradeDate) return fail(`${tradeDate} 还不是已沉淀完的交易日（当日日K未入库或不足 ${MIN_BAR_SYMBOLS} 只），不生成`);
  if (dates.length < 21) return fail(`窗口不足：${tradeDate} 往前只有 ${dates.length} 个已沉淀交易日，ret20 算不出`);

  const { bars: indexBars, source: indexSource } = await shadowIndexBars();
  const idxCloses = indexBars.filter((b) => b.date <= tradeDate).map((b) => b.close);
  const idxDates = indexBars.filter((b) => b.date <= tradeDate).map((b) => b.date);
  if (!idxCloses.length || idxDates[idxDates.length - 1] !== tradeDate) {
    return fail(`上证日K最后一天是 ${idxDates[idxDates.length - 1] ?? "无"}，对不上信号日 ${tradeDate}，档位算不出（指数来源：${indexSource}）`);
  }
  const reg = shadowRegimeOf(idxCloses);
  if (!reg) return fail("上证日K不足 21 根，档位算不出");

  // 全市场 21 日窗口日K
  const inList = dates.map(() => "?").join(",");
  const rows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; open: number | null; high: number | null; low: number | null; close: number | null; amount: number | null }[]>(
    `SELECT symbol, tradeDate, open, high, low, close, amount FROM stock_daily_bar WHERE adjust = ? AND tradeDate IN (${inList})`,
    ADJUST, ...dates,
  );
  const nameRows = await db.stockDailyClose.findMany({ where: { tradeDate }, select: { symbol: true, name: true } }).catch(() => []);
  const nameMap = new Map(nameRows.map((r) => [r.symbol, r.name ?? ""]));
  // 上市天数近似：库内累计 bar 根数（库起点 2024-01-02 后上市的票 = 真实上市交易日数；
  // 更早上市的票根数远超 60，不会被 60 日门槛误伤）。质量过滤③用。
  const listedRows = await db.$queryRawUnsafe<{ symbol: string; n: bigint | number }[]>(
    `SELECT symbol, COUNT(*) AS n FROM stock_daily_bar WHERE adjust = ? AND tradeDate <= ? GROUP BY symbol`,
    ADJUST, tradeDate,
  ).catch(() => []);
  const listedMap = new Map(listedRows.map((r) => [r.symbol, Number(r.n)]));

  const bySym = new Map<string, Map<string, { open: number | null; high: number | null; low: number | null; close: number | null; amount: number | null }>>();
  for (const r of rows) {
    const m = bySym.get(r.symbol) ?? new Map();
    m.set(r.tradeDate, { open: r.open, high: r.high, low: r.low, close: r.close, amount: r.amount });
    bySym.set(r.symbol, m);
  }
  const candidates: ShadowCandidate[] = [];
  for (const [symbol, m] of bySym) {
    const today = m.get(tradeDate);
    if (!today || today.close == null || !Number.isFinite(today.close) || today.close <= 0) continue;
    // 窗口逐日对齐：缺任何一天（停牌等）就 factors 留 null，不拿错位数据算
    const closes: number[] = [];
    let complete = true;
    for (const d of dates) {
      const c = m.get(d)?.close;
      if (c == null || !Number.isFinite(c) || c <= 0) { complete = false; break; }
      closes.push(c);
    }
    const f = complete ? shadowFactorsOf(closes) : null;
    // 一字跌停：全天一价（开=高=低=收）且跌幅达跌停量级（主板 −10%/双创 −20% 都用 −9.5% 一刀切，
    // 一价才是关键条件）；这种票信号日收盘根本买不进，质量过滤④剔除。
    const prevClose = closes.length >= 2 ? closes[closes.length - 2] : null;
    const onePriceDown = today.high != null && today.low != null && today.open != null
      && today.high === today.low && today.open === today.close && today.high === today.close
      && prevClose != null && prevClose > 0 && today.close / prevClose - 1 <= -0.095;
    candidates.push({
      symbol, name: nameMap.get(symbol) ?? "", close: today.close,
      amount: today.amount, ret20: f?.ret20 ?? null, devMa20: f?.devMa20 ?? null,
      listedBars: listedMap.get(symbol) ?? null, onePriceDown,
    });
  }

  const { pool, rejected: qualityRejected } = shadowPoolWithQuality(candidates);
  const sel = selectShadowPicks(reg.regime, reg.indexSlopeUp, pool);
  const symbolsJson = JSON.stringify(sel.picks.map((p) => ({
    symbol: p.symbol, name: p.name, close: p.close,
    ret20: Math.round(p.ret20 * 10000) / 100, // 存百分数（+18.25 表示 +18.25%），页面直接读
    devMa20: p.devMa20 == null ? null : Math.round(p.devMa20 * 10000) / 100,
  })));
  const qualityLine = qualityRejected.length
    ? `质量过滤在池口剔除 ${qualityRejected.length} 只（${qualityRejected.map((r) => `${r.symbol}${r.name ? ` ${r.name}` : ""}：${r.reason}`).join("；")}）`
    : "质量过滤池口零剔除";
  const note = `${sel.note}。档位=${reg.regime}（上证 ${reg.close}，20日均线 ${Math.round(reg.ma20 * 100) / 100}，均线${reg.indexSlopeUp ? "向上" : "向下"}）；池子=质量过滤后当日成交额前 300（候选 ${candidates.length} 只）；${qualityLine}；指数来源：${indexSource}；无排雷、无温度过滤（规格书口径）。`;

  const existing = await db.strategyPick.findFirst({
    where: { tradeDate, strategyId: SHADOW_STRATEGY_ID, source: SHADOW_SOURCE },
    select: { id: true, h20Stat: true },
  });
  if (existing?.h20Stat) {
    return { ok: true, tradeDate, regime: reg.regime, indexSlopeUp: reg.indexSlopeUp, strategyName: sel.strategyName, pickCount: sel.picks.length, note: "该日影子行已回填到 20 日，名单冻结不重写", missing };
  }
  const data = {
    tradeDate, strategyId: SHADOW_STRATEGY_ID, strategyName: sel.strategyName, source: SHADOW_SOURCE,
    regime: reg.regime, symbols: symbolsJson, symbolsNote: note,
  };
  if (existing) await writeRetry(() => db.strategyPick.update({ where: { id: existing.id }, data }));
  else await writeRetry(() => db.strategyPick.create({ data: { ...data, pickedAt: new Date() } }));

  return { ok: true, tradeDate, regime: reg.regime, indexSlopeUp: reg.indexSlopeUp, strategyName: sel.strategyName, pickCount: sel.picks.length, note, missing };
}

/** 写库重试：SQLite 在有长读事务时写会等锁，Prisma 默认约 5 秒就报 P1008（Socket timeout）。
 *  影子落库是幂等 upsert，退避重试 4 次是安全的；重试也失败就把错误抛出去如实报，不吞。 */
async function writeRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/P1008|Socket timeout|database is locked/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastErr;
}

interface ShadowDetailRow { symbol: string; net1: number | null; net5: number | null; net20: number | null }

function round2(x: number): number { return Math.round(x * 100) / 100; }

/** 回填所有影子行的 h1/h5/h20（到期一档填一档，幂等，已填的不重算） */
export async function fillShadowHorizons(): Promise<{ scanned: number; updated: number; missing: string[] }> {
  const missing: string[] = [];
  const rows = await db.strategyPick.findMany({
    where: { source: SHADOW_SOURCE },
    orderBy: { tradeDate: "asc" },
    select: { id: true, tradeDate: true, symbols: true, h1Stat: true, h5Stat: true, h20Stat: true, shadowDetail: true },
  });
  const { bars: indexBars } = await shadowIndexBars();
  const idxCloseOf = new Map(indexBars.map((b) => [b.date, b.close]));
  let updated = 0;

  for (const row of rows) {
    const syms = parseSymbols(row.symbols);
    if (!syms.length) continue; // 空仓行没有收益可填，h* 留 null 是正确状态
    const after = await tradeDatesAfter(row.tradeDate, SHADOW_HOLD_DAYS);
    const horizons: { key: "h1Stat" | "h5Stat" | "h20Stat"; n: number; detailKey: "net1" | "net5" | "net20" }[] = [
      { key: "h1Stat", n: 1, detailKey: "net1" },
      { key: "h5Stat", n: 5, detailKey: "net5" },
      { key: "h20Stat", n: 20, detailKey: "net20" },
    ];
    const detail: ShadowDetailRow[] = (() => {
      try {
        const raw = row.shadowDetail ? JSON.parse(row.shadowDetail) as ShadowDetailRow[] : [];
        const m = new Map(raw.map((d) => [d.symbol, d]));
        return syms.map((s) => m.get(s.symbol) ?? { symbol: s.symbol, net1: null, net5: null, net20: null });
      } catch { return syms.map((s) => ({ symbol: s.symbol, net1: null, net5: null, net20: null })); }
    })();
    const patch: Record<string, string> = {};
    let touched = false;

    for (const h of horizons) {
      if (row[h.key]) continue;
      const sellDate = after[h.n - 1];
      if (!sellDate) continue; // 还没到期，不填
      const qRows = await db.$queryRawUnsafe<{ symbol: string; close: number | null }[]>(
        `SELECT symbol, close FROM stock_daily_bar WHERE adjust = ? AND tradeDate = ? AND symbol IN (${syms.map(() => "?").join(",")})`,
        ADJUST, sellDate, ...syms.map((s) => s.symbol),
      );
      const closeMap = new Map(qRows.map((r) => [r.symbol, r.close]));
      const nets: number[] = [];
      for (const s of syms) {
        const net = shadowNetOf(s.close, closeMap.get(s.symbol) ?? null);
        const d = detail.find((x) => x.symbol === s.symbol);
        if (d) d[h.detailKey] = net == null ? null : round2(net);
        if (net != null) nets.push(net);
      }
      if (!nets.length) { missing.push(`${row.tradeDate} ${h.key}：${sellDate} 一只票都没取到收盘价，未回填`); continue; }
      const idxEntry = idxCloseOf.get(row.tradeDate);
      const idxExit = idxCloseOf.get(sellDate);
      const bench = idxEntry && idxExit ? (idxExit / idxEntry - 1) * 100 : null;
      const stat: HorizonStat | null = horizonStatOf(nets, bench, sellDate);
      if (stat) {
        patch[h.key] = JSON.stringify({ ...stat, mean: round2(stat.mean), median: round2(stat.median), winRate: round2(stat.winRate), benchMean: stat.benchMean == null ? null : round2(stat.benchMean) });
        touched = true;
      }
    }
    if (touched) {
      patch.shadowDetail = JSON.stringify(detail);
      await writeRetry(() => db.strategyPick.update({ where: { id: row.id }, data: patch }));
      updated++;
    }
  }
  return { scanned: rows.length, updated, missing };
}
