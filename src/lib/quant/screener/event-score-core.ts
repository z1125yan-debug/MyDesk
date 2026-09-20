// P7-③ 事件面（event_score）打分规则表 —— 纯内核：无 DB、无 fetch、无时钟，node --test 可直跑。
//
// 与 market-score-core.ts 同一个授权来源：任务书 §六 没有事件面打分表，§七 却挂了 10/100 权重，
// P7-① 因此把 RULE_VERSIONS.event 写成 null 并拒绝打分。本文件补的就是那张表，版本号
// `p7.s3.event.v1`（不是 `p7.taskbook.*`），并且有一条测试专门钉住这个出处区分。
//
// 事件面是四个维度里唯一**输入本身来自 AI 解释层**的：impact_direction / impact_scope / importance
// 都是 P6-B 由模型产出、经服务端字段核对后落库的（event-interpret-core.ts:113 EventInterpretation）。
// 所以本层的分层与事实层不同：能算出来的分项 status 一律 AI_INTERPRETATION，绝不写成 REAL/DERIVED，
// 让 decision-core 的 layers 里能看到「这一维的解释成分来自模型」。
//
// 三条防越界的设计（各对应至少一条测试）：
// 1) **confidence 不参与计算**。它是模型对自己那段解释的把握度（0~1），event-interpret-core.ts:157 的
//    提示词就明写着「不是上涨概率」。这里只在 E-TILT 的 raw 文案里回显本批均值（confidenceEcho），
//    缺读数则在 missing[] 里登记；如果拿它当系数去乘分数，就等于把 AI 的自我把握伪装成市场概率，
//    还会让同一批事件因为换了一个模型给出不同的档位。
// 2) **不被条数灌分**：方向倾向用归一化净差 (W_pos − W_neg)/(W_pos + W_neg)，1 条利好与 10 条利好的
//    档位相同。事件面在 §七 的定位是「短期扰动」，它回答的是「消息面偏向哪边、有多强」，
//    不是「今天抓到了多少条新闻」——后者只反映抓取窗口，把它算成分会让结论随 cron 频率漂移。
// 3) **旧闻不算今天的扰动**：每条事件按 trade_date 与决策日的天数差判定，超过 stale_after_days 的
//    不参与计分并登记。本层不看时钟（纯函数），参考日由调用方传 shanghaiDate()。
//
// 缺失口径与 P7-① 一致：缺读数 = points=null 且进 missing[]；一条都算不出 ⇒ score=null，
// 由 buildDecision 把 10/100 的权重从分母里拿掉。**「当日 0 条事件」与「事件表读不到」都走 null**，
// 不给 0 分 —— 后者是研究层已经写过的口径（research.ts:237「真实为空 ⇒ 不猜新闻」）。
// 反过来，「事件里有 2 条利好 2 条利空、方向相抵」是读数存在，取 0 分并在 note 里写清楚。

import type { ExternalDimension, ScoreItem } from "./decision-core";
import type { DataStatus } from "./datastatus-core";

/** 规则表版本：s3 = P7 第三阶段，event = 本表 */
export const EVENT_RULE_VERSION = "p7.s3.event.v1";
export const EVENT_RULE_PROVENANCE = "P7-③ 本层规则表（任务书 §六 无事件面打分表），非任务书原文";

/** 重要性权重：只有这三档参与归一化净差。「无法判断」不参与，见 eventItems 的登记 */
export const IMPORTANCE_WEIGHTS: Record<string, number> = { 高: 3, 中: 2, 低: 1 };

/** event-interpret-core.ts:79 的枚举。双向/中性/未知 不带方向，不进净差 */
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

/**
 * 归一化方向倾向：**幅度**档（按 |加权倾向| 查表，再乘方向符号）。
 * 刻意不写成带符号的五档：pickBand 是左闭右开，带符号写法会把 tilt=−0.6 归进 −6 档、
 * 而 tilt=+0.6 归进 +10 档 —— 同幅度的利多和利空得分不一样。那属于查表方式的边角不对称，
 * 不是「利空更不敏感」的设计意图，所以两侧必须走同一张幅度表。
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

export interface EventDimensionResult {
  score: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
  /** 参与/被剔除的条数，页面与台账要看（0 条参与 ⇒ 整维度 null） */
  tally: { total: number; usable: number; rejected: number; not_interpreted: number; stale: number; no_date: number; non_directional: number; unknown_importance: number };
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

function item(rule: string, band: Band, raw: string): ScoreItem {
  return {
    rule, label: band.label, points: band.points, raw, status: "AI_INTERPRETATION",
    note: [band.note, EVENT_RULE_PROVENANCE].filter(Boolean).join("｜"),
  };
}

function missingItem(rule: string, label: string, raw: string, note: string): ScoreItem {
  return { rule, label, points: null, raw, status: "MISSING", note: `${note}（不是 0 分，也不是「消息面中性」）` };
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

/**
 * 事件面逐条打分。四个分项：E-TILT 倾向、E-HIGH 高重要度净差、E-SCOPE 市场整体扰动、E-SUBJECT 标的相关。
 * 先用统一口径把「不采信」的事件挑出来并登记原因（REJECTED / 没解读过 / 过期 / 状态残缺），
 * 再对剩下的 usable 事件查表 —— 剔除的原因必须留在 missing[] 里，不能只是悄悄少算几条。
 */
export function eventItems(input: EventInput): { items: ScoreItem[]; missing: string[]; tally: EventDimensionResult["tally"] } {
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

  const items: ScoreItem[] = [];

  // —— E-TILT：重要性加权后的归一方向倾向 ——
  const weighted = dirOk.filter((e) => e.importance !== null && IMPORTANCE_WEIGHTS[e.importance] !== undefined);
  const unknownImportance = dirOk.length - weighted.length;
  if (unknownImportance > 0) missing.push(`${unknownImportance} 条带方向的事件重要度是「无法判断」或缺失：没有权重就不进净差（不做「默认按中」的凑数）`);
  if (!usable.length) {
    items.push(missingItem("E-TILT", "消息面方向倾向", `${input.ref_date} 没有任何可采信的事件解读`, "事件面本次一条可用的解读都没有（库里当日为空、或全部被剔除）：这属于「算不出」，按 0 分参与加权就是把「没读到消息」写成了「消息面中性」"));
  } else if (!weighted.length) {
    items.push(missingItem("E-TILT", "消息面方向倾向", `可采信 ${usable.length} 条，其中带方向且有权重 0 条`, "没有任何一条带方向且重要性可加权的事件：倾向无定义，不判成 +0"));
  } else {
    const pos = weighted.filter((e) => e.impact_direction === "利好");
    const neg = weighted.filter((e) => e.impact_direction === "利空");
    const w = (list: EventSignal[]) => list.reduce((a, e) => a + IMPORTANCE_WEIGHTS[e.importance as string], 0);
    const wp = w(pos);
    const wn = w(neg);
    const tilt = (wp - wn) / (wp + wn);
    const raw = `利好 ${pos.length} 条（权重 ${wp}）／利空 ${neg.length} 条（权重 ${wn}）⇒ 加权倾向 ${signed(n2(tilt))}（归一化，与条数无关）；${confidenceEcho([...pos, ...neg])}；样本事件 ${ids([...pos, ...neg], 2)}`;
    items.push(item("E-TILT", tiltBand(tilt), raw));
  }

  // —— E-HIGH：高重要度事件净差 ——
  const highUsable = usable.filter((e) => e.importance === "高" && (DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
  if (!usable.length) {
    items.push(missingItem("E-HIGH", "高重要度事件净差", "无可采信事件", "本项随事件面整体一起算不出"));
  } else {
    const hp = highUsable.filter((e) => e.impact_direction === "利好").length;
    const hn = highUsable.filter((e) => e.impact_direction === "利空").length;
    items.push(item("E-HIGH", pickBand(EVENT_HIGH_BANDS, hp - hn)!, `高重要度利好 ${hp} 条 − 高重要度利空 ${hn} 条 = ${signed(hp - hn)}（可采信事件 ${usable.length} 条）`));
  }

  // —— E-SCOPE：有没有覆盖市场整体的扰动 ——
  const marketWide = usable.filter((e) => e.impact_scope === MARKET_WIDE_SCOPE);
  if (!usable.length) {
    items.push(missingItem("E-SCOPE", "市场整体范围扰动", "无可采信事件", "本项随事件面整体一起算不出"));
  } else {
    if (!marketWide.length) {
      items.push(item("E-SCOPE", { ...EVENT_SCOPE_NONE }, `可采信事件 ${usable.length} 条，其中影响范围＝${MARKET_WIDE_SCOPE} 的 0 条`));
    } else {
      const mp = marketWide.filter((e) => e.impact_direction === "利好").length;
      const mn = marketWide.filter((e) => e.impact_direction === "利空").length;
      const band = mp > mn ? { min: 1, max: null, points: EVENT_SCOPE_POINTS.bull, label: "存在偏多的市场整体级事件" }
        : mn > mp ? { min: -Infinity, max: 0, points: EVENT_SCOPE_POINTS.bear, label: "存在偏空的市场整体级事件", note: "市场整体级利空按短期扰动扣分" }
        : { min: 0, max: 1, points: EVENT_SCOPE_POINTS.offset, label: "市场整体级事件利多利空并存或均无方向", note: `本层不净相消也不择一，取 0 并标注｜${EVENT_RULE_PROVENANCE}` };
      items.push(item("E-SCOPE", band, `影响范围＝${MARKET_WIDE_SCOPE}：利好 ${mp} 条 / 利空 ${mn} 条 / 共 ${marketWide.length} 条（${ids(marketWide, 2)}）`));
    }
  }

  // —— E-SUBJECT：与本标的相关的事件（只有调用方给了 subject 才启用） ——
  if (!input.subject) {
    items.push(missingItem("E-SUBJECT", "标的相关事件净差", "本次决策未指定标的", "没有标的就谈不上「相关事件」，本项不适用；不适用与算不出都不是 0 分"));
  } else {
    const rel = usable.filter((e) => e.relates_to_subject === true);
    if (!rel.length) {
      const flagged = usable.filter((e) => typeof e.relates_to_subject === "boolean");
      items.push(missingItem("E-SUBJECT", "标的相关事件净差", `标的「${clip(input.subject)}」，可采信事件 ${usable.length} 条中带相关性判定的 ${flagged.length} 条`, flagged.length ? "有相关性判定但没有一条判为相关：不据此给分，因为「不相关」不等于「消息面对它无影响」" : "事件层本次没有提供 标的↔事件 的相关性判定（P6-B 的 affected_symbols 没对上）：本层不拿标题去猜相关"));
    } else {
      const rp = rel.filter((e) => e.impact_direction === "利好").length;
      const rn = rel.filter((e) => e.impact_direction === "利空").length;
      const relNonDir = rel.filter((e) => !(DIRECTIONAL as readonly string[]).includes(e.impact_direction ?? ""));
      const band = pickBand(EVENT_SUBJECT_BANDS, rp - rn)!;
      items.push(item("E-SUBJECT", { ...band, note: relNonDir.length ? `${band.note ?? ""}｜另有 ${relNonDir.length} 条相关事件不带方向，未计入净差` : band.note }, `与「${clip(input.subject)}」相关：利好 ${rp} 条 / 利空 ${rn} 条 / 共 ${rel.length} 条（${ids(rel, 2)}）`));
    }
  }

  // confidence 只在这里回显：有缺就登记，但一条都不影响分数
  const noConf = usable.filter((e) => e.confidence === null || e.confidence === undefined);
  if (noConf.length) missing.push(`${noConf.length} 条解读没有 confidence（模型把握度）读数：本层不用它计算，缺了也不影响分数，只影响可解释性`);

  const tally = {
    total: all.length, usable: usable.length, rejected: rejected.length, not_interpreted: notInterpreted.length,
    stale: stale.length, no_date: noDate.length, non_directional: nonDirectional.length, unknown_importance: unknownImportance,
  };
  // 血缘同市场面的处理：事件面的每个分数都写着「参考日 + 可采信几条 + 用了哪些 event_id」，
  // 事后复看能回答「那天到底是按哪几条事件给的这个分」，而不只是看到一个数字。
  const lineage = `参考日 ${input.ref_date}｜可采信 ${usable.length}/${all.length} 条`;
  return { items: items.map((i) => ({ ...i, raw: `${i.raw}｜${lineage}` })), missing, tally };
}

export function eventDimension(input: EventInput): EventDimensionResult {
  const { items, missing, tally } = eventItems(input);
  const counted = items.filter((i) => i.points !== null);
  if (!counted.length) {
    return {
      score: null, items, missing: [...missing, `事件面 ${items.length} 个分项全部算不出（参考日 ${input.ref_date}，可采信 0 条）：整维度不计分、权重让给可算维度，本层不会用空分母凑出消息面结论`],
      status: "MISSING", tally,
    };
  }
  const nulls = items.length - counted.length;
  if (nulls) missing.push(`有 ${nulls} 个事件面分项算不出，得分只按可算项求和（可能偏保守）`);
  // 分层固定标成 AI_INTERPRETATION：这一维的输入是模型解释，不是行情事实。
  // 降级信息（缺日期、PARTIAL、分项算不出）全部走 missing[]，因为 DataStatus 只有一个字段，
  // 而「它是 AI 解释」这件事比「它这次不完整」更要紧 —— 页面必须能看到前者。
  return {
    score: counted.reduce((a, i) => a + (i.points as number), 0),
    items,
    missing,
    status: "AI_INTERPRETATION",
    tally,
  };
}

/** 直接喂给 buildDecision 的 external 入口（对齐 ExternalDimension 契约） */
export function eventExternal(input: EventInput): ExternalDimension {
  const d = eventDimension(input);
  // bounds 只用于 decision-core 的可达区间对账，不参与打分（见 market-score-core 同一格的理由）。
  return { key: "event", score: d.score, rule_version: EVENT_RULE_VERSION, items: d.items, missing: d.missing, status: d.status, bounds: EVENT_EXTREMES };
}

/**
 * 本表的极值，用途同 MARKET_EXTREMES：随 `eventExternal()` 的 `bounds` 交给 decision-core 的
 * `scoreBounds`，并自证 ±25 两端真有一组事件读数打得到（CEILING/FLOOR 两组 fixture）。
 * 事件面天然对称（±25）：四个分项都按「净差/倾向」取值，利多与利空走同一张表的两侧，
 * 所以不会出现市场面那种 +30 / −33 的不对称 —— 那一侧的不等来自风险等级只有看空方向才扣分。
 */
export const EVENT_EXTREMES: { min: number; max: number } = (() => {
  const tiltPts = EVENT_TILT_MAGNITUDE_BANDS.flatMap((b) => [b.points, -b.points]);
  const groups: number[][] = [
    tiltPts,
    EVENT_HIGH_BANDS.map((b) => b.points),
    [EVENT_SCOPE_POINTS.bull, EVENT_SCOPE_POINTS.bear, EVENT_SCOPE_POINTS.offset],
    EVENT_SUBJECT_BANDS.map((b) => b.points),
  ];
  return { max: groups.reduce((a, g) => a + Math.max(...g), 0), min: groups.reduce((a, g) => a + Math.min(...g), 0) };
})();
