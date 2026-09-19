// 个股资金画像 API（需求文档 P0：输入代码 → 自动拉全量 → 结构化报告）
// 每个数据块带来源/接口/时间/状态（REAL_DATA_ONLY：缺失块显式标「暂缺」，不冒充实数）。
import { NextResponse } from "next/server";
import { quantBootstrap, } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { tdxQuotes, tdxDepth, tdxTradesMoney } from "@/lib/desk/tdx";
import { fetchQuotesReal, fetchDetailReal, fetchNewsReal, fetchBoardReal, symbolToSecid } from "@/lib/desk/em";
import { marketSession, shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { computeSentiment, evalLimitSnapshot } from "@/lib/quant/screener/sentiment";
import { buildFieldPanel, lastValues, type BarsLike } from "@/lib/quant/factors/fields";
import { historicalWinProbability, type WinProbStats } from "@/lib/quant/factors/probability";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYM_RE = /^\d{6}\.(SH|SZ|BJ)$/i;

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!SYM_RE.test(symbol)) {
    return NextResponse.json({ ok: false, error: "代码格式应为 688256.SH / 000001.SZ / 430047.BJ" }, { status: 400 });
  }
  const now = new Date();
  const asOf = shanghaiStamp(now);
  const session = marketSession(now);
  const statusLive = session.open ? "LIVE" : "HISTORICAL";
  const missing: string[] = [];

  // 1) 实时报价：eltdx → 腾讯
  let quote: { price: number; changePct: number; high: number; low: number; prevClose: number; amountYi: number } | null = null;
  let quoteSource = "";
  const tq = await tdxQuotes([symbol]).catch(() => null);
  if (tq?.get(symbol)) {
    const q = tq.get(symbol)!;
    quote = { price: q.price, changePct: q.changePct, high: q.high, low: q.low, prevClose: q.prevClose, amountYi: q.amountYi };
    quoteSource = "eltdx · quotes.get_snapshots";
  } else {
    const qs = await fetchQuotesReal([symbol]).catch(() => null);
    const q = qs?.[0];
    if (q) {
      quote = { price: q.price, changePct: q.changePct, high: q.high ?? q.price, low: q.low ?? q.price, prevClose: q.prevClose ?? q.price, amountYi: q.amountYi ?? 0 };
      quoteSource = "腾讯 · qt.gtimg.cn";
    }
  }
  if (!quote) missing.push("实时报价");

  // 2) 五档盘口（仅 eltdx）
  const depth = (await tdxDepth([symbol]).catch(() => null))?.get(symbol) ?? null;
  if (!depth) missing.push("五档盘口（eltdx 网关未运行或不可用）");

  // 3) 逐笔主动买卖（仅 eltdx，近2页近似口径）
  const trades = await tdxTradesMoney(symbol).catch(() => null);
  if (!trades) missing.push("逐笔主动买卖（eltdx 网关未运行或不可用）");

  // 4) 日K（腾讯带成交量）→ 技术指标 + 历史条件概率
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate(now);
  let bars: BarsLike[] = [];
  let meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  try {
    const barsMap = await fetchBarsHybrid([symbol], tradeDate, 480);
    bars = (barsMap.get(symbol) ?? []) as BarsLike[];
  } catch { /* 由技术面缺失兜底 */ }
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

  // 5) 资金流：东财 14 日主力净额
  const secid = symbolToSecid(symbol);
  const detail = secid ? await fetchDetailReal(secid).catch(() => null) : null;
  if (!detail) missing.push("主力资金流（东财接口被限流或不可用）");

  // 6) 板块：行业 + 板块涨幅榜排名
  let sector: { name: string; changePct: number; rank: number; mainYi: number; count: number } | null = null;
  if (meta?.industry) {
    const boards = await fetchBoardReal("industry", "in", 90).catch(() => null);
    const row = boards?.find((b) => b.name === meta?.industry);
    if (row && boards) sector = { name: row.name, changePct: row.changePct, rank: boards.indexOf(row) + 1, mainYi: row.main, count: boards.length };
  }
  if (!sector) missing.push("板块强度（行业未匹配到榜单）");

  // 7) 新闻：宏观快讯可得；个股新闻无数据源 → 暂缺
  const news = await fetchNewsReal(8).catch(() => null);
  if (!news) missing.push("宏观快讯");
  missing.push("个股新闻（无个股级新闻数据源）");

  // 8) 市场风险（共用情绪计算，universe 走缓存，开销小）
  let risk: { level: string; triggers: string[] } | null = null;
  try {
    const s = await computeSentiment();
    risk = { level: s.risk.level, triggers: s.risk.triggers };
  } catch { /* 风险块缺失可容忍 */ }

  return NextResponse.json({
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
        source: "eltdx · quotes.get_depth", status: statusLive,
      } : null,
      trades: trades ? {
        data: {
          buyAmountYi: trades.buyAmountYi, sellAmountYi: trades.sellAmountYi,
          netYi: trades.netYi, outerHand: trades.outerHand, insideHand: trades.insideHand,
          avgPrice: trades.avgPrice, basis: trades.basis,
        },
        source: "eltdx · quotes.get_snapshots（内外盘）",
        note: "主动买卖金额为系统按内外盘×成交均价计算的代理指标，非交易所官方主力资金统计",
        status: statusLive,
      } : null,
      fundflow: detail ? {
        data: {
          todayYi: detail.days.at(-1)?.value ?? null,
          spark: detail.spark, days: detail.days,
        },
        source: "东财 · push2his 主力净额", status: "LIVE",
      } : null,
      tech: bars.length >= 60 ? { data: tech, source: "腾讯日K · 本机指标计算（未验证因子）", status: "HISTORICAL" } : null,
      probability: winProb ? { data: winProb, source: "腾讯日K · 历史条件概率引擎", note: "条件：站上MA20 且 站上20日成本线（K线口径）", status: "HISTORICAL" } : null,
      sector: sector ? { data: sector, source: "东财 · 行业资金榜", status: "LIVE" } : null,
      news: news ? { data: news.slice(0, 6), source: "东财7x24/新浪 · 宏观快讯", status: "LIVE" } : null,
      risk: risk ? { data: risk, source: "全A快照风险引擎", status: "LIVE" } : null,
    },
    missing,
    source_note: "REAL_DATA_ONLY=true：以上所有数据来自真实数据源，缺失块已显式列出",
  }, { headers: { "Cache-Control": "no-store" } });
}
