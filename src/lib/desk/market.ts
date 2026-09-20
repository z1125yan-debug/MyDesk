"use client";
// 客户端行情取数：优先本地真实数据源（服务端直连腾讯/东财），失败时自动回退本机演示数据。
import { buildQuote, buildCandles, buildRanking, buildDetail, autoLevels } from "./data";
import { suffixOf } from "./intent-core";
import type { SectorRef } from "./link-core";
import type { Candle, QuoteCard, SectorRow, SectorDetail } from "./types";

export interface SuggestItem {
  symbol: string;
  name: string;
  type: string;
}

export type BoardKind = "stock" | "industry" | "concept" | "region";

// 演示符号：非 A 股代码的旧自选（如 XAU/USD、BTC/USDT）继续走本机演示数据
export function isDemoSymbol(symbol: string): boolean {
  return !/^\d{6}\.(SH|SZ|BJ)$/.test(symbol.trim().toUpperCase());
}

// TradingView 品种格式 → MyDesk 格式：SSE:688825 → 688825.SH，SZSE:000001 → 000001.SZ，BSE:920819 → 920819.BJ
// 显式带了交易所前缀的以前缀为准；裸 6 位代码补后缀走 intent-core 的唯一一份号段口径
// （这里原来也自己抄了一份 `startsWith("6")→SH / [4892]→BJ`，把 5xxxxx 整个漏掉、又把 90xxxx 沪市 B 股算成北交所）。
export function normalizeTradingViewSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  const m = /^([A-Z]+)[:\-](\d{6})$/.exec(s);
  if (m) {
    if (m[1] === "SSE") return `${m[2]}.SH`;
    if (m[1] === "SZSE") return `${m[2]}.SZ`;
    if (m[1] === "BSE") return `${m[2]}.BJ`;
  }
  if (/^\d{6}$/.test(s)) return `${s}.${suffixOf(s)}`;
  return s;
}

// 分时不可得时，用真实价格锚定的轻量序列填充缩略图
function syntheticSeries(price: number, changePct: number, seedKey: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    h ^= seedKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = (i: number) => {
    let x = (h + i * 2654435761) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 1274126177);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const out: number[] = [];
  let p = price / (1 + changePct / 100);
  for (let i = 0; i < 40; i++) {
    p *= 1 + (rnd(i) - 0.5) * 0.002;
    out.push(p);
  }
  out[out.length - 1] = price;
  return out;
}

export async function searchSymbols(q: string): Promise<SuggestItem[]> {
  const kw = q.trim();
  if (!kw) return [];
  try {
    const r = await fetch(`/api/market/search?q=${encodeURIComponent(kw)}`);
    const j = await r.json();
    if (Array.isArray(j.items) && j.items.length) return j.items;
  } catch {
    // 数据源不可用时回退本地目录
  }
  const k = kw.toLowerCase();
  const { CATALOG } = await import("./data");
  return CATALOG.filter(
    (c) => c.symbol.toLowerCase().includes(k) || c.name.toLowerCase().includes(k),
  ).map((c) => ({ symbol: c.symbol, name: c.name, type: "演示" }));
}

export interface QuoteCardsResult {
  cards: QuoteCard[];
  source: "real" | "mixed" | "demo";
}

export async function fetchQuoteCards(symbols: string[]): Promise<QuoteCardsResult> {
  const real = symbols.filter((s) => !isDemoSymbol(s));
  const demo = symbols.filter((s) => isDemoSymbol(s));
  const cards: QuoteCard[] = [];
  let realOk = false;
  if (real.length) {
    try {
      const r = await fetch(`/api/market/quote?symbols=${encodeURIComponent(real.join(","))}`);
      const j = await r.json();
      for (const q of j.quotes ?? []) {
        if (!q) continue;
        realOk = true;
        const spark = Array.isArray(q.spark) && q.spark.length > 4 ? q.spark : null;
        cards.push({
          symbol: q.symbol,
          name: q.name,
          price: q.price,
          changePct: q.changePct,
          prevClose: q.prevClose,
          // P6-A：真实报价标 REAL；缺分时时用合成序列，就必须显式标出来（否则 AI 会拿假分时当价量事实）
          series: spark ?? syntheticSeries(q.price, q.changePct, q.symbol),
          data_status: "REAL",
          series_synthetic: !spark,
        });
      }
    } catch {
      // 整体失败时全部回退
    }
  }
  // 非 A 股品种只有本机演示数据：标 DEMO，注入上下文时不得与真实行情混为「事实」
  for (const s of demo) cards.push({ ...buildQuote(s, 0), data_status: "DEMO", series_synthetic: true });
  const order = new Map(symbols.map((s, i) => [s, i]));
  cards.sort((a, b) => (order.get(a.symbol) ?? 1e9) - (order.get(b.symbol) ?? 1e9));
  // 真实符号但本次没取到报价（数据源断开/停牌）→ 显式缺失，不冒充实数
  for (const s of symbols) {
    if (!cards.some((c) => c.symbol === s)) {
      cards.push({ symbol: s, name: s, price: 0, changePct: 0, series: [], missing: true, data_status: "MISSING" });
    }
  }
  return { cards, source: realOk ? (demo.length ? "mixed" : "real") : "demo" };
}

export async function fetchCandlesFor(
  symbol: string,
  tf: string,
): Promise<{ candles: Candle[]; source: "real" | "demo" }> {
  if (!isDemoSymbol(symbol)) {
    try {
      const r = await fetch(
        `/api/market/kline?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`,
      );
      const j = await r.json();
      if (Array.isArray(j.candles) && j.candles.length > 10) {
        return { candles: j.candles, source: "real" };
      }
    } catch {
      // 回退演示
    }
  }
  return { candles: buildCandles(symbol, tf), source: "demo" };
}

export async function fetchBoardRows(
  kind: BoardKind,
  dir: "in" | "out",
): Promise<{ rows: SectorRow[]; source: "real" | "demo" }> {
  try {
    const r = await fetch(`/api/market/board?kind=${kind}&dir=${dir}`);
    const j = await r.json();
    if (Array.isArray(j.rows) && j.rows.length) return { rows: j.rows, source: "real" };
  } catch {
    // 回退演示
  }
  const tab = kind === "region" ? "地域" : kind === "concept" ? "概念" : "行业";
  return { rows: buildRanking(tab, dir, 0), source: "demo" };
}

/**
 * P7-⑧② 板块链接的白名单：对话正文里哪些板块名可以点。
 * 走 SectorsPage 同一个 /api/market/sectors（点过去看到的就是这份榜单），失败时返回空数组 = 一个板块链接都不生成。
 * 这里**故意不像 fetchBoardRows 那样回退演示数据**：白名单里的名字必须能在板块榜页真的找得到，
 * 否则点一下就是一个查无此板块的页面——链接的可用性本身就是数据真实性的一部分。
 */
export async function fetchSectorRefs(): Promise<SectorRef[]> {
  try {
    const r = await fetch("/api/market/sectors", { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok) return [];
    return (j.list ?? [])
      .map((row: { code?: unknown; name?: unknown }) => ({ code: String(row.code ?? ""), name: String(row.name ?? "") }))
      .filter((s: SectorRef) => /^BK\d+$/i.test(s.code) && s.name.length >= 2);
  } catch {
    return [];
  }
}

export async function fetchDetailFor(
  secid: string,
  name: string,
  code: string,
): Promise<{ detail: SectorDetail; source: "real" | "demo" }> {
  if (secid.includes(".")) {
    try {
      const r = await fetch(`/api/market/board-detail?secid=${encodeURIComponent(secid)}`);
      const j = await r.json();
      if (j.detail && ((j.detail.spark?.length ?? 0) > 0 || (j.detail.days?.length ?? 0) > 0)) {
        return {
          detail: { name, code, spark: j.detail.spark, days: j.detail.days },
          source: "real",
        };
      }
    } catch {
      // 回退演示
    }
  }
  return { detail: buildDetail(code, name, 0), source: "demo" };
}

// 最新财经快讯文本块（供助手上下文注入；空串表示暂不可用）
export async function fetchNewsBlock(limit = 12): Promise<string> {
  try {
    const r = await fetch("/api/market/news", { cache: "no-store" });
    const j = await r.json();
    const items: { time: string; title: string }[] = j.news ?? [];
    if (!items.length) return "";
    const lines = items.map((it) => `- ${it.time ? it.time + " " : ""}${it.title}`);
    return `【最新财经快讯】（本机直连实时获取）\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ---------- 技术快照：多周期趋势 / RSI / 区间位置 / 关键位与盈亏比 ----------

export interface TechTF {
  tf: string;
  trend: "上行" | "下行" | "震荡";
  rsi: number | null;
}

export interface TechSnapshot {
  tfs: TechTF[];
  support: number | null;
  resistance: number | null;
  rr: number | null; // （阻力-现价)/(现价-支撑)
  rangeHigh: number | null;
  rangeLow: number | null;
  rangePos: number | null; // 0-100，现价处于近半年区间位置
  source: "real" | "demo";
}

function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  const v = 100 - 100 / (1 + ag / al);
  return isFinite(v) ? v : null;
}

export function trendLabel(closes: number[]): "上行" | "下行" | "震荡" {
  const n = closes.length;
  if (n < 20) return "震荡";
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  closes.forEach((y, i) => { sx += i; sy += y; sxy += i * y; sxx += i * i; });
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const norm = (a * (n - 1)) / (sy / n || 1);
  if (norm > 0.004) return "上行";
  if (norm < -0.004) return "下行";
  return "震荡";
}

export async function fetchTechSnapshot(symbol: string): Promise<TechSnapshot> {
  const defs = [["15分", "15分"], ["60分", "60分"], ["日线", "日线"], ["周线", "周线"]] as const;
  const results = await Promise.all(defs.map(([, tf]) => fetchCandlesFor(symbol, tf)));
  const tfs: TechTF[] = results.map((r, i) => {
    // 趋势判定与图表通道保持一致，都只看最近 60 根
    const closes = r.candles.slice(-60).map((c) => c.c);
    return { tf: defs[i][0], trend: trendLabel(closes), rsi: computeRsi(r.candles.map((c) => c.c)) };
  });

  const daily = results[2].candles;
  const source = results[2].source;
  let support: number | null = null;
  let resistance: number | null = null;
  let rr: number | null = null;
  let rangeHigh: number | null = null;
  let rangeLow: number | null = null;
  let rangePos: number | null = null;
  if (daily.length > 30) {
    const last = daily[daily.length - 1].c;
    // 关键位取最近 60 根，保证支撑/阻力贴近现价
    const lv = autoLevels(daily.slice(-60));
    resistance = lv.resistances.length ? lv.resistances[0] : null;
    support = lv.supports.length ? lv.supports[lv.supports.length - 1] : null;
    if (support != null && resistance != null && resistance > last && last > support) {
      const v = (resistance - last) / Math.max(1e-9, last - support);
      rr = isFinite(v) && v > 0 ? v : null;
    }
    const win = daily.slice(-120);
    rangeHigh = Math.max(...win.map((c) => c.h));
    rangeLow = Math.min(...win.map((c) => c.l));
    if (rangeHigh > rangeLow) {
      const p = ((last - rangeLow) / (rangeHigh - rangeLow)) * 100;
      rangePos = isFinite(p) ? p : null;
    }
  }
  return { tfs, support, resistance, rr, rangeHigh, rangeLow, rangePos, source };
}
