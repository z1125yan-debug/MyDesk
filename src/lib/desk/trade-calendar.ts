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

/**
 * 一句人话的交易日历说明（给 AI 注入 / 页面展示用）。
 * 例：「接下来的交易日：9/28、9/29、9/30、10/8、10/9；10/1–10/7 休市，10/8 复市」
 * 日历读不到时返回 null——调用方不许拿它编一句。
 */
export function tradeCalendarNote(from: string, horizon = 21): string | null {
  const ups = upcomingTradingDays(from, 5);
  if (!ups.length) return null;
  const parts: string[] = [`接下来的交易日：${ups.map(fmt).join("、")}`];
  for (const h of upcomingHolidayWindows(from, horizon)) {
    const after = upcomingTradingDays(h.end, 1)[0];
    parts.push(`${fmt(h.start)}–${fmt(h.end)} 休市${after ? `，${fmt(after)} 复市` : ""}`);
  }
  return parts.join("；");
}
