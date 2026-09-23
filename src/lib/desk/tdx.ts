// 通达信(eltdx)行情数据层（仅服务端使用）
// 通过本机 eltdx-http 网关（https://github.com/electkismet/eltdx）访问通达信行情主站。
// 网关未启动时所有函数静默返回 null，由上层回退腾讯/东财源。
// 启动方式：eltdx-http --host 127.0.0.1 --port 8756

import {
  accumulateTicks, latestServerTime, mainFlowFromAccum,
  TICK_PAGE, MAX_TICK_PAGES, MAIN_FLOW_UNIVERSE,
  type FlowAccum, type FlowTickLike, type MainFlow,
} from "@/lib/quant/screener/tdx-flow-core";

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

// ---------- 主力净额自算（当日逐笔分页 → 分档轧差，纯核 tdx-flow-core） ----------
// 东财 push2 断源后资金流榜的唯一活路：网关没有现成的资金流字段，但 trades.today 给了当日
// 逐笔（含 side 方向），够按公开分档口径自己算。口径与差异声明全在纯核里，这里只管翻页与缓存。

interface TdxRankRow {
  rank?: number;
  full_code?: string;   // sh688825
  name?: string;
  change_pct?: number;
  amount?: number;      // 元
  raw?: { active1?: number; server_time_raw?: number };
}

export interface TdxMainFlowRow {
  symbol: string;       // 688825.SH
  name: string;
  changePct: number;
  amountYi: number;     // 当日成交额（亿）
  serverTimeRaw: number; // 行情侧时刻原始值，供榜级「数据截至」取最新
  flow: MainFlow | null; // null = 逐笔没取到，不等于净额 0
}

// TDX 全码 → MyDesk 符号：sh688825 → 688825.SH
function toSymbol(fullCode: string): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/i.exec(String(fullCode ?? "").trim());
  if (!m) return null;
  return `${m[2]}.${m[1].toUpperCase()}`;
}

let flowCache: { at: number; rows: TdxMainFlowRow[]; asOf: string } | null = null;

/** 单只当日逐笔翻页收集后一次性累加（去重交给纯核）；网关没给数据返回 null */
async function tdxTickAccum(fullCode: string): Promise<{ acc: FlowAccum; pages: number; truncated: boolean } | null> {
  const all: FlowTickLike[] = [];
  const seen = new Set<string>();
  let start = 0;
  let pages = 0;
  let truncated = false;
  for (;;) {
    const t = await rpc<{ ticks?: FlowTickLike[] }>("trades.today", { code: fullCode, start, count: TICK_PAGE }, 6000);
    const ticks = Array.isArray(t?.ticks) ? t.ticks : null;
    if (!ticks) return pages ? { acc: accumulateTicks(all), pages, truncated } : null;
    pages++;
    let fresh = 0;
    for (const tk of ticks) {
      const key = String(tk?.absolute_index ?? tk?.index ?? `p${pages}n${seen.size}`);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(tk);
      fresh++;
    }
    if (ticks.length < TICK_PAGE || fresh === 0) break; // 尾页/翻页不再前进就收工
    if (pages >= MAX_TICK_PAGES) { truncated = true; break; } // 超限：样本截断，不静默按半截算
    start += TICK_PAGE;
  }
  return { acc: accumulateTicks(all), pages, truncated };
}

/** 并发上限的小池子：80 只票串行翻页要十几秒，8 路并发实测 1.7~3.8 秒 */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 当日成交额前 N 只的主力净额榜（N = 纯核 MAIN_FLOW_UNIVERSE）。
 * 返回 null = 榜本身没拿到（网关断/无权限）；单只逐笔取不到时该行 flow 为 null，不补 0。
 * 交易时段缓存 60 秒，休市后逐笔不再变化 → 缓存 10 分钟（与 tdxDayBars 同一把尺子）。
 */
export async function tdxMainFlowUniverse(): Promise<{ rows: TdxMainFlowRow[]; asOf: string } | null> {
  const { marketSession } = await import("./session");
  const ttl = marketSession().open ? 60_000 : 600_000;
  if (flowCache && Date.now() - flowCache.at < ttl) return flowCache;
  const rank = await rpc<{ rows?: TdxRankRow[] }>(
    "helpers.stock_realtime_rank", { sort_by: "成交额", count: MAIN_FLOW_UNIVERSE }, 8000,
  );
  const list = (rank?.rows ?? []).slice(0, MAIN_FLOW_UNIVERSE);
  if (!list.length) return flowCache ?? null; // 榜取不到：有旧缓存就用旧的（比空白强），没有就是没取到
  const rows = await mapPool(list, 8, async (r): Promise<TdxMainFlowRow> => {
    const full = String(r.full_code ?? "");
    const base: TdxMainFlowRow = {
      symbol: toSymbol(full) ?? full,
      name: String(r.name ?? ""),
      changePct: isFinite(r.change_pct ?? NaN) ? (r.change_pct as number) : 0,
      amountYi: isFinite(r.amount ?? NaN) ? (r.amount as number) / 1e8 : 0,
      serverTimeRaw: r.raw?.server_time_raw ?? 0,
      flow: null,
    };
    const got = await tdxTickAccum(full).catch(() => null);
    if (!got) return base;
    return { ...base, flow: mainFlowFromAccum(got.acc, {
      pages: got.pages, truncated: got.truncated,
      amountYuan: isFinite(r.amount ?? NaN) ? (r.amount as number) : null,
      expectedTicks: r.raw?.active1 ?? null,
    }) };
  });
  const asOf = latestServerTime(rows.map((x) => x.serverTimeRaw));
  flowCache = { at: Date.now(), rows, asOf };
  return flowCache;
}
