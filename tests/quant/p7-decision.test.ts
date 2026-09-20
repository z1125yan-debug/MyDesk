// P7-① 统一决策层纯内核的单元测试（node --test 直跑，无 DB / 无网络 / 无时钟）。
//
// 这些测试钉住的是四件事，顺序即本层存在的理由：
// 1) 任务书 §五 / §六 的分档在边界上必须有唯一答案（左闭右开，重叠处高分档优先，空洞处按补充口径）；
//    结论映射阈值取自《P7-① 决策内核评审确认结论》§一·规格 A（A1），不再是任务书 §七 的 ≥50/<−50；
// 2) 「缺数据」和「0 分」和「中性」在三条路上走，不能被压成同一个数字（REAL_DATA_ONLY 的本层版本）；
// 3) 没有规则的维度不许参与加权，缺了就重归一 + 显式声明，而不是补 0；
// 4) 输出里不出现「可信度 xx%」这种把加权得分冒充概率的表述，而概率读数必须自带口径才进血缘。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFLICT_PROBABILITY_MAX, CONFLICT_TECHNICAL_MIN, DEFAULT_WEIGHTS, DECISION_PROTOCOL_VERSION,
  GRADE_BANDS, GRADE_MAPPING_VERSION, PROBABILITY_BANDS, PROBABILITY_MIN_SAMPLE, RULE_VERSIONS, SUPPLEMENT_MARKER,
  buildDecision, decisionToText, detectConflict, gradeForScore, probabilityDimension,
  probabilityPointsFor, scoreBounds, technicalItems,
  type ProbabilityInput, type TechnicalInput,
} from "../../src/lib/quant/screener/decision-core.ts";

const fullTech: TechnicalInput = {
  ma5: 12, ma10: 11, ma20: 10, close: 12.5,
  dif: 0.4, dea: 0.2, dif_prev: 0.1, dea_prev: 0.15, bar: 0.4, bar_prev: 0.3,
  rsi: 62, rsi_period: 14,
};
/** 均线多头 +20、未跌破 MA20 记 0、金叉且柱扩大 +15、零轴上方 +10、RSI 强势 +10 ⇒ 55（技术面极值） */
const TECH_MAX = 55;

function prob(readings: ProbabilityInput["readings"], engine: ProbabilityInput["engine"] = "similar_env", extra: Partial<ProbabilityInput> = {}): ProbabilityInput {
  return { engine, readings, ...extra };
}
const r1 = (win_rate: number | null, sample = 200): ProbabilityInput["readings"][number] =>
  ({ horizon: 1, win_rate, sample_size: sample, trade_date: "2026-09-19", period: { start: "2024-08-06", end: "2026-08-20" } });

test("P7-① 概率分档：边界只属于一档（左闭右开，重叠处高分档优先）", () => {
  assert.equal(probabilityPointsFor(20, 55), 20, "55 属于「≥55」这一档，不是 45–55 那档");
  assert.equal(probabilityPointsFor(20, 54.99), 5);
  assert.equal(probabilityPointsFor(20, 45), 5);
  assert.equal(probabilityPointsFor(20, 44.99), 0);
  assert.equal(probabilityPointsFor(20, 35), 0);
  assert.equal(probabilityPointsFor(20, 34.99), -20);
  assert.equal(probabilityPointsFor(20, 100), 20, "100% 是合法读数，不能因为端点写 101 就掉出区间");
  assert.equal(probabilityPointsFor(5, 40), 0);
  assert.equal(probabilityPointsFor(5, 39.9), -10);
});

test("P7-① 任务书 §五 的空洞（1 日 35%–55%）按补充口径给 0 分，且明写这不是「算不出」", () => {
  assert.equal(probabilityPointsFor(1, 54), 0);
  assert.equal(probabilityPointsFor(1, 35), 0);
  assert.equal(probabilityPointsFor(1, 55), 5);
  assert.equal(probabilityPointsFor(1, 34.9), -5);
  const band = PROBABILITY_BANDS[1].find((b) => b.min === 35)!;
  assert.match(band.note ?? "", /未定义/, "补的口径必须自己承认是补的，不能伪装成任务书原文");
});

test("P7-① win_rate 用 0–100 量纲：null 与越界读数一律不判定，而不是当 0%", () => {
  assert.equal(probabilityPointsFor(1, null), null);
  assert.equal(probabilityPointsFor(1, -1), null, "越界读数若被判成 −5 分，就是把脏数据变成了结论");
  assert.equal(probabilityPointsFor(1, 101), null);
  const d = probabilityDimension(prob([r1(null)]));
  assert.equal(d.score, null, "唯一一条读数算不出 ⇒ 整维度不进分母");
  assert.equal(d.items[0].points, null);
  assert.match(d.items[0].note ?? "", /不是 0%/, "缺读数分项要明说它不等于 0%");
});

test("P7-① 技术面：缺哪天就只说哪天算不出，不沿用因子面板「缺数据返回 0」的写法", () => {
  const noPrev: TechnicalInput = { ...fullTech, dif_prev: null, dea_prev: null };
  const items = technicalItems(noPrev);
  const cross = items.find((i) => i.rule === "T-MACD-CROSS")!;
  assert.equal(cross.points, null, "fields.ts:671 的 crossUp 在缺前一天时返回 0（=没有金叉），本层必须给 null");
  assert.match(cross.note ?? "", /crossUp/);
  assert.equal(items.find((i) => i.rule === "T-MA-STRUCT")!.points, 20, "其余项照算，不因为一项缺就整面归零");
  const nulls = technicalItems(noPrev).filter((i) => i.points === null).map((i) => i.rule);
  assert.deepEqual(nulls, ["T-MACD-CROSS", "T-VOLUME"], "其余四项读数齐全 ⇒ 只有金叉（缺前一天）与成交量（无规则）不计分；零轴项仍能给分");
});

test("P7-① 成交量与 MACD 跨零轴：任务书没写规则的项不补规则，只登记未计入", () => {
  const items = technicalItems(fullTech);
  const vol = items.find((i) => i.rule === "T-VOLUME")!;
  assert.equal(vol.points, null);
  assert.match(vol.note ?? "", /不补规则|不计 0 分/);
  const zero = technicalItems({ ...fullTech, dif: 0.4, dea: -0.2 }).find((i) => i.rule === "T-MACD-ZERO")!;
  assert.equal(zero.points, 0, "一上一下是「读数存在但任务书没定义」，本层取 0 并标注，不猜方向");
  assert.match(zero.note ?? "", /只定义两侧同号/);
  const rsiGap = technicalItems({ ...fullTech, rsi: 72 }).find((i) => i.rule === "T-RSI")!;
  assert.equal(rsiGap.points, -5, "70–75 是任务书的空洞：保守取超买侧的 −5，宁可不给强势分");
  assert.match(rsiGap.note ?? "", /空洞/);
});

test("P7-① 均线结构三档互斥：跌破 MA20 是独立分项，与结构分相加", () => {
  const items = technicalItems({ ...fullTech, close: 9.5 });
  assert.equal(items.find((i) => i.rule === "T-MA-STRUCT")!.points, 20);
  assert.equal(items.find((i) => i.rule === "T-MA-BREAK")!.points, -15);
  const allNull = technicalItems({ ma5: null, ma10: null, ma20: null, close: null, dif: null, dea: null, dif_prev: null, dea_prev: null, bar: null, bar_prev: null, rsi: null });
  assert.ok(allNull.every((i) => i.points === null), "全缺 ⇒ 没有任何一项给分");
  const d = buildDecision({ technical: { ma5: null, ma10: null, ma20: null, close: null, dif: null, dea: null, dif_prev: null, dea_prev: null, bar: null, bar_prev: null, rsi: null } });
  assert.equal(d.final_score, null);
  assert.equal(d.grade, null);
  assert.match(d.statement, /算不出/);
});

test("P7-① 缺规则的维度不进分母，权重按剩余维度重归一（且明写重归一成了什么）", () => {
  const d = buildDecision({ technical: fullTech, probability: prob([{ ...r1(60), horizon: 20 }]) });
  assert.deepEqual(d.included, ["technical", "probability"]);
  assert.deepEqual(d.excluded.map((e) => e.key).sort(), ["event", "market"]);
  assert.match(d.excluded.find((e) => e.key === "market")!.reason, /没有打分表/);
  assert.equal(d.weights.applied.technical, 0.5714, "生效权重取四位小数，页面按 n/100 显示，不做浮点等值断言");
  assert.equal(d.weights.applied.probability, 0.4286);
  assert.ok(Math.abs(d.weights.applied.technical + d.weights.applied.probability - 1) < 1e-9, "生效权重必须自和为 1，否则得分量纲会随缺失维度漂移");
  assert.equal(d.weights.renormalized, true);
  // 技术 55 + 概率 20（20 日 ≥55%）⇒ 加权 55*(4/7)+20*(3/7) = 40
  assert.equal(d.final_score, 40, "55*0.5714 + 20*0.4286 = 31.43 + 8.57 = 40");
  assert.match(d.basis, /重归一为 技术结构 0\.5714、历史概率 0\.4286/);
  assert.match(d.basis, /市场=无（本层不补规则） 事件=无（本层不补规则）/, "basis 里要能看到「这两维没有规则」这件事本身，而不是只看到它们没分");
});

test("P7-① 外部维度必须自带规则版本才承认，否则同样是未计入（不给 0 分）", () => {
  const noRule = buildDecision({ technical: fullTech, external: [{ key: "market", score: null, rule_version: "" }] });
  assert.deepEqual(noRule.excluded.map((e) => e.key).sort(), ["event", "market", "probability"], "rule_version 传空串等同于没带规则 ⇒ 仍然未计入");
  const withRule = buildDecision({
    technical: fullTech,
    external: [{ key: "market", score: 10, rule_version: "p7.market.v0-draft", status: "DERIVED" }],
  });
  assert.deepEqual(withRule.included, ["technical", "market"]);
  assert.equal(withRule.dimensions.find((x) => x.key === "market")!.rule_version, "p7.market.v0-draft");
  assert.ok(withRule.final_score !== null && withRule.final_score < TECH_MAX, "市场面参与后必须稀释技术面，说明它真进了加权");
});

test("P7-① 结论映射按评审 A1 + 看跌线补丁（A1.1）：五档左闭右开，§七 原阈值与 A1 的 −40 都已作废", () => {
  assert.equal(gradeForScore(30), "看涨", "+30 是看涨线下限");
  assert.equal(gradeForScore(29.9), "偏强震荡");
  assert.equal(gradeForScore(5), "偏强震荡", "+5 归偏强震荡，不落中性");
  assert.equal(gradeForScore(4.9), "中性");
  assert.equal(gradeForScore(-20), "中性", "中性档 −20~+5 左闭 ⇒ −20 归中性，不是偏弱");
  assert.equal(gradeForScore(-20.1), "偏弱");
  assert.equal(gradeForScore(-30), "偏弱", "偏弱档 −30~−20 左闭 ⇒ −30 仍属偏弱（A1.1 的看跌线）");
  assert.equal(gradeForScore(-30.1), "看跌");
  assert.deepEqual(GRADE_BANDS, {
    看涨: { min: 30, max: null }, 偏强震荡: { min: 5, max: 30 }, 中性: { min: -20, max: 5 },
    偏弱: { min: -30, max: -20 }, 看跌: { min: -Infinity, max: -30 },
  }, "映射表就是这一版，任何后续调整都要经用户拍板");
  assert.equal(GRADE_MAPPING_VERSION, "p7.review.s1.A1.1");
  assert.match(buildDecision({ technical: fullTech }).basis, /映射阈值 p7\.review\.s1\.A1\.1（左闭右开）：看涨 \[30,∞\)/, "结论卡的口径里要能看到阈值出处，不能只有一句话结论");
  // §七 的 50/20/−50 与 A1 原稿的 −40 都不许回来：它们各自都造过死档
  const retired = [50, 20, -50, -40];
  assert.ok(!retired.some((v) => Object.values(GRADE_BANDS).some((b) => b.min === v || b.max === v)), `旧阈值残留在映射表里：${retired.join("/")}`);
  assert.match(buildDecision({ technical: fullTech }).basis, /看跌 \[-∞,-30\)/, "无穷端点要印成 ∞，不能把 -Infinity 这种 JS 字面量丢给用户");
});

test("P7-① 可达区间自检（A1.1）：任意真实生效权重组合下五档全部可达，本层每次重算并显示", () => {
  const b = scoreBounds(DEFAULT_WEIGHTS);
  assert.equal(b.max, 32.5, "技术极值 55*0.4 + 概率极值 35*0.3");
  assert.equal(b.min, -24.5);
  // 这一组是纸面情形：只有市场/事件面各自拿到规则并记 0 分才会用原权重，而 scoreBounds 不建模外部维度极值，
  // 所以它给出的 −24.5 地板比真实可达性乐观；buildDecision 产出的生效权重必自和为 1，见下面的穷举。
  assert.deepEqual(b.unreachable_grades, ["看跌"], "地板 −24.5 够不到 −30 ⇒ 这个假想权重下看跌仍不可达（不代表真实组合）");
  // 只算技术+概率（市场/事件因缺规则被剔除、权重落到 0.571/0.429）时区间变宽 ⇒ 同一字面结论取决于参与维度数
  const onlyTwo = { technical: 0.4 / 0.7, probability: 0.3 / 0.7, market: 0, event: 0 };
  const b2 = scoreBounds(onlyTwo);
  assert.equal(b2.max, 46.4);
  assert.equal(b2.min, -35);
  assert.deepEqual(b2.unreachable_grades, [], "两维重归一后 −35~46.4 ⇒ A1.1 下五档全部可达");
  const one = buildDecision({ technical: fullTech });
  assert.equal(one.weights.applied.technical, 1, "只剩一个维度时它独占权重：final_score 就等于该维度原始分");
  assert.deepEqual(one.attainable, { min: -35, max: 55, unreachable_grades: [] });
  const two = buildDecision({ technical: fullTech, probability: prob([{ ...r1(60), horizon: 5 }]) });
  assert.deepEqual(two.attainable, { min: -35, max: 46.4, unreachable_grades: [] });
  // 穷举 buildDecision 真正可能产出的全部生效权重组合（技术/概率的非空子集，重归一到自和为 1）
  const combos = [
    { technical: 1, probability: 0, market: 0, event: 0 },
    { technical: 0, probability: 1, market: 0, event: 0 },
    { technical: 0.5714, probability: 0.4286, market: 0, event: 0 },
  ];
  for (const w of combos) {
    const bb = scoreBounds(w);
    assert.deepEqual(bb.unreachable_grades, [], `组合 ${JSON.stringify(w)} 区间 ${bb.min}~${bb.max} 仍有死档 ⇒ A1.1 的「五档全部可达」承诺被破坏`);
  }
  // 只有概率参与时区间最窄（±35），它是这个承诺的边界情形：看涨 [30,∞) 与看跌 <−30 都刚好够得到
  const probOnly = buildDecision({ probability: prob([r1(60), { ...r1(60), horizon: 5 }, { ...r1(60), horizon: 20 }]) });
  assert.deepEqual(probOnly.included, ["probability"]);
  assert.deepEqual(probOnly.attainable, { min: -35, max: 35, unreachable_grades: [] });
  assert.equal(scoreBounds(DEFAULT_WEIGHTS).max, 32.5, "同一份打分表、四维权重下的上限只有 32.5");
  assert.match(buildDecision({ technical: fullTech }).statement, /得分是规则加权的结果，不是概率/);
  assert.match(buildDecision({ technical: fullTech }).basis, /映射表五档全部可达/, "可达性结论要出现在默认视图的口径行里，而不是只活在测试断言里");
});

test("P7-① B1 补分留痕：三处替任务书补的分数都带「本层补充，非原始任务书定义」标记", () => {
  const band = PROBABILITY_BANDS[1].find((b) => b.min === 35)!;
  assert.ok((band.note ?? "").includes(SUPPLEMENT_MARKER), `1 日 35%–55% 的补分 note 缺标记：${band.note}`);
  const zero = technicalItems({ ...fullTech, dif: 0.4, dea: -0.2 }).find((i) => i.rule === "T-MACD-ZERO")!;
  assert.ok((zero.note ?? "").includes(SUPPLEMENT_MARKER));
  assert.match(zero.note ?? "", /跨零轴状态/, "评审 §一·规格 B 第 3 条要求文案里点明这是跨零轴状态");
  const rsiGap = technicalItems({ ...fullTech, rsi: 72 }).find((i) => i.rule === "T-RSI")!;
  assert.ok((rsiGap.note ?? "").includes(SUPPLEMENT_MARKER));
  // 任务书本来就有定义的档位不得被打上「补充」标记，否则标记就失去区分意义
  const rsiStrong = technicalItems({ ...fullTech, rsi: 62 }).find((i) => i.rule === "T-RSI")!;
  assert.ok(!(rsiStrong.note ?? "").includes(SUPPLEMENT_MARKER), "55–70 是任务书原文的 +10 档，不该标补充");
  const p20 = PROBABILITY_BANDS[20].find((b) => b.min === 35)!;
  assert.equal(p20.points, 0, "20 日 35%–45% 的 0 分是任务书原文，不是补充");
  assert.ok(!(p20.note ?? "").includes(SUPPLEMENT_MARKER));
  // 标记要能在文案里见到（note 必须进 decisionToText，不能只留在 JSON）
  const text = decisionToText(buildDecision({ technical: { ...fullTech, rsi: 72 } }));
  assert.ok(text.includes(SUPPLEMENT_MARKER), "默认视图看不到「这是补的分」的话，标记就等于没写");
});

test("P7-① §九 冲突：技术看涨 + 短期概率落在最低档 ⇒ 不出单边结论", () => {
  assert.equal(CONFLICT_TECHNICAL_MIN, 15);
  assert.equal(CONFLICT_PROBABILITY_MAX, 35);
  const d = buildDecision({ technical: fullTech, probability: prob([r1(30)]) });
  assert.ok(d.conflict, "技术面 55 分、1 日上涨概率 30% ⇒ 必须触发");
  assert.equal(d.grade, "反弹观察");
  assert.equal(d.single_side, false, "分歧时不得标记为单边确认");
  assert.match(d.conflict!.statement, /反弹观察/);
  assert.match(d.conflict!.statement, /不属于强趋势上涨确认/);
  assert.match(d.conflict!.statement, /样本 200/, "冲突文案里也要带口径，不能只留一句情绪化的话");
  assert.ok(!/^看涨$/m.test(d.statement.trim()), "禁止单独输出「看涨」");
  // 不触发：概率读数在中间档
  const ok = buildDecision({ technical: fullTech, probability: prob([r1(50)]) });
  assert.equal(ok.conflict, null);
  // 技术面分数不够高也不触发
  const weak = buildDecision({
    technical: { ...fullTech, ma5: 9, ma10: 10, ma20: 11, close: 8.5, dif: -0.4, dea: -0.2, dif_prev: -0.5, dea_prev: -0.3, bar: -0.4, bar_prev: -0.5, rsi: 40 },
    probability: prob([r1(30)]),
  });
  assert.equal(weak.conflict, null, "技术面自己就是看跌侧，不构成「反弹信号」冲突");
});

test("P7-① 概率口径冲突要拒绝，而不是平均：多份读数、同期限两条都不给分", () => {
  const mixed = buildDecision({
    technical: fullTech,
    probability: [prob([r1(60)], "similar_env"), prob([{ ...r1(40), horizon: 5 }], "conditional", { conditions: ["RPS>90"] })],
  });
  assert.deepEqual(mixed.included, ["technical"], "两份引擎的读数不得混算");
  assert.match(mixed.dimensions.find((x) => x.key === "probability")!.missing[0], /不能相加也不能平均/);
  const dup = probabilityDimension(prob([r1(60), r1(20)]));
  assert.equal(dup.score, null);
  assert.match(dup.missing[0], /同一期限|条读数/);
});

test("P7-① 条件概率少了筛选条件就不承认它是「上涨概率」", () => {
  const d = probabilityDimension(prob([r1(60)], "conditional"));
  assert.ok(d.score !== null, "有样本有读数仍算得出分档，但缺口必须登记");
  assert.match(d.missing.join(" / "), /没有给出筛选条件/);
  assert.match(d.missing.join(" / "), /无条件时它自己就返回 null/);
  const withCond = probabilityDimension(prob([r1(60)], "conditional", { conditions: ["板块 RPS>90 且主力净流入>0"] }));
  assert.deepEqual(withCond.missing, [], "条件写清楚后这条缺口消失");
});

test("P7-① 样本不足：历史频率仍有值，但整维度降级 DEGRADED（引擎的 sample_ok 就是 false）", () => {
  const d = probabilityDimension(prob([r1(60, 12)]));
  assert.equal(d.status, "DEGRADED");
  assert.match(d.items[0].note ?? "", new RegExp(`样本 12 < ${PROBABILITY_MIN_SAMPLE}`));
  assert.equal(probabilityDimension(prob([r1(60, 30)])).status, "DERIVED", "刚好到线下限不再降级");
});

test("P7-① 血缘：每条计入得分的概率读数自带 trade_date/样本/区间/期限，供证据面板与复校验用", () => {
  const d = buildDecision({
    technical: fullTech,
    probability: prob([{ horizon: 5, win_rate: 58, sample_size: 77, trade_date: "2026-09-19", period: { start: "2025-01-02", end: "2026-08-20" } }]),
  });
  assert.equal(d.sources.length, 1);
  assert.deepEqual(d.sources[0], {
    dimension: "probability", rule: "P-5D", engine: "similar_env", horizon: 5, win_rate: 58, sample: 77,
    trade_date: "2026-09-19", period: { start: "2025-01-02", end: "2026-08-20" },
  });
  const text = decisionToText(d);
  assert.match(text, /相似环境 5 日上涨概率 58%（样本 77，区间 2025-01-02→2026-08-20，读数所属日 2026-09-19）/);
  assert.match(text, /历史统计，不是对今天的预测|HISTORICAL/, "概率项要自带分层提示");
});

test("P7-① 文案：得分不带百分号，百分号只出现在有出处的概率读数里", () => {
  const d = buildDecision({ technical: fullTech, probability: prob([r1(52.9)]), subject: "寒武纪 688256" });
  const text = decisionToText(d);
  assert.match(d.basis, /标的：寒武纪 688256/);
  assert.equal(d.protocol_version, DECISION_PROTOCOL_VERSION);
  const confidenceLine = text.split("\n").filter((l) => /综合得分|加权得分/.test(l)).join("\n");
  assert.ok(!/可信度\s*[:：]?\s*\d+(\.\d+)?%/.test(text), `得分被写成了百分比：${confidenceLine}`);
  assert.ok(!/置信度|把握度/.test(text), "同义伪装也算违规");
  const pcts = text.match(/(\d+(\.\d+)?)%/g) ?? [];
  for (const p of pcts) assert.ok(/上涨概率|档|≥|–|<|样本/.test(text.split("\n").find((l) => l.includes(p))!), `百分号 ${p} 出现在没有概率出处的行里`);
  assert.match(text, /未计入（不是 0 分，是没算）/);
  assert.match(text, /生效权重 \d+\/100/, "权重要以分数形式给出，避免被读成概率");
});

test("P7-① 缺口在默认视图就要出现：decisionToText 不吞 missing，也不给空分母凑结论", () => {
  const empty = buildDecision({});
  assert.equal(empty.final_score, null);
  assert.deepEqual(empty.excluded.map((e) => e.key).sort(), ["event", "market", "probability", "technical"]);
  const text = decisionToText(empty);
  assert.match(text, /所有维度本次都没有可加权的得分/);
  assert.match(text, /综合得分 算不出/);
  assert.ok(!/综合判断：(看涨|看跌|中性|偏强震荡|偏弱)/.test(text), "一条读数都没有时不能给出任何档位（口径行里出现「看涨/看跌」字样是在解释死档，不是在下结论）");
  assert.equal(empty.grade, null);
  const partial = buildDecision({ technical: { ...fullTech, rsi: null } });
  assert.equal(partial.dimensions.find((x) => x.key === "technical")!.status, "DEGRADED");
  assert.ok(decisionToText(partial).includes("缺口【技术结构】"), "分项级缺口要出现在文本结论里，不能只在 JSON 里");
});

test("P7-① 冲突判定独立于维度归并：detectConflict 只看技术分与 1 日读数，且带触发线原文", () => {
  assert.equal(detectConflict(14, prob([r1(10)])), null, "技术面未到 ${CONFLICT_TECHNICAL_MIN} 分不触发");
  assert.equal(detectConflict(20), null, "没有概率读数就无从冲突");
  assert.equal(detectConflict(20, prob([{ ...r1(10), horizon: 20 }])), null, "20 日低概率不触发短期反弹冲突（任务书 §九 说的是短期）");
  const c = detectConflict(20, prob([r1(10)]))!;
  assert.deepEqual(c.trigger, { technical_min: CONFLICT_TECHNICAL_MIN, probability_max: CONFLICT_PROBABILITY_MAX });
  assert.equal(c.engine, "similar_env");
  assert.equal(c.probability_win_rate, 10);
});

test("P7-① 规则版本表：市场/事件面在任务书里没有规则，这件事本身要可断言", () => {
  assert.deepEqual(RULE_VERSIONS, { technical: "p7.taskbook.s6", probability: "p7.taskbook.s5", market: null, event: null });
  const d = buildDecision({ technical: fullTech });
  assert.equal(d.dimensions.find((x) => x.key === "market")!.rule_version, null);
  assert.match(d.basis, /市场=无（本层不补规则）/);
  assert.match(d.basis, /区间口径：概率分档与技术分档一律左闭右开/);
});
