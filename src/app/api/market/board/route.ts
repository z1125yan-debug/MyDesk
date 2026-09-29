// GET /api/market/board — 板块/个股资金流向榜（数据看板 BoardPage 用）
// P15-R7：行业/概念两榜在东财断源（无返回或只剩腾讯涨幅占位）时整榜换同花顺资金流榜
// （独立上游，净额真数、无净占比拆分 → 行上 breakdownMissing，页面显「—」）；
// 同花顺榜按涨幅序取，流入向取净额>0 降序、流出向取净额<0 升序，各截前 30。
// P15-R16：个股榜再往下一棒——东财断源时换**通达信当日逐笔自算**的主力净额
// （口径与分档阈值在 tdx-flow-core 纯核，行上挂 mainSelfComputed，页面必须标「自算」不冒充东财官方读数）。
// 地域榜无对等替代源——缺就是缺，交回 rows:null 由页面显式声明，绝不落回演示数据。
import { NextResponse } from "next/server";
import { fetchBoardReal } from "@/lib/desk/em";
import { fetchThsBoards, thsToRankRow } from "@/lib/desk/ths";
import { tdxMainFlowUniverse, type TdxMainFlowRow } from "@/lib/desk/tdx";
import { pickMainFlowSide, type MainFlow } from "@/lib/quant/screener/tdx-flow-core";
import { latestTradeDate } from "@/lib/desk/trade-date";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";

const KINDS = new Set(["stock", "industry", "concept", "region"]);
type Kind = "stock" | "industry" | "concept" | "region";

/** 通达信自算行 → 榜单行形状：净额/占比/超大单/大单都来自逐笔轧差，出身必须挂在 mainSelfComputed */
function tdxToRankRow(r: TdxMainFlowRow, rank: number, flow: MainFlow) {
  const digits = /^(\d{6})\./.exec(r.symbol);
  const market = /\.SH$/i.test(r.symbol) ? 1 : /\.SZ$/i.test(r.symbol) ? 0 : null;
  return {
    rank,
    code: digits ? digits[1] : r.symbol,
    // 有东财 secid 才能点出「近 14 日主力净额」明细；市场前缀推得出就给，推不出留空由页面显式缺失
    secid: digits && market !== null ? `${market}.${digits[1]}` : undefined,
    name: r.name,
    changePct: r.changePct,
    main: flow.mainNetYi,
    ratio: flow.ratioPct ?? Number.NaN, // 当日成交额没给 → NaN，页面显「—」，不补一个 0 冒充「占比为 0」
    superBig: flow.superBigYi,
    big: flow.bigYi,
    leader: "",
    mainSelfComputed: true,
    // 翻页撞到上限 / 没取满快照给出的全日笔数：样本不完整的行必须自己说出来，不装全量
    ...(flow.sampleComplete ? {} : { flowSampleTruncated: true }),
  };
}

/**
 * 2026-09-29 菜单打开提速：本路由算一次要几秒（实测冷启动 1.3~6 秒），
 * 而菜单/切页会反复打它。包一层进程内 TTL 缓存（默认 60s，与页面轮询同档）：
 * 第二次起直接命中热缓存（几十毫秒），响应里的 asOf/tradeDate 照旧如实标数据时间。
 */
export async function GET(req: Request) {
  return ttlCache(`market/board${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind") ?? "industry";
  const kind = (KINDS.has(kindParam) ? kindParam : "industry") as Kind;
  const dir = url.searchParams.get("dir") === "out" ? "out" : "in";
  const asOf = new Date().toISOString(); // 本机取数完成时刻（回答「我们什么时候取的」，不是「这是哪天的数」）
  // 「这是哪天的数」由 tradeDate 回答：行情源给的最近交易日（休市日补上，页面才不会把 15:32 读成今天的行情）
  const tradeDate = await latestTradeDate().catch(() => null);
  try {
    const rows = await fetchBoardReal(kind, dir);
    if (rows?.length && !rows.every((r) => r.fundsMissing)) {
      return NextResponse.json({ rows, source: "em", asOf, tradeDate });
    }
    // 东财这条路没有可用读数：按榜的种类往下递棒，递不到就如实 null
    const needThs = kind === "industry" || kind === "concept"; // 地域仍无对等榜——缺就是缺
    if (needThs) {
      const ths = await fetchThsBoards(kind);
      const picked = (dir === "in"
        ? ths.filter((r) => r.netYi > 0).sort((a, b) => b.netYi - a.netYi)
        : ths.filter((r) => r.netYi < 0).sort((a, b) => a.netYi - b.netYi)
      ).slice(0, 30);
      if (picked.length) {
        return NextResponse.json({ rows: picked.map(thsToRankRow), source: "ths", asOf, tradeDate });
      }
    }
    if (kind === "stock") {
      const univ = await tdxMainFlowUniverse();
      if (univ?.rows.length) {
        // 板块码防线（2026-09-29）：不是「6 位代码 + .SH/.SZ/.BJ」的行一律不进个股榜——
        // 上游/网关口径再怎么变，榜上也不许出现「银行」这类板块行冒充个股。
        const stockRows = univ.rows.filter((r) => /^\d{6}\.(SH|SZ|BJ)$/i.test(r.symbol));
        const picked = pickMainFlowSide(
          stockRows.map((r) => ({ name: r.name, code: r.symbol, changePct: r.changePct, flow: r.flow })),
          dir,
        );
        const bySymbol = new Map(stockRows.map((r) => [r.symbol, r]));
        // pickMainFlowSide 已把「逐笔没取到」的行滤掉（不占位、不补 0），这里只保留真有读数的行
        const out = picked.flatMap((p, i) => {
          const src = bySymbol.get(p.code);
          return src?.flow ? [tdxToRankRow(src, i + 1, src.flow)] : [];
        });
        if (out.length) {
          return NextResponse.json({ rows: out, source: "tdx", asOf, tradeDate, quoteTime: univ.asOf || null });
        }
      }
    }
    // 递棒到底没有可用来源： rows 原样带回（可能是东财给的腾讯涨幅占位榜），由页面显式声明缺失
    return NextResponse.json({ rows: rows ?? null, source: null, asOf, tradeDate });
  } catch {
    return NextResponse.json({ rows: null, error: "数据源暂不可用", asOf, tradeDate });
  }
}
