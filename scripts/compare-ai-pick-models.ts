// TEST-ONLY：双模型 AI 优选对比（glm-5.3-flash vs Qwen3.8-Flash）。
//
// 背景：用户本地 AI 优选用 Qwen3.8-Flash，VM 生产用 glm-5.3-flash。
// 用户想知道两个模型选出来的股是否一样——一样就不换（VM 继续用 glm）。
//
// 流程（与生产服务端自动优选一致，只在“调模型”一步拆成两次）：
// ① 读官方版：取 tradeDate 当天 15:20 官方生成的最新版本文件（官方记录，只读，不重跑、不覆盖）
// ② 候选 + 富化：gatherLayer1Candidates + enrichAiPickCandidates（生产函数，原样复用）
// ③ 硬过滤：applyHardFilter（生产函数，第一道，与生产一致）
// ④ 同一个 prompt：buildAiPickPrompt（生产函数，marketCtx 与生产一致 = 不传）
// ⑤ 同一条消息调两次：glm-5.3-flash（对比重跑，仅对比，不落库）
// 与 Qwen3.8-Flash（测试，仅对比，不落库），temperature 0.1 / max_tokens 6000 与生产一致
// ⑥ 各自 parseAiPickResponse + narrowChoices（生产函数，第二道硬过滤）
// ⑦ 三方对比：Qwen vs 官方 glm、Qwen vs glm 对比重跑（同输入，干净的模型对比）、
// glm 对比重跑 vs 官方 glm（同模型两次抽样漂移——告诉你多少差异只是大模型随机性）
//
// 诚实边界（测试，绝不进生产）：
// - 不调 generateAiPickForDate，不调 persistAiPick，不调 appendAiPickVersion；
// 不写 StrategyPick，不写版本文件，不改.env，不改任何生产代码。
// - Qwen 那次是测试，不进官方版本、不进台账、不覆盖。
// - 估值（PE/PB/市值/流通股本）来自 MCP 最新值，不是“决策日当时”的时点值（与生产一致的近似）。
// - 两个模型各自的 rejected：从模型原始 JSON 的 rejected 数组提取（parseAiPickResponse 只取 picks）。
// - 超时：生产是 120s；这里每调用放宽到 300s（为了拿到对比结果）。
// 若某次调用 >120s，会在结果里标出“生产 120s 会超时”，供换模型决策参考。
//
// 用法（周一 2026-10-19 16:00，由 cron 跑；今天周六不要跑——没有周一的候选）：
// node --import ./scripts/ts-alias-register.mjs --experimental-transform-types \
// scripts/compare-ai-pick-models.ts --date 2026-10-19 [--out DIR]
// 输出：<out>/2026-10-19-compare.json + <out>/2026-10-19-compare.md，stdout 打印一句话结论。
// 默认 out：~/workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/ai-pick-model-compare/

import fs from "node:fs";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher} from "undici";
import { db} from "../src/lib/db.ts";
import {
AI_PICK_MAX, applyHardFilter, buildAiPickPrompt, narrowChoices, parseAiPickResponse,
type AiPickCandidate,
} from "../src/lib/quant/strategy/ai-pick-core.ts";
import {
enrichAiPickCandidates, gatherLayer1Candidates,
} from "../src/lib/quant/strategy/ai-pick-generate.ts";
import { latestAiPickVersion} from "../src/lib/quant/strategy/ai-pick-versions.ts";
import { getServerLlm} from "../src/lib/llm/model-config.ts";

const GLM_MODEL = "glm-5.3-flash";
const QWEN_MODEL = "Qwen3.8-Flash";
const PROD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;

interface ChatMsg { role: "system" | "user" | "assistant"; content: string}

/** 读仓库.env（只补 process.env 里没有的键；绝不打印任何值）。脚本在 cron 里跑时 shell 未必有 LLM_*。 */
function loadDotEnv(): void {
try {
const envPath = path.resolve(process.cwd(), ".env");
const raw = fs.readFileSync(envPath, "utf-8");
for (const line of raw.split("\n")) {
const t = line.trim();
if (!t || t.startsWith("#")) continue;
const eq = t.indexOf("=");
if (eq <= 0) continue;
const k = t.slice(0, eq).trim();
let v = t.slice(eq + 1).trim();
if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
if (k && process.env[k] === undefined) process.env[k] = v;
}
} catch {
//.env 读不到就用现有环境变量；getServerLlm 会如实报未配置
}
}

function apiBase(base: string): string {
return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 与生产 callServerChat 同口径（temperature 0.1 / max_tokens 6000 / 代理规则），只把 model 换成传入值。 */
async function callChat(
channel: { baseUrl: string; apiKey: string},
model: string,
messages: ChatMsg[],
ms: number,
): Promise<{ text: string; durationMs: number}> {
const url = apiBase(channel.baseUrl) + "/v1/chat/completions";
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), ms);
const proxyUrl = (process.env.AI_PROXY_URL || "").trim();
const isLan = /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(channel.baseUrl);
const dispatcher: Dispatcher | undefined = proxyUrl &&!isLan? new ProxyAgent(proxyUrl): undefined;
const started = Date.now();
try {
const res = await undiciFetch(url, {
method: "POST",
headers: { "Content-Type": "application/json", Authorization: `Bearer ${channel.apiKey}`},
body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 6000}),
signal: ctrl.signal,
dispatcher,
});
const json = (await res.json().catch(() => ({}))) as { error?: { message?: string}; choices?: { message?: { content?: string}}[]};
if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
return { text: json?.choices?.[0]?.message?.content?? "", durationMs: Date.now() - started};
} finally {
clearTimeout(timer);
}
}

/** 从模型原始 JSON 里提取 rejected 数组（parseAiPickResponse 只取 picks，这里补 rejected）。 */
function extractRejected(text: string): { symbol: string; reason: string}[] {
const first = text.indexOf("{");
const last = text.lastIndexOf("}");
if (first < 0 || last <= first) return [];
try {
const obj = JSON.parse(text.slice(first, last + 1)) as { rejected?: unknown};
if (!Array.isArray(obj.rejected)) return [];
return obj.rejected
.filter((r): r is Record<string, unknown> =>!!r && typeof r === "object")
.map((r) => ({ symbol: String(r.symbol?? "").trim().toUpperCase(), reason: String(r.reason?? "").trim()}))
.filter((r) =>!!r.symbol);
} catch {
return [];
}
}

function normSym(s: string): string {
return String(s || "").trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, "");
}

interface ModelRun {
model: string;
role: string;
durationMs: number;
timedOutForProd: boolean;
rawText: string;
picks: { symbol: string; reason: string}[];
rejected: { symbol: string; reason: string}[];
parseError: string | null;
}

function summarizePicks(picks: { symbol: string}[]): string {
return picks.length? picks.map((p) => p.symbol).join("、"): "（一只没选）";
}

function overlap(a: string[], b: string[]): { both: string[]; onlyA: string[]; onlyB: string[]} {
const sa = new Set(a.map(normSym));
const sb = new Set(b.map(normSym));
return {
both: [...sa].filter((x) => sb.has(x)),
onlyA: [...sa].filter((x) =>!sb.has(x)),
onlyB: [...sb].filter((x) =>!sa.has(x)),
};
}

async function main(): Promise<void> {
loadDotEnv();
const args = process.argv.slice(2);
const dateArg = args[args.indexOf("--date") + 1];
const outArg = args[args.indexOf("--out") + 1];
const tradeDate = dateArg || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
console.error(`tradeDate 格式不对：${tradeDate}（应为 YYYY-MM-DD）`);
process.exit(2);
}
const outDir = outArg
? path.resolve(outArg)
: path.join(process.env.HOME || process.cwd(), "workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/ai-pick-model-compare");
fs.mkdirSync(outDir, { recursive: true});

// ① 官方版（只读）
const official = await latestAiPickVersion(tradeDate);
if (!official) {
console.error(`官方版还没生成：${tradeDate} 没有版本文件（15:20 官方生成还没跑或失败）。不对比，等官方生成后再跑。`);
process.exit(3);
}
const officialSyms = official.picks.map((p) => p.symbol);

// ②③ 候选 + 富化 + 硬过滤（生产函数）
const rawCands = await gatherLayer1Candidates(tradeDate);
if (!rawCands.length) {
console.error(`${tradeDate} 当日没有 layer1 候选，无从对比。`);
process.exit(4);
}
const cands = await enrichAiPickCandidates(tradeDate, rawCands);
const { kept: filteredCands, rejected: hardRejected} = applyHardFilter(cands);

// ④ 同一个 prompt（marketCtx 与生产一致 = 不传）
const prompt = buildAiPickPrompt(filteredCands, tradeDate, AI_PICK_MAX);
const messages: ChatMsg[] = [
{ role: "system", content: "你是 A 股量化工作台的 AI优选环节，只输出 JSON，绝不解释。"},
{ role: "user", content: prompt},
];

const llm = getServerLlm();
if (!llm.available) {
console.error(`服务端模型通道未配置（${llm.reason}），无法对比。`);
process.exit(5);
}

// ⑤ 两次调用（顺序固定：先 glm 对比重跑，再 Qwen；互不干扰）
const runs: ModelRun[] = [];
for (const [model, role] of [[GLM_MODEL, "glm 对比重跑（仅对比，不落库）"], [QWEN_MODEL, "Qwen 测试（仅对比，不落库）"]] as const) {
let text = "";
let durationMs = 0;
let parseError: string | null = null;
try {
const r = await callChat(llm.channel, model, messages, TEST_TIMEOUT_MS);
text = r.text;
durationMs = r.durationMs;
} catch (e) {
parseError = `调用失败：${(e as Error).message}`;
}
let picks: ModelRun["picks"] = [];
if (!parseError) {
const choices = parseAiPickResponse(text);
if (!choices) {
parseError = "模型没有返回可解析的优选清单";
} else {
const narrowed: AiPickCandidate[] = narrowChoices(choices, filteredCands, AI_PICK_MAX);
picks = narrowed.map((p) => ({ symbol: p.symbol, reason: p.reason || ""}));
}
}
runs.push({
model, role, durationMs,
timedOutForProd: durationMs > PROD_TIMEOUT_MS,
rawText: text,
picks,
rejected: extractRejected(text),
parseError,
});
}

const [glmRun, qwenRun] = runs;
const glmSyms = glmRun.picks.map((p) => p.symbol);
const qwenSyms = qwenRun.picks.map((p) => p.symbol);

// ⑦ 三方对比
const qwenVsOfficial = overlap(qwenSyms, officialSyms);
const qwenVsGlm = overlap(qwenSyms, glmSyms);
const glmVsOfficial = overlap(glmSyms, officialSyms);
const qwenSameAsOfficial = qwenVsOfficial.onlyA.length === 0 && qwenVsOfficial.onlyB.length === 0 && qwenSyms.length === officialSyms.length;
const qwenSameAsGlmRun = qwenVsGlm.onlyA.length === 0 && qwenVsGlm.onlyB.length === 0 && qwenSyms.length === glmSyms.length;

const verdict = qwenSameAsOfficial && qwenSameAsGlmRun
? "一致：Qwen 与 glm 选出来的股完全相同，不用换（VM 继续用 glm）"
: qwenSameAsGlmRun
? "同输入下一致，但与官方版有差异（差异来自官方版与对比重跑的两次抽样 / 富化时间不同，不是模型差异）"
: "不一致：Qwen 与 glm 选出来的股不同，见下面差异票";

const reasonOf = (run: ModelRun, sym: string): string => {
const p = run.picks.find((x) => normSym(x.symbol) === normSym(sym));
if (p) return p.reason || "（模型没给理由）";
const r = run.rejected.find((x) => normSym(x.symbol) === normSym(sym));
if (r) return `模型弃选：${r.reason || "（没给理由）"}`;
return "（模型既没选也没在 rejected 里提）";
};

const result = {
tradeDate,
generatedAt: new Date().toISOString(),
models: { glm: GLM_MODEL, qwen: QWEN_MODEL},
verdict,
official: {
source: "15:20 官方生成版本文件（只读，未重跑）",
runAt: official.runAt,
picks: officialSyms,
},
inputs: {
layer1Candidates: rawCands.length,
afterHardFilter: filteredCands.length,
hardRejected: hardRejected,
promptChars: prompt.length,
},
runs: runs.map((r) => ({
model: r.model,
role: r.role,
durationMs: r.durationMs,
timedOutForProd: r.timedOutForProd,
parseError: r.parseError,
picks: r.picks,
rejected: r.rejected,
rawText: r.rawText,
})),
compare: {
qwenVsOfficial: {...qwenVsOfficial, same: qwenSameAsOfficial},
qwenVsGlmRun: {...qwenVsGlm, same: qwenSameAsGlmRun},
glmRunVsOfficial: {...glmVsOfficial, same: glmVsOfficial.onlyA.length === 0 && glmVsOfficial.onlyB.length === 0 && glmSyms.length === officialSyms.length},
differingPicks: [
...qwenVsGlm.onlyA.map((s) => ({ symbol: s, qwen: reasonOf(qwenRun, s), glm: reasonOf(glmRun, s), where: "只在 Qwen 里"})),
...qwenVsGlm.onlyB.map((s) => ({ symbol: s, qwen: reasonOf(qwenRun, s), glm: reasonOf(glmRun, s), where: "只在 glm 对比重跑里"})),
],
},
};

const jsonPath = path.join(outDir, `${tradeDate}-compare.json`);
const mdPath = path.join(outDir, `${tradeDate}-compare.md`);
fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");

const md = [
`# 双模型 AI 优选对比（${tradeDate}）`,
``,
`结论：${verdict}`,
``,
`| 对比 | 结果 |`,
`|---|---|`,
`| Qwen vs 官方 glm | 重合 ${qwenVsOfficial.both.length} 只；Qwen 独有 ${qwenVsOfficial.onlyA.length} 只（${qwenVsOfficial.onlyA.join("、") || "无"}）；官方独有 ${qwenVsOfficial.onlyB.length} 只（${qwenVsOfficial.onlyB.join("、") || "无"}） |`,
`| Qwen vs glm 对比重跑（同输入） | 重合 ${qwenVsGlm.both.length} 只；Qwen 独有 ${qwenVsGlm.onlyA.length} 只（${qwenVsGlm.onlyA.join("、") || "无"}）；glm 独有 ${qwenVsGlm.onlyB.length} 只（${qwenVsGlm.onlyB.join("、") || "无"}） |`,
`| glm 对比重跑 vs 官方 glm（同模型抽样漂移） | 重合 ${glmVsOfficial.both.length} 只；重跑独有 ${glmVsOfficial.onlyA.length} 只；官方独有 ${glmVsOfficial.onlyB.length} 只 |`,
``,
`## 各方选股`,
``,
`- 官方 glm（15:20 官方版，${official.runAt}）：${summarizePicks(officialSyms.map((s) => ({ symbol: s})))}`,
`- glm 对比重跑（${(glmRun.durationMs / 1000).toFixed(1)}s${glmRun.timedOutForProd? "，生产 120s 会超时": ""}${glmRun.parseError? `，${glmRun.parseError}`: ""}）：${summarizePicks(glmRun.picks)}`,
`- Qwen 测试（${(qwenRun.durationMs / 1000).toFixed(1)}s${qwenRun.timedOutForProd? "，生产 120s 会超时": ""}${qwenRun.parseError? `，${qwenRun.parseError}`: ""}）：${summarizePicks(qwenRun.picks)}`,
``,
`## 差异票理由（Qwen vs glm 对比重跑，同输入）`,
``,
...(result.compare.differingPicks.length
? result.compare.differingPicks.map((d) => `- ${d.symbol}（${d.where}）：Qwen——${d.qwen}；glm——${d.glm}`)
: ["（无差异票）"]),
``,
`## 输入`,
``,
`- layer1 候选 ${rawCands.length} 只，硬过滤后 ${filteredCands.length} 只，硬过滤拦掉 ${hardRejected.length} 只（${hardRejected.map((x) => `${x.symbol}${x.reason}`).join("；") || "无"}）`,
`- prompt ${prompt.length} 字符；Qwen 是测试，不进官方版本、不进台账、不覆盖；.env 未动（生产仍是 glm-5.3-flash）。`,
`- 完整原始输出见同目录 ${tradeDate}-compare.json（rawText）。`,
``,
].join("\n");
fs.writeFileSync(mdPath, md, "utf-8");

console.log(`${verdict}`);
console.log(`官方 glm：${summarizePicks(officialSyms.map((s) => ({ symbol: s})))}`);
console.log(`glm 对比重跑：${summarizePicks(glmRun.picks)}`);
console.log(`Qwen 测试：${summarizePicks(qwenRun.picks)}`);
console.log(`结果文件：${jsonPath}`);
console.log(`结果文件：${mdPath}`);
}

main()
.then(() => process.exit(0))
.catch((e) => {
console.error(`对比脚本失败：${(e as Error)?.stack || e}`);
process.exit(1);
})
.finally(async () => {
try { await db.$disconnect();} catch { /* ignore */}
});
