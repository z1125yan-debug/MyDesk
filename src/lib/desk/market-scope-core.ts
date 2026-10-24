// 市场分流纯核：LLM 分析 / AI 对话 / 事件 AI 理解三条链路共用同一份「当前市场」口径。
//
// 为什么必须有这一层（事故）：行情页的 marketTab（A/HK/US）只在行情页生效，
// 三条 LLM 链路谁都不读它——服务端场景预取永远取 A 股情绪/板块资金、提示词里也没有
// 市场声明，于是美股页面问「今天大盘怎么样」，模型拿着 A 股的涨跌家数、涨停数、
// 主力净额当美股回答。分流不是「提示词里提一句美股」，而是三件同时做：
// ① 客户端把当前市场随请求带上（marketTab 是唯一口径，不各页各猜）；
// ② 服务端按当前市场注入分流提示词块（本文件 marketScopePrompt）；
// ③ 服务端按当前市场关掉 A 股专属预取（scene-dispatch 按 A_SHARE_ONLY_TOOLS 过滤，
// 结论卡/交易日历等 A 股引擎也不在非 A 股轮次里跑）。
// 缺数据时三条链路都按「缺就是缺」：非 A 股市场没有 A 股工具的等价物，不拿 A 股数据顶替。
//
// 本文件零依赖、可 node --test 直跑；判定与文案都在这里，调用方只做接线。

export type MarketScope = "A" | "HK" | "US";

/** 外部输入（请求体 market / store.marketTab）过白名单：认不出 = null，不猜、不默认成 A 股。 */
export function asMarketScope(v: unknown): MarketScope | null {
if (v === "A" || v === "HK" || v === "US") return v;
return null;
}

export const MARKET_SCOPE_LABEL: Record<MarketScope, string> = {
A: "A股",
HK: "港股",
US: "美股",
};

/** 当前市场的计价货币：价位单位错市场等于数字错市场，提示词里必须点名。 */
export const MARKET_SCOPE_CURRENCY: Record<MarketScope, string> = {
A: "人民币元",
HK: "港元",
US: "美元",
};

/**
* 按代码推断所属市场（只认形状，不查库）：
*.SH/.SZ/.BJ 后缀、6 位数字 = A 股；.HK 后缀、5 位数字 = 港股；
*.US 后缀、纯字母代码（如 NVDA）= 美股；其余 = null（不知道就不猜）。
*/
export function inferMarketScopeFromSymbol(symbol: unknown): MarketScope | null {
const s = String(symbol?? "").trim().toUpperCase();
if (!s) return null;
if (s.endsWith(".HK")) return "HK";
if (s.endsWith(".US")) return "US";
if (s.endsWith(".SH") || s.endsWith(".SZ") || s.endsWith(".BJ")) return "A";
const bare = s.split(".")[0];
if (/^\d{6}$/.test(bare)) return "A";
if (/^\d{5}$/.test(bare)) return "HK";
if (/^[A-Z]{1,5}$/.test(bare)) return "US";
return null;
}

/**
* A 股专属工具：取数口径、指数、资金、板块、财报、日历全部只覆盖 A 股，
* 在港股/美股轮次里调用它拿到的数（即使返回了东西）也是 A 股的数，不能引用。
* stock_*（快照/盘口/K线/资金/新闻）不在此列：它们按入参代码取数，约束在提示词里
* （「只用当前市场的代码调」），而不是按工具名一刀切——否则明确问某只港股/美股时
* 连按代码取数的路都被堵死；取不到时它们回 missing，提示词要求如实写暂无数据。
*/
export const A_SHARE_ONLY_TOOLS: ReadonlySet<string> = new Set([
"market_sentiment",
"sector_rank",
"sector_constituents",
"sector_breadth",
"factor_screener",
"tdx_market_overview",
"tdx_quotes",
"tdx_kline",
"market_calendar_effect",
"stock_business_composition",
"run_backtest",
]);

/**
* 分流提示词块：服务端注入，客户端（AnalysisPage 等一次一问的调用）复用同一份。
* 结构固定：当前市场声明 → 该市场可用什么 → 其它市场数据怎么处理 → 禁止事项。
* 文案里不带任何行情数字——数字只能来自工具返回，提示词只给「什么能说什么不能说」的纪律。
*/
export function marketScopePrompt(market: MarketScope): string {
const label = MARKET_SCOPE_LABEL[market];
const currency = MARKET_SCOPE_CURRENCY[market];
const others = (["A", "HK", "US"] as const).filter((m) => m!== market).map((m) => MARKET_SCOPE_LABEL[m]).join(" / ");
const forbiddenTools = [...A_SHARE_ONLY_TOOLS].join(" / ");
const common = [
``,
`当前市场：${label}。本轮只回答${label}的数据与结论；价位单位是${currency}，不要把其它市场的货币单位套到本轮价位上。`,
`只引用本轮取到的${label}数据（工具返回 / 注入块里标注${label}来源的）。${others}的数据、指数、涨跌家数、板块资金、涨停/跌停、主力净额一律不得当作${label}数据引用，也不得用${others}的走势推断${label}。`,
`若用户消息里附带其它市场的数据块，只能将其标注为该市场数据，不得当作当前市场数据；若用户明确问其它市场的标的，按该标的的市场回答并注明市场，但不得把其它市场数据说成当前市场数据。`,
`交易日 / 交易时段按当前市场：不要用 A 股交易日、A 股节假日、A 股收盘时间推断${label}的数据时间；数据时间以各工具返回的行情时刻为准，取不到就写「暂无数据」。`,
`缺数据就写「暂无数据」：${label}数据缺失时不要用其它市场数据顶替，也不要凭印象补数字。`,
];
if (market === "A") {
return [
...common,
`本轮可用 A 股工具（market_sentiment / sector_rank / sector_constituents / sector_breadth / factor_screener / tdx_* / market_calendar_effect / stock_*）；market_overseas 只作「外盘与外部环境」参考，其读数（纳指 / 标普 / 恒生 / A50）是外盘数据，不得当作 A 股数据引用。`,
].join("\n");
}
const overseasLine = market === "HK"
? `本轮可用：market_overseas（其中的恒生读数是港股数据）、market_news（只取其中港股相关快讯）、stock_*（仅限.HK 代码）。`
: `本轮可用：market_overseas（其中的纳指 / 标普 / 道指 / 半导体 ETF / 英伟达读数是美股数据）、market_news（只取其中美股相关快讯）、stock_*（仅限美股代码）。`;
return [
...common,
overseasLine,
`A 股专属工具本轮不可用、不可引用：${forbiddenTools}。本轮没有取它们；回答里出现它们的数据就是编造。`,
market === "US"
? `美股无涨跌停、无「主力净额（全 A 口径）」概念：不要写美股涨停 / 跌停家数，不要把 A 股主力净额说成美股资金。`
: `港股涨跌停口径与 A 股不同：不要把 A 股涨停 / 跌停家数说成港股的；港股资金读数取不到就写暂无数据。`,
].join("\n");
}
