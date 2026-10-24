// 财联社电报（公开电报，非 VIP）：GET /v1/roll/get_roll_list + 签名。
//
// 只用公开电报接口，不碰 VIP 精选（280 读全文）等付费内容，不绕付费墙。
// 逆向来源：财联社电报页 JS（_app 里的 request 封装 + sign 模块 36498 + MD5 模块 81383 + SHA1 模块 37371）。
// 签名算法（已实测通过，errno=0）：
// 1) 参数先加 os=web、sv=8.7.9、app=CailianpressWeb；
// 2) 按 key 字母排序（JS 默认 sort，大小写敏感），拼成 key=value&key=value...；
// 3) sign = MD5(SHA1(拼好的字符串))，SHA1/MD5 均为 hex 小写。
// 实时性：单页原语 fetchClsTelegraphPage 每次拉 20 条（last_time 游标），不走长缓存，不用 /api/cache（返回空），
// 不用 /api/v1/telegraph（返回 50101）。需要全天时用 fetchClsDayWindow：以 last_time 游标往前分页翻到当日之前，
// 不是只取最新 20 条。
//
// 本模块只发请求 + 解析，不读 DB、不写库、不做映射；映射与入库仍走原有 events.ts 链路。

import { createHash} from "crypto";
import type { NewsRawRow} from "@/lib/quant/screener/news-window-core";

const CLS_BASE = "https://www.cls.cn";
const CLS_UA =
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 财联社 roll 接口的单条原样字段（只取解析用到的） */
export interface ClsRollItem {
id?: number | string;
ctime?: number; // Unix 秒（UTC）
title?: string;
content?: string;
brief?: string;
reading_num?: number;
subjects?: { subject_name?: string}[];
stock_list?: unknown[];
tags?: unknown[];
}

interface ClsRollResp {
errno?: number;
msg?: string;
data?: { roll_data?: ClsRollItem[]};
}

/** 签名：MD5(SHA1(按 key 排序后的 key=value&...))。参数只含字符串/数字，无数组/对象，故简化为 key=String(value)。 */
export function clsSign(params: Record<string, string | number>): string {
const keys = Object.keys(params).sort();
const s = keys.map((k) => `${k}=${String(params[k])}`).join("&");
const sha1 = createHash("sha1").update(s, "utf8").digest("hex");
return createHash("md5").update(sha1, "utf8").digest("hex");
}

/** ctime（Unix 秒，UTC）→ 上海时区 "YYYY-MM-DD HH:MM:SS"（ts+8h，与 A 股交易日对齐） */
export function clsShanghaiShowTime(ctime: number): string {
const d = new Date((ctime + 8 * 3600) * 1000);
const pad = (n: number) => String(n).padStart(2, "0");
return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
* 标题提取：财联社电报的 title 经常为空，标题在 content 里。
* content 形如“财联社10月16日电，正文...”或“财联社10月16日电，正文...”。
* 规则：title 非空用 title；否则优先用 内的标题；否则去掉“财联社MM月DD日电，”前缀后截前 30 字。
*/
export function clsTitleOf(item: ClsRollItem): string {
const t = String(item.title?? "").trim();
if (t) return t;
const content = String(item.content?? item.brief?? "").trim();
const bracket = content.match(/\u3010([^\u3011]{1,60})\u3011/);
if (bracket) return bracket[1].trim();
const body = content.replace(/^财联社\d+月\d+日电[，,]\s*/, "");
return body.slice(0, 30).trim();
}

/** 全标题（供 AI 喂新闻用）：与 clsTitleOf 同逻辑，但不截成 30 字（30 字会把“于10月1…”截断成半句），截 120 字。 */
export function clsFullTitleOf(item: ClsRollItem): string {
  const t = String(item.title ?? "").trim();
  if (t) return t;
  const content = String(item.content ?? item.brief ?? "").trim();
  const bracket = content.match(/\u3010([^\u3011]{1,60})\u3011/);
  if (bracket) return bracket[1].trim();
  const body = content.replace(/^财联社\d+月\d+日电[，,]\s*/, "");
  return body.slice(0, 120).trim();
}
export async function fetchClsTelegraphPage(lastTime: number, rn = 20): Promise<ClsRollItem[]> {
const params: Record<string, string | number> = {
refresh_type: 1,
rn,
last_time: lastTime,
os: "web",
sv: "8.7.9",
app: "CailianpressWeb",
};
const sign = clsSign(params);
const qs = new URLSearchParams({...params, sign} as Record<string, string>).toString();
const url = `${CLS_BASE}/v1/roll/get_roll_list?${qs}`;
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 8000);
try {
const res = await fetch(url, {
headers: { "User-Agent": CLS_UA, Referer: "https://www.cls.cn/telegraph", Accept: "application/json, text/plain, */*"},
signal: ctrl.signal,
cache: "no-store",
});
if (!res.ok) throw new Error(`财联社电报 HTTP ${res.status}`);
const j = (await res.json()) as ClsRollResp;
if (j?.errno!== 0) throw new Error(`财联社电报 errno=${j?.errno} msg=${j?.msg?? ""}`);
return j?.data?.roll_data?? [];
} finally {
clearTimeout(timer);
}
}

/** 把一页电报解析成 NewsRawRow（与东财/新浪同一形状，供 news-window-core 的 pickNewsWindow 复用）。 */
export function clsToNewsRows(items: ClsRollItem[]): NewsRawRow[] {
const rows: NewsRawRow[] = [];
for (const it of items) {
const ctime = Number(it.ctime);
if (!Number.isFinite(ctime) || ctime <= 0) continue;
const title = clsTitleOf(it);
if (!title) continue;
rows.push({
code: String(it.id?? ""),
showTime: clsShanghaiShowTime(ctime),
realSort: String(ctime),
title,
});
}
return rows;
}

export interface ClsDayItem {
  /** 原标题（逐字，不改写） */
  title: string;
  /** 上海时区 "YYYY-MM-DD HH:MM:SS" */
  time: string;
  /** 正文（用于关键词匹配；可能为空） */
  content: string;
}

export interface ClsDayWindow {
  items: ClsDayItem[];
  /** 分页实际拉到的原始行数（含越界/重复/丢弃，供调用方如实说明“这一轮看了多少条电报”） */
  fetchedRows: number;
  /** ctime 落在目标日之外的条数（翻页越界，正常） */
  offDay: number;
  /** 跨页撞 id 被合并的条数 */
  duplicated: number;
  /** ctime 认不出 / 标题为空而丢弃的条数 */
  dropped: number;
  /** true = 翻到 80 页上限仍未翻到目标日之前，全天窗口可能不完整，调用方须如实说明 */
  capped: boolean;
}

/**
 * 分页拉回指定交易日（上海时区）全天的财联社电报，附计数。
 * 原理：last_time 游标往前翻（下一页 last_time = 本页最小 ctime - 1），
 * 直到翻到早于目标日 00:00 为止；只保留上海日期 == tradeDate 的条目。
 * 失败抛错（调用方据此写“未取到”，不拿空数组冒充“当日无新闻”）。
 * 注意：只拉历史/当日全天，不拿今天的新闻当昨天的——调用方必须传决策日，
 * 绝不能把其它日期的新闻喂给该日的 AI 优选（那是未来数据 / 穿越）。
 */
export async function fetchClsDayWindow(tradeDate: string): Promise<ClsDayWindow> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`bad tradeDate ${tradeDate}`);
  const dayStart = Date.parse(`${tradeDate}T00:00:00+08:00`) / 1000;
  const dayEnd = Date.parse(`${tradeDate}T23:59:59+08:00`) / 1000;
  const out: ClsDayItem[] = [];
  const seen = new Set<string>();
  let fetchedRows = 0;
  let offDay = 0;
  let duplicated = 0;
  let dropped = 0;
  let reachedBeforeDay = false;
  let pagesRun = 0;
  let lastTime = dayEnd;
  for (let page = 0; page < 80; page++) {
    const items = await fetchClsTelegraphPage(lastTime, 20);
    pagesRun = page + 1;
    if (!items.length) break;
    let minCtime = Infinity;
    let anyInDay = false;
    for (const it of items) {
      fetchedRows++;
      const ctime = Number(it.ctime);
      if (!Number.isFinite(ctime) || ctime <= 0) { dropped++; continue; }
      if (ctime < minCtime) minCtime = ctime;
      if (ctime < dayStart || ctime > dayEnd) { offDay++; continue; }
      anyInDay = true;
      const id = String(it.id ?? `${ctime}-${clsTitleOf(it)}`);
      if (seen.has(id)) { duplicated++; continue; }
      seen.add(id);
      const title = clsFullTitleOf(it);
      if (!title) { dropped++; continue; }
      out.push({ title, time: clsShanghaiShowTime(ctime), content: String(it.content ?? it.brief ?? "") });
    }
    if (!anyInDay && minCtime < dayStart) { reachedBeforeDay = true; break; }
    if (!Number.isFinite(minCtime) || minCtime <= dayStart) {
      // minCtime <= dayStart：已翻到当日 00:00 边界（含恰好等于），窗口完整，不算 capped
      if (minCtime <= dayStart) reachedBeforeDay = true;
      break;
    }
    lastTime = minCtime - 1;
    if (items.length < 20) {
      // 最后一页不足 20 条：若已翻到当日之前可停；否则继续（服务端可能还有更早的）
      if (minCtime < dayStart) { reachedBeforeDay = true; break; }
    }
  }
  // 新→旧排序（与电报页一致）
  out.sort((a, b) => (a.time < b.time ? 1 : -1));
  return {
    items: out,
    fetchedRows,
    offDay,
    duplicated,
    dropped,
    capped: pagesRun >= 80 && !reachedBeforeDay,
  };
}

/**
 * 分页拉回指定交易日（上海时区）全天的财联社电报（仅条目，计数版见 fetchClsDayWindow）。
 * 与 fetchClsDayWindow 同一实现，不各自漂移。
 */
export async function fetchClsDayItems(tradeDate: string): Promise<ClsDayItem[]> {
  return (await fetchClsDayWindow(tradeDate)).items;
}
