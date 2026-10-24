// 港股 / 美股选股纯核（零 IO、零时钟）：与 A 股选股同款五件套——
// 选股筛选、宽度、分歧、事件、AI 优选——但数据只用港股 / 美股自己的。
//
// 口径纪律（与 /api/market/hk-us 同源，不编数据）：
// - 票池 = 各市场 20 只主流票（与行情页同一批），不是全市场。选股/宽度/分歧
//   的分母都是这 20 只，页面必须如实标注「主流票池，非全市场」。
// - 行情/K线/估值/新闻只来自长桥 MCP（美股长桥未接通时回退 Yahoo 公开行情，
//   由路由层做，纯核不感知来源）。长桥不给的数据一律 null：
//   换手率（无流通股本）、主力/大户/散户资金流（无逐笔/资金流工具）、
//   市值/PB（valuation 工具只给 PE）——这些字段进 unavailable_fields，
//   绝不用 A 股数据顶包，也不用 0 冒充。
// - 美股无涨跌停；港股/美股不套 A 股的涨跌停/连板/封板逻辑。
// - AI 优选是确定性规则打分（字段 → 分数 → 理由），不是模型编理由，
//   不写库（A 股 AI 优选写 strategyPick 且只认 6 位 A 股代码，港美不进那张表）。

// breadth-core 纯核（单向依赖，不回指本文件）。
import { computeBreadthSeries as _computeBreadthSeries } from "./breadth-core";

export type HkUsMarket = "HK" | "US";

export interface HkUsUniverseEntry { code: string; name: string }

/** 与 /api/market/hk-us 同一批 20 只主流票：单点来源，行情页改池子只改这里。 */
export const HK_US_UNIVERSE: Record<HkUsMarket, HkUsUniverseEntry[]> = {
  HK: [
    { code: "00700", name: "腾讯控股" },
    { code: "09988", name: "阿里巴巴" },
    { code: "03690", name: "美团" },
    { code: "01024", name: "快手" },
    { code: "01810", name: "小米集团" },
    { code: "09618", name: "京东集团" },
    { code: "02899", name: "紫金矿业" },
    { code: "03888", name: "金山软件" },
    { code: "00883", name: "中国海洋石油" },
    { code: "01171", name: "兖矿能源" },
    { code: "03988", name: "中国银行" },
    { code: "00941", name: "中国移动" },
    { code: "01398", name: "工商银行" },
    { code: "00005", name: "汇丰控股" },
    { code: "02318", name: "中国平安" },
    { code: "02628", name: "中国人寿" },
    { code: "00939", name: "建设银行" },
    { code: "03968", name: "招商银行" },
    { code: "00011", name: "恒生银行" },
    { code: "00669", name: "创科实业" },
  ],
  US: [
    { code: "NVDA", name: "英伟达" },
    { code: "AAPL", name: "苹果" },
    { code: "MSFT", name: "微软" },
    { code: "AMZN", name: "亚马逊" },
    { code: "META", name: "Meta" },
    { code: "GOOGL", name: "谷歌" },
    { code: "TSM", name: "台积电" },
    { code: "AVGO", name: "博通" },
    { code: "LLY", name: "礼来" },
    { code: "JPM", name: "摩根大通" },
    { code: "V", name: "维萨" },
    { code: "MA", name: "万事达" },
    { code: "NFLX", name: "奈飞" },
    { code: "COST", name: "好市多" },
    { code: "WMT", name: "沃尔玛" },
    { code: "AMD", name: "超威半导体" },
    { code: "TSLA", name: "特斯拉" },
    { code: "PLTR", name: "Palantir" },
    { code: "VOO", name: "标普500ETF" },
    { code: "SPY", name: "SPDR标普500" },
  ],
};

/** 宽基对照：港股用 02800（盈富基金，跟踪恒指）；美股用 SPY（已在池内）。 */
export const HK_US_BENCHMARK: Record<HkUsMarket, string> = { HK: "02800", US: "SPY" };

/** 长桥 MCP 给不了的字段：筛选项里出现即忽略 + 如实告警（与 A 股 unavailable_fields 同纪律）。 */
export const HK_US_UNAVAILABLE_FIELDS: { field: string; zh: string }[] = [
  { field: "turnover_rate", zh: "换手率" },
  { field: "main_net_yi", zh: "主力净额" },
  { field: "market_cap_yi", zh: "总市值" },
  { field: "pb", zh: "市净率" },
  { field: "floatcap_yi", zh: "流通市值" },
];

/** 可筛字段（全部由长桥 quote + 日 K + valuation 现算）。 */
export const HK_US_FILTERABLE_FIELDS: { field: string; zh: string }[] = [
  { field: "change_pct", zh: "涨跌幅%" },
  { field: "amount_yi", zh: "成交额(亿)" },
  { field: "pe_ttm", zh: "市盈率PE" },
  { field: "ret_20", zh: "近20日涨跌%" },
  { field: "ret_60", zh: "近60日涨跌%" },
  { field: "rsi_14", zh: "RSI(14)" },
  { field: "volume_ratio", zh: "量比" },
  { field: "amplitude", zh: "振幅%" },
  { field: "rps_20", zh: "相对强度RPS(20日，池内百分位)" },
  { field: "above_ma5", zh: "站上5日线(1=是)" },
  { field: "above_ma20", zh: "站上20日线(1=是)" },
  { field: "above_ma60", zh: "站上60日线(1=是)" },
];

export interface HkUsBar { date: string; o: number; h: number; l: number; c: number; v: number | null; amount: number | null }

export interface HkUsQuoteIn {
  symbol: string; // 裸代码
  name: string | null;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  turnover: number | null; // 原币成交额
}

export interface HkUsNewsIn {
  symbol: string;
  title: string;
  time: string | null;
  source: string | null;
  url: string | null;
  content: string | null;
}

export interface HkUsEnriched {
  symbol: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  amount_yi: number | null;
  pe_ttm: number | null;
  /** 长桥给不了：恒为 null，页面显「—」 */
  turnover_rate: null;
  main_net_yi: null;
  market_cap_yi: null;
  pb: null;
  bars: number; // 取到的日 K 根数
  last_date: string | null;
  ret_5: number | null;
  ret_20: number | null;
  ret_60: number | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  above_ma5: number | null;
  above_ma20: number | null;
  above_ma60: number | null;
  rsi_14: number | null;
  volume_ratio: number | null;
  amplitude: number | null;
  new_high_20: number | null; // 1=近20日新高
  rps_20: number | null; // 池内百分位 0~100
}

function retFrom(closes: number[], n: number): number | null {
  if (closes.length <= n) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - n];
  if (then === 0) return null;
  return ((now / then) - 1) * 100;
}

function maOf(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  return w.reduce((a, b) => a + b, 0) / n;
}

/** Wilder RSI(14)：不足 15 根 → null。 */
function rsiOf(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  // Wilder 平滑：这里只有最近一段，用首段平均即可（单值 RSI，不做全序列递推）
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function enrichHkUs(
  universe: HkUsUniverseEntry[],
  quotes: Map<string, HkUsQuoteIn>,
  barsBySymbol: Map<string, HkUsBar[]>,
  peBySymbol: Map<string, number | null>,
): HkUsEnriched[] {
  const rows: HkUsEnriched[] = universe.map((u) => {
    const q = quotes.get(u.code) ?? null;
    const bars = (barsBySymbol.get(u.code) ?? []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const closes = bars.map((b) => b.c);
    const last = bars[bars.length - 1] ?? null;
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const price = q?.price ?? last?.c ?? null;
    const changePct = q?.changePct ?? (last && prev && prev.c !== 0 ? ((last.c / prev.c) - 1) * 100 : null);
    const volume = q?.volume ?? last?.v ?? null;
    const turnover = q?.turnover ?? last?.amount ?? (price != null && volume != null ? price * volume : null);
    const ma5 = maOf(closes, 5);
    const ma20 = maOf(closes, 20);
    const ma60 = maOf(closes, 60);
    const close = closes[closes.length - 1] ?? null;
    const vols = bars.map((b) => b.v).filter((v): v is number => v != null && v > 0);
    const priorVols = vols.slice(0, -1).slice(-20);
    const volumeRatio = last?.v != null && priorVols.length >= 5
      ? last.v / (priorVols.reduce((a, b) => a + b, 0) / priorVols.length)
      : null;
    const amplitude = last && prev && prev.c !== 0 ? ((last.h - last.l) / prev.c) * 100 : null;
    const win20 = closes.slice(-20);
    const newHigh20 = close != null && win20.length >= 5 && close >= Math.max(...win20) ? 1 : (win20.length >= 5 ? 0 : null);
    return {
      symbol: u.code,
      name: q?.name ?? u.name,
      price,
      change_pct: changePct,
      volume,
      amount_yi: turnover != null ? turnover / 1e8 : null,
      pe_ttm: peBySymbol.get(u.code) ?? null,
      turnover_rate: null,
      main_net_yi: null,
      market_cap_yi: null,
      pb: null,
      bars: bars.length,
      last_date: last?.date ?? null,
      ret_5: retFrom(closes, 5),
      ret_20: retFrom(closes, 20),
      ret_60: retFrom(closes, 60),
      ma5,
      ma20,
      ma60,
      above_ma5: close != null && ma5 != null ? (close > ma5 ? 1 : 0) : null,
      above_ma20: close != null && ma20 != null ? (close > ma20 ? 1 : 0) : null,
      above_ma60: close != null && ma60 != null ? (close > ma60 ? 1 : 0) : null,
      rsi_14: rsiOf(closes),
      volume_ratio: volumeRatio,
      amplitude,
      new_high_20: newHigh20,
      rps_20: null, // 第二遍按池内 ret_20 排百分位
    };
  });
  // RPS：池内按 ret_20 升序排，百分位 = (rank-1)/(n-1)*100；ret_20 缺失的不排
  const ranked = rows.filter((r) => r.ret_20 != null).sort((a, b) => (a.ret_20 as number) - (b.ret_20 as number));
  if (ranked.length >= 2) {
    ranked.forEach((r, i) => { r.rps_20 = (i / (ranked.length - 1)) * 100; });
  } else if (ranked.length === 1) {
    ranked[0].rps_20 = 50;
  }
  return rows;
}

// ---------- 选股筛选 ----------

export interface HkUsCond { field: string; op: string; value: number | string }

export function cmpHkUs(v: number | null, op: string, target: number): boolean {
  if (v == null) return false;
  switch (op) {
    case "=": return v === target;
    case ">=": return v >= target;
    case ">": return v > target;
    case "<=": return v <= target;
    case "<": return v < target;
    case "!=": return v !== target;
    default: return false;
  }
}

export interface HkUsFilterResult {
  rows: HkUsEnriched[];
  warnings: string[];
  unavailable: { field: string; zh: string }[];
}

export function filterHkUs(rows: HkUsEnriched[], conds: HkUsCond[]): HkUsFilterResult {
  const warnings: string[] = [];
  const unavailable: { field: string; zh: string }[] = [];
  const usable: HkUsCond[] = [];
  const filterable = new Set(HK_US_FILTERABLE_FIELDS.map((f) => f.field));
  for (const c of conds) {
    const un = HK_US_UNAVAILABLE_FIELDS.find((f) => f.field === c.field);
    if (un) {
      if (!unavailable.some((x) => x.field === un.field)) unavailable.push(un);
      continue;
    }
    if (!filterable.has(c.field)) {
      warnings.push(`未知筛选字段已忽略：${c.field}`);
      continue;
    }
    const num = typeof c.value === "number" ? c.value : Number(c.value);
    if (!Number.isFinite(num)) {
      warnings.push(`筛选条件 ${c.field} 的值不是数字，已忽略`);
      continue;
    }
    usable.push({ ...c, value: num });
  }
  if (unavailable.length) {
    warnings.push(`以下条件因长桥 MCP 无此数据被忽略，本次未按它们筛选：${unavailable.map((x) => x.zh).join("、")}（缺读数，不是值为 0）`);
  }
  const filtered = rows.filter((r) => usable.every((c) => {
    const v = (r as unknown as Record<string, number | null>)[c.field];
    return cmpHkUs(typeof v === "number" ? v : null, c.op, Number(c.value));
  }));
  return { rows: filtered, warnings, unavailable };
}

// ---------- 宽度（复用 A 股 breadth-core 同一套判定，分母 = 主流票池） ----------

export interface HkUsBreadth {
  pool: string;
  universe: number;
  above_ma5: number | null;
  above_ma5_pct: number | null;
  above_ma3: number | null;
  new_low_5: number | null;
  new_low_3: number | null;
  latest_date: string | null;
  advancers: number;
  decliners: number;
  flat: number;
  median_change_pct: number | null;
  caliber: string;
}

export function breadthHkUs(rows: HkUsEnriched[], barsBySymbol: Map<string, HkUsBar[]>): HkUsBreadth {
  // 宽度判定走 breadth-core（与 A 股同一套：站上5日线 = 收盘 > 近5根均值，凑不满不进分母）
  const bars: { symbol: string; date: string; close: number }[] = [];
  for (const [sym, list] of barsBySymbol) {
    for (const b of list) bars.push({ symbol: sym, date: b.date, close: b.c });
  }
  const series = _computeBreadthSeries(bars);
  const latest = series[series.length - 1] ?? null;
  const changes = rows.map((r) => r.change_pct).filter((v): v is number => v != null).sort((a, b) => a - b);
  const median = changes.length
    ? changes.length % 2 === 1
      ? changes[(changes.length - 1) / 2]
      : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2
    : null;
  return {
    pool: "20 只主流票（非全市场）",
    universe: rows.length,
    above_ma5: latest?.above_ma5 ?? null,
    above_ma5_pct: latest?.above_ma5_pct ?? null,
    above_ma3: latest?.above_ma3 ?? null,
    new_low_5: latest?.new_low_5 ?? null,
    new_low_3: latest?.new_low_3 ?? null,
    latest_date: latest?.date ?? null,
    advancers: rows.filter((r) => (r.change_pct ?? 0) > 0).length,
    decliners: rows.filter((r) => (r.change_pct ?? 0) < 0).length,
    flat: rows.filter((r) => r.change_pct === 0).length,
    median_change_pct: median,
    caliber: "站上5日线占比/创5日(3日)新低：与 A 股 breadth-core 同一套判定（收盘价 > 近5根均值；凑不满根数不进分母）；分母是 20 只主流票，不是全市场。",
  };
}



// ---------- 分歧 ----------

export interface HkUsDivergence {
  kind: string;
  divergent: boolean;
  plain: string;
  missing: string | null;
}

function medianOf(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const pct = (v: number | null): string => (v == null ? "无读数" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

export function divergenceHkUs(
  market: HkUsMarket,
  rows: HkUsEnriched[],
  benchOverride?: { change_pct: number | null; name: string } | null,
): HkUsDivergence[] {
  const out: HkUsDivergence[] = [];
  const benchCode = HK_US_BENCHMARK[market];
  const bench = rows.find((r) => r.symbol === benchCode) ?? null;
  // 港股宽基 02800 不在 20 只池内：由路由层单独取后以 override 传入，不进池内中位分母。
  const benchPct = benchOverride ? benchOverride.change_pct : (bench?.change_pct ?? null);
  const benchName = benchOverride ? benchOverride.name : (bench?.name ?? benchCode);
  const poolMedian = medianOf(rows.map((r) => r.change_pct).filter((v): v is number => v != null));

  // 1) 龙头 vs 其余：成交额前 3 只的中位涨跌 vs 其余中位；方向相反且两边幅度 ≥0.5% 才算分歧
  const byAmount = [...rows].filter((r) => r.amount_yi != null).sort((a, b) => (b.amount_yi as number) - (a.amount_yi as number));
  const leaders = byAmount.slice(0, 3);
  const rest = byAmount.slice(3);
  const leaderMed = medianOf(leaders.map((r) => r.change_pct).filter((v): v is number => v != null));
  const restMed = medianOf(rest.map((r) => r.change_pct).filter((v): v is number => v != null));
  const leaderDiv = leaderMed != null && restMed != null
    && ((leaderMed >= 0.5 && restMed <= -0.5) || (leaderMed <= -0.5 && restMed >= 0.5));
  out.push({
    kind: "龙头 vs 其余",
    divergent: leaderDiv,
    plain: leaderMed == null || restMed == null
      ? "龙头 vs 其余：成交额或涨跌幅没取全，判不了。"
      : leaderDiv
        ? `龙头分歧：成交额前 3 只（${leaders.map((r) => r.name).join("、")}）中位${pct(leaderMed)}，其余中位${pct(restMed)}，龙头和大部队反着走。`
        : `龙头 vs 其余：成交额前 3 只中位${pct(leaderMed)}，其余中位${pct(restMed)}，方向没打架。`,
    missing: leaderMed == null || restMed == null ? "部分票成交额/涨跌幅缺失" : null,
  });

  // 2) 指数 vs 个股：宽基（港股 02800 / 美股 SPY）vs 池内中位
  const idxDiv = benchPct != null && poolMedian != null
    && ((benchPct >= 0.5 && poolMedian <= -0.5) || (benchPct <= -0.5 && poolMedian >= 0.5));
  out.push({
    kind: "指数 vs 个股",
    divergent: idxDiv,
    plain: benchPct == null || poolMedian == null
      ? "指数 vs 个股：宽基或池内中位涨跌没取到，判不了。"
      : idxDiv
        ? `指数与个股分歧：宽基 ${benchName}${pct(benchPct)}，池内中位${pct(poolMedian)}，指数和多数票反着走。`
        : `指数 vs 个股：宽基 ${benchName}${pct(benchPct)}，池内中位${pct(poolMedian)}，方向没打架。`,
    missing: benchPct == null || poolMedian == null ? "宽基或池内涨跌缺失" : null,
  });

  // 3) 价格 vs 量：上涨但缩量（量比 <0.8）的票数；上涨且放量（量比 ≥1.5）的票数
  const up = rows.filter((r) => (r.change_pct ?? 0) > 0);
  const upWeakVol = up.filter((r) => r.volume_ratio != null && (r.volume_ratio as number) < 0.8).length;
  const upStrongVol = up.filter((r) => r.volume_ratio != null && (r.volume_ratio as number) >= 1.5).length;
  const volKnown = rows.filter((r) => r.volume_ratio != null).length;
  out.push({
    kind: "价格 vs 量",
    divergent: up.length > 0 && upWeakVol > upStrongVol,
    plain: volKnown === 0
      ? "价格 vs 量：量比没取到（日 K 成交量缺失），判不了。"
      : `价格 vs 量：上涨 ${up.length} 只里，缩量上涨（量比<0.8）${upWeakVol} 只，放量上涨（量比≥1.5）${upStrongVol} 只。${upWeakVol > upStrongVol ? "涨的多是缩量涨，量没跟上。" : "量跟得上，涨得不算虚。"}`,
    missing: volKnown === 0 ? "量比全部缺失" : volKnown < rows.length ? `量比只取到 ${volKnown}/${rows.length} 只` : null,
  });

  // 4) 事件 vs 价格：有新闻的票里，新闻日价格方向（仅陈述，不判因果）
  // 注：新闻条数由路由层传入？纯核这里只留占位，路由层在事件块里附带统计。
  // 为保持纯核完整，分歧第 4/5 种（事件 vs 资金、主力 vs 散户）因长桥无资金流数据，
  // 在路由层统一以 missing 形式返回（见 route 注释），此处不编造。

  // 5) 主力 vs 散户：长桥 MCP 没有资金流/逐笔工具，算不出——如实说，不编
  out.push({
    kind: "主力 vs 散户",
    divergent: false,
    plain: "主力 vs 散户：长桥 MCP 没有主力/大户/散户资金流数据，算不出这只的分歧，不编。",
    missing: "长桥 MCP 无资金流工具（主力/大户/散户净额全部缺失）",
  });

  // 6) 事件 vs 资金：同上，资金缺失 → 判不了
  out.push({
    kind: "事件 vs 资金",
    divergent: false,
    plain: "事件 vs 资金：资金流没取到，事件有没有资金跟进判不了，不编。",
    missing: "长桥 MCP 无资金流工具",
  });
  return out;
}

// ---------- 事件 ----------

export interface HkUsEvent {
  symbol: string;
  name: string;
  title: string;
  time: string | null;
  source: string | null;
  url: string | null;
  content: string | null;
}

export function eventsHkUs(news: HkUsNewsIn[], nameOf: Map<string, string>, limit = 60): HkUsEvent[] {
  return news
    .filter((n) => n.title)
    .map((n) => ({
      symbol: n.symbol,
      name: nameOf.get(n.symbol) ?? n.symbol,
      title: n.title,
      time: n.time,
      source: n.source,
      url: n.url,
      content: n.content,
    }))
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
    .slice(0, limit);
}

// ---------- AI 优选（确定性规则打分，不调模型、不编理由） ----------

export interface HkUsAiPick {
  symbol: string;
  name: string;
  score: number;
  price: number | null;
  change_pct: number | null;
  reasons: string[];
  divergence: string;
  warnings: string[];
}

interface ScorePart { score: number; reason: string | null }

function scoreHkUs(r: HkUsEnriched, benchPct: number | null): { total: number; reasons: string[]; warnings: string[] } {
  const parts: ScorePart[] = [];
  if (r.above_ma20 === 1) parts.push({ score: 25, reason: "站上20日线" });
  else if (r.above_ma20 === 0) parts.push({ score: 0, reason: "跌破20日线" });
  if (r.above_ma60 === 1) parts.push({ score: 10, reason: "站上60日线" });
  if (r.rps_20 != null) parts.push({ score: Math.round(r.rps_20 * 0.3), reason: `池内相对强度 RPS ${r.rps_20.toFixed(0)}` });
  if (r.ret_20 != null) parts.push({ score: Math.max(-10, Math.min(10, Math.round(r.ret_20))), reason: `近20日${pct(r.ret_20)}` });
  if (r.volume_ratio != null) {
    if (r.volume_ratio >= 1 && r.volume_ratio <= 3) parts.push({ score: 10, reason: `量比 ${r.volume_ratio.toFixed(2)}，量跟得上` });
    else if (r.volume_ratio > 3) parts.push({ score: 5, reason: `量比 ${r.volume_ratio.toFixed(2)}，放量偏热` });
    else if (r.volume_ratio < 0.5) parts.push({ score: 0, reason: `量比 ${r.volume_ratio.toFixed(2)}，缩量` });
  }
  if (r.rsi_14 != null) {
    if (r.rsi_14 >= 50 && r.rsi_14 <= 70) parts.push({ score: 10, reason: `RSI ${r.rsi_14.toFixed(0)}，动能温和` });
    else if (r.rsi_14 > 80) parts.push({ score: -10, reason: `RSI ${r.rsi_14.toFixed(0)}，偏热` });
    else if (r.rsi_14 >= 30 && r.rsi_14 < 50) parts.push({ score: 5, reason: `RSI ${r.rsi_14.toFixed(0)}` });
  }
  if (r.pe_ttm != null) {
    if (r.pe_ttm < 25) parts.push({ score: 10, reason: `PE ${r.pe_ttm.toFixed(1)}，估值不贵` });
    else if (r.pe_ttm <= 40) parts.push({ score: 5, reason: `PE ${r.pe_ttm.toFixed(1)}` });
    else if (r.pe_ttm > 60) parts.push({ score: -5, reason: `PE ${r.pe_ttm.toFixed(1)}，估值偏高` });
  }
  if (r.ret_60 != null && r.ret_60 < -15) parts.push({ score: -10, reason: `近60日${pct(r.ret_60)}，中期偏弱` });
  if (r.new_high_20 === 1) parts.push({ score: 5, reason: "近20日新高" });
  const warnings: string[] = [];
  if (r.bars < 60) warnings.push(`日 K 仅 ${r.bars} 根，60日/RSI 口径不全`);
  if (r.pe_ttm == null) warnings.push("PE 未取到（估值项未计分）");
  const total = parts.reduce((s, p) => s + p.score, 0);
  const reasons = parts.map((p) => p.reason).filter((x): x is string => !!x);
  void benchPct;
  return { total, reasons, warnings };
}

export function aiPickHkUs(rows: HkUsEnriched[], benchPct: number | null, topN = 5): HkUsAiPick[] {
  const withData = rows.filter((r) => r.price != null);
  const scored = withData.map((r) => ({ r, ...scoreHkUs(r, benchPct) }));
  scored.sort((a, b) => b.total - a.total);
  return scored.slice(0, topN).map(({ r, total, reasons, warnings }) => {
    const divParts: string[] = [];
    if (r.change_pct != null && benchPct != null) {
      const sameDir = (r.change_pct >= 0 && benchPct >= 0) || (r.change_pct < 0 && benchPct < 0);
      divParts.push(sameDir ? `与宽基同向（个股${pct(r.change_pct)} / 宽基${pct(benchPct)}）` : `与宽基反向（个股${pct(r.change_pct)} / 宽基${pct(benchPct)}），和指数打架`);
    }
    if ((r.change_pct ?? 0) > 0 && r.volume_ratio != null && r.volume_ratio < 0.8) divParts.push("上涨但缩量，量没跟上");
    if ((r.change_pct ?? 0) > 0 && r.volume_ratio != null && r.volume_ratio >= 1.5) divParts.push("上涨且放量");
    divParts.push("主力 vs 散户：资金流没取到，判不了");
    return {
      symbol: r.symbol,
      name: r.name,
      score: total,
      price: r.price,
      change_pct: r.change_pct,
      reasons,
      divergence: divParts.join("；"),
      warnings,
    };
  });
}
