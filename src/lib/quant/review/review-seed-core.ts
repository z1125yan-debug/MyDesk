// P15-R19 稳智复盘统计种子的纯核：14 列位置数组 → 命名字段 + 抄进库之前的口径自查。
// 零 IO、零时钟 —— 可被 node --test 直接钉。
//
// 为什么要单独一层：种子文件是无表头的位置数组（[日期, 涨停, 跌停, 三板, 四板, 五板+, 最高板,
// 下跌家数, 低5日, 低3日, 站上5日占比, 微盘, 中盘, 大盘]）。列序只要在某一处写歪一格，
// 页面不会报错，只会静默把「跌停家数」画成「涨停家数」。所以列序映射全项目只留这一份：
// 读侧接口（/api/market/review-stats）与导入器（/api/market/review-stats/import-seed）都从这里取。
//
// 与自产行的分工没变（见 review-daily-core）：种子只当历史底子，本地自产只补种子终点之后的
// 新交易日，同日互不覆盖；导入器还会主动给自产行让路。
import type { ReviewSelfRow } from "./review-daily-core.ts";
import { isUsableSelfRow } from "./review-daily-core.ts";

/** 种子的列序（写死：改种子格式必须同时改这里和钉测） */
export const SEED_COLUMNS = [
  "date", "limitUp", "limitDown", "t3", "t4", "t5", "maxBoards",
  "decliners", "belowMa5", "belowMa3", "aboveMa5Pct", "microPct", "midPct", "largePct",
] as const;
export const SEED_COLUMN_COUNT = SEED_COLUMNS.length; // 14

/** 种子行与自产行吃同一个字段形状 */
export type SeedStatRow = ReviewSelfRow;

/** 导进 market_daily_stats 时写进 basis 的出身句：明标外部来源照抄，不许冒充收盘自产。
 *  ⚠ 这句话里不能出现 SELF_BASIS_PREFIX 那四个字——实测过一次：写成「非本地自产」
 *  会让下面的让路判定把自己也认成自产行，第二次导入就一条都不写了。 */
export const SEED_IMPORT_BASIS =
  "稳智同步种子照抄（外部来源，非收盘自产）";

/** 自产行的 basis 前缀（与 review-daily-collect 写的那句同源）：导入器据此让路，绝不覆盖自产 */
export const SELF_BASIS_PREFIX = "本地自产";

/** 这行库记录是不是本地收盘自产写的（只看开头，不做全文包含——见上面那条坑） */
export function isSelfProducedBasis(basis: string): boolean {
  return (basis ?? "").startsWith(SELF_BASIS_PREFIX);
}

/** 单个格子 → number | null：只有真实数字才进字段，空串/null/NaN 一律 null（缺就是缺，不按 0 算） */
function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/** 一行位置数组 → 命名字段。列数不足时缺的列记 null，绝不拿别列顶位 */
export function mapSeedRow(row: readonly unknown[]): SeedStatRow {
  const at = (i: number): unknown => (i < row.length ? row[i] : null);
  return {
    date: String(at(0) ?? ""),
    limitUp: num(at(1)), limitDown: num(at(2)),
    t3: num(at(3)), t4: num(at(4)), t5: num(at(5)), maxBoards: num(at(6)),
    decliners: num(at(7)), belowMa5: num(at(8)), belowMa3: num(at(9)),
    aboveMa5Pct: num(at(10)), microPct: num(at(11)), midPct: num(at(12)), largePct: num(at(13)),
  };
}

export function mapSeedRows(rows: readonly (readonly unknown[])[]): SeedStatRow[] {
  return rows.map(mapSeedRow);
}

/** 种子实际给了几种列宽（正常只有 14；出现第二种就是种子被改坏了，先报出来再决定抄不抄） */
export function seedColumnWidths(rows: readonly (readonly unknown[])[]): number[] {
  return [...new Set(rows.map((r) => r.length))].sort((a, b) => a - b);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 北京日期的星期（0=周日，6=周六）——按 UTC 日历日算，不依赖宿主时区 */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function dayGap(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * 抄之前先自查：只报「这份数据自己跟自己打架」的项，不猜外部真值（外部抽查另记 worklog）。
 * 返回人话一行一条，空数组 = 没查出毛病。审计不拦导入——缺数也是真实读数，照抄后要如实显示；
 * 但结果原样进接口，页面与验收都能看到「抄之前查了什么」。
 */
export function auditSeedRows(rows: readonly SeedStatRow[]): string[] {
  if (!rows.length) return ["种子是空的：没有可抄的行"];
  const out: string[] = [];
  const pctCols = ["aboveMa5Pct", "microPct", "midPct", "largePct"] as const;

  let badDate = 0, badOrder = 0, weekend = 0, unusable = 0, tierConflict = 0, pctOut = 0;
  let prev = "";
  for (const r of rows) {
    if (!DATE_RE.test(r.date)) { badDate++; continue; }
    if (weekdayOf(r.date) === 0 || weekdayOf(r.date) === 6) weekend++;
    if (prev && r.date <= prev) badOrder++;
    const t345 = (r.t3 ?? 0) + (r.t4 ?? 0) + (r.t5 ?? 0);
    // 按「行」计数不按「条」：一行里两处打架也只报一行，别让报警数字看着像更多坏数据
    if (r.maxBoards !== null && ((t345 > 0 && r.maxBoards < 3) || ((r.t5 ?? 0) > 0 && r.maxBoards < 5))) tierConflict++;
    if (!isUsableSelfRow(r)) unusable++;
    for (const c of pctCols) {
      const v = r[c];
      if (v !== null && (v < 0 || v > 100)) pctOut++;
    }
    prev = r.date;
  }

  if (badDate) out.push(`${badDate} 行日期不合 YYYY-MM-DD：这些行不进库`);
  if (badOrder) out.push(`${badOrder} 行日期不比前一行晚：种子内部顺序乱了，图上会同一两天来回跳`);
  if (weekend) out.push(`${weekend} 行落在周六日：A 股周末不交易，要么来源错要么日期串了`);
  if (unusable) out.push(`${unusable} 行缺涨停/跌停/最高板任一项：按同一套可用性口径这些日子进不了图（缺读数≠0）`);
  if (tierConflict) out.push(`${tierConflict} 行「连板家数」与「最高板」对不上（有 3 板以上家数，最高板却不够高）`);
  if (pctOut) out.push(`${pctOut} 个「站上5日线占比」类读数不在 0~100 区间`);

  // 断档：相邻交易日隔 >7 天才提醒（五一/十一/春节本就该断，超过一周才可能是漏采）
  const dates = rows.map((r) => r.date).filter((d) => DATE_RE.test(d)).sort();
  const gaps: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = dayGap(dates[i - 1], dates[i]);
    if (gap > 7) gaps.push(`${dates[i - 1]}→${dates[i]}（${gap} 天）`);
  }
  if (gaps.length) out.push(`种子有 ${gaps.length} 处超过一周的断档：${gaps.join("、")}——断档日无数据，图上照实留空`);

  return out;
}
