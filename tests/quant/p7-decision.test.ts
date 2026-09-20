// P7-⑦ v3 统一决策层纯内核的单元测试（node --test 直跑，无 DB / 无网络 / 无时钟）。
//
// 这些测试钉住的是五件事，顺序即本层存在的理由：
// 1) 刻度：每一维先按**本维规则表极值**折算到 −100~+100，再按 40/30/20/10 加权（用户 2026-09-21 拍板）。
//    折算过程（raw_score / norm_score / bounds）必须留在输出里，页面那个加权分不等于任何一张表字面分之和；
// 2) 结论映射 = P7-⑦ 任务书六档，边界左闭右开，且六档在真实生效权重下全部可达（可达性自检）；
// 3) 缺数据 ≠ 0 分 ≠ 中性：缺读数 points=null，整维度算不出或**没带本维极值** ⇒ 不进分母 + 显式登记；
// 4) 新旧表并入：同一指标 ⇒ 新表计分、旧项 role="basis" 只作依据；新表没这个指标 ⇒ 旧项继续计分；
// 5) 输出不产出「可信度 xx%」，概率读数必须自带四要素（样本/区间/观察周期/来源）才进结论文本。
//
// —— 本文件在 P7-⑦ 跟着内核从 v1/v2 升到 v3，下列每条断言的改动都注明「为何改」，
//    没有删除任何一条测试意图（原 20 个测试点全部保留或拆得更细），改数字的地方都写着新旧刻度差在哪。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFLICT_PROBABILITY_MAX, CONFLICT_TECHNICAL_MIN, DECISION_PROTOCOL_VERSION, DEFAULT_WEIGHTS,
  DIMENSION_CLAMP, GRADE_BANDS, GRADE_MAPPING_VERSION, GRADE_ORDER, PROBABILITY_BOUNDS, PROBABILITY_MIN_SAMPLE,
  RETIRED_GRADE_BANDS, RULE_VERSIONS, SUPPLEMENT_MARKER, VOLUME_SHRINK_RATIO, VOLUME_SURGE_RATIO,
  buildDecision, clampRaw, decisionSections, decisionToText, detectConflict, gradeForScore,
  normalizedBounds, payoffPointsFor, probabilityDimension, probabilitySentence, samplePointsFor,
  scoreBounds, technicalDimension, technicalItems, winRatePointsFor,
  type Decision, type ProbabilityInput, type TechnicalInput,
} from "../../src/lib/quant/screener/decision-core.ts";
// P7-④ 接线后要拿两张规则表自己的版本号和极值来跟内核对账（依赖方向仍是 测试 → 两边，
// 决策内核不 import 规则表，所以这里就是防止两边各写一份数字的唯一一道闸）。
import { EVENT_EXTREMES, EVENT_LEGACY_EXTREMES, EVENT_LEVEL_MAJOR, EVENT_LEVEL_MINOR, EVENT_RULE_VERSION } from "../../src/lib/quant/screener/event-score-core.ts";
import { MARKET_EXTREMES, MARKET_EXTREMES_UNCLAMPED, MARKET_LEGACY_RULE_VERSION, MARKET_RULE_VERSION } from "../../src/lib/quant/screener/market-score-core.ts";

const fullTech: TechnicalInput = {
  ma5: 12, ma10: 11, ma20: 10, close: 12.5,
  dif: 0.4, dea: 0.2, dif_prev: 0.1, dea_prev: 0.15, bar: 0.4, bar_prev: 0.3,
  rsi: 62, rsi_period: 14,
};
// v2 时代的「技术面极值 55」不再成立：P7-⑦ 表五条计分档的账面极值是 ±58，任务书单维限制夹到 ±50。
// 折算刻度下这维的尺子就是 ±50 ⇒ 满额 58 分与 50 分都折成 +100（夹取本身有测试钉住）。
const TECH_MAX = 50;
/** fullTech 的期望字面分：多头排列 +15、金叉且 DIF>0 +15、RSI 62 → +8，量能与压力位两条没接读数 ⇒ 38 */
const TECH_FULL = 38;

/**
 * v3 起 primary_horizon **必传**（P7-⑦ 表按单周期给分，1/5/20 各打一遍等于把同一维权重放大三倍），
 * 所以 helper 默认按 1 日打分，需要别的周期时用第三个参数覆盖，而不是像 v2 那样随便换 horizon。
 */
function prob(readings: ProbabilityInput["readings"], engine: ProbabilityInput["engine"] = "similar_env", extra: Partial<ProbabilityInput> = {}): ProbabilityInput {
  return { engine, readings, primary_horizon: 1, ...extra };
}
const r1 = (win_rate: number | null, sample = 200): ProbabilityInput["readings"][number] =>
  ({ horizon: 1, win_rate, sample_size: sample, trade_date: "2026-09-19", period: { start: "2024-08-06", end: "2026-08-20" } });
/** 带真实盈亏比的读数（P7-⑦ #104 扩的读数；v2 的概率面根本没有这一档） */
const r1p = (win_rate: number | null, payoff_ratio: number | null, sample = 200): ProbabilityInput["readings"][number] =>
  ({ ...r1(win_rate, sample), payoff_ratio, avg_win: 2.4, avg_loss: payoff_ratio === null ? null : -2.4 / payoff_ratio, win_samples: 120, loss_samples: 80 });

const ext = (opts: { bounds?: boolean; score?: number | null } = {}) => {
  const b = opts.bounds !== false;
  return [
    { key: "market" as const, score: opts.score ?? 0, rule_version: MARKET_RULE_VERSION, status: "DERIVED" as const, ...(b ? { bounds: MARKET_EXTREMES } : {}) },
    { key: "event" as const, score: opts.score ?? 0, rule_version: EVENT_RULE_VERSION, status: "AI_INTERPRETATION" as const, ...(b ? { bounds: EVENT_EXTREMES } : {}) },
  ];
};
const fourDim = (probability: ProbabilityInput): Decision => buildDecision({ technical: fullTech, probability, external: ext() });

/* ------------------------------------------------ 概率面：三张表的边界（任务书 P7-⑦） */

// 为何改：v2 只有一张「按期限分档的 win_rate 表」（PROBABILITY_BANDS/probabilityPointsFor 已随新表删除），
// v3 的概率面是 样本量 / 上涨比例 / 盈亏比 三条独立档，于是三个查表函数各钉各的边界。
test("P7-⑦ 概率面三张表：边界只属于一档（左闭右开），盈亏比档线与越界读数各自自证", () => {
  assert.equal(winRatePointsFor(60), 20, "60 属于「≥60」这一档，不是 50–60 那档");
  assert.equal(winRatePointsFor(59.99), 10);
  assert.equal(winRatePointsFor(50), 10, "50 是任务书原文线：50–60 → +10");
  assert.equal(winRatePointsFor(49.99), 0);
  assert.equal(winRatePointsFor(40), 0, "40–50 是 0 分档（读数存在、按表归 0）");
  assert.equal(winRatePointsFor(39.99), -15, "跌破 40% 才是 −15");
  assert.equal(winRatePointsFor(100), 20, "100% 是合法读数，不能因为端点写 101 就掉出区间");
  assert.equal(winRatePointsFor(0), -15, "0% 有定义（一次都没涨），它落在最低档");

  assert.equal(samplePointsFor(300), 10);
  assert.equal(samplePointsFor(299.9), 5);
  assert.equal(samplePointsFor(100), 5, "100–300 左闭");
  assert.equal(samplePointsFor(99.9), 0, "任务书把 <100 写成 0 分，不是「算不出」");
  assert.equal(samplePointsFor(0), 0, "样本 0 次是引擎会给的读数：按表归 0 分，另由 <30 的降级线把整维度标 DEGRADED");

  assert.equal(payoffPointsFor(1.2), 10, "≥1.2 显著占优（数值线本层补，见 PAYOFF_BANDS 的 note）");
  assert.equal(payoffPointsFor(1.19), 0);
  assert.equal(payoffPointsFor(0.8), 0);
  assert.equal(payoffPointsFor(0.79), -10, "<0.8 = 下跌风险占优");
  assert.equal(payoffPointsFor(0), -10, "盈亏比 0 意味着平均盈利为 0：这是最低档，不是「无读数」");
});

test("P7-⑦ 概率面账面极值 +40/−25 且不对称：折算尺子如实反映「样本 <100 记 0 分」这条任务书规定", () => {
  assert.deepEqual(PROBABILITY_BOUNDS, { max: 40, min: -25 });
  assert.deepEqual(normalizedBounds(PROBABILITY_BOUNDS), { min: -62.5, max: 100 }, "同一把尺 max(|min|,|max|)=40 ⇒ 地板折成 −62.5，不夹平");
});

/* -------------------------------------------------- 缺失 ≠ 0 分（REAL_DATA_ONLY 的本层版本） */

test("P7-① win_rate 用 0–100 量纲：null 与越界读数一律不判定，而不是当 0%", () => {
  assert.equal(winRatePointsFor(null), null);
  assert.equal(winRatePointsFor(-1), null, "越界读数若被判成 −15 分，就是把脏数据变成了结论");
  assert.equal(winRatePointsFor(101), null);
  assert.equal(payoffPointsFor(null), null, "没有亏损样本 ⇒ 比值无定义，绝不能读成 0（那等于「下跌风险占优」）");
  assert.equal(payoffPointsFor(-0.5), null);
  assert.equal(samplePointsFor(null), null);
  const d = probabilityDimension(prob([r1(null)]));
  assert.equal(d.score, 5, "样本 200 有读数 ⇒ +5，上涨概率与盈亏比算不出 ⇒ 得分只按可算项求和（偏保守，登记在案）");
  assert.equal(d.items.find((i) => i.rule === "P-WINRATE")!.points, null);
  assert.match(d.items.find((i) => i.rule === "P-WINRATE")!.note ?? "", /不是 0%/, "缺读数分项要明说它不等于 0%");
  assert.match(d.missing.join(" / "), /1 日：本次没有可用的上涨概率读数（引擎自报算不出）/);
  assert.deepEqual(d.bounds, PROBABILITY_BOUNDS, "有部分读数 ⇒ 尺子仍然带着；整维度算不出时才交 null");
  const nothing = probabilityDimension(prob([{ ...r1(null), sample_size: null as unknown as number }]));
  assert.equal(nothing.score, null, "三条档全部算不出 ⇒ 整维度不进分母");
  assert.equal(nothing.bounds, null, "整维度不计分时尺子交 null，buildDecision 会按未计入处理");
});

// 为何新增：任务书说「无可用事件数据时 event_score=null」，而概率面同样有「一条都算不出」的时刻；
// v3 的 P-PAYOFF 多了「字段缺失(undefined) vs 引擎给 null」两种不同的算不出，必须分别登记。
test("P7-⑦ 盈亏比：字段缺失(undefined) 与 引擎给 null 是两条不同的话，都不按 0 计", () => {
  const noField = probabilityDimension(prob([{ ...r1(60), payoff_ratio: undefined }]));
  assert.match(noField.items.find((i) => i.rule === "P-PAYOFF")!.note ?? "", /没有 payoff_ratio 字段/);
  const engineNull = probabilityDimension(prob([r1p(60, null)]));
  assert.match(engineNull.items.find((i) => i.rule === "P-PAYOFF")!.note ?? "", /一次都没亏过|无定义/);
  for (const d of [noField, engineNull]) {
    assert.equal(d.items.find((i) => i.rule === "P-PAYOFF")!.points, null);
    assert.ok(d.score !== null, "另外两条有读数 ⇒ 这一维仍可打分，但缺口登记在案");
    assert.equal(d.status, "DERIVED", "分项级缺失不降级整维度（降级线只管样本量）");
    assert.match(d.missing.join(" / "), /盈亏比本次算不出/);
  }
});

test("P7-① 样本不足：历史频率仍有值，但整维度降级 DEGRADED（引擎的 sample_ok 就是 false）", () => {
  const d = probabilityDimension(prob([r1p(60, 1.5, 12)]));
  assert.equal(d.status, "DEGRADED");
  assert.match(d.items.find((i) => i.rule === "P-SAMPLE")!.note ?? "", new RegExp(`样本 12 < ${PROBABILITY_MIN_SAMPLE}`));
  assert.equal(d.items.find((i) => i.rule === "P-SAMPLE")!.points, 0, "样本 <100 是任务书的 0 分档，降级只改 status 不改分数");
  assert.equal(probabilityDimension(prob([r1p(60, 1.5, 30)])).status, "DERIVED", "刚好到线下限不再降级");
});

test("P7-① 概率口径冲突要拒绝，而不是平均：多份读数、同期限两条都不给分", () => {
  const mixed = buildDecision({
    technical: fullTech,
    probability: [prob([r1(60)], "similar_env"), prob([{ ...r1(40), horizon: 5 }], "conditional", { conditions: ["RPS>90"] })],
  });
  assert.deepEqual(mixed.included, ["technical"], "两份引擎的读数不得混算");
  assert.match(mixed.dimensions.find((x) => x.key === "probability")!.missing[0], /不能相加也不能平均/);
  const dup = probabilityDimension(prob([r1(60), { ...r1(20), horizon: 1 }]));
  assert.equal(dup.score, null);
  assert.match(dup.missing[0], /同一期限|条读数/);
});

// 为何新增：primary_horizon 从 v2 的「按期限各算一次」改成 v3 的「必传单周期」，
// 这条纪律只能由测试钉住 —— 漏传的后果是同一维权重被算三遍，页面看不出来。
test("P7-⑦ primary_horizon 必传：没声明就不打分，声明了但读数里没有这一档也不拿别的周期顶上", () => {
  const noPh = probabilityDimension({ engine: "similar_env", readings: [r1(60), { ...r1(55), horizon: 5 }, { ...r1(52), horizon: 20 }] });
  assert.equal(noPh.score, null);
  assert.match(noPh.missing[0], /没有声明 primary_horizon/);
  assert.match(noPh.missing[0], /不替调用方挑一个周期/);
  assert.equal(noPh.bounds, null, "整维度不计分时连尺子都不交出去 ⇒ buildDecision 会把它按未计入处理");

  const mismatch = probabilityDimension(prob([r1(60)], "similar_env", { primary_horizon: 5 }));
  assert.equal(mismatch.score, null);
  assert.match(mismatch.missing[0], /primary_horizon=5 日，但本次读数里没有这一档/);
  assert.match(mismatch.missing[0], /不拿别的周期顶上/);
  assert.equal(mismatch.primary_horizon, 5);

  const d = fourDim(prob([r1(60), { ...r1(55), horizon: 5 }, { ...r1(52), horizon: 20 }]));
  const dim = d.dimensions.find((x) => x.key === "probability")!;
  assert.equal(dim.score, 25, "只按 1 日那一条给分：样本 +5、上涨比例 +20、盈亏比算不出 ⇒ 25");
  assert.deepEqual(dim.items.filter((i) => i.role === "basis").map((i) => i.rule), ["P-5D", "P-20D"], "非主周期转 basis：看得到，不再计权");
});

test("P7-① 条件概率少了筛选条件就不承认它是「上涨概率」", () => {
  const d = probabilityDimension(prob([r1p(60, 1.5)], "conditional"));
  assert.ok(d.score !== null, "有样本有读数仍算得出分档，但缺口必须登记");
  assert.match(d.missing.join(" / "), /没有给出筛选条件/);
  assert.match(d.missing.join(" / "), /无条件时它自己就返回 null/);
  const withCond = probabilityDimension(prob([r1p(60, 1.5)], "conditional", { conditions: ["板块 RPS>90 且主力净流入>0"] }));
  assert.deepEqual(withCond.missing, [], "条件写清楚后这条缺口消失");
});

/* ---------------------------------------------------------- 技术面（P7-⑦ 五条 + 旧项 basis） */

test("P7-① 技术面：缺哪天就只说哪天算不出，不沿用因子面板「缺数据返回 0」的写法", () => {
  const noPrev: TechnicalInput = { ...fullTech, dif_prev: null, dea_prev: null };
  const items = technicalItems(noPrev);
  const cross = items.find((i) => i.rule === "T-MACD-CROSS")!;
  assert.equal(cross.points, null, "fields.ts 的 crossUp 在缺前一天时返回 0（=没有金叉），本层必须给 null");
  assert.match(cross.note ?? "", /crossUp/);
  assert.equal(items.find((i) => i.rule === "T-MA-STRUCT")!.points, 15, "其余项照算，不因为一项缺就整面归零"); // v2 的 20 分档已换成新表的 +15
  const nulls = technicalItems(noPrev).filter((i) => i.points === null).map((i) => i.rule);
  // 为何改：v2 的 nulls 只有金叉 + 成交量（当时没规则）；v3 多了「压力位」这一条同样没接读数，
  // 而 T-MA-BREAK / T-MACD-ZERO 已降级 basis，不再出现在计分项里。
  assert.deepEqual(nulls, ["T-MACD-CROSS", "T-VOLUME", "T-BREAKOUT"], "缺前一天 ⇒ 金叉不判定；量能与压力位本层没供读数 ⇒ 同样不判定");
});

// 为何新增：v2 的 T-VOLUME 是「任务书没规则所以不计分」，v3 有规则了 —— 那么「有读数怎么判、没读数怎么判」
// 就成了新的必测项，尤其是「下跌缩量」这种任务书没写、本层取 0 的组合。
test("P7-⑦ 量能配合与压力突破：有读数才判定，任务书没写的组合取 0 并登记为补充口径", () => {
  const up = technicalItems({ ...fullTech, close_prev: 12, volume: 2000, volume_avg: 1000, volume_window: 20 });
  assert.equal(up.find((i) => i.rule === "T-VOLUME")!.points, 10, "上涨 + 2 倍均量 ⇒ 放量 +10");
  assert.match(up.find((i) => i.rule === "T-VOLUME")!.note ?? "", new RegExp(`放量线 ${VOLUME_SURGE_RATIO} 倍.*${SUPPLEMENT_MARKER}`));
  const shrink = technicalItems({ ...fullTech, close_prev: 12, volume: 500, volume_avg: 1000 });
  assert.equal(shrink.find((i) => i.rule === "T-VOLUME")!.points, 3, "上涨缩量 +3（任务书原文）");
  assert.match(shrink.find((i) => i.rule === "T-VOLUME")!.note ?? "", new RegExp(`缩量线 ${VOLUME_SHRINK_RATIO} 倍`));
  const downSurge = technicalItems({ ...fullTech, close_prev: 13, volume: 2000, volume_avg: 1000 });
  assert.equal(downSurge.find((i) => i.rule === "T-VOLUME")!.points, -10, "下跌放量 −10");
  const downShrink = technicalItems({ ...fullTech, close_prev: 13, volume: 500, volume_avg: 1000 });
  assert.equal(downShrink.find((i) => i.rule === "T-VOLUME")!.points, 0, "下跌缩量任务书没写 ⇒ 取 0，不猜成「惜售看多」也不猜成「无量看空」");
  assert.match(downShrink.find((i) => i.rule === "T-VOLUME")!.note ?? "", /本层补充/);
  const noAvg = technicalItems({ ...fullTech, close_prev: 12, volume: 2000, volume_avg: 0 });
  assert.equal(noAvg.find((i) => i.rule === "T-VOLUME")!.points, null, "均量为 0 时比值无定义：这是算不出，不是 −∞ 倍缩量");

  const broke = technicalItems({ ...fullTech, high: 13.2, prior_high_20: 12, prior_high_window: 20 });
  assert.equal(broke.find((i) => i.rule === "T-BREAKOUT")!.points, 10, "收盘 12.5 站上 20 日最高 12 ⇒ 有效突破 +10");
  const failed = technicalItems({ ...fullTech, high: 12.8, prior_high_20: 12.6, close: 12.5 });
  assert.equal(failed.find((i) => i.rule === "T-BREAKOUT")!.points, -10, "盘中触及、收盘回落 ⇒ 突破失败 −10");
  const untouched = technicalItems({ ...fullTech, high: 12.2, prior_high_20: 12.6 });
  assert.equal(untouched.find((i) => i.rule === "T-BREAKOUT")!.points, 0, "没碰压力位：任务书两档都不适用，本层取 0");
  const shortWin = technicalItems({ ...fullTech, high: 13.2, prior_high_20: 12, prior_high_window: 5 });
  assert.match(shortWin.find((i) => i.rule === "T-BREAKOUT")!.raw, /压力位窗口只有 5 天/, "历史不足 20 根时要说明它是 5 日压力而不是 20 日压力");
});

test("P7-① 均线结构档位互斥：新表按排列给分，跌破 MA20 已并进结构/突破两项", () => {
  const items = technicalItems({ ...fullTech, close: 9.5 });
  assert.equal(items.find((i) => i.rule === "T-MA-STRUCT")!.points, 15);
  const brk = items.find((i) => i.rule === "T-MA-BREAK")!;
  // 为何改：v2 里 T-MA-BREAK 是计分项 −15；v3 它降级成 basis —— 读数照给，点数不进求和。
  assert.equal(brk.role, "basis");
  assert.equal(brk.points, -15, "旧表字面分保留着，页面要能看到它在自己那张表里值几分");
  assert.equal(brk.rule_version, "p7.taskbook.s6");
  const bear = technicalItems({ ...fullTech, ma5: 9, ma10: 10, ma20: 11 });
  assert.equal(bear.find((i) => i.rule === "T-MA-STRUCT")!.points, -15, "空头排列 −15");
  const mid = technicalItems({ ...fullTech, ma5: 12, ma10: 9.5, ma20: 10 });
  assert.equal(mid.find((i) => i.rule === "T-MA-STRUCT")!.points, 8, "MA5>MA20 但 MA10 不在两者之间 ⇒ 短期震荡 +8");
  const sticky = technicalItems({ ...fullTech, ma5: 12, ma10: 12.02, ma20: 12.04 });
  assert.equal(sticky.find((i) => i.rule === "T-MA-STRUCT")!.points, 0, "三线相对差 ≤0.5% ⇒ 粘合档 0 分");
  assert.match(sticky.find((i) => i.rule === "T-MA-STRUCT")!.note ?? "", /带宽.*本层补/);
  const allNull = technicalItems({ ma5: null, ma10: null, ma20: null, close: null, dif: null, dea: null, dif_prev: null, dea_prev: null, bar: null, bar_prev: null, rsi: null });
  assert.ok(allNull.filter((i) => i.role !== "basis").every((i) => i.points === null), "全缺 ⇒ 没有任何计分项给分");
  const d = buildDecision({ technical: { ma5: null, ma10: null, ma20: null, close: null, dif: null, dea: null, dif_prev: null, dea_prev: null, bar: null, bar_prev: null, rsi: null } });
  assert.equal(d.final_score, null);
  assert.equal(d.grade, null);
  assert.match(d.statement, /算不出/);
});

test("P7-① 成交量与 MACD 跨零轴：任务书没写规则的项不补规则，只登记未计入（v3：跨零轴已是 basis）", () => {
  const items = technicalItems(fullTech);
  const vol = items.find((i) => i.rule === "T-VOLUME")!;
  assert.equal(vol.points, null);
  assert.match(vol.note ?? "", /取不出|不判定/);
  const zero = technicalItems({ ...fullTech, dif: 0.4, dea: -0.2 }).find((i) => i.rule === "T-MACD-ZERO")!;
  assert.equal(zero.role, "basis", "v2 里它计分 0，v3 并进「金叉且 DIF>0」⇒ 只作依据");
  assert.equal(zero.points, 0, "一上一下仍是 0：旧表当时的补充口径，现在不重复计权");
  assert.match(zero.label, /跨零轴/, "评审 §一·规格 B 第 3 条要求文案里点明这是跨零轴状态");
  assert.match(zero.note ?? "", /不重复计分/);
  const rsiGap = technicalItems({ ...fullTech, rsi: 72 }).find((i) => i.rule === "T-RSI")!;
  // 为何改：v2 的表把 70–75 写成「保守取 −5」；P7-⑦ 表只写到 55–70 +8，>70 整段未定义 ⇒
  // 本层取 0（既不沿用旧表的超买扣分，也不给强势分），比 v2 更不猜。
  assert.equal(rsiGap.points, 0, "RSI>70 在新表里没有档位：取 0 而不是猜一个符号");
  assert.match(rsiGap.note ?? "", /没有档位|空洞|未定义/);
  assert.match(rsiGap.note ?? "", new RegExp(SUPPLEMENT_MARKER));
  assert.equal(technicalItems({ ...fullTech, rsi: 62 }).find((i) => i.rule === "T-RSI")!.points, 8, "55–70 是任务书原文的 +8 档");
  assert.ok(!(technicalItems({ ...fullTech, rsi: 62 }).find((i) => i.rule === "T-RSI")!.note ?? "").includes(SUPPLEMENT_MARKER), "任务书本来就有定义的档位不得被打上补充标记");
  assert.ok(technicalItems({ ...fullTech, rsi: 101 }).find((i) => i.rule === "T-RSI")!.points === null, "越界 RSI 不判定");
});

test("P7-⑦ 同维度两代表：计分项只出 p7.s7.*，旧项各自带着 p7.taskbook.s6，出处不许糊", () => {
  const items = technicalItems(fullTech);
  assert.deepEqual([...new Set(items.filter((i) => i.role !== "basis").map((i) => i.rule_version))], ["p7.s7.technical.v1"]);
  assert.deepEqual([...new Set(items.filter((i) => i.role === "basis").map((i) => i.rule_version))], ["p7.taskbook.s6"]);
  const d = technicalDimension(fullTech);
  assert.equal(d.raw, TECH_FULL, "15 + 15 + 8（量能与压力位缺读数不计 0）");
  assert.equal(d.status, "DEGRADED", "有计分项算不出 ⇒ 降级，但仍按可算项给分");
  assert.match(d.missing.join(" / "), /T-VOLUME、T-BREAKOUT/);
  assert.match(d.missing.join(" / "), /未重复计分（T-MA-BREAK=0、T-MACD-ZERO=\+10）/, "basis 项的读数要照常报出来");
});

/* -------------------------------------------------------------- 折算、夹取与可达性（#106） */

test("P7-⑦ 维度归一：字面分、折算分、尺子三样都在输出里，页面那个数可由它们复算", () => {
  const d = buildDecision({ technical: fullTech });
  const dim = d.dimensions.find((x) => x.key === "technical")!;
  assert.equal(dim.score, TECH_FULL);
  assert.equal(dim.raw_score, TECH_FULL, "raw_score 是 score 的同名副本，语义是「折算前」");
  assert.deepEqual(dim.bounds, { min: -TECH_MAX, max: TECH_MAX });
  assert.equal(dim.norm_score, 76, "38 / 50 × 100 = 76");
  assert.equal(d.final_score, 76, "只剩一维 ⇒ 它独占权重，综合分就是它的折算分");
  assert.equal(d.grade, "偏强看多", "v2 里 38 分会落在「偏强震荡」，v3 折算刻度下同一份读数是「偏强看多」：刻度不同不是打分变松，是量纲变了");
  assert.match(d.basis, /页面显示的加权分不等于任何一张表字面分之和/);
  assert.equal(normalizedBounds({ min: -50, max: 50 })!.max, 100);
  assert.equal(buildDecision({ technical: fullTech, probability: prob([r1p(60, 1.5, 400)]) }).dimensions.find((x) => x.key === "probability")!.norm_score, 100,
    "40 / 40 × 100：样本 ≥300 +10、上涨比例 ≥60% +20、盈亏比 ≥1.2 +10 ⇒ 满额折到 +100");
});

// 为何新增：±50 的单维限制是任务书写死的，但账面极值 ±58 —— 不夹就会越过尺子上限，
// 夹了不登记就等于悄悄改分。两条都要钉。
test("P7-⑦ 单维 ±50 夹取：夹前夹后都要登记，且夹取只发生在任务书明写的两维", () => {
  assert.deepEqual(clampRaw("technical", 58), { value: 50, clampedFrom: 58 });
  assert.deepEqual(clampRaw("technical", -58), { value: -50, clampedFrom: -58 });
  assert.deepEqual(clampRaw("technical", 49), { value: 49, clampedFrom: null });
  assert.deepEqual(clampRaw("event", 58), { value: 58, clampedFrom: null }, "事件面/概率面任务书没给单维限制 ⇒ 不替它们补一条");
  assert.deepEqual(DIMENSION_CLAMP, { technical: 50, market: 50 });
  assert.deepEqual(TECH_MAX_LIMITS(), { min: -58, max: 58 }, "账面极值真的能越线，夹取不是纸面动作");
  const maxed = buildDecision({
    technical: { ma5: 12, ma10: 11, ma20: 10, close: 12.5, dif: 0.4, dea: 0.2, dif_prev: 0.1, dea_prev: 0.15, bar: 0.4, bar_prev: 0.3, rsi: 62, close_prev: 12, volume: 2000, volume_avg: 1000, high: 13.2, prior_high_20: 12 },
    probability: prob([{ ...r1(60), payoff_ratio: null }]),
  });
  const tech = maxed.dimensions.find((x) => x.key === "technical")!;
  assert.equal(tech.score, 50, "15+15+10+10+8=58 ⇒ 夹到 50");
  assert.equal(tech.norm_score, 100);
  assert.match(tech.missing.join(" / "), /字面分 \+58 超出单维限制 ±50，按 \+50 计入/);
  assert.match(tech.missing.join(" / "), /夹取是任务书的规定/, "夹取要留痕，不能只留一个 50");
});
/** TECHNICAL_BOUNDS 的未夹取极值（导出常量，这里只做本地断言用） */
function TECH_MAX_LIMITS() {
  const groups: number[][] = [[15, 8, 0, -15], [15, 8, 0, -15], [10, 3, 0, -10], [10, 0, -10], [8, 0, -8]];
  return { min: groups.reduce((a, g) => a + Math.min(...g), 0), max: groups.reduce((a, g) => a + Math.max(...g), 0) };
}

test("P7-⑦ 可达区间：四维齐全 −88.75~+100，六档全部可达；少一维就换一个区间，且明写区间随参与维度数变", () => {
  assert.deepEqual(MARKET_EXTREMES, { min: -50, max: 50 }, "市场面账面 ±60/−57，任务书单维限制夹到 ±50");
  assert.deepEqual(MARKET_EXTREMES_UNCLAMPED, { min: -57, max: 60 });
  assert.deepEqual(EVENT_EXTREMES, { min: -20, max: 20 }, "v3 尺子跟**计分项**同步：EV-LEVEL 五档 ±20");
  assert.deepEqual(EVENT_LEGACY_EXTREMES, { min: -25, max: 25 }, "旧表账面 ±25 只留作对账，不再充当尺子");
  const four = scoreBounds(DEFAULT_WEIGHTS, { market: MARKET_EXTREMES, event: EVENT_EXTREMES });
  assert.deepEqual(four, { min: -88.75, max: 100, unreachable_grades: [] });
  const d = buildDecision({ technical: fullTech, probability: prob([r1p(60, 1.5)]), external: ext() });
  assert.deepEqual(d.included, ["technical", "probability", "market", "event"], "四维都带 rule_version + bounds ⇒ 不重归一");
  assert.equal(d.weights.renormalized, false);
  assert.deepEqual(d.attainable, four, "结论卡上印的区间就是这一组");
  // 只技术+概率（两维重归一到 4/7 与 3/7）：−100×0.5714 − 62.5×0.4286 = −83.93（区间端点按 n2 取两位小数）
  const two = buildDecision({ technical: fullTech, probability: prob([r1p(60, 1.5)]) });
  assert.deepEqual(two.attainable, { min: -83.93, max: 100, unreachable_grades: [] });
  assert.equal(two.weights.applied.technical, 0.5714);
  assert.equal(two.weights.applied.probability, 0.4286);
  const one = buildDecision({ technical: fullTech });
  assert.deepEqual(one.attainable, { min: -100, max: 100, unreachable_grades: [] }, "只剩一维 ⇒ 它独占权重，区间就是它的折算区间");
  const probOnly = buildDecision({ probability: prob([r1p(60, 1.5)]) });
  assert.deepEqual(probOnly.attainable, { min: -62.5, max: 100, unreachable_grades: [] }, "概率面的地板由它的尺子决定，不到 −100");
  // 穷举 buildDecision 真正可能产出的生效权重组合（都按「四维都声明了极值」算，与真实接线一致）
  for (const w of [DEFAULT_WEIGHTS, { technical: 1, probability: 0, market: 0, event: 0 }, { technical: 0, probability: 1, market: 0, event: 0 }, { technical: 0.5714, probability: 0.4286, market: 0, event: 0 }]) {
    const withExt = scoreBounds(w, { market: MARKET_EXTREMES, event: EVENT_EXTREMES });
    assert.deepEqual(withExt.unreachable_grades, [], `组合 ${JSON.stringify(w)} 区间 ${withExt.min}~${withExt.max} 仍有死档 ⇒ 六档全部可达的承诺被破坏`);
  }
  // 反过来钉住「极值必须与表同步」：市场/事件两维没声明极值时它们就不进区间，上限掉到 70 ⇒ 强势看多成为死档。
  // 有人改了 EXTREMES 或漏传 bounds 时，这条会立刻说出来，而不是让页面悄悄少一档。
  assert.deepEqual(scoreBounds(DEFAULT_WEIGHTS), { min: -58.75, max: 70, unreachable_grades: ["强势看多"] },
    "0.4×100 + 0.3×100 = 70：两维未声明极值 ⇒ 区间按参与维度算，强势看多(≥80) 变成死档（buildDecision 会在 basis 里登记这件事）");
  assert.match(buildDecision({ technical: fullTech }).basis, /六档全部可达/, "可达性结论要出现在默认视图的口径行里");
});

/* ------------------------------------------------ 结论映射：P7-⑦ 六档（用户拍板保留原阈值） */

test("P7-⑦ 结论映射六档：阈值原样保留、左闭右开，旧五档 A1.1 只留在 RETIRED_GRADE_BANDS 里", () => {
  assert.deepEqual(GRADE_ORDER, ["强势看多", "偏强看多", "震荡偏强", "中性震荡", "偏弱", "弱势看空"]);
  assert.equal(gradeForScore(80), "强势看多", "+80 是上限档下限（左闭）");
  assert.equal(gradeForScore(79.9), "偏强看多");
  assert.equal(gradeForScore(50), "偏强看多");
  assert.equal(gradeForScore(49.9), "震荡偏强");
  assert.equal(gradeForScore(20), "震荡偏强");
  assert.equal(gradeForScore(19.9), "中性震荡");
  assert.equal(gradeForScore(-20), "中性震荡", "中性档 −20~+20 左闭 ⇒ −20 归中性，不是偏弱");
  assert.equal(gradeForScore(-20.1), "偏弱");
  assert.equal(gradeForScore(-50), "偏弱", "偏弱档 −50~−20 左闭 ⇒ −50 仍属偏弱");
  assert.equal(gradeForScore(-50.1), "弱势看空");
  assert.deepEqual(GRADE_BANDS, {
    强势看多: { min: 80, max: null }, 偏强看多: { min: 50, max: 80 }, 震荡偏强: { min: 20, max: 50 },
    中性震荡: { min: -20, max: 20 }, 偏弱: { min: -50, max: -20 }, 弱势看空: { min: -Infinity, max: -50 },
  }, "映射表就是任务书这一版，任何后续调整都要经用户拍板");
  assert.equal(GRADE_MAPPING_VERSION, "p7.s7.six.v1");
  assert.match(buildDecision({ technical: fullTech }).basis, /映射阈值 p7\.s7\.six\.v1（左闭右开）：强势看多 \[80,∞\)/, "口径行里要能看到阈值出处");
  assert.match(buildDecision({ technical: fullTech }).basis, /弱势看空 \[-∞,-50\)/, "无穷端点印成 ∞，不丢 -Infinity 给用户");
  // v2 的五档不得再影响打分，但也不能被悄悄删掉：它留在留档里。
  assert.deepEqual(Object.keys(RETIRED_GRADE_BANDS), ["p7.review.s1.A1.1"]);
  assert.deepEqual(RETIRED_GRADE_BANDS["p7.review.s1.A1.1"].bands["看涨"], { min: 30, max: null });
  for (const g of Object.values(GRADE_BANDS)) {
    assert.ok(![30, 5, -30].includes(g.min as number) || g.min === undefined, "旧 A1.1 的 30/5/−30 不得出现在六档里");
  }
});

/* ------------------------------- 外部维度：rule_version 与 bounds 都是参与加权的前提（硬规则 4） */

test("P7-① 外部维度必须自带规则版本才承认，否则同样是未计入（不给 0 分）", () => {
  const noRule = buildDecision({ technical: fullTech, external: [{ key: "market", score: null, rule_version: "" }] });
  assert.deepEqual(noRule.excluded.map((e) => e.key).sort(), ["event", "market", "probability"], "rule_version 传空串等同于没带规则 ⇒ 仍然未计入（P7-③ 补表之后这条纪律一字未改）");
  assert.match(noRule.excluded.find((e) => e.key === "market")!.reason, /没有传入打分结果/, "未计入的理由是「本次没传读数」，不是「没有这张表」");
  // 为何改：内核登记的现行版本从 p7.s3.* 升到 p7.s7.*（新表为主），旧表版本改由分项自己带着。
  assert.match(noRule.excluded.find((e) => e.key === "market")!.reason, /p7\.s7\.market\.v1/, "未计入的说明要把现行规则表版本一起报出来");
  assert.equal(noRule.dimensions.find((x) => x.key === "market")!.rule_version, null, "内核有版本 ≠ 本次有读数：没传进来仍是 null");
  const withRule = buildDecision({
    technical: fullTech,
    external: [{ key: "market", score: 10, rule_version: "p7.market.v0-draft", status: "DERIVED", bounds: { min: -50, max: 50 } }],
  });
  assert.deepEqual(withRule.included, ["technical", "market"]);
  assert.equal(withRule.dimensions.find((x) => x.key === "market")!.rule_version, "p7.market.v0-draft");
  assert.equal(withRule.dimensions.find((x) => x.key === "market")!.norm_score, 20, "10/50×100：外部维度同样走折算，不再按字面分加权");
  assert.ok((withRule.final_score as number) < 100, "市场面参与后必须稀释技术面，说明它真进了加权");
  const drift = withRule.dimensions.find((x) => x.key === "market")!.missing.join(" / ");
  assert.match(drift, /p7\.market\.v0-draft/, "缺口里要点名是哪份版本传进来了");
  assert.match(drift, /p7\.s7\.market\.v1/);
  assert.match(drift, /不一致/);
});

// 为何新增：v3 与 v2 在 bounds 上语义相反（v2 只影响可达区间、不影响打分；v3 是折算的前提）。
// 这条测试就是那处「与 v2 相反」的唯一防回归闸。
test("P7-⑦ 硬规则 4：字面分算得出来但没带本维极值 ⇒ 这一维不参与加权，且字面分照实展示", () => {
  const blind = buildDecision({ technical: fullTech, probability: prob([r1p(60, 1.5)]), external: ext({ bounds: false }) });
  assert.deepEqual(blind.excluded.map((e) => e.key).sort(), ["event", "market"]);
  assert.equal(blind.dimensions.find((x) => x.key === "market")!.score, 0, "字面分不撒谎：它仍然是这张表算出来的 0");
  assert.equal(blind.dimensions.find((x) => x.key === "market")!.norm_score, null);
  assert.match(blind.dimensions.find((x) => x.key === "market")!.excluded_reason ?? "", /没带本维极值 bounds ⇒ 无法折算到 ±100 ⇒ 本次不参与加权/);
  assert.match(blind.dimensions.find((x) => x.key === "market")!.excluded_reason ?? "", /本层不猜一个极值把区间撑宽/);
  assert.match(blind.basis, /有字面分但没带本维极值/, "口径行里也要登记，否则读的人以为这是四维结论");
  const wired = buildDecision({ technical: fullTech, probability: prob([r1p(60, 1.5)]), external: ext() });
  assert.notEqual(blind.final_score, wired.final_score, "带不带 bounds 会改变加权：这正是 v3 与 v2 相反的地方");
  assert.equal(blind.final_score, 80.9, "只剩技术+概率 ⇒ 76×0.5714 + 87.5×0.4286 = 80.9：没带尺子的两维整个从分母里拿掉，不是按 0 分平均");
  assert.equal(wired.final_score, 56.7, "同样两份读数，四维齐全时 76×0.4 + 87.5×0.3 + 0×0.2 + 0×0.1 = 56.7：两个 0 分维度把结论拉向中性");
  assert.deepEqual(blind.attainable, { min: -83.93, max: 100, unreachable_grades: [] }, "未计入的维度不进区间");
  const badBounds = buildDecision({ technical: fullTech, external: [{ key: "market", score: 10, rule_version: MARKET_RULE_VERSION, bounds: { min: 0, max: 0 } }] });
  assert.match(badBounds.dimensions.find((x) => x.key === "market")!.excluded_reason ?? "", /无法折算/, "极值写成 0~0 也是「没有尺子」，不能折算成 ±∞");
});

test("P7-① 缺规则的维度不进分母，权重按剩余维度重归一（且明写重归一成了什么）", () => {
  const d = buildDecision({ technical: fullTech, probability: prob([{ ...r1(60), horizon: 1 }], "similar_env", { primary_horizon: 1 }) });
  assert.deepEqual(d.included, ["technical", "probability"]);
  assert.deepEqual(d.excluded.map((e) => e.key).sort(), ["event", "market"]);
  assert.equal(d.weights.applied.technical, 0.5714, "生效权重取四位小数，页面按 n/100 显示，不做浮点等值断言");
  assert.equal(d.weights.applied.probability, 0.4286);
  assert.ok(Math.abs(d.weights.applied.technical + d.weights.applied.probability - 1) < 1e-9, "生效权重必须自和为 1，否则得分量纲会随缺失维度漂移");
  assert.equal(d.weights.renormalized, true);
  // 技术 38→折算 76、概率 25→折算 62.5 ⇒ 76×0.5714 + 62.5×0.4286 = 70.2
  assert.equal(d.final_score, 70.2);
  assert.match(d.basis, /重归一为 技术结构 0\.5714、历史概率 0\.4286/);
  assert.match(d.basis, /市场=p7\.s7\.market\.v1 事件=p7\.s7\.event\.v1/, "basis 里的规则版本要说清是哪张表；这两维本次未计入是「没传读数」，不是「没有规则」");
});

/* --------------------------------------------------------------- 补充口径留痕（评审 B1） */

test("P7-① B1 补分留痕：本层替任务书补的分/线都带「本层补充，非原始任务书定义」标记", () => {
  const rsiGap = technicalItems({ ...fullTech, rsi: 72 }).find((i) => i.rule === "T-RSI")!;
  assert.ok((rsiGap.note ?? "").includes(SUPPLEMENT_MARKER));
  assert.ok((technicalItems({ ...fullTech, close_prev: 12, volume: 2000, volume_avg: 1000 }).find((i) => i.rule === "T-VOLUME")!.note ?? "").includes(SUPPLEMENT_MARKER), "放量线倍数是本层补的");
  const pPayoff = probabilityDimension(prob([r1p(60, 2)])).items.find((i) => i.rule === "P-PAYOFF")!;
  assert.ok((pPayoff.note ?? "").includes(SUPPLEMENT_MARKER), "盈亏比三档的数值线是本层补的");
  assert.ok((probabilityDimension(prob([r1p(60, 0.5)])).items.find((i) => i.rule === "P-PAYOFF")!.note ?? "").includes(SUPPLEMENT_MARKER));
  const level = probabilityDimension(prob([r1(50)])).items.find((i) => i.rule === "P-WINRATE")!;
  assert.ok(!(level.note ?? "").includes(SUPPLEMENT_MARKER), "50–60 的 +10 是任务书原文，不该标补充");
  assert.ok(!(probabilityDimension(prob([r1(45)])).items.find((i) => i.rule === "P-SAMPLE")!.note ?? "").match(/本层补充/), "样本 <100 记 0 分同样是任务书原文");
  // 事件/市场两张表的补充线同样要能见到（阈值常量本身在各自文件里，这里钉「文案带标记」）
  const ev = buildDecision({ technical: fullTech, external: [{ key: "event", score: 20, rule_version: EVENT_RULE_VERSION, status: "AI_INTERPRETATION", bounds: EVENT_EXTREMES, missing: [`分档界线（±${EVENT_LEVEL_MINOR}/±${EVENT_LEVEL_MAJOR}）｜${SUPPLEMENT_MARKER}`] }] });
  assert.match(decisionToText(ev), new RegExp(SUPPLEMENT_MARKER));
  assert.ok(EVENT_LEVEL_MAJOR > EVENT_LEVEL_MINOR, "重大档界线必须高于普通档，否则档位顺序反了");
  // 标记要能在文案里见到（note 必须进 decisionToText，不能只留在 JSON）
  const text = decisionToText(buildDecision({ technical: { ...fullTech, rsi: 72 } }));
  assert.ok(text.includes(SUPPLEMENT_MARKER), "默认视图看不到「这是补的分」的话，标记就等于没写");
});

/* ---------------------------------------------------------------------- 冲突（任务书 §九） */

test("P7-⑦ §九 冲突：技术看涨 + 主周期上涨比例落在最低档 ⇒ 登记分歧，但不改映射表档位", () => {
  assert.equal(CONFLICT_TECHNICAL_MIN, 15);
  // 为何改：v2 的触发线 35 是当时那张表的最低档上沿；新表最低档是「<40% −15」，
  // 再拿 35 当线会让 35%~40% 既被表判成最低档、又不触发冲突声明，自相矛盾。
  assert.equal(CONFLICT_PROBABILITY_MAX, 40);
  const d = buildDecision({ technical: fullTech, probability: prob([r1(30)]) });
  assert.ok(d.conflict, "技术面看涨、1 日上涨概率 30% ⇒ 必须触发");
  assert.equal(d.single_side, false, "分歧时不得标记为单边确认");
  assert.match(d.conflict!.statement, /反弹观察/);
  assert.match(d.conflict!.statement, /不属于强趋势上涨确认/);
  assert.match(d.conflict!.statement, /样本 200/, "冲突文案里也要带口径，不能只留一句情绪化的话");
  // 为何改：v2 在这里断言 grade 被改写成「反弹观察」。v3 的映射表恰好六个标签，
  // 塞第七个进去等于把任务书的档位改样 —— 分歧改由 conflict + single_side + 三段式风险段表达。
  assert.equal(d.grade, "震荡偏强", "档位仍按折算分查映射表：分歧不新增档位，但风险段必须出现");
  assert.ok(!/^看涨$/m.test(d.statement.trim()), "禁止单独输出「看涨」");
  assert.ok(d.conflict!.statement.length > 0);
  const ok = buildDecision({ technical: fullTech, probability: prob([r1(50)]) });
  assert.equal(ok.conflict, null, "50% 落在 40–50 之外的中间档，不构成反弹冲突");
  assert.equal(ok.single_side, true);
  const weak = buildDecision({
    technical: { ...fullTech, ma5: 9, ma10: 10, ma20: 11, close: 8.5, dif: -0.4, dea: -0.2, dif_prev: -0.5, dea_prev: -0.3, bar: -0.4, bar_prev: -0.5, rsi: 40 },
    probability: prob([r1(30)]),
  });
  assert.equal(weak.conflict, null, "技术面自己就是看跌侧，不构成「反弹信号」冲突");
});

test("P7-① 冲突判定独立于维度归并：detectConflict 只看技术分与主周期读数，且带触发线原文", () => {
  assert.equal(detectConflict(14, prob([r1(10)])), null, `技术面未到 ${CONFLICT_TECHNICAL_MIN} 分不触发`);
  assert.equal(detectConflict(20), null, "没有概率读数就无从冲突");
  assert.equal(detectConflict(20, prob([{ ...r1(10), horizon: 20 }], "similar_env", { primary_horizon: 1 })), null, "主周期是 1 日时 20 日低概率不触发短期反弹冲突（任务书 §九 说的是短期）");
  const c = detectConflict(20, prob([r1(10)]))!;
  assert.deepEqual(c.trigger, { technical_min: CONFLICT_TECHNICAL_MIN, probability_max: CONFLICT_PROBABILITY_MAX });
  assert.equal(c.engine, "similar_env");
  assert.equal(c.probability_win_rate, 10);
  assert.equal(c.probability_horizon, 1);
  const also = detectConflict(20, { engine: "similar_env", readings: [r1(10)], primary_horizon: null });
  assert.equal(also!.probability_horizon, 1, "没声明主周期时按最短的 1 日读，与 probabilityDimension「不替调用方挑周期」不冲突：这里只是判分歧，不给分");
});

/* --------------------------------------------------------------- 血缘、文案与三段式（#107） */

test("P7-① 血缘：每条概率读数自带 trade_date/样本/区间/期限，并标出哪条是打分用的主周期", () => {
  const d = buildDecision({
    technical: fullTech,
    probability: prob([{ horizon: 5, win_rate: 58, sample_size: 77, trade_date: "2026-09-19", period: { start: "2025-01-02", end: "2026-08-20" }, payoff_ratio: 1.35 }], "similar_env", { primary_horizon: 5 }),
  });
  assert.equal(d.sources.length, 1);
  assert.deepEqual(d.sources[0], {
    dimension: "probability", rule: "P-SAMPLE/P-WINRATE/P-PAYOFF", engine: "similar_env", horizon: 5, win_rate: 58, sample: 77,
    payoff_ratio: 1.35, role: "scored", trade_date: "2026-09-19", period: { start: "2025-01-02", end: "2026-08-20" },
  }, "v3 的 rule 是三条档一起给 ⇒ 不再是 v2 的单一 P-5D；盈亏比也进血缘（它参与打分）");
  const two = buildDecision({ technical: fullTech, probability: prob([r1p(60, 1.5), { ...r1(55), horizon: 5 }]) });
  assert.deepEqual(two.sources.map((s) => s.role), ["scored", "basis"], "非主周期仍进血缘，只是不打分");
  const text = decisionToText(d);
  assert.match(text, /相似环境 5 日上涨概率 58%（样本 77，区间 2025-01-02→2026-08-20，读数所属日 2026-09-19；盈亏比 1.35/);
  assert.match(text, /历史统计，不是对今天的预测|HISTORICAL/, "概率项要自带分层提示");
});

test("P7-⑦ 概率句式四要素齐备：样本数量 / 时间范围 / 观察周期 / 数据来源，缺哪个就写「未给出」", () => {
  const full = buildDecision({ technical: fullTech, probability: prob([r1p(52.9, 1.5)]) });
  const s = probabilitySentence(full)!;
  assert.match(s, /历史相似环境口径样本 200 次，未来 1 日上涨概率 52\.9%，统计区间 2024-08-06→2026-08-20，数据来源 similar-env\.ts（similarReturnForward）/);
  assert.match(s, /该数据仅代表历史统计，不代表未来预测/, "任务书要求的收尾句一字不改");
  const bare = buildDecision({ technical: fullTech, probability: prob([{ horizon: 1, win_rate: 52.9, sample_size: 200 }]) });
  const bs = probabilitySentence(bare)!;
  assert.match(bs, /统计区间未给出/, "缺要素要写在句子里，不能整段从句省掉");
  assert.equal(probabilitySentence(buildDecision({ technical: fullTech })), null, "没有概率读数就没有这句话");
});

test("P7-① 文案：得分不带百分号，百分号只出现在有出处的概率读数里", () => {
  const d = buildDecision({ technical: fullTech, probability: prob([r1p(52.9, 1.5)]), subject: "寒武纪 688256" });
  const text = decisionToText(d);
  assert.match(d.basis, /标的：寒武纪 688256/);
  assert.equal(d.protocol_version, DECISION_PROTOCOL_VERSION);
  const scoreLine = text.split("\n").filter((l) => /综合得分|综合评分/.test(l)).join("\n");
  assert.ok(!/可信度\s*[:：]?\s*\d+(\.\d+)?%/.test(text), `得分被写成了百分比：${scoreLine}`);
  assert.ok(!/置信度|把握度/.test(text), "同义伪装也算违规");
  assert.ok(!/\+?76%|\+?70\.2%/.test(text), "折算分带百分号同样是伪装：得分量纲不能写成频率");
  const pcts = text.match(/(\d+(\.\d+)?)%/g) ?? [];
  for (const p of pcts) assert.ok(/上涨概率|占比|比例|档|≥|<|–|样本|概率/.test(text.split("\n").find((l) => l.includes(p))!), `百分号 ${p} 出现在没有概率出处的行里`);
  assert.match(text, /未计入|未参与加权/, "缺维度要在默认视图里出现");
  assert.match(text, /×\d+\/100/, "权重要以分数形式给出，避免被读成概率");
});

test("P7-⑦ 三段式：①评分+等级 ②主要判断依据 ③核心风险点，页面首屏与 AI 上下文共用同一份", () => {
  const d = buildDecision({ technical: fullTech, probability: prob([r1p(30, 1.5)]), external: ext({ score: -10 }) });
  const s = decisionSections(d);
  assert.match(s.headline, /^① 综合评分 [+-][\d.]+（−100~\+100 折算刻度）／趋势等级「.+」$/);
  assert.ok(d.grade !== null && s.headline.includes(d.grade), "等级必须就是映射表算出来的那个，不能另写一份（这一组读数有等级，且首屏印的就是它）");
  assert.ok(s.basis.length >= 2);
  assert.ok(s.basis.some((b) => b.includes("技术结构·")), "依据取参与加权的字面分项，维度名前缀要在");
  assert.ok(s.basis.some((b) => /综合：技术结构 字面/.test(b)), "第二段要能把加权结果追回各维字面分与折算分");
  assert.ok(s.basis.some((b) => b.includes("历史相似环境口径样本")), "概率的标准句式属于「依据」，不是风险");
  assert.ok(s.risk.some((r) => r.includes("分歧：")), "反弹型分歧属于第三段");
  assert.ok(s.risk.some((r) => r.includes("缺口【")), "分项级缺口也归第三段");
  const riskText = s.risk.join("\n");
  assert.match(riskText, /T-VOLUME|未计入|缺口/, "第三段是「这次缺什么、什么在反对」的原样清单，不是模板");
  assert.equal(s.risk.every((r) => !/可信度/.test(r)), true);
  const text = decisionToText(d);
  for (const h of ["【综合评分与趋势等级】", "【主要判断依据】", "【核心风险点】", "【判定依据（已并入上表，不重复计分）】", "【逐维折算记账】"]) {
    assert.ok(text.includes(h), `三段式文本缺 ${h}`);
  }
  assert.match(text, /依据（已并入上表，不重复计分）/, "basis 段落标题要把「不重复计分」写在脸上");
});

test("P7-⑦ 三段式（只有一维时）：依据仍带得出，风险段仍登记未计入的三维", () => {
  const one = buildDecision({ technical: fullTech });
  const s = decisionSections(one);
  assert.equal(s.basis.some((b) => b.startsWith("技术结构·均线多头排列")), true);
  for (const k of ["历史概率", "市场环境", "事件影响"]) assert.ok(s.risk.some((r) => r.includes(`未计入【${k}】`)), `${k} 未计入要出现在风险段`);
});

test("P7-① 缺口在默认视图就要出现：decisionToText 不吞 missing，也不给空分母凑结论", () => {
  const empty = buildDecision({});
  assert.equal(empty.final_score, null);
  assert.deepEqual(empty.excluded.map((e) => e.key).sort(), ["event", "market", "probability", "technical"]);
  const text = decisionToText(empty);
  assert.match(text, /所有维度本次都没有可加权的得分|没有任何维度参与加权/);
  assert.match(text, /综合得分 算不出/);
  assert.ok(!/综合判断：(看涨|看跌|中性|偏强震荡|偏弱)/.test(text), "一条读数都没有时不能给出任何档位（口径行里出现档位名是在解释映射表，不是在下结论）");
  assert.equal(empty.grade, null);
  const partial = buildDecision({ technical: { ...fullTech, rsi: null } });
  assert.equal(partial.dimensions.find((x) => x.key === "technical")!.status, "DEGRADED");
  assert.ok(decisionToText(partial).includes("缺口【技术结构】"), "分项级缺口要出现在文本结论里，不能只在 JSON 里");
  assert.equal(partial.dimensions.find((x) => x.key === "technical")!.score, 30, "去掉 RSI 的 +8 ⇒ 38−8=30，其它项照算");
});

test("P7-⑦ 分层：来源分层只统计计分项，basis 项不把 MISSING/AI_INTERPRETATION 混进结论分层", () => {
  const d = fourDim(prob([r1p(60, 1.5)]));
  assert.ok(d.layers.includes("DERIVED"));
  assert.ok(d.layers.includes("HISTORICAL"), "概率读数属 HISTORICAL：它是历史统计，不是今天的行情事实");
  // 事件面这里是一个只有维度状态、没有分项的桩：分层取维度状态，能看到解释层，但不会看到分项层
  const basisOnly = buildDecision({ external: [{
    key: "event", score: 20, rule_version: EVENT_RULE_VERSION, status: "AI_INTERPRETATION", bounds: EVENT_EXTREMES,
    items: [
      { rule: "EV-LEVEL", label: "重大利好", points: 20, raw: "x", status: "AI_INTERPRETATION", role: "scored", rule_version: EVENT_RULE_VERSION },
      { rule: "E-TILT", label: "旧表倾向（本次无读数）", points: null, raw: "y", status: "MISSING", role: "basis", rule_version: MARKET_LEGACY_RULE_VERSION },
    ],
  }] });
  assert.ok(basisOnly.layers.includes("AI_INTERPRETATION"), "事件面的解释成分要让页面看得到");
  assert.ok(!basisOnly.layers.includes("MISSING"), "basis 项即便算不出也不进分层：它本来就不参与这份得分");
});

test("P7-① 规则版本表：四维都有版本了，但「不传读数仍然未计入」这条纪律一字未改", () => {
  assert.deepEqual(RULE_VERSIONS, {
    technical: "p7.s7.technical.v1", probability: "p7.s7.probability.v1",
    market: "p7.s7.market.v1", event: "p7.s7.event.v1",
  }, "v3 起四维都是 P7-⑦ 任务书表（p7.s7.*）；旧表版本落在分项的 rule_version 上（p7.s3.*/p7.taskbook.*）");
  assert.equal(RULE_VERSIONS.market, MARKET_RULE_VERSION, "内核写死的版本字符串必须与 market-score-core 一致");
  assert.equal(RULE_VERSIONS.event, EVENT_RULE_VERSION, "同上：与 event-score-core 一致");
  assert.equal(MARKET_LEGACY_RULE_VERSION, "p7.s3.market.v1", "并入项的旧版本仍然独立存在，两代表不能混成一个前缀");
  const d = buildDecision({ technical: fullTech });
  assert.match(d.basis, /市场=p7\.s7\.market\.v1/, "口径行里印的是现行规则表版本，接线后要能顺着它找到那张表");
  assert.match(d.basis, /刻度口径：每一维先按本维规则表极值折算到 −100~\+100/);
});
