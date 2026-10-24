// 定时价格快照 · 纯核（零 IO、零时钟、零数据库）
//
// 用户 2026-10-16 最新口径（以这个为准，之前的“三时刻含昨晚”已废弃），
// 2026-10-17 修正卖出日（之前错把买入日当卖出日）：
//   · 完整生命周期：D 选股（收盘后，决策日）→ D+1 开盘买 → D+2 卖。
//   · 三个快照是卖出日 D+2 的三个候选卖点：
//       10:30      = 卖出日 10:30 盘中价（一般卖都是这个时间卖）
//       11:30 休盘 = 卖出日 11:30 上午收盘价（中午休盘）
//       15:00 收盘 = 卖出日 15:00 收盘价（下午收盘后定稿）
//   · 买入日（D+1）/ 选股日（D）的价格不是卖点，不抓、不当卖点用。
//     10-16 抓的那批是买入日的，不能当卖点用（文件保留，但排除在版本评估之外）。
//   · 成本 = 卖出日之前最近一个交易日（D+1）的收盘价（DB 日K），不随快照落档。
//     注意：卖出日快照的收益口径（价 vs D+1 收盘）≠ T+1 收益（D+2 卖价 vs D+1 开盘买入价
//     再扣 0.41% 成本）。两者差 D+1 开盘→收盘那段。本任务不擅自改成本基数，
//     只把关系写明，供用户确认。
//   · 对比 = 今天 10:30 卖 vs 今天 11:30 休盘卖 vs 今天 15:00 收盘卖，
//     哪个多赚。日报里每个涨跌幅后面都写当时时间：
//     “昨天收盘”“今天 10:30”“今天 11:30 休盘”“今天 15:00 收盘”，不混在一起。
//   · 日报写法：午报（12:00）写 10:30 + 11:30 休盘的涨跌（收盘还没发生，
//     比不了收盘）；晚报（16:00）写 10:30 + 11:30 休盘 + 15:00 收盘的涨跌。
//   · 涨跌幅的基数统一是昨天收盘价（成本）：
//     10:30 涨跌 = (10:30 价 − 昨天收盘价) / 昨天收盘价；
//     11:30、收盘同理。三个涨跌幅基数相同，才能直接比。
//   · 卖点比较用价格本身：最高价的那个时刻卖最合适。
//   · 缺快照就说“没取到”，不编、不拿别的时间的价顶替。
//     10:30 / 11:30 必须当时现抓，事后拿日K还原不了当时盘中价。
//
// 午报门禁也钉在文件头注释里：午报是上午盘复盘（9:30–11:30），必须 12:00 之后
// 才发。09:56 这种盘中数据只能叫“上午盘中快照”，不能当午报发。

export type SnapshotSlot = "1030" | "1130" | "close";

export interface SnapshotSlotDef {
  slot: SnapshotSlot;
  /** 如“10:30”“11:30 休盘”“15:00 收盘” */
  label: string;
  /** 北京时间当日分钟数：10:30=630，11:30=690，15:00 收盘价在 16:00 抓取=960 */
  minuteOfDay: number;
  /** 该快照的价格含义 */
  meaning: string;
  /** 卖点说明 */
  sellNote: string;
}

export const SNAPSHOT_SLOT_DEFS: SnapshotSlotDef[] = [
  {
    slot: "1030",
    label: "10:30",
    minuteOfDay: 10 * 60 + 30,
    meaning: "当日 10:30 盘中价（一般卖都是这个时间卖）",
    sellNote: "10:30 卖的参照价",
  },
  {
    slot: "1130",
    label: "11:30 休盘",
    minuteOfDay: 11 * 60 + 30,
    meaning: "当日 11:30 上午收盘价（中午休盘）",
    sellNote: "11:30 休盘卖的参照价",
  },
  {
    slot: "close",
    label: "15:00 收盘",
    minuteOfDay: 16 * 60,
    meaning: "当日 15:00 收盘价（下午收盘后定稿，16:00 抓取）",
    sellNote: "拿到收盘卖的参照价",
  },
];

export function snapshotDefOf(slot: SnapshotSlot): SnapshotSlotDef {
  return SNAPSHOT_SLOT_DEFS.find((d) => d.slot === slot) ?? SNAPSHOT_SLOT_DEFS[2];
}

export function isSnapshotSlot(v: string | null): v is SnapshotSlot {
  return v === "1030" || v === "1130" || v === "close";
}

// ── 卖出日：决策日 D 之后的第 2 个交易日（D+2，跳周末/休市） ──

/** 卖出日偏移：决策日之后第几个交易日卖出 */
export const VERSION_SELL_OFFSET = 2;

/**
 * 决策日 D 的卖出日 = D 之后第 2 个交易日。
 * tradingDaysAfterDecision：D 之后的交易日（升序，至少 2 个才算得出；IO 层用 trade-calendar 给）。
 * 只有 0/1 个 → null（算不出，不猜）。买入日（第 1 个）绝不是卖出日。
 */
export function sellDayOfDecision(
  decisionDate: string,
  tradingDaysAfterDecision: readonly string[],
): string | null {
  void decisionDate;
  if (tradingDaysAfterDecision.length < VERSION_SELL_OFFSET) return null;
  return tradingDaysAfterDecision[VERSION_SELL_OFFSET - 1] ?? null;
}

/** 版本评估的 evalDate 门禁：卖出日算得出时，evalDate 必须等于卖出日；算不出时放行显式 evalDate */
export function isSellDayEval(evalDate: string, sellDay: string | null): boolean {
  return sellDay == null || evalDate === sellDay;
}

export interface SellDayVersionLike {
  tradeDate: string;
  picks: readonly { symbol: string; name?: string | null }[];
}

/**
 * 某日卖出日的版本（纯函数）：从全部版本里找“卖出日 = date”的那个决策日的全部版本。
 * sellDayByDecision：决策日 → 卖出日（IO 层用 trade-calendar 算；卖出日 null = 算不出，不匹配）。
 * 决策日→卖出日是单射，最多一个决策日匹配。没有 → decisionDate null、versions []、picks []。
 * 买入日（D+1）/ 选股日（D）永远不匹配——它们的卖出日不是当天。
 */
export function versionsSellingOnDate(
  versions: readonly SellDayVersionLike[],
  date: string,
  sellDayByDecision: ReadonlyMap<string, string | null>,
): { decisionDate: string | null; versions: SellDayVersionLike[]; picks: { symbol: string; name: string }[] } {
  const byDecision = new Map<string, SellDayVersionLike[]>();
  for (const v of versions) {
    const arr = byDecision.get(v.tradeDate) ?? [];
    arr.push(v);
    byDecision.set(v.tradeDate, arr);
  }
  for (const decisionDate of [...byDecision.keys()].sort()) {
    if (sellDayByDecision.get(decisionDate) !== date) continue;
    const matched = byDecision.get(decisionDate) ?? [];
    const map = new Map<string, { symbol: string; name: string }>();
    for (const v of matched) {
      for (const p of v.picks) {
        const symbol = String(p.symbol || "").trim().toUpperCase();
        if (!symbol) continue;
        if (!map.has(symbol)) map.set(symbol, { symbol, name: p.name || symbol });
      }
    }
    return { decisionDate, versions: matched, picks: [...map.values()] };
  }
  return { decisionDate: null, versions: [], picks: [] };
}

// ── 快照行 ──

export interface PriceSnapshotRow {
  symbol: string;
  name: string;
  /** 该时刻的价格；null = 该票该时刻没取到 */
  price: number | null;
  /** 该时刻价格的前收盘价（算涨跌幅的基数）；null = 基数没取到 */
  prevClose: number | null;
  /** 该时刻的涨跌幅 %（(price-prevClose)/prevClose*100）；基数缺失时 null，不编 */
  changePct: number | null;
}

export interface PriceSnapshot {
  /** 快照归属的交易日（北京时间，如 2026-10-16） */
  date: string;
  slot: SnapshotSlot;
  label: string;
  /** 抓取时刻（北京时间戳，如 2026-10-16 10:30:12） */
  capturedAt: string;
  rows: PriceSnapshotRow[];
  /** 没取到的票 */
  missingSymbols: string[];
}

/** 价格 + 前收 → 涨跌幅；任一缺失返回 null（不拿 0 顶替） */
export function changePctOf(price: number | null, prevClose: number | null): number | null {
  if (price == null || prevClose == null || prevClose <= 0) return null;
  return ((price - prevClose) / prevClose) * 100;
}

export function fmtPct(v: number | null): string {
  if (v == null) return "涨跌没取到";
  return v >= 0 ? `涨 ${v.toFixed(2)}%` : `跌 ${Math.abs(v).toFixed(2)}%`;
}

// ── 什么时候卖最合适：三个卖点比价格（成本 = 昨天收盘价，不参与比，只当基数） ──

export interface SellWindowPoint {
  slot: SnapshotSlot;
  label: string;
  price: number | null;
  /** 该卖点的涨跌幅 %（基数 = 昨天收盘价）；成本缺失时 null */
  changePct: number | null;
}

export interface SellWindowComparison {
  symbol: string;
  name: string;
  /** 昨天收盘价（成本）；null = 成本没取到（涨跌幅算不出，但价格对比仍可比） */
  cost: number | null;
  /** 三个卖点的点（顺序固定：10:30 / 11:30 休盘 / 15:00 收盘） */
  points: SellWindowPoint[];
  /** 最高价的卖点；任一卖点价格缺失时 null（比不了，不编结论） */
  bestSlot: SnapshotSlot | null;
  bestLabel: string | null;
  /** 最好卖的价 vs 收盘价，多赚/少赚 %（正 = 比收盘卖多赚，负 = 少赚）；缺失时 null */
  advantageVsClosePct: number | null;
  /** 小白一句话（带当时时间） */
  plain: string;
}

const SELL_ORDER: SnapshotSlot[] = ["1030", "1130", "close"];

/**
 * 三个卖点比价格：最高价的时刻卖最合适。
 * 任一卖点价格缺失 → bestSlot = null，plain 明说哪个时刻没取到，不编结论。
 * 三个卖点价格全相等 → bestSlot = null，plain 写“三个时刻价一样，怎么卖都一样”。
 * 成本缺失时涨跌幅全为 null，但价格对比仍可比（plain 会明说成本没取到）。
 */
export function compareSellWindows(
  symbol: string,
  name: string,
  cost: number | null,
  pointsBySlot: Partial<Record<SnapshotSlot, { price: number | null; changePct: number | null }>>,
): SellWindowComparison {
  const points: SellWindowPoint[] = SELL_ORDER.map((slot) => {
    const p = pointsBySlot[slot];
    return {
      slot,
      label: snapshotDefOf(slot).label,
      price: p?.price ?? null,
      changePct: p?.changePct ?? null,
    };
  });
  const costText =
    cost == null
      ? "昨天收盘价（成本）没取到"
      : `昨天收盘价（成本）${cost}`;
  const pointText = points
    .map((p) => `今天 ${p.label}时 ${p.price == null ? "价格没取到" : `价格 ${p.price}，${fmtPct(p.changePct)}`}`)
    .join("；");
  const head = `${name}：${costText}；${pointText}。`;
  const missing = points.filter((p) => p.price == null);
  if (missing.length) {
    return {
      symbol, name, cost, points,
      bestSlot: null, bestLabel: null, advantageVsClosePct: null,
      plain: `${head}${missing.map((m) => `今天 ${m.label}`).join("、")}没取到，比不出哪个时间卖最合适，不编。`,
    };
  }
  const prices = points.map((p) => p.price as number);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  if (max === min) {
    return {
      symbol, name, cost, points,
      bestSlot: null, bestLabel: null, advantageVsClosePct: 0,
      plain: `${head}三个时刻价一样，怎么卖都一样。`,
    };
  }
  const best = points.find((p) => p.price === max) as SellWindowPoint;
  const close = points.find((p) => p.slot === "close") as SellWindowPoint;
  const closePrice = close.price as number;
  const advantage = ((max - closePrice) / closePrice) * 100;
  let verb: string;
  if (best.slot === "1030") {
    verb = `今天 10:30 卖最好，比拿到收盘卖多赚 ${advantage.toFixed(2)}%。`;
  } else if (best.slot === "1130") {
    verb = `今天 11:30 休盘卖最好，比拿到收盘卖多赚 ${advantage.toFixed(2)}%。`;
  } else {
    // best 是收盘：对比早卖的最高点（10:30 / 11:30 中价高的那个），说清拿住多赚多少
    const early = points.filter((p) => p.slot !== "close");
    const earlyMax = Math.max(...early.map((p) => p.price as number));
    const earlyBest = early.find((p) => p.price === earlyMax) as SellWindowPoint;
    const gainVsEarly = ((closePrice - earlyMax) / earlyMax) * 100;
    verb = `拿到收盘卖最好，比今天 ${earlyBest.label}卖多赚 ${gainVsEarly.toFixed(2)}%（早卖就卖早了）。`;
  }
  return {
    symbol, name, cost, points,
    bestSlot: best.slot,
    bestLabel: best.label,
    advantageVsClosePct: advantage,
    plain: `${head}${verb}`,
  };
}

/** 多只票的卖点对比 → 日报一节（小白语言，每句都带当时时间） */
export function sellWindowSectionPlain(
  comparisons: readonly SellWindowComparison[],
  opts?: { title?: string },
): string {
  const title = opts?.title ?? "什么时候卖最合适（10:30 / 11:30 休盘 / 15:00 收盘对比）";
  if (!comparisons.length) {
    return `${title}：没有可对比的票（快照没取到），算不出什么时候卖最合适。`;
  }
  const lines = comparisons.map((c) => c.plain).join(" ");
  return `${title}：${lines}`;
}

// ── 两点对比（午报用：收盘还没发生，只比 10:30 vs 11:30 休盘） ──

/**
 * 两点比价格：午报 12:00 时收盘价还没出，只能比“10:30 卖”和“11:30 休盘卖”。
 * 成本（昨天收盘价）只当涨跌幅基数，不参与比。
 * 任一点缺失 → plain 明说缺了哪个，不编结论。
 */
export function compareSellPair(
  symbol: string,
  name: string,
  cost: number | null,
  a: { label: string; price: number | null; changePct: number | null },
  b: { label: string; price: number | null; changePct: number | null },
): string {
  const costText =
    cost == null ? "昨天收盘价（成本）没取到" : `昨天收盘价（成本）${cost}`;
  const text = (p: typeof a): string =>
    `今天 ${p.label}时 ${p.price == null ? "价格没取到" : `价格 ${p.price}，${fmtPct(p.changePct)}`}`;
  if (a.price == null || b.price == null) {
    const missing = [a, b].filter((p) => p.price == null).map((p) => `今天 ${p.label}`).join("、");
    return `${name}：${costText}；${text(a)}；${text(b)}。${missing}没取到，比不出哪个时间卖最合适，不编。`;
  }
  if (a.price === b.price) {
    return `${name}：${costText}；${text(a)}；${text(b)}。两个时刻价一样，怎么卖都一样。`;
  }
  const [high, low] = a.price > b.price ? [a, b] : [b, a];
  const diff = (Math.abs(a.price - b.price) / (low.price as number)) * 100;
  return `${name}：${costText}；${text(a)}；${text(b)}。今天 ${high.label}卖最好，比今天 ${low.label}卖多赚 ${diff.toFixed(2)}%。`;
}
