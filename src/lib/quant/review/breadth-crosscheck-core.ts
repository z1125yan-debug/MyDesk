// 宽度口径交叉核对纯核（P15-R19）：把「稳智同步种子的站上5日线占比」和
// 「本地真实收盘自算出来的同一条线」摆在一起算差多少，输出一段能写进页面的结论。
//
// 为什么单独成核：R19 给 stock_daily_close 回填了 110 个交易日的真实收盘价（新浪日K，不复权），
// 这是项目里第一次「同一天有两个独立来源的宽度读数」。种子列对不对，不能靠嘴说，
// 也不能靠一次性脚本——算差值的算法本身要能被钉测，跑真数据的那次结果要能复跑。
//
// 纪律：
//   1) 只算不裁决：这里只报「差多少、哪天差最大、两条线走得多像」，不做静默替换（谁上线是页面/口径决定的事）；
//   2) 缺读数不进比对：种子或自算任一侧为 null 的日子直接跳过，不拿 0 顶、不插值；
//   3) 日期不匹配的两侧都不丢：只比对交集，并如实报可比天数（可比天数本身就是结论的一部分）。
export interface SeedBreadthPoint {
  date: string;
  aboveMa5Pct: number | null;
}

export interface ComputedBreadthPoint {
  date: string;
  above_ma5_pct: number | null;
}

export interface BreadthDiffPoint {
  date: string;
  seed: number;
  computed: number;
  /** 自算 − 种子，单位：百分点。正数=本地算出来更高，负数=种子更高 */
  diff_pt: number;
}

export interface BreadthCrossCheck {
  /** 两侧都有读数的天数（可比天数） */
  comparable_days: number;
  seed_days: number;
  computed_days: number;
  /** 平均绝对偏差（百分点） */
  mean_abs_pt: number | null;
  /** 最大绝对偏差（百分点） */
  max_abs_pt: number | null;
  /** 平均带符号偏差（百分点）：>0 说明本地自算整体高于种子 */
  mean_signed_pt: number | null;
  /** 两条线的皮尔逊相关系数；样本 <2 或某一侧方差为 0 时为 null（算不出就是算不出） */
  corr: number | null;
  /** 偏差最大的 3 天（按绝对值降序、并列按日期升序）；两条线完全重合时为空数组 */
  worst: BreadthDiffPoint[];
  /** 一句人话结论，页面/文档直接引用 */
  verdict: string;
}

/**
 * 比对两条「站上5日线占比」序列。输入不要求有序，也不要求同长。
 * 空交集返回全 null + 明说的 verdict，不返回 0 冒充「完全一致」。
 */
export function compareBreadthWithSeed(
  seed: readonly SeedBreadthPoint[],
  computed: readonly ComputedBreadthPoint[],
): BreadthCrossCheck {
  const seedByDate = new Map<string, number>();
  for (const r of seed) {
    if (typeof r.aboveMa5Pct === "number" && isFinite(r.aboveMa5Pct)) seedByDate.set(r.date, r.aboveMa5Pct);
  }
  const compByDate = new Map<string, number>();
  for (const r of computed) {
    if (typeof r.above_ma5_pct === "number" && isFinite(r.above_ma5_pct)) compByDate.set(r.date, r.above_ma5_pct);
  }

  const points: BreadthDiffPoint[] = [];
  for (const [date, s] of seedByDate) {
    const c = compByDate.get(date);
    if (c === undefined) continue;
    points.push({ date, seed: s, computed: c, diff_pt: c - s });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const empty = {
    comparable_days: points.length,
    seed_days: seedByDate.size,
    computed_days: compByDate.size,
    worst: [],
  };
  if (!points.length) {
    return {
      ...empty,
      mean_abs_pt: null,
      max_abs_pt: null,
      mean_signed_pt: null,
      corr: null,
      verdict: "两条线没有一个同日读数：没法比（不是「一致」，是没得比）",
    };
  }

  const n = points.length;
  const abs = points.map((p) => Math.abs(p.diff_pt));
  const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
  const meanAbs = mean(abs);
  const meanSigned = mean(points.map((p) => p.diff_pt));
  const maxAbs = Math.max(...abs);

  // 皮尔逊相关：任一侧方差为 0（一条水平线）时相关无定义，返回 null 而不是 0
  let corr: number | null = null;
  if (n >= 2) {
    const xs = points.map((p) => p.seed);
    const ys = points.map((p) => p.computed);
    const mx = mean(xs);
    const my = mean(ys);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
    if (sxx > 0 && syy > 0) corr = sxy / Math.sqrt(sxx * syy);
  }

  // 只列真有偏差的日子：完全重合时「最差三天」是三条 0，看着像漏算
  const worst = [...points].filter((p) => p.diff_pt !== 0)
    .sort((a, b) => Math.abs(b.diff_pt) - Math.abs(a.diff_pt) || (a.date < b.date ? -1 : 1)).slice(0, 3);
  const r2 = (v: number) => Math.round(v * 100) / 100;

  let verdict: string;
  if (meanAbs <= 1) verdict = `同口径：${n} 个可比交易日平均差 ${r2(meanAbs)} 个百分点`;
  else if (meanAbs <= 3) verdict = `基本对得上：${n} 个可比交易日平均差 ${r2(meanAbs)} 个百分点（最大 ${r2(maxAbs)}）`;
  else {
    const dir = meanSigned < 0 ? "种子整体偏高" : "本地自算整体偏高";
    verdict =
      `两个口径对不齐：${n} 个可比交易日平均差 ${r2(meanAbs)} 个百分点、最大 ${r2(maxAbs)}（${dir}）；` +
      `走势一致度 ${corr === null ? "算不出" : r2(corr).toFixed(2)}——同一件事的两种算法，不是两个数各说各话`;
  }

  return {
    comparable_days: n,
    seed_days: seedByDate.size,
    computed_days: compByDate.size,
    mean_abs_pt: r2(meanAbs),
    max_abs_pt: r2(maxAbs),
    mean_signed_pt: r2(meanSigned),
    corr: corr === null ? null : Math.round(corr * 10000) / 10000,
    worst,
    verdict,
  };
}
