// R21 每日复盘统计的纯核（零 IO、零时钟 —— 可被 node --test 直接钉）。
//
// 放纯核的理由和别处一样：落库与路由都只做 IO，规则写在这里才不会出现
// 「接口合并的口径」和「采集器写的口径」各说一套。
//
// 种子与自产的分工（写死，别搞反）：
//   · 种子（review-stats-seed.json）= 历史底子，只覆盖到某个终点日期；
//   · market_daily_stats（收盘后自产）= 只补**终点之后**的新交易日。
//   同日两者都有时以种子为准：种子 09-24 涨停是 51 家、本地口径是 55 家，
//   同一天摆两个数就是跳变，自产行只留档不覆盖，图才连续、口径才可核对。

export interface ReviewSelfRow {
  date: string;
  limitUp: number | null;
  limitDown: number | null;
  t3: number | null;
  t4: number | null;
  t5: number | null;
  maxBoards: number | null;
  decliners: number | null;
  belowMa5: number | null;
  belowMa3: number | null;
  aboveMa5Pct: number | null;
  microPct: number | null;
  midPct: number | null;
  largePct: number | null;
}

/**
 * 从涨停梯队的「3连板+」桶里拆出 3/4/5板及以上家数。
 * 种子的 t3/t4/t5 就是这么分的（t5 = 5 板及以上，不单独列 6 板、7 板）。
 */
export function splitBoards(boards: readonly (number | null | undefined)[]): { t3: number; t4: number; t5: number } {
  let t3 = 0, t4 = 0, t5 = 0;
  for (const b of boards) {
    const n = Number(b);
    if (!isFinite(n)) continue; // null/undefined/NaN 不进任何桶（缺就是缺，不按 1 板算）
    if (n >= 5) t5++;
    else if (n === 4) t4++;
    else if (n === 3) t3++;
  }
  return { t3, t4, t5 };
}

/** 自产行能不能上图：涨跌停与最高板缺任何一样，整行不进序列（用 0 顶替就是「当日 0 家涨停」的假事实） */
export function isUsableSelfRow(r: ReviewSelfRow): boolean {
  return r.limitUp !== null && r.limitDown !== null && r.maxBoards !== null;
}

/**
 * 合并种子行与自产行：自产只补 seedEnd 之后，且必须通过 isUsableSelfRow。
 * 返回按日期升序（两条来源各自本来就是升序，这里只做一次稳定归并）。
 */
export function mergeReviewRows<T extends { date: string }>(seedRows: readonly T[], selfRows: readonly ReviewSelfRow[], seedEnd: string): T[] {
  const usable = selfRows
    .filter((r) => Boolean(seedEnd) ? r.date > seedEnd : true)
    .filter(isUsableSelfRow) as unknown as T[];
  return [...seedRows, ...usable].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 页面/接口要显示的数据出身那一行字：种子止于哪天、自产续了几天、从哪天起 */
export function reviewSourceLine(o: {
  seedEnd: string;
  seedStart?: string;
  selfDays: number;
  firstSelfDate?: string;
  selfError?: string;
}): string {
  const seed = `复盘统计·离线快照种子（${o.seedStart ?? "2026-04-20"}~${o.seedEnd}）`;
  if (o.selfDays > 0) {
    return `${seed} + 本地自产续写 ${o.selfDays} 个交易日（${o.firstSelfDate ?? "?"} 起）`;
  }
  if (o.selfError) return `${seed}；本地自产续写暂不可用（${o.selfError}）`;
  return `${seed}；收盘后自动续写（kind=review，北京 15:05 后）`;
}
