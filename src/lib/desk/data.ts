// MyDesk 演示数据层（兜底用）
// 说明：真实行情见 src/lib/desk/em.ts（本机直连腾讯/东财公开接口）。
// 本文件仅在真实数据源不可用、或品种不属于 A 股（如 XAU/USD）时提供本机生成的演示数据。
import type { SectorRow, SectorDetail, QuoteCard, Candle } from "./types";

export function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 确定性伪随机：同一种子序列一致，保证刷新前数据稳定
export function seeded(seed: number, i: number): number {
  let x = (seed + i * 2654435761) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 1274126177); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function jitter(base: number, refresh: number, key: string, scale = 0.006): number {
  if (!refresh) return base;
  const seed = hashCode(key + "#" + refresh);
  return base * (1 + (seeded(seed, 1) * 2 - 1) * scale);
}

export function fmt(n: number, digits = 2): string {
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(digits);
}

// ---------- 板块池（通用行业/概念/地域分类，数值为演示数据） ----------

interface Pool { name: string; leader: string; base: number; pct: number }

const INDUSTRY_IN: Pool[] = [
  { name: "半导体", leader: "中芯国际", base: 62.4, pct: 3.2 },
  { name: "电力设备", leader: "宁德时代", base: 48.1, pct: 2.6 },
  { name: "软件开发", leader: "金山办公", base: 41.7, pct: 2.9 },
  { name: "通信设备", leader: "中兴通讯", base: 35.2, pct: 2.1 },
  { name: "汽车整车", leader: "比亚迪", base: 33.8, pct: 1.8 },
  { name: "证券", leader: "东方财富", base: 29.5, pct: 1.5 },
  { name: "光伏设备", leader: "隆基绿能", base: 26.3, pct: 2.4 },
  { name: "军工电子", leader: "紫光国微", base: 22.9, pct: 1.9 },
  { name: "计算机设备", leader: "海康威视", base: 20.6, pct: 1.4 },
  { name: "化学制药", leader: "恒瑞医药", base: 18.4, pct: 1.1 },
  { name: "贵金属", leader: "山东黄金", base: 16.8, pct: 2.8 },
  { name: "仪器仪表", leader: "汇川技术", base: 14.2, pct: 1.3 },
  { name: "游戏", leader: "三七互娱", base: 12.7, pct: 1.7 },
  { name: "文化传媒", leader: "分众传媒", base: 10.9, pct: 0.9 },
  { name: "环保设备", leader: "伟明环保", base: 9.4, pct: 0.8 },
  { name: "食品加工", leader: "安井食品", base: 8.1, pct: 0.6 },
];

const INDUSTRY_OUT: Pool[] = [
  { name: "煤炭开采", leader: "中国神华", base: -21.6, pct: -1.4 },
  { name: "钢铁", leader: "宝钢股份", base: -17.3, pct: -1.1 },
  { name: "石油化工", leader: "中国石化", base: -14.8, pct: -0.9 },
  { name: "纺织服装", leader: "海澜之家", base: -11.2, pct: -1.3 },
  { name: "农林牧渔", leader: "牧原股份", base: -9.7, pct: -1.6 },
  { name: "航空机场", leader: "中国国航", base: -7.5, pct: -0.7 },
  { name: "造纸印刷", leader: "太阳纸业", base: -5.3, pct: -1.0 },
  { name: "燃气水务", leader: "新奥股份", base: -4.1, pct: -0.5 },
];

const CONCEPT_IN: Pool[] = [
  { name: "人工智能", leader: "科大讯飞", base: 55.8, pct: 3.6 },
  { name: "算力租赁", leader: "中科曙光", base: 43.2, pct: 3.1 },
  { name: "机器人执行器", leader: "绿的谐波", base: 31.5, pct: 2.7 },
  { name: "固态电池", leader: "亿纬锂能", base: 27.9, pct: 2.3 },
  { name: "低空经济", leader: "中信海直", base: 23.4, pct: 2.9 },
  { name: "数据要素", leader: "太极股份", base: 19.8, pct: 1.8 },
  { name: "智能驾驶", leader: "德赛西威", base: 17.2, pct: 2.0 },
  { name: "卫星互联网", leader: "中国卫通", base: 14.6, pct: 1.6 },
  { name: "创新药", leader: "百济神州", base: 12.3, pct: 1.2 },
  { name: "储能", leader: "阳光电源", base: 10.7, pct: 1.5 },
];

const CONCEPT_OUT: Pool[] = [
  { name: "周期资源", leader: "紫金矿业", base: -15.4, pct: -1.2 },
  { name: "传统基建", leader: "中国建筑", base: -12.1, pct: -0.8 },
  { name: "火电", leader: "华能国际", base: -9.6, pct: -0.9 },
  { name: "猪周期", leader: "新希望", base: -7.2, pct: -1.4 },
  { name: "白色家电", leader: "美的集团", base: -5.8, pct: -0.6 },
  { name: "纺织出口", leader: "华孚时尚", base: -3.9, pct: -1.1 },
];

const REGION_IN: Pool[] = [
  { name: "北京", leader: "中关村样本", base: 38.5, pct: 2.2 },
  { name: "上海", leader: "浦东样本", base: 34.2, pct: 1.9 },
  { name: "广东", leader: "深圳样本", base: 31.8, pct: 2.1 },
  { name: "江苏", leader: "苏州样本", base: 26.4, pct: 1.6 },
  { name: "浙江", leader: "杭州样本", base: 24.9, pct: 1.8 },
  { name: "山东", leader: "青岛样本", base: 15.3, pct: 0.9 },
  { name: "四川", leader: "成都样本", base: 13.7, pct: 1.2 },
  { name: "湖北", leader: "武汉样本", base: 11.9, pct: 1.0 },
  { name: "安徽", leader: "合肥样本", base: 10.2, pct: 1.3 },
  { name: "福建", leader: "福州样本", base: 8.8, pct: 0.7 },
];

const REGION_OUT: Pool[] = [
  { name: "河南", leader: "郑州样本", base: -8.3, pct: -0.8 },
  { name: "河北", leader: "石家庄样本", base: -6.4, pct: -0.6 },
  { name: "辽宁", leader: "沈阳样本", base: -5.1, pct: -0.9 },
  { name: "山西", leader: "太原样本", base: -4.2, pct: -1.1 },
  { name: "广西", leader: "南宁样本", base: -2.8, pct: -0.5 },
];

export type TabKey = "实时" | "历史" | "行业" | "概念" | "地域";

export function datasetFor(tab: TabKey, direction: "in" | "out"): Pool[] {
  if (tab === "概念") return direction === "in" ? CONCEPT_IN : CONCEPT_OUT;
  if (tab === "地域") return direction === "in" ? REGION_IN : REGION_OUT;
  if (tab === "行业") return direction === "in" ? INDUSTRY_IN : INDUSTRY_OUT;
  // 实时/历史（演示数据中两者取同一池子，历史把波动放大便于区分）
  return direction === "in" ? INDUSTRY_IN : INDUSTRY_OUT;
}

export function buildRanking(tab: TabKey, direction: "in" | "out", refresh: number): SectorRow[] {
  const pools = datasetFor(tab, direction);
  const amp = tab === "历史" ? 1.6 : 1;
  const rows = pools.map((p, i) => {
    const code = "MD" + String(1000 + hashCode(p.name) % 9000);
    const main = jitter(p.base * amp, refresh, code + p.name, 0.004);
    const changePct = jitter(p.pct * amp, refresh, code + "c" + p.name, 0.05);
    return {
      rank: i + 1,
      name: p.name,
      code,
      changePct,
      main,
      ratio: Math.min(28, Math.abs(main) / 3.2),
      superBig: main * (0.52 + seeded(hashCode(code), i) * 0.14),
      big: main * 0.34,
      leader: p.leader,
    } satisfies SectorRow;
  });
  rows.sort((a, b) => Math.abs(b.main) - Math.abs(a.main));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

function recentDates(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d.getTime() - i * 86400000);
    out.push(t.toISOString().slice(0, 10));
  }
  return out;
}

export function buildDetail(code: string, name: string, refresh: number): SectorDetail {
  const seed = hashCode(code + name);
  const spark: number[] = [];
  let v = 0;
  for (let i = 0; i < 20; i++) {
    v += (seeded(seed, i) - 0.46) * 2.4;
    spark.push(jitter(v, refresh, code + "s" + i, 0.02));
  }
  const days = recentDates(14).map((date, i) => ({
    date,
    value: jitter((seeded(seed, i + 40) - 0.42) * 9, refresh, code + "d" + i, 0.05),
  }));
  return { name, code, spark, days };
}

// ---------- 自选行情（演示数据） ----------

const QUOTE_BASE: Record<string, { name: string; price: number }> = {
  "XAU/USD": { name: "现货黄金", price: 2912.4 },
  "BTC/USDT": { name: "比特币", price: 84215.0 },
  "ETH/USDT": { name: "以太坊", price: 3184.6 },
  "000001.SH": { name: "上证指数", price: 3421.76 },
  "HS300": { name: "沪深300", price: 3987.51 },
  "NDX100": { name: "纳指100", price: 20184.33 },
};

export function buildQuote(symbol: string, refresh: number): QuoteCard {
  const meta = QUOTE_BASE[symbol] ?? { name: symbol, price: 50 + (hashCode(symbol) % 9000) / 10 };
  const seed = hashCode(symbol);
  const changePct = jitter((seeded(seed, 7) - 0.42) * 4, refresh, symbol + "q", 0.03);
  const series: number[] = [];
  let p = meta.price / (1 + changePct / 100);
  for (let i = 0; i < 40; i++) {
    p *= 1 + (seeded(seed, i + 100) - 0.5) * 0.004;
    series.push(p);
  }
  series[series.length - 1] = meta.price;
  return { symbol, name: meta.name, price: meta.price, changePct, series };
}

// ---------- K 线（演示数据，确定性随机游走） ----------

const TF_BARS: Record<string, number> = {
  "1分": 90, "5分": 96, "15分": 96, "30分": 96,
  "60分": 96, "日线": 140, "周线": 120, "月线": 120,
};

export const TIMEFRAMES = Object.keys(TF_BARS);

export function buildCandles(symbol: string, tf: string): Candle[] {
  const n = TF_BARS[tf] ?? 96;
  const seed = hashCode(symbol + "@" + tf);
  const base = 20 + (seed % 4800) / 24; // 20 ~ 220 的演示基准价
  const out: Candle[] = [];
  let c = base;
  // 用几段趋势+震荡拼出有结构的走势，便于支撑/阻力/通道有意义
  for (let i = 0; i < n; i++) {
    const phase = Math.sin(i / 14 + (seed % 7)) + Math.sin(i / 41 + 1.3);
    const drift = phase * base * 0.0009;
    const vol = base * 0.004 * (0.6 + seeded(seed, i) * 0.9);
    const o = c;
    c = c + drift + (seeded(seed, i + 500) - 0.5) * vol * 2.4;
    const h = Math.max(o, c) + seeded(seed, i + 900) * vol;
    const l = Math.min(o, c) - seeded(seed, i + 1300) * vol;
    out.push({ t: i, o, h, l, c });
  }
  return out;
}

export interface AutoLevels {
  supports: number[];
  resistances: number[];
  regression: { a: number; b: number };
}

// 简单枢轴点聚类：窗口极值 → 靠近当前价的成为支撑，远离的成为阻力
export function autoLevels(candles: Candle[]): AutoLevels {
  const n = candles.length;
  const w = 3;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = w; i < n - w; i++) {
    const seg = candles.slice(i - w, i + w + 1);
    if (candles[i].h >= Math.max(...seg.map((c) => c.h))) highs.push(candles[i].h);
    if (candles[i].l <= Math.min(...seg.map((c) => c.l))) lows.push(candles[i].l);
  }
  const last = candles[n - 1].c;
  const merge = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) {
        if (!out.length || Math.abs(v - out[out.length - 1]) > (base_range(candles) * 0.02)) out.push(v);
    }
    return out;
  };
  const base_range = (cs: Candle[]) => Math.max(...cs.map((c) => c.h)) - Math.min(...cs.map((c) => c.l));
  const all = merge([...highs, ...lows]);
  const resistances = all.filter((v) => v > last).slice(0, 3);
  const supports = all.filter((v) => v <= last).slice(-3);
  // 收盘价线性回归
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  candles.forEach((c, i) => { sx += i; sy += c.c; sxy += i * c.c; sxx += i * i; });
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const b = (sy - a * sx) / n;
  return { supports, resistances, regression: { a, b } };
}

// ---------- 目录（搜索与热门） ----------

export interface CatalogItem { symbol: string; name: string }

export const HOT_SYMBOLS: CatalogItem[] = [
  { symbol: "000001.SH", name: "上证指数" },
  { symbol: "399001.SZ", name: "深证成指" },
  { symbol: "688256.SH", name: "寒武纪" },
  { symbol: "600519.SH", name: "贵州茅台" },
];

export const CATALOG: CatalogItem[] = [
  ...HOT_SYMBOLS,
  { symbol: "000300.SH", name: "沪深300" },
  { symbol: "399006.SZ", name: "创业板指" },
  { symbol: "000688.SH", name: "科创50" },
  { symbol: "300750.SZ", name: "宁德时代" },
  { symbol: "002594.SZ", name: "比亚迪" },
  { symbol: "688981.SH", name: "中芯国际" },
  { symbol: "300059.SZ", name: "东方财富" },
  { symbol: "XAU/USD", name: "现货黄金（演示）" },
  { symbol: "BTC/USDT", name: "比特币（演示）" },
];
