// P7-⑦ 事件面（event_score）打分规则表 —— 纯内核：无 DB、无 fetch、无时钟，node --test 可直跑。
//
// v2 → v3 改了什么（P7-⑦ 任务书给了事件面五档，所以这一维从「本层自认表」升级成「任务书表 + 本层并入」）：
//   - 计分项换成 **EV-LEVEL 一条**：重大利好 +20 / 普通利好 +10 / 无 0 / 普通利空 −10 / 重大风险 −20
//     （版本号 `p7.s7.event.v1`，五档字面值是任务书原文；只有「旧表合计 落到哪一档」的阈值线 ±6/±12 是本层补的，带 SUPPLEMENT_MARKER）。
//   - P7-③ 的四个分项（E-TILT / E-HIGH / E-SCOPE / E-SUBJECT）**不删、不丢**：它们改成 `role:"basis"`
//     继续算、继续显示，并且是 EV-LEVEL 的计算来源（旧表字面分合计 → 新表五档），各自带 `rule_version:"p7.s3.event.v1"`。
//     为什么不并进求和：新表说「五档只加一次分」，四条老分项再加一遍就是同一个消息面被计两回（与 market-score-core 同一个并入纪律）。
//   - `EVENT_EXTREMES` 从 ±25 改成 **±20**：v3 起 bounds 是 decision-core 折算 ±100 的尺子，必须跟**计分档**同步。
//     旧表的账面极值 ±25 留成 `EVENT_LEGACY_EXTREMES`，只作记录与测试对照，不再充当尺子。
//   - 任务书没给事件面的单维限制（±50 只写在技术面与市场环境），而本维极值天然 ±20 不越界 ⇒ 本层不做夹取，
//     也不替它补一条限制。
//
// 事件面是四个维度里唯一**输入本身来自 AI 解释层**的：impact_direction / impact_scope / importance
// 都是 P6-B 由模型产出、经服务端字段核对后落库的（event-interpret-core.ts 的 EventInterpretation）。
// 所以本层的分层与事实层不同：能算出来的分项 status 一律 AI_INTERPRETATION，绝不写成 REAL/DERIVED，
// 让 decision-core 的 layers 里能看到「这一维的解释成分来自模型」。
//
// 三条防越界的设计（各对应至少一条测试，v2 就在、v3 原样保留）：
// 1) **confidence 不参与计算**。它是模型对自己那段解释的把握度（0~1），提示词里就明写着「不是上涨概率」。
//    这里只在 E-TILT 的 raw 文案里回显本批均值（confidenceEcho），缺读数则在 missing[] 里登记；
//    如果拿它当系数去乘分数，就等于把 AI 的自我把握伪装成市场概率，还会让同一批事件因为换了一个模型给出不同档位。
// 2) **不被条数灌分**：方向倾向用归一化净差 (W_pos − W_neg)/(W_pos + W_neg)，1 条利好与 10 条利好的档位相同。
//    事件面在任务书里的定位是「短期扰动」，它回答的是「消息面偏向哪边、有多强」，
//    不是「今天抓到了多少条新闻」——后者只反映抓取窗口，把它算成分会让结论随 cron 频率漂移。
//    （EV-LEVEL 因此也只能由归一化后的档位映射出来：直接按条数加会同时破坏这一条。）
// 3) **旧闻不算今天的扰动**：每条事件按 trade_date 与决策日的天数差判定，超过 stale_after_days 的不参与计分并登记。
//    本层不看时钟（纯函数），参考日由调用方传 shanghaiDate()。
//
// 缺失口径与 P7-① 一致：缺读数 = points=null 且进 missing[]；一条都算不出 ⇒ score=null，
// 由 buildDecision 把 10/100 的权重从分母里拿掉（任务书原话：「无可用事件数据时 event_score=null，并对其余三维修权重归一」）。
// **"当日 0 条事件"与"事件表读不到"都走 null**，不给 0 分 —— 0 分在任务书里是「无消息面影响」这个明确判断，
// 而研究层早就写过另一条口径（research.ts「真实为空 ⇒ 不猜新闻」）：库里没内容时我们并不知道消息面是否平静。
// 反过来，「事件里有 2 条利好 2 条利空、方向相抵」是读数存在，走 0 分档并在 note 里写清楚它不是算不出。

import { SUPPLEMENT_MARKER, type Bounds, type ExternalDimension, type ScoreItem } from "./decision-core.ts";
import type { DataStatus } from "./datastatus-core";

/** 规则表版本：s7 = P7 第七阶段（任务书五档表），event = 本表 */
export const EVENT_RULE_VERSION = "p7.s7.event.v1";
/** P7-③ 那张本层自认表仍在算，只是不再充当计分项 —— 版本留在分项上，出处不能糊掉 */
export const EVENT_LEGACY_RULE_VERSION = "p7.s3.event.v1";

export const EVENT_RULE_PROVENANCE = "P7-③ 本层规则表（任务书 §六 无事件面打分表），非任务书原文";
/** 新表五档字面值出自任务书；只有分档阈值是本层补的，所以措辞与 market-score-core 的 S7 那格对齐 */
export const EVENT_S7_PROVENANCE = "P7-⑦ 任务书事件面五档（重大利好 +20／普通利好 +10／无 0／普通利空 −10／重大风险 −20），本层只补分档阈值";

/** 重要性权重：只有这三档参与归一化净差。「无法判断」不参与，见 eventItems 的登记 */
export const IMPORTANCE_WEIGHTS: Record<string, number> = { 高: 3, 中: 2, 低: 1 };

/** event-interpret-core.ts 的枚举。双向/中性/未知 不带方向，不进净差 */
export const DIRECTIONAL = ["利好", "利空"] as const;
export const NON_DIRECTIONAL = ["双向", "中性", "未知"] as const;

/** 参与计分的事件解读状态（P6-B）：REJECTED 与没跑过的一律不采信 */
export const USABLE_INTERPRET_STATUSES = ["INTERPRETED", "PARTIAL"] as const;

/** 短期扰动默认窗口（日历天）。调用方可按场景收紧，本层不写死在判定之外 */
export const EVENT_STALE_AFTER_DAYS_DEFAULT = 3;

/** 市场整体范围的判定值：impact_scope 里唯一带系统级含义的一档 */
export const MARKET_WIDE_SCOPE = "市场整体";

export interface EventSignal {
  event_id: string;
  /** 事件所属交易日（P6-B 落库的 trade_date）；null = 无法判定新鲜度 */
  trade_date: string | null;
  title?: string;
  /** 利好/利空/双向/中性/未知；不在枚举内按「不采信」登记，不猜方向 */
  impact_direction: string | null;
  /** 个股/板块/行业/主题/产业链/市场整体/海外/未知 */
  impact_scope: string | null;
  /** 高/中/低/无法判断 */
  importance: string | null;
  /** 模型的把握度：只回显，不参与计算（见文件头第 1 条） */
  confidence?: number | null;
  /** INTERPRETED / PARTIAL / REJECTED / 未跑（null 或其它值）*/
  interpretation_status: string | null;
  /** 该事件是否与本决策的标的相关：null = 本次没有相关性判定，E-SUBJECT 就不打分（不猜） */
  relates_to_subject?: boolean | null;
}

export interface EventInput {
  /** 决策参考日（YYYY-MM-DD）。本层不取时钟，纯函数才可测 */
  ref_date: string;
  events: EventSignal[];
  /** 标的名/代码：给了才启用 E-SUBJECT 分项 */
  subject?: string | null;
  stale_after_days?: number;
}

export interface Band {
  min: number;
  max: number | null;
  points: number;
  label: string;
  note?: string;
}

export function pickBand(bands: Band[], v: number): Band | null {
  return bands.find((b) => v >= b.min && (b.max === null || v < b.max)) ?? null;
}

/* --------------------------------------------------- EV-LEVEL：任务书五档（唯一计分项） */

/**
 * 五档的**幅度**表：任务书给了五档的字面分与名字，但没说「消息面强到什么程度算重大」。
 * 本层补的映射线是 |旧表四条字面分合计| ≥12 ⇒ 重大档、6~12 ⇒ 普通档、<6 ⇒ 无影响档：
 *   - 12 = 旧表里「一边倒倾向(10) + 高重要度净多(3)」这一类组合才够得着，单一分项推不出重大；
 *   - 6 = 至少要有两个分项同向（或一个高重要度净差）才算普通档，一条都不算不出时不会走到这里。
 * 阈值写在常量里（测试要能对账），并且带 SUPPLEMENT_MARKER —— 五档分值是任务书的，档位界线是本层的。
 */
export const EVENT_LEVEL_MAJOR = 12;
export const EVENT_LEVEL_MINOR = 6;

export const EVENT_LEVEL_MAGNITUDE_BANDS: Band[] = [
  { min: EVENT_LEVEL_MAJOR, max: null, points: 20, label: "重大" },
  { min: EVENT_LEVEL_MINOR, max: EVENT_LEVEL_MAJOR, points: 10, label: "普通" },
  { min: 0, max: EVENT_LEVEL_MINOR, points: 0, label: "无" },
];

/**
 * 旧表合计 → 新表五档。和 tiltBand 同一个理由：pickBand 左闭右开，带符号写五档会让 ±12 这个端点
 * 一侧进「重大」、另一侧进「普通」，同幅度的利多和利空得分不一样 —— 那是查表方式的边角不对称，
 * 不是「利空更不敏感」的设计意图。所以两侧走同一张幅度表，方向只决定符号与用哪个名字。
 */
export function eventLevelBand(sum: number): Band {
  const v = n2(sum);
  const mag = pickBand(EVENT_LEVEL_MAGNITUDE_BANDS, Math.abs(v))!;
  if (mag.points === 0 || v === 0) {
    return {
      ...mag,
      label: "无实质消息面影响（利多利空相抵或消息面平静）",
      note: `读数存在、按表归入 0 分（消息面平静或利多利空相抵），不是算不出｜界线 |合计|<${EVENT_LEVEL_MINOR} 是本层补的｜${SUPPLEMENT_MARKER}`,
    };
  }
  const major = mag.points === 20;
  const label = v > 0 ? (major ? "重大利好" : "普通利好") : (major ? "重大风险（偏空）" : "普通利空");
  const th = mag.max === null ? `|旧表合计| ≥ ${mag.min}` : `${mag.min} ≤ |旧表合计| < ${mag.max}`;
  return {
    ...mag,
    points: (v > 0 ? 1 : -1) * mag.points,
    label: `${label}（${th}）`,
    note: `五档分值出自任务书；分档界线（±${EVENT_LEVEL_MINOR}/±${EVENT_LEVEL_MAJOR}）｜${SUPPLEMENT_MARKER}`,
  };
}

/* ------------------------------- 旧表四条（P7-③）：继续计算、降级为 basis、喂给 EV-LEVEL */

/**
 * 归一化方向倾向：**幅度**档（按 |加权倾向| 查表，再乘方向符号）。
 * 刻意不写成带符号的五档：pickBand 是左闭右开，带符号写法会把 tilt=−0.6 归进 −6 档、
 * 而 tilt=+0.6 归进 +10 档 —— 同幅度的利多和利空得分不一样。所以两侧必须走同一张幅度表。
 */
export const EVENT_TILT_MAGNITUDE_BANDS: Band[] = [
  { min: 0.6, max: null, points: 10, label: "消息面一边倒" },
  { min: 0.3, max: 0.6, points: 6, label: "消息面有明显偏向" },
  { min: 0, max: 0.3, points: 0, label: "消息面方向不明或利多利空相抵", note: `读数存在、按表归入 0 分，不是算不出｜${EVENT_RULE_PROVENANCE}` },
];

/** 带符号查表：幅度定档、方向定符号，±0.6 与 ±0.3 两个端点在多空两侧完全对称 */
export function tiltBand(tilt: number): Band {
  const v = n2(tilt);
  const mag = pickBand(EVENT_TILT_MAGNITUDE_BANDS, Math.abs(v))!;
  if (mag.points === 0 || v === 0) return mag;
  const dir = v > 0 ? "偏多" : "偏空";
  const th = mag.max === null ? `≥ ${mag.min}` : `${mag.min}~${mag.max}`;
  return {
    ...mag,
    points: (v > 0 ? 1 : -1) * mag.points,
    label: `${mag.label}${dir}（|加权倾向| ${th}）`,
  };
}

/** 高重要度事件净差（条数）：高级事件比总量更能说明「短期扰动」的方向 */
export const EVENT_HIGH_BANDS: Band[] = [
  { min: 2, max: null, points: 6, label: "高重要度利好 ≥2 条多于利空" },
  { min: 1, max: 2, points: 3, label: "高重要度净多 1 条" },
  { min: 0, max: 1, points: 0, label: "高重要度利多利空持平（含当日没有高级事件）", note: `读数存在、按表归入 0 分，不是算不出｜${EVENT_RULE_PROVENANCE}` },
  { min: -1, max: 0, points: -3, label: "高重要度净空 1 条" },
  { min: -Infinity, max: -1, points: -6, label: "高重要度利空明显多于利好" },
];

/** 标的相关事件净差（条数）：只有调用方给了 subject 且事件带了相关性判定才打分 */
export const EVENT_SUBJECT_BANDS: Band[] = [
  { min: 2, max: null, points: 4, label: "与标的相关的利好多于利空 ≥2 条" },
  { min: 1, max: 2, points: 2, label: "与标的相关的净多 1 条" },
  { min: 0, max: 1, points: 0, label: "与标的相关的利多利空持平", note: `读数存在、按表归入 0 分，不是算不出｜${EVENT_RULE_PROVENANCE}` },
  { min: -1, max: 0, points: -2, label: "与标的相关的净空 1 条" },
  { min: -Infinity, max: -1, points: -4, label: "与标的相关的利空明显多于利好" },
];

/** E-SCOPE 的市场整体判定：±5 分，两向同时出现时不净相消 */
export const EVENT_SCOPE_POINTS = { bull: 5, bear: -5, offset: 0, none: 0 };

/** E-SCOPE「没有市场整体级事件」这一档：0 分，且明说这是读数不是缺失 */
const EVENT_SCOPE_NONE: Band = {
  min: 0, max: 1, points: 0,
  label: `当日没有影响范围＝${MARKET_WIDE_SCOPE} 的事件`,
  note: `这是可采信事件的统计结果（消息面本次没有系统级扰动），不是缺数据；0 分不等于利好｜${EVENT_RULE_PROVENANCE}`,
};

export interface EventTally {
  total: number; usable: number; rejected: number; not_interpreted: number;
  stale: number; no_date: number; non_directional: number; unknown_importance: number;
}

export interface EventDimensionResult {
  /** 本维字面分 = EV-LEVEL 一条（±20）；null = 没有任何可采信事件 */
  score: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
  /** 参与/被剔除的条数，页面与台账要看（0 条参与 ⇒ 整维度 null） */
  tally: EventTally;
  /** 旧表四条的字面分合计（EV-LEVEL 的输入）。null = 四条全部算不出 */
  legacy_sum: number | null;
}

const n2 = (x: number) => Math.round(x * 100) / 100;
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}`;
const clip = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 纯日期差：YYYY-MM-DD → 日历日；格式不合法返回 null（不猜、不用本地时区） */
export function dayGap(refDate: string, eventDate: string | null): number | null {
  if (!eventDate) return null;
  const parse = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  };
  const a = parse(refDate);
  const b = parse(eventDate);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86_400_000);
}

/** 计分项（只有 EV-LEVEL 走这里） */
function scoredItem(band: Band, raw: string, extraNote?: string): ScoreItem {
  return {
    rule: "EV-LEVEL", label: band.label, points: band.points, raw, status: "AI_INTERPRETATION",
    note: [band.note, extraNote, EVENT_S7_PROVENANCE].filter(Boolean).join("｜"),
    role: "scored", rule_version: EVENT_RULE_VERSION,
  };
}

/**
 * 旧表分项：读数照常给、points 照常带着 `p7.s3.event.v1` 的字面值，但 role=basis ⇒ 不进本维求和。
 * 它的两点用途：① 作为 EV-LEVEL 的计算来源（合计值）；② 让页面能追问「凭什么说是重大利好」。
 */
function basisItem(rule: string, label: string, band: Band | null, raw: string, why: string): ScoreItem {
  return {
    rule, label: band ? band.label : `${label}：本次给不出读数`, points: band ? band.points : null, raw,
    status: band ? "AI_INTERPRETATION" : "MISSING", role: "basis", rule_version: EVENT_LEGACY_RULE_VERSION,
    note: band
      ? `${why}｜表 ${EVENT_LEGACY_RULE_VERSION}${band.note ? `｜${band.note}` : ""}`
      : `${why}（不是 0 分，也不是「消息面中性」）｜表 ${EVENT_LEGACY_RULE_VERSION}`,
  };
}

const ids = (list: EventSignal[], n = 3) => `${list.length} 条[${list.slice(0, n).map((e) => e.event_id).join("、")}${list.length > n ? `…另 ${list.length - n} 条` : ""}]`;

/**
 * confidence 的**回显**（文件头第 1 条：它不参与任何计算）。写成一行文字挂在 E-TILT 的 raw 上，
 * 措辞刻意避开「概率/胜率/可信度」这类会被误读成市场频率的词，并且明写「不参与打分」。
 */
function confidenceEcho(list: EventSignal[]): string {
  const got = list.map((e) => e.confidence).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (!got.length) return "模型把握度：本批无读数（不影响分数）";
  const avg = got.reduce((a, b) => a + b, 0) / got.length;
  return `模型把握度 ${n2(avg)}（${got.length}/${list.length} 条有值；这是模型对自己那段解释的把握，不是统计频率，不参与打分）`;
}

/** 一条旧表分项的中间结果：band=null 表示这条算不出（既不进合计，也要登记原因） */
interface LegacyHit {
  rule: string;
  label: string;
  band: Band | null;
  raw: string;
  why: string;
}

export interface EventItemsResult {
  items: ScoreItem[];
  missing: string[];
  tally: EventTally;
  legacy_sum: number | null;
}

/**
 * 事件面逐条打分：先算旧表四条（E-TILT 倾向、E-HIGH 高重要度净差、E-SCOPE 市场整体扰动、E-SUBJECT 标的相关），
 * 用它们的字面分合计映射出任务书五档 EV-LEVEL（唯一计分项），再把四条以 basis 身份一并交出去。
 * 剔除原因（REJECTED / 没解读过 / 过期 / 状态残缺）必须留在 missing[] 里，不能只是悄悄少算几条。
 */
export function eventItems(input: EventInput): EventItemsResult {
  const all = input.events ?? [];
  const staleAfter = input.stale_after_days ?? EVENT_STALE_AFTER_DAYS_DEFAULT;
  const missing: string[] = [];
  const rejected: EventSignal[] = [];
  const notInterpreted: EventSignal[] = [];
  const stale: EventSignal[] = [];
  const noDate: EventSignal[] = [];
  const usable: EventSignal[] = [];

  for (const e of all) {
    const st = e.interpretation_status;
    if (!(USABLE_INTERPRET_STATUSES as readonly string[]).includes(st ?? "")) {
      if (st === "REJECTED") rejected.push(e);
      else notInterpreted.push(e);
      continue;
    }
    const gap = dayGap(input.ref_date, e.trade_date);
    if (gap === null) { noDate.push(e); usable.push(e); continue; }
    if (gap > staleAfter) { stale.push(e); continue; }
    usable.push(e);
  }
  if (rejected.length) missing.push(`剔除 ${rejected.length} 条被服务端判为 REJECTED 的解读（${ids(rejected)}）：解读不成立时不给它分数`);
  if (notInterpreted.length) missing.push(`${notInterpreted.length} 条事件本次没有可用的 AI 解读（未跑或状态残缺，${ids(notInterpreted)}）：只有标题不足以定方向，本层不按「无影响」计 0`);
  if (stale.length) missing.push(`剔除 ${stale.length} 条早于参考日 ${staleAfter} 天以上的事件（${ids(stale)}）：事件面按短期扰动口径，不把旧闻算成今天的消息面`);
  if (noDate.length) missing.push(`${noDate.length} 条事件没有所属日期（${ids(noDate)}）：新鲜度无法判定，本层不猜它属于哪天 —— 它们仍参与计算（tally.no_date 有计数），但这次的事件面不能自称「仅当日消息面」`);

  const dirOk = usable.filter((e) => (DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
  const nonDirectional = usable.filter((e) => (NON_DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
  const unknownDir = usable.filter((e) => e.impact_direction !== null && !(DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? "") && !(NON_DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
  if (nonDirectional.length) missing.push(`${nonDirectional.length} 条事件的影响方向是 双向/中性/未知（${ids(nonDirectional)}）：不进方向净差，也不算利空或利好`);
  if (unknownDir.length) missing.push(`${unknownDir.length} 条事件的方向取值不在 P6-B 枚举里（${ids(unknownDir)}）：不猜它属于哪一侧`);

  const hits: LegacyHit[] = [];

  // —— E-TILT：重要性加权后的归一方向倾向 ——
  const weighted = dirOk.filter((e) => e.importance !== null && IMPORTANCE_WEIGHTS[e.importance] !== undefined);
  const unknownImportance = dirOk.length - weighted.length;
  if (unknownImportance > 0) missing.push(`${unknownImportance} 条带方向的事件重要度是「无法判断」或缺失：没有权重就不进净差（不做「默认按中」的凑数）`);
  if (!usable.length) {
    hits.push({
      rule: "E-TILT", label: "消息面方向倾向", band: null,
      raw: `${input.ref_date} 没有任何可采信的事件解读`,
      why: "事件面本次一条可用的解读都没有（库里当日为空、或全部被剔除）：这属于「算不出」，按 0 分参与加权就是把「没读到消息」写成了「消息面中性」",
    });
  } else if (!weighted.length) {
    hits.push({
      rule: "E-TILT", label: "消息面方向倾向", band: null,
      raw: `可采信 ${usable.length} 条，其中带方向且有权重 0 条`,
      why: "没有任何一条带方向且重要性可加权的事件：倾向无定义，不判成 +0",
    });
  } else {
    const pos = weighted.filter((e) => e.impact_direction === "利好");
    const neg = weighted.filter((e) => e.impact_direction === "利空");
    const w = (list: EventSignal[]) => list.reduce((a, e) => a + IMPORTANCE_WEIGHTS[e.importance as string], 0);
    const wp = w(pos);
    const wn = w(neg);
    const tilt = (wp - wn) / (wp + wn);
    const raw = `利好 ${pos.length} 条（权重 ${wp}）／利空 ${neg.length} 条（权重 ${wn}）⇒ 加权倾向 ${signed(n2(tilt))}（归一化，与条数无关）；${confidenceEcho([...pos, ...neg])}；样本事件 ${ids([...pos, ...neg], 2)}`;
    hits.push({ rule: "E-TILT", label: "消息面方向倾向", band: tiltBand(tilt), raw, why: "按重要性加权后的归一方向倾向定档，条数不影响档位" });
  }

  // —— E-HIGH：高重要度事件净差 ——
  const highUsable = usable.filter((e) => e.importance === "高" && (DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
  if (!usable.length) {
    hits.push({ rule: "E-HIGH", label: "高重要度事件净差", band: null, raw: "无可采信事件", why: "本项随事件面整体一起算不出" });
  } else {
    const hp = highUsable.filter((e) => e.impact_direction === "利好").length;
    const hn = highUsable.filter((e) => e.impact_direction === "利空").length;
    hits.push({
      rule: "E-HIGH", label: "高重要度事件净差", band: pickBand(EVENT_HIGH_BANDS, hp - hn)!,
      raw: `高重要度利好 ${hp} 条 − 高重要度利空 ${hn} 条 = ${signed(hp - hn)}（可采信事件 ${usable.length} 条）`,
      why: "高级事件比总量更能说明短期扰动的方向",
    });
  }

  // —— E-SCOPE：有没有覆盖市场整体的扰动 ——
  const marketWide = usable.filter((e) => e.impact_scope === MARKET_WIDE_SCOPE);
  if (!usable.length) {
    hits.push({ rule: "E-SCOPE", label: "市场整体范围扰动", band: null, raw: "无可采信事件", why: "本项随事件面整体一起算不出" });
  } else if (!marketWide.length) {
    hits.push({
      rule: "E-SCOPE", label: "市场整体范围扰动", band: { ...EVENT_SCOPE_NONE },
      raw: `可采信事件 ${usable.length} 条，其中影响范围＝${MARKET_WIDE_SCOPE} 的 0 条`,
      why: "统计结论：本次没有系统级扰动",
    });
  } else {
    const mp = marketWide.filter((e) => e.impact_direction === "利好").length;
    const mn = marketWide.filter((e) => e.impact_direction === "利空").length;
    const band = mp > mn ? { min: 1, max: null, points: EVENT_SCOPE_POINTS.bull, label: "存在偏多的市场整体级事件" }
      : mn > mp ? { min: -Infinity, max: 0, points: EVENT_SCOPE_POINTS.bear, label: "存在偏空的市场整体级事件", note: "市场整体级利空按短期扰动扣分" }
      : { min: 0, max: 1, points: EVENT_SCOPE_POINTS.offset, label: "市场整体级事件利多利空并存或均无方向", note: `本层不净相消也不择一，取 0 并标注｜${EVENT_RULE_PROVENANCE}` };
    hits.push({
      rule: "E-SCOPE", label: "市场整体范围扰动", band,
      raw: `影响范围＝${MARKET_WIDE_SCOPE}：利好 ${mp} 条 / 利空 ${mn} 条 / 共 ${marketWide.length} 条（${ids(marketWide, 2)}）`,
      why: "只有影响范围判为市场整体的事件才走这一项",
    });
  }

  // —— E-SUBJECT：与本标的相关的事件（只有调用方给了 subject 才启用） ——
  if (!input.subject) {
    hits.push({
      rule: "E-SUBJECT", label: "标的相关事件净差", band: null, raw: "本次决策未指定标的",
      why: "没有标的就谈不上「相关事件」，本项不适用；不适用与算不出都不是 0 分",
    });
  } else {
    const rel = usable.filter((e) => e.relates_to_subject === true);
    if (!rel.length) {
      const flagged = usable.filter((e) => typeof e.relates_to_subject === "boolean");
      hits.push({
        rule: "E-SUBJECT", label: "标的相关事件净差", band: null,
        raw: `标的「${clip(input.subject)}」，可采信事件 ${usable.length} 条中带相关性判定的 ${flagged.length} 条`,
        why: flagged.length ? "有相关性判定但没有一条判为相关：不据此给分，因为「不相关」不等于「消息面对它无影响」" : "事件层本次没有提供 标的↔事件 的相关性判定（P6-B 的 affected_symbols 没对上）：本层不拿标题去猜相关",
      });
    } else {
      const rp = rel.filter((e) => e.impact_direction === "利好").length;
      const rn = rel.filter((e) => e.impact_direction === "利空").length;
      const relNonDir = rel.filter((e) => !(DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
      const band = pickBand(EVENT_SUBJECT_BANDS, rp - rn)!;
      hits.push({
        rule: "E-SUBJECT", label: "标的相关事件净差",
        band: { ...band, note: relNonDir.length ? `${band.note ?? ""}｜另有 ${relNonDir.length} 条相关事件不带方向，未计入净差` : band.note },
        raw: `与「${clip(input.subject)}」相关：利好 ${rp} 条 / 利空 ${rn} 条 / 共 ${rel.length} 条（${ids(rel, 2)}）`,
        why: "只统计判为相关的事件（匹配用代码/名称清单，不拿标题猜）",
      });
    }
  }

  // —— 合计旧表字面分 → EV-LEVEL ——
  const got = hits.filter((h) => h.band !== null);
  const legacySum = got.length ? got.reduce((a, h) => a + (h.band as Band).points, 0) : null;
  const items: ScoreItem[] = [];
  if (legacySum === null) {
    items.push({
      rule: "EV-LEVEL", label: "消息面强度分级（任务书五档）", points: null,
      raw: `参考日 ${input.ref_date}：可采信事件 ${usable.length}/${all.length} 条，旧表四条分项全部算不出`,
      status: "MISSING",
      note: "事件面本次一条可用的解读都没有（库里当日为空、或全部被剔除）⇒ 整维度不计分，10/100 的权重按任务书让给其余三维重归一。这不是 0 分，也不是「消息面中性」",
      role: "scored", rule_version: EVENT_RULE_VERSION,
    });
  } else {
    const band = eventLevelBand(legacySum);
    const parts = got.map((h) => `${h.rule} ${signed((h.band as Band).points)}`).join("、");
    const missingRules = hits.filter((h) => h.band === null).map((h) => h.rule);
    items.push(scoredItem(band,
      `旧表四条字面分合计 ${signed(legacySum)}（${parts}）⇒ 按 |合计| 落到任务书五档（界线 ±${EVENT_LEVEL_MINOR}/±${EVENT_LEVEL_MAJOR}）`,
      missingRules.length ? `另有 ${missingRules.length} 条判定依据分项本次算不出（${missingRules.join("、")}）⇒ 合计的可达范围变窄，五档偏保守，不会凭空升档` : undefined));
  }
  for (const h of hits) items.push(basisItem(h.rule, h.label, h.band, h.raw, h.why));

  // confidence 只在这里回显：有缺就登记，但一条都不影响分数
  const noConf = usable.filter((e) => e.confidence === null || e.confidence === undefined);
  if (noConf.length) missing.push(`${noConf.length} 条解读没有 confidence（模型把握度）读数：本层不用它计算，缺了也不影响分数，只影响可解释性`);

  const tally: EventTally = {
    total: all.length, usable: usable.length, rejected: rejected.length, not_interpreted: notInterpreted.length,
    stale: stale.length, no_date: noDate.length, non_directional: nonDirectional.length, unknown_importance: unknownImportance,
  };
  // 血缘同市场面的处理：事件面的每个分数都写着「参考日 + 可采信几条 + 用了哪些 event_id」，
  // 事后复看能回答「那天到底是按哪几条事件给的这个分」，而不只是看到一个数字。
  const lineage = `参考日 ${input.ref_date}｜可采信 ${usable.length}/${all.length} 条`;
  return { items: items.map((i) => ({ ...i, raw: `${i.raw}｜${lineage}` })), missing, tally, legacy_sum: legacySum };
}

export function eventDimension(input: EventInput): EventDimensionResult {
  const { items, missing, tally, legacy_sum } = eventItems(input);
  const scored = items.filter((i) => i.role !== "basis");
  const basis = items.filter((i) => i.role === "basis");
  const counted = scored.filter((i) => i.points !== null);
  if (!counted.length) {
    return {
      score: null, items, legacy_sum,
      missing: [...missing, `事件面 ${scored.length} 个计分分项全部算不出（参考日 ${input.ref_date}，可采信 0 条）：整维度不计分、权重让给可算维度，本层不会用空分母凑出消息面结论`],
      status: "MISSING", tally,
    };
  }
  const nulls = scored.length - counted.length;
  if (nulls) missing.push(`有 ${nulls} 个事件面计分分项算不出，得分只按可算项求和（可能偏保守）`);
  if (basis.length) {
    missing.push(`旧表 ${basis.length} 条分项按判定依据展示、未重复计分（${basis.map((i) => `${i.rule}=${i.points === null ? "无读数" : signed(i.points as number)}`).join("、")}），合计 ${legacy_sum === null ? "无" : signed(legacy_sum)} 用来定 EV-LEVEL 档位`);
  }
  // 分层固定标成 AI_INTERPRETATION：这一维的输入是模型解释，不是行情事实。
  // 降级信息（缺日期、PARTIAL、分项算不出）全部走 missing[]，因为 DataStatus 只有一个字段，
  // 而「它是 AI 解释」这件事比「它这次不完整」更要紧 —— 页面必须能看到前者。
  return {
    score: counted.reduce((a, i) => a + (i.points as number), 0),
    items,
    missing,
    status: "AI_INTERPRETATION",
    tally,
    legacy_sum,
  };
}

/** 直接喂给 buildDecision 的 external 入口（对齐 v3 的 ExternalDimension 契约） */
export function eventExternal(input: EventInput): ExternalDimension {
  const d = eventDimension(input);
  // bounds 在 v3 里是折算的尺子：不带它内核无法把这一维折成 ±100 ⇒ 该维不参与加权（硬规则 4）。
  return { key: "event", score: d.score, rule_version: EVENT_RULE_VERSION, items: d.items, missing: d.missing, status: d.status, bounds: EVENT_EXTREMES };
}

/**
 * 旧表（P7-③ 四条分项）的账面极值 ±25，四个分项都按「净差/倾向」取值、多空对称。
 * v3 起它**不再充当折算尺子**（尺子看下面的 EVENT_EXTREMES），只留给测试与事后对账：
 * 有人问「为什么这一维只能到 ±20」时，答案就是「±25 那张表已经降级成 basis 了」。
 */
export const EVENT_LEGACY_EXTREMES: Bounds = (() => {
  const tiltPts = EVENT_TILT_MAGNITUDE_BANDS.flatMap((b) => [b.points, -b.points]);
  const groups: number[][] = [
    tiltPts,
    EVENT_HIGH_BANDS.map((b) => b.points),
    [EVENT_SCOPE_POINTS.bull, EVENT_SCOPE_POINTS.bear, EVENT_SCOPE_POINTS.offset],
    EVENT_SUBJECT_BANDS.map((b) => b.points),
  ];
  return { max: groups.reduce((a, g) => a + Math.max(...g), 0), min: groups.reduce((a, g) => a + Math.min(...g), 0) };
})();

/**
 * 本表**计分项**（EV-LEVEL 一条）的极值 = ±20，任务书五档给定。
 * 用途 —— ① 随 `eventExternal()` 的 `bounds` 交给 decision-core 折算与 `scoreBounds`；
 * ② 自证 ±20 两端真有一组事件读数打得到（一边倒 + 高重要度净多 ≥2 + 市场整体偏多 + 标的相关 ≥2 = 25 ≥ 12 ⇒ +20）。
 * 事件面天然对称，不会出现市场面那种 +60/−57 的不对称。任务书没给事件面的单维限制，而 ±20 本就在那之下 ⇒ 本层不做夹取。
 */
export const EVENT_EXTREMES: Bounds = {
  min: Math.min(...EVENT_LEVEL_MAGNITUDE_BANDS.map((b) => -b.points)),
  max: Math.max(...EVENT_LEVEL_MAGNITUDE_BANDS.map((b) => b.points)),
};
