// 大盘趋势取数（服务端专属）：沪深京指数日线。
// 主源：eltdx 通达信网关（bars.get，指数码 sh/sz+6 位；bars 自带 amount=成交额（元），
//   实测 09-22 上证 1.008 万亿量级正确）——2026-09-25 用户拍板：不再使用东财。
// 备源：腾讯 ifzq 日K（close 准确；腾讯对指数的量字段是成交量不是成交额，amountYi 留 NaN，
//   硬算会画出量级错误 20 倍的曲线——备源不冒充成交额）。
// 今日成交额兜底：stock-sdk（腾讯行情快照，指数 amount 单位万元），仅补今日一根柱。
import type { IndexDayBar } from "./market-trend-core";
import { tdxDayBars } from "@/lib/desk/tdx";
import { StockSDK } from "stock-sdk";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TENCENT_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";

/** 指数目录（对齐稳智「指数涨跌幅」七线：全A/上证/红利/小盘/中小盘/深成/创业板）。
 *  名称用官方指数名：小盘=国证2000（399303），中小盘=中证500（000905），全A=国证A指（399317）。 */
export interface IndexCatalogEntry { key: string; name: string; symbol: string; }
export const INDEX_CATALOG: IndexCatalogEntry[] = [
  { key: "all", name: "全A", symbol: "399317.SZ" },
  { key: "sh", name: "上证", symbol: "000001.SH" },
  { key: "dividend", name: "红利", symbol: "000015.SH" },
  { key: "gz2000", name: "国证2000", symbol: "399303.SZ" },
  { key: "csi500", name: "中证500", symbol: "000905.SH" },
  { key: "sz", name: "深成", symbol: "399001.SZ" },
  { key: "cyb", name: "创业板", symbol: "399006.SZ" },
  { key: "bj", name: "北证50", symbol: "899050.BJ" },
];
export const SH_SYMBOL = "000001.SH";
export const SZ_SYMBOL = "399001.SZ";
export const CYB_SYMBOL = "399006.SZ";
/** 北证50（北交所）——「三市合计」的第三市；成交额口径与沪深一致（通达信日K带 amount） */
export const BJ_SYMBOL = "899050.BJ";

// 腾讯指数代码：sh=上证系、sz=深证系/创业系、bj=北证系
const TENCENT_CODE: Record<string, string> = {
  [SH_SYMBOL]: "sh000001",
  [SZ_SYMBOL]: "sz399001",
  [CYB_SYMBOL]: "sz399006",
  [BJ_SYMBOL]: "bj899050",
};

async function getJson<T>(url: string, timeoutMs = 6000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://gu.qq.com/" }, signal: ac.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

interface TencentKlineResp {
  code?: number;
  data?: Record<string, { day?: string[][]; qfqday?: string[][] }>;
}

/** 60s 进程内小缓存：页面挂载、点按钮、来回切页都会撞同一个区间，不值得每次打穿上游 */
const memo = new Map<string, { at: number; bars: IndexDayBar[]; source: "eltdx" | "tencent" | "none" }>();
const MEMO_MS = 60_000;

let _sdk: StockSDK | null = null;
function getSdk(): StockSDK {
  if (!_sdk) _sdk = new StockSDK();
  return _sdk;
}

export interface IndexDayBarsResult {
  bars: IndexDayBar[];
  source: "eltdx" | "tencent" | "none";
}

/**
 * 拉一只指数的日线（闭区间日期 YYYY-MM-DD）。
 * 主源 eltdx 通达信（带 amount）→ 备源腾讯（仅 close）；两个都空如实给空数组。
 */
export async function fetchIndexDayBars(symbol: string, from: string, to: string): Promise<IndexDayBarsResult> {
  const key = `${symbol}|${from}|${to}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return { bars: hit.bars, source: hit.source };

  // 主源：通达信网关（本地，~30ms/只；一次取 520 根覆盖 90 天窗口 + MA5）
  try {
    const bars = await tdxDayBars(symbol, 520);
    const inWin = (bars ?? [])
      .filter((b) => b.date >= from && b.date <= to)
      .map((b) => ({ date: b.date, close: b.c, amountYi: b.amount > 0 ? b.amount / 1e8 : NaN }));
    if (inWin.length) {
      memo.set(key, { at: Date.now(), bars: inWin, source: "eltdx" });
      return { bars: inWin, source: "eltdx" };
    }
  } catch {
    // 网关挂/超时 → 腾讯兜底
  }

  const tx = await fetchFromTencent(symbol, from, to);
  memo.set(key, { at: Date.now(), bars: tx, source: tx.length ? "tencent" : "none" });
  return { bars: tx, source: tx.length ? "tencent" : "none" };
}

async function fetchFromTencent(symbol: string, from: string, to: string): Promise<IndexDayBar[]> {
  const tc = TENCENT_CODE[symbol];
  if (!tc) return [];
  const norm = (s: string) => {
    const digits = s.replace(/-/g, "");
    return digits.length >= 8
      ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
      : "";
  };
  const beg = norm(from || "19900101");
  const end = norm(to || "20990101");
  try {
    const j = await getJson<TencentKlineResp>(
      `${TENCENT_KLINE}?param=${tc},day,${beg},${end},320,qfq`,
      8000,
    );
    const rows = j?.data?.[tc]?.day ?? j?.data?.[tc]?.qfqday ?? [];
    if (!rows.length) return [];
    return rows
      .map((p) => {
        if (p.length < 3) return null;
        const date = p[0];
        const close = parseFloat(p[2]);
        // 腾讯 kline 第 6 列对指数是成交量，量级与真实成交额差 20 倍以上——amountYi 留 NaN，不冒充
        return { date, close, amountYi: NaN };
      })
      .filter((b): b is IndexDayBar => b !== null && isFinite(b.close));
  } catch {
    return [];
  }
}

/**
 * 从 stock-sdk（腾讯行情快照）拿指数的当日成交额（亿）。
 * 单位换算：腾讯行情 amount 对指数是万元（实测口径），除以 1e4 得亿。
 * 仅能拿最近一根，历史序列靠 eltdx；失败返回 null 由调用方决定。
 */
export async function fetchTodayAmountYi(symbol: string): Promise<{ date: string; amountYi: number } | null> {
  const tc = TENCENT_CODE[symbol];
  if (!tc) return null;
  try {
    const sdk = getSdk();
    const quotes = await sdk.quotes.cn([tc]);
    const q = quotes[0] as { amount?: number | null; time?: string } | undefined;
    if (!q || typeof q.amount !== "number" || !isFinite(q.amount) || q.amount <= 0) return null;
    const ts = String(q.time ?? "").replace(/\D/g, "");
    const date = ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null;
    if (!date) return null;
    return { date, amountYi: q.amount / 1e4 };
  } catch {
    return null;
  }
}
