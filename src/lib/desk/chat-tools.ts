// P7-⑥① 对话工具层（服务层：只取数，不判定）。
//
// 为什么从 /api/ai/chat 的路由里搬出来：这一层要做的事情（拿真实行情、算指标、跑选股）
// 与「谁来问」无关。搬出来之后，工具调用环（/api/ai/chat）和自动调度（scene-dispatch）
// 用的是同一份实现——否则同一个「今天大盘情绪」在两条链路上可能算出两个数，那才是真事故。
//
// 数据纪律（沿用 P6-A/P7-④ 的口径，本层一条不放松）：
//  - 全部走真实接口（eltdx / 东财 / 腾讯 / 本机指标计算），没有任何演示值兜底；
//  - 取不到一律返回 {missing: 原因}，**不返回 0、不返回空数组冒充「没有符合的」**；
//  - 「取数失败」与「确实没这么长的历史」必须分开写，否则模型会把限流说成历史不足；
//  - 每个返回值自带 数据源 字段，前端与模型都能看到这条数据是从哪儿来的。
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { runScreener } from "@/lib/quant/screener/run";
import { buildFieldPanel, lastValues, type BarsLike } from "@/lib/quant/factors/fields";
import { historicalWinProbability, type ScreenerCond } from "@/lib/quant/factors/probability";
import { getProvider } from "@/lib/quant/data/index";
import { fetchBarsHybridTracked } from "@/lib/quant/data/hybrid";
import { tdxQuotes, tdxDepth, tdxTradesMoney } from "./tdx";
import { fetchQuotesReal, fetchDetailReal, fetchNewsReal, fetchBoardReal, symbolToSecid } from "./em";
import { shanghaiDate } from "./session";

/** 一次工具调用能看到的请求级上下文（只有本机存档才有的东西走这里传，不查库） */
export interface ToolCtx {
  /** 用户本机自选清单（浏览器存档随请求带上；本层只负责给这些代码取真实行情） */
  watchlist?: { symbol: string; name?: string | null }[];
}

/**
 * 一次自选概览最多取多少只：清单来自浏览器存档，条数由用户自己堆。
 * 上限是为了不在一轮对话里并发打爆行情接口；超出部分不静默丢，结果里写明「只看了前 N 只」。
 */
export const WATCHLIST_MAX = 200;

export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    if (/^(60|68|9)/.test(s)) return `${s}.SH`;
    if (/^(43|83|87|92)/.test(s)) return `${s}.BJ`;
    return `${s}.SZ`;
  }
  return null;
}

async function toolMarketSentiment(): Promise<unknown> {
  const s = await computeSentiment();
  return {
    trade_date: s.trade_date, live: s.live,
    涨跌: { 上涨: s.advancers, 下跌: s.decliners, 平盘: s.flat, 总数: s.total },
    涨停: s.limit_up, 跌停: s.limit_down,
    成交额亿: Math.round(s.amount_total_yi), 全A主力净额亿: Math.round(s.main_net_sum_yi),
    中位涨跌幅: s.median_pct,
    指数: s.indices,
    风险等级: s.risk.level, 风险触发: s.risk.triggers,
    missing: s.missing,
  };
}

async function toolSectorRank(args: { kind?: string; size?: number }): Promise<unknown> {
  const kind = args.kind === "concept" ? "concept" : "industry";
  const rows = await fetchBoardReal(kind, "in", Math.min(30, Math.max(5, args.size ?? 15)));
  if (!rows) return { missing: `${kind}板块资金榜暂无数据（东财接口失败）` };
  return {
    数据源: "东财板块资金榜（主力净流入排序）",
    板块: rows.map((r, i) => ({ 排名: i + 1, 名称: r.name, 涨跌幅: r.changePct, 主力净额亿: r.main, 领涨股: r.leader })),
  };
}

async function toolStockSnapshot(args: { symbol: string }): Promise<unknown> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return { missing: `无法识别代码：${args.symbol}（应为 688256 或 688256.SH）` };
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate();
  const meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  const q = (await tdxQuotes([symbol]).catch(() => null))?.get(symbol)
    ?? ((await fetchQuotesReal([symbol]).catch(() => []))[0] ?? null);
  if (!q && !meta) return { missing: `${symbol} 快照暂无数据` };
  return {
    symbol,
    名称: meta?.name ?? null,
    现价: q?.price ?? meta?.price ?? null,
    涨跌幅: q?.changePct ?? meta?.changePct ?? null,
    成交额亿: q?.amountYi ?? (meta?.amount != null ? meta.amount / 1e8 : null),
    换手率: meta?.turnover ?? null, 量比: meta?.volumeRatio ?? null,
    市盈率TTM: meta?.pe ?? null, 市净率: meta?.pb ?? null,
    总市值亿: meta?.marketCap != null ? meta.marketCap / 1e8 : null,
    主力净额亿: meta?.mainNet != null ? meta.mainNet / 1e8 : null,
    行业: meta?.industry ?? null,
    数据源: "eltdx/腾讯快照 + 东财 clist",
  };
}

async function toolStockDepth(args: { symbol: string }): Promise<unknown> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return { missing: `无法识别代码：${args.symbol}` };
  const d = (await tdxDepth([symbol]).catch(() => null))?.get(symbol);
  if (!d) return { missing: "五档盘口暂无数据（eltdx 网关未运行）" };
  const sum = (arr: { volume: number }[]) => arr.reduce((s, l) => s + l.volume, 0);
  return {
    symbol, 数据源: "eltdx · quotes.get_depth",
    买五档: d.bids, 卖五档: d.asks,
    委买总量手: sum(d.bids), 委卖总量手: sum(d.asks),
    委买卖比: sum(d.asks) > 0 ? +(sum(d.bids) / sum(d.asks)).toFixed(2) : null,
    内盘手: d.insideHand, 外盘手: d.outerHand,
  };
}

async function toolStockTrades(args: { symbol: string }): Promise<unknown> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return { missing: `无法识别代码：${args.symbol}` };
  const t = await tdxTradesMoney(symbol).catch(() => null);
  if (!t) return { missing: "主动买卖数据暂无（eltdx 网关未运行）" };
  return {
    symbol, 数据源: "eltdx 快照内外盘（全日累计，代理指标）",
    口径: t.basis,
    主动买入亿: +t.buyAmountYi.toFixed(2), 主动卖出亿: +t.sellAmountYi.toFixed(2),
    主动净额亿: +t.netYi.toFixed(2),
    外盘手: t.outerHand, 内盘手: t.insideHand, 成交均价: +t.avgPrice.toFixed(2),
  };
}

async function toolStockKline(args: { symbol: string }): Promise<unknown> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return { missing: `无法识别代码：${args.symbol}` };
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate();
  const meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  const barsRes = await fetchBarsHybridTracked([symbol], tradeDate, 480);
  const bars = (barsRes.bars.get(symbol) ?? []) as BarsLike[];
  if (!bars.length) {
    // 取数失败与「这只票确实没这么长历史」是两件事，工具返回值必须分开，否则模型会把限流说成「历史不足」
    const oc = barsRes.outcomes[0];
    return { missing: oc?.kind === "request_failed" ? `日K取数失败：${oc.reason}` : "日K无返回（本标的未取到任何K线）" };
  }
  if (bars.length < 60) return { missing: `日K历史不足（仅 ${bars.length} 根，需 ≥60），无法计算技术状态` };
  const panel = buildFieldPanel([symbol], [bars], [meta]);
  const vals = lastValues(panel).get(symbol) ?? new Map();
  const pick = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, vals.get(k) ?? null]));
  const winProb = historicalWinProbability({
    symbol, bars, meta,
    conditions: [{ field: "above_ma_20", op: "=", value: 1 }, { field: "vwap20_filter", op: "=", value: 1 }],
  });
  return {
    symbol,
    数据源: barsRes.outcomes[0]?.channel === "tdx"
      ? "eltdx 日K（本机直连网关）+ 本机指标计算（未验证因子）"
      : "腾讯日K（eltdx 未取到，本条为兜底口径）+ 本机指标计算（未验证因子）",
    最近5日: bars.slice(-5).map((b) => ({ 日期: b.date, 开: b.o, 高: b.h, 低: b.l, 收: b.c })),
    技术状态: pick("above_ma_5", "above_ma_10", "above_ma_20", "above_ma_60", "above_ma_144", "ma_struct",
      "macd", "macd_cross", "kdj_cross", "rsi_14", "vwap20_filter", "vwap_pos", "rps_50", "rps_120", "is_limit_up"),
    历史条件概率: winProb ? {
      条件: "站上MA20且站上20日成本线",
      统计: winProb.horizons.map((h) => ({ 持有日: h.h, 胜率: h.win_rate?.toFixed(0) + "%", 样本: h.sample_size })),
      统计区间: winProb.period, 样本是否充足: winProb.sample_ok, 提示: winProb.warnings,
    } : null,
  };
}

async function toolStockFundFlow(args: { symbol: string }): Promise<unknown> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return { missing: `无法识别代码：${args.symbol}` };
  const secid = symbolToSecid(symbol);
  const detail = secid ? await fetchDetailReal(secid).catch(() => null) : null;
  if (!detail) return { missing: "主力资金流暂无数据（东财接口失败/被限流）" };
  return {
    symbol, 数据源: "东财 · push2his 主力净额",
    今日主力净额亿: detail.days.at(-1)?.value ?? null,
    近14日: detail.days.map((d) => ({ 日期: d.date, 主力净额亿: d.value })),
  };
}

async function toolMarketNews(args: { limit?: number }): Promise<unknown> {
  const rows = await fetchNewsReal(Math.min(15, Math.max(5, args.limit ?? 10))).catch(() => null);
  if (!rows) return { missing: "宏观快讯暂无数据" };
  return { 数据源: "东财7x24/新浪快讯", 快讯: rows };
}

async function toolFactorScreener(args: { conditions: ScreenerCond[]; limit?: number }): Promise<unknown> {
  const conds = Array.isArray(args.conditions) ? args.conditions : [];
  if (!conds.length) return { missing: "conditions 为空：需要至少一个 {field, op, value}" };
  const result = await runScreener({
    universe: "all_a",
    conditions: conds,
    fields: ["change_pct", "turnover_rate", "amount_yi", "main_net_yi", "rps_50"],
    sort: { order_by: "amount_yi", order_dir: "desc" },
    pagination: { limit: Math.min(20, Math.max(3, args.limit ?? 10)) },
    maxKlineSymbols: 120,
  });
  return {
    funnel: result.funnel, trade_date: result.as_of_trade_date,
    数据源: result.source.provider, 口径提示: result.warnings,
    结果: result.list.map((r) => ({
      代码: r.symbol, 名称: r.name, 现价: r.close, 涨跌幅: r.change_pct, ...r.values,
    })),
  };
}

async function toolHistoricalProbability(args: { symbol: string; conditions: ScreenerCond[] }): Promise<unknown> {
  const symbol = normalizeSymbol(args.symbol ?? "");
  if (!symbol) return { missing: `无法识别代码：${args.symbol}` };
  const conds = Array.isArray(args.conditions) ? args.conditions : [];
  if (!conds.length) return { missing: "conditions 为空" };
  const provider = await getProvider("em");
  const tradeDate = shanghaiDate();
  const meta = (await provider.listUniverse({ kind: "custom", symbols: [symbol] }, tradeDate).catch(() => []))[0];
  const barsRes = await fetchBarsHybridTracked([symbol], tradeDate, 480);
  const bars = (barsRes.bars.get(symbol) ?? []) as BarsLike[];
  if (!bars.length) {
    const oc = barsRes.outcomes[0];
    return { missing: oc?.kind === "request_failed" ? `日K取数失败：${oc.reason}` : "日K无返回（本标的未取到任何K线）" };
  }
  if (bars.length < 120) return { missing: `日K历史不足（仅 ${bars.length} 根，需 ≥120），无法统计` };
  const stats = historicalWinProbability({ symbol, bars, meta, conditions: conds });
  if (!stats) return { missing: "条件无法识别（字段不在因子目录内）" };
  return {
    symbol, 条件: conds, 统计: stats.horizons.map((h) => ({
      持有日: h.h, 胜率: h.win_rate?.toFixed(1) + "%", 样本: h.sample_size,
      平均收益: h.avg_return?.toFixed(2) + "%", 最差收益: h.worst_return?.toFixed(2) + "%",
    })),
    统计区间: stats.period, 样本是否充足: stats.sample_ok, 口径提示: stats.warnings,
  };
}

/**
 * 自选股总览（P7-⑥④ 新增）。
 * 口径要说清楚两件事：**清单**来自用户本机浏览器存档（不是交易所或东财给的），
 * **行情**是这一步现取的真实报价。清单为空时返回 missing，而不是回一个空列表冒充「你的自选都没动」。
 */
async function toolWatchlistOverview(args: { symbols?: string[] }, ctx: ToolCtx = {}): Promise<unknown> {
  const fromArgs = Array.isArray(args.symbols) ? args.symbols.map((s) => String(s)) : [];
  const stored = (ctx.watchlist ?? []).map((w) => w.symbol);
  const raw = fromArgs.length ? fromArgs : stored;
  if (!raw.length) return { missing: "自选清单为空（本机存档里没有自选，或本次请求未带清单）" };
  // 去重 + 上限：清单是浏览器带来的，重复项和一次塞几千条都可能发生。
  // 截断必须在结果里写明（否则模型会把「只看了前 200 只」说成「你的自选都看了」）。
  const unique: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const s of raw) {
    const sym = normalizeSymbol(s);
    if (!sym) continue;
    if (seen.has(sym)) { duplicates++; continue; }
    seen.add(sym);
    unique.push(sym);
  }
  const symbols = unique.slice(0, WATCHLIST_MAX);
  const truncated = unique.length - symbols.length;
  const unrecognized = raw.length - unique.length - duplicates;
  if (!symbols.length) return { missing: `自选清单里的代码都无法识别：${raw.slice(0, 5).join(", ")}` };
  const nameOf = new Map<string, string | null>((ctx.watchlist ?? []).map((w) => [w.symbol, w.name ?? null] as const));
  const [quotes, metaRows] = await Promise.all([
    tdxQuotes(symbols).catch(() => null),
    getProvider("em").then((p) => p.listUniverse({ kind: "custom", symbols }, shanghaiDate()).catch(() => [])),
  ]);
  const metas = new Map<string, (typeof metaRows)[number]>((metaRows ?? []).map((m) => [m.symbol, m] as const));
  const rows = symbols.map((sym) => {
    const q = quotes?.get(sym) ?? null;
    const meta = metas.get(sym);
    return {
      symbol: sym,
      名称: meta?.name ?? nameOf.get(sym) ?? null,
      现价: q?.price ?? meta?.price ?? null,
      涨跌幅: q?.changePct ?? meta?.changePct ?? null,
      主力净额亿: meta?.mainNet != null ? Number(meta.mainNet) / 1e8 : null,
      成交额亿: q?.amountYi ?? (meta?.amount != null ? Number(meta.amount) / 1e8 : null),
      换手率: meta?.turnover ?? null,
    };
  });
  return {
    清单来源: "用户本机自选存档（浏览器 localStorage，随请求带上，非交易所数据）",
    数据源: "eltdx/腾讯实时快照 + 东财 clist",
    取数时刻: shanghaiDate(),
    自选: rows,
    家数: rows.length,
    // 三种「少了几只」原因分开写：把识别失败说成去重、或把截断说成没数据，都会让模型的结论对不上事实
    ...(raw.length - symbols.length > 0
      ? {
          未计入: [
            duplicates > 0 ? `${duplicates} 条重复代码已合并` : "",
            truncated > 0 ? `${truncated} 条超出单次上限（${WATCHLIST_MAX} 只）未取数，只看了前 ${WATCHLIST_MAX} 只` : "",
            unrecognized > 0 ? `${unrecognized} 个代码无法识别` : "",
          ].filter(Boolean).join("；"),
        }
      : {}),
  };
}

export interface ChatTool {
  name: string;
  desc: string;
  /**
   * 工具入参形状不同，运行时传的就是模型/调度层给的那份 JSON，所以这里只能是 any：
   * 工具体内自己判空并回 missing。（项目没开 no-explicit-any 规则，不需要 disable 注释。）
   */
  fn: (args: any, ctx?: ToolCtx) => Promise<unknown>;
  params: Record<string, any>;
}

export const TOOLS: ChatTool[] = [
  { name: "market_sentiment", desc: "大盘情绪：涨跌家数/涨停/跌停/成交额/主力净额/风险等级", fn: toolMarketSentiment, params: { type: "object", properties: {} } },
  { name: "sector_rank", desc: "行业/概念板块资金榜（按主力净流入排序）", fn: toolSectorRank, params: { type: "object", properties: { kind: { type: "string", enum: ["industry", "concept"] }, size: { type: "number" } } } },
  { name: "stock_snapshot", desc: "个股实时快照：价格/涨跌幅/换手/量比/估值/主力净额/行业", fn: toolStockSnapshot, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "stock_depth", desc: "个股五档盘口（eltdx）", fn: toolStockDepth, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "stock_trades", desc: "个股主动买卖金额（内外盘全日口径，代理指标）", fn: toolStockTrades, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "stock_kline_summary", desc: "个股技术状态：均线/MACD/KDJ/RSI/VWAP/RPS + 历史条件概率", fn: toolStockKline, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "stock_fund_flow", desc: "个股近14日主力资金净额（东财）", fn: toolStockFundFlow, params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "market_news", desc: "最新宏观/市场快讯", fn: toolMarketNews, params: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "factor_screener", desc: "全A条件选股：conditions=[{field,op,value}]，field 必须来自因子目录", fn: toolFactorScreener, params: { type: "object", properties: { conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string", enum: ["=", ">=", ">", "<=", "<", "!="] }, value: { type: ["number", "string"] } }, required: ["field", "op", "value"] } }, limit: { type: "number" } }, required: ["conditions"] } },
  { name: "historical_probability", desc: "个股历史条件概率：conditions 中的 field 必须来自因子目录", fn: toolHistoricalProbability, params: { type: "object", properties: { symbol: { type: "string" }, conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" }, value: { type: ["number", "string"] } }, required: ["field", "op", "value"] } } }, required: ["symbol", "conditions"] } },
  { name: "watchlist_overview", desc: "自选股实时总览（清单取自用户本机存档，行情现取）", fn: toolWatchlistOverview, params: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } } } },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function findTool(name: string): ChatTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 因子目录一行（提示词与自动调度都要用同一份，写两遍迟早对不上） */
export const FACTOR_KEYS = "pe_ttm,pb,market_cap_yi,floatcap_yi,change_pct,turnover_rate,volume_ratio,amplitude,amount_yi,is_limit_up,double_volume_signal,volume_signal,above_ma_5/10/20/60/90/144,ma_struct,rps_50,rps_120,rps_composite,macd_dif/macd_dea/macd/macd_cross,kdj_k/kdj_d/kdj_j/kdj_cross,rsi_7/14/24,main_net_yi,above_cost_20,break_cost_20,vwap20_filter,vwap_pos,vwap20_up3,breakout_high_20,breakout_high_60";
