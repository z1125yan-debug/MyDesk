// AI 优选「排雷盖章」取数 + 组装层（服务端）：温度（pick-heat-core）+ 位置（pick-position-core）
// + 风险观察标签（pick-risk-tags）→ riskStampOf 逐只出章。2026-10-24 用户指示：
// 「正式版从现在起加上排雷」——每只入选股出厂带章，写进版本文件 + note 落版。
//
// 硬约束（与标签层同一条纪律）：只盖章落版——绝不剔除、绝不重排、绝不降权、绝不改动
// 任何一只入选股与落库语义（盖章标注 ≠ 剔除拦截，拦截未开）。任一数据源失败 → 该项按
// 「未取到」降级（温度未取到不算热、位置未取到不扣章），绝不编；本层失败不阻塞优选主流程。

import "server-only";
import { db} from "../../db.ts";
import { inferMarketEnv} from "../review/market-inference.ts";
import { computePickHeat, deviationFromMa20Pct, type HeatBar, type PickHeat} from "./pick-heat-core.ts";
import { positionOf, type PositionClass, type PositionRegime} from "./pick-position-core.ts";
import { riskStampOf, type RiskStamp, type RiskTagResult} from "./pick-risk-tags-core.ts";

const ADJUST = "qfq";
/** 温度/位置取数根数（与台账 Python build_pick_horizons.py 的 LIMIT 61 一致） */
const HEAT_BARS = 61;

export interface PickStampInfo {
stamp: RiskStamp;
reasons: string[];
/** 温度三读数（未取到为 null；盖章时按 hot = 0 计，即不算热） */
heat: PickHeat | null;
/** 决策日乖离 %（未取到为 null） */
devPct: number | null;
/** 位置格（未取到为 null，不扣章） */
position: PositionClass | null;
/** 当日档位（未取到为 null） */
regime: PositionRegime | null;
}

interface CloseRow {
close: number | null;
volume: number | null;
}

function numOrNull(v: unknown): number | null {
const n = typeof v === "bigint"? Number(v): typeof v === "number"? v: NaN;
return Number.isFinite(n)? n: null;
}

/** 逐只取截至决策日的 qfq 收盘/量（倒序，每只最多 61 根）。单只 DB 失败 → 空数组（该只温度/位置未取到）。 */
async function fetchClosesForStamps(
tradeDate: string,
symbols: string[],
): Promise<Map<string, HeatBar[]>> {
const out = new Map<string, HeatBar[]>();
await Promise.all(symbols.map(async (symbol) => {
const key = symbol.toUpperCase();
try {
const rows = await db.$queryRawUnsafe<CloseRow[]>(
`SELECT close, volume FROM stock_daily_bar
WHERE symbol =? AND adjust =? AND tradeDate <=?
ORDER BY tradeDate DESC LIMIT ${HEAT_BARS}`,
symbol, ADJUST, tradeDate,
);
out.set(key, rows.map((r) => ({ close: numOrNull(r.close), volume: numOrNull(r.volume)})));
} catch {
out.set(key, []);
}
}));
return out;
}

const REGIME3_MAP: Record<string, PositionRegime> = {
"主升": "强势",
"震荡": "震荡",
"退潮": "弱势",
"修复": "弱势",
};

/**
* 当日档位（强势/震荡/弱势）：与 review-stats 路由同一套 inferMarketEnv
* （market_daily_stats 自产行 + 复盘种子），桶 → 三档映射与台账 Python
* compute_regimes 的 MAP 一字不差。取不到 → null（位置整项不判）。
*/
export async function regime3Of(tradeDate: string): Promise<PositionRegime | null> {
let inference: ReturnType<typeof inferMarketEnv> = null;
try {
const dbRows = await db.marketDailyStats.findMany({
where: { tradeDate: { lte: tradeDate}},
orderBy: { tradeDate: "desc"},
take: 30,
});
const asc = dbRows.reverse();
inference = inferMarketEnv(tradeDate, asc.map((m) => ({
date: m.tradeDate, limitUp: m.limitUp?? 0, limitDown: m.limitDown?? 0,
t3: m.t3?? 0, t4: m.t4?? 0, t5: m.t5?? 0, maxBoards: m.maxBoards?? 0,
decliners: m.decliners?? 0, belowMa5: m.belowMa5?? 0, belowMa3: m.belowMa3?? 0,
aboveMa5Pct: m.aboveMa5Pct?? null,
})));
} catch {
inference = null;
}
if (!inference) {
try { inference = inferMarketEnv(tradeDate);} catch { inference = null;}
}
return inference? (REGIME3_MAP[inference.market_bucket]?? null): null;
}

/** 标签结果缺失时的替身（该只标签没算出 → 按无确认标签计，章只由温度 + 位置决定；
* 与 riskResults 为空时 note 里没有该只标签段的事实一致，不冒充命中）。 */
function emptyTagResult(symbol: string, name: string): RiskTagResult {
return {
symbol,
name,
tags: [],
hits: [],
catalystStatus: "unknown",
fadeMetrics: { pullbackPct: null, shadowShare: null, volRatio: null},
plain: "",
};
}

/**
* 给一批已定稿的优选票逐只盖章。riskResults = computePickRiskTags 的结果（按 symbol 对齐，
* 缺只按无标签计）。返回 Map（key = 大写 symbol），每只都有条目（数据缺失走降级，不缺席）。
*/
export async function computePickStamps(
tradeDate: string,
picked: readonly { symbol: string; name?: string}[],
riskResults: readonly RiskTagResult[],
): Promise<Map<string, PickStampInfo>> {
const out = new Map<string, PickStampInfo>();
if (!picked.length) return out;
const symbols = picked.map((p) => p.symbol);
const [closesMap, regime] = await Promise.all([
fetchClosesForStamps(tradeDate, symbols),
regime3Of(tradeDate),
]);
const tagMap = new Map(riskResults.map((r) => [r.symbol.toUpperCase(), r]));
for (const p of picked) {
const key = p.symbol.toUpperCase();
const bars = closesMap.get(key)?? [];
const heat = computePickHeat(bars);
const devPct = deviationFromMa20Pct(bars);
const position = regime && devPct!= null? positionOf(regime, devPct).cls: null;
const result = tagMap.get(key)?? emptyTagResult(p.symbol, p.name || "");
const { stamp, reasons} = riskStampOf({ hot: heat?.hot?? 0, result, position});
out.set(key, { stamp, reasons, heat, devPct, position, regime});
}
return out;
}

/** note 的段：逐只一行「代码 名称：章（原因）」，末尾一行三章汇总只数。 */
export function buildStampSection(
picked: readonly { symbol: string; name?: string}[],
stamps: ReadonlyMap<string, PickStampInfo>,
): string {
const lines: string[] = [];
const counts: Record<RiskStamp, number> = { "合格": 0, "注意": 0, "不合格": 0};
for (const p of picked) {
const info = stamps.get(p.symbol.toUpperCase());
if (!info) continue;
counts[info.stamp] += 1;
lines.push(`${p.symbol} ${p.name || ""}：${info.stamp}${info.reasons.length? `（${info.reasons.join("；")}）`: ""}`);
}
if (!lines.length) return "";
return `（只标注不拦截、不影响选股）${lines.join(" ")} 汇总：合格 ${counts["合格"]} 只、注意 ${counts["注意"]} 只、不合格 ${counts["不合格"]} 只。`;
}
