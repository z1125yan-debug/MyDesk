// P7-③ 市场面打分规则表的单元测试（node --test 直跑，无 DB / 无网络 / 无时钟）。
//
// 这套测试钉住的是「一张本层自己定的表凭什么可信」，四件事：
// 1) 出处要说清楚：本表不是任务书 §六 的原文 —— 规则版本、每条 note、断言三处都要看得出来；
// 2) 缺失走三条路：算不出（null）/ 读数存在按表归 0 / 越界或枚举外的脏数据不判定，三者不得压成同一个数字；
// 3) 值域要自证：MARKET_EXTREMES 的上下限必须真有一组输入打得到，并与 decision-core 的 scoreBounds 对得上账
//    （P7-④ 起 marketExternal() 会把本表极值随 ExternalDimension.bounds 交进内核 ⇒ 区间的 ± 端由本层声明，
//     不再是「内核只建模两维」的已知偏差；这条对账从不等式升级为精确等式）；
// 4) 文案不得出现「可信度 xx%」，出现的百分号只能属于真实读数（涨跌家数占比、涨跌幅、炸板率）。
//
// 测试里的输入全部是**合成读数**（用来验查表逻辑），不是任何一天的真实行情；这一点在各条断言里不冒充事实。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MARKET_BREADTH_BANDS, MARKET_BREAK_BANDS, MARKET_EXTREMES, MARKET_INDEX_BANDS, MARKET_LIMITNET_BANDS,
  MARKET_MAFLOW_BANDS, MARKET_MEDIAN_BANDS, MARKET_RISK_NOTE, MARKET_RISK_POINTS, MARKET_RULE_PROVENANCE,
  MARKET_RULE_VERSION, MARKET_THEME_BANDS, marketDimension, marketExternal, marketItems, pickBand,
  type MarketInput,
} from "../../src/lib/quant/screener/market-score-core.ts";
import {
  DECISION_PROTOCOL_VERSION, DEFAULT_WEIGHTS, RULE_VERSIONS, buildDecision, decisionToText, gradeForScore,
  type ProbabilityInput, type TechnicalInput,
} from "../../src/lib/quant/screener/decision-core.ts";

/** 偏强但不极端的一天：广度 +3、中位 +2、指数 +2、涨跌停净差 +4、炸板 +2、主力 +1、风险 +4、主线 +4 ⇒ 22 */
const STRONG: MarketInput = {
  advancers: 3300, decliners: 1700, total: 5000, median_pct: 0.8,
  index: { symbol: "000001.SH", label: "上证指数", change_pct: 0.5 },
  limit_up: 45, limit_down: 6, break_rate: 15, main_net_sum_yi: 210,
  risk_level: "正常", themes: { main_count: 4, top_score: 78 }, trade_date: "2026-09-19", live: false,
};
/** 全面走弱的这一天，正好落在本表地板上：−6−5−5−5−3−3−6+0 = −33 */
const WEAK: MarketInput = {
  advancers: 600, decliners: 4500, total: 5100, median_pct: -2.3,
  index: { symbol: "000001.SH", label: "上证指数", change_pct: -2.1 },
  limit_up: 4, limit_down: 42, break_rate: 63, main_net_sum_yi: -580,
  risk_level: "高风险", themes: { main_count: 0, top_score: null }, trade_date: "2026-09-19", live: false,
};
/** 每个分项都取本表能给的最高档（用来证明极值是可达的，不是纸面求和） */
const CEILING: MarketInput = { ...STRONG, advancers: 5200, decliners: 0, median_pct: 9.99, index: { symbol: "000001.SH", label: "上证指数", change_pct: 10 }, limit_up: 100, limit_down: 0, break_rate: 0, main_net_sum_yi: 1000, themes: { main_count: 6, top_score: 95 } };
const EMPTY: MarketInput = {
  advancers: null, decliners: null, median_pct: null, index: null, limit_up: null, limit_down: null,
  break_rate: null, main_net_sum_yi: null, risk_level: null, themes: null,
};

const byRule = (items: ReturnType<typeof marketItems>, rule: string) => items.find((i) => i.rule === rule)!;
const fullTech: TechnicalInput = { ma5: 12, ma10: 11, ma20: 10, close: 12.5, dif: 0.4, dea: 0.2, dif_prev: 0.1, dea_prev: 0.15, bar: 0.4, bar_prev: 0.3, rsi: 62, rsi_period: 14 };
const probHigh = (win_rate: number): ProbabilityInput => ({
  engine: "similar_env",
  readings: [{ horizon: 1, win_rate, sample_size: 200, trade_date: "2026-09-19", period: { start: "2024-08-06", end: "2026-08-20" } }],
});

test("P7-③ 出处：版本号不是 taskbook 前缀，每条 note 带出处；P7-④ 接线后内核登记的仍是这张表", () => {
  assert.equal(MARKET_RULE_VERSION, "p7.s3.market.v1");
  assert.ok(!MARKET_RULE_VERSION.startsWith("p7.taskbook"), "把本层的表标成任务书原文 = 给一个没人定过的分数找出处");
  // P7-① 把这一格写成 null 是因为那时真的没有这张表；P7-③ 补表、P7-④ 接线后它等于本表的版本号。
  // 「登记的是哪张表」与「这张表不是任务书原文」是两件事，后一件必须继续可断言。
  assert.equal(RULE_VERSIONS.market, MARKET_RULE_VERSION);
  assert.match(MARKET_RULE_PROVENANCE, /非任务书原文/);
  for (const i of marketItems(STRONG)) {
    if (i.points !== null) assert.ok((i.note ?? "").includes(MARKET_RULE_PROVENANCE), `${i.rule} 的 note 没带出处声明`);
  }
  // P7-① 的入口纪律不变：不带 rule_version 就等于没带规则 ⇒ 仍然未计入，不给 0 分
  const bare = buildDecision({ external: [{ key: "market", score: 22, rule_version: "" }] });
  assert.equal(bare.included.includes("market"), false);
  assert.match(bare.excluded.find((e) => e.key === "market")!.reason, /没有传入打分结果|不替它把「没算」写成 0 分/);
});

test("P7-③ 全缺输入：八个分项全 null、整维度 score=null，理由进 missing[] 而不是补一个 0", () => {
  const d = marketDimension(EMPTY);
  assert.equal(d.items.length, 8);
  assert.ok(d.items.every((i) => i.points === null), "一条读数都没有时任何分项给 0 分都是伪造");
  assert.equal(d.score, null);
  assert.equal(d.status, "MISSING");
  assert.match(d.missing.join(" / "), /不会用空分母/);
  const dec = buildDecision({ external: [marketExternal(EMPTY)] });
  assert.equal(dec.final_score, null);
  assert.equal(dec.grade, null);
  assert.deepEqual(dec.excluded.map((e) => e.key).sort(), ["event", "market", "probability", "technical"]);
});

test("P7-③ 正常输入：逐项档位、总分、以及「缺一项只说那一项」的降级", () => {
  const s = marketDimension(STRONG);
  assert.equal(s.score, 22, "广度+3 中位+2 指数+2 涨跌停净差+4 炸板+2 主力+1 风险+4 主线+4");
  assert.equal(s.status, "DERIVED");
  assert.deepEqual(s.missing, [], "读数齐全 ⇒ 缺口清单为空，不靠兜底文案凑数");
  assert.equal(marketDimension(WEAK).score, -33);
  assert.equal(marketDimension(WEAK).score, MARKET_EXTREMES.min, "WEAK 这组输入就是地板的实证");
  const partial = marketDimension({ ...STRONG, themes: null, break_rate: null });
  assert.equal(partial.status, "DEGRADED", "两项算不出 ⇒ 降级，但其余项照算（P7-① 技术面同一条纪律）");
  assert.equal(partial.score, 22 - 4 - 2, "缺的两项不进求和，也不用 0 顶替");
  assert.match(partial.missing.join(" / "), /有 2 个市场面分项算不出/);
  assert.equal(byRule(partial.items, "M-BREADTH").points, 3, "一项缺不会让别的项归零");
});

test("P7-③ 值域自证：CEILING/WEAK 真的打到 MARKET_EXTREMES 两端，并与 scoreBounds 对账", () => {
  assert.ok(marketItems(CEILING).every((i) => i.points !== null), "上限那组必须八项全可算，否则极值对账不成立");
  assert.equal(marketDimension(CEILING).score, MARKET_EXTREMES.max);
  assert.equal(MARKET_EXTREMES.max, 30);
  assert.equal(MARKET_EXTREMES.min, -33);
  const w = DEFAULT_WEIGHTS;
  assert.equal(Math.round(MARKET_EXTREMES.max * w.market * 100) / 100, 6, "市场面对综合得分的最大贡献 = 30×0.2");
  assert.equal(Math.round(MARKET_EXTREMES.min * w.market * 100) / 100, -6.6);
  // P7-④ 接线后不再有「attainable 是两维口径」这个偏差：marketExternal() 会把本表的极值随
  // ExternalDimension.bounds 一起交进内核，所以传了市场面的那次决策，区间上限就要等于
  // 本表上限×生效权重 + 其余各维的上限。这里用**精确等式**替掉原来那条「会低估」的不等式。
  const b = buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(WEAK)] });
  assert.deepEqual(b.weights.applied, { technical: 0.4444, probability: 0.3333, market: 0.2222, event: 0 });
  // 42.8 = 55×0.4444 + 35×0.3333 + 30×0.2222；−34.6 = −35×0.4444 − 35×0.3333 − 33×0.2222
  assert.deepEqual(b.attainable, { min: -34.6, max: 42.8, unreachable_grades: [] }, "市场面的 ± 极值已经进区间：P7-① 那套「上限 32.5」两维口径在这里不再出现");
  assert.equal(b.dimensions.find((x) => x.key === "market")!.rule_version, MARKET_RULE_VERSION);
  assert.ok(MARKET_EXTREMES.min * DEFAULT_WEIGHTS.market <= -6, "市场面单独就能贡献 ≤ −6 ⇒ 四维下综合得分可以跌破 −30，「看跌」档自此不再依赖权重巧合才可达");
  assert.equal(gradeForScore(-31), "看跌", "A1.1 的 <−30 判据（可达性核对用，不是本层新发明）");
});

test("P7-③ 缺数据 ≠ 0 分 ≠ 脏数据：炸板率与主力净额这两个「引擎会补 0」的坑分开走", () => {
  const br = (v: number | null) => byRule(marketItems({ ...STRONG, break_rate: v }), "M-BREAK");
  assert.equal(br(null).points, null);
  assert.match(br(null).note ?? "", /触板 0 家、比率无定义/, "sentiment.ts:86 的 null 必须原样传上来");
  assert.equal(br(0)!.points, 2, "真 0% 炸板才吃 +2");
  assert.equal(br(120).points, null, "越界读数不判定：脏数据不能变成一个分数");
  assert.equal(br(40)!.points, -3, "左闭右开：40 归 ≥40 档");
  assert.equal(br(39.9)!.points, 0);

  const flow = (v: number | null) => byRule(marketItems({ ...STRONG, main_net_sum_yi: v }), "M-MAINFLOW");
  assert.equal(flow(null).points, null);
  assert.match(flow(null).note ?? "", /\?\? 0/, "文案点名 sentiment.ts:83 的累加写法，接线的人才知道那个 0 是从哪来的");
  assert.equal(flow(0)!.points, 0);
  assert.match(flow(0)!.note ?? "", /读数存在、按表归入 0 分/, "0 亿是读数，不是算不出");
});

test("P7-③ 涨跌家数：0/0 不判定（不当五五开也不给 0）；下跌 0 家用占比而不是比值，天然避开除零", () => {
  const zero = marketItems({ ...STRONG, advancers: 0, decliners: 0, total: 0 });
  assert.equal(byRule(zero, "M-BREADTH").points, null);
  assert.match(byRule(zero, "M-BREADTH").note ?? "", /占比无定义/);
  assert.ok(!/占比 50%/.test(byRule(zero, "M-BREADTH").raw), "不得把 0/0 当成五五开");
  assert.equal(byRule(marketItems({ ...STRONG, decliners: 0 }), "M-BREADTH").points, 6, "下跌 0 家 ⇒ 占比 1 ⇒ 普涨档");
});

test("P7-③ 指数分项不猜基准：没给指数就不判定；给了涨跌幅但没给名字时 raw 里不出现「上证指数」", () => {
  const none = byRule(marketItems({ ...STRONG, index: null }), "M-INDEX");
  assert.equal(none.points, null);
  assert.match(none.note ?? "", /不替它选一条/);
  const anonymous = marketItems({ ...STRONG, index: { symbol: null, label: null, change_pct: 1.2 } });
  assert.equal(byRule(anonymous, "M-INDEX").points, 4);
  assert.match(byRule(anonymous, "M-INDEX").raw, /未命名指数/);
  assert.ok(!/上证指数/.test(byRule(anonymous, "M-INDEX").raw), "来源不明的指数读数不能在结论里长得像有出处的上证指数");
  const idx = marketItems({ ...STRONG, index: { symbol: "399006.SZ", label: "创业板指", change_pct: null } });
  assert.equal(byRule(idx, "M-INDEX").points, null, "有名字没读数 ⇒ 仍算不出");
});

test("P7-③ 风险等级：四档逐档给分，枚举外的值不判定；note 明写它与其它分项同源", () => {
  assert.deepEqual(MARKET_RISK_POINTS, { 正常: 4, 注意: -2, 偏高: -4, 高风险: -6 });
  for (const lv of Object.keys(MARKET_RISK_POINTS) as (keyof typeof MARKET_RISK_POINTS)[]) {
    assert.equal(byRule(marketItems({ ...STRONG, risk_level: lv }), "M-RISK").points, MARKET_RISK_POINTS[lv]);
  }
  assert.equal(byRule(marketItems({ ...STRONG, risk_level: "极端" as never }), "M-RISK").points, null, "不在引擎枚举里的等级不映射，也不新增一档");
  assert.match(byRule(marketItems({ ...STRONG, risk_level: null }), "M-RISK").note ?? "", /不是 0 分/);
  assert.match(byRule(marketItems(STRONG), "M-RISK").note ?? "", /同源/);
  assert.match(MARKET_RISK_NOTE, /不能当成独立证据/);
});

test("P7-③ 主线：0 个主线是读数（计 0），引擎没跑是缺失（不判定），口径异常的组合登记而不硬给分", () => {
  const none = marketItems({ ...STRONG, themes: { main_count: 0, top_score: null } });
  assert.equal(byRule(none, "M-THEME").points, 0);
  assert.match(byRule(none, "M-THEME").note ?? "", /不是缺数据/);
  assert.equal(byRule(marketItems({ ...STRONG, themes: null }), "M-THEME").points, null);
  assert.equal(byRule(marketItems({ ...STRONG, themes: { main_count: null, top_score: null } }), "M-THEME").points, null);
  const odd = marketItems({ ...STRONG, themes: { main_count: 4, top_score: 40 } });
  assert.equal(byRule(odd, "M-THEME").points, null, "主线数量够但榜首强度 <60：登记为口径异常，不解释成强势也不给 0");
  assert.match(byRule(odd, "M-THEME").note ?? "", /口径异常/);
  assert.equal(byRule(marketItems({ ...STRONG, themes: { main_count: 2, top_score: 90 } }), "M-THEME").points, 2);
});

test("P7-③ 分档边界：每个档的 min 只命中自己一档，右开端点必被下一档接住（不重不漏）", () => {
  const tables: (typeof MARKET_BREADTH_BANDS)[] = [
    MARKET_BREADTH_BANDS, MARKET_MEDIAN_BANDS, MARKET_INDEX_BANDS, MARKET_LIMITNET_BANDS, MARKET_BREAK_BANDS, MARKET_MAFLOW_BANDS, MARKET_THEME_BANDS,
  ];
  for (const bands of tables) {
    for (const b of bands) {
      if (b.max === null) continue;
      assert.equal(bands.filter((x) => x.min === b.max).length, 1, `右端 ${b.max} 必须被且只被下一档的 min 接住`);
      assert.equal(pickBand(bands, b.max)!.min, b.max, `边界值 ${b.max} 归下一档（左闭）`);
      assert.notEqual(pickBand(bands, b.max)!.points, undefined);
    }
  }
  assert.equal(pickBand(MARKET_MAFLOW_BANDS, 299.99)!.points, 1);
  // 净差 −20 归「−20~−6 家」这一档（左闭），−21 才进 ≤−20 档：标签与判定必须同向，
  // 上一条测试跑的就是这个接住关系；这里再点一次是因为涨跌停两侧都数得清时最容易写错端点。
  assert.equal(pickBand(MARKET_LIMITNET_BANDS, -20)!.points, -2);
  assert.equal(pickBand(MARKET_LIMITNET_BANDS, -21)!.points, -5);
  assert.equal(pickBand(MARKET_LIMITNET_BANDS, -5)!.points, 0, "−5 属于「相当」档：跌停多于涨停从 −6 家起算");
  assert.equal(pickBand(MARKET_BREADTH_BANDS, 0.399)!.points, -3);
});

test("P7-③ 时间戳：盘内外状态回显；没有 trade_date 时整维度降级并登记，不静默", () => {
  assert.match(byRule(marketItems({ ...STRONG, live: true }), "M-BREADTH").raw, /盘中实时/);
  assert.match(byRule(marketItems({ ...STRONG, live: false }), "M-BREADTH").raw, /收盘\/休市/);
  const undated = marketDimension({ ...STRONG, trade_date: null });
  assert.equal(undated.status, "DEGRADED");
  assert.match(undated.missing.join(" / "), /没有 trade_date/);
  assert.match(byRule(undated.items, "M-BREADTH").raw, /读数所属日未给出/);
  assert.equal(undated.score, 22, "日期缺失不改变数字（读数是真的），改的是它能不能被当成当日事实引用");
});

test("P7-③ 文案：不出现「可信度/置信度/把握度 xx%」，每个百分号都有真实读数出处，且不出现概率字样", () => {
  for (const input of [STRONG, WEAK, CEILING, EMPTY]) {
    const text = marketItems(input).map((i) => `${i.label} ${i.points ?? "无"}｜${i.raw}｜${i.note ?? ""}`).join("\n");
    assert.ok(!/可信度|置信度|把握度/.test(text), text);
    assert.ok(!/概率|胜率/.test(text), "市场面不得出现概率字样：那是概率面的口径，凭空出现会牵动 probabilityCheck 的三项概率要求");
    for (const m of text.match(/(\d+(\.\d+)?)%/g) ?? []) {
      const line = text.split("\n").find((l) => l.includes(m))!;
      assert.ok(/占比|中位|涨跌幅|指数|涨跌|炸板/.test(line), `百分号 ${m} 出现在没有真实读数出处的行里：${line}`);
    }
  }
});

test("P7-③ 接进决策内核：市场面参与加权（22/100），并真的改变字面结论", () => {
  const withMarket = buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(WEAK)] });
  const without = buildDecision({ technical: fullTech, probability: probHigh(60) });
  assert.deepEqual(withMarket.included, ["technical", "probability", "market"], "事件面本次没传 ⇒ 仍按未计入处理");
  assert.equal(without.final_score, 33.6, "55×0.5714 + 5×0.4286");
  assert.equal(without.grade, "看涨");
  assert.equal(withMarket.weights.applied.market, 0.2222, "0.2 / (0.4+0.3+0.2) 重归一");
  const mk = withMarket.dimensions.find((x) => x.key === "market")!;
  assert.equal(mk.score, -33);
  assert.equal(mk.rule_version, MARKET_RULE_VERSION);
  assert.equal(withMarket.final_score, 18.8, "55×0.4444 + 5×0.3333 − 33×0.2222");
  assert.equal(withMarket.grade, "偏强震荡", "弱市场把「看涨」拉回「偏强震荡」：这才叫参与了加权，而不是挂个名字");
  assert.ok(withMarket.weights.renormalized);
  const text = decisionToText(withMarket);
  assert.match(text, /市场环境：-33 分（生效权重 22\/100，分层 DERIVED）/);
  assert.match(text, /· 普跌（上涨占比 <25%） -6｜上涨 600 家 \/ 下跌 4500 家（占比 11\.8%）/, "分项归因与真实读数要出现在文本里");
  assert.match(text, /未计入（不是 0 分，是没算）：\n  事件影响/, "没传事件面时仍走未计入出口（理由文案变了，出口本身没变）");
  assert.ok(!/可信度\s*[:：]?\s*\d+(\.\d+)?%/.test(text));
});

test("P7-④ 接线后：不传 external 时内核仍走「未计入」出口，只是把该找的表指出来", () => {
  const d = buildDecision({});
  assert.match(d.basis, /市场=p7\.s3\.market\.v1/, "口径行印的是 P7-③ 那张表的版本号（出处仍是 p7.s3.*，不是 taskbook）");
  assert.match(d.dimensions.find((x) => x.key === "market")!.missing.join(""), /没有传入打分结果/, "没传读数就还是未计入 —— 补表不等于给缺失数据兜底");
  assert.equal(d.final_score, null, "四维一条都没传 ⇒ 依旧不给综合分，P7-① 的空输入出口一字未改");
  assert.equal(d.protocol_version, DECISION_PROTOCOL_VERSION);
});
