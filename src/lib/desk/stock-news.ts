// R10 扩容轮：个股自己的消息面（新闻 + 公告）与「公司名 → 代码」解析（服务层，带网络 IO）。
//
// 为什么单独一层：用户口径（2026-09-23）——「不光是开放数据，她要知道数据才行」：
// 谈一只票不能只有技术数字，得有这只票自己的新闻/公告；而用户说话用的是公司名
// （「中国电影卖的怎么样」），代码形状的识别（intent-core 纯层）拿不到标的。
// 本层两头都补：resolveStockName 用东财搜索把名字落成代码（搜不中不猜），
// fetchStockNews/fetchStockAnnouncements 走东财两家接口取个股消息面。
//
// 为什么不动 em.ts（不动清单）：em.ts 的 searchReal 已够用（搜索建议接口），import 复用即可；
// 个股新闻接口 getNewsByStock 实测已 404（2026-09-23 走查），换 search-api-web 的 cmsArticleWebOld
// 口径——与东财网页个股频道「相关新闻资讯」同一份数据源。
//
// 数据纪律（与 chat-tools 同口径）：
//  - 取数失败回 null（调用方转 {missing:原因}），不返回空数组冒充「没有消息」；
//  - 空数组只在「接口正常返回但确实没搜到」时出现，由调用方标注为「没搜到，不是失败」；
//  - 每条数据自带来源与时间，模型转述时拆不开出身。

/** 与 em.ts 同族的 JSONP/JSON 拉取：东财搜索接口必须带 cb 才回 JSONP 包装（无 cb 实测 400） */
async function fetchEmsJson<T = unknown>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.eastmoney.com/" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    // JSONP 剥离：x({...}) → {...}；纯 JSON 直接.parse
    const a = text.indexOf("(");
    const b = text.lastIndexOf(")");
    const body = a >= 0 && b > a ? text.slice(a + 1, b) : text;
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

// ---------- 公司名 → 代码（东财搜索建议，em.ts searchReal 复用） ----------

import { searchReal } from "./em";

export type NameMatchKind = "exact" | "prefix" | "suffix";

export interface ResolvedStock {
  symbol: string;   // 600977.SH 形态
  name: string;
  type: string;     // SecurityTypeName（沪A/深A/…）
  /** exact = 全称与候选名一字不差；prefix = 候选名是口语简称，唯一命中的全称以它开头；suffix = 砍掉一个组织形式词尾缀后再命中（R10c） */
  matchKind: NameMatchKind;
}

/**
 * 品牌叫法与上市主体全称的差常常就是一个组织形式词：用户说「长鑫存储」（品牌口径），
 * 上市主体叫「长鑫科技」（688825）。全查不中时允许砍掉这一个尾缀再查一次，
 * 且仍过同一道「唯一前缀命中」闸——「平安保险」砍成「平安」照样一票多义，不认。
 */
const ORG_SUFFIX = /(存储|科技|技术|电子|集团|控股|股份|公司)$/;

async function lookupStock(q: string): Promise<ResolvedStock | null> {
  const rows = await searchReal(q).catch(() => [] as Awaited<ReturnType<typeof searchReal>>);
  const stocks = rows.filter((r) => !/指数|基金|ETF|债|回购/.test(r.type));
  const exact = stocks.find((r) => r.name === q);
  if (exact) return { symbol: exact.symbol, name: exact.name, type: exact.type, matchKind: "exact" };
  const prefixed = stocks.filter((r) => r.name.startsWith(q));
  const only = prefixed.length === 1 ? prefixed[0] : null;
  return only ? { symbol: only.symbol, name: only.name, type: only.type, matchKind: "prefix" } : null;
}

/**
 * 按公司简称解析出场内代码。四条不放松（R10c 只加了两道「唯一」闸，不放宽「不猜」）：
 *  1) 名称全等优先；没有全等时允许「唯一前缀命中」——用户说简称（「长鑫」指上市主体「长鑫科技」，
 *     688825 已在 2026 年 7 月登陆科创板），只有一只票的全称以候选名开头才认；
 *     命中多只（「平安」对到平安银行/中国平安等一票）照样不认——简称能唯一命中，不许自由联想；
 *     全查不中再砍一个组织形式词尾缀重试一次（「长鑫存储」→「长鑫」→唯一命中，见 ORG_SUFFIX）；
 *  2) 排除指数/基金类同名品种（searchReal 已滤债/回购，这里再滤非个股）；
 *  3) 搜不到/没通就回 null，由调用方回 missing——纯层与模型都不许凭印象补代码；
 *  4) 解析失败只是「没匹配到代码」，不代表市场事实：3014 实测「那长鑫呢」被模型答成
 *     「长鑫存储当前无公开上市A股代码」——查不到 ≠ 不存在，话术闸见 intent-core 场景提示词与 chat 路由纪律 3。
 */
export async function resolveStockName(name: string): Promise<ResolvedStock | null> {
  const q = (name ?? "").trim();
  if (!q || !/[\u4e00-\u9fa5]/.test(q)) return null; // 纯代码形态不该走这条路
  const direct = await lookupStock(q);
  if (direct) return direct;
  const base = q.replace(ORG_SUFFIX, "");
  if (!base || base === q || base.length < 2) return null; // 没尾缀可砍 / 砍剩单字就不再试
  const rescued = await lookupStock(base);
  return rescued ? { ...rescued, matchKind: "suffix" } : null;
}

// ---------- 个股新闻（东财站内搜索，按时间倒序） ----------

export interface StockNewsRow {
  title: string;
  date: string;   // YYYY-MM-DD HH:mm:ss
  media: string;  // 财联社/证券时报…
  url: string;
}

/**
 * keyword 建议传公司名（报道正文里出现名字的远多于出现代码的）；只有代码时传 6 位代码也搜得到。
 * 返回 null＝接口失败；返回 []＝正常但时间窗内没搜到——两件事必须分开，模型不能把断源说成没消息。
 */
export async function fetchStockNews(keyword: string, limit = 6): Promise<StockNewsRow[] | null> {
  const kw = (keyword ?? "").trim();
  if (!kw) return null;
  const param = {
    uid: "", keyword: kw, type: ["cmsArticleWebOld"], client: "web", clientType: "web", clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "time", pageIndex: 1, pageSize: Math.min(10, Math.max(1, limit)), preTag: "", postTag: "" } },
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${encodeURIComponent(JSON.stringify(param))}`;
  const j = await fetchEmsJson<{ result?: { cmsArticleWebOld?: Record<string, string>[] } }>(url);
  const rows = j?.result?.cmsArticleWebOld;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, limit).map((r) => ({
    title: String(r.title ?? "").replace(/\s+/g, " ").trim(),
    date: String(r.date ?? ""),
    media: String(r.mediaName ?? "未署名"),
    url: String(r.url ?? ""),
  }));
}

// ---------- 个股公告（东财披露列表，沪深京通用） ----------

export interface StockAnnRow {
  title: string;
  time: string;    // display_time 截到分钟
  column: string;  // 栏目标签（调研活动/年度报告/…）
}

/**
 * 6 位代码查披露公告（实测走查：getNewsByStock 已 404，本接口稳定且带 column_name）。
 * 同样 null=失败、[]=确实没公告。
 */
export async function fetchStockAnnouncements(code6: string, limit = 5): Promise<StockAnnRow[] | null> {
  const code = (code6 ?? "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${Math.min(10, Math.max(1, limit))}&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
  const j = await fetchEmsJson<{ data?: { list?: Record<string, unknown>[] } }>(url);
  const list = j?.data?.list;
  if (!Array.isArray(list)) return null;
  return list.slice(0, limit).map((r) => ({
    title: String(r.title ?? ""),
    time: String(r.display_time ?? "").slice(0, 16),
    column: ((r.columns as { column_name?: string }[] | undefined)?.[0]?.column_name) ?? "",
  }));
}
