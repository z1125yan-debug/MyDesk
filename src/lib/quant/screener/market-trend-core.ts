// 大盘趋势图的纯内核（P15-R2a 对齐稳智「市场情绪分析页」）。零 IO，node 可直测；
// 取数在 market-trend.ts（服务端），画图在 MarketPage —— 三处只吃这一份口径。
//
// 为什么单独成文件：两市成交额合计、涨跌停日配对、vs昨日增量这些算错一位就是假数字，
// 必须能在 node 里钉行为；且「缺哪边就是缺」的诚实口径不能被渲染层各自发明。
//
// 诚实纪律：
//  - 某天只有沪没有深（或反之）：那天合计为 null，不是「有边就算」更不是补 0；
//  - vs昨日只在「今天有读数且上一配对日也有读数」时给，配对断档就明说缺；
//  - 累计收益按区间首日收盘归一；首日就是基准（0%），不藏「基准日也画点」的错位。

export interface IndexDayBar {
  /** YYYY-MM-DD */
  date: string;
  close: number;
  /** 成交额（亿）。数据源给「元」，进核前已换算；缺读数不出这个对象 */
  amountYi: number;
}

/** 按日配对的成交额（大盘成交额趋势口径：沪深北（沪+深+北证50），缺北证时退化为沪深两市） */
export interface TurnoverPoint {
  date: string;
  shYi: number | null;
  szYi: number | null;
  /** 北证50 成交额（亿）；未启用沪深北口径时为 null */
  bjYi?: number | null;
  /**
   * 合计。缺任一边为 null（不拿单边冒充合计）。
   * 沪深北口径下要求沪、深、北三者齐全才出数——北交所体量虽小，但缺一天就不该假装那天有北证数据。
   */
  totalYi: number | null;
}

export function mergeTurnover(sh: IndexDayBar[], sz: IndexDayBar[], bj?: IndexDayBar[]): TurnoverPoint[] {
  const szMap = new Map(sz.map((b) => [b.date, b]));
  const shMap = new Map(sh.map((b) => [b.date, b]));
  const bjMap = new Map((bj ?? []).map((b) => [b.date, b]));
  const useBj = Array.isArray(bj) && bj.length > 0;
  const dates = [...new Set([...shMap.keys(), ...szMap.keys(), ...(useBj ? bjMap.keys() : [])])].sort();
  return dates.map((d) => {
    const a = shMap.get(d)?.amountYi ?? null;
    const b = szMap.get(d)?.amountYi ?? null;
    const c = useBj ? (bjMap.get(d)?.amountYi ?? null) : null;
    // 沪深北：三者齐全才合计；两市：沪深齐全才合计
    const total = a !== null && b !== null && (!useBj || c !== null)
      ? a + b + (useBj ? (c as number) : 0)
      : null;
    return { date: d, shYi: a ?? null, szYi: b ?? null, bjYi: useBj ? c : null, totalYi: total };
  });
}

/** 今天相对上一个配对日的合计增量（亿）；任一缺读数返回 null，调用方按「暂无数据」画 */
export function turnoverDeltaVsPrev(pts: TurnoverPoint[]): { deltaYi: number | null; prevDate: string | null } {
  const paired = pts.filter((p): p is TurnoverPoint & { totalYi: number } => p.totalYi !== null);
  if (!paired.length) return { deltaYi: null, prevDate: null };
  const today = paired[paired.length - 1];
  const prev = paired[paired.length - 2]; // 排序在 mergeTurnover 已按日期做过
  if (!prev) return { deltaYi: null, prevDate: null };
  return { deltaYi: today.totalYi - prev.totalYi, prevDate: prev.date };
}

/** 指数按区间首日收盘归一的累计涨跌幅（%）；无 bars 给空序列，首日固定 0 */
export function cumReturnSeries(bars: IndexDayBar[]): { date: string; pct: number }[] {
  if (!bars.length) return [];
  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : 1));
  const base = sorted[0].close;
  if (!base) return [];
  return sorted.map((b) => ({ date: b.date, pct: ((b.close - base) / base) * 100 }));
}

/** 日期范围过滤（闭区间，字符串比较即可：YYYY-MM-DD 字典序=日期序）。空 from/to 表示不设边 */
export function inRange(bars: IndexDayBar[], from: string, to: string): IndexDayBar[] {
  return bars.filter((b) => (!from || b.date >= from) && (!to || b.date <= to));
}

/** 图注要自报的口径串：拿了几根、缺哪边——数字对不上时用户能自己看出是「没取到」不是「没有」 */
export function trendNotes(shCount: number, szCount: number, cybCount: number): string[] {
  const notes: string[] = [];
  if (shCount !== szCount) notes.push(`沪 ${shCount} 日、深 ${szCount} 日不齐：不齐的日期合计按缺数据画，不拿单边冒充两市`);
  if (cybCount === 0) notes.push("创业板指没有取到读数：指数图只画沪深两线");
  return notes;
}
