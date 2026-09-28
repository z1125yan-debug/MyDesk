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
  new_low_5: number;
  new_low_3: number;
}

/** 输入不要求全局有序；同票同日重复行取首条（库里 unique 键本就挡重，这里是防御性去重）。 */
export function computeBreadthSeries(bars: StockBar[]): BreadthDayStat[] {
  // 按票分组、组内按日期升序（同日重复取第一条出现的价）
  const bySymbol = new Map<string, Map<string, number>>();
  for (const b of bars) {
    if (!isFinite(b.close) || b.close <= 0 || !b.date) continue; // 脏行不进统计
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
        s = { date, universe: 0, ma5_eligible: 0, ma3_eligible: 0, above_ma5: 0, above_ma5_pct: null, new_low_5: 0, new_low_3: 0 };
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
        if (close <= Math.min(...prior2)) s.new_low_3++;
      } else if (i + 1 >= 3) {
        // 不满 5 根满 3 根：只进 3 日新低口径，不进 MA5 口径——不拿 4 根凑 5 根的数
        s.ma3_eligible++;
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

/** 给页面/工具的固定口径句（同一份措辞，不散落各处各写各的） */
export const BREADTH_CALIBER =
  "站上5日线占比/创5日(3日)新低：按每票已沉淀的收盘价序列滚动（停牌不补价、凑不满根数不进分母）；" +
  "2026-04-20~09-24 的历史逐票收盘价用真实日K（不复权原始价）回填，之后的交易日由收盘后调度器自产——同一套算法、同一种价格基准";
