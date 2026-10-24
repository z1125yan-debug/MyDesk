/**
* 本机版产业链研报生成（复刻 LlmAnalysisPage.IndustryReportView.generate 的服务端等价流程）。
*
* 背景：研报生成原本只有浏览器端流程（页面里拼数据→调 /api/ai/proxy 流式生成→留档）。
* Z 本机部署生成卡住时，用这个脚本在 VM 本机走同一套数据装配（report-input-core /
* report-news-core 纯核）、同一份提示词、同一个 /api/ai/proxy 端点、同一套后处理
* （screenReportShape → mendReportSkeleton → mendBoldSeams → mendTypos → reportTitleOf），
* 最后同样 POST /api/industry-report 留档，并把成稿 markdown 写到 ~/workspace/your_files/。
*
* 用法：npx tsx scripts/gen-industry-report-local.ts [MyDeskBaseUrl]
*/
import { readFileSync, writeFileSync } from "node:fs";
import { METRIC_DEFS_ZH, indexTrendFromCandles, indexTrendZh, localVerdictZh, reviewRowsZh, themeFlowsZh} from "../src/lib/desk/report-input-core.ts";
import { groupNewsByTheme, groupedNewsZh, newsPoolLabelZh, newsQuoteZh, unmatchedThemesZh, type NewsPoolRow} from "../src/lib/desk/report-news-core.ts";
import { mendBoldSeams, mendReportSkeleton, mendTypos, reportTitleOf, screenReportShape} from "../src/lib/desk/report-text-core.ts";
import { createSseScanner, decodeStreamEvent} from "../src/lib/desk/chat-stream-core.ts";

const argvAll = process.argv.slice(2);
const consumedIdx = new Set<number>();
argvAll.forEach((a, i) => { if (a === "--model" || a === "--ingest") { consumedIdx.add(i); consumedIdx.add(i + 1); } });
const BASE = argvAll.find((a, i) => !a.startsWith("--") && !consumedIdx.has(i)) ?? "http://127.0.0.1:3000";

const shDay = (offset: number) => {
const d = new Date(Date.now() - offset * 864e5);
return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const todayStr = shDay(0);

async function getJson<T = Record<string, unknown>>(url: string): Promise<T> {
const r = await fetch(BASE + url);
const j = await r.json();
if (!r.ok || (j as { ok?: boolean}).ok === false) throw new Error((j as { error?: string}).error || `${url} 获取失败`);
return j as T;
}

const klineUrl = (symbol: string) => `/api/market/kline?symbol=${symbol}&tf=${encodeURIComponent("日线")}&fq=none`;
const newsPoolUrl = (dates: string[]) => `/api/market/news?dates=${dates.join(",")}`;

const NONSTREAM = process.argv.includes("--nonstream");

// --model <id>：换模型时必须把服务端通道的 base/key 一并以 x-ai-* 头带上——
// 路由口径是「没带 x-ai-base-url 就整组用 .env 通道（连模型一起覆盖）」，只带 x-ai-model 会被冲掉。
// base/key 从本机 .env 读，只进请求头，不打印、不落盘。
function modelHeaders(): Record<string, string> {
const mi = process.argv.indexOf("--model");
if (mi < 0) return {};
const envText = readFileSync(`${process.env.HOME}/workspace/kairotrend-p1/.env`, "utf8");
const get = (k: string) => (envText.match(new RegExp(`^${k}="?([^"\\n]*)"?`, "m"))?.[1] ?? "").trim();
return {
"x-ai-base-url": get("LLM_BASE_URL"),
"x-ai-api-key": get("LLM_API_KEY"),
"x-ai-model": process.argv[mi + 1],
};
}

async function streamReport(prompt: string): Promise<string> {
if (NONSTREAM) {
// 非流式一次性取全量：流式路径在 Z 的网关上对这种长生成三次都是「约 270 秒后零内容返回」
// （小请求流式正常），疑网关内部整段生成后才回、流式被中途掐断。路由对显式 timeout_ms
// 的非流式请求同样钳到 600s，够这份研报生成完。
const res2 = await fetch(BASE + "/api/ai/proxy", {
method: "POST",
headers: { "Content-Type": "application/json", ...modelHeaders() },
body: JSON.stringify({
messages: [{ role: "user", content: prompt }],
stream: false,
max_tokens: 6000,
timeout_ms: 600_000,
market: "A",
}),
signal: AbortSignal.timeout(660_000),
});
const j2 = (await res2.json().catch(() => ({}))) as { content?: string; error?: string };
if (!res2.ok || j2.error) throw new Error(j2.error || `研报生成失败（${res2.status}）`);
return j2.content ?? "";
}
const upstreamMs = 300_000;
const res = await fetch(BASE + "/api/ai/proxy", {
method: "POST",
headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...modelHeaders() },
body: JSON.stringify({
messages: [{ role: "user", content: prompt}],
stream: true,
max_tokens: 6000,
timeout_ms: upstreamMs,
market: "A",
}),
signal: AbortSignal.timeout(upstreamMs + 60_000),
});
if (!/text\/event-stream/i.test(res.headers.get("content-type")?? "")) {
const j = (await res.json().catch(() => ({}))) as { content?: string; error?: string};
if (!res.ok || j.error) throw new Error(j.error || `研报生成失败（${res.status}）`);
return j.content?? "";
}
if (!res.ok ||!res.body) throw new Error(`流式响应不可用（${res.status}）`);
let full = "";
let streamError: string | null = null;
const scanner = createSseScanner();
const reader = res.body.getReader();
const decoder = new TextDecoder();
const feed = (frames: { data: string}[]) => {
for (const f of frames) {
const ev = decodeStreamEvent(f.data);
if (!ev) continue;
if (ev.type === "delta") full += ev.data.content;
else if (ev.type === "done" && ev.data.fullText) full = ev.data.fullText;
else if (ev.type === "error") streamError = ev.data.message;
}
};
for (;;) {
const { done, value} = await reader.read();
if (done) break;
feed(scanner.push(decoder.decode(value, { stream: true})));
}
feed(scanner.flush());
if (streamError) throw new Error(streamError);
return full;
}

async function main() {
const [rv, shK, szK, cybK, sent] = await Promise.all([
getJson<{ rows: Record<string, unknown>[]; themeHeat?: unknown; range?: { to?: string}}>("/api/market/review-stats?from=" + shDay(10)).catch(() => ({ rows: [] as Record<string, unknown>[]})),
getJson<{ candles?: { date: string; c: number}[]}>(klineUrl("000001.SH")).catch(() => ({ candles: undefined})),
getJson<{ candles?: { date: string; c: number}[]}>(klineUrl("399001.SZ")).catch(() => ({ candles: undefined})),
getJson<{ candles?: { date: string; c: number}[]}>(klineUrl("399006.SZ")).catch(() => ({ candles: undefined})),
getJson<{ ok?: boolean; amount_total_yi?: number; amount_known?: number; as_of?: string}>("/api/market/sentiment").catch(
() => ({ ok: false, amount_total_yi: undefined, amount_known: 0, as_of: undefined}),
),
]);
const rows = (rv.rows?? []).slice(-3);
const th = (rv as { themeHeat?: { industries?: { n: string}[]; concepts?: { n: string}[]} | null}).themeHeat?? null;
const dataDay = String(rv.range?.to?? "").trim().slice(0, 10);
const genDay = /^\d{4}-\d{2}-\d{2}$/.test(dataDay)? dataDay: String(rows[rows.length - 1]?.date?? todayStr).slice(0, 10);
console.log(`[gen] 研报日 genDay=${genDay}（range.to=${dataDay}），复盘行 ${rows.length} 条：${rows.map((r) => r.date).join(",")}`);

const flowsZh = themeFlowsZh(th?.industries as never, th?.concepts as never);
const rowsZh = reviewRowsZh(rows as never);
const verdictZh = localVerdictZh(th as never);
const turnoverYi = typeof sent.amount_total_yi === "number" && Number.isFinite(sent.amount_total_yi)? sent.amount_total_yi: NaN;
const turnoverKnown = (sent.amount_known?? 0) > 0 && Number.isFinite(turnoverYi);
const turnoverZh = turnoverKnown
? `⑦ 全A当日成交额锚点（真实，来自 /api/market/sentiment 全A快照合计，数据截至 ${sent.as_of?? "未知"}）：约 ${turnoverYi.toFixed(0)} 亿元（≈ ${(turnoverYi / 10000).toFixed(2)} 万亿元）。`
: `⑦ 全A成交额本次没读到（amount_known=0：全A快照里一家都没带成交额字段，合计 0 不是「今天只成交 0 亿」）。`;
// 指数K线必须按研报日截断：kline 接口给的是截至今天的完整序列，隔日补生成昨日研报时
// 不截断就会把今天的指数收盘/涨幅喂进去，模型会把它们写成研报日的（2026-10-23 实测：
// DeepSeek 稿把 10-23 的上证 3685.65/+0.76% 写成 10-22 收盘，整节叙事被带偏）。
const asOfGenDay = (cs?: { date: string; c: number }[]) => (cs ?? []).filter((c) => String(c.date).slice(0, 10) <= genDay);
const indexZh = [
indexTrendZh("上证指数(000001.SH)", indexTrendFromCandles(asOfGenDay(shK.candles))),
indexTrendZh("深证成指(399001.SZ)", indexTrendFromCandles(asOfGenDay(szK.candles))),
indexTrendZh("创业板指(399006.SZ)", indexTrendFromCandles(asOfGenDay(cybK.candles))),
];
const poolDates = rows.map((r) => String(r.date?? "").slice(0, 10)).filter(Boolean).reverse();
const nj = await getJson<{ news?: { date?: string; time?: string; title?: string}[]; source?: { provider?: string}; capped?: boolean; error?: string}>(newsPoolUrl(poolDates)).catch(() => null);
const pool: NewsPoolRow[] = (nj?.news?? []).map((x) => ({
date: String(x.date?? "").slice(0, 10),
time: String(x.time?? ""),
title: String(x.title?? "").trim(),
})).filter((x) => x.title);
const hotThemes = [
...(th?.industries?? []).map((x) => x.n),
...(th?.concepts?? []).slice(0, 8).map((x) => x.n),
];
const newsGroups = groupNewsByTheme(hotThemes, pool, { perTheme: 6});
const groupedNews = groupedNewsZh(newsGroups);
const unmatchedNews = unmatchedThemesZh(newsGroups);
const newsLabel = newsPoolLabelZh({
dates: poolDates,
total: pool.length,
fetchedOn: todayStr,
source: nj?.source?.provider,
capped: nj?.capped,
});
const newsBlock = groupedNews
|| pool.slice(0, 40).map((x) => newsQuoteZh(x)).join("")
|| `（本次没有取到快讯：${nj?.error?? "接口无返回"}。正文里所有「关联新闻」一律写「数据不足」，不许自己编题目。）`;
console.log(`[gen] 快讯池 ${pool.length} 条（${poolDates.join(",")}），主线 ${hotThemes.length} 个`);

const prompt = [
"你是A股产业链研究分析师，文风对标头部券商每日复盘研报。请基于下方撰写当日产业链深度研报（markdown 正文），严格遵循下列格式与文风要求。",
"",
"",
"1. 首行是一级标题，固定写成：# 📈 " + genDay,
"2. 正文分五节，每节标题必须写成「## + 空格 + emoji + 空格 + 标题」，emoji 与文字照抄下面给出的，不得增删改：",
" ## 📊 市场情绪与风格判断",
" ## 🚀 核心主线与热点板块",
" ## 🧩 潜伏机会与预期差",
" ## ⚠️ 风险警示",
" ## 🧭 策略总结",
"3. 每两节之间单独一行写 --- 作为分隔线（共 4 处）。",
"4. 严禁使用 markdown 表格（正文里不要出现 | 竖线）；所有分层信息一律用「加粗小标题 + 项目符号 -」的嵌套列表表达。",
"",
"",
"全文要像研报一样「重点密布」：关键判断、板块名、产业链环节名、公司名、数值结论用 **加粗** 标出。",
"经验密度：大约每 30 个字出现 1 处加粗（4000 字正文约 120 处，最多不超过 160 处）。不得出现整段没有一个加粗的素文段落，但也不许更密。",
"红线 1：一处加粗只包一个词或一个短语，长度不超过 14 个字；不要把整句话切碎成十几个连续加粗。",
"红线 2：两个加粗之间必须有「、」「，」或空格之类的分隔，**绝不允许写成 **A****B** 这种中间连着四个星号的形状**。",
"红线 3：星号只能成对出现（** 开、** 闭），全文任何位置不得出现连续 3 个以上星号；发现自己在重复打星号就立刻停笔收尾。",
"红线 4：数值只能照抄下方真实数据。数据里没有的指数点位、价格、止损位一律不许出现（不准写「3000 点」「跌破 2950 加仓」这类编出来的数）；",
" 没有点位数据时就只引用涨跌幅、家数、资金额这些给到的读数，操作建议按「仓位比例 / 涨跌幅」表述。",
"",
"",
"▶ 市场情绪与风格判断（用 4 条加粗项 + 1 段收束，不要用 ### 小标题）：",
"- **市场阶段**：……（用上面「本地量化引擎判读」给的市场桶/阶段定性，并引用指数趋势里的真实点位；判读没给就写「数据不足」，不许自己定性和编点位）",
"- **情绪温度**：……（用 🟠/🔥/🧊 等 emoji 定性，并引用真实读数）",
"- **风格研判**：……（大小盘 / 成长价值 / 高低位）",
"- **核心逻辑**：……（分 1./2./3. 条列出驱动）",
"**综合判断**：用一段话收束本节。",
"▶ 核心主线与热点板块（2-3 条主线，每条严格按下面五件套写）：",
"### 1. 主线名称（🔥 热度：极高｜高｜中高｜中）",
"> **关联新闻**：“新闻标题1”（09-20 11:28）“新闻标题2”（09-22 09:31）……（只能从下方 ⑥「已按主线预分组」里该主线名下的快讯挑；标题逐字照抄，标题后面的（月-日 时:分）日期标注一并照抄，一条不许少，每条主线至少 3 条，用中文引号串起来）",
` （那条主线在下面没有对应快讯时，就写「> **关联新闻**：本区间快讯池里没有与该主线直接相关的题目」，不许挪用别的主题的标题，更不许自己编一条新闻。）`,
"- **逻辑推演**：……（为什么是主线，结合真实数据）",
"- **产业链受益**：",
" **① 环节名（一句话定性）**",
" - 核心受益：**公司A、公司B**（一句理由）；**公司C**（一句理由）",
" - 次级受益：**公司D、公司E**（一句理由）",
" **② 环节名**",
" - 核心受益：……",
"- **操作建议**：……（分 2-3 条，说清节奏 / 仓位 / 止损）",
"▶ 潜伏机会与预期差（1-3 个机会点）：",
"- **① 机会点名称**",
" - **逻辑**：……（市场主流预期是什么、可能错在哪）",
" - **验证点**：……（盯哪个数据或事件来证实或证伪）",
"▶ 风险警示（2-4 条，每条「加粗风险名 + 具体描述」）：",
"- **风险名**：具体描述……",
"▶ 策略总结：一整段话收束，给出仓位与配置方向。",
"",
"",
"---",
"**免责声明**：本分析基于公开信息整理，不构成任何投资建议。A股市场受多重因素影响，历史表现不代表未来。投资者应结合自身风险承受能力独立决策，并对投资结果负责。",
"",
"",
"① 指数趋势（真实日K算出，正文里的点位 / 与最近一个月均价的关系 / 回撤只能引用这里）：",
...indexZh,
"② " + verdictZh,
"③ 指标口径（照这个读，不许按字段名猜）：",
...METRIC_DEFS_ZH,
"④ 最近三个交易日复盘统计：",
...rowsZh,
"⑤ 当日主线热度与 3 日资金（正数=流入）：",
...flowsZh,
`⑥ ${newsLabel}，已按主线预分组（每条标题后面的日期就是它真实发布的日期）：`,
newsBlock,
...(unmatchedNews? [unmatchedNews]: []),
turnoverZh,
turnoverKnown
? " 正文里凡提到「全市场成交额 / 两市成交额 / 全A成交额 / 量能总量」这类**总量**读数，只能引用⑦给的数（约 " + (turnoverYi / 10000).toFixed(2) + " 万亿元），不许另编一个总量；分行业/分板块的成交额没给你，要写就写「数据不足」。"
: " 正文里所有「全市场成交额 / 两市成交额」一律写「数据不足」，不许编一个总量数（本次全A快照没读到成交额字段）。",
"",
"",
"1. 所有判断必须与上述数据一致，不得编造读数；数据不足的环节明确写「数据不足」，不编造公司或数字。",
"1b. 指数与板块涨跌的「方向」只能照抄数据里带正负号的当日涨跌（如 +0.18%=上涨、-0.34%=下跌），",
" 严禁依据「价格在一个月均价下方」「退潮」等语境自行推测方向——实测曾把真实 +0.18% 写成「跌幅 0.18%」（方向写反）。",
"2. 产业链受益环节列代表公司时，只用A股真实存在的上市公司。",
"3. 标题层级只用 # / ## / ###，正文用 - 项目符号；不要表格、不要代码块、不要 JSON。",
"4. 正文里不许出现内部字段名（aboveMa5Pct、microPct、decliners、limitUp 这类），指标一律用上面「指标口径」给的中文说法。",
"5. 没有喂业绩、调研、订单类数据：不许写「业绩兑现阶段」「主升浪中段」这种需要产业基本面证据的定性；只能说数据里给到的情绪面 / 资金面 / 热度读数。",
"6. 新闻只能从 ⑥ 里逐字照抄原标题，并把它后面的日期标注一起抄下来；不许改写、不许自拟、不许把标题里的数字换成别的数。",
" 反面例子：原帖是「快递“反内卷”引发新一轮涨价 多家公司今起安徽区域单票最低上调0.15元」，",
" 写成「快递单票价格同比+4%」就是编造（涨幅和口径都是换过的）——读者拿标题去搜搜不到，这种引用一次都不许出现。",
"7. 受益标的只写 A 股上市公司。反面例子：**星际荣耀**、**华为海思**、**长江存储** 都不是 A 股上市公司，一次都不能作为标的出现；",
"7b. 全市场/全A成交额只能引用 ⑦ 给的真实总量（本次约 " + (turnoverKnown? (turnoverYi / 10000).toFixed(2) + " 万亿元": "未读到") + "），",
" 严禁自己编一个总量数（实测曾把 1.45 万亿写成 1.61 万亿，这种一眼假的数字一次都不许出现）；分行业成交额没给就写「数据不足」。",
" 拿不准公司是否上市，就只写产业链环节名，不写公司名。",
" 公司名必须用**A 股在册证券简称**，不许拿港/美那边的叫法顶替：「华虹半导体」是港股名，A 股在册叫「华虹宏力」；",
" 「华润微电子」的 A 股在册简称是「华润微」；「金山云」不是 A 股公司，压根不能出现在受益栏。",
" 这三处写法都会被页面上的「受益标的 A 股核对」程序逐条点名，写错就露错。",
" 在册简称会随公司状态变：已被风险警示的标的要按在册写法写（300044 现在在册叫「*ST赛为」），沿用改名前的老名会被判成简称不符。",
].join("\n");

console.log(`[gen] 提示词 ${prompt.length} 字，开始流式生成…`);
writeFileSync(`/tmp/report-prompt-last-${genDay}.txt`, prompt, "utf8");
const argv = process.argv.slice(2);
if (argv.includes("--dump-prompt")) {
const pf = `/tmp/report-prompt-${genDay}.txt`;
writeFileSync(pf, prompt, "utf8");
console.log(`[gen] 提示词已写出 ${pf}（genDay=${genDay}）`);
return;
}
let content: string;
const ingestIdx = argv.indexOf("--ingest");
if (ingestIdx >= 0) {
const rawResp = JSON.parse((await import("node:fs")).readFileSync(argv[ingestIdx + 1], "utf8")) as { choices?: { message?: { content?: string } }[]; content?: string };
content = rawResp.choices?.[0]?.message?.content ?? rawResp.content ?? "";
console.log(`[gen] 已从外部响应导入正文 ${content.length} 字`);
} else {
content = await streamReport(prompt);
}
if (!content.trim()) throw new Error("研报生成失败：上游未返回内容");
console.log(`[gen] 生成完毕，正文 ${content.length} 字，过形状安检…`);
const shape = screenReportShape(String(content));
if (!shape.ok) throw new Error(`形状安检未过：${shape.reason}`);
const skeleton = mendReportSkeleton(String(content));
if (skeleton.inserted.length) console.log("[gen] 骨架已补回：" + skeleton.inserted.join("、"));
const text = mendTypos(mendBoldSeams(skeleton.text));
const title = reportTitleOf(text, genDay);
const rec = { ts: Date.now(), title, text, tradeDate: genDay};
if (process.argv.includes("--no-save")) {
console.log("[gen] --no-save：跳过服务端留档");
} else {
const sr = await fetch(BASE + "/api/industry-report", {
method: "POST", headers: { "Content-Type": "application/json"},
body: JSON.stringify(rec),
});
console.log(`[gen] 服务端留档：${sr.ok? "OK": "失败 " + sr.status}`);
}
const outSuffix = process.argv.includes("--mercury") ? "-mercury" : "";
const out = `${process.env.HOME}/workspace/your_files/产业链研报-${genDay}${outSuffix}.md`;
writeFileSync(out, text, "utf8");
console.log(`[gen] 已写出 ${out}`);
console.log(`[gen] 标题：${title}`);
}

main().catch((e) => {
console.error("[gen] 失败：", e instanceof Error? e.message: e);
process.exit(1);
});
