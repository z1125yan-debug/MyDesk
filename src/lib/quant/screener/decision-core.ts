// P7-⑦ 统一决策层的纯内核 v3（无 DB、无 fetch、无时钟，node --test 可直跑）。
//
// v3 改的是**刻度**，不是「再补几条规则」。P7-⑦ 任务书《完整 AI 决策系统开发文档》要求：
//   · 放弃「上涨概率 xx%」这种范式，改成 **综合评分（−100~+100）+ 趋势等级（六档）**；
//   · 权重 技术 40 / 历史概率 30 / 市场环境 20 / 事件 10，技术面与市场面各限 ±50；
//   · 六档：+80~+100 强势看多 / +50~+80 偏强看多 / +20~+50 震荡偏强 / −20~+20 中性震荡 /
//     −50~−20 偏弱 / −100~−50 弱势看空；
//   · 事件面无可用数据时 event_score=null，其余三维修权重归一（这条 v1 起就是这么做的）。
// 直接按任务书的字面分加权会得到 −36.5 ~ +42（实测），六档里 强势看多 / 偏强看多 / 弱势看空
// **三档是永远打不出来的死档**，而任务书后续要做的回测（score>50 与 score<−30）根本没有样本。
// 用户 2026-09-21 就此拍板：**每一维先按本维上下限折算到 −100~+100，再按 40/30/20/10 加权**
// —— 六档全部可达、任务书阈值原样保留，代价是页面上那个 +63 不等于任何一张表字面分之和，
// 所以本层把「字面分 raw_score」「折算分 norm_score」「本维极值 bounds」三样都留在输出里，
// 折算过程可复算，不归一化变成黑箱。
//
// 四条硬规则（REAL_DATA_ONLY 在本层的可执行版本；前 3 条自 P7-① 起一字未改）：
// 1) 缺数据 ≠ 0 分 ≠ 中性：算不出的分项 points=null 且进 missing[]；整维度算不出 ⇒ 不进分母；
//    只有「读数存在、按表归入 0 分档」才是 0 分（这类项 note 里写明是 0 而非 null）。
// 2) 没有打分规则的维度不许参与加权；调用方自带规则必须显式传 rule_version（空串 = 没带规则）。
// 3) 输出不产出「可信度 xx%」。得分是规则加权结果，不是明日概率；百分号只允许出现在**带全套口径的
//    历史概率读数**里（引擎/期限/样本/区间/所属日），这样才过得了 agent-loop-core 的 probabilityCheck。
// 4) v3 新增、与第 2 条同一条纪律：**没声明本维极值（bounds）就没法折算 ⇒ 这一维不参与加权**。
//    折算要用「这张表能给几分」当尺子；尺子不知道就别猜一个把区间撑宽，登记成未计入（有测试钉住）。
//    这一条与 v2 相反：v2 里 bounds 只用于可达区间对账、不影响打分；v3 里它是折算的前提。
//
// 新旧表并入的判定纪律（用户拍板「新表为主 + 旧表并入」）：
//   · 同一个指标（如涨跌家数、基准指数、MACD 零轴）⇒ 按新分法计分，旧分项转 `role:"basis"`
//     继续显示读数但**不重复计权**，并带着它自己的 rule_version；
//   · 新表没有这个指标（如中位涨跌幅、炸板率、主力净额、主线数量）⇒ 旧分项继续计分。
//
// 规则版本前缀的语义：`p7.taskbook.*` = 任务书原文表；`p7.s3.*` = P7-③ 本层自认表；
// `p7.s7.*` = P7-⑦ 任务书给的表。字面量一致性由 p7-decision.test.ts 钉住（内核不 import 规则表）。

import type { DataStatus } from "./datastatus-core";

/**
 * 决策层输出契约版本。
 * v1 → v2（P7-④）：① 市场/事件两维的规则版本不再是 null；② attainable 按输入声明的外部维度极值一起算。
 * v2 → v3（P7-⑦）：① 刻度从「字面分加权和」换成「每维折算到 ±100 后加权和」，DimensionResult 多出
 * raw_score / norm_score / bounds / excluded_reason 四格；② 结论映射从五档（A1.1）换成任务书六档；
 * ③ 技术面/概率面按 P7-⑦ 表重做，旧分项降级 basis；④ bounds 缺失的维度不再参与加权（硬规则 4）；
 * ⑤ 冲突不再把等级改写成「反弹观察」（六档表恰好六个标签，塞第七个进去就是把映射表改样）。
 * 落库/页面上的旧 v1/v2 结论卡不得按 v3 口径解读：同一个数字在两套刻度下不是一回事。
 */
export const DECISION_PROTOCOL_VERSION = "p7.decision.v3";

/** 映射表出处：P7-⑦ 任务书给的六档阈值（本层不调整，只把「左闭右开」写死并做可达性自检） */
export const GRADE_MAPPING_VERSION = "p7.s7.six.v1";

/**
 * 旧映射表留档（P7-① 评审 A1.1 的五档）。留着不是为了兼容打分 —— v3 已经不走这套刻度 ——
 * 而是让「为什么页面上再也不会出现『看涨/偏强震荡』」有出处可查。
 */
export const RETIRED_GRADE_BANDS: Record<string, { version: string; bands: Record<string, { min: number; max: number | null }> }> = {
  "p7.review.s1.A1.1": {
    version: "p7.review.s1.A1.1",
    bands: {
      看涨: { min: 30, max: null }, 偏强震荡: { min: 5, max: 30 }, 中性: { min: -20, max: 5 },
      偏弱: { min: -30, max: -20 }, 看跌: { min: -Infinity, max: -30 },
    },
  },
};

/**
 * 打分规则版本表。四格全部按 P7-⑦ 任务书的表；市场/事件两维里并入的旧分项各自带自己的
 * `p7.s3.*`（写在 ScoreItem.rule_version 上），不要把两代表当成同一代。
 * 字面量必须与各张表里的常量一致，由 p7-decision.test.ts 钉住（依赖方向：规则表 → 决策内核）。
 */
export const RULE_VERSIONS: Record<DimensionKey, string | null> = {
  technical: "p7.s7.technical.v1",
  probability: "p7.s7.probability.v1",
  market: "p7.s7.market.v1",
  event: "p7.s7.event.v1",
};

export type DimensionKey = "technical" | "probability" | "market" | "event";
export const DECISION_DIMENSIONS: DimensionKey[] = ["technical", "probability", "market", "event"];

/** P7-⑦ 任务书的权重。维度不参与加权时按可加权维度的比例重归一，而不是等权平均 */
export const DEFAULT_WEIGHTS: Record<DimensionKey, number> = {
  technical: 0.4, probability: 0.3, market: 0.2, event: 0.1,
};

export const DIMENSION_LABEL: Record<DimensionKey, string> = {
  technical: "技术结构", probability: "历史概率", market: "市场环境", event: "事件影响",
};

/**
 * 单维字面分限制（P7-⑦ 任务书：技术面与市场面「单维限制 −50~+50」）。
 * 只在任务书明写的两维上夹；概率面与事件面按各自表的极值折算，不额外夹。
 * 夹到边界这件事本身要留痕（见 technicalDimension 的 missing 登记），不能悄悄少算。
 */
export const DIMENSION_CLAMP: Partial<Record<DimensionKey, number>> = { technical: 50, market: 50 };

/**
 * 评审确认结论 §一·规格 B 要求：凡本层替任务书补的分数/判据，note 里必须带这句原文标记。
 * v3 里任务书留的口子比 v2 多（金叉 DIF=0、下跌缩量、未触及压力位、RSI>70、盈亏比三档的数值线、
 * 事件等级阈 12/6…），全部走这个标记，不允许混在规则自带文案里。
 */
export const SUPPLEMENT_MARKER = "本层补充，非原始任务书定义";

/* ------------------------------------------------------------------ 共享工具 */

export interface Bounds { min: number; max: number }

export interface Band {
  min: number;
  /** null = 无上界 */
  max: number | null;
  points: number;
  label: string;
  note?: string;
}

/** 区间一律左闭右开 [min,max)（与 P7-①/③ 各表同约定）：边界只有唯一归属 */
export function pickBand(bands: Band[], v: number): Band | null {
  return bands.find((b) => v >= b.min && (b.max === null || v < b.max)) ?? null;
}

/** 折算刻度：一组字面分能到 ±100 的尺子（正负共用一把，避免「利多满分、利空不满分」） */
export function normalizationScale(b: Bounds): number {
  return Math.max(Math.abs(b.min), Math.abs(b.max));
}

/**
 * 字面分 → 折算分（−100~+100）。
 * scale = max(|min|,|max|)：概率面账面是 +40/−25，一把尺量下来就是 −62.5~+100，
 * 这种不对称**如实**反映在结论的可达区间里，不去修正它（修正就是替任务书改表）。
 * 没有 bounds 就没法折算 ⇒ 返回 null，调用方把这一维按未计入处理（硬规则 4）。
 */
export function normalizeScore(raw: number | null, b: Bounds | null | undefined): number | null {
  if (raw === null || !Number.isFinite(raw) || !b) return null;
  const scale = normalizationScale(b);
  if (!(scale > 0)) return null;
  return n2(Math.max(-100, Math.min(100, (raw / scale) * 100)));
}

/** 一组字面分极值折算后的区间（可达性自检用） */
export function normalizedBounds(b: Bounds | null | undefined): Bounds | null {
  if (!b) return null;
  const lo = normalizeScore(b.min, b);
  const hi = normalizeScore(b.max, b);
  if (lo === null || hi === null) return null;
  return { min: lo, max: hi };
}

/** 按任务书把某一维字面分夹进 ±limit，夹了就把夹前夹后都报出来（登记而不是静默） */
export function clampRaw(key: DimensionKey, raw: number): { value: number; clampedFrom: number | null } {
  const limit = DIMENSION_CLAMP[key];
  if (!limit || Math.abs(raw) <= limit) return { value: raw, clampedFrom: null };
  return { value: raw > 0 ? limit : -limit, clampedFrom: raw };
}

/* ------------------------------------------------------------------ 结论映射（六档） */

/**
 * 结论映射表 = P7-⑦ 任务书六档，阈值原样保留（这正是选「维度归一到 ±100」这套刻度的理由：
 * 只有把每一维折到 ±100，任务书这套 80/50/20/−20/−50 才有档位打得出来）。
 * 左闭右开：+80 归强势看多，+50 归偏强看多，+20 归震荡偏强，−20 归中性震荡，−50 归偏弱。
 * 本表是唯一事实源：gradeForScore 与可达性自检都读它，页面不得另写一套档位名。
 */
export const GRADE_BANDS: Record<string, { min: number; max: number | null }> = {
  强势看多: { min: 80, max: null },
  偏强看多: { min: 50, max: 80 },
  震荡偏强: { min: 20, max: 50 },
  中性震荡: { min: -20, max: 20 },
  偏弱: { min: -50, max: -20 },
  弱势看空: { min: -Infinity, max: -50 },
};
export const GRADE_ORDER = ["强势看多", "偏强看多", "震荡偏强", "中性震荡", "偏弱", "弱势看空"] as const;

/** 结论映射（见 GRADE_BANDS）：左闭右开；入参是**折算后**的综合得分 */
export function gradeForScore(score: number): string {
  for (const label of GRADE_ORDER) {
    const g = GRADE_BANDS[label];
    if (score >= g.min && (g.max === null || score < g.max)) return label;
  }
  return "弱势看空";
}

/* ------------------------------------------------------------------ 概率面（任务书 P7-⑦） */

/** 上涨比例分档（任务书：60% +20、50–60% +10、40–50% 0、<40% −15）；win_rate 用库里的 0–100 量纲 */
export const WIN_RATE_BANDS: Band[] = [
  { min: 60, max: null, points: 20, label: "上涨比例 ≥60%" },
  { min: 50, max: 60, points: 10, label: "上涨比例 50%–60%" },
  { min: 40, max: 50, points: 0, label: "上涨比例 40%–50%", note: `读数存在、按表归入 0 分，不是算不出｜${RULE_VERSIONS.probability}` },
  { min: -Infinity, max: 40, points: -15, label: "上涨比例 <40%" },
];

/** 样本量分档（任务书：≥300 +10、100–300 +5、<100 0）—— <100 是 0 分，不是「算不出」 */
export const SAMPLE_BANDS: Band[] = [
  { min: 300, max: null, points: 10, label: "样本 ≥300 次" },
  { min: 100, max: 300, points: 5, label: "样本 100–300 次" },
  { min: -Infinity, max: 100, points: 0, label: "样本 <100 次", note: `任务书把这一档写成 0 分（读数存在、按表归 0），不是算不出；样本少到下面这条线时整维度还会再降级｜${RULE_VERSIONS.probability}` },
];

/**
 * 盈亏比分档。任务书只写了「显著占优 +10 / 接近 0 / 下跌风险占优 −10」，没给数值线，
 * 三档的 ≥1.2 / 0.8–1.2 / <0.8 是本层补的（所以每一档都带 SUPPLEMENT_MARKER）。
 * payoff_ratio = avg_win / |avg_loss|（概率引擎算的真实值）；没有亏损样本时引擎给 null ⇒ 本项算不出，
 * 绝不是 0：「一次都没亏过」和「盈亏比正好 0」是两个相反的事实。
 */
export const PAYOFF_BANDS: Band[] = [
  { min: 1.2, max: null, points: 10, label: "盈亏比显著占优（≥1.2）", note: `数值线是本层补的｜${SUPPLEMENT_MARKER}` },
  { min: 0.8, max: 1.2, points: 0, label: "盈亏比接近（0.8–1.2）", note: `数值线是本层补的｜${SUPPLEMENT_MARKER}` },
  { min: -Infinity, max: 0.8, points: -10, label: "下跌风险占优（盈亏比 <0.8）", note: `数值线是本层补的｜${SUPPLEMENT_MARKER}` },
];

export const PAYOFF_STRONG_MIN = 1.2;
export const PAYOFF_NEAR_MIN = 0.8;

/** 概率面账面极值：样本 +10/+5/0、上涨比例 +20/+10/0/−15、盈亏比 +10/0/−10 ⇒ +40 / −25 */
export const PROBABILITY_BOUNDS: Bounds = (() => {
  const groups = [SAMPLE_BANDS, WIN_RATE_BANDS, PAYOFF_BANDS].map((g) => g.map((b) => b.points));
  return {
    max: groups.reduce((a, g) => a + Math.max(...g), 0),
    min: groups.reduce((a, g) => a + Math.min(...g), 0),
  };
})();

export type Horizon = 1 | 5 | 20;

/** 单档查表：null 或越出 0–100 的读数一律不判定（不承认「越界读数的得分」存在） */
export function winRatePointsFor(win_rate: number | null): number | null {
  if (win_rate === null || !Number.isFinite(win_rate) || win_rate < 0 || win_rate > 100) return null;
  return pickBand(WIN_RATE_BANDS, win_rate)?.points ?? null;
}
export function samplePointsFor(sample_size: number | null): number | null {
  if (sample_size === null || !Number.isFinite(sample_size) || sample_size < 0) return null;
  return pickBand(SAMPLE_BANDS, sample_size)?.points ?? null;
}
export function payoffPointsFor(payoff_ratio: number | null): number | null {
  if (payoff_ratio === null || !Number.isFinite(payoff_ratio) || payoff_ratio < 0) return null;
  return pickBand(PAYOFF_BANDS, payoff_ratio)?.points ?? null;
}

/** 概率读数的来源引擎。两种口径不可混算，混了整维度不出分（见 probabilityDimension） */
export type ProbabilityEngine = "conditional" | "similar_env";
export const PROBABILITY_ENGINE_TEXT: Record<ProbabilityEngine, string> = {
  conditional: "条件概率（historicalWinProbability：必须带筛选条件，无条件时它自己就返回 null）",
  similar_env: "相似环境（similarReturnForward：按上证日涨跌幅落在带宽内的历史日算后续胜率，无条件口径）",
};

/** 样本量降级线：沿用两个引擎自带的 sample_ok（<30 时它们各自已产警示），本层不另立标准 */
export const PROBABILITY_MIN_SAMPLE = 30;

export interface ProbabilityReading {
  horizon: Horizon;
  /** 0–100；null = 这个期限本次算不出（引擎给的 win_rate 就是 null，不是 0%） */
  win_rate: number | null;
  sample_size: number;
  /** 读数属于哪个交易日/快照日：不是「今天」就得写清楚是哪天 */
  trade_date?: string | null;
  /** 样本区间起止。两个引擎都产出 period，本层要求带上来，否则证据链无法事后重建 */
  period?: { start: string; end: string } | null;
  /**
   * 盈亏比 = avg_win / |avg_loss|（P7-⑦ #104 扩的真实读数，与 win_rate 同源同批样本）。
   * 缺格（undefined）与 null 都读成「本次算不出」：旧快照里没有这两格，不许按 0 参与分档。
   */
  payoff_ratio?: number | null;
  avg_win?: number | null;
  avg_loss?: number | null;
  win_samples?: number | null;
  loss_samples?: number | null;
}

export interface ProbabilityInput {
  engine: ProbabilityEngine;
  /**
   * 这一维按哪个观察周期打分。P7-⑦ 表只有「上涨比例 / 样本 / 盈亏比」三条，没说 1/5/20 日各算什么，
   * 于是三个周期一起算就把同一维加了三遍。所以**必传**：不传 ⇒ 整维度不计分并登记
   * 「本层不替调用方挑一个周期」（挑了就是替任务书补口径）。其余周期的读数转 basis 并照常进 sources 血缘。
   */
  primary_horizon?: Horizon | null;
  /** 条件概率口径下的筛选条件原文；similar_env 可省 */
  conditions?: string[];
  /** 引擎自带的 warnings 原文，本层只转述不改写 */
  warnings?: string[];
  readings: ProbabilityReading[];
  status?: DataStatus;
}

/* ------------------------------------------------------------------ 分项与维度契约 */

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
  /** v2 时代的文案出口：接线层没供 volume 读数时，这条文字会出现在 T-VOLUME 的 raw 上（区分「没接」与「没量」） */
  volume_note?: string;
  /** P7-⑦ 新读数：全部可选 —— 没供就只意味着那两条分项算不出，不影响其它分项 */
  /** 前一根日K收盘：T-VOLUME 的「上涨/下跌」判定用（任务书按涨跌方向分别给放量/缩量分） */
  close_prev?: number | null;
  volume?: number | null;
  /** 成交量基准（最近 N 根均量）；volume_window 记实际用了多少根，只进文案 */
  volume_avg?: number | null;
  volume_window?: number | null;
  /** 当日最高价 + 前 20 个交易日最高价（不含当日）：T-BREAKOUT 的「有效突破 20 日压力」 */
  high?: number | null;
  prior_high_20?: number | null;
  prior_high_window?: number | null;
}

/** 放量/缩量的数值线：任务书只写「放量」「缩量」，倍数是本层补的 */
export const VOLUME_SURGE_RATIO = 1.2;
export const VOLUME_SHRINK_RATIO = 0.8;
/** 均线粘合的判定带宽：任务书没给定义，本层按三线最高最低相对差 ≤0.5% 判粘合 */
export const MA_STICKINESS_BAND = 0.005;
/** 均量与压力位的默认窗口，供接线层引用（内核不取时钟也不数K线） */
export const VOLUME_AVG_WINDOW_DEFAULT = 20;
export const PRIOR_HIGH_WINDOW_DEFAULT = 20;

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
  /**
   * 这一分项出自哪张表。同维度里现在混着两代表（P7-⑦ 新表 + P7-③ 并入的附加项），
   * 所以出处要落到分项上，而不只是落在维度上。缺省读成所属维度的版本。
   */
  rule_version?: string | null;
  /**
   * "basis" = 只作为判定依据展示，**不进本维求和**（新旧表同一个指标时旧项走这里，避免重复计权）。
   * 缺省 = "scored"。points 仍然带着旧表的字面值，页面必须把它跟计分项区分开渲染。
   */
  role?: "scored" | "basis";
}

export interface DimensionResult {
  key: DimensionKey;
  /** 本维字面分（该维规则表原样求和，含单维 ±50 夹取）；null = 一条都算不出 */
  score: number | null;
  /** score 的同名副本，语义写清楚：结论卡折算前的那个数 */
  raw_score: number | null;
  /** 折算到 −100~+100 的分；null = 本维不参与加权（缺读数，或缺 bounds 无法折算） */
  norm_score: number | null;
  /** 本维规则表的极值（折算的尺子） */
  bounds: Bounds | null;
  rule_version: string | null;
  items: ScoreItem[];
  /** 为什么没算进来 / 哪些分项没算出来，原文，页面要显示在结论旁边 */
  missing: string[];
  status: DataStatus;
  /** 重归一后的实际权重；0 表示未参与 */
  weight_applied: number;
  /** 参与加权被拒的原因（norm_score=null 而 score 仍有值时必带，不能只让页面显示一个裸数字） */
  excluded_reason: string | null;
}

/** v2 兼容：老代码里的维度归并返回形态（不含 norm/bounds 折算） */
export interface ProbabilityDimension {
  score: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
  bounds: Bounds | null;
  primary_horizon: Horizon | null;
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
  payoff_ratio?: number | null;
  /** 这条读数是打分用的主周期，还是只进血缘的其它周期 */
  role?: "scored" | "basis";
  trade_date?: string | null;
  period?: { start: string; end: string } | null;
}

export interface Decision {
  protocol_version: string;
  subject: string | null;
  /** 加权综合得分（**折算刻度**，−100~+100）；null = 没有任何可折算维度 */
  final_score: number | null;
  grade: string | null;
  /** 是否属于「多维度分歧、不下单边确认」的情形（任务书 §九） */
  single_side: boolean;
  conflict: DecisionConflict | null;
  statement: string;
  /** 四个维度按 DECISION_DIMENSIONS 顺序给出，含未计入的（norm_score=null） */
  dimensions: DimensionResult[];
  included: DimensionKey[];
  excluded: { key: DimensionKey; reason: string }[];
  weights: { requested: Record<DimensionKey, number>; applied: Record<DimensionKey, number>; renormalized: boolean };
  /** 本次结论涉及的来源分层（REAL/DERIVED/HISTORICAL/AI_INTERPRETATION…），混层时页面要标出来 */
  layers: DataStatus[];
  /**
   * 打分表在**本次生效权重**下的得分可达区间（折算刻度）。
   * 四维齐全 ⇒ −88.75 ~ +100（概率面地板 −25/40 折成 −62.5，其余三维对称 ±100）：
   *   0.4×(−100) + 0.3×(−62.5) + 0.2×(−100) + 0.1×(−100) = −88.75。
   * 维度被剔除会让权重落到剩余维度上、区间跟着变，所以每次重算。
   */
  attainable: { min: number; max: number; unreachable_grades: string[] };
  sources: DecisionSource[];
  basis: string;
}

const n1 = (x: number) => Math.round(x * 10) / 10;
const n2 = (x: number) => Math.round(x * 100) / 100;
const fnum = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? "无" : `${n1(x)}`);
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}`;
const isNum = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/* ------------------------------------------------------------------ 技术面（任务书 P7-⑦） */

/**
 * 技术面逐条打分（P7-⑦ 任务书的五条规则）。每条规则一个分项，缺读数的分项是 null。
 *
 * 与 v2 的差别：v2 抄的是旧任务书 §六（均线 +20/+10、金叉且红柱扩大 +15、零轴 ±10、RSI +10/−5、
 * 跌破 MA20 −15，成交量无规则）。新表把「零轴」并进「金叉且 DIF>0」、把「均线排列」细化出粘合档、
 * 并第一次给成交量与突破写了分。同一个指标不能算两遍，所以 v2 独有的两条（T-MA-BREAK、T-MACD-ZERO）
 * 降级成 basis：读数照常显示，点数不进求和，rule_version 停在 p7.taskbook.s6 上。
 *
 * 这里刻意不吃因子面板的现成列：fields.ts 的 crossUp 在任一侧为 null 时返回 0（= 把「没有前一天的
 * 数据」读成「没有金叉」）。决策层要的是「算不出就说算不出」，所以从原始数值自己判。
 */
export function technicalItems(input: TechnicalInput): ScoreItem[] {
  const items: ScoreItem[] = [];
  const { ma5, ma10, ma20, close, dif, dea, dif_prev, dea_prev, bar, bar_prev } = input;
  const scored = (rule: string, label: string, points: number, raw: string, note?: string): ScoreItem =>
    ({ rule, label, points, raw, status: "DERIVED", note, role: "scored", rule_version: RULE_VERSIONS.technical });
  const unscored = (rule: string, label: string, raw: string, note: string): ScoreItem =>
    ({ rule, label, points: null, raw, status: "MISSING", note: `${note}（不是 0 分，也不是「中性」）`, role: "scored", rule_version: RULE_VERSIONS.technical });

  // T-MA-STRUCT：多头 +15 / MA5>MA20 短期震荡 +8 / 粘合 0 / 空头 −15（其余组合本层补 0）
  if (ma5 === null || ma10 === null || ma20 === null) {
    items.push(unscored("T-MA-STRUCT", "均线排列", `MA5=${fnum(ma5)} / MA10=${fnum(ma10)} / MA20=${fnum(ma20)}`, "均线有缺，本项不计分"));
  } else {
    const trio = `MA5=${fnum(ma5)} / MA10=${fnum(ma10)} / MA20=${fnum(ma20)}`;
    const hi = Math.max(ma5, ma10, ma20);
    const lo = Math.min(ma5, ma10, ma20);
    const spread = hi !== 0 ? (hi - lo) / Math.abs(hi) : 0;
    if (hi !== lo && spread <= MA_STICKINESS_BAND) {
      items.push(scored("T-MA-STRUCT", "均线粘合（三线相对差 ≤0.5%）", 0,
        `${trio}，三线最大相对差 ${n2(spread * 100)}%`,
        `任务书把「均线粘合」列为 0 分但没给带宽，0.5% 是本层补的｜${SUPPLEMENT_MARKER}`));
    } else if (ma5 > ma10 && ma10 > ma20) {
      items.push(scored("T-MA-STRUCT", "均线多头排列（MA5>MA10>MA20）", 15, `${trio} 依次向上`));
    } else if (ma5 < ma10 && ma10 < ma20) {
      items.push(scored("T-MA-STRUCT", "均线空头排列（MA5<MA10<MA20）", -15, `${trio} 依次向下`));
    } else if (ma5 > ma20) {
      items.push(scored("T-MA-STRUCT", "MA5>MA20（短期震荡，非完整多头）", 8, `${trio}：MA5>MA20 但 MA10 未落在两者之间`));
    } else {
      items.push(scored("T-MA-STRUCT", "均线无看涨结构（非多头/非空头/未粘合）", 0, trio,
        `任务书四档未覆盖本组合（MA5≤MA20 且不满足空头排列），本层取 0 而不是猜方向｜${SUPPLEMENT_MARKER}`));
    }
  }

  // T-MACD-CROSS：金叉且 DIF>0 +15 / 金叉 DIF<0 +8 / 死叉 −15（其余 0，本层补）
  if (dif === null || dea === null || dif_prev === null || dea_prev === null) {
    items.push(unscored("T-MACD-CROSS", "MACD 金叉/死叉", `dif=${fnum(dif)} / dea=${fnum(dea)}（当日或前一日值缺失）`,
      "交叉判定要当日与前一日两组值；缺前一天时不判定，也不沿用因子面板 crossUp 的「缺数据返回 0」写法"));
  } else {
    const crossUp = dif > dea && dif_prev <= dea_prev;
    const crossDown = dif < dea && dif_prev >= dea_prev;
    const barText = `柱 ${fnum(bar_prev)}→${fnum(bar)}`;
    if (crossUp && dif > 0) {
      items.push(scored("T-MACD-CROSS", "MACD 金叉且 DIF 在零轴上方", 15, `dif ${fnum(dif)} 上穿 dea ${fnum(dea)}（dif>0），${barText}`));
    } else if (crossUp && dif < 0) {
      items.push(scored("T-MACD-CROSS", "MACD 金叉但 DIF 仍在零轴下方", 8, `dif ${fnum(dif)} 上穿 dea ${fnum(dea)}（dif<0），${barText}`));
    } else if (crossUp) {
      items.push(scored("T-MACD-CROSS", "MACD 金叉且 DIF 正好为 0", 0, `dif ${fnum(dif)} 上穿 dea ${fnum(dea)}，${barText}`,
        `任务书只写了 DIF>0 与 DIF<0 两侧，dif=0 未定义，本层取 0｜${SUPPLEMENT_MARKER}`));
    } else if (crossDown) {
      items.push(scored("T-MACD-CROSS", "MACD 死叉", -15, `dif ${fnum(dif)} 下穿 dea ${fnum(dea)}（前一日 dif ${fnum(dif_prev)} / dea ${fnum(dea_prev)}），${barText}`));
    } else {
      items.push(scored("T-MACD-CROSS", "MACD 当日无交叉", 0,
        `dif ${fnum(dif)} / dea ${fnum(dea)}（前一日 dif ${fnum(dif_prev)} / dea ${fnum(dea_prev)}）`,
        `任务书只给金叉/死叉两种结果，「持续多头但今日没交叉」未定义，本层取 0（不重复给结构分）｜${SUPPLEMENT_MARKER}`));
    }
  }

  // T-VOLUME：上涨放量 +10 / 上涨缩量 +3 / 下跌放量 −10（下跌缩量与持平本层补 0）
  const prevClose = input.close_prev ?? null;
  const vol = input.volume ?? null;
  const volAvg = input.volume_avg ?? null;
  if (!isNum(close) || !isNum(prevClose) || !isNum(vol) || !isNum(volAvg) || volAvg <= 0) {
    items.push(unscored("T-VOLUME", "量能配合", input.volume_note
        ?? `收盘 ${fnum(close)}／前收 ${fnum(prevClose)}，成交量 ${fnum(vol)}，基准均量 ${fnum(volAvg)}${isNum(input.volume_window) ? `（${input.volume_window} 根均量）` : ""}`,
      "涨跌方向或量能基准取不出：本项不判定（v2 里这一项是「没有规则」，v3 有规则但读数仍可能没接上）"));
  } else {
    const ratio = vol / volAvg;
    const dir = close > prevClose ? 1 : close < prevClose ? -1 : 0;
    const dirText = dir > 0 ? `上涨（${fnum(prevClose)}→${fnum(close)}）` : dir < 0 ? `下跌（${fnum(prevClose)}→${fnum(close)}）` : `收平（收盘 ${fnum(close)} 与前收相同）`;
    const volText = `成交量 ${fnum(vol)} 为 ${fnum(input.volume_window ?? VOLUME_AVG_WINDOW_DEFAULT)} 根均量的 ${n2(ratio)} 倍`;
    const line = `${dirText}；${volText}`;
    if (dir > 0 && ratio >= VOLUME_SURGE_RATIO) {
      items.push(scored("T-VOLUME", "上涨放量", 10, line, `放量线 ${VOLUME_SURGE_RATIO} 倍是本层补的｜${SUPPLEMENT_MARKER}`));
    } else if (dir > 0 && ratio <= VOLUME_SHRINK_RATIO) {
      items.push(scored("T-VOLUME", "上涨缩量", 3, line, `缩量线 ${VOLUME_SHRINK_RATIO} 倍是本层补的｜${SUPPLEMENT_MARKER}`));
    } else if (dir < 0 && ratio >= VOLUME_SURGE_RATIO) {
      items.push(scored("T-VOLUME", "下跌放量", -10, line, `放量线 ${VOLUME_SURGE_RATIO} 倍是本层补的｜${SUPPLEMENT_MARKER}`));
    } else {
      items.push(scored("T-VOLUME", dir === 0 ? "收平（量能不参与方向判定）" : "下跌缩量 / 量能中等", 0, line,
        `任务书只写了上涨放量、上涨缩量、下跌放量三档，本组合未定义，取 0（不给分也不扣分）｜${SUPPLEMENT_MARKER}`));
    }
  }

  // T-BREAKOUT：有效突破 20 日压力 +10 / 突破失败 −10（未尝试突破本层补 0）
  const high = input.high ?? null;
  const prior = input.prior_high_20 ?? null;
  if (!isNum(high) || !isNum(prior) || !isNum(close)) {
    items.push(unscored("T-BREAKOUT", "20 日压力突破", `当日最高 ${fnum(high)}，前 ${input.prior_high_window ?? PRIOR_HIGH_WINDOW_DEFAULT} 日最高 ${fnum(prior)}，收盘 ${fnum(close)}`,
      "压力位或当日高/收盘缺读数：本项不判定（不会拿 MA20 之类另一个指标顶上「20 日压力」）"));
  } else {
    const win = input.prior_high_window ?? PRIOR_HIGH_WINDOW_DEFAULT;
    const line = `当日最高 ${fnum(high)} / 收盘 ${fnum(close)}，前 ${win} 个交易日最高 ${fnum(prior)}`;
    const windowNote = win < PRIOR_HIGH_WINDOW_DEFAULT ? `；压力位窗口只有 ${win} 天（不足 ${PRIOR_HIGH_WINDOW_DEFAULT} 天），本层按实际窗口判定并登记` : "";
    if (close > prior) {
      items.push(scored("T-BREAKOUT", "有效突破 20 日压力（收盘站上）", 10, `${line}${windowNote}`));
    } else if (close === prior) {
      items.push(scored("T-BREAKOUT", "收盘正好落在 20 日压力位上", 0, line,
        `既没站上也没回落，任务书两档都不适用，本层不判成败取 0｜${SUPPLEMENT_MARKER}`));
    } else if (high > prior) {
      items.push(scored("T-BREAKOUT", "突破失败（盘中触及压力、收盘回落）", -10, line));
    } else {
      items.push(scored("T-BREAKOUT", "未尝试突破 20 日压力", 0, line,
        `任务书只定义「有效突破 +10 / 突破失败 −10」，没碰压力位时取 0（不因此扣分）｜${SUPPLEMENT_MARKER}`));
    }
  }

  // T-RSI：55–70 +8 / 45–55 0 / <45 −8（>70 未定义 ⇒ 取 0 并登记，既不猜超买扣分也不给强势分）
  const rp = input.rsi_period ?? 14;
  if (!isNum(input.rsi)) {
    items.push(unscored("T-RSI", `RSI(${rp}) 分档`, "RSI 缺失", "本项不计分"));
  } else {
    const r = input.rsi;
    if (r < 0 || r > 100) {
      items.push(unscored("T-RSI", `RSI(${rp}) 分档`, `RSI(${rp})=${fnum(r)} 越出 0–100`, "越界读数一律不判定：脏数据不能变成一个分数"));
    } else if (r > 70) {
      items.push(scored("T-RSI", `RSI(${rp}) 落在 >70 段（任务书未定义）`, 0, `RSI(${rp})=${fnum(r)}`,
        `新表只写到 55–70 +8，>70 没有档位；本层取 0，不沿用旧表的超买扣分也不给强势分｜${SUPPLEMENT_MARKER}`));
    } else if (r >= 55) {
      items.push(scored("T-RSI", `RSI(${rp}) 强势区间 55–70`, 8, `RSI(${rp})=${fnum(r)}`));
    } else if (r >= 45) {
      items.push(scored("T-RSI", `RSI(${rp}) 中性 45–55`, 0, `RSI(${rp})=${fnum(r)}`,
        `读数存在、按表归入 0 分，不是算不出｜${RULE_VERSIONS.technical}`));
    } else {
      items.push(scored("T-RSI", `RSI(${rp}) 偏弱 <45`, -8, `RSI(${rp})=${fnum(r)}`));
    }
  }

  // —— 以下两条是 v2 的计分项，新表里同指标已被别的档覆盖 ⇒ 降级 basis（照常展示，不重复计权） ——
  if (close === null || ma20 === null) {
    items.push({ rule: "T-MA-BREAK", label: "价格与 MA20 的关系", points: null, raw: `收盘=${fnum(close)} / MA20=${fnum(ma20)}`, status: "MISSING", role: "basis", rule_version: "p7.taskbook.s6", note: "收盘或 MA20 缺失：这条依据本次也给不出" });
  } else {
    items.push({
      rule: "T-MA-BREAK", label: close < ma20 ? "价格跌破 MA20" : "价格未跌破 MA20",
      points: close < ma20 ? -15 : 0, raw: `收盘 ${fnum(close)} ${close < ma20 ? "<" : "≥"} MA20 ${fnum(ma20)}`,
      status: "DERIVED", role: "basis", rule_version: "p7.taskbook.s6",
      note: "旧表（p7.taskbook.s6）的分值；P7-⑦ 新表把均线关系并进 T-MA-STRUCT 与 T-BREAKOUT ⇒ 本项只作判定依据，不重复计分",
    });
  }
  if (dif === null || dea === null) {
    items.push({ rule: "T-MACD-ZERO", label: "MACD 零轴位置", points: null, raw: `dif=${fnum(dif)} / dea=${fnum(dea)}`, status: "MISSING", role: "basis", rule_version: "p7.taskbook.s6" });
  } else {
    const both = dif > 0 && dea > 0 ? { p: 10, l: "MACD 零轴上方运行" } : dif < 0 && dea < 0 ? { p: -10, l: "MACD 零轴下方运行" } : { p: 0, l: "MACD 跨零轴（一上一下）" };
    items.push({
      rule: "T-MACD-ZERO", label: both.l, points: both.p, raw: `dif ${fnum(dif)} / dea ${fnum(dea)}`,
      status: "DERIVED", role: "basis", rule_version: "p7.taskbook.s6",
      note: both.p === 0
        ? `旧表对异号取 0（当时的补充口径）；P7-⑦ 新表用「金叉且 DIF>0」表达零轴位置 ⇒ 本项只作判定依据，不重复计分｜${SUPPLEMENT_MARKER}`
        : "旧表（p7.taskbook.s6）的分值；P7-⑦ 新表用「金叉且 DIF>0 / DIF<0」表达同一信息 ⇒ 本项只作判定依据，不重复计分",
    });
  }
  return items;
}

/** 技术面账面极值（五条计分档各取上下限，再夹到任务书的单维 ±50） */
export const TECHNICAL_BOUNDS: Bounds = (() => {
  const groups: number[][] = [
    [15, 8, 0, -15], // T-MA-STRUCT
    [15, 8, 0, -15], // T-MACD-CROSS
    [10, 3, 0, -10], // T-VOLUME
    [10, 0, -10], // T-BREAKOUT
    [8, 0, -8], // T-RSI
  ];
  const rawMax = groups.reduce((a, g) => a + Math.max(...g), 0);
  const rawMin = groups.reduce((a, g) => a + Math.min(...g), 0);
  return { min: Math.max(rawMin, -(DIMENSION_CLAMP.technical as number)), max: Math.min(rawMax, DIMENSION_CLAMP.technical as number) };
})();

/** 技术面账面（未夹取）极值，只用于「夹取是否真的会发生」的自证 */
export const TECHNICAL_BOUNDS_UNCLAMPED: Bounds = { min: -58, max: 58 };

export interface DimensionParts {
  raw: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
  bounds: Bounds | null;
}

/** 归并一批分项：只加 role!=="basis" 且 points!==null 的项，然后按单维限制夹取 */
function mergeItems(key: DimensionKey, items: ScoreItem[], bounds: Bounds | null, emptyNote: string): DimensionParts {
  const scoredItems = items.filter((i) => i.role !== "basis");
  const basisItems = items.filter((i) => i.role === "basis");
  const counted = scoredItems.filter((i) => i.points !== null);
  const missing: string[] = [];
  if (!counted.length) {
    missing.push(emptyNote);
    return { raw: null, items, missing, status: "MISSING", bounds };
  }
  const sum = counted.reduce((a, i) => a + (i.points as number), 0);
  const clamped = clampRaw(key, sum);
  if (clamped.clampedFrom !== null) {
    missing.push(`本维字面分 ${signed(clamped.clampedFrom)} 超出单维限制 ±${DIMENSION_CLAMP[key]}，按 ${signed(clamped.value)} 计入（夹取是任务书的规定，不是本层藏的口径）`);
  }
  const nulls = scoredItems.filter((i) => i.points === null);
  if (nulls.length) missing.push(`有 ${nulls.length} 个分项算不出（${nulls.map((i) => i.rule).join("、")}），得分只按可算项求和再折算（可能偏保守）`);
  if (basisItems.length) missing.push(`另有 ${basisItems.length} 项作为判定依据展示、未重复计分（${basisItems.map((i) => `${i.rule}=${i.points === null ? "无读数" : signed(i.points)}`).join("、")}）`);
  return { raw: clamped.value, items, missing, status: nulls.length ? "DEGRADED" : "DERIVED", bounds };
}

/** 技术面整维（供测试与上层直接调用；buildDecision 也走这里） */
export function technicalDimension(input: TechnicalInput): DimensionParts & { rule_version: string | null } {
  const items = technicalItems(input);
  const p = mergeItems("technical", items, TECHNICAL_BOUNDS,
    "技术面五条规则本次全部算不出（没有任何有效读数）：整维度不计分、权重让给可算维度");
  return { ...p, rule_version: RULE_VERSIONS.technical };
}

/* ------------------------------------------------------------------ 概率面归并 */

function readingRaw(input: ProbabilityInput, r: ProbabilityReading): string {
  const extra: string[] = [];
  if (r.payoff_ratio !== undefined) extra.push(`盈亏比 ${isNum(r.payoff_ratio) ? n2(r.payoff_ratio) : "算不出"}`);
  if (isNum(r.avg_win)) extra.push(`平均盈利 ${signed(n1(r.avg_win))}%`);
  if (isNum(r.avg_loss)) extra.push(`平均亏损 ${n1(r.avg_loss)}%`);
  if (isNum(r.win_samples) || isNum(r.loss_samples)) extra.push(`赢 ${r.win_samples ?? "无"} 次/亏 ${r.loss_samples ?? "无"} 次`);
  return `${input.engine === "conditional" ? "条件概率" : "相似环境"} ${r.horizon} 日上涨概率 ${r.win_rate === null ? "算不出" : `${n1(r.win_rate)}%`}（样本 ${r.sample_size}${r.period ? `，区间 ${r.period.start}→${r.period.end}` : "，区间未给出"}${r.trade_date ? `，读数所属日 ${r.trade_date}` : ""}${extra.length ? `；${extra.join("；")}` : ""}）`;
}

/**
 * 概率面。三条纪律：
 * 1) **不接受两个引擎、或同一期限两条读数的混算**（条件概率与相似环境样本定义不同，平均出来没有口径可解释）；
 * 2) **必须显式声明 primary_horizon**：P7-⑦ 表按「样本量 / 上涨比例 / 盈亏比」三条给分，没说多个周期
 *    怎么合。把 1/5/20 三档分别打分再加起来，等于把同一维算三遍 ⇒ 本层拒绝，登记成未计入；
 * 3) 非主周期的读数转 basis（照常进 sources 血缘），页面看得到另外两个周期的历史频率。
 */
export function probabilityDimension(inputs: ProbabilityInput | ProbabilityInput[]): ProbabilityDimension {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const items: ScoreItem[] = [];
  const missing: string[] = [];
  const first = list[0];
  if (!first) return { score: null, items, missing: ["概率面本次没有任何期限的读数：不计分，权重让给可算维度"], status: "MISSING", bounds: null, primary_horizon: null };
  if (list.length > 1) {
    return {
      score: null, items,
      missing: [`概率面一次传入 ${list.length} 份读数（引擎：${list.map((p) => p.engine).join("、")}）：不同引擎/不同窗口的概率不能相加也不能平均，本层拒绝混算，请只留一份并注明口径`],
      status: "MISSING", bounds: null, primary_horizon: null,
    };
  }
  const input = first;
  const seen = new Set<number>();
  const dup = input.readings.filter((r) => (seen.has(r.horizon) ? true : (seen.add(r.horizon), false)));
  if (dup.length) {
    return {
      score: null, items,
      missing: [`同一期限出现 ${dup.length + 1} 条读数（${[...new Set(dup.map((d) => d.horizon))].join("、")} 日）：本层不择一、不平均，先决定要用哪个窗口再喂进来`],
      status: "MISSING", bounds: null, primary_horizon: null,
    };
  }
  if (!input.readings.length) return { score: null, items, missing: ["概率面本次没有任何期限的读数：不计分，权重让给可算维度"], status: "MISSING", bounds: null, primary_horizon: null };

  const ph = input.primary_horizon ?? null;
  if (ph === null) {
    return {
      score: null, items,
      missing: [`概率面没有声明 primary_horizon（本次拿到的是 ${input.readings.map((r) => `${r.horizon} 日`).join("、")}）：P7-⑦ 表按单周期给分，本层不替调用方挑一个周期，也不把三个周期各自的分加起来`],
      status: "MISSING", bounds: null, primary_horizon: null,
    };
  }
  const primary = input.readings.find((r) => r.horizon === ph) ?? null;
  if (!primary) {
    return {
      score: null, items,
      missing: [`primary_horizon=${ph} 日，但本次读数里没有这一档（只有 ${input.readings.map((r) => `${r.horizon} 日`).join("、")}）：不拿别的周期顶上`],
      status: "MISSING", bounds: null, primary_horizon: ph,
    };
  }

  let sum = 0;
  let counted = 0;
  let degraded = false;

  // P-SAMPLE
  const sp = samplePointsFor(primary.sample_size);
  const sband = isNum(primary.sample_size) ? pickBand(SAMPLE_BANDS, primary.sample_size) : null;
  if (sp === null || !sband) {
    items.push({ rule: "P-SAMPLE", label: "样本量分档", points: null, raw: `样本 ${fnum(primary.sample_size)}`, status: "MISSING", role: "scored", rule_version: RULE_VERSIONS.probability, note: `引擎没给出样本数（或为负）：本项不判定，不按「样本 0 次」计 0 分（不是 0 分，也不是「无风险」）` });
    missing.push("样本量本次无读数");
  } else {
    if (primary.sample_size < PROBABILITY_MIN_SAMPLE) degraded = true;
    items.push({
      rule: "P-SAMPLE", label: sband.label, points: sp, raw: readingRaw(input, primary), status: "HISTORICAL", role: "scored",
      rule_version: RULE_VERSIONS.probability,
      note: [sband.note, primary.sample_size < PROBABILITY_MIN_SAMPLE
        ? `样本 ${primary.sample_size} < ${PROBABILITY_MIN_SAMPLE}：历史频率本身仍有值，但整维度按降级处理（引擎自带的 sample_ok 就是 false）`
        : "历史统计，不是对今天的预测"].filter(Boolean).join("｜"),
    });
    sum += sp; counted += 1;
  }

  // P-WINRATE
  const wp = winRatePointsFor(primary.win_rate);
  const wband = isNum(primary.win_rate) && primary.win_rate >= 0 && primary.win_rate <= 100 ? pickBand(WIN_RATE_BANDS, primary.win_rate) : null;
  if (wp === null || !wband) {
    items.push({
      rule: "P-WINRATE", label: `${ph} 日上涨比例分档`, points: null, raw: readingRaw(input, primary), status: "MISSING", role: "scored", rule_version: RULE_VERSIONS.probability,
      note: primary.win_rate === null ? "引擎本次返回 null（样本不足或窗口不够），不是 0%" : "读数越出 0–100，本层不判定",
    });
    missing.push(`${ph} 日：本次没有可用的上涨概率读数${primary.win_rate === null ? "（引擎自报算不出）" : ""}`);
  } else {
    items.push({
      rule: "P-WINRATE", label: `${ph} 日 · ${wband.label}`, points: wp, raw: readingRaw(input, primary),
      status: "HISTORICAL", role: "scored", rule_version: RULE_VERSIONS.probability,
      note: [wband.note, "历史统计，不是对今天的预测"].filter(Boolean).join("｜"),
    });
    sum += wp; counted += 1;
  }

  // P-PAYOFF
  const pp = payoffPointsFor(primary.payoff_ratio ?? null);
  const pband = isNum(primary.payoff_ratio) && primary.payoff_ratio >= 0 ? pickBand(PAYOFF_BANDS, primary.payoff_ratio) : null;
  if (pp === null || !pband) {
    items.push({
      rule: "P-PAYOFF", label: "盈亏比分档", points: null,
      raw: isNum(primary.payoff_ratio) ? `盈亏比 ${n2(primary.payoff_ratio)}` : "本次没有盈亏比读数",
      status: "MISSING", role: "scored", rule_version: RULE_VERSIONS.probability,
      note: primary.payoff_ratio === undefined
        ? "这条读数的来源没有 payoff_ratio 字段（旧快照或未升级的引擎）：本项按缺失处理，不按 0 计"
        : primary.payoff_ratio === null
          ? "引擎给 null 的含义是「命中样本里没有亏损（或没有盈利）」，比值无定义 ⇒ 本项不判定，绝不能读成 0（那会把「一次都没亏过」算成「下跌风险占优」）"
          : "盈亏比读数越界（<0 或非数值）：脏数据不判定",
    });
    missing.push("盈亏比本次算不出（缺该字段，或样本只有一侧）");
  } else {
    items.push({
      rule: "P-PAYOFF", label: pband.label, points: pp, raw: readingRaw(input, primary),
      status: "HISTORICAL", role: "scored", rule_version: RULE_VERSIONS.probability, note: pband.note,
    });
    sum += pp; counted += 1;
  }

  // 非主周期：只作依据展示 + 血缘，不重复计分
  for (const r of input.readings) {
    if (r.horizon === ph) continue;
    items.push({
      rule: `P-${r.horizon}D`, label: `${r.horizon} 日读数（非本次打分周期）`, points: null, raw: readingRaw(input, r),
      status: "HISTORICAL", role: "basis", rule_version: RULE_VERSIONS.probability,
      note: `primary_horizon=${ph} 日 ⇒ 其它周期只进依据与血缘，不重复计权（同一维算三遍等于把权重放大三倍）`,
    });
  }

  if (input.warnings?.length) missing.push(...input.warnings.map((w) => `引擎自报：${w}`));
  if (input.engine === "conditional" && !input.conditions?.length) {
    missing.push(`条件概率口径没有给出筛选条件：probability.ts 在无条件时本就返回 null，这里同样不承认它能代表「上涨概率」（出处：${PROBABILITY_ENGINE_TEXT.conditional}）`);
  }
  if (!counted) return { score: null, items, missing, status: "MISSING", bounds: null, primary_horizon: ph };
  return { score: sum, items, missing, status: degraded ? "DEGRADED" : (input.status ?? "DERIVED"), bounds: PROBABILITY_BOUNDS, primary_horizon: ph };
}

/* ------------------------------------------------------------------ 外部维度（市场面 / 事件面） */

/** 调用方自带规则时用的维度输入（市场面/事件面各自的规则表走这个入口） */
export interface ExternalDimension {
  key: "market" | "event";
  /** 该维规则表算出的字面分（含各自的单维夹取）；null = 本次算不出 */
  score: number | null;
  rule_version: string;
  items?: ScoreItem[];
  missing?: string[];
  status?: DataStatus;
  /**
   * 这张规则表能给出的最高/最低分（各 core 里的 `*_EXTREMES`）—— v3 起它是**折算的尺子**。
   * 不带它 ⇒ 本层不知道这一维能走多远 ⇒ 无法折算 ⇒ 这一维不参与加权（硬规则 4），并在结论里登记原因。
   * v2 里 bounds 只影响 attainable、不影响打分；v3 里两者是同一件事，所以两张表的极值必须与表同步更新。
   */
  bounds?: Bounds | null;
}

function resolveExternal(key: "market" | "event", d: ExternalDimension | undefined, label: string, weight: number): DimensionResult {
  const base = { key, rule_version: d?.rule_version ?? null, items: d?.items ?? [], weight_applied: 0 };
  if (!d || !d.rule_version) {
    return {
      ...base, rule_version: null, score: null, raw_score: null, norm_score: null, bounds: null,
      missing: [`${label}面本次没有传入打分结果（任务书挂了 ${n1(weight * 100)}/100 的权重，现行规则表版本是 ${RULE_VERSIONS[key]}）：没有规则读数就不计分、权重从分母里拿掉，本层也不替它把「没算」写成 0 分`],
      status: "MISSING", excluded_reason: null,
    };
  }
  const driftNote = d.rule_version !== RULE_VERSIONS[key]
    ? `注意：本次传入的规则版本是「${d.rule_version}」，与内核登记的「${RULE_VERSIONS[key]}」不一致 —— 有一边过期了，这条结论的版本归属要重新核对`
    : null;
  if (d.score === null) {
    return {
      ...base, score: null, raw_score: null, norm_score: null, bounds: d.bounds ?? null,
      missing: [...(d.missing ?? []), `${label}面自带规则「${d.rule_version}」，但本次没算出得分`],
      status: "MISSING", excluded_reason: null,
    };
  }
  // 尺子没带 ⇒ 折算不了。这一维的字面分仍然如实展示，但进不了加权，也不能假装它进了。
  if (!d.bounds || !Number.isFinite(d.bounds.min) || !Number.isFinite(d.bounds.max) || normalizationScale(d.bounds) <= 0) {
    const reason = `${label}面算出了字面分 ${signed(d.score)}（规则 ${d.rule_version}），但没带本维极值 bounds ⇒ 无法折算到 ±100 ⇒ 本次不参与加权（v3 起折算必须知道这把尺子有多长，本层不猜一个极值把区间撑宽）`;
    return { ...base, score: d.score, raw_score: d.score, norm_score: null, bounds: null, missing: [...(d.missing ?? []), reason], status: d.status ?? "DERIVED", excluded_reason: reason };
  }
  const missing = [...(d.missing ?? [])];
  if (driftNote) missing.push(driftNote);
  return {
    ...base, rule_version: d.rule_version, score: d.score, raw_score: d.score,
    norm_score: normalizeScore(d.score, d.bounds), bounds: d.bounds,
    missing, status: d.status ?? "DERIVED", excluded_reason: null,
  };
}

/* ------------------------------------------------------------------ 可达区间与冲突 */

/** 内核自己建模的两维极值（折算后） */
function internalNormBounds(): Partial<Record<DimensionKey, Bounds>> {
  return { technical: normalizedBounds(TECHNICAL_BOUNDS) ?? undefined, probability: normalizedBounds(PROBABILITY_BOUNDS) ?? undefined };
}

/**
 * 当前打分表能把 final_score 推到哪（**折算刻度**）。唯一用途是让「映射表里有档位永远出不来」
 * 变成可断言、可显示的事实。
 *
 * 四维齐全、任务书权重 0.4/0.3/0.2/0.1 下：
 *   上限 = 100×0.4 + 100×0.3 + 100×0.2 + 100×0.1 = +100；
 *   地板 = −100×0.4 − 62.5×0.3 − 100×0.2 − 100×0.1 = **−88.75**
 *   （概率面 −25/40 = −62.5 是唯一不对称的一维：任务书给它的最小档是「样本 <100 记 0 分」，
 *    所以概率面跌不到 −100 —— 这件事如实印在区间上，不去夹平）。
 * 只参与部分维度时区间按生效权重收窄；某维没声明 bounds 就不在区间里（buildDecision 会登记）。
 */
export function scoreBounds(
  weights: Record<DimensionKey, number> = DEFAULT_WEIGHTS,
  external: Partial<Record<"market" | "event", Bounds | null | undefined>> = {},
): { min: number; max: number; unreachable_grades: string[] } {
  const inner = internalNormBounds();
  let max = (inner.technical?.max ?? 0) * (weights.technical || 0) + (inner.probability?.max ?? 0) * (weights.probability || 0);
  let min = (inner.technical?.min ?? 0) * (weights.technical || 0) + (inner.probability?.min ?? 0) * (weights.probability || 0);
  for (const k of ["market", "event"] as const) {
    const b = external[k];
    if (!b) continue; // 没声明极值 = 不知道这一维能走多远，不猜
    const nb = normalizedBounds(b);
    if (!nb) continue;
    max += nb.max * (weights[k] || 0);
    min += nb.min * (weights[k] || 0);
  }
  max = n2(max);
  min = n2(min);
  const unreachable = GRADE_ORDER.filter((label) => {
    const g = GRADE_BANDS[label];
    const reachable = max >= g.min && (g.max === null ? true : min < g.max);
    return !reachable;
  });
  return { min, max, unreachable_grades: unreachable };
}

/**
 * §九 冲突判定的触发线：技术面给出看涨侧分数，而（主周期的）上涨比例落在任务书的最低档。
 * CONFLICT_PROBABILITY_MAX 从 v2 的 35 提到 **40**：新表的最低档就是「<40% −15」，
 * 再拿 35 当线会让 35%~40% 这段既被表判成最低档、又不触发冲突声明，自相矛盾。
 * CONFLICT_TECHNICAL_MIN 保持 15（技术面单维上限 50，15 = 三成的看涨侧证据）。
 */
export const CONFLICT_TECHNICAL_MIN = 15;
export const CONFLICT_PROBABILITY_MAX = 40;

export function detectConflict(techScore: number | null, input?: ProbabilityInput): DecisionConflict | null {
  if (techScore === null || techScore < CONFLICT_TECHNICAL_MIN || !input) return null;
  const ph = input.primary_horizon ?? null;
  const pool = input.readings.filter((r) => (ph === null ? r.horizon === 1 : r.horizon === ph));
  const hit = pool.find((r) => r.win_rate !== null && r.win_rate < CONFLICT_PROBABILITY_MAX);
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

/* ------------------------------------------------------------------ 组装 */

export interface BuildDecisionInput {
  technical?: TechnicalInput;
  /** 传数组时本层会拒绝混算（见 probabilityDimension），保留数组入口是为了让上层能显式表达「拿到了两份口径」 */
  probability?: ProbabilityInput | ProbabilityInput[];
  external?: ExternalDimension[];
  weights?: Partial<Record<DimensionKey, number>>;
  /** 标的与口径（只用于展示与落库标注，本层不据此计算任何东西） */
  subject?: string;
}

export function buildDecision(input: BuildDecisionInput): Decision {
  const weights: Record<DimensionKey, number> = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };

  const techDim: DimensionResult = input.technical
    ? (() => {
        const t = technicalDimension(input.technical as TechnicalInput);
        return {
          key: "technical", score: t.raw, raw_score: t.raw, norm_score: normalizeScore(t.raw, t.bounds), bounds: t.bounds,
          rule_version: t.rule_version, items: t.items, missing: t.missing, status: t.status, weight_applied: 0,
          excluded_reason: t.raw === null ? null : `技术面算不出折算分（内部状态 ${t.status}）`,
        } as DimensionResult;
      })()
    : { key: "technical", score: null, raw_score: null, norm_score: null, bounds: null, rule_version: RULE_VERSIONS.technical, items: [], missing: ["技术面没有任何读数输入：整维度不计分"], status: "MISSING", weight_applied: 0, excluded_reason: null } as DimensionResult;

  const probIn = input.probability;
  const probSingle: ProbabilityInput | null = probIn && !Array.isArray(probIn) ? probIn : probIn && probIn.length === 1 ? probIn[0] : null;
  const probDim: DimensionResult = probIn
    ? (() => {
        const p = probabilityDimension(probIn);
        return {
          key: "probability", score: p.score, raw_score: p.score, norm_score: normalizeScore(p.score, p.bounds), bounds: p.bounds,
          rule_version: RULE_VERSIONS.probability, items: p.items, missing: p.missing, status: p.status, weight_applied: 0,
          excluded_reason: null,
        } as DimensionResult;
      })()
    : { key: "probability", score: null, raw_score: null, norm_score: null, bounds: null, rule_version: RULE_VERSIONS.probability, items: [], missing: ["概率面没有读数（未指定来源引擎或本次没取到概率）：不计分"], status: "MISSING", weight_applied: 0, excluded_reason: null } as DimensionResult;

  const dims: DimensionResult[] = [
    techDim, probDim,
    resolveExternal("market", input.external?.find((e) => e.key === "market"), DIMENSION_LABEL.market, weights.market),
    resolveExternal("event", input.external?.find((e) => e.key === "event"), DIMENSION_LABEL.event, weights.event),
  ];

  // 参与加权的判据在 v3 是「折算分算得出」而不是「字面分算得出」：字面分有值却没带尺子的维度
  // 只在 excluded 里出现，且带着它那个如实的字面分。
  const includedDims = dims.filter((d) => d.norm_score !== null);
  const sumW = includedDims.reduce((a, d) => a + (weights[d.key] || 0), 0);
  const applied: Record<DimensionKey, number> = { technical: 0, probability: 0, market: 0, event: 0 };
  for (const d of includedDims) {
    d.weight_applied = sumW > 0 ? Math.round(((weights[d.key] || 0) / sumW) * 10000) / 10000 : 0;
    applied[d.key] = d.weight_applied;
  }
  const final_score = includedDims.length ? n1(includedDims.reduce((a, d) => a + (d.norm_score as number) * d.weight_applied, 0)) : null;
  const conflict = detectConflict(techDim.score, probSingle ?? undefined);
  const grade = final_score === null ? null : gradeForScore(final_score);
  const layers = [...new Set(includedDims.flatMap((d) => [d.status, ...d.items.filter((i) => i.role !== "basis").map((i) => i.status)]))];

  const sources: DecisionSource[] = probSingle
    ? probSingle.readings
        .filter((r) => r.win_rate !== null || isNum(r.sample_size))
        .map((r) => ({
          dimension: "probability" as DimensionKey,
          rule: r.horizon === probSingle.primary_horizon ? "P-SAMPLE/P-WINRATE/P-PAYOFF" : `P-${r.horizon}D`,
          engine: probSingle.engine, horizon: r.horizon, win_rate: r.win_rate, sample: r.sample_size,
          payoff_ratio: r.payoff_ratio ?? null,
          role: (r.horizon === probSingle.primary_horizon ? "scored" : "basis") as "scored" | "basis",
          trade_date: r.trade_date ?? null, period: r.period ?? null,
        }))
    : [];

  const statement = final_score === null
    ? "综合评分：算不出。没有任何维度能折算出可加权的得分（见 excluded），本层不会用一个空分母凑出结论。"
    : `综合评分 ${signed(final_score)}（−100~+100 折算刻度）／趋势等级「${grade}」。得分是各维规则表折算后加权的结果，不是概率，也不是对本次判断正确性的百分比。${conflict ? ` ${conflict.statement}` : ""}`;

  const effWeights: Record<DimensionKey, number> = { technical: 0, probability: 0, market: 0, event: 0 };
  for (const d of includedDims) effWeights[d.key] = d.weight_applied;
  const externalExtremes: Partial<Record<"market" | "event", Bounds>> = {};
  const unmodeled: ("market" | "event")[] = [];
  for (const d of dims) {
    if (d.key !== "market" && d.key !== "event") continue;
    if (!(weights[d.key] > 0)) continue;
    if (d.bounds) externalExtremes[d.key] = d.bounds;
    else if (!unmodeled.includes(d.key)) unmodeled.push(d.key);
  }
  const bounds = scoreBounds(includedDims.length ? effWeights : DEFAULT_WEIGHTS, externalExtremes);
  const effText = DECISION_DIMENSIONS.filter((k) => effWeights[k] > 0).map((k) => `${DIMENSION_LABEL[k]} ${effWeights[k]}`).join("、");
  const unmodeledNote = unmodeled.length
    ? `；${unmodeled.map((k) => DIMENSION_LABEL[k]).join("、")}有字面分但没带本维极值 ⇒ 折算不了、本次未参与加权，区间也不含它`
    : "";
  const attainingNote = includedDims.length === 0
    ? "没有任何维度参与加权，综合得分无区间可言"
    : `按本次生效权重（${effText}）综合得分只能落在 ${bounds.min} ~ ${bounds.max}${bounds.unreachable_grades.length ? `，映射表里的「${bounds.unreachable_grades.join("、")}」在这个区间内永远打不出来（阈值现按 ${GRADE_MAPPING_VERSION}，出现这句说明打分表或权重被动过，需回到评审重新拍板）` : "，六档全部可达"}；维度被剔除会让权重落到剩余维度上、区间随之变窄或变宽，所以同一个字面结论取决于有几维参与${unmodeledNote}`;

  return {
    protocol_version: DECISION_PROTOCOL_VERSION,
    subject: input.subject ?? null,
    final_score,
    grade,
    single_side: !conflict && final_score !== null && grade !== null && grade !== "中性震荡",
    conflict,
    statement,
    dimensions: dims,
    included: includedDims.map((d) => d.key),
    excluded: dims.filter((d) => d.norm_score === null).map((d) => ({ key: d.key, reason: d.excluded_reason ?? d.missing[0] ?? `${DIMENSION_LABEL[d.key]}面未计入` })),
    weights: { requested: weights, applied, renormalized: includedDims.length > 0 && includedDims.length < dims.length },
    layers,
    attainable: bounds,
    sources,
    basis: [
      `决策层 ${DECISION_PROTOCOL_VERSION}｜规则版本：技术=${RULE_VERSIONS.technical} 概率=${RULE_VERSIONS.probability} 市场=${RULE_VERSIONS.market ?? "无（本层不补规则）"} 事件=${RULE_VERSIONS.event ?? "无（本层不补规则）"}`,
      `映射阈值 ${GRADE_MAPPING_VERSION}（左闭右开）：${GRADE_ORDER.map((g) => `${g} [${Number.isFinite(GRADE_BANDS[g].min) ? GRADE_BANDS[g].min : "-∞"},${GRADE_BANDS[g].max === null ? "∞" : GRADE_BANDS[g].max})`).join(" ")}`,
      input.subject ? `标的：${input.subject}` : "标的：未指定",
      "刻度口径：每一维先按本维规则表极值折算到 −100~+100（正负同一把尺），再按 40/30/20/10 加权；分档一律左闭右开，win_rate 用 0–100 量纲",
      "折算记账：dimensions[].score 是该维字面分，norm_score 是折算分，bounds 是折算用的尺子，三者都在输出里，页面显示的加权分不等于任何一张表字面分之和",
      "缺失口径：算不出的分项 points=null 并出现在 missing[]，不计 0 分；整维度算不出则不进分母，权重按剩余维度重归一",
      "重复计权口径：role=basis 的分项只作判定依据展示，不进本维求和（新旧表同一指标时旧项走这里）",
      includedDims.length === dims.length
        ? "四个维度全部可加权"
        : `本次只有 ${includedDims.map((d) => DIMENSION_LABEL[d.key]).join("、") || "无"} 可加权，权重从 ${DECISION_DIMENSIONS.map((k) => `${DIMENSION_LABEL[k]} ${weights[k]}`).join("、")} 重归一为 ${includedDims.map((d) => `${DIMENSION_LABEL[d.key]} ${d.weight_applied}`).join("、") || "没有"}`,
      `概率面引擎：${probSingle ? PROBABILITY_ENGINE_TEXT[probSingle.engine] : probIn ? "本次拒绝混算：传入多份概率读数" : "本次未取概率读数"}`,
      `概率面主周期：${probSingle?.primary_horizon ? `${probSingle.primary_horizon} 日` : "未声明（这一维就不打分）"}`,
      attainingNote,
    ].join(" / "),
  };
}

/* ------------------------------------------------------------------ 三段式结论（任务书 P7-⑦ 的输出形态） */

export interface DecisionSections {
  /** ① 综合评分 + 趋势等级 */
  headline: string;
  /** ② 主要判断依据 */
  basis: string[];
  /** ③ 核心风险点 */
  risk: string[];
}

/**
 * 概率的标准句式（任务书要求同步展示「样本数量 / 时间范围 / 观察周期 / 数据来源」四要素）。
 * 缺哪个要素就写「未给出」而不是省掉整个从句：省掉之后这句话就没法核对口径了。
 */
export function probabilitySentence(d: Decision): string | null {
  const scored = d.sources.filter((s) => s.role === "scored" && isNum(s.win_rate));
  const r = scored[0];
  if (!r) return null;
  const sample = isNum(r.sample) ? `${r.sample} 次` : "样本数未给出";
  const range = r.period?.start && r.period?.end ? `统计区间 ${r.period.start}→${r.period.end}` : "统计区间未给出";
  const horizon = isNum(r.horizon) ? `未来 ${r.horizon} 日` : "观察周期未给出";
  const engine = r.engine === "conditional" ? "条件概率口径" : "历史相似环境口径";
  return `${engine}样本 ${sample}，${horizon}上涨概率 ${n1(r.win_rate as number)}%，${range}，数据来源 ${r.engine === "conditional" ? "probability.ts（historicalWinProbability）" : "similar-env.ts（similarReturnForward）"}；该数据仅代表历史统计，不代表未来预测`;
}

/**
 * 三段式结论。给页面首屏与 AI 上下文共用同一份，避免「页面上三段话、模型里另一套话」。
 * 依据取**参与加权**的字面分项按绝对值排序；风险取反向分项 + 缺口 + 未计入维度 + 冲突，
 * 也就是说：第三段不是文案模板，而是这次结论真正缺什么、什么在反对它的原样清单。
 */
export function decisionSections(d: Decision): DecisionSections {
  const headline = d.final_score === null
    ? "① 综合评分：算不出／趋势等级：无（本次没有任何维度能折算出可加权得分）"
    : `① 综合评分 ${signed(d.final_score)}（−100~+100 折算刻度）／趋势等级「${d.grade}」`;

  const positive: string[] = [];
  const negative: string[] = [];
  for (const dim of d.dimensions) {
    for (const i of dim.items) {
      if (i.role === "basis" || i.points === null) continue;
      const line = `${DIMENSION_LABEL[dim.key]}·${i.label} ${signed(i.points)}（字面）｜${i.raw}`;
      (i.points >= 0 ? positive : negative).push(line);
    }
  }
  const order = (list: string[]) => list;
  const basis = [
    ...order(positive).slice(0, 6),
    d.final_score === null ? "" : `综合：${d.included.map((k) => {
      const dim = d.dimensions.find((x) => x.key === k)!;
      return `${DIMENSION_LABEL[k]} 字面 ${dim.raw_score === null ? "算不出" : signed(dim.raw_score)}→折算 ${dim.norm_score === null ? "未折算" : signed(dim.norm_score)}×${Math.round(dim.weight_applied * 100)}/100`;
    }).join("；")}`,
    probabilitySentence(d) ?? "",
  ].filter(Boolean);

  const risk = [
    ...order(negative).slice(0, 6),
    ...(d.conflict ? [`分歧：${d.conflict.statement}`] : []),
    ...d.excluded.map((e) => `未计入【${DIMENSION_LABEL[e.key]}】${e.reason}`),
    ...d.dimensions.flatMap((dim) => dim.missing.map((m) => `缺口【${DIMENSION_LABEL[dim.key]}】${m}`)),
  ];
  if (!risk.length) risk.push("本次没有登记到反向分项或缺口；这不等于「没有风险」，只代表这几张表的读数当前都站在同一侧");
  return { headline, basis, risk };
}

/**
 * 给 AI 层/页面用的纯文本结论块（三段式 + 全量归因）。
 * 本函数产出的文本里不会出现任何「可信度 xx%」式表述；百分号只出现在带四要素的历史概率读数里。
 */
export function decisionToText(d: Decision): string {
  const s = decisionSections(d);
  const lines: string[] = ["【综合评分与趋势等级】", s.headline, "", "【主要判断依据】"];
  for (const b of s.basis) lines.push(`  · ${b}`);
  lines.push("", "【核心风险点】");
  for (const r of s.risk) lines.push(`  · ${r}`);

  const basisItems = d.dimensions.flatMap((dim) => dim.items.filter((i) => i.role === "basis").map((i) => ({ dim, i })));
  if (basisItems.length) {
    lines.push("", "【判定依据（已并入上表，不重复计分）】");
    for (const { dim, i } of basisItems) {
      // 分项各自的 note 末尾可能已经带了出处（那是单张表自己渲染时的写法）；这里统一补一次「表 版本号」，
      // 所以把重复的那一段摘掉——同一行里出现两遍 p7.s3.market.v1 会让读者以为那是两张不同的表。
      const provenance = `｜表 ${i.rule_version ?? dim.rule_version ?? "无"}`;
      const note = i.note?.endsWith(provenance) ? i.note.slice(0, -provenance.length) : (i.note ?? "");
      lines.push(`  · ${DIMENSION_LABEL[dim.key]} ${i.rule} ${i.label}${i.points === null ? "（本次无读数）" : ` ${signed(i.points)}`}｜${i.raw}${note ? `｜${note}` : ""}${provenance}`);
    }
  }

  lines.push("", "【逐维折算记账】");
  for (const dim of d.dimensions) {
    lines.push(`  ${DIMENSION_LABEL[dim.key]}：字面 ${dim.raw_score === null ? "算不出" : signed(dim.raw_score)}｜本维极值 ${dim.bounds ? `${dim.bounds.min}~${dim.bounds.max}` : "未声明"}｜折算 ${dim.norm_score === null ? "未参与加权" : `${signed(dim.norm_score)} × ${Math.round(dim.weight_applied * 100)}/100`}｜分层 ${dim.status}`);
    for (const i of dim.items.filter((x) => x.role !== "basis")) {
      // note 里装的是「这一档为什么给这个分」与「历史统计不是预测」这类必须见人的口径，不能只留在 JSON 里
      lines.push(`    · ${i.label} ${i.points === null ? "算不出" : signed(i.points)}｜${i.raw}${i.note ? `｜${i.note}` : ""}（${i.status}${i.rule_version ? `｜${i.rule_version}` : ""}）`);
    }
  }
  lines.push(`综合得分 ${d.final_score === null ? "算不出" : signed(d.final_score)}，趋势等级「${d.grade ?? "无"}」${d.single_side ? "" : "（本条不属于单边确认）"}`);
  lines.push(`口径：${d.basis}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ P8-② v3 结论契约（强制注入 + 引用一致性校验） */
//
// 任务书 P8 第 4 条：「把 v3 最终得分、六档趋势等级、各维度分值以固定结构化字段注入 Prompt，
// 锁死数字，模型不得自行修改或虚构」。这一节就是那个「结构化字段」的唯一出处：
//  · renderDecisionContract 把引擎结果压成键序固定的 JSON —— 注入给模型的是它，
//    事后校验比对的也是它，不存在第二份「引擎数字的转述」。
//  · verifyContractCitations 只查回答里**明确挂词引用**的数字（「综合得分 X」「技术面折算分 X」…），
//    没被这些模式点到的数字一概不校验 —— 宁可漏报，不能把行文里的普通数字误判成造假。
//  · 校验不一致的唯一后果是一条警告（风险点 4）：本层只产出违规清单与文案，
//    不改写模型输出、不触发自动重试 —— 那是调用方（聊天路由）的事，而且它们也不会那么做。
//  · 注入条件（风险点 3）：只有本轮真的算出了决策结果才注入；纯行情查询走不到这里，
//    判「走不走」的闸在 scene-dispatch（服务层），入口条件由 shouldBuildDecisionContract 把死。

/** 契约里每一维只带这几格：归因明细进契约会让 JSON 大十倍，而「锁数字」需要的是各维分值本身 */
export interface DecisionContractDim {
  key: DimensionKey;
  label: string;
  rule_version: string | null;
  /** 字面分（折算前，本维规则表原样求和）；null = 算不出 */
  raw_score: number | null;
  /** 折算到 −100~+100 的分；null = 未参与加权 */
  norm_score: number | null;
  /** 本次生效权重（重归一后的实际值） */
  weight_applied: number;
}

export interface DecisionContract {
  protocol_version: string;
  grade_mapping_version: string;
  subject: string | null;
  final_score: number | null;
  grade: string | null;
  dimensions: DecisionContractDim[];
  /** 本结论的取数时刻与服务端参考日（决策卡页面的同一对字段，不另算一份） */
  as_of: string;
  trade_date: string;
  /** 技术面最后一根日K的日期：与 trade_date 不等就是既有口径里的「要说得出口」，进契约让模型也看得见 */
  technical_bar_date: string | null;
}

/**
 * 从结论卡响应里取契约。参数写成结构而不是 DecisionView：decision-core 不 import 接线内核
 * （方向反过来才对：wiring 依赖 core），调用方传 { decision, as_of, trade_date, wiring } 四件即可。
 */
export function buildDecisionContract(view: {
  decision: Decision;
  as_of: string;
  trade_date: string;
  wiring: { technical_bar_date: string | null };
}): DecisionContract {
  const d = view.decision;
  return {
    protocol_version: d.protocol_version,
    grade_mapping_version: GRADE_MAPPING_VERSION,
    subject: d.subject ?? null,
    final_score: d.final_score,
    grade: d.grade,
    dimensions: d.dimensions.map((dim) => ({
      key: dim.key,
      label: DIMENSION_LABEL[dim.key],
      rule_version: dim.rule_version,
      raw_score: dim.raw_score,
      norm_score: dim.norm_score,
      weight_applied: dim.weight_applied,
    })),
    as_of: view.as_of,
    trade_date: view.trade_date,
    technical_bar_date: view.wiring.technical_bar_date,
  };
}

/** 契约的注入形态：固定键序的紧凑 JSON（对象字面量的插入序就是 stringify 的输出序，两次渲染逐字节一致） */
export function renderDecisionContract(view: {
  decision: Decision;
  as_of: string;
  trade_date: string;
  wiring: { technical_bar_date: string | null };
}): string {
  return JSON.stringify(buildDecisionContract(view));
}

/** 是否该为本轮建结论卡（P8-② 的闸，风险点 3 的代码化）：只有个股研判类场景有「决策结果」可言 */
export function shouldBuildDecisionContract(scene: string): boolean {
  return scene === "stock_analysis";
}

/** 跟契约原文的引用规则：进 system prompt，和契约 JSON 贴在一起，「怎么引用」也只有一个出处 */
export const CONTRACT_QUOTE_RULE =
  "【v3 结论契约（本机引擎实算，数字锁死）】上面 [本地决策结论卡] 块末尾的 JSON 是本次四维打分与" +
  "趋势等级的契约原文：final_score=综合得分（折算刻度 −100~+100），grade=六档等级，dimensions[]=各维" +
  "字面分与折算分，as_of/trade_date/technical_bar_date=口径日期。引用这些数字时只能逐字引用契约里的值" +
  "（含符号与小数位），禁止重算、取整、改档或引用一份你没见到的分数；契约里没有的数字不要以" +
  "「综合得分/趋势等级」的名义给出。本轮回答与契约不一致会被系统比对并公示警告。";

/** 数值引用：只认「标签 + 至多几个连接符 + 数字」这种明确挂词的写法 */
const CITE_NUM_SPECS: { key: "final" | DimensionKey; label: string; re: string }[] = [
  { key: "final", label: "综合得分", re: "(?:综合得分|最终得分|总得分|综合评分|总分)" },
  { key: "technical", label: DIMENSION_LABEL.technical, re: `(?:${DIMENSION_LABEL.technical}|技术面|技术维)(?:的)?(?:折算)?(?:得分|分值|分)` },
  { key: "probability", label: DIMENSION_LABEL.probability, re: `(?:${DIMENSION_LABEL.probability}|概率面|概率维)(?:的)?(?:折算)?(?:得分|分值|分)` },
  { key: "market", label: DIMENSION_LABEL.market, re: `(?:${DIMENSION_LABEL.market}|市场面|情绪面|情绪分)(?:的)?(?:折算)?(?:得分|分值|分)` },
  { key: "event", label: DIMENSION_LABEL.event, re: `(?:${DIMENSION_LABEL.event}|事件面|消息面|事件分)(?:的)?(?:折算)?(?:得分|分值|分)` },
];

/** 等级引用：本项目六档词表是唯一合法档位名，普通行文里的「偏弱」不挂「等级」字样就不会被算成引用 */
const GRADE_ALT = [...GRADE_ORDER].sort((a, b) => b.length - a.length).join("|");
const GRADE_CITE_RE = new RegExp(`(?:趋势等级|综合等级|六档|等级|档位)[^。；，,！!？?\\n]{0,3}?(${GRADE_ALT})`, "g");

export interface ContractCitation {
  field: string;
  /** 数值引用的数字；等级引用为 null（等级走 cited_text 比对） */
  cited: number | null;
  cited_text: string;
  target: "final" | DimensionKey | "grade";
}

/** 抽出回答里全部「明确引用」。循环内新建正则实例：共享 /g 正则会带着 lastIndex 串到下一次调用（intent-core 的 codeRe 同一教训） */
export function extractContractCitations(text: string): ContractCitation[] {
  const src = text ?? "";
  const out: ContractCitation[] = [];
  for (const s of CITE_NUM_SPECS) {
    const re = new RegExp(`${s.re}[^+\\-\\d]{0,4}([+-]?\\d+(?:\\.\\d+)?)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) out.push({ field: s.label, cited: v, cited_text: m[0].trim().slice(0, 40), target: s.key });
    }
  }
  const gre = new RegExp(GRADE_CITE_RE.source, "g");
  gre.lastIndex = 0;
  let gm: RegExpExecArray | null;
  while ((gm = gre.exec(src))) {
    out.push({ field: "趋势等级", cited: null, cited_text: gm[1], target: "grade" });
  }
  return out;
}

export interface ContractViolation {
  field: string;
  cited_text: string;
  engine_value: string;
}

/** 四舍五入等价：引用位数比引擎少时按引用自己的精度收引擎值（写 33 对上 32.6 是显示精度，不是造假） */
function equalsWithinRounding(engine: number, cited: number): boolean {
  const digits = /\.(\d+)$/.exec(String(cited))?.[1].length ?? 0;
  const factor = 10 ** digits;
  return Math.round(engine * factor) / factor === cited;
}

/** 回答 vs 契约的一致性校验：只出违规清单，不改写、不重试（风险点 4 的落点） */
export function verifyContractCitations(text: string, contract: DecisionContract): ContractViolation[] {
  const cites = extractContractCitations(text ?? "");
  if (!cites.length) return [];
  const bad: ContractViolation[] = [];
  for (const c of cites) {
    if (c.target === "grade") {
      if (contract.grade && c.cited_text !== contract.grade) {
        bad.push({ field: c.field, cited_text: c.cited_text, engine_value: contract.grade });
      }
      continue;
    }
    if (c.cited === null) continue;
    // 提出来给闭包用：c.cited 是可变属性，TS 不把它在 continue 之后的收窄带进回调（TS2345）
    const cited = c.cited;
    let candidates: number[] = [];
    if (c.target === "final") {
      if (contract.final_score !== null) candidates = [contract.final_score];
    } else {
      const dim = contract.dimensions.find((d) => d.key === c.target);
      if (!dim) continue;
      if (dim.raw_score !== null) candidates.push(dim.raw_score);
      if (dim.norm_score !== null) candidates.push(dim.norm_score);
    }
    if (!candidates.length) continue; // 引擎本身没有这个数：不拿「引用了一个算不出的字段」当违规
    if (!candidates.some((v) => equalsWithinRounding(v, cited))) {
      bad.push({ field: c.field, cited_text: c.cited_text, engine_value: candidates.map((v) => String(v)).join(" / ") });
    }
  }
  return bad;
}

/** 警告横幅的唯一文案出处（SSE warning 帧与非流式 JSON 的 warning 字段共用这一份） */
export function contractWarningText(violations: ContractViolation[]): string {
  const list = violations.map((v) => `「${v.cited_text}」→ 本地引擎是 ${v.engine_value}`).join("；");
  return `结论契约校验：模型回答里引用的数字与本地 v3 引擎的对不上（${list}）。以本地引擎为准；模型原文未被改动，也没有自动重答。`;
}
