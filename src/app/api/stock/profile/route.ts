// 个股资金画像 API（需求文档 P0：输入代码 → 自动拉全量 → 结构化报告）
// 每个数据块带来源/接口/时间/状态（REAL_DATA_ONLY：缺失块显式标「暂缺」，不冒充实数）。
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { quantBootstrap, } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { fetchMcpStockBasic, fetchMcpStockNews } from "@/lib/quant/data/mcp-provider";
import { tdxQuotes, tdxDepth, tdxTradesMoney } from "@/lib/desk/tdx";
import { fetchQuotesReal, fetchDetailReal, fetchNewsReal, symbolToSecid } from "@/lib/desk/em";
// R20 主力净额第三档备胎（通达信当日逐笔自算）
import { mainNetSelfNote, tdxMainNetOf } from "@/lib/desk/fund-flow";
import { fetchBoardRowsRescued } from "@/lib/desk/board-rescue";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { marketSessionHolidayAware } from "@/lib/desk/session-server";
import { computeSentiment, evalLimitSnapshot } from "@/lib/quant/screener/sentiment";
import { buildFieldPanel, lastValues, type BarsLike } from "@/lib/quant/factors/fields";
import { historicalWinProbability, type WinProbStats } from "@/lib/quant/factors/probability";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYM_RE = /^\d{6}\.(SH|SZ|BJ)$/i;

export async function GET(request: Request) {
  const symbol = (new URL(request.url).searchParams.get("symbol") ?? "").trim().toUpperCase();
  // 2026-09-30（P34-3）：加服务端 TTL 缓存（5min + SWR）。画像一次要跑全链路
  // （K线/实时快照/五档/新闻/历史概率，maxDuration 60），此前只有浏览器端 HTTP 缓存，
  // 换标签页/别的进程进来照样全量重算——用户体感「画像打开慢」。加后同 symbol 5 分钟内直返，
  // 过期后 SWR 秒回旧值 + 后台刷新，不再阻塞。
  return ttlCache(`stock/profile:${symbol}`, 5 * 60_000, () => profileHandler(symbol));
}

async function profileHandler(symbol: string) {
  quantBootstrap();
  if (!SYM_RE.test(symbol)) {
    return NextResponse.json({ ok: false, error: "代码格式应为 688256.SH / 000001.SZ / 430047.BJ" }, { status: 400 });
  }
  const now = new Date();
  const asOf = shanghaiStamp(now);
  const session = marketSessionHolidayAware(now);
  const statusLive = session.open ? "LIVE" : "HISTORICAL";
  const missing: string[] = [];

  // —— 并行拉取所有互相独立的外部源 ——
  // 原实现是顺序 await（报价→盘口→逐笔→K线→资金→板块→新闻→概况→风险），
  // 每个都是一次网络往返，冷路径被叠加到 6~7s；这些源彼此不依赖，并发后冷路径≈最慢单个源（约 2~3s）。
  // 依赖关系只在「拿到结果后的本地计算/兜底」里发生，下面各自 await 收口（quote 仍走 eltdx→腾讯兜底）。
  const pTdxQuotes = tdxQuotes([symbol]).catch(() => null);
  const pDepth = tdxDepth([symbol]).catch(() => null);
  const pTrades = tdxTradesMoney(symbol).catch(() => null);
  const tradeDate = shanghaiDate(now);
  const provider = await getProvider("em");
  const pUniverse = provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []);
  const pBars = fetchBarsHybrid([symbol], tradeDate, 480).catch(() => null);
  const secid = symbolToSecid(symbol);
  const pDetail = secid ? fetchDetailReal(secid).catch(() => null) : Promise.resolve(null);
  const pBoard = fetchBoardRowsRescued("industry", "in", 90).catch(() => ({ rows: null, fromThs: false }));
  const pNews = fetchNewsReal(8).catch(() => null);
  const code6 = symbol.split(".")[0];
  const pStockNews = fetchMcpStockNews(code6, 6).catch(() => null);
  const pBasic = fetchMcpStockBasic(code6).catch(() => null);
  const pSentiment = computeSentiment().catch(() => null);

  // 1) 实时报价：eltdx → 腾讯
  let quote: { price: number; changePct: number | undefined; high: number; low: number; prevClose: number; amountYi: number | undefined } | null = null;
  let quoteSource = "";
  const tq = await pTdxQuotes;
  if (tq?.get(symbol)) {
    const q = tq.get(symbol)!;
    quote = { price: q.price, changePct: q.changePct, high: q.high, low: q.low, prevClose: q.prevClose, amountYi: q.amountYi };
    quoteSource = "通达信网关快照";
  } else {
    const qs = await fetchQuotesReal([symbol]).catch(() => null);
    const q = qs?.[0];
    if (q) {
      quote = { price: q.price, changePct: q.changePct, high: q.high ?? q.price, low: q.low ?? q.price, prevClose: q.prevClose ?? q.price, amountYi: q.amountYi };
      quoteSource = "腾讯 · qt.gtimg.cn";
    }
  }
  if (!quote) missing.push("实时报价");

  // 2) 五档盘口（仅 eltdx）
  const depth = (await pDepth)?.get(symbol) ?? null;
  if (!depth) missing.push("五档盘口（本机通达信行情网关未开启或不可用）");

  // 3) 逐笔主动买卖（仅 eltdx，近2页近似口径）
  const trades = await pTrades;
  if (!trades) missing.push("逐笔主动买卖（本机通达信行情网关未开启或不可用）");

  // 4) 日K（腾讯带成交量）→ 技术指标 + 历史条件概率
  let bars: BarsLike[] = [];
  let meta = (await pUniverse)[0];
  const barsMap = await pBars;
  if (barsMap) bars = (barsMap.get(symbol) ?? []) as BarsLike[];
  if (bars.length < 60) missing.push("日K历史不足，技术指标与历史统计不可用");

  const tech: Record<string, number | null> = {};
  if (bars.length >= 60) {
    const panel = buildFieldPanel([symbol], [bars], [meta]);
    const vals = lastValues(panel);
    const m = vals.get(symbol) ?? new Map();
    for (const k of ["above_ma_5", "above_ma_10", "above_ma_20", "above_ma_60", "above_ma_144", "ma_struct",
      "macd", "macd_cross", "kdj_cross", "kdj_j", "rsi_14", "rsi_24", "atr_ratio_14",
      "vwap20_filter", "vwap_pos", "rps_50", "rps_120", "is_limit_up", "amount_yi"]) {
      tech[k] = m.get(k) ?? null;
    }
    // §三（验收修复）：「今日涨停」实时态优先快照口径（snapshot 的 prevClose/high/price 精确涨停价），
    // 快照不可判时保留K线口径并在 missing 中显式说明，不当作「确认未涨停」。
    const limEv = meta ? evalLimitSnapshot(meta) : null;
    if (limEv) tech["is_limit_up"] = limEv.sealed ? 1 : 0;
    else if (tech["is_limit_up"] !== null && tech["is_limit_up"] !== undefined) {
      missing.push("今日涨停：快照不可判（新股无涨跌幅限制期或快照字段缺失），当前为K线口径（bar_time 可能滞后）");
    }
  }

  // 历史条件概率：当前命中的默认技术环境（站上MA20 + 站上20日成本线）
  let winProb: WinProbStats | null = null;
  if (bars.length >= 120) {
    winProb = historicalWinProbability({
      symbol, bars, meta,
      conditions: [
        { field: "above_ma_20", op: "=", value: 1 },
        { field: "vwap20_filter", op: "=", value: 1 },
      ],
    });
  }

  // 5) 资金流：东财 14 日主力净额（断源时新浪日度净额备胎，source 三元如实分标）
  //    R20 第三档：前两条源都没通时，用通达信当日逐笔自算一个出来——
  //    自算只有当日一点（没有历史序列），所以 days 只放当日、并挂「自算」出身，不冒充东财序列。
  const detail = await pDetail;
  const selfFlow = detail ? null : await tdxMainNetOf(symbol, meta?.amount ?? null).catch(() => null);
  if (!detail && !selfFlow) missing.push("主力资金流（资金明细、新浪日度净额、通达信逐笔自算三条源都没通）");

  // 6) 板块：行业 + 板块涨幅榜排名
  //    R8：走带同花顺兜底的入口——东财断源日也有净额真数可标；注意同花顺行业名与
  //    成分股表 f100 的行业名不保证对得上，匹不上就如实记「行业未匹配到榜单」，不硬攀。
  let sector: { name: string; changePct: number; rank: number; mainYi: number | null; count: number; source: string } | null = null;
  let sectorFromThs = false;
  if (meta?.industry) {
    const { rows: boards, fromThs } = await pBoard;
    sectorFromThs = fromThs;
    const row = boards?.find((b) => b.name === meta?.industry);
    if (row && boards) sector = {
      name: row.name, changePct: row.changePct, rank: boards.indexOf(row) + 1,
      mainYi: row.fundsMissing ? null : row.main, count: boards.length,
      source: fromThs ? "同花顺行业资金流榜（净额=流入−流出口径）" : "行业资金榜",
    };
  }
  if (!sector) missing.push("板块强度（行业未匹配到榜单）");

  // 7) 新闻：宏观快讯可得；个股新闻用 MCP（get_news_data）补齐
  const news = await pNews;
  if (!news) missing.push("宏观快讯");
  const stockNewsRes = await pStockNews;
  if (!stockNewsRes) missing.push("个股新闻（MCP get_news_data 未返回或上游不可用）");

  // 7b) 公司概况：MCP get_stock_basic_info（静态表，稳定可用）
  const basicRes = await pBasic;
  if (!basicRes) missing.push("公司概况（MCP get_stock_basic_info 未返回）");

  // 8) 市场风险（共用情绪计算，universe 走缓存，开销小）
  let risk: { level: string; triggers: string[] } | null = null;
  const s = await pSentiment;
  if (s) risk = { level: s.risk.level, triggers: s.risk.triggers };

  return NextResponse.json({
    market: "A", market_label: "A股",
    ok: true,
    symbol,
    name: meta?.name ?? null,
    industry: meta?.industry ?? null,
    market_cap_yi: meta?.marketCap != null ? meta.marketCap / 1e8 : null,
    floatcap_yi: meta?.floatCap != null ? meta.floatCap / 1e8 : null,
    pe_ttm: meta?.pe ?? null, pb: meta?.pb ?? null,
    as_of: asOf,
    session,
    blocks: {
      quote: quote ? { data: quote, source: quoteSource, status: statusLive } : null,
      depth: depth ? {
        data: {
          bids: depth.bids, asks: depth.asks,
          bidTotalHand: depth.bids.reduce((s, l) => s + l.volume, 0),
          askTotalHand: depth.asks.reduce((s, l) => s + l.volume, 0),
          insideHand: depth.insideHand, outerHand: depth.outerHand, activeHand: depth.activeHand,
        },
        source: "通达信五档盘口", status: statusLive,
      } : null,
      trades: trades ? {
        data: {
          buyAmountYi: trades.buyAmountYi, sellAmountYi: trades.sellAmountYi,
          netYi: trades.netYi, outerHand: trades.outerHand, insideHand: trades.insideHand,
          avgPrice: trades.avgPrice, basis: trades.basis,
        },
        source: "通达信快照·内外盘",
        note: "主动买卖金额为系统按内外盘×成交均价计算的代理指标，非交易所官方主力资金统计",
        status: statusLive,
      } : null,
      fundflow: detail ? {
        data: {
          todayYi: detail.days.at(-1)?.value ?? null,
          spark: detail.spark, days: detail.days,
        },
        source: detail.source === "sina" ? "新浪资金流向日度净额（口径≈主力净流入）" : "主力资金日明细", status: "LIVE",
      } : selfFlow ? {
        data: {
          todayYi: selfFlow.mainNetYi,
          superBigYi: selfFlow.superBigYi,
          bigYi: selfFlow.bigYi,
          ratioPct: selfFlow.ratioPct,
          sampleTicks: selfFlow.sampleTicks,
          spark: [], days: [],
        },
        source: "通达信当日逐笔自算（主力净额主源）",
        note: mainNetSelfNote(selfFlow),
        status: statusLive,
      } : null,
      tech: bars.length >= 60 ? { data: tech, source: "腾讯日K · 本机指标计算（未验证因子）", status: "HISTORICAL" } : null,
      probability: winProb ? { data: winProb, source: "腾讯日K · 历史条件概率引擎", note: "条件：站上MA20 且 站上20日成本线（K线口径）", status: "HISTORICAL" } : null,
      sector: sector ? { data: sector, source: sector.source, status: "LIVE" } : null,
      news: news ? { data: news.slice(0, 6), source: "东财7x24/新浪 · 宏观快讯", status: "LIVE" } : null,
      stock_news: stockNewsRes ? { data: stockNewsRes.data, source: stockNewsRes.source, status: "LIVE" } : null,
      basic: basicRes ? { data: basicRes.data, source: basicRes.source, status: "HISTORICAL" } : null,
      risk: risk ? { data: risk, source: "全A快照风险引擎", status: "LIVE" } : null,
    },
    missing,
    source_note: "以上所有数据来自真实数据源，缺失块已显式列出（不冒充实数）",
  }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" } });
}
