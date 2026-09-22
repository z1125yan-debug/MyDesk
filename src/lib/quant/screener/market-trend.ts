// 大盘趋势取数（服务端专属）：沪深京指数日线（含成交额）走东财 kline 接口。
// 与 em.ts 的关系：em.ts 在「不动清单」上，而它现有的 K 线走腾讯/通达信、行里根本没有成交额字段，
// 两市成交额趋势要的 f57（成交额·元）只有东财给——所以这里自带一份窄取数，不回写 em.ts。
//
// 断源口径（P8/P9 实测教训）：push2his 对指数 kline 实测可用，push2delay 对指数返回空数组是实测结果，
// 仍按「先 his 后 delay」试一遍——两边都空就如实 missing，页面画「暂无数据」，不拿昨天的数冒充今天。
import type { IndexDayBar } from "./market-trend-core";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HOSTS = ["https://push2his.eastmoney.com", "https://push2delay.eastmoney.com"];

export const SH_SECID = "1.000001"; // 上证指数
export const SZ_SECID = "0.399001"; // 深证成指
export const CYB_SECID = "0.399006"; // 创业板指

async function getJson<T>(url: string, timeoutMs = 6000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: ac.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

interface EmKlineResp { data?: { klines?: string[] } }

/** 60s 进程内小缓存：页面挂载、点按钮、来回切页都会撞同一个区间，不值得每次打穿东财 */
const memo = new Map<string, { at: number; bars: IndexDayBar[] }>();
const MEMO_MS = 60_000;

/** 拉一只指数的日线（闭区间日期 YYYY-MM-DD）。任何一边失败都是空数组——空不是一种谎，缺会由上层如实报 */
export async function fetchIndexDayBars(secid: string, from: string, to: string): Promise<IndexDayBar[]> {
  const key = `${secid}|${from}|${to}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.bars;
  const beg = (from || "").replace(/-/g, "");
  const end = (to || "").replace(/-/g, "") || "20990101";
  let bars: IndexDayBar[] = [];
  for (const host of HOSTS) {
    try {
      const j = await getJson<EmKlineResp>(
        `${host}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&fields1=f1,f2,f3&fields2=f51,f53,f57&beg=${beg}&end=${end}&lmt=480`,
      );
      const rows = j?.data?.klines ?? [];
      if (!rows.length) continue;
      bars = rows
        .map((line) => line.split(","))
        .filter((p) => p.length >= 3)
        .map((p) => ({ date: p[0], close: parseFloat(p[1]), amountYi: parseFloat(p[2]) / 1e8 }))
        .filter((b) => isFinite(b.close) && isFinite(b.amountYi));
      break;
    } catch {
      // 换下一个主机；全失败就空数组
    }
  }
  memo.set(key, { at: Date.now(), bars });
  return bars;
}
