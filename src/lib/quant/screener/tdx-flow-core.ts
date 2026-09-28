// P15-R16 主力净额「逐笔自算」纯核：把通达信当日逐笔（trades.today 的分笔）按东财 f62 同一把
// 尺子分档轧差，得出主力净流入 / 超大单净额 / 大单净额 / 净占比。
//
// 为什么要自算：东财 push2 断源后，全仓唯一一个「主力资金」读数来源就没了（个股/地域两榜当时
// 直接落回演示数据）。通达信网关里**没有**现成的资金流字段（126 个方法逐个查过，MCP 那个
// symbol_zjlx 上游自带 dict/list 契约 bug 不能用），但它给了当日逐笔成交，且每一笔都带
// side=buy/sell —— 有方向、有价、有量，就够按公开口径把「特大+大单主动买卖」算出来。
//
// 口径（与东财资金流分档一致，逐条钉死在这里，不留在注释里飘着）：
//   特大单 = 单笔成交额 ≥100万元；大单 = 20万 ≤ 单笔 < 100万；中单/小单不计入主力。
//   主力净额 = (特大买+大买) − (特大卖+大卖)，恒等式 main = superBig + big（钉测第 1 条就验它）。
//   只计 event_kind="trade" 且 side 明确为 buy/sell 的笔：中性笔（方向判定不出来）与集合竞价
//   撮合笔一律不计入，但**计数并如实上报**——这是本口径与东财逐笔口径的系统性差异来源之一。
//
// 与东财数字对不上的原因（诚实口径，页面上也要说）：通达信这里是**分笔聚合**成交（一笔可能由
// 多张委托撮成，order_count 就是那张数），东财是按委托拆单后归档。同一只票同一个时刻两边
// 不会逐分不差，所以本层产出必须挂「自算」出身，绝不冒充东财官方读数。
//
// 零依赖纯核：node --test 可直跑，钉在 p15-r16-tdx-flow.test.ts。IO 与翻页在 src/lib/desk/tdx.ts。

/** 特大单阈值（元/笔）：单笔成交额 ≥100万 */
export const SUPER_BAND_YUAN = 1_000_000;
/** 大单阈值（元/笔）：20万 ≤ 单笔成交额 < 100万 */
export const BIG_BAND_YUAN = 200_000;
/** 逐笔翻页页长（网关单页上限实测 1800 笔） */
export const TICK_PAGE = 1800;
/** 单只最多翻几页：超限就是「样本截断」，不许静默按半截数算净额 */
export const MAX_TICK_PAGES = 10;
/** 自算覆盖的只数：当日成交额前 N 只。榜口径必须说清是这个子集内排序，不是全市场 */
export const MAIN_FLOW_UNIVERSE = 60;

/** 页面出身说明（消费方引用这批数时必须带上这句） */
export const MAIN_FLOW_BASIS =
  "通达信逐笔自算：特大单(≥100万)+大单(20–100万) 主动买−主动卖；中性笔与开盘集合竞价撮合不计入";

export interface FlowTickLike {
  price?: number | null;
  volume?: number | null;   // 手（1 手 = 100 股）
  side?: string | null;     // buy / sell / neutral
  event_kind?: string | null; // trade / opening_match / …
  absolute_index?: number | null;
  index?: number | null;
}

export interface FlowAccum {
  superBuyYuan: number;
  superSellYuan: number;
  bigBuyYuan: number;
  bigSellYuan: number;
  allBuyYuan: number;   // 全日主动买额（不分档）：给内外盘口径做交叉核对
  allSellYuan: number;
  buyTicks: number;
  sellTicks: number;
  neutralTicks: number; // side 判定不出来的笔数（如实计数，不当 0 消失）
  auctionTicks: number; // 集合竞价/非连续竞价的撮合笔数
  badTicks: number;     // 价或量缺失/非正的笔数
  ticksSeen: number;    // 去重后实际计入的笔数
  dupTicks: number;     // 翻页重叠被去重掉的笔数
}

export interface MainFlow {
  superBigYi: number;  // 超大单净额（亿）
  bigYi: number;       // 大单净额（亿）
  mainNetYi: number;   // 主力净额（亿）= superBigYi + bigYi
  buyYi: number;       // 主力买入额（亿）
  sellYi: number;      // 主力卖出额（亿）
  ratioPct: number | null; // 净占比% = 主力净额 / 当日成交额；成交额未知为 null（不补 0）
  sampleTicks: number;
  neutralTicks: number;
  auctionTicks: number;
  badTicks: number;
  pages: number;
  truncated: boolean;      // 翻页撞到 MAX_TICK_PAGES
  sampleComplete: boolean; // 取到的笔数是否覆盖到快照给出的全日笔数
  basis: string;
}

const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : NaN);

/** 单笔成交额（元）= 价(元) × 量(手) × 100；坏输入返回 NaN，由调用方计入 badTicks */
export function tickAmountYuan(price: unknown, volumeHand: unknown): number {
  const p = num(price);
  const v = num(volumeHand);
  if (!(p > 0) || !(v > 0)) return NaN;
  return p * v * 100;
}

/** 分档：特大 / 大 / 不计入（中单小单与坏值都是 null） */
export function bandOf(amountYuan: number): "super" | "big" | null {
  if (!isFinite(amountYuan)) return null;
  if (amountYuan >= SUPER_BAND_YUAN) return "super";
  if (amountYuan >= BIG_BAND_YUAN) return "big";
  return null;
}

export function emptyFlowAccum(): FlowAccum {
  return {
    superBuyYuan: 0, superSellYuan: 0, bigBuyYuan: 0, bigSellYuan: 0,
    allBuyYuan: 0, allSellYuan: 0,
    buyTicks: 0, sellTicks: 0, neutralTicks: 0, auctionTicks: 0, badTicks: 0,
    ticksSeen: 0, dupTicks: 0,
  };
}

/**
 * 逐笔累加：按 absolute_index（缺失退 index）去重后分档轧差。
 * 只做纯计算——不读时间、不猜方向：side 不是 buy/sell 就是中性笔，计入 neutralTicks 不进金额。
 */
export function accumulateTicks(ticks: readonly FlowTickLike[]): FlowAccum {
  const acc = emptyFlowAccum();
  const seen = new Set<string>();
  for (const tk of ticks ?? []) {
    if (!tk || typeof tk !== "object") { acc.badTicks++; continue; }
    const key = tk.absolute_index ?? tk.index;
    const k = key === null || key === undefined ? `n:${seen.size}` : String(key);
    if (seen.has(k)) { acc.dupTicks++; continue; } // 翻页首尾重叠：同一笔只算一次
    seen.add(k);
    acc.ticksSeen++;
    const amount = tickAmountYuan(tk.price, tk.volume);
    if (!isFinite(amount)) { acc.badTicks++; continue; }
    const isTrade = (tk.event_kind ?? "trade") === "trade";
    if (!isTrade) { acc.auctionTicks++; continue; }
    const side = String(tk.side ?? "").toLowerCase();
    if (side === "buy") {
      acc.buyTicks++;
      acc.allBuyYuan += amount;
      const band = bandOf(amount);
      if (band === "super") acc.superBuyYuan += amount;
      else if (band === "big") acc.bigBuyYuan += amount;
    } else if (side === "sell") {
      acc.sellTicks++;
      acc.allSellYuan += amount;
      const band = bandOf(amount);
      if (band === "super") acc.superSellYuan += amount;
      else if (band === "big") acc.bigSellYuan += amount;
    } else {
      acc.neutralTicks++;
    }
  }
  return acc;
}

/**
 * 累加结果 → 主力净额读数。amountYuan（当日成交额，元）用于净占比；拿不到就 null，
 * 由页面显「—」——补一个 0 就是把「不知道」说成「占比为 0」。
 */
export function mainFlowFromAccum(
  acc: FlowAccum,
  opts: { pages: number; truncated: boolean; amountYuan?: number | null; expectedTicks?: number | null; complete?: boolean },
): MainFlow {
  const superBigYi = (acc.superBuyYuan - acc.superSellYuan) / 1e8;
  const bigYi = (acc.bigBuyYuan - acc.bigSellYuan) / 1e8;
  const mainNetYi = superBigYi + bigYi;
  const amount = num(opts.amountYuan);
  const expected = num(opts.expectedTicks);
  return {
    superBigYi,
    bigYi,
    mainNetYi,
    buyYi: (acc.superBuyYuan + acc.bigBuyYuan) / 1e8,
    sellYi: (acc.superSellYuan + acc.bigSellYuan) / 1e8,
    ratioPct: amount > 0 ? (mainNetYi * 1e8) / amount * 100 : null,
    sampleTicks: acc.ticksSeen,
    neutralTicks: acc.neutralTicks,
    auctionTicks: acc.auctionTicks,
    badTicks: acc.badTicks,
    pages: opts.pages,
    truncated: opts.truncated,
    // 快照给的 active1 是全日分笔数：取够数才算样本完整；没有 active1 时不冒充完整（false）。
    // R20 例外：`trades.all_today` 一次就把当天的逐笔全给了（无翻页、无截断），
    // 这时即便拿不到 active1 对账，也确实拿到了全日样本 → complete=true 直接认完整。
    // 截断一票否决：哪怕是 all_today 取的，撞了页上限就只是半截样本，不许认完整。
    sampleComplete: !opts.truncated && (!!opts.complete || (isFinite(expected) && expected > 0 && acc.ticksSeen >= expected)),
    basis: MAIN_FLOW_BASIS,
  };
}

export interface MainFlowRowLike {
  name: string;
  code: string;      // MyDesk 符号 688825.SH
  changePct: number;
  flow: MainFlow | null; // null = 这只票的逐笔没取到（网关断/超时），不是「净额为 0」
}

/** 榜的取侧：流入向取净额>0 降序、流出向取净额<0 升序；没取到读数的行不进榜（不占位、不补 0） */
export function pickMainFlowSide(rows: readonly MainFlowRowLike[], dir: "in" | "out", size = 30): MainFlowRowLike[] {
  const withFlow = rows.filter((r) => r.flow);
  const sorted = withFlow.slice().sort((a, b) =>
    dir === "in" ? (b.flow as MainFlow).mainNetYi - (a.flow as MainFlow).mainNetYi
      : (a.flow as MainFlow).mainNetYi - (b.flow as MainFlow).mainNetYi,
  );
  const picked = dir === "in" ? sorted.filter((r) => (r.flow as MainFlow).mainNetYi > 0) : sorted.filter((r) => (r.flow as MainFlow).mainNetYi < 0);
  return picked.slice(0, size);
}

/**
 * 网关快照里的行情侧时刻（如 11294379 ⇒ 11:29:43.79）翻成 HH:MM:SS。
 * 注意秒位会越界：收盘集合竞价那一下，网关把「分 + 该分内的百分秒」直接拼十进制，
 * 于是出现 11237001 这种「11:23 + 70.01 秒」= 11:24:10 的形状（实测 60 只里有 9 只这样）。
 * 所以秒位要**归一化进分**再输出，不能拿「ss ≤ 59」当无效判掉——否则整榜最新时刻被一个
 * 越界值挡掉，页面的「行情时刻」就成空的了。认不出的形状（小时/分钟超界）仍返回空串，不猜。
 */
export function formatTdxServerTime(raw: unknown): string {
  const n = num(raw);
  if (!(n > 0)) return "";
  const s = String(Math.trunc(n));
  // ≤6 位是 HHMMSS（补两位百分秒占位）；7~8 位左侧补零到 8 位（09:29:44.79 会掉前导 0）
  const eight = (s.length <= 6 ? `${s}00` : s).padStart(8, "0").slice(0, 8);
  const hh = Number(eight.slice(0, 2));
  const mm = Number(eight.slice(2, 4));
  const ss = Number(eight.slice(4, 6));
  if (!(hh <= 23 && mm <= 59 && ss <= 99)) return "";
  const total = hh * 3600 + mm * 60 + ss; // 归一化：秒位满 60 自然进分
  if (total > 23 * 3600 + 59 * 60 + 59) return "";
  const H = Math.floor(total / 3600);
  const M = Math.floor((total % 3600) / 60);
  const S = total % 60;
  return `${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}:${String(S).padStart(2, "0")}`;
}

/**
 * 一批行情时刻里取最新的那个（各只票快照先后差几秒，页面只需要一个「截至」）。
 * 只在「认得出的时刻」里挑最新——一个认不出的大值不能把整批时刻挡成空串。
 */
export function latestServerTime(times: readonly (number | null | undefined)[]): string {
  let best: number | null = null;
  for (const t of times) {
    const n = num(t);
    if (!(n > 0) || formatTdxServerTime(n) === "") continue;
    if (best === null || n > best) best = n;
  }
  return best === null ? "" : formatTdxServerTime(best);
}
