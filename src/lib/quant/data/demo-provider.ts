// Quant Research Lab — 确定性演示数据源（零网络，供离线测试/数据源断连回退）
// 与 MyDesk 演示数据同一思想：固定种子伪随机，任何时刻重放结果一致，
// 保证单元测试可复现、历史回放不依赖外部接口。
import type { AssetMeta, Bar, DataCoverage, DataProvider, BarsRequest, UniverseSpec } from "../types.ts";

const TRADING_DAYS: string[] = buildTradingDays("2024-01-02", 760); // 覆盖 2024-01 ~ 2026-12

function buildTradingDays(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// mulberry32：固定种子确定性随机
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const INDUSTRIES = ["半导体", "白酒", "银行", "医药", "新能源", "军工", "计算机", "家电"] as const;

interface DemoStock {
  meta: AssetMeta;
  drift: number; // 日漂移
  vol: number; // 日波动
}

// 60 只演示 A 股：代码段覆盖 60/00/30/68，含 1 只 ST 与 1 只 2025 年才上市（过滤测试用）
function buildUniverse(): DemoStock[] {
  const out: DemoStock[] = [];
  for (let i = 0; i < 60; i++) {
    const rnd = mulberry32(hashSeed(`demo-stock-${i}`));
    const board = i < 20 ? "60" : i < 36 ? "00" : i < 48 ? "30" : "68";
    const code = String(1000 + i).padStart(3, "0");
    const symbol = `${board}${code}.${board === "60" || board === "68" ? "SH" : "SZ"}`;
    const listDate = i === 59 ? "2025-06-10" : "2020-01-01";
    const st = i === 58;
    const name = st ? `演示${i}ST` : `演示股份${i}`;
    const meta: AssetMeta = {
      symbol,
      name,
      industry: INDUSTRIES[i % INDUSTRIES.length],
      listDate,
      marketCap: Math.round((30 + rnd() * 470) * 1e8),
      floatCap: Math.round((20 + rnd() * 300) * 1e8),
      pe: 10 + rnd() * 60,
      pb: 1 + rnd() * 6,
      st,
      suspended: false,
    };
    out.push({ meta, drift: (rnd() - 0.45) * 0.0015, vol: 0.012 + rnd() * 0.022 });
  }
  return out;
}

const UNIVERSE = buildUniverse();
const barsCache = new Map<string, Bar[]>(); // symbol -> 全历史（asOf 截断由 getBars 统一做）

function barsFor(st: DemoStock): Bar[] {
  const hit = barsCache.get(st.meta.symbol);
  if (hit) return hit;
  const rnd = mulberry32(hashSeed(`demo-bars-${st.meta.symbol}`));
  let price = 8 + rnd() * 40;
  const bars: Bar[] = [];
  for (let i = 0; i < TRADING_DAYS.length; i++) {
    // 上市首日之前无数据（演示 new listing 场景）
    if (TRADING_DAYS[i] < st.meta.listDate!) { price = 8 + rnd() * 40; continue; }
    const shock = st.drift + (rnd() - 0.5) * 2 * st.vol;
    const o = price;
    const c = Math.max(1, price * (1 + shock));
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    const v = Math.round((5e6 + rnd() * 2e8) * (0.7 + 0.6 * rnd()));
    bars.push({
      date: TRADING_DAYS[i],
      o: round2(o), h: round2(h), l: round2(l), c: round2(c),
      v, amount: v * ((o + c) / 2),
    });
    price = c;
  }
  barsCache.set(st.meta.symbol, bars);
  return bars;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function find(symbol: string): DemoStock | undefined {
  return UNIVERSE.find((s) => s.meta.symbol === symbol);
}

export const demoProvider: DataProvider = {
  id: "demo",
  coverage(): DataCoverage {
    return {
      source: "demo",
      daily: true, minute: false,
      fundamentals: "snapshot",
      universeMembership: "point_in_time",
    };
  },

  async listUniverse(spec: UniverseSpec, asOf: string): Promise<AssetMeta[]> {
    let list = UNIVERSE.map((s) => {
      const snapBars = barsFor(s);
      const last = [...snapBars].reverse().find((b) => b.date <= asOf);
      return {
        ...s.meta,
        price: last?.c,
        turnover: last ? round2(((last.amount ?? 0) / Math.max(1, s.meta.floatCap ?? 1)) * 100) : undefined,
        volume: last?.v,
        amount: last?.amount,
      };
    });
    if (spec.kind === "custom" && spec.symbols?.length) {
      const set = new Set(spec.symbols);
      list = list.filter((m) => set.has(m.symbol));
    } else if (spec.kind === "industry" && spec.boardCode) {
      // 演示池用行业名当 boardCode
      list = list.filter((m) => m.industry === spec.boardCode);
    } else if (spec.kind === "concept" && spec.boardCode) {
      list = list.filter((m) => (hashSeed(m.symbol) + hashSeed(spec.boardCode!)) % 3 === 0);
    }
    // 上市时间过滤：asOf 之前未上市的剔除（演示池成员固定，无幸存者偏差）
    return list.filter((m) => !m.listDate || m.listDate <= asOf);
  },

  async getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
    const out = new Map<string, Bar[]>();
    for (const sym of req.symbols) {
      const st = find(sym);
      if (!st) { out.set(sym, []); continue; }
      const all = barsFor(st);
      const cut = all.filter((b) => b.date <= req.asOf);
      out.set(sym, req.tf === "day" ? cut.slice(-req.lookback) : []);
    }
    return out;
  },

  async getQuotes(symbols: string[]): Promise<Map<string, { price: number; name?: string }>> {
    const out = new Map<string, { price: number; name?: string }>();
    for (const sym of symbols) {
      const st = find(sym);
      if (st) {
        const bars = barsFor(st);
        out.set(sym, { price: bars[bars.length - 1].c, name: st.meta.name });
      }
    }
    return out;
  },
};

// 测试辅助：暴露固定交易日历
export const DEMO_TRADING_DAYS = TRADING_DAYS;
export const DEMO_UNIVERSE_SIZE = UNIVERSE.length;
