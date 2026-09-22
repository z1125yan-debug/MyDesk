// ---------- 同花顺（THS）板块资金流兜底（P15-R6） ----------
// 东财 push2 断源是复发问题：板块榜、资金读数全线 blackout。GitHub 上主流行情库
// （akshare/adata/efinance/qstock）的板块资金流大多仍以东财为上游——换库逃不开同源断供。
// 同花顺 data.10jqka.com.cn 的行业/概念资金流榜是服务端渲染 HTML（GBK 编码），实测无
// cookie、无 key 可直取，是与东财真正独立的上游。
//
// 口径差异如实登记（不冒充东财字段）：
//  1) 净额 = 流入资金 − 流出资金（亿），没有超大单/大单/净占比拆分；
//  2) 榜单按涨幅排序取前几页——净流出且涨幅靠后的板块可能不在榜内；
//  3) 同花顺板块代码与东财 secid 不同系：secid 留空、code 加 THS 前缀，
//     日K/资金连续/成分扩散自然落「无数据」分支，绝不拿别家板块码错接东财数据。
// 只在东财+腾讯兜底都拿不到资金读数时才启用；东财正常时本模块不参与主链路。

export interface ThsBoardRow {
  code: string; // 带 THS 前缀的板块码（防与东财 BK 码串源；无码时退到 THSN_名称）
  name: string;
  changePct: number;
  inflowYi: number; // 流入资金(亿)
  outflowYi: number; // 流出资金(亿)
  netYi: number; // 净额(亿) = 流入 − 流出
  count: number; // 公司家数
  leader: string; // 领涨股
  leaderPct: number; // 领涨股涨跌幅 %
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_PAGES = 3; // 每页 50 条：行业 90 条可全扫，概念取涨幅序前 150
const TTL_MS = 60_000;

export type ThsKind = "industry" | "concept";
const BASE: Record<ThsKind, string> = {
  industry: "https://data.10jqka.com.cn/funds/hyzjl/",
  concept: "https://data.10jqka.com.cn/funds/gnzjl/",
};

function toNum(v: string): number {
  const n = parseFloat(v.replace(/%/, "").replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}

/** 零 IO 纯解析：一页 THS 资金流 HTML（GBK 已解码）→ 行数组。列序固定为
 *  序号|行业|行业指数|涨跌幅|流入(亿)|流出(亿)|净额(亿)|公司家数|领涨股|领涨涨跌幅|当前价 */
export function parseThsRows(html: string): ThsBoardRow[] {
  const out: ThsBoardRow[] = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    if (!tr.includes("<td")) continue;
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
    );
    if (cells.length < 11 || !cells[1]) continue; // 表头/杂散行按列数剔除
    const codeM = tr.match(/\/(?:thshy|gn)\/detail\/code\/(\d+)\//);
    out.push({
      code: codeM ? `THS${codeM[1]}` : `THSN_${cells[1]}`,
      name: cells[1],
      changePct: toNum(cells[3]),
      inflowYi: toNum(cells[4]),
      outflowYi: toNum(cells[5]),
      netYi: toNum(cells[6]),
      count: toNum(cells[7]),
      leader: cells[8],
      leaderPct: toNum(cells[9]),
    });
  }
  return out;
}

async function fetchThsPage(url: string): Promise<ThsBoardRow[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  return parseThsRows(new TextDecoder("gbk").decode(await res.arrayBuffer()));
}

/** 同花顺行 → 板块榜行形状（sectors/board 两路共用，R7）：main 是真净额，
 *  但净占比/超大单/大单同花顺榜没有该拆分 → breakdownMissing，页面这些列必须显「—」不画 0；
 *  secid 留空 + THS 前缀码：东财资金明细/成分池递棒自然禁掉，不跨系错接。 */
export function thsToRankRow(r: ThsBoardRow) {
  return {
    code: r.code,
    secid: "",
    name: r.name,
    changePct: r.changePct,
    main: r.netYi,
    ratio: 0,
    superBig: 0,
    big: 0,
    leader: r.leader,
    breakdownMissing: true as const,
  };
}

const cache = new Map<ThsKind, { at: number; rows: ThsBoardRow[] }>();/** 抓一整个榜单（分页顺序拼接，最多 MAX_PAGES 页）。全部失败返回 []，由调用方决定回退话术；
 *  中途某页失败则带回已取到的部分（缺口按「榜按涨幅取前 N」如实登记，不谎称全量）。 */
export async function fetchThsBoards(kind: ThsKind): Promise<ThsBoardRow[]> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows: ThsBoardRow[] = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    try {
      const page = await fetchThsPage(p === 1 ? BASE[kind] : `${BASE[kind]}page/${p}/`);
      rows.push(...page);
      if (page.length < 50) break; // 尾页不满即到底
    } catch {
      break;
    }
  }
  if (rows.length) cache.set(kind, { at: Date.now(), rows });
  return rows;
}
