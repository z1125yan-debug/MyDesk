// 港股 / 美股单只日 K API（个股行情选项卡用）。
// 优先长桥 MCP 历史 K 线；美股回退 Yahoo（6 个月日 K）；港股无回退。
// 失败/无数据返回 available:false，不编 K 线。
import { NextResponse } from "next/server";
import { fetchLongbridgeHist, longbridgeMcpConfigured } from "@/lib/desk/longbridge-mcp";
import { classifySymbol, type MarketKind } from "@/lib/desk/market-kind";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";

export interface HkUsCandle {
  date: string; // YYYY-MM-DD
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

function yahooDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function fetchYahooCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean).join("; ");
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

async function fetchYahooKline(sym: string): Promise<HkUsCandle[] | null> {
  const auth = await fetchYahooCrumb();
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const crumbQs = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
      const res = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d${crumbQs}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          ...(auth ? { Cookie: auth.cookie } : {}),
        },
        cache: "no-store",
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status === 429) continue;
      if (!res.ok) return null;
      const j = (await res.json()) as {
        chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[] };
      };
      const r = j.chart?.result?.[0];
      if (!r?.timestamp?.length) return null;
      const q = r.indicators?.quote?.[0];
      if (!q) return null;
      const out: HkUsCandle[] = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const o = q.open?.[i];
        const h = q.high?.[i];
        const l = q.low?.[i];
        const c = q.close?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        out.push({ date: yahooDate(r.timestamp[i]), o, h, l, c, v: q.volume?.[i] ?? null });
      }
      return out.length ? out : null;
    } catch {
      // 超时/断线 → 换 host 再试一次
    }
  }
  return null;
}

export async function GET(request: Request) {
  return ttlCache(`market/hk-us/kline${new URL(request.url).search}`, DEFAULT_TTL_MS, () => getHandler(request));
}

async function getHandler(request: Request) {
  const url = new URL(request.url);
  const market = (url.searchParams.get("market") ?? "").toUpperCase();
  const symbol = (url.searchParams.get("symbol") ?? "").trim();
  if (market !== "HK" && market !== "US") {
    return NextResponse.json({ ok: false, error: "market 只能是 HK 或 US" }, { status: 400 });
  }
  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol 必填" }, { status: 400 });
  }
  // 符号必须属于该市场（A 股代码 / 对面市场代码 → 400，绝不跨市场映射）。
  const mk = market as MarketKind;
  if (classifySymbol(symbol) !== mk) {
    return NextResponse.json({ ok: false, market, error: `symbol ${symbol} 不属于 ${market} 市场` }, { status: 400 });
  }

  // 长桥优先（按 market 严格规范化符号）
  if (longbridgeMcpConfigured()) {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 200 * 864e5);
      const bars = await fetchLongbridgeHist(symbol, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), mk);
      if (bars?.length) {
        return NextResponse.json({
          ok: true, market, symbol, available: true, source: "longbridge-mcp",
          candles: bars.map((b) => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
        });
      }
    } catch {
      // 往下回退（美股）/ 报暂无（港股）
    }
  }

  if (market === "HK") {
    return NextResponse.json({ ok: true, market, symbol, available: false, reason: "长桥 MCP 未接通，暂无港股 K 线", source: "", candles: [] });
  }

  const y = await fetchYahooKline(symbol.replace(/\.(US|HK)$/i, ""));
  if (y) {
    return NextResponse.json({ ok: true, market, symbol, available: true, source: "yahoo", candles: y });
  }
  return NextResponse.json({ ok: true, market, symbol, available: false, reason: "长桥 MCP 未接通且 Yahoo 无返回，暂无美股 K 线", source: "", candles: [] });
}
