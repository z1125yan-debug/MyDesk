// 跨市场预警·外盘日K数据层 —— 美股ETF走腾讯 usfqkline，国际期货走新浪 GlobalFuturesService。
// 免 key、零新依赖（与 tc-universe / sina-flow 同一套打法）。
// 纪律：拿不到 → bars 留空并带原因字符串，不给 0、不猜；进程内 TTL 缓存（外盘日K一天只变一次，30 分钟足够）。
// 端点 2026-09-29 本机实测：
//   · https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=usSMH.OQ,day,,,10,qfq → data[code].qfqday = [date,open,close,high,low,vol]
//   · https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=GC
//     （要 Referer: https://finance.sina.com.cn）→ jsonp 包一列 {date,open,high,low,close,...}，升序全历史（CL 自 1996 起，~700KB）
import fs from "node:fs";
import path from "node:path";

export interface OverseasDailyBar {
  date: string;
  close: number;
}

export interface OverseasDailySeries {
  key: string;
  label: string;
  kind: "etf" | "futures";
  /** 升序，尾部最新；只保留尾部窗口（判定用不了更多） */
  bars: OverseasDailyBar[];
  /** bars 为空时给原因；有数时为空串 */
  missing: string;
}

export const OVERSEAS_DAILY_CODES = [
  { key: "usSMH", label: "美国半导体ETF", kind: "etf" as const, tc: "usSMH.OQ" },
  { key: "usNQ", label: "纳指期货", kind: "futures" as const, sina: "NQ" },
  { key: "comexGold", label: "COMEX黄金", kind: "futures" as const, sina: "GC" },
  { key: "nymexCrude", label: "NYMEX原油", kind: "futures" as const, sina: "CL" },
] as const;

const TAIL = 12; // 判定最多用到近 5 日 + 少量余量
const TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, { t: number; series: OverseasDailySeries }>();
const inflight = new Map<string, Promise<OverseasDailySeries>>();

async function fetchText(url: string, referer?: string, timeoutMs = 15000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal, headers: referer ? { Referer: referer } : undefined });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 腾讯美股日K：data[code].qfqday（也兼容 day），[date, open, close, high, low, vol] */
function parseTcDaily(text: string, code: string): OverseasDailyBar[] {
  const j = JSON.parse(text) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
  const rows = j.data?.[code]?.qfqday ?? j.data?.[code]?.day ?? [];
  const out: OverseasDailyBar[] = [];
  for (const r of rows) {
    const close = Number(r[2]);
    if (r[0] && Number.isFinite(close) && close > 0) out.push({ date: r[0], close });
  }
  return out.slice(-TAIL);
}

/** 新浪全球期货日K：jsonp `var t=([...])`，升序全历史 → 取尾部 */
function parseSinaFuturesDaily(text: string): OverseasDailyBar[] {
  const m = /var t=\(([\s\S]*)\)\s*;?\s*$/.exec(text.trim());
  if (!m) throw new Error("返回形状不认（jsonp 壳变了？）");
  const arr = JSON.parse(m[1]) as { date: string; close: string }[];
  const out: OverseasDailyBar[] = [];
  for (const r of arr) {
    const close = Number(r.close);
    if (r.date && Number.isFinite(close) && close > 0) out.push({ date: r.date, close });
  }
  return out.slice(-TAIL);
}

async function fetchOne(key: string): Promise<OverseasDailySeries> {
  const def = OVERSEAS_DAILY_CODES.find((d) => d.key === key);
  if (!def) return { key, label: key, kind: "etf", bars: [], missing: `未知外盘代码 ${key}` };
  try {
    let bars: OverseasDailyBar[];
    if (def.kind === "etf") {
      const text = await fetchText(`https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${def.tc},day,,,${TAIL},qfq`);
      bars = parseTcDaily(text, def.tc);
      if (!bars.length) throw new Error("腾讯回了但没有可用日K行");
    } else {
      const text = await fetchText(
        `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${def.sina}`,
        "https://finance.sina.com.cn",
      );
      bars = parseSinaFuturesDaily(text);
      if (!bars.length) throw new Error("新浪回了但没有可用日K行");
    }
    return { key: def.key, label: def.label, kind: def.kind, bars, missing: "" };
  } catch (e) {
    return { key: def.key, label: def.label, kind: def.kind, bars: [], missing: `${def.label}：${String((e as Error).message || e)}` };
  }
}

/** 全部外盘日K（30 分钟缓存 + in-flight 去重；单只失败不拖垮其它） */
export async function fetchOverseasDailyAll(): Promise<OverseasDailySeries[]> {
  const now = Date.now();
  const jobs: Promise<OverseasDailySeries>[] = [];
  for (const def of OVERSEAS_DAILY_CODES) {
    const hit = cache.get(def.key);
    if (hit && now - hit.t < TTL_MS) {
      jobs.push(Promise.resolve(hit.series));
      continue;
    }
    let p = inflight.get(def.key);
    if (!p) {
      p = fetchOne(def.key).then((s) => {
        cache.set(def.key, { t: Date.now(), series: s });
        inflight.delete(def.key);
        return s;
      }).catch((e) => {
        inflight.delete(def.key);
        return { key: def.key, label: def.label, kind: def.kind, bars: [], missing: `${def.label}：${String((e as Error).message || e)}` };
      });
      inflight.set(def.key, p);
    }
    jobs.push(p);
  }
  return Promise.all(jobs);
}

/** 北京时区「今天」YYYY-MM-DD（禁 toISOString，会把 UTC 日期当北京日期） */
export function beijingTodayStr(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
