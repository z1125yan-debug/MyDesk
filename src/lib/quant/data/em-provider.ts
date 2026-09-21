// Quant Research Lab — A 股真实数据源实现（仅服务端使用）
// 数据原则：本文件是 DataProvider 的一个实现，量化模块不直接依赖它。
// 行情复用 MyDesk 既有数据层（src/lib/desk/em.ts，腾讯/东财公开接口，本机直连）；
// em.ts 未覆盖的能力（全A成分股快照字段、带成交量的历史K线窗口、板块成分）在
// 本文件内以同模式独立实现，不修改 em.ts。
// 注意：公开接口无历史时点成分股/停牌数据 → universeMembership=current_only，
// 历史回放存在幸存者偏差风险，由调用方在结果中标注。
import { fetchQuotesReal } from "@/lib/desk/em";
import { fetchTcUniverseAllA, setUniverseSource } from "./tc-universe";
import type { AssetMeta, Bar, BarsRequest, DataCoverage, DataProvider, Timeframe, UniverseSpec } from "../types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- 抓取 + TTL 缓存（模式与 em.ts 一致，独立实例互不污染） ----------

async function fetchJson<T>(url: string, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// 多主机 fallback：同一路径在多个主机间依次尝试（腾讯主域被 WAF 时自动切代理域）
async function fetchJsonMultiHost<T>(paths: string[], timeoutMs = 6000): Promise<T> {
  let lastErr: unknown = new Error("no host");
  for (const url of paths) {
    try {
      return await fetchJson<T>(url, timeoutMs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 腾讯K线同接口多域名：主域被 WAF/限流时自动切代理域（同路径加 /ifzqgtimg 前缀）
const TC_DAY_HOSTS = ["https://web.ifzq.gtimg.cn", "https://proxy.finance.qq.com/ifzqgtimg"];
const TC_MINUTE_HOSTS = ["https://ifzq.gtimg.cn", "https://proxy.finance.qq.com/ifzqgtimg"];

const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_TTL_MS: Record<string, number> = { universe: 300_000, bars: 600_000 };
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(kind: keyof typeof CACHE_TTL_MS, key: string, fn: () => Promise<T>): Promise<T> {
  const k = `${kind}:${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS[kind]) return hit.data as T;
  const running = inflight.get(k);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((data) => {
      cache.set(k, { at: Date.now(), data });
      if (cache.size > 1200) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      return data;
    })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 符号映射（沿用 MyDesk 约定） ----------

function symbolToTencent(symbol: string): string | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbol.trim().toUpperCase());
  return m ? `${m[2].toLowerCase()}${m[1]}` : null;
}

// ---------- 全A / 板块成分（东财 clist；字段口径与 em.ts 板块接口一致） ----------

// 沪深京 A 股口径沿用 em.ts BOARD_FS.stock
const FS_ALL_A = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const EM_HOSTS = ["https://push2delay.eastmoney.com", "https://push2.eastmoney.com"];
// f12代码 f13市场 f14名称 f2价 f3涨跌幅 f5量(手) f6额(元) f7振幅 f8换手 f9PE f10量比
// f15最高 f18昨收（P0补齐·炸板率口径需要） f20总市值 f21流通 f23PB f26上市日 f62主力净额 f100行业
const UNIVERSE_FIELDS = "f12,f13,f14,f2,f3,f5,f6,f7,f8,f9,f10,f15,f18,f20,f21,f23,f26,f62,f100";
const UNIVERSE_PAGE_SIZE = 200;

function isBjCode(code: string): boolean {
  return /^(43|83|87|92)/.test(code);
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : null;
}

function emDate(v: unknown): string | undefined {
  const n = num(v);
  if (!n || String(n).length !== 8) return undefined;
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function toSymbol(market: unknown, code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (num(market) === 1) return `${code}.SH`;
  if (isBjCode(code)) return `${code}.BJ`;
  return `${code}.SZ`;
}

async function clistPage(fs: string, pn: number, sortFid = "f12"): Promise<{ total: number; rows: Record<string, unknown>[] }> {
  const path =
    `/api/qt/clist/get?pn=${pn}&pz=${UNIVERSE_PAGE_SIZE}&po=0&np=1&fltt=2&invt=2&fid=${sortFid}` +
    `&fs=${encodeURIComponent(fs)}&fields=${UNIVERSE_FIELDS}`;
  let lastErr: unknown = new Error("no host");
  for (const host of EM_HOSTS) {
    try {
      const j = await fetchJson<{ data?: { total?: number; diff?: Record<string, unknown>[] } }>(host + path);
      return { total: j?.data?.total ?? 0, rows: j?.data?.diff ?? [] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function rowToMeta(d: Record<string, unknown>): AssetMeta | null {
  const symbol = toSymbol(d.f13, String(d.f12 ?? ""));
  if (!symbol) return null;
  const price = num(d.f2);
  return {
    symbol,
    name: String(d.f14 ?? symbol),
    industry: typeof d.f100 === "string" && d.f100 !== "-" ? d.f100 : undefined,
    listDate: emDate(d.f26),
    marketCap: num(d.f20) ?? undefined,
    floatCap: num(d.f21) ?? undefined,
    pe: num(d.f9) ?? undefined,
    pb: num(d.f23) ?? undefined,
    price: price ?? undefined,
    changePct: num(d.f3) ?? undefined,
    turnover: num(d.f8) ?? undefined,
    volumeRatio: num(d.f10) ?? undefined,
    amplitude: num(d.f7) ?? undefined,
    high: num(d.f15) ?? undefined,
    prevClose: num(d.f18) ?? undefined,
    mainNet: num(d.f62) ?? undefined,
    volume: num(d.f5) !== null ? (num(d.f5) as number) * 100 : undefined, // 手 → 股
    amount: num(d.f6) ?? undefined,
    st: /ST/i.test(String(d.f14 ?? "")),
    suspended: price === null, // 无价 = 当日停牌/无成交（快照口径）
  };
}

async function clistUniverseAllA(): Promise<AssetMeta[]> {
  const out: AssetMeta[] = [];
  let pn = 1;
  for (;;) {
    const { total, rows } = await clistPage(FS_ALL_A, pn);
    for (const r of rows) {
      const m = rowToMeta(r);
      if (m) out.push(m);
    }
    if (!rows.length || out.length >= total || pn > 60) break;
    pn++;
    await sleep(120); // 节流防限流
  }
  return out;
}

// 东财 clist 断源（push2 集群对部分出口 IP 拒连，2026-09-22 实测）时改走腾讯批量快照兜底；
// 两路都挂才把合并后的错误抛给页面。universeSource() 记录实际服务方，上层据此如实改写 source 文案。
async function fetchUniverseAllARaw(): Promise<AssetMeta[]> {
  try {
    const rows = await clistUniverseAllA();
    if (rows.length) {
      setUniverseSource("em");
      return rows;
    }
    throw new Error("东财 clist 全A快照无返回");
  } catch (e) {
    const emErr = (e as Error).message;
    try {
      const tc = await fetchTcUniverseAllA();
      setUniverseSource("tc");
      return tc;
    } catch (e2) {
      throw new Error(`东财 clist 与腾讯兜底均失败：${emErr}；${(e2 as Error).message}`);
    }
  }
}

async function fetchUniverseAllA(): Promise<AssetMeta[]> {
  return cached("universe", `all`, fetchUniverseAllARaw);
}

async function fetchBoardMembers(boardCode: string): Promise<AssetMeta[]> {
  return cached("universe", `board:${boardCode}`, async () => {
    const { rows } = await clistPage(`b:${boardCode}`, 1, "f6");
    return rows.map(rowToMeta).filter((m): m is AssetMeta => m !== null);
  });
}

// ---------- K线（腾讯；日线支持历史窗口，分钟线仅近期） ----------
// 数组顺序沿用 em.ts 注释：[日期, 开, 收, 高, 低, 量, ...]

const MINUTE_TF: Partial<Record<Timeframe, string>> = {
  m1: "m1", m5: "m5", m15: "m15", m30: "m30", m60: "m60",
};

interface TcRow extends Array<string | number> {}

function parseDayRows(rows: TcRow[]): Bar[] {
  const out: Bar[] = [];
  for (const p of rows) {
    if (!Array.isArray(p) || p.length < 6) continue;
    const date = String(p[0]);
    const o = +p[1], c = +p[2], h = +p[3], l = +p[4], v = +p[5];
    if (![o, c, h, l].every(isFinite)) continue;
    out.push({ date, o, h, l, c, v: isFinite(v) ? v * 100 : 0, amount: isFinite(+p[6]) ? +p[6] : undefined });
  }
  return out;
}

function parseMinuteRows(rows: TcRow[]): Bar[] {
  const out: Bar[] = [];
  for (const p of rows) {
    if (!Array.isArray(p) || p.length < 6) continue;
    const raw = String(p[0]); // YYYYMMDDHHmm
    if (raw.length !== 12) continue;
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`;
    const o = +p[1], c = +p[2], h = +p[3], l = +p[4], v = +p[5];
    if (![o, c, h, l].every(isFinite)) continue;
    out.push({ date, o, h, l, c, v: isFinite(v) ? v * 100 : 0 });
  }
  return out;
}

async function fetchDayBarsTc(symbol: string, asOf: string, lookback: number): Promise<Bar[] | null> {
  const tc = symbolToTencent(symbol);
  if (!tc) return null;
  return cached("bars", `${tc}:day:${asOf}:${lookback}`, async () => {
    // start 往前多取一倍窗口，容忍节假日
    const end = asOf;
    const startMs = Date.parse(asOf) - Math.max(60, lookback * 2) * 86400000;
    const start = new Date(Math.max(0, startMs)).toISOString().slice(0, 10);
    const count = Math.min(800, Math.max(40, Math.ceil(lookback * 1.6)));
    const path = `/appstock/app/fqkline/get?param=${tc},day,${start},${end},${count},qfq`;
    const j = await fetchJsonMultiHost<{ data?: Record<string, Record<string, unknown>> }>(TC_DAY_HOSTS.map((h) => h + path));
    const d = j?.data?.[tc] ?? {};
    const rows = ((d["qfqday"] ?? d["day"]) as TcRow[] | undefined) ?? [];
    return parseDayRows(rows);
  });
}

async function fetchMinuteBarsTc(symbol: string, tf: Timeframe, asOf: string, lookback: number): Promise<Bar[] | null> {
  const per = MINUTE_TF[tf];
  const tc = symbolToTencent(symbol);
  if (!per || !tc) return null;
  return cached("bars", `${tc}:${per}:recent`, async () => {
    const path = `/appstock/app/kline/mkline?param=${tc},${per},,${Math.min(800, Math.max(60, lookback))}`;
    const j = await fetchJsonMultiHost<{ data?: Record<string, Record<string, unknown>> }>(TC_MINUTE_HOSTS.map((h) => h + path));
    const rows = ((j?.data?.[tc]?.[per]) as TcRow[] | undefined) ?? [];
    return parseMinuteRows(rows);
  }).then((bars) => (bars ?? []).filter((b) => b.date.slice(0, 10) <= asOf).slice(-lookback));
}

// ---------- Provider ----------

let lastThrottle = 0;

export const emProvider: DataProvider = {
  id: "em",
  coverage(): DataCoverage {
    return {
      source: "em(腾讯/东财公开接口)",
      daily: true,
      minute: true, // 仅近期（mkline 不支持任意历史窗口）
      fundamentals: "snapshot",
      universeMembership: "current_only",
    };
  },

  async listUniverse(spec: UniverseSpec, asOf: string): Promise<AssetMeta[]> {
    let metas: AssetMeta[];
    if (spec.kind === "custom" && spec.symbols?.length) {
      const all = await fetchUniverseAllA();
      const set = new Set(spec.symbols.map((s) => s.toUpperCase()));
      metas = all.filter((m) => set.has(m.symbol));
    } else if (spec.kind === "industry" && spec.boardCode) {
      metas = await fetchBoardMembers(spec.boardCode);
    } else if (spec.kind === "concept" && spec.boardCode) {
      metas = await fetchBoardMembers(spec.boardCode);
    } else {
      metas = await fetchUniverseAllA();
    }
    // 上市时间过滤：asOf 之前未上市的剔除（可得的时点信息之一）
    return metas.filter((m) => !m.listDate || m.listDate <= asOf);
  },

  async getBars(req: BarsRequest): Promise<Map<string, Bar[]>> {
    const out = new Map<string, Bar[]>();
    let consecutiveEmpty = 0;
    for (const sym of req.symbols) {
      try {
        // 节流：相邻请求至少间隔 100ms，防触发数据源限流殃及现有功能
        const now = Date.now();
        const gap = now - lastThrottle;
        if (gap < 100) await sleep(100 - gap);
        lastThrottle = Date.now();
        let bars: Bar[] | null;
        if (req.tf === "day") bars = await fetchDayBarsTc(sym, req.asOf, req.lookback);
        else bars = await fetchMinuteBarsTc(sym, req.tf, req.asOf, req.lookback);
        const cut = (bars ?? []).filter((b) => b.date.slice(0, 10) <= req.asOf);
        out.set(sym, cut.slice(-req.lookback));
        consecutiveEmpty = cut.length ? 0 : consecutiveEmpty + 1;
        // 熔断：批量拉取时连续空返回大概率意味着被数据源限流，
        // 继续只会加重封锁并污染结果——立即中止，让调用方拿到明确错误。
        if (consecutiveEmpty >= 10 && req.symbols.length > 10) {
          throw new Error("数据源连续 10 只无K线返回，疑似被限流（WAF），已中止本次批量拉取；请稍后重试或缩小样本");
        }
      } catch (e) {
        if ((e as Error).message.includes("疑似被限流")) throw e;
        out.set(sym, []); // 单只失败不拖垮整批
        consecutiveEmpty++;
      }
    }
    return out;
  },

  async getQuotes(symbols: string[]): Promise<Map<string, { price: number; name?: string }>> {
    const out = new Map<string, { price: number; name?: string }>();
    try {
      const quotes = await fetchQuotesReal(symbols);
      for (const q of quotes) {
        if (q) out.set(q.symbol, { price: q.price, name: q.name });
      }
    } catch {
      // 保持空，由上层回退
    }
    return out;
  },
};
