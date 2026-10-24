// AI优选决策卡 · symbolsNote 文本 → 11 字段结构化卡片（纯核，无 IO / 无时钟）
//
// 为什么需要这一层：
// AI优选的 11 字段（AiPickChoice）在落库时被 narrowChoices() 拼进 symbolsNote，
// 成了一段扁平文本（"600519.SH：入选理由：…；入场条件：…；…；000858.SZ：…"）。
// 战绩页此前只能原样展示这段文本，看不出每只票的 11 个字段各是什么。
// 本解析器把文本按「字段标签」切回结构化卡片，供前端分格渲染。
//
// 诚实边界：
// - 只解析文本里真实出现的字段；模型没给的字段一律 null，前端显示「未取到」，绝不编；
// - 旧格式 note（没有「逐只决策卡：」标记）返回 []，调用方保留原文本展示，不冒充有卡；
// - note 末尾的「第 5 种分歧」附录不是某只票的字段，解析时切掉；
// - 字段值里自带的「；」不截断（按「标签：」切，不按「；」切）。

export const AI_PICK_MISSING_LABEL = "未取到";

/** 11 字段研究卡（docs/参考平台能力清单.md §七.2），顺序与参考平台一致 */
export interface AiPickCardFieldSpec {
key: AiPickCardFieldKey;
label: string;
icon: string;
}

export type AiPickCardFieldKey =
| "researchConclusion"
| "coreConclusion"
| "evidence"
| "keySignals"
| "priceVolume"
| "falsification"
| "trigger"
| "invalidCondition"
| "positionRhythm"
| "riskHint"
| "actionRef";

export const AI_PICK_CARD_FIELDS: readonly AiPickCardFieldSpec[] = [
{ key: "researchConclusion", label: "研究结论", icon: "🎯"},
{ key: "coreConclusion", label: "核心结论", icon: "📌"},
{ key: "evidence", label: "依据", icon: "📎"},
{ key: "keySignals", label: "关键信号", icon: "📈"},
{ key: "priceVolume", label: "强弱量价", icon: "📊"},
{ key: "falsification", label: "反证状态", icon: "🧪"},
{ key: "trigger", label: "触发条件", icon: "🗓️"},
{ key: "invalidCondition", label: "失效条件", icon: "🛑"},
{ key: "positionRhythm", label: "仓位节奏", icon: "📦"},
{ key: "riskHint", label: "风险提示", icon: "⚠️"},
{ key: "actionRef", label: "操作参考", icon: "🧭"},
];

export interface AiPickNoteCard {
symbol: string;
/** 名称来自 note 的段（"600519.SH 贵州茅台←…"）；没有就 undefined */
name?: string;
/** 5 字段模板的其余三项（11 字段之外，卡片头部展示，不丢信息） */
reason?: string;
entryCondition?: string;
mainRisk?: string;
/** 11 字段：模型没给 = null，前端显示「未取到」 */
researchConclusion: string | null;
coreConclusion: string | null;
evidence: string | null;
keySignals: string | null;
priceVolume: string | null;
falsification: string | null;
trigger: string | null;
invalidCondition: string | null;
positionRhythm: string | null;
riskHint: string | null;
actionRef: string | null;
}

/** 中文标签 → 卡片字段（11 字段 + 头部用的 5 字段三项） */
const LABEL_TO_KEY: Record<string, keyof AiPickNoteCard> = {
入选理由: "reason",
入场条件: "entryCondition",
主要风险: "mainRisk",
研究结论: "researchConclusion",
核心结论: "coreConclusion",
依据: "evidence",
关键信号: "keySignals",
强弱量价: "priceVolume",
反证状态: "falsification",
触发条件: "trigger",
失效条件: "invalidCondition",
仓位节奏: "positionRhythm",
风险提示: "riskHint",
操作参考: "actionRef",
};

const LABELS = Object.keys(LABEL_TO_KEY);

/** 方括号标记用转义写：成对的【…】在写入时会被剥掉，直接写字面量不可靠 */
const LBR = String.fromCharCode(0x3010);
const RBR = String.fromCharCode(0x3011);

/** 去掉字段值末尾的分隔符「；」与空白（"；" 是拼卡时的连接符，不是字段内容） */
function cleanValue(raw: string): string | null {
const v = raw.replace(/[；\s]+$/g, "").trim();
return v? v: null;
}

/**
 * 去选股日涨跌幅数字（日报 AI 优选段规则 2026-10-17：决策日只列代码、名称、理由，
 * 不显示选股日涨跌幅——没意义，不是收益）。
 * 只删“涨/跌/涨幅/涨跌幅 + 数字 + %”这种涨跌幅数字；换手、PE/PB、市值、收盘价等
 * 其他数字一律保留（“换手1.00%”不是涨跌幅，不删；“价涨”是定性词，不删）。
 * 删完清掉残留的悬空分隔符（“、，”→“，”、“，，”→“，”等），不留断句。
 */
export function stripPickDayChangePct(text: string | null | undefined): string {
if (text == null) return "";
let out = String(text);
// 涨跌幅数字：涨幅+2.44% / 涨2.44% / 跌1.39% / 涨跌幅+2.44% / 涨-1.39% / 上涨2.44%（允许涨/跌后有空格）
out = out.replace(/涨跌幅\s*[+-]?[\d.]+%/g, "");
out = out.replace(/涨幅\s*[+-]?[\d.]+%/g, "");
out = out.replace(/跌幅\s*[+-]?[\d.]+%/g, "");
out = out.replace(/上涨\s*[+-]?[\d.]+%/g, "");
out = out.replace(/下跌\s*[+-]?[\d.]+%/g, "");
out = out.replace(/涨\s*[+-]?[\d.]+%/g, "");
out = out.replace(/跌\s*[+-]?[\d.]+%/g, "");
// 清悬空分隔符（多轮，直到稳定）
let prev = "";
while (prev !== out) {
prev = out;
out = out
.replace(/，，/g, "，")
.replace(/、、/g, "、")
.replace(/；；/g, "；")
.replace(/、，/g, "，")
.replace(/，、/g, "、")
.replace(/、；/g, "；")
.replace(/；、/g, "；")
.replace(/：，/g, "：")
.replace(/（，/g, "（")
.replace(/，）/g, "）")
.replace(/^\s*[，、；]\s*/g, "")
.replace(/\s*[，、；]\s*$/g, "");
}
return out.trim();
}

/** 从优选来源段取「代码 → 名称」：形如 "600519.SH 贵州茅台←动量策略" */
function nameMapOf(note: string): Map<string, string> {
const m = new Map<string, string>();
const srcStart = note.indexOf(LBR + "优选来源" + RBR);
if (srcStart < 0) return m;
const srcEnd = note.indexOf(LBR + "参考模板版" + RBR, srcStart);
const seg = note.slice(srcStart, srcEnd < 0? undefined: srcEnd);
const re = /(\d{6}\.(?:SH|SZ|BJ))\s+([^←；]*?)←/g;
for (const match of seg.matchAll(re)) {
const name = (match[2]?? "").trim();
if (name) m.set(match[1], name);
}
return m;
}

/**
* 把 symbolsNote 解析成每只票一张的 11 字段决策卡。
* 入口标记「逐只决策卡：」缺失（旧格式）→ []；每只票的起止按「；代码：」切，
* 字段按「标签：」切，值里含「；」不会被误截。
*/
export function parseAiPickNote(note: string | null | undefined): AiPickNoteCard[] {
if (!note) return [];
const marker = "逐只决策卡：";
const markerIdx = note.indexOf(marker);
if (markerIdx < 0) return [];
let section = note.slice(markerIdx + marker.length);
// 末尾附录「第 5 种分歧」不是某只票的字段，切掉
const divIdx = section.indexOf(LBR + "第 5 种分歧");
if (divIdx >= 0) section = section.slice(0, divIdx);

const names = nameMapOf(note);
const pickRe = /(?:^|；)(\d{6}\.(?:SH|SZ|BJ))：/g;
const starts: { symbol: string; start: number}[] = [];
for (const m of section.matchAll(pickRe)) {
const prefixLen = m[0].startsWith("；")? 1: 0;
starts.push({ symbol: m[1], start: m.index + prefixLen});
}
if (!starts.length) return [];

const cards: AiPickNoteCard[] = [];
for (let i = 0; i < starts.length; i++) {
const { symbol, start} = starts[i];
const end = i + 1 < starts.length? starts[i + 1].start: section.length;
const slice = section.slice(start, end);
// 去掉开头的 "代码："，剩下字段文本
const body = slice.replace(/^\d{6}\.(?:SH|SZ|BJ)：/, "");

// 找每个标签第一次出现的位置，按位置切值
const hits: { pos: number; label: string; key: keyof AiPickNoteCard}[] = [];
for (const label of LABELS) {
const pos = body.indexOf(`${label}：`);
if (pos >= 0) hits.push({ pos, label, key: LABEL_TO_KEY[label]});
}
hits.sort((a, b) => a.pos - b.pos);

const card: AiPickNoteCard = {
symbol,
name: names.get(symbol),
researchConclusion: null,
coreConclusion: null,
evidence: null,
keySignals: null,
priceVolume: null,
falsification: null,
trigger: null,
invalidCondition: null,
positionRhythm: null,
riskHint: null,
actionRef: null,
};
for (let j = 0; j < hits.length; j++) {
const h = hits[j];
const valueStart = h.pos + h.label.length + 1; // 跳过 "标签："
const valueEnd = j + 1 < hits.length? hits[j + 1].pos: body.length;
const v = cleanValue(body.slice(valueStart, valueEnd));
if (v!= null) (card as unknown as Record<string, unknown>)[h.key] = v;
}
cards.push(card);
}
return cards;
}
