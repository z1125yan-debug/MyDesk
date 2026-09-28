// 新浪日K兜底源（服务端）——专门补「腾讯日K对北交所只返回 1 根」这个缺口。
//
// 背景（2026-09-25 实测）：
//   通达信网关对北交所（.BJ）无返回；腾讯 fqkline 对 .BJ 只给最新 1 根（沪市给几百根）。
//   结果是北交所 344 只股票的 K线类字段（K线形态、趋势压力线_60、各类均线/RPS）全部为 null，
//   页面整列显示「—」。新浪 getKLineData 对北交所返回完整历史，实测可取数十根。
//
// 口径纪律：
//   1) 只做「腾讯拿不到足够K线」时的兜底，不改变主链优先级（通达信 → 腾讯 → 新浪）；
//   2) 返回结构与 BarsLike 对齐（o/h/l/c/v/date），不做复权猜测——新浪该接口返回的是不复权原始价，
//      与通达信网关口径一致（腾讯兜底才是 qfq），差异在 price_basis 已如实标注；
//   3) 失败一律抛错，由调用方决定降级姿势，不返回空数组冒充「没数据」。
import type { BarsLike } from "../factors/fields.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** MyDesk 符号 → 新浪符号：688256.SH → sh688256；920706.BJ → bj920706 */
function toSinaCode(symbol: string): string | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  return m[2].toLowerCase() + m[1];
}

interface SinaKlineRow {
  day: string; open: string; high: string; low: string; close: string; volume: string;
}

/**
 * 取新浪日K（最近 len 根，时间升序）。
 * @throws 网络失败 / 返回不可解析 / 无数据时抛错
 */
export async function sinaDayBars(symbol: string, len = 260): Promise<BarsLike[]> {
  const code = toSinaCode(symbol);
  if (!code) throw new Error(`新浪源不支持该代码：${symbol}`);
  const url =
    "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData" +
    `?symbol=${code}&scale=240&ma=no&datalen=${Math.max(1, Math.min(1000, len))}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" },
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`新浪日K HTTP ${res.status}`);
  const txt = (await res.text()).trim();
  if (!txt || txt === "null" || !txt.startsWith("[")) {
    throw new Error(`新浪日K无数据（${symbol}）`);
  }
  let rows: SinaKlineRow[];
  try {
    rows = JSON.parse(txt) as SinaKlineRow[];
  } catch {
    throw new Error(`新浪日K响应不可解析（${symbol}）`);
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error(`新浪日K无数据（${symbol}）`);
  const out: BarsLike[] = [];
  for (const r of rows) {
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    const v = Number(r.volume);
    if (!r.day || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    out.push({ date: r.day, o, h, l, c, v: isFinite(v) ? v : 0 });
  }
  if (!out.length) throw new Error(`新浪日K全部行不可解析（${symbol}）`);
  // 新浪返回已是升序，这里再保险排一次
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
