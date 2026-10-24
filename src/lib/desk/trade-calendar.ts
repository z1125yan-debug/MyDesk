// 真实 A 股交易日历（内置年历）——唯一能回答「未来哪天开盘 / 哪天休市」的东西。
//
// 为什么必须有它：通达信 workdays.range 只统计到最近交易日，**给不出未来**（tdx.ts:308 明写），
// 而稳智那种「下周只有 9/28、29、30 三个交易日，10/1–7 休市，10/8 复市」只能靠整年日历。
// 数据：data/trade-calendar.json（2026 全年，源 akshare.tool_trade_date_hist_sina / 新浪）。
// 口径：真实含法定节假日与周末；不是「去掉周末」的近似，也不是推断——读不到就一律返回空/null。
//
// 用 py -3.14 重生成（PATH 上的 python 是坏的）：
//   NO_PROXY=* py -3.14 -c "import akshare as ak,json;d=sorted(str(x) for x in ak.tool_trade_date_hist_sina()['trade_date']);\
//   json.dump({'source':'akshare.tool_trade_date_hist_sina（新浪 A股交易日历，含法定节假日）','coverage':'2026-01-01 ~ 2026-12-31','days':[x for x in d if x.startswith('2026')]},open('data/trade-calendar.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)"
// 换年时重跑一次即可（旧年份不影响：本模块只查未来的日子）。
import fs from "node:fs";
import path from "node:path";

interface CalendarJson {
  source: string;
  generatedAt?: string;
  coverage: string;
  note?: string;
  days: string[];
}

let cache: Set<string> | null = null;

function days(): Set<string> {
  if (cache) return cache;
  try {
    const p = path.resolve(process.cwd(), "data", "trade-calendar.json");
    const j: CalendarJson = JSON.parse(fs.readFileSync(p, "utf8"));
    cache = new Set((j.days || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  } catch {
    cache = new Set(); // 读不到就空集：所有查询返回空/null，绝不猜一个日期出来
  }
  return cache;
}

/** 该日是否交易日；日历读不到时返回 null（不是 false——「不知道」≠「休市」） */
export function isTradingDay(d: string): boolean | null {
  const s = days();
  if (!s.size) return null;
  return s.has(d);
}

/** 从 from（含）起的未来 n 个交易日 */
export function upcomingTradingDays(from: string, n = 5): string[] {
  const s = days();
  if (!s.size) return [];
  return [...s].filter((d) => d >= from).sort().slice(0, n);
}

export function nextTradingDay(from: string): string | null {
  return upcomingTradingDays(from, 1)[0] ?? null;
}

/**
 * from 之后的 n 个交易日（严格 > from，跳周末/法定节假日）。
 * 日历覆盖不到时返回已找到的（可能少于 n 个），绝不猜。
 * 用途：卖出日 = 决策日 D 之后的第 2 个交易日（D+2）。
 */
export function tradingDaysAfter(from: string, n: number): string[] {
  const s = days();
  if (!s.size || n <= 0) return [];
  const out: string[] = [];
  //  bounded search：最多往后查 120 个自然日，日历覆盖不到就停
  const d0 = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(d0)) return [];
  for (let i = 1; i <= 120 && out.length < n; i++) {
    const d = new Date(d0 + i * 86_400_000).toISOString().slice(0, 10);
    if (s.has(d)) out.push(d);
  }
  return out;
}

/** from 之后的第 n 个交易日（严格 > from）；日历覆盖不到时返回 null，绝不猜 */
export function nthTradingDayAfter(from: string, n: number): string | null {
  return tradingDaysAfter(from, n)[n - 1] ?? null;
}

/** 未来 horizon 天内、连续 >= minLen 天的休市段（法定节假日 / 周末连休） */
export function upcomingHolidayWindows(
  from: string,
  horizon = 21,
  minLen = 2,
): { start: string; end: string; len: number }[] {
  const s = days();
  if (!s.size) return [];
  const out: { start: string; end: string; len: number }[] = [];
  let run: string[] = [];
  const d0 = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < horizon; i++) {
    const d = new Date(d0 + i * 86_400_000).toISOString().slice(0, 10);
    if (!s.has(d)) run.push(d);
    else {
      if (run.length >= minLen) out.push({ start: run[0], end: run[run.length - 1], len: run.length });
      run = [];
    }
  }
  if (run.length >= minLen) out.push({ start: run[0], end: run[run.length - 1], len: run.length });
  return out;
}

const fmt = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 星期几（按北京时间 UTC+8、无夏令时，直接用日期的 UTC 星期，避免宿主机时区漂移）。 */
export function weekdayOf(d: string): string {
  return WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
}

/**
 * 一句人话的交易日历说明（给 AI 注入 / 页面展示用），**带星期**——之前没带星期，
 * 模型只能自己猜，结果把 9/29 写成「周五」（实际周二）、9/30 写成「周六」（实际周三）。
 * 现在星期由这里确定性算出，模型照抄即可，不许再自己算。
 * 例：「接下来的交易日：9/29（周二）、9/30（周三）；10/1—10/7 国庆休市；10/8（周四）、10/9（周五）交易；10/10—10/11 周末休市；10/12（周一）交易」
 * 日历读不到时返回 null——调用方不许拿它编一句。
 */
export function tradeCalendarNote(from: string, horizon = 21): string | null {
  const ups = upcomingTradingDays(from, 6);
  if (!ups.length) return null;
  const hols = upcomingHolidayWindows(from, horizon);
  const tradeRun = (arr: string[], withTrade: boolean) =>
    arr.map((d) => `${fmt(d)}（${weekdayOf(d)}）${withTrade ? "交易" : ""}`).join("、");
  const segs: string[] = [];
  let ti = 0;
  let hi = 0;
  let first = true;
  while (ti < ups.length) {
    const nextHol = hols[hi];
    const runEnd = nextHol ? ups.findIndex((d) => d >= nextHol.start) : -1;
    const end = runEnd === -1 ? ups.length : runEnd;
    if (end > ti) {
      segs.push(tradeRun(ups.slice(ti, end), !first));
      ti = end;
      first = false;
    }
    if (nextHol && ti < ups.length && ups[ti] >= nextHol.start) {
      let label = "休市";
      // 国庆：覆盖 10/1–10/7（A 股国庆长假窗口）；其余纯周六日连休标「周末休市」
      if (nextHol.start <= "2026-10-07" && nextHol.end >= "2026-10-01") label = "国庆休市";
      else if (weekdayOf(nextHol.start) === "周六" && weekdayOf(nextHol.end) === "周日") label = "周末休市";
      segs.push(`${fmt(nextHol.start)}—${fmt(nextHol.end)} ${label}`);
      hi++;
      first = false;
    } else if (ti < ups.length) {
      segs.push(tradeRun(ups.slice(ti), !first));
      ti = ups.length;
    } else break;
  }
  return `接下来的交易日：${segs.join("；")}`;
}
