// 大盘情绪分档纯核（P34-1）：只做纯计算，零 IO、零时钟。
//
// 为什么单独成核：分档口径此前只活在一次性的回测脚本里（`data/_probe-strategy-regime.json`），
// 线上弹卡要用同一套档位判定，就必须有一处可测的纯函数——否则「回测说弱势期最强、
// 线上按另一套判档」就会在同一块屏上打架（R20b 宽度那格已经栽过一次同样的跟头）。
//
// 档位法（沿用 Zcode 回测口径，写在注释里免得后人改歪）：
//   上证指数 MA20 趋势法——收盘在 MA20 上 且 MA20 向上 = 强势；
//   收盘在 MA20 下 且 MA20 向下 = 弱势；其余 = 震荡。
// 只有三个词：强势 / 震荡 / 弱势。不新增第四档、不预测点位。

export type Regime = "强势" | "震荡" | "弱势";

export const REGIMES: Regime[] = ["强势", "震荡", "弱势"];

/** 单档回测成绩（历史统计，不是预测） */
export interface RegimeStat {
  /** 该档命中次数 */
  n: number;
  /** 次日上涨占比 % */
  win: number;
  /** 次日平均涨跌幅 % */
  avg: number;
  /** 后 5 个交易日平均涨跌幅 % */
  avg5: number;
  /** P1（2026-09-30）：胜率的 Wilson 95% 置信区间文本（如「69% [95%CI 63–74]（N=323）」）。
   *  点估计不许当真值卖——样本小的时候区间会宽，模型/页面转述必须带区间。 */
  winCi: string;
}

/** 一条策略的分档回测行（与 data/strategy-regime.json 的 rows[] 形状一致） */
export interface RegimeRow {
  id: number;
  name: string;
  condsText: string;
  /** 全期：命中 / 次日胜率% / 次日均益% / 5日均益% */
  n1: number;
  win1: number;
  avg1: number;
  avg5: number;
  /** 近 110 根K线窗口 */
  n110: number;
  win110: number;
  强势: RegimeStat | null;
  震荡: RegimeStat | null;
  弱势: RegimeStat | null;
}

/**
 * MA20 序列（简单均线）。长度不足的头部返回 null——
 * 「算不出来」和「等于 0」是两件事，不许用 0 占位（缺读数不许洗白，项目一贯纪律）。
 */
export function ma20Of(closes: number[]): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < 19) {
      out.push(null);
      continue;
    }
    // 窗口内只要有一天是缺失/非法值，这天的 MA20 就是「算不出来」——
    // 不能拿缺失当 0 累加（那是把均线往下拉），也不能让 NaN 顺着滑动和污染后面所有天数。
    let sum = 0;
    let ok = true;
    for (let k = i - 19; k <= i; k++) {
      const v = closes[k];
      if (!Number.isFinite(v)) { ok = false; break; }
      sum += v;
    }
    out.push(ok ? sum / 20 : null);
  }
  return out;
}

/**
 * 逐日档位序列。输入收盘价序列，输出与它等长的档位数组；
 * MA20 算不出（不足 20 根）或方向判不出（相邻 MA20 缺失）的那些天返回 null。
 */
export function regimeSeriesOf(closes: number[]): (Regime | null)[] {
  const ma = ma20Of(closes);
  return closes.map((c, i) => {
    if (!Number.isFinite(c)) return null;
    const m = ma[i];
    const prev = i > 0 ? ma[i - 1] : null;
    if (m == null || !Number.isFinite(m)) return null;
    // 第一天没有前值可比方向 → 方向未定，归入「震荡」，不猜强/弱
    const up = prev != null && Number.isFinite(prev) ? m > prev : null;
    const above = c > m;
    if (up == null) return "震荡";
    if (above && up) return "强势";
    if (!above && !up) return "弱势";
    return "震荡";
  });
}

/** 取序列最后一天的档位；算不出返回 null（不猜） */
export function latestRegimeOf(closes: number[]): Regime | null {
  const s = regimeSeriesOf(closes);
  return s.length ? s[s.length - 1] : null;
}

/** 取指定下标的档位（历史回放用）；越界或算不出返回 null */
export function regimeAt(closes: number[], index: number): Regime | null {
  const s = regimeSeriesOf(closes);
  if (index < 0 || index >= s.length) return null;
  return s[index];
}

export interface RankOptions {
  /**
   * 该档最少命中次数（不足不上榜）。
   * 2026-09-30 从 20 提到 100：删掉 43 条涨停类策略后，minHits=20 让 n=22/29 的噪音占榜首，
   * 出现「胜率 48.3% 排第 1」这种荒谬结果。用 Wilson 95%CI 半宽当尺子：
   *   n=29  → 半宽 ±17%（等于没测）；n=100 → ±10%；n=797 → ±3.4%（可用）。
   * 取 100：三档 Top1 的置信区间半宽都收在 ±5% 以内，且榜单仍有足够多样性。
   */
  minHits?: number;
  /** 全期最少命中次数（同步提到 150） */
  minTotal?: number;
  /** 最多返回几条 */
  limit?: number;
}

/**
 * 分档排名：按该档「次日平均收益」降序。
 * 只排有该档成绩的、且样本够的（该档≥100、全期≥150）。
 * 理由行所需的真实数字全部随结果带出——页面不许自己再算一遍（刻度只有一处）。
 */
export function regimeRankOf(
  rows: RegimeRow[],
  regime: Regime | null,
  opts: RankOptions = {},
): { regime: Regime | null; items: { id: number; name: string; stat: RegimeStat; win1: number; n1: number }[] } {
  const minHits = opts.minHits ?? 100;
  const minTotal = opts.minTotal ?? 150;
  const limit = opts.limit ?? 5;
  if (!regime) return { regime: null, items: [] };

  const items = rows
    .map((r) => ({ row: r, st: r[regime] }))
    .filter((x): x is { row: RegimeRow; st: RegimeStat } => !!x.st && x.st.n >= minHits && x.row.n1 >= minTotal)
    .sort((a, b) => b.st.avg - a.st.avg)
    .slice(0, limit)
    .map((x) => ({ id: x.row.id, name: x.row.name, stat: x.st, win1: x.row.win1, n1: x.row.n1 }));

  return { regime, items };
}

/** 百分比/收益数字的展示口径：统一保留 2 位去尾 0，避免各页面各写一份 toFixed */
export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
