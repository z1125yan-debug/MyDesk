// 第 5 种分歧：主力 vs 大户散户（日报，AI 优选之后按每只票算）。
//
// 小白口径（用户 2026-10-16 定）：
// 1) 主力是跑还是留：直接说“主力在跑”或“主力在留”，不说“平的”“净额 +0.002 亿”；
// 2) 卖的是谁：主力 / 大户 / 散户，谁在卖，卖了多少；
// 3) 散户是进来接盘还是在跑：小单流入 = 散户在接盘，小单流出 = 散户也在跑；
// 4) 假进真退：主力表面在进、实际准备撤（小幅流入但超大单在卖，或主力流入但价格跌）；
// 5) 板块分歧：这只票和板块比，方向相反 = 和板块打架。
//
// 用词纪律：输出里不出现“净额”“中单”“小单”这类词，只用“主力”“大户”“散户”“板块”。
// 口径映射（只在注释里写，不进输出）：主力 = 超大单 + 大单（THS 223/224/225/226），
// 大户 = 中单（THS 237/238），散户 = 小单（THS 259/260）。
//
// 阈值（单位：亿，1 亿 = 1e8 元）：
// FLAT_YI = 0.01：主力 |净| < 0.01 亿（100 万）视为“基本没动”→ 判“留”，不是跑；
// SIG_YI = 0.05：单边 |净| ≥ 0.05 亿（500 万）才算“明显在卖/在买”，低于它不认方向，避免噪音。

export interface MainVsRetailInput {
symbol: string;
name?: string;
/** 当日涨跌幅 %（DB 当日收盘 vs 前一日收盘；缺为 null，不编） */
changePct?: number | null;
/** 主力买卖差（亿，正 = 买的多，负 = 卖的多；缺为 null） */
mainNetYi?: number | null;
/** 超大单买卖差（亿；用于识别假进真退） */
superNetYi?: number | null;
/** 大户买卖差（亿） */
midNetYi?: number | null;
/** 散户买卖差（亿） */
smallNetYi?: number | null;
/** 板块名（第一级，如“煤炭”；缺为 null） */
sectorName?: string | null;
/** 板块中位涨跌幅 %（同板块所有票的中位；缺为 null） */
sectorMedianChangePct?: number | null;
}

export interface MainVsRetailResult {
symbol: string;
name: string;
/** 资金三边是否都取到了 */
hasData: boolean;
/** true = 主力在留，false = 主力在跑，null = 没取到 */
mainStay: boolean | null;
/** 假进真退 */
fakeInRealOut: boolean;
fakeReason: string;
/** 这只票和板块方向相反 */
sectorDivergent: boolean;
/** 是否分歧（主力与大户/散户反向，或假进真退，或和板块打架，任一成立） */
isDivergent: boolean;
/** 一句话（小白语言） */
plain: string;
}

const FLAT_YI = 0.01;
const SIG_YI = 0.05;

function fmtYi(v: number): string {
const a = Math.abs(v);
if (a < 0.005) return "不到 0.01 亿";
return `${a.toFixed(2)} 亿`;
}

/** “涨 2.44%” / “跌 1.39%” */
function dirPct(v: number): string {
return v >= 0? `涨 ${v.toFixed(2)}%`: `跌 ${Math.abs(v).toFixed(2)}%`;
}

export function judgeMainVsRetail(inp: MainVsRetailInput): MainVsRetailResult {
const name = inp.name || inp.symbol;
const { mainNetYi: main, superNetYi: sup, midNetYi: mid, smallNetYi: small, changePct, sectorName, sectorMedianChangePct: secMed} = inp;
const base: Omit<MainVsRetailResult, "plain"> = {
symbol: inp.symbol, name, hasData: false, mainStay: null,
fakeInRealOut: false, fakeReason: "", sectorDivergent: false, isDivergent: false,
};
if (main == null || mid == null || small == null) {
return {...base, plain: `${name}：主力 / 大户 / 散户的资金没取到，算不出这只的分歧。`};
}
const hasData = true;
// 1) 主力跑还是留（直接说，不说“平的”“净额”）
const mainStay = main >= -FLAT_YI;
// 2) 卖的是谁：主力在卖就先说主力（带数），再说其他在卖的一边；主力没卖就说大户/散户谁在卖。
const otherSellers = [
{ who: "大户", amount: mid},
{ who: "散户", amount: small},
].filter((s) => s.amount < -FLAT_YI).sort((a, b) => a.amount - b.amount);
let sellPart: string;
if (!mainStay) {
const others = otherSellers.map((s) => `${s.who}也卖了 ${fmtYi(s.amount)}`).join("，");
sellPart = `主力在跑，卖了 ${fmtYi(main)}${others ? `，${others}` : ""}`;
} else if (otherSellers.length) {
sellPart = `主力在留，${otherSellers.map((s) => `${s.who}卖了 ${fmtYi(s.amount)}`).join("，")}`;
} else {
sellPart = "主力在留，三边都没怎么卖";
}
// 3) 散户接盘还是跑路（卖出金额已在上一句出现过，这里只说方向；买入才带数）
const retailLine = small > FLAT_YI
? `散户在接盘，买了 ${fmtYi(small)}`
: small < -FLAT_YI
? "散户也在跑"
: "散户基本没动";
// 4) 假进真退：主力表面在进，但超大单在卖；或主力在买，价格却跌
const fakeReasons: string[] = [];
if (main > FLAT_YI && sup!= null && sup < -FLAT_YI) {
fakeReasons.push("主力表面在进，但超大单在卖，大资金其实在撤");
}
if (main > FLAT_YI && changePct!= null && changePct < 0) {
fakeReasons.push(`主力在买，但价格还跌了 ${Math.abs(changePct).toFixed(2)}%，买的钱没托住股价`);
}
const fakeInRealOut = fakeReasons.length > 0;
const fakeLine = fakeInRealOut? `主力假进真退（${fakeReasons.join("；")}）`: "主力没有假进真退";
// 5) 板块分歧：这只票和板块中位方向相反才算打架（两边幅度都 ≥ 0.5% 才认，避免噪音）。
//    方向相反但幅度小 → 如实说“方向相反但幅度小，不算打架”，不说“同向”（那是错的）。
let sectorDivergent = false;
let sectorLine = "板块对比没取到";
if (changePct!= null && secMed!= null) {
const opp = (changePct >= 0.5 && secMed <= -0.5) || (changePct <= -0.5 && secMed >= 0.5);
sectorDivergent = opp;
const secName = sectorName || "板块";
const signsDiffer = (changePct > 0 && secMed < 0) || (changePct < 0 && secMed > 0);
sectorLine = opp
? `${secName}中位${dirPct(secMed)}，这只${dirPct(changePct)}，和板块打架`
: signsDiffer
? `${secName}中位${dirPct(secMed)}，这只${dirPct(changePct)}，方向相反但幅度小，不算打架`
: `${secName}中位${dirPct(secMed)}，这只${dirPct(changePct)}，和板块同向，没打架`;
}
// 分歧判定：主力与大户/散户反向，或假进真退，或和板块打架
const opposite = (main >= -FLAT_YI && (mid <= -SIG_YI || small <= -SIG_YI))
|| (main <= -FLAT_YI && (mid >= SIG_YI || small >= SIG_YI));
const isDivergent = opposite || fakeInRealOut || sectorDivergent;
const priceLine = changePct!= null? `价格${dirPct(changePct)}，`: "";
const plain = `${name}：${priceLine}${sellPart}，${retailLine}，${fakeLine}；板块：${sectorLine}。`;
return {...base, hasData, mainStay, fakeInRealOut, fakeReason: fakeReasons.join("；"), sectorDivergent, isDivergent, plain};
}

/** 多只拼成日报里的段落（小白语言，放在 AI 优选之后）。 */
export function buildMainVsRetailSection(inputs: readonly MainVsRetailInput[]): string {
if (!inputs.length) return "【第 5 种分歧：主力 vs 大户散户】当日 AI 优选没有票，算不出。";
const results = inputs.map(judgeMainVsRetail);
const n = results.filter((r) => r.isDivergent).length;
const lines = results.map((r) => r.plain).join(" ");
return `【第 5 种分歧：主力 vs 大户散户】（AI 优选之后，按每只算；主力在留 = 主力没跑）${results.length} 只里有 ${n} 只出现分歧：${lines}`;
}
