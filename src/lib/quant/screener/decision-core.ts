// P7-① 统一决策层的纯内核（无 DB、无 fetch、无时钟，node --test 可直跑）。
//
// 这一层要解决的是 P7 任务书 §一「问题 2」：技术分析说看涨、历史统计说 1 日上涨概率三成，
// 两个模块各说各话，用户不知道信哪个。已核对过的前提（D:/Zai/p7-review.md）：全库不存在
// 「无条件上涨概率」——probability.ts 的三档是**条件概率**、similar-env.ts 的是**相似环境**，
// 两者样本定义不同。所以决策层的第一件事不是把分数加起来，而是不让不同口径被混成一个数。
//
// 三条硬规则（REAL_DATA_ONLY 在本层的可执行版本）：
// 1) 缺数据 ≠ 0 分 ≠ 中性，三者走三条路：
//    算不出的分项 points=null 且出现在 missing[]；整维度算不出 ⇒ 该维度不进分母；
//    只有「读数存在、按表归入 0 分档」才是 0 分（这类项在 note 里都写明了是 0 而非 null）。
// 2) 没有打分规则的维度不许参与加权。任务书 §六 只给了技术面规则，market_score / event_score
//    只有 §七 的权重没有规则 ⇒ 本层不替它发明规则；调用方若自带规则版本，必须显式传 rule_version。
//    P7-③ 补出了这两张自认规则的表（p7.s3.market.v1 / p7.s3.event.v1，前缀刻意不是 taskbook），
//    P7-④ 接线后 RULE_VERSIONS 的两格不再是 null —— 但这条纪律本身没变：**空 rule_version 依旧等于没带规则**，
//    调用方不传这一维仍然走「未计入」出口（有测试钉住），补表不等于给缺失数据兜底。
// 3) 输出是「得分 + 分级」，不产出百分号形式的可信度。得分是规则加权的结果，不是「明天对的概率」；
//    写成 72% 会直接撞上已提交的概率出处判据（agent-loop-core.ts 的 probabilityCheck：
//    答案里出现「概率/胜率」就要求 trade_date/sample/horizon 三项口径）。概率要展示就单独展示原始口径。
//
// 打分表（§五/§六）照抄任务书，不擅自调整；为把它变成可判定的代码，补了半开区间与三处原表没有
// 定义的分数空洞（1 日 35%–55% → 0、RSI 70–75 → −5、MACD 跨零轴 → 0）。这三处已由评审确认结论
// §一·规格 B 选定 B1 方案认可，并要求 note 带 SUPPLEMENT_MARKER（「本层补充，非原始任务书定义」）留痕。
// 结论映射阈值不沿用 §七 原值：那套（≥50 看涨 / <−50 看跌）在 §五/§六 打分表下属于永远打不出来的死档。
// 评审确认结论 §一·规格 A 选了 A1（≥+30 / +5~+30 / −20~+5 / −40~−20 / <−40），我在核对中指出 <−40 仍够不到
// （全表地板 −35），用户随后把看跌线提到 <−30 ⇒ 现行表 = A1.1，五档在任意生效权重组合下全部可达（见 GRADE_BANDS）。

import type { DataStatus } from "./datastatus-core";

/**
 * 决策层输出契约版本。
 * v1 → v2（P7-④）：① 市场/事件两维的规则版本不再是 null（P7-③ 补表后接线）；
 * ② attainable 从「只建模技术+概率」变成按输入声明的外部维度极值一起算。
 * 落库/页面上的旧 v1 结论卡不得按 v2 口径解读。
 */
export const DECISION_PROTOCOL_VERSION = "p7.decision.v2";

/** 映射表出处：§七 原阈值作废 → 评审确认结论 §一·规格 A（A1）→ A1 的看跌线补丁（<−40 够不到，提到 <−30） */
export const GRADE_MAPPING_VERSION = "p7.review.s1.A1.1";

/**
 * 打分规则版本表。
 * 市场/事件两格在 P7-① 里是 null —— 那时任务书 §六 确实没有这两张表，「有权重无规则」的维度
 * 一旦参与加权，页面就会出现一个没人能追问出处的数。P7-③ 补出了两张自认出处的规则表
 * （market-score-core.ts / event-score-core.ts，版本号前缀 `p7.s3.*` 而非 `p7.taskbook.*`），
 * P7-④ 接线后这里不再是 null。字面量与两张表里的常量必须一致，由 p7-decision.test.ts 钉住
 * （依赖方向保持「规则表 → 决策内核」，不让内核反向 import 规则表）。
 */
export const RULE_VERSIONS: Record<DimensionKey, string | null> = {
  technical: "p7.taskbook.s6",
  probability: "p7.taskbook.s5",
  market: "p7.s3.market.v1",
  event: "p7.s3.event.v1",
};

export type DimensionKey = "technical" | "probability" | "market" | "event";
export const DECISION_DIMENSIONS: DimensionKey[] = ["technical", "probability", "market", "event"];

/** 任务书 §七 的权重。维度缺失时按可算维度的比例重归一，而不是等权平均 */
export const DEFAULT_WEIGHTS: Record<DimensionKey, number> = {
  technical: 0.4, probability: 0.3, market: 0.2, event: 0.1,
};

export const DIMENSION_LABEL: Record<DimensionKey, string> = {
  technical: "技术结构", probability: "历史概率", market: "市场环境", event: "事件影响",
};

/**
 * 概率面分档（任务书 §五）。区间一律**左闭右开 [min,max)**；win_rate 用库里的 0–100 量纲
 * （factors/probability.ts 的 horizons[].win_rate 本身就是百分数，接线时不要再乘 100）。
 *
 * 原文有两处不能直接判定，本文件的处理：
 * - 边界重叠（「≥55」与「45–55」都含 55）⇒ 高分档优先命中，即 [55,101) 先匹配，[45,55) 不含 55；
 * - 1 日的 35%–55% 没定义得分（区间空洞）⇒ 补 0 分档。这里取 0 而非 null，是因为读数存在、
 *   只是任务书没说它值几分，与「算不出」不同性质（见该档 note）。
 * 数组末尾的 max=101 只是右开端点，不让 100% 这个合法值掉到区间外。
 */
export interface ProbBand { min: number; max: number; points: number; label: string; note?: string }
/**
 * 评审确认结论 §一·规格 B 要求：凡本层替任务书补的分数，note 里必须带这句原文标记，
 * 让「谁定的分」在数据里可查，而不是混在规则自带的文案里。
 */
export const SUPPLEMENT_MARKER = "本层补充，非原始任务书定义";
export const PROBABILITY_BANDS: Record<1 | 5 | 20, ProbBand[]> = {
  20: [
    { min: 55, max: 101, points: 20, label: "20 日 ≥55%" },
    { min: 45, max: 55, points: 5, label: "20 日 45%–55%" },
    { min: 35, max: 45, points: 0, label: "20 日 35%–45%" },
    { min: 0, max: 35, points: -20, label: "20 日 <35%" },
  ],
  5: [
    { min: 55, max: 101, points: 10, label: "5 日 ≥55%" },
    { min: 40, max: 55, points: 0, label: "5 日 40%–55%" },
    { min: 0, max: 40, points: -10, label: "5 日 <40%" },
  ],
  1: [
    { min: 55, max: 101, points: 5, label: "1 日 ≥55%" },
    { min: 35, max: 55, points: 0, label: "1 日 35%–55%", note: `任务书 §五 未定义本档得分，补为 0（读数存在、只是没说值几分），不是「算不出」｜${SUPPLEMENT_MARKER}` },
    { min: 0, max: 35, points: -5, label: "1 日 <35%" },
  ],
};

/** 概率读数的来源引擎。两种口径不可混算，混了整维度不出分（见 probabilityDimension） */
export type ProbabilityEngine = "conditional" | "similar_env";
export const PROBABILITY_ENGINE_TEXT: Record<ProbabilityEngine, string> = {
  conditional: "条件概率（historicalWinProbability：必须带筛选条件，无条件时它自己就返回 null）",
  similar_env: "相似环境（similarReturnForward：按上证日涨跌幅落在带宽内的历史日算后续胜率，无条件口径）",
};

/** 样本量下限沿用两个引擎自带的 sample_ok（<30 时它们各自已产警示），本层不另立标准 */
export const PROBABILITY_MIN_SAMPLE = 30;

export interface ProbabilityReading {
  horizon: 1 | 5 | 20;
  /** 0–100；null = 这个期限本次算不出（引擎给的 win_rate 就是 null，不是 0%） */
  win_rate: number | null;
  sample_size: number;
  /** 读数属于哪个交易日/快照日：不是「今天」就得写清楚是哪天 */
  trade_date?: string | null;
  /** 样本区间起止。两个引擎都产出 period，本层要求带上来，否则证据链无法事后重建 */
  period?: { start: string; end: string } | null;
}

export interface ProbabilityInput {
  engine: ProbabilityEngine;
  /** 条件概率口径下的筛选条件原文；similar_env 可省 */
  conditions?: string[];
  /** 引擎自带的 warnings 原文，本层只转述不改写 */
  warnings?: string[];
  readings: ProbabilityReading[];
  status?: DataStatus;
}

/** 技术面一条规则的输入读数：全部允许 null；null 一律读成「本项算不出」，不读成 0 分 */
export interface TechnicalInput {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  close: number | null;
  /** MACD：dif/dea/bar 各取当日与前一日（bar = 2*(dif-dea)，与 fields.ts 的 macdCalc 同口径） */
  dif: number | null;
  dea: number | null;
  dif_prev: number | null;
  dea_prev: number | null;
  bar: number | null;
  bar_prev: number | null;
  /** 库里同时有 rsi_7/14/24，周期由调用方选定并记账；任务书没指定，本层不默认它是哪一条 */
  rsi: number | null;
  rsi_period?: number;
  /** 任务书 §四 把成交量列为技术面输入，§六 却没给打分表 ⇒ 不补规则，只登记为未计入 */
  volume_note?: string;
}

export interface ScoreItem {
  /** 规则号，便于事后追问「这条分数是哪张表给的」 */
  rule: string;
  label: string;
  /** null = 本项算不出（缺读数）；0 = 读数有、按表归入 0 分档。UI 上必须区分这两者 */
  points: number | null;
  /** 原始读数的文字（带数值与口径），用户能对着它复核 */
  raw: string;
  status: DataStatus;
  note?: string;
}

export interface DimensionResult {
  key: DimensionKey;
  /** null = 该维度本次不参与加权（无规则 / 全算不出 / 口径冲突） */
  score: number | null;
  rule_version: string | null;
  items: ScoreItem[];
  /** 为什么没算进来 / 哪些分项没算出来，原文，页面要显示在结论旁边 */
  missing: string[];
  status: DataStatus;
  /** 重归一后的实际权重；0 表示未参与 */
  weight_applied: number;
}

export interface DecisionConflict {
  /** 任务书 §九 的方向：分歧要说明，不下单边结论 */
  statement: string;
  technical_score: number;
  probability_win_rate: number;
  probability_horizon: number;
  engine: ProbabilityEngine;
  trigger: { technical_min: number; probability_max: number };
}

export interface DecisionSource {
  dimension: DimensionKey;
  rule: string;
  engine?: ProbabilityEngine;
  horizon?: number;
  win_rate?: number | null;
  sample?: number;
  trade_date?: string | null;
  period?: { start: string; end: string } | null;
}

export interface Decision {
  protocol_version: string;
  subject: string | null;
  /** 加权综合得分；null = 没有任何可加权维度，此时不给分级也不给结论 */
  final_score: number | null;
  grade: string | null;
  /** 是否属于「多维度分歧、不下单边确认」的情形（任务书 §九） */
  single_side: boolean;
  conflict: DecisionConflict | null;
  statement: string;
  /** 四个维度按 DECISION_DIMENSIONS 顺序给出，含未计入的（score=null） */
  dimensions: DimensionResult[];
  included: DimensionKey[];
  excluded: { key: DimensionKey; reason: string }[];
  weights: { requested: Record<DimensionKey, number>; applied: Record<DimensionKey, number>; renormalized: boolean };
  /** 本次结论涉及的来源分层（REAL/DERIVED/HISTORICAL/AI_INTERPRETATION…），混层时页面要标出来 */
  layers: DataStatus[];
  /**
   * 打分表在**本次生效权重**下的得分可达区间。参与加权的外部维度只有把规则表极值（`ExternalDimension.bounds`）
   * 带进来才会被建模；没带进来的那些维不在区间里，basis 的可达性那句话会点名说它「区间比真实区间窄」。
   * 四维全参与、§七 原权重下的参考区间是 −33.6 ~ +41（见 scoreBounds 的注释）。
   */
  attainable: { min: number; max: number; unreachable_grades: string[] };
  sources: DecisionSource[];
  basis: string;
}

const n1 = (x: number) => Math.round(x * 10) / 10;
const fnum = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? "无" : `${n1(x)}`);
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}`;

/** 单档概率查表：区间左闭右开；null 或越出 0–100 的读数一律不判定（不承认「越界读数的得分」存在） */
export function probabilityPointsFor(horizon: 1 | 5 | 20, win_rate: number | null): number | null {
  if (win_rate === null || Number.isNaN(win_rate) || win_rate < 0 || win_rate > 100) return null;
  const band = PROBABILITY_BANDS[horizon].find((b) => win_rate >= b.min && win_rate < b.max);
  return band ? band.points : null;
}

/**
 * 技术面逐条打分（任务书 §六）。每条规则产出一个分项，缺读数的分项是 null。
 *
 * 注意这里刻意不吃因子面板的现成列：fields.ts:671 的 crossUp 在任一侧为 null 时返回 0
 * （= 把「没有前一天的数据」读成「没有金叉」），ma_struct 在仅 c 为 null 时也返回 0。
 * 决策层要的是「算不出就说算不出」，所以从原始数值自己判，并在这里写明为什么不复用。
 */
export function technicalItems(input: TechnicalInput): ScoreItem[] {
  const items: ScoreItem[] = [];
  const { ma5, ma10, ma20, close, dif, dea, dif_prev, dea_prev, bar, bar_prev } = input;

  if (ma5 === null || ma10 === null || ma20 === null) {
    items.push({ rule: "T-MA-STRUCT", label: "均线多空排列", points: null, raw: `MA5=${fnum(ma5)} / MA10=${fnum(ma10)} / MA20=${fnum(ma20)}`, status: "MISSING", note: "均线有缺，本项不计分（不是计 0 分）" });
  } else if (ma5 > ma10 && ma10 > ma20) {
    items.push({ rule: "T-MA-STRUCT", label: "均线多头排列（MA5>MA10>MA20）", points: 20, raw: `MA5=${fnum(ma5)} > MA10=${fnum(ma10)} > MA20=${fnum(ma20)}`, status: "DERIVED" });
  } else if (ma5 > ma20) {
    items.push({ rule: "T-MA-STRUCT", label: "MA5>MA20（非完整多头）", points: 10, raw: `MA5=${fnum(ma5)} > MA20=${fnum(ma20)}；MA10=${fnum(ma10)} 未落在两者之间`, status: "DERIVED" });
  } else {
    items.push({ rule: "T-MA-STRUCT", label: "均线无看涨结构", points: 0, raw: `MA5=${fnum(ma5)} / MA10=${fnum(ma10)} / MA20=${fnum(ma20)}`, status: "DERIVED", note: "读数存在、按表归入 0 分，不是算不出" });
  }

  if (close === null || ma20 === null) {
    items.push({ rule: "T-MA-BREAK", label: "价格与 MA20 的关系", points: null, raw: `收盘=${fnum(close)} / MA20=${fnum(ma20)}`, status: "MISSING", note: "收盘或 MA20 缺失，本项不计分" });
  } else if (close < ma20) {
    items.push({ rule: "T-MA-BREAK", label: "价格跌破 MA20", points: -15, raw: `收盘 ${fnum(close)} < MA20 ${fnum(ma20)}`, status: "DERIVED" });
  } else {
    items.push({ rule: "T-MA-BREAK", label: "价格未跌破 MA20", points: 0, raw: `收盘 ${fnum(close)} ≥ MA20 ${fnum(ma20)}`, status: "DERIVED", note: "任务书 §六 只写了跌破扣分，站上不加分" });
  }

  if (dif === null || dea === null || dif_prev === null || dea_prev === null) {
    items.push({ rule: "T-MACD-CROSS", label: "MACD 金叉", points: null, raw: `dif=${fnum(dif)} / dea=${fnum(dea)}（当日或前一日值缺失）`, status: "MISSING", note: "金叉要当日与前一日两组值；缺前一天时不判定，也不沿用因子面板 crossUp 的「缺数据返回 0」写法" });
  } else {
    const crossed = dif > dea && dif_prev <= dea_prev;
    const expanding = bar !== null && bar_prev !== null && bar >= bar_prev;
    if (crossed && expanding) {
      items.push({ rule: "T-MACD-CROSS", label: "MACD 金叉且红柱未缩短", points: 15, raw: `dif ${fnum(dif)} 上穿 dea ${fnum(dea)}，柱 ${fnum(bar_prev)}→${fnum(bar)}`, status: "DERIVED" });
    } else {
      items.push({
        rule: "T-MACD-CROSS",
        label: crossed ? "MACD 金叉但柱体在缩短" : "MACD 无金叉",
        points: 0,
        raw: crossed ? `dif ${fnum(dif)} > dea ${fnum(dea)}，柱 ${fnum(bar_prev)}→${fnum(bar)}（未扩大）` : `dif ${fnum(dif)} / dea ${fnum(dea)}（前一日 dif ${fnum(dif_prev)} / dea ${fnum(dea_prev)}）`,
        status: "DERIVED",
        note: crossed ? "任务书要求「金叉且红柱扩大」，只满足金叉不给分" : undefined,
      });
    }
  }

  if (dif === null || dea === null) {
    items.push({ rule: "T-MACD-ZERO", label: "MACD 零轴位置", points: null, raw: `dif=${fnum(dif)} / dea=${fnum(dea)}`, status: "MISSING" });
  } else if (dif > 0 && dea > 0) {
    items.push({ rule: "T-MACD-ZERO", label: "MACD 零轴上方运行", points: 10, raw: `dif ${fnum(dif)} > 0 且 dea ${fnum(dea)} > 0`, status: "DERIVED" });
  } else if (dif < 0 && dea < 0) {
    items.push({ rule: "T-MACD-ZERO", label: "MACD 零轴下方运行", points: -10, raw: `dif ${fnum(dif)} < 0 且 dea ${fnum(dea)} < 0`, status: "DERIVED" });
  } else {
    items.push({ rule: "T-MACD-ZERO", label: "MACD 跨零轴（一上一下）", points: 0, raw: `dif ${fnum(dif)} / dea ${fnum(dea)}`, status: "DERIVED", note: `任务书 §六 只定义两侧同号，异号取 0 分并标注「跨零轴状态」，不猜方向｜${SUPPLEMENT_MARKER}` });
  }

  const rp = input.rsi_period ?? 14;
  if (input.rsi === null) {
    items.push({ rule: "T-RSI", label: `RSI(${rp}) 分档`, points: null, raw: "RSI 缺失", status: "MISSING" });
  } else {
    const r = input.rsi;
    // 任务书 §六 原文：55–70 +10、50–55 0、<50 −10、>75 −5 ⇒ (70,75] 是空洞。
    // 本实现保守取超买侧的 −5：这一段既没被授权给强势分，也没被授权给中性，宁可少给。
    const band = r > 75 || (r > 70 && r <= 75) ? { p: -5, l: r > 75 ? "超买过热" : "超买前哨（70–75 空洞）" } : r >= 55 ? { p: 10, l: "强势区间" } : r >= 50 ? { p: 0, l: "中性偏强" } : { p: -10, l: "偏弱" };
    const inGap = r > 70 && r <= 75;
    items.push({
      rule: "T-RSI", label: `RSI(${rp}) ${band.l}`, points: band.p,
      raw: `RSI(${rp})=${fnum(r)}`, status: "DERIVED",
      note: inGap ? `任务书只写了 55–70 给 +10 与 >75 给 −5，70–75 是空洞；保守取超买侧的 −5（宁可不给强势分，也不给中性）｜${SUPPLEMENT_MARKER}` : undefined,
    });
  }

  items.push({
    rule: "T-VOLUME", label: "成交量", points: null,
    raw: input.volume_note ?? "任务书 §四 把成交量列为技术面输入，§六 未给出打分表",
    status: "MISSING", note: "没有规则 ⇒ 不补规则、不计 0 分，只出现在未计入清单里",
  });
  return items;
}

export interface ProbabilityDimension {
  score: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
}

/**
 * 概率面。**同一维度不接受两个引擎、或同一期限两条读数的混算**：条件概率与相似环境的样本定义不同，
 * 同一天与另一天的读数也不属同一个窗口，相加/平均得到的数没有口径可解释——而任务书方向二想消除的
 * 正是这种「两个数各说各话」。混了就整维度不出分，并把原因报出来，让页面显示「口径冲突」而不是给个数。
 */
export function probabilityDimension(inputs: ProbabilityInput | ProbabilityInput[]): ProbabilityDimension {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const items: ScoreItem[] = [];
  const missing: string[] = [];
  const first = list[0];
  if (!first) return { score: null, items, missing: ["概率面本次没有任何期限的读数：不计分，权重让给可算维度"], status: "MISSING" };
  if (list.length > 1) {
    return {
      score: null, items,
      missing: [`概率面一次传入 ${list.length} 份读数（引擎：${list.map((p) => p.engine).join("、")}）：不同引擎/不同窗口的概率不能相加也不能平均，本层拒绝混算，请只留一份并注明口径`],
      status: "MISSING",
    };
  }
  const input = first;
  const seen = new Set<number>();
  const dup = input.readings.filter((r) => (seen.has(r.horizon) ? true : (seen.add(r.horizon), false)));
  if (dup.length) {
    return {
      score: null, items,
      missing: [`同一期限出现 ${dup.length + 1} 条读数（${[...new Set(dup.map((d) => d.horizon))].join("、")} 日）：本层不择一、不平均，先决定要用哪个窗口再喂进来`],
      status: "MISSING",
    };
  }
  if (!input.readings.length) return { score: null, items, missing: ["概率面本次没有任何期限的读数：不计分，权重让给可算维度"], status: "MISSING" };

  let sum = 0;
  let counted = 0;
  let degraded = false;
  for (const r of input.readings) {
    const band = r.win_rate === null ? null : PROBABILITY_BANDS[r.horizon].find((b) => r.win_rate! >= b.min && r.win_rate! < b.max);
    const raw = `${input.engine === "conditional" ? "条件概率" : "相似环境"} ${r.horizon} 日上涨概率 ${r.win_rate === null ? "算不出" : `${n1(r.win_rate)}%`}（样本 ${r.sample_size}${r.period ? `，区间 ${r.period.start}→${r.period.end}` : "，区间未给出"}${r.trade_date ? `，读数所属日 ${r.trade_date}` : ""}）`;
    const pts = probabilityPointsFor(r.horizon, r.win_rate);
    if (pts === null || !band) {
      items.push({ rule: `P-${r.horizon}D`, label: `${r.horizon} 日概率分档`, points: null, raw, status: "MISSING", note: r.win_rate === null ? "引擎本次返回 null（样本不足或窗口不够），不是 0%" : "读数越出 0–100，本层不判定" });
      missing.push(`${r.horizon} 日：本次没有可用的上涨概率读数${r.win_rate === null ? "（引擎自报算不出）" : ""}`);
      continue;
    }
    const smallSample = r.sample_size < PROBABILITY_MIN_SAMPLE;
    if (smallSample) degraded = true;
    items.push({
      rule: `P-${r.horizon}D`, label: `${band.label} 档`, points: pts, raw, status: "HISTORICAL",
      note: smallSample
        ? `样本 ${r.sample_size} < ${PROBABILITY_MIN_SAMPLE}：历史频率本身仍有值，但整维度按降级处理（引擎自带的 sample_ok 就是 false）`
        : "历史统计，不是对今天的预测",
    });
    sum += pts;
    counted += 1;
  }
  if (input.warnings?.length) missing.push(...input.warnings.map((w) => `引擎自报：${w}`));
  if (input.engine === "conditional" && !input.conditions?.length) {
    missing.push(`条件概率口径没有给出筛选条件：probability.ts 在无条件时本就返回 null，这里同样不承认它能代表「上涨概率」（出处：${PROBABILITY_ENGINE_TEXT.conditional}）`);
  }
  if (!counted) return { score: null, items, missing, status: "MISSING" };
  return { score: sum, items, missing, status: degraded ? "DEGRADED" : (input.status ?? "DERIVED") };
}

/** 调用方自带规则时用的维度输入（市场面/事件面将来补出规则表后走这个入口） */
export interface ExternalDimension {
  key: "market" | "event";
  score: number | null;
  rule_version: string;
  items?: ScoreItem[];
  missing?: string[];
  status?: DataStatus;
  /**
   * 这张规则表能给出的最高/最低分（P7-③ 两个 core 里的 `*_EXTREMES`）。
   * 只用于 `attainable` 的可达区间对账，**不参与任何打分**。不带它 ⇒ 本层不知道这一维能走多远，
   * 区间就按不建模处理（宁可报窄并在 basis 里登记，也不猜一个极值把区间撑宽）。
   */
  bounds?: { min: number; max: number } | null;
}

function resolveExternal(key: "market" | "event", d: ExternalDimension | undefined, label: string, weight: number): DimensionResult {
  if (!d || !d.rule_version) {
    return {
      key, score: null, rule_version: null, items: [],
      missing: [`${label}面本次没有传入打分结果（§七 挂了 ${n1(weight * 100)}/100 的权重，§六 原本没有这张表、P7-③ 补出的规则表版本是 ${RULE_VERSIONS[key]}）：没有规则读数就不计分、权重从分母里拿掉，本层也不替它把「没算」写成 0 分`],
      status: "MISSING", weight_applied: 0,
    };
  }
  const driftNote = d.rule_version !== RULE_VERSIONS[key]
    ? `｜注意：本次传入的规则版本是「${d.rule_version}」，与内核登记的「${RULE_VERSIONS[key]}」不一致 —— 有一边过期了，这条结论的版本归属要重新核对`
    : "";
  return {
    key: d.key, score: d.score, rule_version: d.rule_version, items: d.items ?? [],
    missing: d.score === null
      ? [`${label}面自带规则「${d.rule_version}」，但本次没算出得分`]
      : [...(d.missing ?? []), ...(driftNote ? [driftNote.slice(1)] : [])],
    status: d.score === null ? "MISSING" : (d.status ?? "DERIVED"), weight_applied: 0,
  };
}

/**
 * 结论映射表。**阈值来自评审确认结论 §一·规格 A（A1），并含其后续补丁**：A1 定的是
 * ≥+30 / +5~+30 / −20~+5 / −40~−20 / <−40，但 −40 这条线在 §五/§六 打分表下永远够不到
 * （技术面与概率面的地板都是 −35，生效权重自和为 1 ⇒ final_score ≥ −35），用户据此把看跌线
 * 提到 <−30、偏弱档收成 −30~−20，本表就是改后的这一版；原任务书 §七 的 ≥50 / <−50 早已作废。
 * 左闭右开：+30 归「看涨」，+5 归「偏强震荡」，−20 归「中性」，−30 归「偏弱」。
 * max=null 表示无上界，min=-Infinity 表示无下界；本表是唯一事实源，gradeForScore 与可达性自检都读它。
 */
export const GRADE_BANDS: Record<string, { min: number; max: number | null }> = {
  看涨: { min: 30, max: null },
  偏强震荡: { min: 5, max: 30 },
  中性: { min: -20, max: 5 },
  偏弱: { min: -30, max: -20 },
  看跌: { min: -Infinity, max: -30 },
};
export const GRADE_ORDER = ["看涨", "偏强震荡", "中性", "偏弱", "看跌"] as const;

/** 结论映射（见 GRADE_BANDS）：左闭右开 */
export function gradeForScore(score: number): string {
  if (score >= GRADE_BANDS.看涨.min) return "看涨";
  if (score >= GRADE_BANDS.偏强震荡.min) return "偏强震荡";
  if (score >= GRADE_BANDS.中性.min) return "中性";
  if (score >= GRADE_BANDS.偏弱.min) return "偏弱";
  return "看跌";
}

/** 技术面极值：每条规则各自取本层能给的最高/最低分（同组互斥的档不会同时命中，故按组求极值） */
function technicalExtremes(): { min: number; max: number } {
  const groups: number[][] = [
    [20, 10, 0], // 均线结构（互斥三档）
    [0, -15], // 与 MA20 的关系
    [15, 0], // 金叉且红柱扩大
    [10, 0, -10], // 零轴
    [10, 0, -5, -10], // RSI
  ];
  return { max: groups.reduce((a, g) => a + Math.max(...g), 0), min: groups.reduce((a, g) => a + Math.min(...g), 0) };
}

function probabilityExtremes(): { min: number; max: number } {
  const per = ([1, 5, 20] as const).map((h) => PROBABILITY_BANDS[h].map((b) => b.points));
  return { max: per.reduce((a, g) => a + Math.max(...g), 0), min: per.reduce((a, g) => a + Math.min(...g), 0) };
}

/**
 * 当前打分表能把 final_score 推到哪。唯一用途是让「映射表里有档位永远出不来」变成可断言、
 * 可显示的事实。
 *
 * 技术面极值 +55 / −35，概率面 +35 / −35，两者恒参与建模。市场面与事件面由调用方把各自规则表的
 * 极值（`MARKET_EXTREMES` / `EVENT_EXTREMES`）通过第二个参数声明进来：
 *   - 四维全参与、按 §七 原权重 0.4/0.3/0.2/0.1 ⇒ **−33.6 ~ +41**
 *     （技术 55×0.4 + 概率 35×0.3 + 市场 30×0.2 + 事件 25×0.1 = 41；
 *      技术 −35×0.4 + 概率 −35×0.3 + 市场 −33×0.2 + 事件 −25×0.1 = −33.6）；
 *   - 不声明外部极值时本函数退回 P7-① 的两维口径（+32.5 ~ −24.5），报出的区间**偏窄**，
 *     调用方必须自己说明为什么没带（buildDecision 会把它登记进 basis）。
 * 历史说明：P7-① 时期这两维还没有规则表，所以本函数不建模它们；A1 的「看跌 <−40」在那套地板下
 * 够不到，用户据此把线提到 <−30（A1.1）。现行表下五档全部可达，unreachable_grades 应为空——
 * 一旦它非空，说明打分表或权重被动过，要回到评审重新拍板，不是在页面上加个兜底文案。
 */
export function scoreBounds(
  weights: Record<DimensionKey, number> = DEFAULT_WEIGHTS,
  external: Partial<Record<"market" | "event", { min: number; max: number } | null | undefined>> = {},
): { min: number; max: number; unreachable_grades: string[] } {
  const tech = technicalExtremes();
  const prob = probabilityExtremes();
  let max = tech.max * (weights.technical || 0) + prob.max * (weights.probability || 0);
  let min = tech.min * (weights.technical || 0) + prob.min * (weights.probability || 0);
  for (const k of ["market", "event"] as const) {
    const b = external[k];
    if (!b) continue; // 没声明极值 = 不知道这一维能走多远，不猜
    max += b.max * (weights[k] || 0);
    min += b.min * (weights[k] || 0);
  }
  max = n1(max);
  min = n1(min);
  const unreachable = GRADE_ORDER.filter((label) => {
    const g = GRADE_BANDS[label];
    const reachable = max >= g.min && (g.max === null ? true : min < g.max);
    return !reachable;
  });
  return { min, max, unreachable_grades: unreachable };
}

/** §九 冲突判定的触发线：技术面给出看涨侧分数，而概率面的短期读数落在最低档 */
export const CONFLICT_TECHNICAL_MIN = 15;
export const CONFLICT_PROBABILITY_MAX = 35;

export function detectConflict(techScore: number | null, input?: ProbabilityInput): DecisionConflict | null {
  if (techScore === null || techScore < CONFLICT_TECHNICAL_MIN || !input) return null;
  const hit = input.readings.find((r) => r.horizon === 1 && r.win_rate !== null && r.win_rate < CONFLICT_PROBABILITY_MAX);
  if (!hit) return null;
  const wr = n1(hit.win_rate as number);
  return {
    technical_score: techScore,
    probability_win_rate: wr,
    probability_horizon: hit.horizon,
    engine: input.engine,
    trigger: { technical_min: CONFLICT_TECHNICAL_MIN, probability_max: CONFLICT_PROBABILITY_MAX },
    statement: `技术出现反弹信号，但${input.engine === "conditional" ? "该条件下的历史" : "历史相似环境"}胜率较低（${hit.horizon} 日上涨概率 ${wr}%，样本 ${hit.sample_size}${hit.period ? `，${hit.period.start}→${hit.period.end}` : "，样本区间未给出"}），当前属于反弹观察阶段，不属于强趋势上涨确认。`,
  };
}

export interface BuildDecisionInput {
  technical?: TechnicalInput;
  /** 传数组时本层会拒绝混算（见 probabilityDimension），保留数组入口是为了让上层能显式表达「拿到了两份口径」 */
  probability?: ProbabilityInput | ProbabilityInput[];
  external?: ExternalDimension[];
  weights?: Partial<Record<DimensionKey, number>>;
  /** 标的与口径（只用于展示与落库标注，本层不据此计算任何东西） */
  subject?: string;
}

/** 归并成 probabilityDimension 接受的输入形态（它自己负责拒绝多份混算） */
function asProbability(p: ProbabilityInput | ProbabilityInput[] | undefined): ProbabilityInput | ProbabilityInput[] | undefined {
  return p;
}

export function buildDecision(input: BuildDecisionInput): Decision {
  const weights: Record<DimensionKey, number> = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const techItems = input.technical ? technicalItems(input.technical) : [];
  const techDim: DimensionResult = input.technical
    ? (() => {
        const counted = techItems.filter((i) => i.points !== null);
        if (!counted.length) return { key: "technical", score: null, rule_version: RULE_VERSIONS.technical, items: techItems, missing: ["技术面所有分项本次都算不出"], status: "MISSING", weight_applied: 0 };
        const nulls = techItems.filter((i) => i.points === null).map((i) => `${i.label}：${i.raw}`);
        return {
          key: "technical", score: counted.reduce((a, i) => a + (i.points as number), 0), rule_version: RULE_VERSIONS.technical, items: techItems,
          missing: nulls.length ? [`有 ${nulls.length} 个技术分项算不出，得分只按可算项求和（可能偏保守）：${nulls.join("；")}`] : [],
          status: nulls.length ? "DEGRADED" : "DERIVED", weight_applied: 0,
        } as DimensionResult;
      })()
    : { key: "technical", score: null, rule_version: RULE_VERSIONS.technical, items: [], missing: ["技术面没有任何读数输入：整维度不计分"], status: "MISSING", weight_applied: 0 };

  const probIn = asProbability(input.probability);
  const probSingle: ProbabilityInput | null = probIn && !Array.isArray(probIn) ? probIn : (probIn && probIn.length === 1 ? probIn[0] : null);
  const probDim: DimensionResult = probIn
    ? (() => {
        const p = probabilityDimension(probIn);
        return { key: "probability", score: p.score, rule_version: RULE_VERSIONS.probability, items: p.items, missing: p.missing, status: p.status, weight_applied: 0 } as DimensionResult;
      })()
    : { key: "probability", score: null, rule_version: RULE_VERSIONS.probability, items: [], missing: ["概率面没有读数（未指定来源引擎或本次没取到概率）：不计分"], status: "MISSING", weight_applied: 0 };

  const dims: DimensionResult[] = [
    techDim,
    probDim,
    resolveExternal("market", input.external?.find((e) => e.key === "market"), DIMENSION_LABEL.market, weights.market),
    resolveExternal("event", input.external?.find((e) => e.key === "event"), DIMENSION_LABEL.event, weights.event),
  ];

  const includedDims = dims.filter((d) => d.score !== null);
  const sumW = includedDims.reduce((a, d) => a + (weights[d.key] || 0), 0);
  const applied: Record<DimensionKey, number> = { technical: 0, probability: 0, market: 0, event: 0 };
  for (const d of includedDims) {
    d.weight_applied = sumW > 0 ? Math.round(((weights[d.key] || 0) / sumW) * 10000) / 10000 : 0;
    applied[d.key] = d.weight_applied;
  }
  const final_score = includedDims.length ? n1(includedDims.reduce((a, d) => a + (d.score as number) * d.weight_applied, 0)) : null;
  const conflict = detectConflict(techDim.score, probSingle ?? undefined);
  const grade = final_score === null ? null : conflict ? "反弹观察" : gradeForScore(final_score);
  const layers = [...new Set(includedDims.flatMap((d) => [d.status, ...d.items.map((i) => i.status)]))];
  // 血缘：每条计入得分的概率读数都带上引擎/样本/区间/期限，页面与复校验都吃这个，不吃文案
  const sources: DecisionSource[] = probSingle
    ? probSingle.readings
        .filter((r) => probabilityPointsFor(r.horizon, r.win_rate) !== null)
        .map((r) => ({
          dimension: "probability" as DimensionKey, rule: `P-${r.horizon}D`, engine: probSingle.engine,
          horizon: r.horizon, win_rate: r.win_rate, sample: r.sample_size, trade_date: r.trade_date ?? null, period: r.period ?? null,
        }))
    : [];

  const statement = final_score === null
    ? "综合判断：算不出。所有维度本次都没有可加权的得分（见 excluded），本层不会用一个空分母凑出结论。"
    : `综合判断：${grade}（加权得分 ${signed(final_score)}）。得分是规则加权的结果，不是概率，也不是对本次判断正确性的百分比。${conflict ? ` ${conflict.statement}` : ""}`;

  // 可达区间按**生效权重**算：维度被剔除后权重落到剩余维度上，档位可达性会跟着变，
  // 这正是必须每次重算、不能写死一张表的原因。
  const effWeights: Record<DimensionKey, number> = { technical: 0, probability: 0, market: 0, event: 0 };
  for (const d of includedDims) effWeights[d.key] = d.weight_applied;
  // 外部维度的极值只认「本次真的参与加权、且调用方把规则表的极值带过来了」的那几维。
  // 没带就不是没有区间，而是本层不知道它能走多远 ⇒ 按不建模算，区间偏窄，并在 basis 里登记（不静默）。
  const externalExtremes: Partial<Record<"market" | "event", { min: number; max: number }>> = {};
  const unmodeled: ("market" | "event")[] = [];
  for (const ext of input.external ?? []) {
    if (!(effWeights[ext.key] > 0)) continue;
    if (ext.bounds && Number.isFinite(ext.bounds.min) && Number.isFinite(ext.bounds.max)) {
      externalExtremes[ext.key] = ext.bounds;
    } else if (!unmodeled.includes(ext.key)) {
      unmodeled.push(ext.key);
    }
  }
  const bounds = scoreBounds(includedDims.length ? effWeights : DEFAULT_WEIGHTS, externalExtremes);
  const effText = DECISION_DIMENSIONS.filter((k) => effWeights[k] > 0).map((k) => `${DIMENSION_LABEL[k]} ${effWeights[k]}`).join("、");
  const unmodeledNote = unmodeled.length
    ? `；${unmodeled.map((k) => DIMENSION_LABEL[k]).join("、")}参与加权但没带规则表极值，本层不猜它能给几分 ⇒ 区间比真实区间窄`
    : "";
  const attainingNote = includedDims.length === 0
    ? "没有任何维度参与加权，综合得分无区间可言"
    : `按本次生效权重（${effText}）综合得分只能落在 ${bounds.min} ~ ${bounds.max}${bounds.unreachable_grades.length ? `，映射表里的「${bounds.unreachable_grades.join("、")}」在这个区间内永远打不出来（阈值现按评审 A1.1，出现这句说明打分表或权重被动过，需回到评审重新拍板）` : "，映射表五档全部可达"}；维度被剔除会让权重落到剩余维度上、区间随之变窄或变宽，所以同一个字面结论取决于有几维参与${unmodeledNote}`;

  return {
    protocol_version: DECISION_PROTOCOL_VERSION,
    subject: input.subject ?? null,
    final_score,
    grade,
    single_side: !conflict && final_score !== null && grade !== null && grade !== "中性",
    conflict,
    statement,
    dimensions: dims,
    included: includedDims.map((d) => d.key),
    excluded: dims.filter((d) => d.score === null).map((d) => ({ key: d.key, reason: d.missing[0] ?? `${DIMENSION_LABEL[d.key]}面未计入` })),
    weights: { requested: weights, applied, renormalized: includedDims.length > 0 && includedDims.length < dims.length },
    layers,
    attainable: bounds,
    sources,
    basis: [
      `决策层 ${DECISION_PROTOCOL_VERSION}｜规则版本：技术=${RULE_VERSIONS.technical} 概率=${RULE_VERSIONS.probability} 市场=${RULE_VERSIONS.market ?? "无（本层不补规则）"} 事件=${RULE_VERSIONS.event ?? "无（本层不补规则）"}`,
      `映射阈值 ${GRADE_MAPPING_VERSION}（左闭右开）：${GRADE_ORDER.map((g) => `${g} [${Number.isFinite(GRADE_BANDS[g].min) ? GRADE_BANDS[g].min : "-∞"},${GRADE_BANDS[g].max === null ? "∞" : GRADE_BANDS[g].max})`).join(" ")}`,
      input.subject ? `标的：${input.subject}` : "标的：未指定",
      "区间口径：概率分档与技术分档一律左闭右开，win_rate 用 0–100 量纲",
      "缺失口径：算不出的分项 points=null 并出现在 missing[]，不计 0 分；整维度算不出则不进分母，权重按剩余维度重归一",
      includedDims.length === dims.length
        ? "四个维度全部可加权"
        : `本次只有 ${includedDims.map((d) => DIMENSION_LABEL[d.key]).join("、") || "无"} 可加权，权重从 ${DECISION_DIMENSIONS.map((k) => `${DIMENSION_LABEL[k]} ${weights[k]}`).join("、")} 重归一为 ${includedDims.map((d) => `${DIMENSION_LABEL[d.key]} ${d.weight_applied}`).join("、") || "没有"}`,
      `概率面引擎：${probSingle ? PROBABILITY_ENGINE_TEXT[probSingle.engine] : probIn ? "本次拒绝混算：传入多份概率读数" : "本次未取概率读数"}`,
      attainingNote,
    ].join(" / "),
  };
}

/**
 * 给 AI 层/页面用的纯文本结论块（任务书 §八 的「完整归因」形态）。
 * 本函数产出的文本里不会出现任何「可信度 xx%」式表述；百分号只出现在历史概率读数本身，
 * 且每次出现都跟着样本数与区间，便于过 probabilityCheck。
 */
export function decisionToText(d: Decision): string {
  const lines = [d.statement, "原因拆解："];
  for (const dim of d.dimensions) {
    if (dim.score === null) continue;
    lines.push(`  ${DIMENSION_LABEL[dim.key]}：${signed(dim.score)} 分（生效权重 ${Math.round(dim.weight_applied * 100)}/100，分层 ${dim.status}）`);
    for (const i of dim.items.filter((x) => x.points !== null)) {
      // note 里装的是「这一档为什么给这个分」与「历史统计不是预测」这类必须见人的口径，不能只留在 JSON 里
      lines.push(`    · ${i.label} ${signed(i.points as number)}｜${i.raw}${i.note ? `｜${i.note}` : ""}（${i.status}）`);
    }
  }
  if (d.excluded.length) {
    lines.push("未计入（不是 0 分，是没算）：");
    for (const e of d.excluded) lines.push(`  ${DIMENSION_LABEL[e.key]}：${e.reason}`);
  }
  for (const dim of d.dimensions) for (const m of dim.missing) lines.push(`  缺口【${DIMENSION_LABEL[dim.key]}】${m}`);
  lines.push(`综合得分 ${d.final_score === null ? "算不出" : signed(d.final_score)}，分级「${d.grade ?? "无"}」${d.single_side ? "" : "（本条不属于单边确认）"}`);
  lines.push(`口径：${d.basis}`);
  return lines.join("\n");
}
