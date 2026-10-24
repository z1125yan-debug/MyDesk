// 港股 / 美股主流票快照 API（行情选项卡用）。
// 口径纪律：
//  - 港股只走长桥 MCP；未接通时返回 available:false + 原因，不编数据、不拿 A 股顶包。
//  - 美股优先长桥 MCP；长桥未接通/无返回时回退 Yahoo（公开行情），source 如实标注。
//  - 只做 20 只主流票，不是全市场；宽度/涨跌停等 A 股逻辑不套到港股/美股上。
//  - 美股无涨跌停；港股/美股的涨跌家数只统计这 20 只主流票，不代表全市场。
import { NextResponse } from "next/server";
import { fetchLongbridgeBatch, fetchLongbridgeQuote, longbridgeMcpConfigured } from "@/lib/desk/longbridge-mcp";
import { classifySymbol, type MarketKind } from "@/lib/desk/market-kind";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { HK_US_UNIVERSE } from "@/lib/quant/screener/hk-us-core";

export const dynamic = "force-dynamic";

export interface HkUsRow {
  symbol: string; // 裸代码：00700 / NVDA（无 .HK/.US 后缀，前端展示用）
  name: string | null;
  price: number | null;
  change_pct: number | null;
  volume: number | null; // 股
  amount_yi: number | null; // 成交额（亿，港元/美元原币，不折算人民币）
  market_cap_yi: number | null;
  pe_ttm: number | null;
  pb: number | null;
  main_net_yi: number | null;
}

// 20 只主流票名单：单点来源见 hk-us-core（选股与行情共用同一批票）。
const HK_MAJORS = HK_US_UNIVERSE.HK;
const US_MAJORS = HK_US_UNIVERSE.US;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emptyRow(code: string, name: string): HkUsRow {
  return { symbol: code, name, price: null, change_pct: null, volume: null, amount_yi: null, market_cap_yi: null, pe_ttm: null, pb: null, main_net_yi: null };
}

/** Yahoo crumb：fc.yahoo.com 取 cookie → /v1/test/getcrumb 取 crumb。失败返回 null（调用方走无 crumb 请求）。 */
async function fetchYahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
      redirect: "manual",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) return null;
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 8000);
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
      signal: ctrl2.signal,
    }).finally(() => clearTimeout(timer2));
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 64) return null;
    return { cookie, crumb };
  } catch {
    return null;
  }
}

interface YahooQuote { price: number; changePct: number | null; volume: number | null; }

/** Yahoo v8 chart 单只：带 crumb+cookie；429 时换 query2 host 重试一次。失败返回 null。 */
async function fetchYahooQuote(sym: string, auth: { cookie: string; crumb: string } | null): Promise<YahooQuote | null> {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (let attempt = 0; attempt < hosts.length; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const crumbQs = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
      const res = await fetch(`https://${hosts[attempt]}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d${crumbQs}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          ...(auth ? { Cookie: auth.cookie } : {}),
        },
        cache: "no-store",
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status === 429) { await sleep(800); continue; }
      if (!res.ok) return null;
      const j = (await res.json()) as { chart?: { result?: { meta?: Record<string, unknown> }[] } };
      const meta = j.chart?.result?.[0]?.meta;
      if (!meta) return null;
      const price = typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
      const prev = typeof meta.previousClose === "number" ? meta.previousClose : null;
      // Yahoo 有时不给 previousClose，但给 regularMarketChangePercent（实测 NVDA 有后者无前者）
      const directPct = typeof meta.regularMarketChangePercent === "number" ? meta.regularMarketChangePercent : null;
      if (price == null) return null;
      return {
        price,
        changePct: directPct ?? (prev != null && prev !== 0 ? ((price - prev) / prev) * 100 : null),
        volume: typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : null,
      };
    } catch {
      // 超时/断线 → 换 host 再试一次
    }
  }
  return null;
}

/** Yahoo 批量：先取 crumb（一次），再逐只拉（间隔 150ms 降限流）。 */
async function fetchYahooBatch(codes: string[]): Promise<Map<string, YahooQuote>> {
  const out = new Map<string, YahooQuote>();
  const auth = await fetchYahooCrumb();
  for (const code of codes) {
    const q = await fetchYahooQuote(code, auth);
    if (q) out.set(code, q);
    await sleep(150);
  }
  return out;
}


/** 单只报价行：长桥优先（按 market 严格规范化符号）；美股长桥无返回时回退 Yahoo；港股无回退。 */
async function fetchSingleRow(market: MarketKind, code: string): Promise<{ row: HkUsRow; source: string } | null> {
  if (longbridgeMcpConfigured()) {
    try {
      const q = await fetchLongbridgeQuote(code, market);
      if (q && q.price != null) {
        return {
          row: {
            symbol: code, name: q.name ?? null, price: q.price, change_pct: q.changePct,
            volume: q.volume, amount_yi: q.turnover != null ? q.turnover / 1e8 : null,
            market_cap_yi: null, pe_ttm: null, pb: null, main_net_yi: null,
          },
          source: "longbridge-mcp",
        };
      }
    } catch { /* 美股往下回退 Yahoo；港股返回 null */ }
  }
  if (market === "HK") return null;
  const y = await fetchYahooQuote(code.replace(/\.(US|HK)$/i, ""), await fetchYahooCrumb());
  if (!y) return null;
  return {
    row: {
      symbol: code, name: null, price: y.price, change_pct: y.changePct, volume: y.volume,
      amount_yi: y.volume != null ? (y.price * y.volume) / 1e8 : null,
      market_cap_yi: null, pe_ttm: null, pb: null, main_net_yi: null,
    },
    source: "yahoo",
  };
}

export async function GET(request: Request) {
  return ttlCache(`market/hk-us${new URL(request.url).search}`, DEFAULT_TTL_MS, () => getHandler(request));
}

async function getHandler(request: Request) {
  const url = new URL(request.url);
  const market = (url.searchParams.get("market") ?? "").toUpperCase();
  if (market !== "HK" && market !== "US") {
    return NextResponse.json({ ok: false, error: "market 只能是 HK 或 US" }, { status: 400 });
  }
  const mk = market as MarketKind;
  const majors = market === "HK" ? HK_MAJORS : US_MAJORS;

  // 单只直查 ?market=HK&symbol=00700（行情/画像/自选页用）：只查该只，不拉 20 只主流榜。
  // 符号必须属于该市场（00700 进 US 页、NVDA 进 HK 页 → 400，绝不跨市场映射）。
  const single = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (single) {
    if (classifySymbol(single) !== mk) {
      return NextResponse.json({ ok: false, market, error: `symbol ${single} 不属于 ${market} 市场` }, { status: 400 });
    }
    const singleRow = await fetchSingleRow(mk, single);
    if (singleRow) {
      return NextResponse.json({ ok: true, market, available: true, source: singleRow.source, trade_date: new Date().toISOString().slice(0, 10), symbol: single, list: [singleRow.row], total: 1 });
    }
    return NextResponse.json({
      ok: true, market, available: false,
      reason: market === "HK" ? "长桥 MCP 未接通，暂无港股数据" : "长桥 MCP 未接通且 Yahoo 无返回，暂无美股数据",
      source: "", trade_date: new Date().toISOString().slice(0, 10), symbol: single, list: [], total: 0,
    });
  }

  // 1) 长桥 MCP（港股/美股首选）
  if (longbridgeMcpConfigured()) {
    try {
      const quotes = await fetchLongbridgeBatch(
        majors.map((m) => m.code),
        (s) => fetchLongbridgeQuote(s, mk),
        { market: mk },
      );
      if (quotes.size > 0) {
        const nameOf = new Map(majors.map((m) => [m.code, m.name]));
        const list: HkUsRow[] = majors.map((m) => {
          const q = quotes.get(m.code) ?? quotes.get(`${m.code}.${market}`) ?? null;
          if (!q) return emptyRow(m.code, m.name);
          return {
            symbol: m.code,
            name: q.name ?? nameOf.get(m.code) ?? null,
            price: q.price,
            change_pct: q.changePct,
            volume: q.volume,
            amount_yi: q.turnover != null ? q.turnover / 1e8 : null,
            market_cap_yi: null,
            pe_ttm: null,
            pb: null,
            main_net_yi: null,
          };
        });
        return NextResponse.json({ ok: true, market, available: true, source: "longbridge-mcp", trade_date: new Date().toISOString().slice(0, 10), list, total: list.length });
      }
    } catch {
      // 长桥失败 → 美股回退 Yahoo；港股无回退（见下）
    }
  }

  // 2) 港股：长桥是唯一源，未接通/无返回 = 暂无数据（不编）
  if (market === "HK") {
    return NextResponse.json({
      ok: true, market, available: false,
      reason: "长桥 MCP 未接通，暂无港股数据",
      source: "", trade_date: new Date().toISOString().slice(0, 10),
      list: [], total: 0,
    });
  }

  // 3) 美股回退 Yahoo（公开行情，crumb 认证 + 429 换 host 重试）
  const yahoo = await fetchYahooBatch(majors.map((m) => m.code));
  const list: HkUsRow[] = [];
  for (const m of majors) {
    const y = yahoo.get(m.code);
    if (y) {
      list.push({
        symbol: m.code, name: m.name, price: y.price, change_pct: y.changePct, volume: y.volume,
        amount_yi: y.volume != null ? (y.price * y.volume) / 1e8 : null,
        market_cap_yi: null, pe_ttm: null, pb: null, main_net_yi: null,
      });
    } else {
      list.push(emptyRow(m.code, m.name));
    }
  }
  const got = list.filter((r) => r.price != null).length;
  if (got === 0) {
    return NextResponse.json({
      ok: true, market, available: false,
      reason: "长桥 MCP 未接通且 Yahoo 无返回，暂无美股数据",
      source: "", trade_date: new Date().toISOString().slice(0, 10),
      list: [], total: 0,
    });
  }
  return NextResponse.json({ ok: true, market, available: true, source: "yahoo", trade_date: new Date().toISOString().slice(0, 10), list, total: list.length });
}
