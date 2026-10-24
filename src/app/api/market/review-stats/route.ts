// 复盘统计（对齐稳智 /api/review-stats 口径）：读种子数据（稳智账号同步 2026-04-20~2026-09-24，110 个交易日），
// 之后由本地回填引擎（S2 后续）逐日续写。缺行就是缺，不内插不补零。
// 行结构（数组序）：[日期, 涨停家数, 跌停家数, 三板, 四板, 五板及以上, 最高板,
//   全市场下跌家数, 低于5日线家数, 低于3日线家数, 高于5日线占比, 微盘股高于5日线, 中盘股高于5日线, 大盘股高于5日线]
// R21：种子 + 本地自产续写。分工写死在这里，别搞反：
//   · 种子（review-stats-seed.json）= 历史底子，覆盖 2026-04-20~2026-09-24，只读不续写；
//   · market_daily_stats 表 = 收盘后自产（archiveReviewScan），只补**种子终点之后**的新日期。
//   同日两者都有时**以种子为准**——种子的 09-24 涨停是 51 家、本地口径是 55 家，
//   同一天摆两个数就是跳变，宁可让自产行只留档不覆盖，这样图是连续的、口径是可核对的。
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { fetchBoardRowsRescuedV2 } from "@/lib/desk/board-rescue";
import { inferMarketEnv } from "@/lib/quant/review/market-inference";
import seed from "@/lib/quant/review/review-stats-seed.json";
import idxSeed from "@/lib/quant/review/index-changes-seed.json";
import themeSeed from "@/lib/quant/review/theme-heat-seed.json";
import { db } from "@/lib/db";
import { mergeReviewRows, reviewSourceLine, type ReviewSelfRow } from "@/lib/quant/review/review-daily-core";
// R19：14 列位置数组 → 命名字段的映射搬进纯核，读侧与导入器共用一份（列序写歪会静默换列，不报错）
import { mapSeedRows, type SeedStatRow } from "@/lib/quant/review/review-seed-core";

export const dynamic = "force-dynamic";

export type ReviewRow = SeedStatRow;

const ROWS: ReviewRow[] = mapSeedRows(seed as unknown as readonly (readonly unknown[])[]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 种子的覆盖终点：自产只补这个日期之后的新交易日（含终点当天也不覆盖） */
export const SEED_END = ROWS.length ? String(ROWS[ROWS.length - 1].date) : "";

/** 上海时区今天（YYYY-MM-DD） */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type HeatItem = { n: string; h: number; pct: number; f: number };

/** 与 theme-heat 路由同款公式：涨幅贡献50(封顶5%) + 主力资金贡献30(封顶20亿) + RPS贡献20；f=当日主力净流入（亿元） */
async function computeHeatLive(kind: "industry" | "concept"): Promise<HeatItem[]> {
  const [inRes, outRes] = await Promise.all([
    fetchBoardRowsRescuedV2(kind, "in", 200),
    fetchBoardRowsRescuedV2(kind, "out", 200),
  ]);
  const merged = new Map<string, { name?: string; changePct?: number; main?: number; rps?: number }>();
  for (const r of [...(inRes.rows ?? []), ...(outRes.rows ?? [])]) {
    if (r.code && !merged.has(r.code)) merged.set(r.code, r);
  }
  return [...merged.values()].map((b) => {
    const pct = typeof b.changePct === "number" ? b.changePct : 0;
    const main = typeof b.main === "number" ? b.main : 0;
    const rps = typeof b.rps === "number" ? b.rps : 0;
    const h = Math.round(50 * Math.min(Math.max(pct, 0) / 5, 1) + 30 * Math.min(Math.max(main, 0) / 20, 1) + 20 * Math.min(rps, 100) / 100);
    return { n: b.name ?? "", h, pct, f: main };
  }).sort((a, b) => b.h - a.h);
}

/** 本地板块快照（data/sector-snapshots.json）算某日热度：涨幅50+资金30，RPS 历史缺省不计 */
function snapshotHeatFor(date: string): { industries: HeatItem[]; concepts: HeatItem[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "sector-snapshots.json"), "utf8")) as {
      days?: Record<string, { rows?: { name?: string; changePct?: number | null; main?: number | null }[] }>;
    };
    const days = raw.days ?? {};
    const pick = (kind: "industry" | "concept"): HeatItem[] | null => {
      const entry = days[`${date}|${kind}`];
      if (!entry?.rows?.length) return null;
      return entry.rows.map((r) => {
        const pct = typeof r.changePct === "number" ? r.changePct : 0;
        const main = typeof r.main === "number" ? r.main : 0;
        const h = Math.round(50 * Math.min(Math.max(pct, 0) / 5, 1) + 30 * Math.min(Math.max(main, 0) / 20, 1));
        return { n: r.name ?? "", h, pct, f: main };
      }).sort((a, b) => b.h - a.h);
    };
    const industries = pick("industry"), concepts = pick("concept");
    if (!industries && !concepts) return null;
    return { industries: industries ?? [], concepts: concepts ?? [] };
  } catch {
    return null;
  }
}

/**
 * themeHeat 现算（2026-10-23 查清并修复）：此前本路由把 themeHeat 写死为种子文件
 * （2026-09-24 抓取），导致 09-24 之后所有研报的主线热度/资金/市场判读都是一
 * 个月前的存货，与同响应里逐日续写的复盘行脱节。改为按目标日现算：市场判读走
 * market_daily_stats 自产行推理（inferMarketEnv）；热度今天走实时板块、历史日
 * 走本地板块快照；取不到就给空表（下游如实写「数据不足」），绝不回退种子冒充
 * 新鲜。例外：目标日 ≤ 种子终点时种子就是该时期的真数据，照旧返回。
 */
async function buildThemeHeat(targetDate: string): Promise<unknown> {
  if (!targetDate || (SEED_END && targetDate <= SEED_END)) return themeSeed;
  let inference: ReturnType<typeof inferMarketEnv> = null;
  try {
    const dbRows = await db.marketDailyStats.findMany({
      where: { tradeDate: { lte: targetDate } },
      orderBy: { tradeDate: "desc" },
      take: 30,
    });
    const asc = dbRows.reverse();
    inference = inferMarketEnv(targetDate, asc.map((m) => ({
      date: m.tradeDate, limitUp: m.limitUp ?? 0, limitDown: m.limitDown ?? 0,
      t3: m.t3 ?? 0, t4: m.t4 ?? 0, t5: m.t5 ?? 0, maxBoards: m.maxBoards ?? 0,
      decliners: m.decliners ?? 0, belowMa5: m.belowMa5 ?? 0, belowMa3: m.belowMa3 ?? 0,
      aboveMa5Pct: m.aboveMa5Pct ?? null,
    })));
  } catch {
    inference = null;
  }
  if (!inference) {
    try { inference = inferMarketEnv(targetDate); } catch { inference = null; }
  }
  let industries: HeatItem[] = [], concepts: HeatItem[] = [];
  try {
    if (targetDate === shanghaiToday()) {
      [industries, concepts] = await Promise.all([computeHeatLive("industry"), computeHeatLive("concept")]);
    } else {
      const snap = snapshotHeatFor(targetDate);
      if (snap) { industries = snap.industries; concepts = snap.concepts; }
    }
  } catch {
    industries = []; concepts = [];
  }
  return {
    as_of_news_date: targetDate,
    market_env: inference ? { as_of_trade_date: inference.as_of_date, label: inference.market_bucket } : undefined,
    inference,
    industries,
    concepts,
  };
}

/**
 * 库里的一行 → 纯核吃的自产行（字段名对齐，null 原样透传）。
 * 能不能上图由纯核 isUsableSelfRow 判：涨跌停与最高板缺任何一样就整行不进序列——
 * 用 0 顶替会变成「当日 0 家涨停」的假事实（缺读数 ≠ 0 纪律）。
 * 宽度三列（aboveMa5Pct/belowMa5/belowMa3）自 P15-R19c 起由本地逐票收盘价自产（三市全A），
 * 微/中/大盘分组自产不了（库里没有市值分层）→ 继续 null 原样透传。
 */
function toSelfRow(r: {
  tradeDate: string; limitUp: number | null; limitDown: number | null;
  t3: number | null; t4: number | null; t5: number | null; maxBoards: number | null;
  decliners: number | null; belowMa5: number | null; belowMa3: number | null;
  aboveMa5Pct: number | null; microPct: number | null; midPct: number | null; largePct: number | null;
}): ReviewSelfRow {
  return {
    date: r.tradeDate,
    limitUp: r.limitUp, limitDown: r.limitDown,
    t3: r.t3, t4: r.t4, t5: r.t5, maxBoards: r.maxBoards,
    decliners: r.decliners, belowMa5: r.belowMa5, belowMa3: r.belowMa3,
    aboveMa5Pct: r.aboveMa5Pct, microPct: r.microPct, midPct: r.midPct, largePct: r.largePct,
  };
}

export async function GET(req: Request) {
  return ttlCache(`market/review-stats?${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const rows = ROWS.filter((r) =>
    (!DATE_RE.test(from) || r.date >= from) && (!DATE_RE.test(to) || r.date <= to));
  // 指数涨跌幅（稳智 index-changes 同源种子：全A/上证/红利/小盘/中小盘/深成/创业板）
  const indexChanges = (idxSeed as unknown as { d: string; allA: number; sh: number; dividend: number; small: number; mid: number; sz: number; cyb: number }[])
    .filter((r) => (!DATE_RE.test(from) || r.d >= from) && (!DATE_RE.test(to) || r.d <= to));

  // 自产续写：只取种子终点之后的新交易日（同日以种子为准，自产行不覆盖）
  let selfError = "";
  try {
    const dbRows = await db.marketDailyStats.findMany({
      where: SEED_END ? { tradeDate: { gt: SEED_END } } : {},
      orderBy: { tradeDate: "asc" },
    });
    // 能不能上图由纯核判（涨跌停/最高板缺一样就整行不进），这里只负责翻译字段
    const all = dbRows.map(toSelfRow);
    const merged = mergeReviewRows(rows, all, SEED_END).filter((r) =>
      (!DATE_RE.test(from) || r.date >= from) && (!DATE_RE.test(to) || r.date <= to));
    const themeHeat = await buildThemeHeat(merged[merged.length - 1]?.date ?? "");
    return NextResponse.json({
      ok: true,
      rows: merged,
      themeHeat,
      indexChanges,
      range: { from: merged[0]?.date ?? null, to: merged[merged.length - 1]?.date ?? null },
      seedEnd: SEED_END,
      selfDays: merged.length - rows.length,
      source: reviewSourceLine({
        seedEnd: SEED_END,
        selfDays: merged.length - rows.length,
        firstSelfDate: merged.slice(rows.length)[0]?.date,
      }),
    });
  } catch (e) {
    // 表还没建/读失败：历史照常返回，只是不续写——不能让一次 DB 异常把整页历史打没
    selfError = (e as Error).message || String(e);
  }

  return NextResponse.json({
    market: "A", market_label: "A股",
    ok: true,
    rows,
    themeHeat: themeSeed,
    indexChanges,
    range: { from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null },
    seedEnd: SEED_END,
    selfDays: 0,
    source: reviewSourceLine({ seedEnd: SEED_END, selfDays: 0, selfError }),
  });
}
