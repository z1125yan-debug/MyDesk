// P7-⑧② 对话正文里的「可点片段」识别（纯内核：给一段纯文本 + 已知板块清单，返回哪几处能点、点了跳到哪）。
//
// 为什么单独一层：跳转联动的全部风险都集中在「把不该点的东西画成可点」。
// 写在组件里就没法测，也没法把「为什么这处不生成链接」的口径写清楚（下面每条拒判都有理由）。
// 组件只做渲染，store/页面只做跳转——三处各管一件事，与 quant/screener 下的 *-core.ts 同一套分层。
//
// 三条口径（本轮不放松）：
//  1) **代码只认形状，不认名字**：与意图层共用 intent-core 的 codeRe（同一份代码形状，不出现两套口径）。
//     正文里的「宁德时代」这种名字一律不生成链接——名字→代码要查标的字典，纯层猜名字就是把猜测当事实。
//  2) **板块只认已知清单**：清单来自 /api/market/sectors（东财行业榜真实数据），清单外的名字不可点。
//     取不到清单就是没有板块链接，不做「看着像板块名就当板块」的兜底，也不静默跳去一个猜出来的 code。
//  3) 链接层比意图层**更保守**：意图层错了只是多取/少取一份数，链接层错了用户会误跳到一只不存在的票。
//     所以这里在 codeRe 之上再加三道拒判（金额/数量单位的六位数字、价格小数尾巴、两字板块名裸现），
//     见 symbolRejectReason 与 sectorRejectReason。
// 带 .ts 后缀是 node --test 直跑纯内核的前提（与 intent-core.ts 同一套写法）。
// 注：代码形状与补后缀都从 intent-core 取，这里不复制第二套口径；反向的「名称→代码」反查在取数层，不在本层。
import { codeRe, suffixOf } from "./intent-core.ts";

/** 已知板块（跳转要有 code 才能直达；name 只用来在正文里定位） */
export interface SectorRef {
  code: string;
  name: string;
}

/** 可点片段点下去要去哪 */
export type DeskLink =
  | { kind: "symbol"; symbol: string }
  | { kind: "sector"; code: string; name: string };

/** 正文里的一处可点区间：start/end 是位置，不覆盖整段原文的区间一律不认 */
export interface LinkSpan {
  start: number;
  end: number;
  link: DeskLink;
}

/** 切好的片段：link 为 null 的就是普通文字，渲染层原样输出 */
export interface LinkSegment {
  text: string;
  link: DeskLink | null;
}

// ---------- 代码：在 codeRe 之上再加保守闸门 ----------

/** 紧跟其后的量词/单位：说明这串六位数字是金额或数量，不是代码（「500000 股」「300000 元」） */
const UNIT_AFTER = /^\s*(股|元|手|万|亿|份|张|枚|个百分点|美元|人民币)/;

/** 补全后的完整代码：带后缀的原样大写，不带的按号段补（与意图层同一份 suffixOf） */
export function toSymbol(raw: string): string {
  const six = raw.slice(0, 6);
  return raw.includes(".") ? raw.toUpperCase() : `${six}.${suffixOf(six)}`;
}

/**
 * 这一处代码出现要不要放弃生成链接。返回拒判原因（null = 可点）：
 *  - `小数尾巴`：前一个字符是小数点（"0.123456" 里的 123456 不是代码）；
 *  - `千分位`：前一个字符是半角逗号（"1,600519" 这种金额分组不是代码）；
 *  - `后接小数位`：后面紧跟「.数字」，说明它是个带小数的读数而不是代码；
 *  - `带单位`：无后缀且紧跟量词，说明是数量/金额。
 * 带 .SH/.SZ/.BJ 的写法只受前三条约束（后缀本身就是「这是代码」的声明）。
 */
export function symbolRejectReason(text: string, start: number, end: number): string | null {
  const before = start > 0 ? text[start - 1] : "";
  if (before === ".") return "小数尾巴";
  if (before === ",") return "千分位";
  const after = text.slice(end);
  if (/^\.\d/.test(after)) return "后接小数位";
  if (!/\./.test(text.slice(start, end)) && UNIT_AFTER.test(after)) return "带单位";
  return null;
}

/** 正文里的全部代码出现（含位置），已剔除该拒的 */
export function findSymbolSpans(text: string): LinkSpan[] {
  const src = text ?? "";
  const re = codeRe();
  const out: LinkSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (!symbolRejectReason(src, start, end)) out.push({ start, end, link: { kind: "symbol", symbol: toSymbol(m[0]) } });
  }
  return out;
}

// ---------- 板块：只认清单，最长优先 ----------

/** 两字板块名的放行条件：紧跟这些词（或整体被「」包着）才点。
 *  为什么两字要另加闸门：榜单里有「综合」「其他」「汽车」「医药」这种既是板块名又是常用词的名字，
 *  「其他综合收益」「医药」这类说法一旦可点，用户点下去是个不相干的板块页——假链接比没链接更伤。 */
export const SECTOR_CUES = ["板块", "行业", "概念", "指数", "主线", "龙头", "成分股", "资金"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 编译一次板块正则：流式回答每来一帧都要重渲染，逐名扫描（正文长度 × 榜单长度）会明显发涩。
// 只缓存最后一份清单——切换会话不会来回换榜单，缓存两个以上没意义。
let sectIndexKey = "";
let sectIndexRe: RegExp | null = null;
let sectIndexNames: Map<string, SectorRef> | null = null;

/** 名 → 板块（同名只留一个：行业榜内名字唯一，重名当数据源异常处理，保留先出现的那个） */
function sectorIndex(sectors: SectorRef[]): { re: RegExp | null; byName: Map<string, SectorRef> } {
  const clean = (sectors ?? []).filter((s) => s && typeof s.code === "string" && typeof s.name === "string" && s.name.length >= 2);
  const byName = new Map<string, SectorRef>();
  for (const s of clean) if (!byName.has(s.name)) byName.set(s.name, s);
  const key = [...byName.keys()].join("\u0000");
  if (sectIndexKey !== key || !sectIndexRe) {
    sectIndexKey = key;
    // 交替式按长度降序 = 同一位置上先试长名字，得到「最长优先」（JS 交替是取首个能匹配的，不是取最长）
    const names = [...byName.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    sectIndexRe = names.length ? new RegExp(names.map(escapeRe).join("|"), "g") : null;
  }
  return { re: sectIndexRe, byName };
}

/** 这一处板块名要不要放弃：两字名必须挨着行业语境词，或被「」包着 */
export function sectorRejectReason(text: string, start: number, end: number, name: string): string | null {
  if (name.length > 2) return null;
  const after = text.slice(end);
  if (SECTOR_CUES.some((c) => after.startsWith(c))) return null;
  if (text[start - 1] === "「" && text[end] === "」") return null;
  return "两字板块名未挨着行业语境词";
}

/** 正文里的全部板块出现（含位置），已剔除该拒的 */
export function findSectorSpans(text: string, sectors: SectorRef[]): LinkSpan[] {
  const src = text ?? "";
  const { re, byName } = sectorIndex(sectors);
  if (!re) return [];
  const out: LinkSpan[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    const start = m.index;
    const end = m.index + m[0].length;
    const ref = byName.get(m[0]);
    if (!ref) continue;
    if (!sectorRejectReason(src, start, end, ref.name)) {
      out.push({ start, end, link: { kind: "sector", code: ref.code, name: ref.name } });
    }
  }
  return out;
}

// ---------- 合流：代码优先，重叠不认 ----------

/**
 * 正文里的可点区间（代码 + 板块），已解决重叠：
 * 按位置排序，同位置代码优先，任何与已接受区间重叠的候选直接丢掉。
 */
export function findLinkSpans(text: string, sectors: SectorRef[] = []): LinkSpan[] {
  const cands = [
    ...findSymbolSpans(text).map((s) => ({ ...s, rank: 0 })),
    ...findSectorSpans(text, sectors).map((s) => ({ ...s, rank: 1 })),
  ].sort((a, b) => a.start - b.start || a.rank - b.rank || (b.end - b.start) - (a.end - a.start));
  const out: LinkSpan[] = [];
  let cursor = -1;
  for (const c of cands) {
    if (c.start < cursor) continue; // 与上一段重叠：一个位置只放一个链接
    out.push({ start: c.start, end: c.end, link: c.link });
    cursor = c.end;
  }
  return out;
}

/**
 * 把正文切成「普通文字 / 可点片段」的序列。
 * 硬不变量：所有片段的 text 拼回去必须逐字等于原文（切分不许吞字、不许改字）。
 * 没有可点片段时返回一段原文，调用方不必特判。
 */
export function splitByLinks(text: string, sectors: SectorRef[] = []): LinkSegment[] {
  const src = text ?? "";
  const spans = findLinkSpans(src, sectors);
  if (!spans.length) return [{ text: src, link: null }];
  const out: LinkSegment[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) out.push({ text: src.slice(at, s.start), link: null });
    out.push({ text: src.slice(s.start, s.end), link: s.link });
    at = s.end;
  }
  if (at < src.length) out.push({ text: src.slice(at), link: null });
  return out;
}
