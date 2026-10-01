// MyDesk 本地行情数据层（仅服务端使用）
// 数据来源：通达信 eltdx 网关（主）→ 腾讯行情（qt.gtimg.cn）→ 东方财富公开接口，
// 全部由本机直连请求。仅供个人本地参考，行情可能有延迟，不构成投资建议。

import fs from "fs";
import path from "path";
import { marketSessionHolidayAware, shanghaiDate } from "./session";
import { tdxQuotes, tdxKlines, tdxNameOf, type TdxQuote } from "./tdx";
import { parseTcBoardRankList } from "@/lib/quant/data/tc-snapshot-core";
import { parseSinaFundFlow, sinaFundFlowUrl } from "@/lib/quant/data/sina-flow-core";
import {
  NEWS_MAX_PAGES, NEWS_MAX_PAGES_MULTI, NEWS_PAGE_SIZE, lastCursor, pickNewsDays, pickNewsWindow,
  shouldFetchMore, shouldFetchMoreUntil,
  type NewsLiteRow, type NewsRawRow,
} from "@/lib/quant/screener/news-window-core";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- 通用抓取（带超时；腾讯行情为 GBK 编码需手动解码） ----------

async function fetchRaw(url: string, timeoutMs = 5000): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function fetchJson<T = unknown>(url: string, timeoutMs = 5000): Promise<T> {
  return fetchRaw(url, timeoutMs).then(
    (buf) => JSON.parse(new TextDecoder("utf-8").decode(buf)) as T,
  );
}

function fetchGbk(url: string, timeoutMs = 5000): Promise<string> {
  return fetchRaw(url, timeoutMs).then((buf) => new TextDecoder("gbk").decode(buf));
}

// ---------- 简单 TTL 缓存：避免刷新过快触发数据源限流 ----------

const cache = new Map<string, { at: number; data: unknown }>();
// 日K限流系统性缓解（P38 复检 #5）：kline TTL 从 20s 提到 180s——日/周/月 K 历史 bar 是静态的
// （只有末根在盘内变化），3 分钟滞后对研报/情绪足够；闭市再 ×20 → 1h。磁盘缓存另见 klineDisk*。
const TTL: Record<string, number> = { search: 300, quote: 15, kline: 180, board: 30, detail: 30, news: 90 };

// 日K 限流系统性缓解（P38 复检 #5）之磁盘复用：腾讯 fqkline 对单 IP 容易限流，而日/周/月 K 历史 bar 当天不变。
// 内存未命中时先查磁盘：日线按北京时间自然日留盘（当天有效），分钟线按 TTL（180s）兜底重启；
// 命中即返、根本不碰源。任何 fs 异常都静默忽略，回退到网络。
const KL_CACHE_DIR = path.join(process.cwd(), "data", "kline-cache");
function klCacheFile(key: string): string {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(KL_CACHE_DIR, `${safe}.json`);
}
function klineDiskRead<T>(key: string): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(klCacheFile(key), "utf-8")) as { at?: number; day?: string; data?: T };
    if (key.includes(":mk:")) {
      if (typeof raw.at !== "number" || Date.now() - raw.at >= 180_000) return null;
    } else if (raw.day !== shanghaiDate()) {
      return null; // 日/周/月：跨自然日失效，重抓
    }
    return (raw.data ?? null) as T | null;
  } catch {
    return null;
  }
}
function klineDiskWrite<T>(key: string, data: T): void {
  try {
    fs.mkdirSync(KL_CACHE_DIR, { recursive: true });
    fs.writeFileSync(klCacheFile(key), JSON.stringify({ at: Date.now(), day: shanghaiDate(), data }), "utf-8");
  } catch { /* 落盘失败不阻断：下次命中网络即可 */ }
}

async function cached<T>(kind: string, key: string, fn: () => Promise<T>): Promise<T> {
  const k = `${kind}:${key}`;
  // 非交易时段（含法定节假日）上游不会有新数据：行情类缓存延长 20 倍，避免客户端轮询造成无意义请求
  const closed = !marketSessionHolidayAware().open && kind !== "news";
  const ttl = (TTL[kind] ?? 30) * (closed ? 20 : 1) * 1000;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  // 日K 限流缓解：内存未命中时先查磁盘（日线按自然日、分钟线按 TTL），命中即返、不碰源
  if (kind === "kline") {
    const disk = klineDiskRead<T>(key);
    if (disk !== null) {
      cache.set(k, { at: Date.now(), data: disk });
      if (cache.size > 800) { const first = cache.keys().next().value; if (first) cache.delete(first); }
      return disk;
    }
  }
  const data = await fn();
  cache.set(k, { at: Date.now(), data });
  if (cache.size > 800) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  if (kind === "kline") void klineDiskWrite(key, data);
  return data;
}

// ---------- 符号映射 ----------
// MyDesk 符号约定：688256.SH / 000001.SZ / 000001.SH=上证指数 / 920819.BJ / 板块=90.BKxxxx

export function symbolToSecid(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (/^\d{6}\.SH$/.test(s)) return `1.${s.slice(0, 6)}`;
  if (/^\d{6}\.(SZ|BJ)$/.test(s)) return `0.${s.slice(0, 6)}`;
  if (/^90\.BK\d+$/.test(s)) return s;
  return null;
}

function symbolToTencent(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(s);
  if (!m) return null;
  return `${m[2].toLowerCase()}${m[1]}`;
}

// ---------- 实时报价（腾讯批量接口） ----------

export interface RealQuote {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  high?: number;
  low?: number;
  prevClose?: number;
  amountYi?: number; // 成交额（亿）
  time?: string;
}

export async function fetchQuotesReal(symbols: string[]): Promise<(RealQuote | null)[]> {
  const out: (RealQuote | null)[] = symbols.map(() => null);

  // 1) 通达信网关优先（本机 eltdx-http，见 tdx.ts；未启动时静默跳过）
  const tdx = await tdxQuotes(symbols).catch(() => null);
  if (tdx) {
    const filled: number[] = [];
    for (let i = 0; i < symbols.length; i++) {
      const q: TdxQuote | undefined = tdx.get(symbols[i]);
      if (!q) continue;
      filled.push(i);
      out[i] = {
        symbol: q.symbol,
        name: "",
        price: q.price,
        changePct: q.changePct,
        high: q.high,
        low: q.low,
        prevClose: q.prevClose,
        amountYi: q.amountYi,
      };
    }
    // 名称表从通达信代码表加载（进程内缓存 24h），失败则由腾讯兜底补
    const names = await Promise.all(
      filled.map((i) => tdxNameOf(symbols[i]).catch(() => null)),
    );
    names.forEach((nm, k) => {
      const i = filled[k];
      if (nm && out[i]) out[i]!.name = nm;
    });
  }

  // 2) 腾讯兜底：只补 TDX 没取到的符号（顺带补全缺失名称）
  const pairs = symbols
    .map((s, i) => ({ s, i, tc: symbolToTencent(s) }))
    .filter((p): p is { s: string; i: number; tc: string } => Boolean(p.tc) && (!out[p.i] || !out[p.i]!.name));
  if (!pairs.length) return out;
  try {
    const raw = await cached(
      "quote",
      pairs.map((p) => p.tc).join(","),
      () => fetchGbk(`https://qt.gtimg.cn/q=${pairs.map((p) => p.tc).join(",")}`),
    );
    const lines = new Map<string, string>();
    for (const line of raw.split(";")) {
      const m = /v_((?:sh|sz|bj)\d+)="([^"]*)"/.exec(line);
      if (m) lines.set(m[1], m[2]);
    }
    for (const p of pairs) {
      const body = lines.get(p.tc);
      if (!body) continue;
      const f = body.split("~");
      if (f.length < 35) continue;
      const price = parseFloat(f[3]);
      const changePct = parseFloat(f[32]);
      if (!isFinite(price) || price <= 0) continue;
      const cur = out[p.i];
      if (cur && cur.name) continue; // TDX 已给出完整数据，腾讯仅作名称兜底
      const amtM = /\/(\d+)$/.exec(f[35] ?? "");
      const base: RealQuote = cur ?? {
        symbol: p.s,
        name: "",
        price,
        changePct: isFinite(changePct) ? changePct : 0,
        high: parseFloat(f[33]) || undefined,
        low: parseFloat(f[34]) || undefined,
        prevClose: parseFloat(f[4]) || undefined,
        amountYi: amtM ? parseFloat(amtM[1]) / 1e8 : undefined,
        time: /^\d{14}$/.test(f[30] ?? "")
          ? `${f[30].slice(4, 6)}-${f[30].slice(6, 8)} ${f[30].slice(8, 10)}:${f[30].slice(10, 12)}`
          : undefined,
      };
      out[p.i] = { ...base, name: base.name || f[1] || p.s };
    }
  } catch {
    // 数据源不可用：保持 null，由上层回退演示数据
  }
  return out;
}

// ---------- 搜索（东财 suggest，支持代码/名称/拼音缩写，覆盖沪深京全部 A 股） ----------

export interface SuggestItem {
  symbol: string;
  name: string;
  secid: string;
  type: string;
}

export async function searchReal(q: string): Promise<SuggestItem[]> {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12`;
  const j = await cached<{ QuotationCodeTable?: { Data?: Record<string, string>[] } }>("search", q, () =>
    fetchJson(url),
  );
  const rows = j?.QuotationCodeTable?.Data ?? [];
  const out: SuggestItem[] = [];
  for (const r of rows) {
    const secid = String(r.QuoteID ?? "");
    const mkt = secid.split(".")[0];
    if (mkt !== "0" && mkt !== "1") continue; // 仅保留沪深京场内品种
    const typeName = String(r.SecurityTypeName ?? "");
    if (/债|回购/.test(typeName)) continue;
    const suffix = mkt === "1" ? "SH" : /京/.test(typeName) ? "BJ" : "SZ";
    out.push({
      symbol: `${r.Code}.${suffix}`,
      name: String(r.Name ?? ""),
      secid,
      type: typeName || "A股",
    });
  }
  return out.slice(0, 10);
}

// ---------- K 线（腾讯，前复权；分钟线走 mkline，日/周/月走 fqkline） ----------
// 腾讯 K 线数组顺序: [日期, 开, 收, 高, 低, 量]

export interface RealCandle {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

const MINUTE_TF: Record<string, [string, number]> = {
  "1分": ["m1", 240], "5分": ["m5", 320], "15分": ["m15", 320],
  "30分": ["m30", 320], "60分": ["m60", 320],
};

export async function fetchKlinesReal(symbol: string, tf: string, lmt = 160, fq = "qfq"): Promise<RealCandle[] | null> {
  const tc = symbolToTencent(symbol);
  if (!tc) return null;
  // 1) 通达信网关优先（未启动时静默回退腾讯）。只有默认「前复权」才走网关——
  //    网关给的是原始行情，后复权/不复权由腾讯 fqkline 提供，口径不能混。
  if (fq === "qfq") {
    const tdx = await tdxKlines(symbol, tf, lmt).catch(() => null);
    if (tdx && tdx.length > 10) return tdx.slice(-lmt);
  }
  // 2) 腾讯兜底
  try {
    let rows: string[][];
    if (MINUTE_TF[tf]) {
      const [per, count] = MINUTE_TF[tf];
      const j = await cached<{ data?: Record<string, Record<string, string[][]>> }>(
        "kline", `${tc}:mk:${tf}`,
        () => fetchJson(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tc},${per},,${count}`),
      );
      rows = j?.data?.[tc]?.[per] ?? [];
    } else {
      const per = tf === "周线" ? "week" : tf === "月线" ? "month" : "day";
      const count = tf === "日线" ? 160 : 120;
      // 复权口径：qfq 前复权 / hfq 后复权 / none 不复权（腾讯 fqkline 末段参数；空串=不复权）
      const fqParam = fq === "hfq" ? "hfq" : fq === "none" ? "" : "qfq";
      const j = await cached<{ data?: Record<string, Record<string, string[][]>> }>(
        "kline", `${tc}:${per}:${fqParam || "none"}`,
        () => fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},${per},,,${count},${fqParam}`),
      );
      const d = j?.data?.[tc] ?? {};
      rows = d[`${fqParam}${per}`] ?? d[per] ?? [];
    }
    if (!rows.length) return null;
    return rows
      .slice(-lmt)
      .map((p) => ({
        date: p[0],
        o: +p[1], c: +p[2], h: +p[3], l: +p[4],
      }))
      .filter((k) => isFinite(k.o) && isFinite(k.c) && isFinite(k.h) && isFinite(k.l));
  } catch {
    return null;
  }
}

// ---------- 板块/个股资金排行（东财 clist，按主力净额 f62 排序；delay 镜像优先） ----------

const BOARD_FS: Record<string, string> = {
  stock: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048", // 沪深京 A 股
  industry: "m:90+t:2",
  concept: "m:90+t:3",
  region: "m:90+t:1",
};

// push2 主站可能对个别 IP 限流，delay 镜像（约延迟一刻钟）作为首选兜底；
// fflow 历史明细只在 push2his 上提供完整区间，单独用一组主机。
const EM_HOSTS = ["https://push2delay.eastmoney.com", "https://push2.eastmoney.com"];
const EM_HIS_HOSTS = ["https://push2his.eastmoney.com", "https://push2delay.eastmoney.com"];

async function emGet<T>(path: string, timeoutMs = 5000, hosts: string[] = EM_HOSTS): Promise<T> {
  let lastErr: unknown = new Error("no host");
  for (const host of hosts) {
    try {
      return await fetchJson<T>(host + path, timeoutMs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export interface BoardRow {
  code: string;
  secid: string;
  name: string;
  changePct: number;
  main: number; // 主力净额（亿）
  ratio: number; // 主力净占比 %
  superBig: number; // 超大单（亿）
  big: number; // 大单（亿）
  leader: string; // 板块=领涨股；个股=所属行业
  /** 腾讯板块兜底榜只有涨幅口径，main/ratio/superBig/big 均为占位 0 —— 页面必须据此显示「—」而不是 0.00 */
  fundsMissing?: boolean;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : null;
}

// ---------- 行业板块兜底（东财 push2 断源时；腾讯板块榜只有涨幅口径，无主力资金读数） ----------

export async function fetchTcIndustryBoard(dir: "in" | "out", size = 30): Promise<BoardRow[] | null> {
  try {
    const path = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=${Math.min(Math.max(size, 10), 200)}&p=1&t=01/averatio`;
    const j = await cached<{ data?: Record<string, unknown>[] }>("board", `tc:${dir}:${size}`, () => fetchJson(path));
    const rows = parseTcBoardRankList((j?.data ?? []) as Record<string, unknown>[], dir);
    return rows.length
      ? rows.map((b) => ({
          code: b.code,
          secid: "", // 腾讯板块代码（pt…）没有东财 secid 口径，留空：日K/资金明细自然走「无数据」分支而不是错源
          name: b.name,
          changePct: b.changePct,
          main: 0,
          ratio: 0,
          superBig: 0,
          big: 0,
          leader: b.leader,
          fundsMissing: true,
        }))
      : null;
  } catch {
    return null;
  }
}

export async function fetchBoardReal(
  kind: "stock" | "industry" | "concept" | "region",
  dir: "in" | "out",
  size = 30,
): Promise<BoardRow[] | null> {
  const fs = BOARD_FS[kind] ?? BOARD_FS.industry;
  const po = dir === "in" ? 1 : 0;
  const path = `/api/qt/clist/get?pn=1&pz=${size}&po=${po}&np=1&fltt=2&invt=2&fid=f62&fs=${encodeURIComponent(fs)}&fields=f12,f13,f14,f2,f3,f62,f66,f72,f100,f128,f184`;
  try {
    const j = await cached<{ data?: { diff?: Record<string, unknown>[] } }>("board", `${kind}:${dir}`, () =>
      emGet(path),
    );
    const rows = j?.data?.diff ?? [];
    const out: BoardRow[] = [];
    for (const d of rows) {
      const main = num(d.f62);
      if (main === null) continue;
      if (dir === "in" ? main <= 0 : main >= 0) continue;
      const isBoard = kind !== "stock";
      out.push({
        code: String(d.f12 ?? ""),
        secid: isBoard ? `90.${d.f12}` : `${d.f13}.${d.f12}`,
        name: String(d.f14 ?? ""),
        changePct: num(d.f3) ?? 0,
        main: main / 1e8,
        ratio: num(d.f184) ?? 0,
        superBig: (num(d.f66) ?? 0) / 1e8,
        big: (num(d.f72) ?? 0) / 1e8,
        leader: String((isBoard ? d.f128 : d.f100) ?? ""),
      });
    }
    return out;
  } catch {
    // 东财 clist 断源（拒连/超时）：行业板块换腾讯涨幅榜兜底（概念/个股板块暂无对等兜底）
    if (kind === "industry") return fetchTcIndustryBoard(dir, size);
    return null;
  }
}

// ---------- 明细：近 14 日主力净额（东财 fflow，断源时新浪 MoneyFlow 备胎） ----------

export interface DetailReal {
  spark: number[];
  days: { date: string; value: number }[];
  /** 读数出身（三元之一必给）：sina 那条是新浪日度净额口径（≈主力净流入），与东财 f62 不完全等价，
   *  消费处（个股档案/对话工具/能力探测）必须按它如实标源，不许拿「东财主力净额」的名头转述。 */
  source: "em" | "sina";
}

export async function fetchDetailReal(secid: string): Promise<DetailReal | null> {
  // 整条兜底链一起进 TTL 缓存：断源期间两边都打不通时，缓存 null 就是限流保护（失败也短存，
  // 恢复后最多 30s 就回到实时）。
  return cached<DetailReal | null>("detail", `f:${secid}`, async () => {
    const fPath = `/api/qt/stock/fflow/daykline/get?lmt=14&klt=101&secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52`;
    try {
      const fj = await emGet<{ data?: { klines?: string[] } }>(fPath, 5000, EM_HIS_HOSTS);
      const days = (fj?.data?.klines ?? [])
        .map((s) => {
          const p = s.split(",");
          return { date: p[0], value: parseFloat(p[1]) / 1e8 };
        })
        .filter((d) => isFinite(d.value));
      if (days.length) return { spark: [], days, source: "em" };
    } catch {
      // 东财 push2his 断连/超时：往下走新浪备胎，不在这里吞掉也不谎称失败
    }
    // P9 备胎轮：新浪日度净额（a-stock-data 验证过的端点，直连不封 IP）。
    // 板块码（90.BKxxxx）与认不出的 secid 在 sinaFundFlowUrl 处返回 null——新浪没有板块资金流对应物，不硬凑。
    const url = sinaFundFlowUrl(secid.split(".").pop() ?? "", 14);
    if (!url) return null;
    try {
      const days = parseSinaFundFlow(await fetchJson<unknown>(url));
      return days.length ? { spark: [], days: days.map((d) => ({ date: d.date, value: d.netYi })), source: "sina" as const } : null;
    } catch {
      return null;
    }
  });
}

// 自选卡片用的日内分时缩略序列（腾讯分时）
export async function fetchSparkReal(symbol: string): Promise<number[] | null> {
  const tc = symbolToTencent(symbol);
  if (!tc) return null;
  try {
    const j = await cached<{ data?: Record<string, { data?: { data?: string[] } }> }>(
      "detail", `min:${tc}`,
      () => fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tc}`),
    );
    const arr = j?.data?.[tc]?.data?.data ?? [];
    const out = arr
      .map((s) => parseFloat(s.split(" ")[1]))
      .filter((v) => isFinite(v));
    return out.length > 4 ? out : null;
  } catch {
    return null;
  }
}

// ---------- 财经快讯（东财 7x24 优先，新浪财经直播兜底） ----------

export interface NewsItem {
  time: string;
  title: string;
}

export async function fetchNewsReal(limit = 12): Promise<NewsItem[] | null> {
  // 东财 7x24 全球快讯
  try {
    const url = `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=${limit}&req_trace=${Date.now()}`;
    const j = await cached<{ data?: { fastNewsList?: { showTime?: string; title?: string }[] } }>("news", "em", () =>
      fetchJson(url),
    );
    const rows = j?.data?.fastNewsList ?? [];
    const out = rows
      .map((r) => ({ time: String(r.showTime ?? "").slice(11, 16), title: String(r.title ?? "").trim() }))
      .filter((r) => r.title);
    if (out.length) return out.slice(0, limit);
  } catch {
    // 换新浪
  }
  // 新浪财经直播（兜底）
  try {
    const url = `https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=${limit}&zhibo_id=152&tag_id=0&dire=f&dpc=1`;
    const j = await cached<{ result?: { data?: { feed?: { list?: { rich_text?: string; create_time?: string }[] } } } }>("news", "sina", () =>
      fetchJson(url),
    );
    const rows = j?.result?.data?.feed?.list ?? [];
    const out = rows
      .map((r) => {
        const mm = String(r.create_time ?? "").match(/\d{2}:\d{2}/);
        return { time: mm ? mm[0] : "", title: String(r.rich_text ?? "").trim() };
      })
      .filter((r) => r.title);
    return out.length ? out.slice(0, limit) : null;
  } catch {
    return null;
  }
}

// ---------- 当日快讯全量窗口（P15-R18） ----------
// 事件雷达以前只吃 fetchNewsReal(24)：东财 7x24 一小时就发几十条，一次日内扫描看得见的时间跨度
// 只有约 20 分钟，一天下来库里只剩一两条事件。这里改成按 realSort 游标往前翻页，翻到跨出目标交易日为止，
// 「翻到哪算完 / 同日过滤 / 跨页去重 / 坏行丢弃」全部由 news-window-core 判定，本层只发请求。
// 取不到仍然如实返回 null（由 collectNews 抛错），不静默当成「今天没有事件」。

export interface NewsWindow {
  tradeDate: string;
  items: NewsLiteRow[];
  source: "东财7x24" | "新浪直播";
  /** 翻页实际拉到的原始行数（含越界与丢弃），用于说明「这一轮看了多少条快讯」 */
  fetchedRows: number;
  offDay: number;
  duplicated: number;
  dropped: number;
  /** 窗口覆盖的时间跨度（上游原样给的时分，新→旧）；空数组时为空串 */
  spanFrom: string;
  spanTo: string;
  /** 是否翻到了上限还没跨日（真发生时要如实说明「当日窗口可能不完整」） */
  capped: boolean;
}

type NewsPageFn = (cursor: string, pageNo: number) => Promise<NewsRawRow[]>;

/** 翻页循环本体：什么时候停由核给的 shouldMore 说了算，本层不拍脑袋；游标不前进也停（防上游回同一页造成无限翻） */
async function pageLoop(
  maxPages: number,
  shouldMore: (rows: NewsRawRow[]) => boolean,
  getPage: NewsPageFn,
): Promise<{ pages: NewsRawRow[][]; pagesFetched: number; capped: boolean }> {
  const pages: NewsRawRow[][] = [];
  let cursor = "";
  let capped = false;
  for (let i = 0; i < maxPages; i++) {
    const rows = await getPage(cursor, i + 1);
    if (!rows.length) break;
    pages.push(rows);
    if (!shouldMore(rows)) break;
    const next = lastCursor(rows);
    if (next && next === cursor) break;
    cursor = next;
    if (i === maxPages - 1) capped = true; // 核说还要翻，但页数预算用完了 → 如实标 capped
  }
  return { pages, pagesFetched: pages.length, capped };
}

/** 单日（日内实时扫描）：翻到跨出目标日为止 */
async function pageThrough(tradeDate: string, getPage: NewsPageFn) {
  return pageLoop(NEWS_MAX_PAGES, (rows) => shouldFetchMore(rows, tradeDate), getPage);
}

/** 区间（研报要的「最近 N 个交易日」）：翻到早于区间最早一天为止 */
async function pageThroughUntil(oldestDate: string, getPage: NewsPageFn) {
  return pageLoop(NEWS_MAX_PAGES_MULTI, (rows) => shouldFetchMoreUntil(rows, oldestDate), getPage);
}

async function emNewsPage(cursor: string): Promise<NewsRawRow[]> {
  const url = `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=${cursor}&pageSize=${NEWS_PAGE_SIZE}&req_trace=${Date.now()}`;
  const j = await fetchJson<{
    data?: { fastNewsList?: { code?: string; showTime?: string; realSort?: string; title?: string }[] };
  }>(url);
  return (j?.data?.fastNewsList ?? []).map((r) => ({
    code: String(r.code ?? ""),
    showTime: String(r.showTime ?? ""),
    realSort: String(r.realSort ?? ""),
    title: String(r.title ?? "").trim(),
  }));
}

async function sinaNewsPage(_cursor: string, pageNo: number): Promise<NewsRawRow[]> {
  const url = `https://zhibo.sina.com.cn/api/zhibo/feed?page=${pageNo}&page_size=${NEWS_PAGE_SIZE}&zhibo_id=152&tag_id=0&dire=f&dpc=1`;
  const j = await fetchJson<{
    result?: { data?: { feed?: { list?: { id?: number | string; create_time?: string; rich_text?: string }[] } } };
  }>(url);
  return (j?.result?.data?.feed?.list ?? []).map((r) => ({
    code: String(r.id ?? ""),
    showTime: String(r.create_time ?? ""),
    realSort: "", // 新浪这条按 page 翻页，没有游标——空串让上层循环走 pageNo 分支
    title: String(r.rich_text ?? "").trim(),
  }));
}

/** 翻某一源到跨出目标日为止，收成窗口（不带缓存，由调用方 cached 包一层） */
async function buildNewsWindow(tradeDate: string, getPage: NewsPageFn, source: NewsWindow["source"]): Promise<NewsWindow | null> {
  const { pages, capped } = await pageThrough(tradeDate, getPage);
  const w = pickNewsWindow(pages, tradeDate);
  if (!w.items.length) return null;
  return {
    tradeDate,
    items: w.items,
    source,
    fetchedRows: w.fetchedRows,
    offDay: w.offDay,
    duplicated: w.duplicated,
    dropped: w.dropped,
    spanFrom: w.items[0]?.time ?? "",
    spanTo: w.items[w.items.length - 1]?.time ?? "",
    capped,
  };
}

/** 当日快讯全量窗口：东财 7x24 优先，失败/为空换新浪直播；两源都空返回 null（调用方据此报错，不当成「今天没事件」） */
export async function fetchNewsWindowForDate(tradeDate: string): Promise<NewsWindow | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null;
  return cached("news", `day:${tradeDate}`, async () => {
    try {
      const em = await buildNewsWindow(tradeDate, emNewsPage, "东财7x24");
      if (em) return em;
    } catch {
      // 换新浪
    }
    try {
      return await buildNewsWindow(tradeDate, sinaNewsPage, "新浪直播");
    } catch {
      return null;
    }
  });
}

// ---------- 多日快讯池（P65：研报「关联新闻」的口径修正） ----------
// 起因：拿稳智的研报对了一遍口径 —— 它那条「涨价链与周期出清反内卷」的关联新闻写的是
// 「快递单票价格同比+4%…玻纤电子布连续5个月提价…钢铁三重底部…粮食库销比历史低位」。
// 实测东财 7x24 最近 14 天 8000 条里：「快递单票」0 命中，而 09-20/09-21 有
// 「快递“反内卷”引发新一轮涨价 多家公司今起安徽区域单票最低上调0.15元」；「制冷剂」「钽精矿」「库销比」「三重底部」全部 0 命中。
// → 它那一栏既不是当日快讯，也不是逐字标题，而是**跨多日、按主题聚合后被模型改写的证据短句**。
// 我们只借这个「多日窗口」的口径（当日快讯挂不住一条主线是真问题：单日 760 条里与某主线相关的常常只有个位数），
// 不借它「改写数字」的写法：本层往下给到模型的永远是带日期的原标题，正文只许逐字照抄。

export interface NewsDaysWindow {
  /** 请求的目标交易日（原样回显，新→旧） */
  tradeDates: string[];
  /** 按天分桶的快讯（桶一定存在，没翻到就是空数组） */
  perDay: Record<string, NewsLiteRow[]>;
  /** 摊平成一条时间线（按 tradeDates 的顺序拼接，桶内新→旧），给只要列表的消费者用 */
  items: NewsLiteRow[];
  source: NewsWindow["source"];
  fetchedRows: number;
  offDay: number;
  duplicated: number;
  dropped: number;
  /** 页数预算花完还没翻到区间最早一天 → 窗口不完整，调用方要如实说明 */
  capped: boolean;
  /** 实际翻到的最早/最晚日期（YYYY-MM-DD），用于「窗口覆盖 09-22~09-24」这种说明 */
  spanFrom: string;
  spanTo: string;
}

async function buildNewsDaysWindow(tradeDates: string[], getPage: NewsPageFn, source: NewsWindow["source"]): Promise<NewsDaysWindow | null> {
  const oldest = [...tradeDates].sort()[0] ?? "";
  const { pages, capped } = await pageThroughUntil(oldest, getPage);
  const picked = pickNewsDays(pages, tradeDates);
  const items = tradeDates.flatMap((d) => picked.perDay[d] ?? []);
  if (!items.length) return null;
  const hitDays = tradeDates.filter((d) => (picked.perDay[d] ?? []).length);
  return {
    tradeDates,
    perDay: picked.perDay,
    items,
    source,
    fetchedRows: picked.fetchedRows,
    offDay: picked.offDay,
    duplicated: picked.duplicated,
    dropped: picked.dropped,
    capped,
    spanFrom: hitDays[hitDays.length - 1] ?? "", // hitDays 是新→旧，末尾才是最早那天
    spanTo: hitDays[0] ?? "",
  };
}

/**
 * 多日快讯池：按 realSort 游标从「现在」翻到早于区间最早一天为止。
 * 与单日版的区别就在停止判据（>= oldest，而不是 === 目标日）：抓取日往往晚于目标区间，
 * 用 === 会在第一页（末行还是区间外的新日子）就停手，一页就空手而归。
 * 两源都拿不到时返回 null，不返回空窗口冒充「这几天没有新闻」。
 */
export async function fetchNewsWindowForDates(tradeDates: string[]): Promise<NewsDaysWindow | null> {
  const dates = [...new Set(tradeDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))].sort((a, b) => (a < b ? 1 : -1));
  if (!dates.length) return null;
  return cached("news", `days:${dates.join(",")}`, async () => {
    try {
      const em = await buildNewsDaysWindow(dates, emNewsPage, "东财7x24");
      if (em) return em;
    } catch {
      // 换新浪
    }
    try {
      return await buildNewsDaysWindow(dates, sinaNewsPage, "新浪直播");
    } catch {
      return null;
    }
  });
}

