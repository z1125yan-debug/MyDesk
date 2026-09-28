// P15-R2b 宽度统计纯核：从「逐票逐日收盘价」沉淀算 站上5日线占比 / 创5日新低 / 创3日新低。
// 零 IO 零时钟：输入是已按天存好的行（stock_daily_close 的投影），输出逐日统计序列。
//
// 口径（写死在这里，页面/接口/工具转述同一份）：
// - 窗口按**该票自己的已沉淀交易日**滚动：停牌日库里没有它的行，窗口不随全局日历平移、也不补价——
//   凑不满所需根数的票当日不进分母（缺就是缺，不拿 4 根均线冒充 5 根）。
// - 站上5日线 = 收盘价 > 最近 5 根（含当日）收盘均值；分母是当日有行且历史（含当日）满 5 根的票。
// - 创5日新低 = 收盘价 ≤ 前 4 根的最低价（并列最低算新低——今天和前某日同价也是「跌到近5日最低」）；
//   创3日新低同理取前 2 根。新低数不进占比分母之外单设口径：分母同样是「满 N 根」的票数。
// - eligible=0 时占比是 null 不是 0——「没有能算的票」和「0% 站上5日线」是两回事（缺读数≠0 纪律）。
// - 序列按日期升序；不足 5 个交易日沉淀时前几行 pct 为 null，页面据此显示「攒中 N/5」而不是画假线。
// - 票池默认**三市全A（沪 2,320 + 深 2,902 + 北交 347 = 5,569 只）**：本地库里本来就有北交所的行，
//   自算就按自己攒到的全票池算，不跟外部口径对齐着删票。要拿稳智同步种子做对照时显式传
//   scope="two_markets"——实测过：种子那两列（低于5日线家数 ÷ 占比）反推的分母是 5,162~5,210，
//   本地剔掉北交后满 5 根的票数是 5,156~5,208，逐日贴合（含北交是 5,462~5,546），
//   所以**种子的票池确实是两市**；但剔掉北交只把两口径的平均差从 4.68 消到 4.42 个百分点
//   （按月收敛的形状完全没变：4 月 −10.48 / 9 月 −0.86），**票池不是主因**，别当成口径已闭合。

export type BreadthScope = "two_markets" | "all_markets";
export const DEFAULT_BREADTH_SCOPE: BreadthScope = "all_markets";

/** 北交所代码：库内 symbol 形如 920001.BJ，兼容 bj920001 这种前缀写法 */
export function isBeijingSymbol(symbol: string): boolean {
  const s = (symbol ?? "").toUpperCase();
  return s.endsWith(".BJ") || s.startsWith("BJ");
}

export function breadthScopeLabel(scope: BreadthScope): string {
  return scope === "all_markets" ? "全A（沪+深+北）" : "两市（沪+深，剔北交所）";
}

export interface StockBar {
  symbol: string;
  date: string; // YYYY-MM-DD
  close: number;
}

export interface BreadthDayStat {
  date: string;
  universe: number; // 当日有收盘价行的票数（分母上界）
  ma5_eligible: number; // 当日有行且该票历史（含当日）≥5 根
  ma3_eligible: number; // 同上 ≥3 根
  above_ma5: number;
  above_ma5_pct: number | null; // ma5_eligible=0 → null（缺，不是 0%）
  above_ma3: number; // 站上3日线家数（低于3日线家数 = ma3_eligible − 这个，与 MA5 那一对同构）
  new_low_5: number;
  new_low_3: number;
}

/** 输入不要求全局有序；同票同日重复行取首条（库里 unique 键本就挡重，这里是防御性去重）。
 *  scope 默认三市全A（all_markets）：北交所的行照样在库里（回填与自产都不筛票），也进默认分母——
 *  要跟稳智同步种子对照才显式传 "two_markets"，两个口径共用同一套判定，差别只在票池。 */
export function computeBreadthSeries(bars: StockBar[], scope: BreadthScope = DEFAULT_BREADTH_SCOPE): BreadthDayStat[] {
  // 按票分组、组内按日期升序（同日重复取第一条出现的价）
  const bySymbol = new Map<string, Map<string, number>>();
  for (const b of bars) {
    if (!isFinite(b.close) || b.close <= 0 || !b.date) continue; // 脏行不进统计
    if (scope === "two_markets" && isBeijingSymbol(b.symbol)) continue; // 票池筛选在进组前做，分母与判定同源
    let m = bySymbol.get(b.symbol);
    if (!m) bySymbol.set(b.symbol, (m = new Map()));
    if (!m.has(b.date)) m.set(b.date, b.close);
  }

  const acc = new Map<string, BreadthDayStat>(); // date → 累计器（日期天然去重）
  for (const g of bySymbol.values()) {
    const sorted = [...g.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      const [date, close] = sorted[i];
      let s = acc.get(date);
      if (!s) {
        s = { date, universe: 0, ma5_eligible: 0, ma3_eligible: 0, above_ma5: 0, above_ma5_pct: null, above_ma3: 0, new_low_5: 0, new_low_3: 0 };
        acc.set(date, s);
      }
      s.universe++;
      const prior4 = sorted.slice(Math.max(0, i - 4), i).map((x) => x[1]); // 不含当日的最近 4 根
      const prior2 = sorted.slice(Math.max(0, i - 2), i).map((x) => x[1]); // 不含当日的最近 2 根
      if (i + 1 >= 5) {
        // 满 5 根：进 MA5 与两档新低口径（满 5 必满 3，3 日口径同批票一起计）
        const win = [...prior4, close]; // 含当日的 5 根
        const mean = win.reduce((a, c) => a + c, 0) / win.length;
        s.ma5_eligible++;
        if (close > mean) s.above_ma5++;
        if (close <= Math.min(...prior4)) s.new_low_5++;
        s.ma3_eligible++;
        const mean3 = [...prior2, close].reduce((a, c) => a + c, 0) / 3;
        if (close > mean3) s.above_ma3++;
        if (close <= Math.min(...prior2)) s.new_low_3++;
      } else if (i + 1 >= 3) {
        // 不满 5 根满 3 根：只进 3 日口径（新低 + 站上3日线），不进 MA5 口径——不拿 4 根凑 5 根的数
        s.ma3_eligible++;
        const mean3 = [...prior2, close].reduce((a, c) => a + c, 0) / 3;
        if (close > mean3) s.above_ma3++;
        if (close <= Math.min(...prior2)) s.new_low_3++;
      }
    }
  }

  const out = [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const s of out) {
    s.above_ma5_pct = s.ma5_eligible > 0 ? (s.above_ma5 / s.ma5_eligible) * 100 : null;
  }
  return out;
}

/** 沉淀进度：库里已有多少个不同的交易日行（页面「攒中 N/5」与图表空不空的判据） */
export function storedTradingDays(bars: StockBar[]): number {
  const dates = new Set<string>();
  for (const b of bars) if (b.date) dates.add(b.date);
  return dates.size;
}

/** 复盘统计里宽度那三列的形状（微/中/大盘分组不在这里——库里只有收盘价，没有市值分层，自产不了） */
export interface BreadthWidthCols {
  aboveMa5Pct: number | null;
  belowMa5: number | null;
  belowMa3: number | null;
}

/**
 * 从逐票收盘价里取**某一个交易日**的宽度三列，给收盘后的复盘统计行用。
 * 「低于5日线家数」按 分母 − 站上家数 算，与种子那 110 行的算法一致（种子 belowMa5/(1−aboveMa5Pct/100)
 * 反推出的分母天天稳在 5,160~5,211，说明它就是 分母−站上，不是另一种口径）。
 * 缺就是缺：库里没有这一天的行（宽度那一路没跑/全停牌）返回 null，三列一律留空，
 * 不拿上一天的数顶替、也不写 0（0 家跌破是个事实断言，我们没读到就不能说）。
 */
export function widthColsForDate(
  bars: StockBar[], date: string, scope: BreadthScope = DEFAULT_BREADTH_SCOPE,
): BreadthWidthCols | null {
  const row = computeBreadthSeries(bars, scope).find((r) => r.date === date);
  if (!row) return null;
  return {
    aboveMa5Pct: row.above_ma5_pct, // 分母 0 时本身已是 null
    belowMa5: row.ma5_eligible > 0 ? row.ma5_eligible - row.above_ma5 : null,
    belowMa3: row.ma3_eligible > 0 ? row.ma3_eligible - row.above_ma3 : null,
  };
}

/** 取数窗口（日历日）：days 个交易日粗略按 1.6 折算，再垫 10 天给首行前 4 根的窗口。
 *  页面那条序列（/api/market/breadth）与收盘后自产的宽度列**共用这个公式**——
 *  两边同一窗口，同一天的分母才对得上。2026-09-28 实测：库里最近 40 个交易日与最近 88 个交易日
 *  两个窗口算出来的 ma5_eligible 都是 5,565，「只有长窗口才攒满 5 根」的票数为 0，
 *  所以窗口长短在这个库里不动分母；真要动的时候（长期停牌票变多）这条会先在这里露馅。 */
export const BREADTH_PAGE_DAYS = 30; // 首页宽度图的默认区间（30 个交易日）
export function breadthCalendarLookback(days: number): number {
  return Math.ceil(days * 1.6) + 10;
}

/** 给页面/工具的固定口径句（同一份措辞，不散落各处各写各的） */
export const BREADTH_CALIBER =
  "站上5日线占比/创5日(3日)新低：按每票已沉淀的收盘价序列滚动（停牌不补价、凑不满根数不进分母）；" +
  "票池是三市全A（沪+深+北交所，5,569 只），因为本地库里北交所的行本来就有——要拿稳智同步口径做对照才显式筛成两市；" +
  "2026-04-20~09-24 的历史逐票收盘价用真实日K（不复权原始价）回填，之后的交易日由收盘后调度器自产——同一套算法、同一种价格基准。" +
  "对照实测：种子票池是两市（剔北交后两边分母逐日贴合），但两口径还剩约 4.4 个百分点的差，是种子那条线在弱市更平滑，不是票池";
