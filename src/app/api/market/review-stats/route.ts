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
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
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

/**
 * 库里的一行 → 纯核吃的自产行（字段名对齐，null 原样透传）。
 * 能不能上图由纯核 isUsableSelfRow 判：涨跌停与最高板缺任何一样就整行不进序列——
 * 用 0 顶替会变成「当日 0 家涨停」的假事实（缺读数 ≠ 0 纪律）。
 * 站上5日线那几列本来就可缺（要等逐票收盘价攒够 5 天），null 原样透传。
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
    return NextResponse.json({
      ok: true,
      rows: merged,
      themeHeat: themeSeed,
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
