// stock-sdk 全市场快照封装（P3：作为 emProvider/腾讯快照 的第三条兜底通道）
// 用途：当 /api/market/quote、/api/market/allstocks、/api/market/sentiment、
//       /api/market/themes、/api/market/risk、/api/quant/selection 等依赖"全市场实时快照"
//       的接口在东财+腾讯双挂时可以兜底；也提供 batch.cn 单股取数（含五档盘口、内外盘）。
// 契约：走本机 stock-sdk（TickFlow 已适配的第三方回退），不冒充实数。
import { StockSDK } from "stock-sdk";

let _sdk: StockSDK | null = null;
export function getSdk(): StockSDK {
  if (!_sdk) _sdk = new StockSDK();
  return _sdk;
}

// 6 位代码 -> stock-sdk 支持的写法（sh600519 / sz000001 / bj430047）
export function toSdkSymbol(symbol: string): string {
  // 支持输入 601318.SH / 601318 / sh600519 三种
  let m = symbol.toUpperCase();
  const dot = m.indexOf(".");
  const suffix = dot >= 0 ? m.slice(dot + 1) : null;
  const code6 = dot >= 0 ? m.slice(0, dot) : m;
  const six = /^\d{6}$/.test(code6) ? code6 : m.match(/^\d{6}/)?.[0];
  if (!six) return m;
  if (suffix === "SH" || /^6|^9|^5/.test(six)) return `sh${six}`;
  if (suffix === "SZ" || /^(0|3)/.test(six)) return `sz${six}`;
  if (suffix === "BJ" || /^(4|8|92)/.test(six)) return `bj${six}`;
  if (/^6/.test(six)) return `sh${six}`;
  if (/^(0|3)/.test(six)) return `sz${six}`;
  if (/^(4|8)/.test(six)) return `bj${six}`;
  return `sh${six}`;
}

export interface SdkQuote {
  symbol: string;         // 601318.SH
  code: string;           // 601318
  name: string;
  price: number;
  prevClose: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;         // 手
  amountYi: number;       // 亿
  turnoverRate: number | null;
  peTtm: number | null;
  pb: number | null;
  totalMarketCapYi: number | null;
  circulatingMarketCapYi: number | null;
  limitUp: number | null;
  limitDown: number | null;
  innerVolume: number | null;
  outerVolume: number | null;
  time: string | null;
  source: string;
}

function mapFullQuote(raw: { marketId?: string; code?: string; name?: string; price?: number; prevClose?: number;
  open?: number; high?: number; low?: number; volume?: number; amount?: number; turnoverRate?: number | null;
  pe?: number | null; pb?: number | null; totalMarketCap?: number | null; circulatingMarketCap?: number | null;
  limitUp?: number | null; limitDown?: number | null; innerVolume?: number | null; outerVolume?: number | null;
  time?: string; source?: string; changePercent?: number }): SdkQuote {
  // stock-sdk 的 marketId 是数字字符串："1"=SH "51"=SZ "141"=BJ；也兼容 "SH"/"SZ"/"BJ" 写法
  let marketId: string;
  const mid = String(raw.marketId ?? "");
  if (/^(sh|sz|bj)$/i.test(mid)) marketId = mid.toUpperCase();
  else if (mid === "1") marketId = "SH";
  else if (mid === "51") marketId = "SZ";
  else if (mid === "141") marketId = "BJ";
  else {
    // 兜底：按代码段判
    const c = raw.code ?? "";
    if (/^(6|9|5)/.test(c)) marketId = "SH";
    else if (/^(4|8|92)/.test(c)) marketId = "BJ";
    else marketId = "SZ";
  }
  const code = raw.code ?? "";
  const symbol = code ? `${code}.${marketId}` : "";
  return {
    symbol,
    code,
    name: raw.name ?? "",
    price: raw.price ?? 0,
    prevClose: raw.prevClose ?? 0,
    changePct: raw.changePercent ?? 0,
    open: raw.open ?? 0,
    high: raw.high ?? 0,
    low: raw.low ?? 0,
    volume: raw.volume ?? 0,
    amountYi: (raw.amount ?? 0) / 1e4, // 万 -> 亿
    turnoverRate: raw.turnoverRate ?? null,
    peTtm: raw.pe ?? null,
    pb: raw.pb ?? null,
    totalMarketCapYi: raw.totalMarketCap ?? null,
    circulatingMarketCapYi: raw.circulatingMarketCap ?? null,
    limitUp: raw.limitUp ?? null,
    limitDown: raw.limitDown ?? null,
    innerVolume: raw.innerVolume ?? null,
    outerVolume: raw.outerVolume ?? null,
    time: raw.time ?? null,
    source: "stock-sdk · " + (raw.source ?? "unknown"),
  };
}

// 单只股票快照（含五档盘口、内外盘）
export async function fetchQuotesSdk(symbols: string[]): Promise<Map<string, SdkQuote>> {
  const out = new Map<string, SdkQuote>();
  const codes = symbols.map((s) => toSdkSymbol(s));
  try {
    const quotes = await getSdk().batch.byCodes(codes, { batchSize: 100, concurrency: 5 });
    for (const q of quotes) {
      const m = mapFullQuote(q as Parameters<typeof mapFullQuote>[0]);
      if (m.symbol) out.set(m.symbol, m);
    }
  } catch {
    // 单批失败返回空 map，调用方归入 missing
  }
  return out;
}

// 全 A 股快照（默认 3000+ 只；market 可选 sh/sz/bj/kc/cy）
export async function fetchQuotesSdkAll(opts?: { market?: "sh" | "sz" | "bj" | "kc" | "cy"; concurrency?: number; batchSize?: number }): Promise<{
  data: SdkQuote[];
  source: string;
  count: number;
}> {
  const market = opts?.market;
  const concurrency = opts?.concurrency ?? 7;
  const batchSize = opts?.batchSize ?? 500;
  try {
    const raw = await getSdk().batch.cn({ market, concurrency, batchSize });
    const data: SdkQuote[] = raw.map((q) => mapFullQuote(q as Parameters<typeof mapFullQuote>[0]));
    return {
      data: data.filter((d) => d.symbol),
      source: `stock-sdk · batch.cn${market ? `:${market}` : " (全市场)"}`,
      count: data.length,
    };
  } catch {
    return { data: [], source: "stock-sdk · batch.cn 失败", count: 0 };
  }
}

// 分钟 K 线（1/5/15/30/60 分钟）
export interface SdkMinuteBar {
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export async function fetchKlineSdkMinute(symbol: string, period: "1" | "5" | "15" | "30" | "60" = "5"): Promise<SdkMinuteBar[]> {
  try {
    const raw = await getSdk().kline.cnMinute(toSdkSymbol(symbol), { period });
    // stock-sdk 返回 MinuteKline[] 或 MinuteTimeline[]，宽容解析
    return (raw as unknown as Record<string, unknown>[]).map((r) => ({
      date: String(r.date ?? r.day ?? ""),
      time: String(r.time ?? r.datetime ?? ""),
      open: Number(r.open ?? 0),
      high: Number(r.high ?? 0),
      low: Number(r.low ?? 0),
      close: Number(r.close ?? 0),
      volume: Number(r.volume ?? 0),
      amount: Number(r.amount ?? 0),
    })).filter((x) => x.date || x.time);
  } catch {
    return [];
  }
}
