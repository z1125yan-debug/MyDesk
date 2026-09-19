// 通达信(eltdx)行情数据层（仅服务端使用）
// 通过本机 eltdx-http 网关（https://github.com/electkismet/eltdx）访问通达信行情主站。
// 网关未启动时所有函数静默返回 null，由上层回退腾讯/东财源。
// 启动方式：eltdx-http --host 127.0.0.1 --port 8756

const GW = process.env.TDX_GATEWAY ?? "http://127.0.0.1:8756";

// MyDesk 符号 → TDX 全码：688256.SH → sh688256
function toTdxCode(symbol: string): string | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  return m[2].toLowerCase() + m[1];
}

let upCache: { at: number; ok: boolean } | null = null;

async function rpc<T = unknown>(method: string, params: unknown, timeoutMs = 4000): Promise<T | null> {
  // 网关存活状态缓存 60 秒：挂掉时避免每个请求都白等超时
  if (upCache && Date.now() - upCache.at < 60_000 && !upCache.ok) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GW}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method, params }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const j = (await res.json()) as { ok?: boolean; result?: T };
    if (!res.ok || !j.ok) {
      upCache = { at: Date.now(), ok: false };
      return null;
    }
    upCache = { at: Date.now(), ok: true };
    return j.result ?? null;
  } catch {
    upCache = { at: Date.now(), ok: false };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 实时快照 ----------

interface TdxSnapshot {
  code: string;
  last_price: number;
  pre_close_price: number;
  open_price: number;
  high_price: number;
  low_price: number;
  amount: number; // 元
  total_hand?: number; // 总手
  inside_dish?: number; // 内盘（主动卖，手）
  outer_disc?: number; // 外盘（主动买，手）
}

export interface TdxQuote {
  symbol: string;
  price: number;
  changePct: number;
  high: number;
  low: number;
  prevClose: number;
  amountYi: number;
  volumeHand?: number;   // 总手（全日）
  insideHand?: number;   // 内盘（主动卖，手）
  outerHand?: number;    // 外盘（主动买，手）
}

export async function tdxQuotes(symbols: string[]): Promise<Map<string, TdxQuote> | null> {
  const pairs = symbols
    .map((s) => ({ s, tc: toTdxCode(s) }))
    .filter((p): p is { s: string; tc: string } => Boolean(p.tc));
  if (!pairs.length) return null;
  const result = await rpc<TdxSnapshot[]>("quotes.get_snapshots", { codes: pairs.map((p) => p.tc) });
  if (!Array.isArray(result)) return null;
  const byCode = new Map(result.map((r) => [String(r.code), r]));
  const out = new Map<string, TdxQuote>();
  for (const p of pairs) {
    const r = byCode.get(p.tc.slice(2));
    if (!r || !isFinite(r.last_price) || r.last_price <= 0) continue;
    const pre = isFinite(r.pre_close_price) && r.pre_close_price > 0 ? r.pre_close_price : r.last_price;
    out.set(p.s, {
      symbol: p.s,
      price: r.last_price,
      changePct: pre > 0 ? ((r.last_price - pre) / pre) * 100 : 0,
      high: isFinite(r.high_price) ? r.high_price : r.last_price,
      low: isFinite(r.low_price) ? r.low_price : r.last_price,
      prevClose: pre,
      amountYi: isFinite(r.amount) ? r.amount / 1e8 : 0,
      volumeHand: isFinite(r.total_hand ?? NaN) ? (r.total_hand as number) : undefined,
      insideHand: isFinite(r.inside_dish ?? NaN) ? (r.inside_dish as number) : undefined,
      outerHand: isFinite(r.outer_disc ?? NaN) ? (r.outer_disc as number) : undefined,
    });
  }
  return out.size ? out : null;
}

// ---------- K 线 ----------

interface TdxBar {
  time: string; // "2026-09-18T10:30:00+08:00"
  open: number;
  close: number;
  high: number;
  low: number;
}

const TDX_PERIOD: Record<string, string> = {
  "1分": "1min", "5分": "5min", "15分": "15min", "30分": "30min", "60分": "60min",
  "日线": "day", "周线": "week", "月线": "month",
};

export interface TdxCandle {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

export async function tdxKlines(symbol: string, tf: string, count = 160): Promise<TdxCandle[] | null> {
  const tc = toTdxCode(symbol);
  const period = TDX_PERIOD[tf];
  if (!tc || !period) return null;
  const result = await rpc<{ bars?: TdxBar[] }>(
    "bars.get",
    { code: tc, period, count, adjust: period === "day" || period === "week" || period === "month" ? "qfq" : "none" },
    6000,
  );
  const bars = result?.bars;
  if (!Array.isArray(bars) || !bars.length) return null;
  const minute = period.endsWith("min");
  return bars
    .map((b) => ({
      date: minute ? b.time.slice(0, 16).replace("T", " ") : b.time.slice(0, 10),
      o: b.open, h: b.high, l: b.low, c: b.close,
    }))
    .filter((k) => isFinite(k.o) && isFinite(k.c) && isFinite(k.h) && isFinite(k.l));
}

// ---------- 五档盘口（eltdx quotes.get_depth，原生 0x0547） ----------

export interface TdxLevel {
  price: number;
  volume: number; // 手
}

export interface TdxDepth {
  symbol: string;
  lastPrice: number;
  bids: TdxLevel[]; // 买1~买5
  asks: TdxLevel[]; // 卖1~卖5
  insideHand: number;  // 内盘（主动卖，手）
  outerHand: number;   // 外盘（主动买，手）
  activeHand: number;  // 现手
}

export async function tdxDepth(symbols: string[]): Promise<Map<string, TdxDepth> | null> {
  const pairs = symbols
    .map((s) => ({ s, tc: toTdxCode(s) }))
    .filter((p): p is { s: string; tc: string } => Boolean(p.tc));
  if (!pairs.length) return null;
  const result = await rpc<{
    records?: {
      code: string;
      last_price: number;
      buy_levels?: { price: number; volume: number }[];
      sell_levels?: { price: number; volume: number }[];
      inside_dish?: number;
      outer_disc?: number;
      active?: number;
    }[];
  }>("quotes.get_depth", { codes: pairs.map((p) => p.tc) }, 5000);
  const records = result?.records;
  if (!Array.isArray(records) || !records.length) return null;
  const byCode = new Map(records.map((r) => [String(r.code), r]));
  const out = new Map<string, TdxDepth>();
  for (const p of pairs) {
    const r = byCode.get(p.tc.slice(2));
    if (!r || !isFinite(r.last_price)) continue;
    const lv = (arr?: { price: number; volume: number }[]): TdxLevel[] =>
      (arr ?? []).filter((x) => isFinite(x.price) && isFinite(x.volume)).map((x) => ({ price: x.price, volume: x.volume }));
    out.set(p.s, {
      symbol: p.s,
      lastPrice: r.last_price,
      bids: lv(r.buy_levels),
      asks: lv(r.sell_levels),
      insideHand: isFinite(r.inside_dish ?? NaN) ? (r.inside_dish as number) : 0,
      outerHand: isFinite(r.outer_disc ?? NaN) ? (r.outer_disc as number) : 0,
      activeHand: isFinite(r.active ?? NaN) ? (r.active as number) : 0,
    });
  }
  return out.size ? out : null;
}

// ---------- 主动买卖金额（内外盘口径，全日累计） ----------
// 口径：外盘（主动买）×成交均价 / 内盘（主动卖）×成交均价。
// 这是系统计算的代理指标，不是交易所官方主力资金统计；逐笔翻页仅能取到部分数据，
// 内外盘是快照自带的全日累计值，口径完整且只需一次请求。

export interface TdxTradesMoney {
  symbol: string;
  buyAmountYi: number;
  sellAmountYi: number;
  netYi: number;
  outerHand: number;  // 外盘（主动买，手）
  insideHand: number; // 内盘（主动卖，手）
  avgPrice: number;
  basis: string;
}

export async function tdxTradesMoney(symbol: string): Promise<TdxTradesMoney | null> {
  const q = (await tdxQuotes([symbol]).catch(() => null))?.get(symbol);
  if (!q || !q.volumeHand || q.volumeHand <= 0 || !q.amountYi) return null;
  const avg = (q.amountYi * 1e8) / (q.volumeHand * 100);
  const outer = q.outerHand ?? 0;
  const inside = q.insideHand ?? 0;
  return {
    symbol,
    buyAmountYi: (outer * 100 * avg) / 1e8,
    sellAmountYi: (inside * 100 * avg) / 1e8,
    netYi: ((outer - inside) * 100 * avg) / 1e8,
    outerHand: outer,
    insideHand: inside,
    avgPrice: avg,
    basis: "内外盘 × 成交均价（全日累计，代理指标）",
  };
}

// ---------- 日K（含量额；快照口径：交易时段返回当日动态未走完K线） ----------

export interface TdxDailyBar {
  date: string;
  o: number; h: number; l: number; c: number;
  v: number;    // 股
  amount: number; // 元
}

const dayBarsCache = new Map<string, { at: number; bars: TdxDailyBar[] }>();

export async function tdxDayBars(symbol: string, count: number): Promise<TdxDailyBar[] | null> {
  const tc = toTdxCode(symbol);
  if (!tc) return null;
  // 交易时段当天K线在跳动：缓存60秒；休市时历史K线不变：缓存10分钟
  const { marketSession } = await import("./session");
  const ttl = marketSession().open ? 60_000 : 600_000;
  const hit = dayBarsCache.get(tc);
  if (hit && Date.now() - hit.at < ttl) return hit.bars;
  const result = await rpc<{
    bars?: {
      time: string; open: number; close: number; high: number; low: number;
      volume_lots?: number; volume_wire_value?: number; amount?: number;
    }[];
  }>("bars.get", { code: tc, period: "day", count, adjust: "qfq" }, 8000);
  const bars = result?.bars;
  if (!Array.isArray(bars) || !bars.length) return null;
  const out: TdxDailyBar[] = [];
  for (const b of bars) {
    const date = b.time.slice(0, 10);
    const v = (isFinite(b.volume_lots ?? NaN) ? b.volume_lots : (b.volume_wire_value ?? NaN) / 100) as number;
    if (![b.open, b.close, b.high, b.low].every((x) => isFinite(x))) continue;
    out.push({
      date, o: b.open, h: b.high, l: b.low, c: b.close,
      v: isFinite(v) ? Math.round(v * 100) : 0,
      amount: isFinite(b.amount ?? NaN) ? (b.amount as number) : 0,
    });
  }
  if (out.length) dayBarsCache.set(tc, { at: Date.now(), bars: out });
  return out;
}

// ---------- 证券名称表（用于 TDX 为主源时补名称，进程内缓存 24h） ----------

interface SecurityCode {
  code: string;
  name: string;
}

// 键含市场前缀（sh000001≠sz000001），指数不在 A 股代码表里 → 返回 null 由腾讯补名
let nameCache: Map<string, string> | null = null;
let nameCacheAt = 0;

export async function tdxNameOf(symbol: string): Promise<string | null> {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(symbol.trim());
  if (!m) return null;
  const key = m[2].toLowerCase() + m[1];
  if (!nameCache || Date.now() - nameCacheAt > 24 * 3600_000) {
    const merged = new Map<string, string>();
    for (const mkt of ["sh", "sz", "bj"]) {
      const rows = await rpc<SecurityCode[]>("codes.a_shares", { market: mkt }, 8000);
      if (Array.isArray(rows)) for (const r of rows) merged.set(`${mkt}${r.code}`, String(r.name ?? ""));
    }
    if (merged.size) {
      nameCache = merged;
      nameCacheAt = Date.now();
    } else {
      return nameCache?.get(key) ?? null;
    }
  }
  return nameCache?.get(key) ?? null;
}
