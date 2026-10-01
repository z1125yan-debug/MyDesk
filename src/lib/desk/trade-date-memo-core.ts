// 最后已知交易日 memo 的有效期判定（纯核，零依赖）。
// 从 trade-date.ts 拆出来：钉测要 node --test 直跑，而那条文件链挂着 fs 和 @/ 别名拽不动。
// 口径见 trade-date.ts 的 memo 注释（2026-10-01 国庆实测事故 + P40 复检 #1 放宽到 10 天）。

export interface TradeDateMemo {
  /** 行情源最后确认的交易日 */
  date: string;
  /** 这份确认是哪天存的（上海时区 YYYY-MM-DD） */
  savedAtDay: string;
}

/** memo 有效期上限（天）：覆盖最长节假日链；写死常量，别散落魔法数 */
export const LAST_GOOD_MAX_AGE_DAYS = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** memo 是否可用（纯函数，钉测直跑）：存档在 N 天内、日期形状合法、且不超过行情源允许的上界 cutoff */
export function memoUsable(
  memo: TradeDateMemo | null,
  today: string,
  cutoff: string,
): boolean {
  if (!memo) return false;
  if (!DATE_RE.test(memo.date) || !DATE_RE.test(memo.savedAtDay)) return false;
  if (memo.savedAtDay > today || memo.date > cutoff) return false;
  const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  const ageDays = Math.round((utc(today) - utc(memo.savedAtDay)) / 86_400_000);
  return ageDays >= 0 && ageDays <= LAST_GOOD_MAX_AGE_DAYS;
}
