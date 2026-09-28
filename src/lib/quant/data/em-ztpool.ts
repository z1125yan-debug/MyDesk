// P15-R20 东财涨停池取数层（仅服务端，只发请求、不做判定）
// 接口：push2ex.eastmoney.com/getTopicZTPool（涨停池，与网页「涨停棱镜」同源）。
// 实测（2026-09-28 探针 D:\Zai\tmp-probe-chain\r20）：
//   · 按日期取数可用：date=YYYYMMDD 确实返回那一天的名单（09-24 共 52 只、lbc 分布 1:39 2:8 3:1 4:3 5:1，
//     与当天收盘的涨停家数对得上）；
//   · 留存窗口有限：09-10 / 09-15 / 09-18 / 09-21 / 09-22 / 09-23 / 09-24 有数，
//     09-01、09-25、06-02、04-20、2025 年各日都返回 tc=0；
//   · **data.qdate 永远是「服务器今天」，不是所查的那一天**，拿它校验取数日会得到假通过；
//   · 字段 m（市场号）深市与北交所同样返回 0，认市别看号——代码后缀一律走 intent-core 的号段表。
//
// 这一层为什么要把「0 条」和「没数据」分开返回：tc=0 既可能是那天休市，也可能是超出了留存窗口，
// 从响应本身分不出来。所以这里只回 `ok:false + reason`，让采集层决定「一行都不写」，
// 而不是把空数组当「今日 0 只涨停」写进历史。
import { parsePoolRows, type RosterRow } from "../screener/limit-up-roster-core.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const POOL_URL = "https://push2ex.eastmoney.com/getTopicZTPool";
const UT = "7eea3edcaed734bea9cbfc24409ed989";
const PAGE_SIZE = 300; // 一天最多百来只，一页装得下；仍留翻页兜底
const MAX_PAGES = 5;
const REQ_TIMEOUT_MS = 10_000;

export interface PoolFetchResult {
  trade_date: string;
  rows: RosterRow[];
  /** 服务端报告的池子条数（data.tc）；-1 = 没读到这个字段 */
  tc: number;
  /** 形状不对、认不出代码而被丢掉的行数 */
  dropped: number;
  /** 是否拿到了一份「可以写库」的名单 */
  ok: boolean;
  /** ok=false 时的人话原因；ok=true 时是空串 */
  reason: string;
}

const EMPTY_NOTE =
  "涨停池返回 0 条：可能是休市日，也可能超出东财留存窗口（实测约只回溯到当月早些时候），"
  + "响应本身分不出来，故不写入任何行";

async function fetchPage(dateCompact: string, pageIndex: number): Promise<{ pool: unknown[]; tc: number }> {
  const url = `${POOL_URL}?ut=${UT}&dpt=wz.ztzt&Pageindex=${pageIndex}&pagesize=${PAGE_SIZE}`
    + `&sort=lbc%3Adesc&date=${dateCompact}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { pool?: unknown; tc?: unknown; qdate?: unknown } };
  const pool = Array.isArray(json?.data?.pool) ? json.data.pool : [];
  const tc = typeof json?.data?.tc === "number" && Number.isFinite(json.data.tc) ? json.data.tc : -1;
  // json.data.qdate 故意不使用：它是服务器当前日期，与所查日期无关（见文件头）
  return { pool, tc };
}

/**
 * 取某一天的涨停池名单。网络/形状错误抛给调用方（回填要知道是「请求失败」还是「那天没数」），
 * 「那天 0 条」不抛错、只回 ok:false ——它是业务事实不是故障。
 */
export async function fetchLimitUpPool(tradeDate: string): Promise<PoolFetchResult> {
  const dateCompact = tradeDate.replace(/-/g, "");
  if (!/^\d{8}$/.test(dateCompact)) throw new Error(`涨停池取数日期格式不对：${tradeDate}`);

  const raw: unknown[] = [];
  let tc = -1;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(dateCompact, page);
    if (page === 0) tc = res.tc;
    raw.push(...res.pool);
    // 翻页条件：服务端说还有更多，且这一页确实给了东西
    if (res.pool.length === 0) break;
    if (tc < 0 || raw.length >= tc) break;
  }

  const { rows, dropped } = parsePoolRows(raw);
  // 同名同日重复行合并（翻页重叠时会撞）：保留后读到的那条，条数不吹
  const bySymbol = new Map<string, RosterRow>();
  for (const r of rows) bySymbol.set(r.symbol, r);
  const merged = [...bySymbol.values()];

  if (!merged.length) {
    return {
      trade_date: tradeDate, rows: [], tc, dropped,
      ok: false,
      reason: raw.length
        ? `池子给了 ${raw.length} 条，但没有一条能认出 6 位代码（丢弃 ${dropped} 条）——不猜代码`
        : EMPTY_NOTE,
    };
  }
  return { trade_date: tradeDate, rows: merged, tc, dropped, ok: true, reason: "" };
}
