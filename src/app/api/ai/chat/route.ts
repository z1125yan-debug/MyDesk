// AI 交易员对话后端（需求文档 六/二十五/二十六/二十七）
// 流程：用户问题 → LLM 生成 Tool Plan → 并行执行工具（真实数据）→ 结果回填 → LLM 生成回答。
// 硬规则：
//  - AI 不得编造数据：所有市场数据一律由工具返回的真实接口数据提供；
//  - 数据缺失 → 工具返回 {missing:...}，提示词要求显式写「暂无数据」，禁止推测；
//  - 输出必须区分【事实】/【模型推断】/【风险】；不给买卖建议；
//  - 证据链：每次工具调用记录名称/参数/耗时/状态，随响应返回前端展示。
// 仅支持 OpenAI 兼容接口（tools 能力）；Anthropic/Gemini 原生协议请用「智能助手」页。
import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { runScreener } from "@/lib/quant/screener/run";
import { buildFieldPanel, lastValues, type BarsLike } from "@/lib/quant/factors/fields";
import { historicalWinProbability, type ScreenerCond } from "@/lib/quant/factors/probability";
import { getProvider } from "@/lib/quant/data/index";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { tdxQuotes, tdxDepth, tdxTradesMoney } from "@/lib/desk/tdx";
import { fetchQuotesReal, fetchDetailReal, fetchNewsReal, fetchBoardReal, symbolToSecid } from "@/lib/desk/em";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OPENAI_COMPAT = new Set(["openai", "deepseek", "moonshot", "openrouter", "ollama", "custom"]);

// ---------- 代理（与 /api/ai/proxy 同规则，简化版） ----------

let sysProxyCache: { at: number; url: string | null } | null = null;
async function windowsSystemProxy(): Promise<string | null> {
  if (sysProxyCache && Date.now() - sysProxyCache.at < 300_000) return sysProxyCache.url;
  sysProxyCache = { at: Date.now(), url: null };
  try {
    const { exec } = await import("node:child_process");
    const run = (cmd: string) => new Promise<string>((resolve) => exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout))));
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const [enOut, svOut] = await Promise.all([run(`reg query "${key}" /v ProxyEnable`), run(`reg query "${key}" /v ProxyServer`)]);
    if (!/0x1\b/.test(enOut)) return null;
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(svOut);
    if (!m) return null;
    let v = m[1].trim();
    if (v.includes(";")) { const pick = /(?:^|;)https?=([^;]+)/.exec(v); v = pick ? pick[1] : v.split(";")[0].split("=")[1] ?? ""; }
    if (!v || !/[\w.]+:\d+/.test(v)) return null;
    if (!/^https?:\/\//.test(v)) v = `http://${v}`;
    sysProxyCache.url = v;
  } catch { /* 保持直连 */ }
  return sysProxyCache.url;
}

function isLanUrl(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
}

async function resolveProxy(req: NextRequest, baseUrl: string): Promise<ProxyAgent | null> {
  if (isLanUrl(baseUrl)) return null;
  let url: string | null = (req.headers.get("x-ai-proxy") ?? "").trim() || null;
  if (!url) url = process.env.AI_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || (await windowsSystemProxy());
  if (!url || /^(direct|off|none)$/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return new ProxyAgent(url);
}

// ---------- 工具实现（全部走真实数据源） ----------

function normalizeSymbol(raw: string): string | null {
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
  const barsMap = await fetchBarsHybrid([symbol], tradeDate, 480);
  const bars = (barsMap.get(symbol) ?? []) as BarsLike[];
  if (bars.length < 60) return { missing: "日K历史不足，无法计算技术状态" };
  const panel = buildFieldPanel([symbol], [bars], [meta]);
  const vals = lastValues(panel).get(symbol) ?? new Map();
  const pick = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, vals.get(k) ?? null]));
  const winProb = historicalWinProbability({
    symbol, bars, meta,
    conditions: [{ field: "above_ma_20", op: "=", value: 1 }, { field: "vwap20_filter", op: "=", value: 1 }],
  });
  return {
    symbol, 数据源: "腾讯日K + 本机指标计算（未验证因子）",
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
  const barsMap = await fetchBarsHybrid([symbol], tradeDate, 480);
  const bars = (barsMap.get(symbol) ?? []) as BarsLike[];
  if (bars.length < 120) return { missing: "日K历史不足，无法统计" };
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

const TOOLS = [
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
];

const FACTOR_KEYS = "pe_ttm,pb,market_cap_yi,floatcap_yi,change_pct,turnover_rate,volume_ratio,amplitude,amount_yi,is_limit_up,double_volume_signal,volume_signal,above_ma_5/10/20/60/90/144,ma_struct,rps_50,rps_120,rps_composite,macd_dif/macd_dea/macd/macd_cross,kdj_k/kdj_d/kdj_j/kdj_cross,rsi_7/14/24,main_net_yi,above_cost_20,break_cost_20,vwap20_filter,vwap_pos,vwap20_up3,breakout_high_20,breakout_high_60";

function systemPrompt(mode: string, focusSymbol?: string): string {
  const today = new Date().toLocaleDateString("zh-CN");
  const modeNote: Record<string, string> = {
    decision: "决策模式：面向操作前的快速研判，结论前置、证据充分。",
    judge: "研判模式：侧重技术结构与资金结构的客观描述，减少主观倾向。",
    deep: "深度思考模式：先梳理数据，再做逻辑推演，最后给风险清单。",
    search: "实时搜索模式：优先引用 market_news 返回的真实快讯，注明时间；无数据则明说。",
  };
  return [
    `你是 MyDesk 的 AI 交易员分析引擎。今天是 ${today}。${modeNote[mode] ?? ""}`,
    focusSymbol ? `用户当前关注标的：${focusSymbol}。` : "",
    "",
    "【数据纪律（最高优先级）】",
    "1. 所有市场数据必须通过工具获取真实数据，绝不编造数字。",
    "2. 工具返回 missing 或数据为 null 时，必须写「XX：暂无数据」，禁止根据涨跌幅推测「主力流入」等无数据结论。",
    "3. 相关个股问题并行调用：stock_snapshot + stock_depth + stock_trades + stock_kline_summary + stock_fund_flow。",
    "4. 选股类问题用 factor_screener（field 只能取：" + FACTOR_KEYS + "）。",
    "",
    "【输出格式（固定）】",
    "1. **结论**（1-2 句，仅陈述结构状态）",
    "2. **事实**：只引用工具返回的数据，标注数据源与时间；缺失块写「暂无数据」",
    "3. **模型推断**：与历史样本/常见结构的对照，明确标注是推断",
    "4. **风险提示**：反向条件、逻辑失效点",
    "不给直接买卖建议，不预测涨跌幅目标；概率必须带样本数。",
    "简体中文，简洁 markdown，表格最多 1 个。",
  ].filter(Boolean).join("\n");
}

interface ToolCallMsg { id: string; type: "function"; function: { name: string; arguments: string } }

export async function POST(req: NextRequest) {
  quantBootstrap();
  const provider = req.headers.get("x-ai-provider") ?? "";
  const baseUrl = (req.headers.get("x-ai-base-url") ?? "").trim();
  const apiKey = req.headers.get("x-ai-api-key") ?? "";
  const model = (req.headers.get("x-ai-model") ?? "").trim();
  if (!OPENAI_COMPAT.has(provider)) {
    return NextResponse.json({ error: "AI 交易员的工具调用需要 OpenAI 兼容接口（DeepSeek/OpenAI/Moonshot/OpenRouter/Ollama/自定义中转），请在设置中切换" }, { status: 400 });
  }
  if (!baseUrl || !model) {
    return NextResponse.json({ error: "AI 未配置：请到「设置 → AI 接口」填写接口地址与模型" }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as {
    messages?: { role: "user" | "assistant"; content: string }[];
    mode?: string;
    focusSymbol?: string;
  } | null;
  const history = (body?.messages ?? []).slice(-12);
  if (!history.length) return NextResponse.json({ error: "消息为空" }, { status: 400 });

  const agent = await resolveProxy(req, baseUrl);
  const apiBase = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = `${apiBase}/v1/chat/completions`;
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.desc, parameters: t.params } }));

  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemPrompt(body?.mode ?? "decision", body?.focusSymbol) },
    ...history,
  ];

  const trace: { name: string; args: Record<string, unknown>; ms: number; status: "ok" | "error"; summary: string }[] = [];
  let content = "";
  try {
    for (let round = 0; round < 5; round++) {
      const res = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.3 }),
        dispatcher: agent ?? undefined,
        signal: AbortSignal.timeout(90_000),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        return NextResponse.json({ error: j?.error?.message || `上游返回 ${res.status}` }, { status: 502 });
      }
      const msg = j?.choices?.[0]?.message;
      const toolCalls: ToolCallMsg[] = msg?.tool_calls ?? [];
      if (!toolCalls.length) {
        content = String(msg?.content ?? "");
        break;
      }
      messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: toolCalls });
      const results = await Promise.all(toolCalls.map(async (tc) => {
        const started = Date.now();
        let out: unknown;
        let status: "ok" | "error" = "ok";
        try {
          const fn = TOOLS.find((t) => t.name === tc.function.name);
          if (!fn) out = { missing: `未知工具 ${tc.function.name}` };
          else out = await fn.fn(JSON.parse(tc.function.arguments || "{}"));
        } catch (e) {
          out = { missing: `工具执行失败：${(e as Error).message}` };
          status = "error";
        }
        const ms = Date.now() - started;
        const text = JSON.stringify(out);
        trace.push({
          name: tc.function.name,
          args: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch { return {}; } })(),
          ms, status,
          summary: text.length > 120 ? text.slice(0, 120) + "…" : text,
        });
        return { role: "tool", tool_call_id: tc.id, content: text.slice(0, 6000) };
      }));
      messages.push(...results);
    }
    if (!content) content = "（工具调用轮次已达上限，未能生成结论；请缩小问题范围后重试）";
    return NextResponse.json({ content, trace, mode: body?.mode ?? "decision" });
  } catch (e) {
    return NextResponse.json({ error: `AI 调用失败：${(e as Error).message}`, trace }, { status: 502 });
  }
}
