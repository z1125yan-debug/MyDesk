// P7-③ 市场面（market_score）打分规则表 —— 纯内核：无 DB、无 fetch、无时钟，node --test 可直跑。
//
// 为什么这张表在 P7-① 里是「空的」：任务书 §六 只给了技术面的打分表，§七 却给 market_score 挂了
// 20/100 的权重。P7-① 的处理是把 RULE_VERSIONS.market 写成 null 并在 resolveExternal 里拒绝打分
// （decision-core.ts:379），因为「有权重无规则」的维度一旦参与加权，页面就会出现一个没人能追问出处的数。
// 本文件就是那张缺失的规则表本身 —— 由用户 2026-09-20 指令「开始执行 P7-③：market_score、event_score
// 打分规则开发」授权新建。它**不是任务书原文**，所以规则版本写作 `p7.s3.market.v1`，与
// `p7.taskbook.s6` 明确区分；有一条测试专门钉住这件事，防止将来有人以为 §六 里真有这张表。
//
// 输入取自哪里（全部是项目里已经在跑、已经有出处的真实读数，本层不取数、不补字段）：
//   - 涨跌家数 / 中位涨跌幅 / 涨跌停家数 / 炸板率 / 主力净额 / 风险等级 / 指数涨跌幅 → sentiment.ts
//     导出的 SentimentResult（全 A 快照 + 腾讯指数实时）；
//   - 主线数量与榜首强度 → themes.ts 导出的 ThemeDiscovery（scoreTheme 的 0~100 综合分）。
//   取数与接线在 P7-④ 由 decision-service.ts 做（映射判断在 decision-wiring-core.ts，那里可测）。
//
// 三条与 P7-① 同源的硬口径：
//   1) **缺读数 = null，不是 0 分**。每个分项都收 `number | null`；null 分项不进求和、并且出现在
//      missing[] 里。整维度一条都算不出 ⇒ score=null，交给 buildDecision 把权重从分母里拿掉（约束 2）。
//   2) 只有「读数存在、按表归入 0 分档」才是 0，这类项的 note 里会写明它不等于算不出。
//   3) 全表文案不出现「概率」「胜率」字样（有测试守着）：市场面给的是当日真实读数与规则分，
//      引用概率是概率面的事。这也保证将来把结论文本喂给 agent-loop-core 的 probabilityCheck 时，
//      不会因为市场面文案凭空要求 trade_date/sample/horizon 三项概率口径。
//
// 三个必须写下来的坑（都对应着本文件里的一条测试；引用上游时写表达式而不是行号，行号会随上游改动漂移）：
//   - 炸板率：sentiment.ts 的 `breakRate = touched > 0 ? … : null` 在「今日触板数为 0」时给的是 null，
//     并进了 s.missing。这是「算不出」，不是「0% 炸板」。调用方若把 null 换成 0，本层就会按最低档给 +2 分 ⇒ 脏数据变成结论。
//   - 主力净额：sentiment.ts 的 `mainNetSum += m.mainNet ?? 0` 是这种累加，全 A 都没这个字段时也会得到 0。
//     所以本层的 `main_net_sum_yi` 要调用方**确认过口径**再传，没确认就传 null；传 0 就等于宣称
//     「今日全 A 主力净额 0 亿」，那是个结论，不是占位。
//   - 风险等级：sentiment.ts 的 level 段（triggers/worse）是由涨跌家数比、跌停家数、主力净额、中位涨跌幅、炸板率
//     推出来的，与本表前几项**同源**。它进加权就是有意为之的重复计权（§七 把「风险模型」和「市场环境」
//     一起摊进 market_score），但重复必须留痕：M-RISK 的 note 里明写同源，页面不得把它当独立证据。

import type { DataStatus } from "./datastatus-core";
import type { ExternalDimension, ScoreItem } from "./decision-core";

/** 规则表版本：s3 = P7 第三阶段，market = 本表；不是 taskbook 前缀，出处一眼可分 */
export const MARKET_RULE_VERSION = "p7.s3.market.v1";

/** 出处声明：写进每条 note 末尾，让「谁定的分」在数据里可查（与 P7-① 的 SUPPLEMENT_MARKER 同思路） */
export const MARKET_RULE_PROVENANCE = "P7-③ 本层规则表（任务书 §六 无市场面打分表），非任务书原文";

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
  limit_up: number | null;
  limit_down: number | null;
  /** 炸板率百分数；触板为 0 时引擎给 null —— 请原样传 null，不要传 0 */
  break_rate: number | null;
  /** 全 A 主力净额（亿）。未确认口径时传 null，见文件头 */
  main_net_sum_yi: number | null;
  /** sentiment 引擎自报的风险等级 */
  risk_level?: MarketRiskLevel | null;
  /** 板块强度：themes 引擎的主线数量与榜首综合分（0~100） */
  themes?: { main_count: number | null; top_score: number | null } | null;
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

/** 涨跌家数占比 = 涨 /（涨+跌）。用占比而不是比值：下跌 0 家时比值无定义，占比天然有定义（=1） */
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
  score: number | null;
  items: ScoreItem[];
  missing: string[];
  status: DataStatus;
}

const n1 = (x: number) => Math.round(x * 10) / 10;
const pct1 = (x: number) => `${n1(x * 100)}%`;
const signed = (x: number) => `${x > 0 ? "+" : ""}${x}`;
const isNum = (x: number | null | undefined): x is number => typeof x === "number" && !Number.isNaN(x);

/** 缺读数的分项：points=null + MISSING + 说明为什么不是 0 分 */
function missingItem(rule: string, label: string, raw: string, note: string): ScoreItem {
  return { rule, label, points: null, raw, status: "MISSING", note: `${note}（不是 0 分，也不是「中性」）` };
}

function hitItem(rule: string, band: Band, raw: string): ScoreItem {
  return {
    rule, label: band.label, points: band.points, raw, status: "DERIVED",
    note: [band.note, MARKET_RULE_PROVENANCE].filter(Boolean).join("｜"),
  };
}

/** 当日/盘中的时间戳文案：收盘值不写成盘中值，盘中值要标明会变（与 sentiment.live 同口径） */
function stampText(input: MarketInput): string {
  const when = input.live === null || input.live === undefined ? "" : input.live ? "，盘中实时（收盘前会变）" : "，收盘/休市值（非盘中实时）";
  return `${input.trade_date ?? "读数所属日未给出"}${when}`;
}
/**
 * 市场面逐条打分。8 个分项，每条各自可空：缺哪项只说哪项算不出，不因为一项缺就整面归零
 * （P7-① 的「缺哪天就只说哪天算不出」同一条纪律）。
 */
export function marketItems(input: MarketInput): ScoreItem[] {
  const items: ScoreItem[] = [];

  // M-BREADTH 涨跌家数占比
  if (!isNum(input.advancers) || !isNum(input.decliners)) {
    items.push(missingItem("M-BREADTH", "涨跌家数占比", `上涨=${input.advancers ?? "无"} / 下跌=${input.decliners ?? "无"}`, "涨跌家数有缺，本项不判定"));
  } else if (input.advancers + input.decliners === 0) {
    items.push(missingItem("M-BREADTH", "涨跌家数占比", `上涨 0 / 下跌 0${isNum(input.total) ? `（参与统计 ${input.total} 家全为平盘或停牌）` : ""}`, "上涨与下跌家数都是 0：占比无定义，本项不判定（把 0/0 当成 50% 或当成 0 分都是编）"));
  } else {
    const share = input.advancers / (input.advancers + input.decliners);
    const band = pickBand(MARKET_BREADTH_BANDS, share)!;
    items.push(hitItem("M-BREADTH", band, `上涨 ${input.advancers} 家 / 下跌 ${input.decliners} 家（占比 ${pct1(share)}）${isNum(input.total) ? `，参与统计 ${input.total} 家` : ""}`));
  }

  // M-MEDIAN 中位涨跌幅
  if (!isNum(input.median_pct)) {
    items.push(missingItem("M-MEDIAN", "全 A 中位涨跌幅", "中位涨跌幅缺失", "引擎本次没有给出中位数（全 A 快照无有效涨跌幅），本项不判定"));
  } else {
    items.push(hitItem("M-MEDIAN", pickBand(MARKET_MEDIAN_BANDS, input.median_pct)!, `全 A 中位涨跌幅 ${signed(n1(input.median_pct))}%`));
  }

  // M-INDEX 基准指数
  const idx = input.index ?? null;
  if (!idx || !isNum(idx.change_pct)) {
    items.push(missingItem("M-INDEX", "基准指数涨跌幅", `指数=${idx ? (idx.label ?? idx.symbol ?? "未命名") : "未给出"}`, idx ? "该指数本次无涨跌幅读数" : "调用方没有指定基准指数：本层不替它选一条（上证还是创业板会给出不一样的一句话）"));
  } else {
    const band = pickBand(MARKET_INDEX_BANDS, idx.change_pct)!;
    items.push(hitItem("M-INDEX", band, `${idx.label ?? idx.symbol ?? "未命名指数"}（${idx.symbol ?? "代码未给出"}）${signed(n1(idx.change_pct))}%`));
  }

  // M-LIMITNET 涨跌停净差：两侧都要有数
  if (!isNum(input.limit_up) || !isNum(input.limit_down)) {
    items.push(missingItem("M-LIMITNET", "涨停−跌停净差", `涨停=${input.limit_up ?? "无"} / 跌停=${input.limit_down ?? "无"}`, "涨跌停有一侧缺数就不判净差：单边读数减不出来时不给 0，避免把「没统计到」写成「没有涨跌停」"));
  } else {
    const net = input.limit_up - input.limit_down;
    items.push(hitItem("M-LIMITNET", pickBand(MARKET_LIMITNET_BANDS, net)!, `涨停 ${input.limit_up} 家 − 跌停 ${input.limit_down} 家 = 净差 ${signed(net)} 家`));
  }

  // M-BREAK 炸板率
  if (!isNum(input.break_rate)) {
    items.push(missingItem("M-BREAK", "炸板率", "炸板率无读数（引擎在当日触板数为 0 时返回 null）", "sentiment 里 breakRate 的 null 是「触板 0 家、比率无定义」，不是 0% 炸板；按 0% 计入会白送 +2 分"));
  } else if (input.break_rate < 0 || input.break_rate > 100) {
    items.push(missingItem("M-BREAK", "炸板率", `炸板率 ${n1(input.break_rate)}% 越出 0–100`, "越界读数一律不判定：脏数据不能变成一个分数"));
  } else {
    items.push(hitItem("M-BREAK", pickBand(MARKET_BREAK_BANDS, input.break_rate)!, `炸板率 ${n1(input.break_rate)}%`));
  }

  // M-MAINFLOW 主力净额
  if (!isNum(input.main_net_sum_yi)) {
    items.push(missingItem("M-MAINFLOW", "全 A 主力净额", "主力净额无可信读数", "sentiment 里的 mainNetSum 是 `?? 0` 累加，字段全缺时也是 0；调用方未确认口径时传 null，本项就不判定而不是判成「0 亿」"));
  } else {
    items.push(hitItem("M-MAINFLOW", pickBand(MARKET_MAFLOW_BANDS, input.main_net_sum_yi)!, `全 A 主力净额 ${signed(n1(input.main_net_sum_yi))} 亿`));
  }

  // M-RISK 风险等级（同源，见 MARKET_RISK_NOTE）
  const level = input.risk_level ?? null;
  if (level === null || !(level in MARKET_RISK_POINTS)) {
    items.push(missingItem("M-RISK", "市场风险等级", `风险等级=${level ?? "未给出"}`, level === null ? "引擎本次没有给出风险等级" : `风险等级「${level}」不在引擎的四档枚举里，本层不映射（宁可不判，也不新增一档）`));
  } else {
    items.push({
      rule: "M-RISK", label: `风险等级「${level}」`, points: MARKET_RISK_POINTS[level], raw: `sentiment 引擎自报风险等级「${level}」`,
      status: "DERIVED", note: `${MARKET_RISK_NOTE}｜${MARKET_RULE_PROVENANCE}`,
    });
  }

  // M-THEME 板块强度
  const th = input.themes ?? null;
  if (!th || !isNum(th.main_count)) {
    items.push(missingItem("M-THEME", "板块强度（主线）", `主线数量=${th?.main_count ?? "未给出"}`, "themes 引擎本次没有产出主线分组结果（未跑或上游无返回）：本项不判定，不给 0"));
  } else if (isNum(th.top_score) && th.top_score < 60 && th.main_count >= 3) {
    items.push(missingItem("M-THEME", "板块强度（主线）", `主线 ${th.main_count} 个，榜首综合分仅 ${n1(th.top_score)}`, "主线数量够但榜首强度不足 60：本层不解释成「强势」也不给 0，先登记为口径异常（themes 的 scoreTheme 是 0~100 综合分）"));
  } else {
    const band = pickBand(MARKET_THEME_BANDS, th.main_count)!;
    const strength = isNum(th.top_score) ? `，榜首综合分 ${n1(th.top_score)}` : "，榜首强度未给出（只按主线数量判定）";
    items.push(hitItem("M-THEME", band, `主线 ${th.main_count} 个${strength}`));
  }
  // 血缘：市场面的每个数字都是「某一天某一时刻」的快照读数，而 decision-core 的 sources[] 只覆盖概率面，
  // 所以日期/盘内外状态只能挂在 raw 上——decisionToText 会把 raw 打出来，页面与事后复看才有得对。
  const stamp = stampText(input);
  return items.map((i) => ({ ...i, raw: `${i.raw}｜读数所属日 ${stamp}` }));
}

/**
 * 归并成一个维度。求和口径与 P7-① 的技术面一致：只加可算分项，缺项写进 missing[]，
 * 整维度全缺 ⇒ score=null（由 buildDecision 把这一维从权重分母里剔除）。
 */
export function marketDimension(input: MarketInput): MarketDimensionResult {
  const items = marketItems(input);
  const counted = items.filter((i) => i.points !== null);
  const nulls = items.filter((i) => i.points === null);
  const missing = nulls.map((i) => `${i.label}：${i.raw}`);
  const stamp = stampText(input);
  if (!counted.length) {
    return {
      score: null, items, status: "MISSING",
      missing: [`市场面 ${items.length} 个分项本次全部算不出（读数所属日 ${stamp}）：整维度不计分、权重让给可算维度，本层不会用空分母凑出一个市场环境分`],
    };
  }
  if (nulls.length) missing.push(`有 ${nulls.length} 个市场面分项算不出，得分只按可算项求和（可能偏保守）`);
  // 没带日期的市场读数仍然参与计算（数字是真的），但「这是哪一天的市场」说不清就得降级并登记，
  // 不能让它以一条无日期却打了满分的市场面结论出现在页面上。
  const undated = !input.trade_date;
  if (undated) missing.push("本次市场面读数没有 trade_date：无法确认这些数字属于哪个交易日，整维度按降级处理（不是拒算，但不得当成当日事实引用）");
  return {
    score: counted.reduce((a, i) => a + (i.points as number), 0),
    items,
    missing,
    status: nulls.length || undated ? "DEGRADED" : "DERIVED",
  };
}

/** 直接喂给 buildDecision 的 external 入口（对齐 P7-① 的 ExternalDimension 契约，不做二次转换） */
export function marketExternal(input: MarketInput): ExternalDimension {
  const d = marketDimension(input);
  // bounds 只给 decision-core 做「可达区间」对账用，不参与打分；不带它的话内核会把市场面按不建模算，
  // 报出的区间比真实区间窄（P7-④ 接线时补上的这一格）。
  return { key: "market", score: d.score, rule_version: MARKET_RULE_VERSION, items: d.items, missing: d.missing, status: d.status, bounds: MARKET_EXTREMES };
}

/**
 * 本表的极值：每条规则各取自己能给的最高/最低分（同组互斥档不会同时命中）。
 * 用途有两个 —— ① 随 `marketExternal()` 的 `bounds` 交给 decision-core 的 `scoreBounds`，让
 * `Decision.attainable` 报出**四维真实**区间（默认权重下 −33.6 ~ +41）；② 自证上下限真有一组输入打得到
 * （CEILING/WEAK 两组读数在测试里就是干这件事的）。
 * 注意它是「这张表能给几分」的账面极值，不是「今天市场能差到哪」的预测。
 */
export const MARKET_EXTREMES: { min: number; max: number } = (() => {
  const groups: number[][] = [
    MARKET_BREADTH_BANDS.map((b) => b.points),
    MARKET_MEDIAN_BANDS.map((b) => b.points),
    MARKET_INDEX_BANDS.map((b) => b.points),
    MARKET_LIMITNET_BANDS.map((b) => b.points),
    MARKET_BREAK_BANDS.map((b) => b.points),
    MARKET_MAFLOW_BANDS.map((b) => b.points),
    Object.values(MARKET_RISK_POINTS),
    MARKET_THEME_BANDS.map((b) => b.points),
  ];
  return { max: groups.reduce((a, g) => a + Math.max(...g), 0), min: groups.reduce((a, g) => a + Math.min(...g), 0) };
})();
