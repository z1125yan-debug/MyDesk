// P7-③ 建立 / P7-⑦ 改版 —— 市场面（market_score）打分规则表：纯内核，无 DB、无 fetch、无时钟，node --test 可直跑。
//
// 版本沿革（这张表有兩代表，出处必须分得清）：
//   · `p7.s3.market.v1` = P7-③ 本层自认的表。它存在的原因是任务书 §六 原本没有市场面打分表，
//     而 §七 却挂了权重 —— 「有权重无规则」的维度一旦参与加权，页面就会出现一个没人能追问出处的数。
//   · `p7.s7.market.v1` = P7-⑦《完整 AI 决策系统开发文档》给的表：指数站上 20 日线 / 上涨家数>下跌家数 /
//     成交放大 / 板块 RPS>80，各 ±10（缩量 −5、RPS<50 −10），单维限制 −50~+50。
//   P7-⑦ 用户拍板「**新表为主 + 旧表并入**」：同一个指标（涨跌家数、基准指数）按新分法计分，
//   旧分项降级 `role:"basis"`（照常显示读数、不重复计权、rule_version 停在 p7.s3）；
//   新表没有这个指标的（中位涨跌幅、涨跌停净差、炸板率、主力净额、风险等级、主线数量）作为**附加项**继续计分。
//   维度级 `MARKET_RULE_VERSION` 因此升到 p7.s7，而附加项与 basis 各自带自己的版本（见 ScoreItem.rule_version）。
//
// 输入取自哪里（全部是项目里已经在跑、已经有出处的真实读数，本层不取数、不补字段）：
//   - 涨跌家数 / 中位涨跌幅 / 涨跌停家数 / 炸板率 / 主力净额 / 风险等级 / 指数涨跌幅 → sentiment.ts
//     导出的 SentimentResult（全 A 快照 + 腾讯指数实时）；
//   - 主线数量 / 榜首综合分 / 榜首板块 RPS → themes.ts 导出的 ThemeDiscovery（scoreTheme 0~100、
//     rps = 行业+概念合并榜内涨幅百分位）；
//   - 指数 20 日线位置、市场成交额与其均值 → 需要**日K序列**，sentiment 的实时快照给不出，
//     由接线层（decision-service → decision-wiring-core）算好后传进来；没供就按缺失登记（不猜）。
//
// 四条与 P7-① 同源的硬口径：
//   1) **缺读数 = null，不是 0 分**。每个分项都收 `number | null`；null 分项不进求和、并且出现在
//      missing[] 里。整维度一条都算不出 ⇒ score=null，交给 buildDecision 把权重从分母里拿掉。
//   2) 只有「读数存在、按表归入 0 分档」才是 0，这类项的 note 里会写明它不等于算不出。
//   3) 全表文案不出现「概率」「胜率」字样（有测试守着）：市场面给的是当日真实读数与规则分。
//   4) v3：维度必须声明本表极值（`MARKET_EXTREMES`）才能折算到 ±100，所以**极值要跟表同步更新**，
//      漏更新 = 内核拿错尺子（有测试拿两张表的 EXTREMES 与 RULE_VERSIONS 对账）。
//
// 三个必须写下来的坑（都对应着本文件里的一条测试；引用上游时写表达式而不是行号，行号会随上游改动漂移）：
//   - 炸板率：sentiment.ts 的 `breakRate = touched > 0 ? … : null` 在「今日触板数为 0」时给的是 null，
//     并进了 s.missing。这是「算不出」，不是「0% 炸板」。调用方若把 null 换成 0，本层就会按最低档给 +2 分 ⇒ 脏数据变成结论。
//   - 主力净额：sentiment.ts 的 `mainNetSum += m.mainNet ?? 0` 是这种累加，全 A 都没这个字段时也会得到 0。
//     所以 `main_net_sum_yi` 要调用方**确认过口径**再传，没确认就传 null；传 0 就等于宣称「今日全 A 主力净额 0 亿」。
//   - 板块 RPS：themes.ts 的 rps 是**榜内涨幅百分位**（第一名恒为 100），所以「当日没有主线」时不能拿榜首
//     百分位当「强势板块 RPS」用 —— 那是个必然虚高的数。本项在没有主线分组时按算不出处理。

import type { DataStatus } from "./datastatus-core";
import { SUPPLEMENT_MARKER, type Bounds, type ExternalDimension, type ScoreItem } from "./decision-core.ts";

/** 维度级规则版本：P7-⑦ 新表为主（与 decision-core 的 RULE_VERSIONS.market 必须一致，有测试钉住） */
export const MARKET_RULE_VERSION = "p7.s7.market.v1";
/** 并入的附加项与 basis 项仍属 P7-③ 那张自认表 —— 分项级出处写在自己的 rule_version 上 */
export const MARKET_LEGACY_RULE_VERSION = "p7.s3.market.v1";

/** 出处声明：写进每条 note 末尾，让「谁定的分」在数据里可查（与 P7-① 的 SUPPLEMENT_MARKER 同思路） */
export const MARKET_RULE_PROVENANCE = "P7-③ 本层规则表（任务书 §六 无市场面打分表），非任务书原文";
/** 新表四条主判据的出处：这一张是 P7-⑦ 任务书原文，与上面那句不能混 */
export const MARKET_S7_PROVENANCE = "P7-⑦ 任务书市场面表（±50 单维限制），本层只补数值线";

export type MarketRiskLevel = "正常" | "注意" | "偏高" | "高风险";

/** 分项输入：一律可空。null 一律读成「本项算不出」，与 P7-① 的 TechnicalInput 同口径 */
export interface MarketInput {
  /** 上涨家数 / 下跌家数（sentiment.ts 的 advancers / decliners，剔除停牌与无成交后的口径） */
  advancers: number | null;
  decliners: number | null;
  /** 参与统计的全 A 家数，只用于 raw 文案，判定不用它（分母是涨+跌） */
  total?: number | null;
  /** 全 A 中位涨跌幅，百分数（-3.21 表示 −3.21%） */
  median_pct: number | null;
  /**
   * 基准指数当日涨跌幅。symbol/label 必须由调用方显式给出：本层不猜「这条指数是哪条」，
   * 也不接受裸数字（否则上证 +0.5% 与创业板 +0.5% 在血缘里会长得一模一样）。
   */
  index?: { symbol: string | null; label: string | null; change_pct: number | null } | null;
  /**
   * 新表 M-IDX-MA20 的读数：同一条基准指数的收盘与 20 日均线（接线层由指数日K算）。
   * symbol 必须与 `index.symbol` 同一条指数 —— 否则「站上 20 日线」和「涨跌幅」说的不是同一个对象。
   */
  index_ma20?: { symbol: string | null; label: string | null; close: number | null; ma20: number | null; window?: number | null } | null;
  /**
   * 新表 M-TURNOVER 的读数：成交额（亿）当日值与近期均值。
   * `scope` 必填写清楚是谁的成交额（全 A / 沪深两市 / 某指数），本层不猜。
   */
  turnover?: { scope: string | null; today_yi: number | null; avg_yi: number | null; window?: number | null } | null;
  limit_up: number | null;
  limit_down: number | null;
  /** 炸板率百分数；触板为 0 时引擎给 null —— 请原样传 null，不要传 0 */
  break_rate: number | null;
  /** 全 A 主力净额（亿）。未确认口径时传 null，见文件头 */
  main_net_sum_yi: number | null;
  /** sentiment 引擎自报的风险等级 */
  risk_level?: MarketRiskLevel | null;
  /** 板块强度：主线数量、榜首综合分（scoreTheme 0~100）、榜首主线的板块 RPS（0~100 百分位） */
  themes?: { main_count: number | null; top_score: number | null; top_rps?: number | null; rps_scope?: string | null } | null;
  /** 读数所属交易日与是否盘中：只进文案，不参与计算（服务端时钟归调用方） */
  trade_date?: string | null;
  live?: boolean | null;
}

export interface Band {
  min: number;
  /** null = 无上界 */
  max: number | null;
  points: number;
  label: string;
  note?: string;
}

/** 区间一律左闭右开 [min,max)，与 P7-① 的 PROBABILITY_BANDS 同约定：边界只有唯一归属 */
export function pickBand(bands: Band[], v: number): Band | null {
  return bands.find((b) => v >= b.min && (b.max === null || v < b.max)) ?? null;
}

/* ---------------------------------- P7-⑦ 新表：四条主判据 ---------------------------------- */

/**
 * 指数与 20 日线的位置：按「收盘相对 MA20 的偏离百分数」查表（+10 / 0 / −10）。
 * 用偏离而不是「高于/低于」的裸比较：任务书还有「震荡 0」这一档，
 * 收盘在均线上下 0.5% 里穿来穿去时，判成站上/跌破都只是噪声。±0.5% 这条带宽是本层补的。
 */
export const IDX_MA20_FLAT_BAND = 0.5;
export const MARKET_MA20_BANDS: Band[] = [
  { min: IDX_MA20_FLAT_BAND, max: null, points: 10, label: "基准指数站上 20 日线" },
  { min: -IDX_MA20_FLAT_BAND, max: IDX_MA20_FLAT_BAND, points: 0, label: "基准指数贴着 20 日线震荡", note: `±${IDX_MA20_FLAT_BAND}% 的「震荡」带宽是本层补的（任务书只写了三档）｜${SUPPLEMENT_MARKER}` },
  { min: -Infinity, max: -IDX_MA20_FLAT_BAND, points: -10, label: "基准指数跌破 20 日线" },
];

/**
 * 涨跌家数三档（任务书：上涨家数>下跌 +10 / 接近 0 / 普跌 −10）。
 * 「接近」与「普跌」任务书都没给线，本层按上涨占比补：±5% 内算接近、占比 <35% 算普跌。
 * 35%~45% 这段是「跌得多但没到普跌线」，任务书没定义 ⇒ 取 0 并登记（不给 −10 也不给 +10）。
 */
export const BREADTH_NEAR_BAND = 0.05;
export const BREADTH_PUDIE_MAX_SHARE = 0.35;
export const MARKET_BREADTH_LEVEL_BANDS: Band[] = [
  { min: 0.5 + BREADTH_NEAR_BAND, max: null, points: 10, label: "上涨家数多于下跌家数" },
  { min: 0.5 - BREADTH_NEAR_BAND, max: 0.5 + BREADTH_NEAR_BAND, points: 0, label: "涨跌家数接近", note: `±${BREADTH_NEAR_BAND * 100}% 的带宽是本层补的｜${SUPPLEMENT_MARKER}` },
  { min: BREADTH_PUDIE_MAX_SHARE, max: 0.5 - BREADTH_NEAR_BAND, points: 0, label: "下跌家数偏多但未达普跌线", note: `任务书只写了「>下跌 / 接近 / 普跌」三档，这一段未定义 ⇒ 本层取 0 不猜｜${SUPPLEMENT_MARKER}` },
  { min: -Infinity, max: BREADTH_PUDIE_MAX_SHARE, points: -10, label: "普跌（上涨占比 <35%）", note: `普跌线 35% 是本层补的｜${SUPPLEMENT_MARKER}` },
];

/** 成交放大/缩量（任务书：放大 +10 / 持平 0 / 明显缩量 −5）；倍数线是本层补的，与技术面同一把尺 */
export const MARKET_VOLUME_SURGE_RATIO = 1.2;
export const MARKET_VOLUME_SHRINK_RATIO = 0.8;
export const MARKET_TURNOVER_BANDS: Band[] = [
  { min: MARKET_VOLUME_SURGE_RATIO, max: null, points: 10, label: "成交放大（≥ 均值的 1.2 倍）", note: `放量线 ${MARKET_VOLUME_SURGE_RATIO} 倍是本层补的｜${SUPPLEMENT_MARKER}` },
  { min: MARKET_VOLUME_SHRINK_RATIO, max: MARKET_VOLUME_SURGE_RATIO, points: 0, label: "成交持平（均值 0.8~1.2 倍）", note: `读数存在、按表归入 0 分，不是算不出｜${SUPPLEMENT_MARKER}` },
  { min: -Infinity, max: MARKET_VOLUME_SHRINK_RATIO, points: -5, label: "明显缩量（< 均值的 0.8 倍）", note: `缩量线 ${MARKET_VOLUME_SHRINK_RATIO} 倍是本层补的｜${SUPPLEMENT_MARKER}` },
];

/** 板块 RPS（任务书：>80 +10、50–80 +5、<50 −10）；口径必须写清楚是「哪份榜的百分位」 */
export const MARKET_RPS_BANDS: Band[] = [
  // 任务书在 80 这个端点上同时写了「50–80」和「>80」，没交代正好 80 归谁。
  // 本层沿用全维统一的「左闭右开」归档口径 ⇒ 80 计入强势档，并把这件事写在 label/note 里，
  // 而不是嘴上写「>80」、手上按「≥80」判。
  { min: 80, max: null, points: 10, label: "强势板块 RPS ≥80", note: `80 这一端任务书两头都写了，本层按左闭归入强势档｜${SUPPLEMENT_MARKER}` },
  { min: 50, max: 80, points: 5, label: "板块 RPS 50~80（不含 80）" },
  { min: -Infinity, max: 50, points: -10, label: "板块 RPS <50" },
];

/* ---------------------------------- P7-③ 旧表：附加项（新表没这个指标，继续计分） ---------------------------------- */

/** 涨跌家数占比五档 —— v3 起降级为判定依据（同指标已并入 M-BREADTH 三档），不再计分 */
export const MARKET_BREADTH_BANDS: Band[] = [
  { min: 0.75, max: null, points: 6, label: "普涨（上涨占比 ≥75%）" },
  { min: 0.6, max: 0.75, points: 3, label: "偏强（上涨占比 60%–75%）" },
  { min: 0.4, max: 0.6, points: 0, label: "涨跌大致对半（40%–60%）", note: `读数存在、按表归入 0 分，不是算不出｜${MARKET_RULE_PROVENANCE}` },
  { min: 0.25, max: 0.4, points: -3, label: "偏弱（上涨占比 25%–40%）" },
  { min: -Infinity, max: 0.25, points: -6, label: "普跌（上涨占比 <25%）" },
];

export const MARKET_MEDIAN_BANDS: Band[] = [
  { min: 1, max: null, points: 4, label: "中位数涨幅 ≥1%" },
  { min: 0.3, max: 1, points: 2, label: "中位数小幅上涨 0.3%–1%" },
  { min: -0.3, max: 0.3, points: 0, label: "中位数在 0 轴附近（−0.3%~0.3%）", note: `读数存在、按表归入 0 分，不是算不出｜${MARKET_RULE_PROVENANCE}` },
  { min: -1, max: -0.3, points: -2, label: "中位数小幅下跌 −1%~−0.3%" },
  { min: -Infinity, max: -1, points: -5, label: "中位数跌幅 >1%" },
];

/** 基准指数当日涨跌幅五档 —— v3 起降级为判定依据（同指标由 M-IDX-MA20 计分） */
export const MARKET_INDEX_BANDS: Band[] = [
  { min: 1, max: null, points: 4, label: "基准指数涨幅 ≥1%" },
  { min: 0.3, max: 1, points: 2, label: "基准指数小幅上涨 0.3%–1%" },
  { min: -0.3, max: 0.3, points: 0, label: "基准指数平收（−0.3%~0.3%）", note: `读数存在、按表归入 0 分，不是算不出｜${MARKET_RULE_PROVENANCE}` },
  { min: -1, max: -0.3, points: -2, label: "基准指数小幅下跌 −1%~−0.3%" },
  { min: -Infinity, max: -1, points: -5, label: "基准指数跌幅 >1%" },
];

/** 涨跌停净差 = 涨停家数 − 跌停家数：赚钱效应的粗口径，两端都要有数才能判 */
export const MARKET_LIMITNET_BANDS: Band[] = [
  { min: 20, max: null, points: 4, label: "涨停显著多于跌停（净差 ≥20 家）" },
  { min: 5, max: 20, points: 2, label: "涨停多于跌停（净差 5~19 家）" },
  { min: -5, max: 5, points: 0, label: "涨停跌停相当（净差 −5~4 家）", note: `读数存在、按表归入 0 分，不是算不出｜${MARKET_RULE_PROVENANCE}` },
  { min: -20, max: -5, points: -2, label: "跌停多于涨停（净差 −20~−6 家）" },
  { min: -Infinity, max: -20, points: -5, label: "跌停显著多于涨停（净差 <−20 家）" },
];

/** 炸板率越高风险越大：分档按升序写，所以分数是递减的（左闭右开同样适用） */
export const MARKET_BREAK_BANDS: Band[] = [
  { min: 0, max: 20, points: 2, label: "炸板率 <20%（封板承接好）" },
  { min: 20, max: 40, points: 0, label: "炸板率 20%–40%", note: `读数存在、按表归入 0 分，不是算不出｜${MARKET_RULE_PROVENANCE}` },
  { min: 40, max: null, points: -3, label: "炸板率 ≥40%（触板封不住）" },
];

export const MARKET_MAFLOW_BANDS: Band[] = [
  { min: 300, max: null, points: 2, label: "全 A 主力净流入 ≥300 亿" },
  { min: 100, max: 300, points: 1, label: "全 A 主力净流入 100–300 亿" },
  { min: -100, max: 100, points: 0, label: "全 A 主力净额在 0 轴附近（−100~100 亿）", note: `读数存在、按表归入 0 分，不是算不出｜${MARKET_RULE_PROVENANCE}` },
  { min: -300, max: -100, points: -1, label: "全 A 主力净流出 100–300 亿" },
  { min: -Infinity, max: -300, points: -3, label: "全 A 主力净流出 >300 亿" },
];

/** 风险等级 → 分：引擎的四档枚举，逐档给分，缺档不猜 */
export const MARKET_RISK_POINTS: Record<MarketRiskLevel, number> = { 正常: 4, 注意: -2, 偏高: -4, 高风险: -6 };
export const MARKET_RISK_NOTE = `风险等级由 sentiment 引擎的涨跌家数比/跌停家数/主力净额/中位涨跌幅/炸板率推出，与本表其它分项同源：这里是有意重复计权，不能当成独立证据`;

/** 板块强度：只认 themes 引擎的分组结果与综合分；「0 条主线」是读数，不是缺数据 */
export const MARKET_THEME_BANDS: Band[] = [
  { min: 3, max: null, points: 4, label: "主线 ≥3 个且榜首够强" },
  { min: 1, max: 3, points: 2, label: "有主线（1–2 个）" },
  { min: 0, max: 1, points: 0, label: "当日未判出主线", note: `这是引擎的读数（没有形成主线分组），不是缺数据；0 分不等于利空｜${MARKET_RULE_PROVENANCE}` },
];

export interface MarketDimensionResult {
  /** 本维字面分（已按任务书夹进 ±50；夹取过程登记在 missing 里） */
  score: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
}

const n1 = (x: number) => Math.round(x * 10) / 10;
const n2 = (x: number) => Math.round(x * 100) / 100;
const pct1 = (x: number) => `${n1(x * 100)}%`;
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}`;
const isNum = (x: number | null | undefined): x is number => typeof x === "number" && !Number.isNaN(x);
const fnum = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? "无" : `${n1(x)}`);

/** 缺读数的分项：points=null + MISSING + 说明为什么不是 0 分 */
function missingItem(rule: string, label: string, raw: string, note: string, version = MARKET_LEGACY_RULE_VERSION): ScoreItem {
  return { rule, label, points: null, raw, status: "MISSING", note: `${note}（不是 0 分，也不是「中性」）`, role: "scored", rule_version: version };
}

function hitItem(rule: string, band: Band, raw: string, version = MARKET_LEGACY_RULE_VERSION, provenance = MARKET_RULE_PROVENANCE): ScoreItem {
  return {
    rule, label: band.label, points: band.points, raw, status: "DERIVED",
    note: [band.note, provenance].filter(Boolean).join("｜"), role: "scored", rule_version: version,
  };
}

/** 判定依据项：读数照常给，点数不进本维求和（新旧表同一指标时旧项走这里） */
function basisItem(rule: string, band: Band | null, raw: string, why: string): ScoreItem {
  return {
    rule, label: band ? band.label : "本次给不出读数", points: band ? band.points : null, raw,
    status: band ? "DERIVED" : "MISSING", role: "basis", rule_version: MARKET_LEGACY_RULE_VERSION,
    note: `${why}｜表 ${MARKET_LEGACY_RULE_VERSION}`,
  };
}

/** 当日/盘中的时间戳文案：收盘值不写成盘中值，盘中值要标明会变（与 sentiment.live 同口径） */
function stampText(input: MarketInput): string {
  const when = input.live === null || input.live === undefined ? "" : input.live ? "，盘中实时（收盘前会变）" : "，收盘/休市值（非盘中实时）";
  return `${input.trade_date ?? "读数所属日未给出"}${when}`;
}

/**
 * 市场面逐条打分：4 条主判据（新表）+ 6 条附加项（旧表继续计分）+ 2 条判定依据（旧表降级）。
 * 每条各自可空：缺哪项只说哪项算不出，不因为一项缺就整面归零。
 */
export function marketItems(input: MarketInput): ScoreItem[] {
  const items: ScoreItem[] = [];

  // —— 新表 1：M-IDX-MA20 指数与 20 日线 ——
  const ma = input.index_ma20 ?? null;
  if (!ma || !isNum(ma.close) || !isNum(ma.ma20) || ma.ma20 === 0) {
    items.push(missingItem("M-IDX-MA20", "基准指数与 20 日线", `指数=${ma ? (ma.label ?? ma.symbol ?? "未命名") : "未给出"}，收盘=${fnum(ma?.close)}，MA20=${fnum(ma?.ma20)}`,
      ma ? "指数的 20 日均线取不出（接线层没给日K序列，或历史长度不足窗口）：本层不拿当日涨跌幅代替均线位置" : "调用方没有声明这条均线是哪条指数的：本层不替它选",
      MARKET_RULE_VERSION));
  } else if (ma.symbol && input.index?.symbol && ma.symbol !== input.index.symbol) {
    items.push(missingItem("M-IDX-MA20", "基准指数与 20 日线", `均线取自 ${ma.symbol}，而涨跌幅取自 ${input.index.symbol}`,
      "两个读数不是同一条指数：本层不把它们并成一个分项（上证站上线、创业板跌破，说成一句就是假话）", MARKET_RULE_VERSION));
  } else {
    const dev = (ma.close / ma.ma20 - 1) * 100;
    const band = pickBand(MARKET_MA20_BANDS, dev)!;
    const win = isNum(ma.window) ? `，均线窗口 ${ma.window} 根` : "";
    items.push(hitItem("M-IDX-MA20", band, `${ma.label ?? ma.symbol ?? "未命名指数"}（${ma.symbol ?? "代码未给出"}）收盘 ${n2(ma.close)} vs MA20 ${n2(ma.ma20)} ⇒ 偏离 ${signed(n2(dev))}%${win}`, MARKET_RULE_VERSION, MARKET_S7_PROVENANCE));
  }

  // —— 新表 2：M-BREADTH 上涨家数 vs 下跌家数（三档） ——
  const share = isNum(input.advancers) && isNum(input.decliners) && input.advancers + input.decliners > 0
    ? input.advancers / (input.advancers + input.decliners) : null;
  if (share === null) {
    items.push(missingItem("M-BREADTH", "上涨家数与下跌家数", `上涨=${input.advancers ?? "无"} / 下跌=${input.decliners ?? "无"}`,
      isNum(input.advancers) && isNum(input.decliners) ? "上涨与下跌都是 0：三档都无定义（把 0/0 当成「接近」或当成 0 分都是编）" : "涨跌家数有缺，本项不判定",
      MARKET_RULE_VERSION));
  } else {
    const band = pickBand(MARKET_BREADTH_LEVEL_BANDS, share)!;
    items.push(hitItem("M-BREADTH", band, `上涨 ${input.advancers} 家 / 下跌 ${input.decliners} 家（上涨占比 ${pct1(share)}）${isNum(input.total) ? `，参与统计 ${input.total} 家` : ""}`, MARKET_RULE_VERSION, MARKET_S7_PROVENANCE));
  }

  // —— 新表 3：M-TURNOVER 成交放大/缩量 ——
  const to = input.turnover ?? null;
  if (!to || !isNum(to.today_yi) || !isNum(to.avg_yi) || to.avg_yi <= 0) {
    items.push(missingItem("M-TURNOVER", "市场成交额放大/缩量", `当日=${fnum(to?.today_yi)} 亿，均值=${fnum(to?.avg_yi)} 亿${isNum(to?.window) ? `（${to?.window} 日均值）` : ""}`,
      to ? "成交额或基准均值取不出：本层不判放大也不判缩量" : "接线层没有提供成交额读数（sentiment 的实时快照里没有全市场成交额历史）：本项按缺失处理，不拿换手率凑",
      MARKET_RULE_VERSION));
  } else if (!to.scope) {
    items.push(missingItem("M-TURNOVER", "市场成交额放大/缩量", `比值 ${n2(to.today_yi / to.avg_yi)}，但 scope 未声明`,
      "没说清这是全 A、沪深两市还是某条指数的成交额：本层按缺失登记（口径不明的读数不进结论）", MARKET_RULE_VERSION));
  } else {
    const ratio = to.today_yi / to.avg_yi;
    const band = pickBand(MARKET_TURNOVER_BANDS, ratio)!;
    items.push(hitItem("M-TURNOVER", band, `${to.scope}当日成交 ${n1(to.today_yi)} 亿 / ${isNum(to.window) ? `${to.window} 日` : "近期"}均值 ${n1(to.avg_yi)} 亿 = ${n2(ratio)} 倍`, MARKET_RULE_VERSION, MARKET_S7_PROVENANCE));
  }

  // —— 新表 4：M-RPS 强势板块 RPS ——
  const th = input.themes ?? null;
  if (!th || !isNum(th.top_rps)) {
    items.push(missingItem("M-RPS", "强势板块 RPS", `榜首板块 RPS=${fnum(th?.top_rps)}`,
      th ? "themes 引擎本次没给出榜首主线的 RPS 百分位（旧快照里没有这个字段）：本项不判定" : "themes 引擎本次没有产出主线分组结果（未跑或上游无返回）：本项不判定，不给 0",
      MARKET_RULE_VERSION));
  } else if (!isNum(th.main_count) || th.main_count < 1) {
    items.push(missingItem("M-RPS", "强势板块 RPS", `榜首 RPS ${n1(th.top_rps)}，但主线 ${th.main_count ?? "未给出"} 个`,
      "当日没有主线分组时榜内的「第一名百分位」必然偏高（themes 的 rps 是合并榜内涨幅百分位）：拿它当「强势板块 RPS」就是虚高，本项按算不出处理", MARKET_RULE_VERSION));
  } else {
    const band = pickBand(MARKET_RPS_BANDS, th.top_rps)!;
    const scopeNote = th.rps_scope ? `｜口径：${th.rps_scope}` : `｜注意：RPS 的榜单口径未声明，本层按读数计入但无法追它是哪份榜`;
    items.push({
      ...hitItem("M-RPS", band, `榜首主线 RPS ${n1(th.top_rps)}（主线 ${th.main_count} 个）${scopeNote}`, MARKET_RULE_VERSION, MARKET_S7_PROVENANCE),
    });
  }

  // —— 附加项（P7-③ 旧表里新表没有的指标，继续计分） ——
  if (!isNum(input.median_pct)) {
    items.push(missingItem("M-MEDIAN", "全 A 中位涨跌幅", "中位涨跌幅缺失", "引擎本次没有给出中位数（全 A 快照无有效涨跌幅），本项不判定"));
  } else {
    items.push(hitItem("M-MEDIAN", pickBand(MARKET_MEDIAN_BANDS, input.median_pct)!, `全 A 中位涨跌幅 ${signed(n1(input.median_pct))}%`));
  }

  if (!isNum(input.limit_up) || !isNum(input.limit_down)) {
    items.push(missingItem("M-LIMITNET", "涨停−跌停净差", `涨停=${input.limit_up ?? "无"} / 跌停=${input.limit_down ?? "无"}`, "涨跌停有一侧缺数就不判净差：单边读数减不出来时不给 0，避免把「没统计到」写成「没有涨跌停」"));
  } else {
    const net = input.limit_up - input.limit_down;
    items.push(hitItem("M-LIMITNET", pickBand(MARKET_LIMITNET_BANDS, net)!, `涨停 ${input.limit_up} 家 − 跌停 ${input.limit_down} 家 = 净差 ${signed(net)} 家`));
  }

  if (!isNum(input.break_rate)) {
    items.push(missingItem("M-BREAK", "炸板率", "炸板率无读数（引擎在当日触板数为 0 时返回 null）", "sentiment 里 breakRate 的 null 是「触板 0 家、比率无定义」，不是 0% 炸板；按 0% 计入会白送 +2 分"));
  } else if (input.break_rate < 0 || input.break_rate > 100) {
    items.push(missingItem("M-BREAK", "炸板率", `炸板率 ${n1(input.break_rate)}% 越出 0–100`, "越界读数一律不判定：脏数据不能变成一个分数"));
  } else {
    items.push(hitItem("M-BREAK", pickBand(MARKET_BREAK_BANDS, input.break_rate)!, `炸板率 ${n1(input.break_rate)}%`));
  }

  if (!isNum(input.main_net_sum_yi)) {
    items.push(missingItem("M-MAINFLOW", "全 A 主力净额", "主力净额无可信读数", "sentiment 里的 mainNetSum 是 `?? 0` 累加，字段全缺时也是 0；调用方未确认口径时传 null，本项就不判定而不是判成「0 亿」"));
  } else {
    items.push(hitItem("M-MAINFLOW", pickBand(MARKET_MAFLOW_BANDS, input.main_net_sum_yi)!, `全 A 主力净额 ${signed(n1(input.main_net_sum_yi))} 亿`));
  }

  const level = input.risk_level ?? null;
  if (level === null || !(level in MARKET_RISK_POINTS)) {
    items.push(missingItem("M-RISK", "市场风险等级", `风险等级=${level ?? "未给出"}`, level === null ? "引擎本次没有给出风险等级" : `风险等级「${level}」不在引擎的四档枚举里，本层不映射（宁可不判，也不新增一档）`));
  } else {
    items.push({
      rule: "M-RISK", label: `风险等级「${level}」`, points: MARKET_RISK_POINTS[level], raw: `sentiment 引擎自报风险等级「${level}」`,
      status: "DERIVED", role: "scored", rule_version: MARKET_LEGACY_RULE_VERSION, note: `${MARKET_RISK_NOTE}｜${MARKET_RULE_PROVENANCE}`,
    });
  }

  if (!th || !isNum(th.main_count)) {
    items.push(missingItem("M-THEME", "板块强度（主线）", `主线数量=${th?.main_count ?? "未给出"}`, "themes 引擎本次没有产出主线分组结果（未跑或上游无返回）：本项不判定，不给 0"));
  } else if (isNum(th.top_score) && th.top_score < 60 && th.main_count >= 3) {
    items.push(missingItem("M-THEME", "板块强度（主线）", `主线 ${th.main_count} 个，榜首综合分仅 ${n1(th.top_score)}`, "主线数量够但榜首强度不足 60：本层不解释成「强势」也不给 0，先登记为口径异常（themes 的 scoreTheme 是 0~100 综合分）"));
  } else {
    const band = pickBand(MARKET_THEME_BANDS, th.main_count)!;
    const strength = isNum(th.top_score) ? `，榜首综合分 ${n1(th.top_score)}` : "，榜首强度未给出（只按主线数量判定）";
    items.push(hitItem("M-THEME", band, `主线 ${th.main_count} 个${strength}`));
  }

  // —— 判定依据（旧表里与新表撞指标的两条：降级、不重复计权） ——
  items.push(basisItem("M-BREADTH-SHARE", share === null ? null : pickBand(MARKET_BREADTH_BANDS, share),
    share === null ? "涨跌家数无有效读数" : `上涨占比 ${pct1(share)}${isNum(input.total) ? `，参与统计 ${input.total} 家` : ""}`,
    "P7-⑦ 新表用三档（>下跌 / 接近 / 普跌）给涨跌家数计分 ⇒ 旧的五档占比只作判定依据"));
  const idx = input.index ?? null;
  items.push(basisItem("M-INDEX-PCT", idx && isNum(idx.change_pct) ? pickBand(MARKET_INDEX_BANDS, idx.change_pct) : null,
    !idx ? "未指定基准指数" : isNum(idx.change_pct) ? `${idx.label ?? idx.symbol ?? "未命名指数"}（${idx.symbol ?? "代码未给出"}）${signed(n1(idx.change_pct))}%` : `${idx.label ?? idx.symbol ?? "未命名指数"}（${idx.symbol ?? "代码未给出"}）本次无涨跌幅读数`,
    "P7-⑦ 新表按「指数是否站上 20 日线」给分 ⇒ 旧的五档当日涨跌幅只作判定依据"));

  // 血缘：市场面的每个数字都是「某一天某一时刻」的快照读数，而 decision-core 的 sources[] 只覆盖概率面，
  // 所以日期/盘内外状态只能挂在 raw 上——decisionToText 会把 raw 打出来，页面与事后复看才有得对。
  const stamp = stampText(input);
  return items.map((i) => ({ ...i, raw: `${i.raw}｜读数所属日 ${stamp}` }));
}

/**
 * 归并成一个维度：只加 `role!=="basis"` 且算得出的分项，然后按任务书把字面分夹进 ±50（夹取登记在 missing）。
 * 整维度全缺 ⇒ score=null（由 buildDecision 把这一维从权重分母里剔除）。
 */
export function marketDimension(input: MarketInput): MarketDimensionResult {
  const items = marketItems(input);
  const scoredItems = items.filter((i) => i.role !== "basis");
  const basisItems = items.filter((i) => i.role === "basis");
  const counted = scoredItems.filter((i) => i.points !== null);
  const nulls = scoredItems.filter((i) => i.points === null);
  const missing = nulls.map((i) => `${i.label}：${i.raw}`);
  const stamp = stampText(input);
  if (!counted.length) {
    return {
      score: null, items, status: "MISSING",
      missing: [`市场面 ${scoredItems.length} 个计分分项本次全部算不出（读数所属日 ${stamp}）：整维度不计分、权重让给可算维度，本层不会用空分母凑出一个市场环境分`, ...missing],
    };
  }
  const sum = counted.reduce((a, i) => a + (i.points as number), 0);
  const clamped = clampMarket(sum);
  if (clamped.clampedFrom !== null) {
    missing.push(`本维字面分 ${signed(clamped.clampedFrom)} 超出任务书的单维限制 ±${MARKET_DIMENSION_LIMIT}，按 ${signed(clamped.value)} 计入（夹取是任务书规定，不是本层藏的口径）`);
  }
  if (nulls.length) missing.push(`有 ${nulls.length} 个市场面分项算不出，得分只按可算项求和（可能偏保守）`);
  if (basisItems.length) missing.push(`另有 ${basisItems.length} 项作为判定依据展示、未重复计分（${basisItems.map((i) => `${i.rule}=${i.points === null ? "无读数" : signed(i.points)}`).join("、")}）`);
  // 没带日期的市场读数仍然参与计算（数字是真的），但「这是哪一天的市场」说不清就得降级并登记，
  // 不能让它以一条无日期却打了满分的市场面结论出现在页面上。
  const undated = !input.trade_date;
  if (undated) missing.push("本次市场面读数没有 trade_date：无法确认这些数字属于哪个交易日，整维度按降级处理（不是拒算，但不得当成当日事实引用）");
  return {
    score: clamped.value,
    items,
    missing,
    status: nulls.length || undated ? "DEGRADED" : "DERIVED",
  };
}

/** 任务书给市场面的单维限制 */
export const MARKET_DIMENSION_LIMIT = 50;

function clampMarket(raw: number): { value: number; clampedFrom: number | null } {
  if (Math.abs(raw) <= MARKET_DIMENSION_LIMIT) return { value: raw, clampedFrom: null };
  return { value: raw > 0 ? MARKET_DIMENSION_LIMIT : -MARKET_DIMENSION_LIMIT, clampedFrom: raw };
}

/** 直接喂给 buildDecision 的 external 入口（对齐 v3 的 ExternalDimension 契约） */
export function marketExternal(input: MarketInput): ExternalDimension {
  const d = marketDimension(input);
  // bounds 在 v3 里是**折算的尺子**（不再只是可达区间对账）：不带它内核就无法把这一维折成 ±100，
  // 这一维就直接不参与加权。所以它必须与计分档同步更新 —— 漏更新等于拿错尺子量。
  return { key: "market", score: d.score, rule_version: MARKET_RULE_VERSION, items: d.items, missing: d.missing, status: d.status, bounds: MARKET_EXTREMES };
}

/**
 * 本表的**计分档**极值（basis 项不在内）：每条计分规则各取自己能给的最高/最低分，再夹到 ±50。
 * 账面（未夹）是 +60 / −57：新表四条 40/−35，附加项 +20/−22。
 * 用途 —— ① 随 `marketExternal()` 的 `bounds` 交给 decision-core 折算与 `scoreBounds`；
 * ② 自证上下限真有一组输入打得到（CEILING/WEAK 两组读数在测试里就是干这件事的，夹取也因此会被真的触发）。
 * 注意它是「这张表能给几分」的账面极值，不是「今天市场能差到哪」的预测。
 */
export const MARKET_EXTREMES_UNCLAMPED: Bounds = (() => {
  const groups: number[][] = [
    MARKET_MA20_BANDS.map((b) => b.points),
    MARKET_BREADTH_LEVEL_BANDS.map((b) => b.points),
    MARKET_TURNOVER_BANDS.map((b) => b.points),
    MARKET_RPS_BANDS.map((b) => b.points),
    MARKET_MEDIAN_BANDS.map((b) => b.points),
    MARKET_LIMITNET_BANDS.map((b) => b.points),
    MARKET_BREAK_BANDS.map((b) => b.points),
    MARKET_MAFLOW_BANDS.map((b) => b.points),
    Object.values(MARKET_RISK_POINTS),
    MARKET_THEME_BANDS.map((b) => b.points),
  ];
  return { max: groups.reduce((a, g) => a + Math.max(...g), 0), min: groups.reduce((a, g) => a + Math.min(...g), 0) };
})();

export const MARKET_EXTREMES: Bounds = {
  min: Math.max(MARKET_EXTREMES_UNCLAMPED.min, -MARKET_DIMENSION_LIMIT),
  max: Math.min(MARKET_EXTREMES_UNCLAMPED.max, MARKET_DIMENSION_LIMIT),
};
