// 港股 / 美股选股 API：与 A 股选股同款五件套（选股筛选、宽度、分歧、事件、AI 优选），
// 但数据只用港股 / 美股自己的，一次取数返回五块（避免前端调 5 次、重复拉 20 只 K 线）。
//
// GET  ?market=HK|US            → 全量快照（不过滤）
// POST {market, conditions?, sort?, limit?} → 按条件过滤后的选股结果 + 同样五块
//
// 数据源：
// - 港股：只走长桥 MCP（quote + candlesticks + valuation + news）。未接通/无返回 →
//   available:false + 原因，不编数据、不拿 A 股 / Yahoo 顶包。
// - 美股：优先长桥 MCP；长桥未接通/无返回时回退 Yahoo 公开行情（v8 chart，
//   一次调用同时拿报价与 6 个月日 K），source 如实标注。Yahoo 也无返回 → available:false。
// - 长桥给不了换手率/主力净额/市值/PB：响应里 unavailable_fields 如实列出，
//   对应字段恒为 null，绝不拿 A 股数据冒充。
// - AI 优选：确定性规则打分（hk-us-core），不调模型、不写库。
import { NextResponse } from "next/server";
import {
  fetchLongbridgeBatch, fetchLongbridgeQuote, fetchLongbridgeHist, fetchLongbridgeFundamentals,
  fetchLongbridgeNews, longbridgeMcpConfigured,
} from "@/lib/desk/longbridge-mcp";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import {
  HK_US_UNIVERSE, HK_US_BENCHMARK, HK_US_FILTERABLE_FIELDS,
  enrichHkUs, filterHkUs, breadthHkUs, divergenceHkUs, eventsHkUs, aiPickHkUs,
  type HkUsMarket, type HkUsCond, type HkUsQuoteIn, type HkUsBar, type HkUsNewsIn,
} from "@/lib/quant/screener/hk-us-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// ---------- Yahoo 回退（仅美股；与 hk-us/kline 同款 crumb 打法，紧凑版） ----------

async function fetchYahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual", signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) return null;
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 8000);
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie }, signal: ctrl2.signal,
    }).finally(() => clearTimeout(timer2));
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    return crumb && crumb.length <= 64 ? { cookie, crumb } : null;
  } catch { return null; }
}

interface YahooChart { price: number | null; changePct: number | null; volume: number | null; bars: HkUsBar[] }

async function fetchYahooChart(sym: string, auth: { cookie: string; crumb: string } | null): Promise<YahooChart | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const crumbQs = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
      const res = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d${crumbQs}`, {
        headers: { "User-Agent": "Mozilla/5.0", ...(auth ? { Cookie: auth.cookie } : {}) },
        cache: "no-store", signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status === 429) { await sleep(800); continue; }
      if (!res.ok) return null;
      const j = (await res.json()) as {
        chart?: { result?: { timestamp?: number[]; meta?: Record<string, unknown>; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[] };
      };
      const r = j.chart?.result?.[0];
      if (!r?.timestamp?.length) return null;
      const meta = r.meta ?? {};
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const price = num(meta.regularMarketPrice);
      const prev = num(meta.previousClose);
      const directPct = num(meta.regularMarketChangePercent);
      const q = r.indicators?.quote?.[0];
      const bars: HkUsBar[] = [];
      if (q) {
        for (let i = 0; i < r.timestamp.length; i++) {
          const o = q.open?.[i]; const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i];
          if (o == null || h == null || l == null || c == null) continue;
          bars.push({
            date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
            o, h, l, c, v: q.volume?.[i] ?? null, amount: c != null && q.volume?.[i] != null ? c * (q.volume?.[i] as number) : null,
          });
        }
      }
      return {
        price,
        changePct: directPct ?? (price != null && prev != null && prev !== 0 ? ((price - prev) / prev) * 100 : null),
        volume: num(meta.regularMarketVolume),
        bars,
      };
    } catch { /* 换 host 再试 */ }
  }
  return null;
}

// ---------- 主流程 ----------

interface Collected {
  quotes: Map<string, HkUsQuoteIn>;
  bars: Map<string, HkUsBar[]>;
  pe: Map<string, number | null>;
  news: HkUsNewsIn[];
  bench: { change_pct: number | null; name: string } | null;
  source: string;
}

async function collectLongbridge(market: HkUsMarket, codes: string[]): Promise<Collected | null> {
  if (!longbridgeMcpConfigured()) return null;
  const quotes = new Map<string, HkUsQuoteIn>();
  const bars = new Map<string, HkUsBar[]>();
  const pe = new Map<string, number | null>();
  const news: HkUsNewsIn[] = [];
  try {
    const qm = await fetchLongbridgeBatch(codes, (s) => fetchLongbridgeQuote(s, market), { market });
    for (const [k, q] of qm) {
      const bare = k.replace(/\.(US|HK)$/, "");
      quotes.set(bare, { symbol: bare, name: q.name, price: q.price, changePct: q.changePct, volume: q.volume, turnover: q.turnover });
    }
    if (!quotes.size) return null;
    const start = isoDaysAgo(200);
    const end = new Date().toISOString().slice(0, 10);
    const hm = await fetchLongbridgeBatch(codes, (s) => fetchLongbridgeHist(s, start, end, market), { market });
    for (const [k, list] of hm) {
      bars.set(k.replace(/\.(US|HK)$/, ""), (list ?? []).map((b) => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, amount: b.amount })));
    }
    const fm = await fetchLongbridgeBatch(codes, (s) => fetchLongbridgeFundamentals(s, market), { market });
    for (const [k, f] of fm) pe.set(k.replace(/\.(US|HK)$/, ""), f?.pe ?? null);
    const nm = await fetchLongbridgeBatch(codes, (s) => fetchLongbridgeNews(s, 6, market), { market });
    for (const [k, items] of nm) {
      const bare = k.replace(/\.(US|HK)$/, "");
      for (const it of items ?? []) news.push({ symbol: bare, title: it.title, time: it.time, source: it.source, url: it.url, content: it.content });
    }
    // 港股宽基 02800 不在池内：单独取（进分歧/优选对照，不进池内分母）
    let bench: Collected["bench"] = null;
    if (market === "HK") {
      const bq = await fetchLongbridgeQuote(HK_US_BENCHMARK.HK, "HK");
      if (bq) bench = { change_pct: bq.changePct, name: bq.name ?? "盈富基金" };
    } else {
      const spy = quotes.get(HK_US_BENCHMARK.US);
      if (spy) bench = { change_pct: spy.changePct, name: spy.name ?? "SPDR标普500" };
    }
    return { quotes, bars, pe, news, bench, source: "longbridge-mcp" };
  } catch {
    return quotes.size ? { quotes, bars, pe, news, bench: null, source: "longbridge-mcp" } : null;
  }
}

async function collectYahooUs(codes: string[]): Promise<Collected | null> {
  const auth = await fetchYahooCrumb();
  const quotes = new Map<string, HkUsQuoteIn>();
  const bars = new Map<string, HkUsBar[]>();
  for (const code of codes) {
    const y = await fetchYahooChart(code, auth);
    if (y) {
      quotes.set(code, { symbol: code, name: null, price: y.price, changePct: y.changePct, volume: y.volume, turnover: y.price != null && y.volume != null ? y.price * y.volume : null });
      bars.set(code, y.bars);
    }
    await sleep(150);
  }
  if (!quotes.size) return null;
  const spy = quotes.get(HK_US_BENCHMARK.US);
  return {
    quotes, bars, pe: new Map(), news: [],
    bench: spy ? { change_pct: spy.changePct, name: "SPDR标普500" } : null,
    source: "yahoo",
  };
}

function buildResponse(market: HkUsMarket, col: Collected, conds: HkUsCond[], sortBy: string, limit: number) {
  const universe = HK_US_UNIVERSE[market];
  const nameOf = new Map(universe.map((u) => [u.code, u.name]));
  const rows = enrichHkUs(universe, col.quotes, col.bars, col.pe);
  const filtered = filterHkUs(rows, conds);
  const sorted = [...filtered.rows].sort((a, b) => {
    const va = (a as unknown as Record<string, number | null>)[sortBy] ?? null;
    const vb = (b as unknown as Record<string, number | null>)[sortBy] ?? null;
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va;
  });
  const page = sorted.slice(0, limit);
  const breadth = breadthHkUs(rows, col.bars);
  const divergence = divergenceHkUs(market, rows, col.bench);
  const events = eventsHkUs(col.news, nameOf);
  const aiPick = aiPickHkUs(rows, col.bench?.change_pct ?? null);
  const withData = rows.filter((r) => r.price != null).length;
  const warnings = [...filtered.warnings];
  if (col.source === "yahoo") warnings.push("长桥 MCP 未接通/无返回，美股本次回退 Yahoo 公开行情（无估值 PE、无新闻，估值/事件项缺失）。");
  if (withData < rows.length) warnings.push(`报价只取到 ${withData}/${rows.length} 只，其余行字段为 null（缺读数，不是 0）。`);
  return {
    ok: true,
    market,
    market_label: market === "HK" ? "港股" : "美股",
    available: true,
    source: col.source,
    trade_date: new Date().toISOString().slice(0, 10),
    pool: "20 只主流票（非全市场）",
    fields: HK_US_FILTERABLE_FIELDS,
    funnel: { universe: rows.length, with_data: withData, filtered: filtered.rows.length },
    list: page.map((r) => ({ ...r, bars: undefined, bars_count: r.bars })),
    total: filtered.rows.length,
    breadth,
    divergence,
    events,
    ai_pick: aiPick,
    warnings,
    unavailable_fields: filtered.unavailable,
    missing: col.source === "yahoo"
      ? ["美股回退 Yahoo：PE、新闻未取到"]
      : ["长桥 MCP 无换手率/主力净额/市值/PB/流通市值"],
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const market = (url.searchParams.get("market") ?? "").toUpperCase() as HkUsMarket;
  if (market !== "HK" && market !== "US") {
    return NextResponse.json({ ok: false, error: "market 只能是 HK 或 US" }, { status: 400 });
  }
  return ttlCache(`market/hk-us/screener?market=${market}`, DEFAULT_TTL_MS, () => getHandler(market, [], "amount_yi", 50));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    market?: string; conditions?: HkUsCond[]; sort_by?: string; limit?: number;
  };
  const market = (String(body.market ?? "").toUpperCase()) as HkUsMarket;
  if (market !== "HK" && market !== "US") {
    return NextResponse.json({ ok: false, error: "market 只能是 HK 或 US" }, { status: 400 });
  }
  const conds = Array.isArray(body.conditions) ? body.conditions : [];
  const sortBy = typeof body.sort_by === "string" && HK_US_FILTERABLE_FIELDS.some((f) => f.field === body.sort_by) ? body.sort_by : "amount_yi";
  const limit = Math.max(1, Math.min(50, Number(body.limit) || 50));
  // POST 带条件体：不进 GET 短缓存（条件不同结果不同），直接算。
  return getHandler(market, conds, sortBy, limit);
}

async function getHandler(market: HkUsMarket, conds: HkUsCond[], sortBy: string, limit: number) {
  const codes = HK_US_UNIVERSE[market].map((u) => u.code);
  let col = await collectLongbridge(market, codes);
  if (!col && market === "US") col = await collectYahooUs(codes);
  if (!col) {
    return NextResponse.json({
      ok: true, market, market_label: market === "HK" ? "港股" : "美股", available: false,
      reason: market === "HK" ? "长桥 MCP 未接通，暂无港股数据" : "长桥 MCP 未接通且 Yahoo 无返回，暂无美股数据",
      source: "", trade_date: new Date().toISOString().slice(0, 10),
      list: [], total: 0, breadth: null, divergence: [], events: [], ai_pick: [],
      warnings: [], unavailable_fields: [], missing: ["数据源未接通"],
    });
  }
  return NextResponse.json(buildResponse(market, col, conds, sortBy, limit));
}
