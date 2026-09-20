// P7-③ 事件面打分规则表的单元测试（node --test 直跑，无 DB / 无网络 / 无时钟）。
//
// 事件面比市场面多一层风险：它的输入**本身就是 AI 的解释**（P6-B 落库的 impact_direction /
// impact_scope / importance / confidence）。所以这套测试钉的是「解释层怎么被换算成分数而不变质」：
// 1) 出处：本表不是任务书 §六 原文 —— 版本号 p7.s3.event.v1、每条 note 带出处，另有一条测试专门禁止冒充 taskbook；
// 2) 缺失三条路：算不出（null）/ 读数存在按表归 0 / 枚举外脏数据不判定，压成同一个数字就是伪造结论；
// 3) 三条防越界各自对应至少一条测试：confidence 不参与计算、不被条数灌分、旧闻不算今天的扰动；
// 4) 分层诚实：能算出来的分项一律 AI_INTERPRETATION，绝不写成 REAL/DERIVED；
// 5) 文案不出现「概率/胜率/可信度」，且本层没有任何百分比读数 —— 出现 % 就是凭空造的。
//
// 全部输入都是**合成的事件批次**（用来验查表逻辑），不是任何一天的真实快讯库内容。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIRECTIONAL, EVENT_EXTREMES, EVENT_HIGH_BANDS, EVENT_RULE_PROVENANCE, EVENT_RULE_VERSION,
  EVENT_SCOPE_POINTS, EVENT_STALE_AFTER_DAYS_DEFAULT, EVENT_SUBJECT_BANDS, EVENT_TILT_MAGNITUDE_BANDS,
  IMPORTANCE_WEIGHTS, MARKET_WIDE_SCOPE, dayGap, eventDimension, eventExternal, eventItems,
  pickBand, tiltBand, type EventInput, type EventSignal,
} from "../../src/lib/quant/screener/event-score-core.ts";
import {
  DEFAULT_WEIGHTS, RULE_VERSIONS, buildDecision, decisionToText, scoreBounds, type ProbabilityInput, type ScoreItem, type TechnicalInput,
} from "../../src/lib/quant/screener/decision-core.ts";
import { MARKET_EXTREMES, marketExternal } from "../../src/lib/quant/screener/market-score-core.ts";
import type { MarketInput } from "../../src/lib/quant/screener/market-score-core.ts";

const REF = "2026-09-19";
const sig = (id: string, over: Partial<EventSignal> = {}): EventSignal => ({
  event_id: id, trade_date: REF, impact_direction: null, impact_scope: "板块", importance: "中",
  confidence: null, interpretation_status: "INTERPRETED", relates_to_subject: null, ...over,
});

/** 偏多的一天：E-TILT 加权倾向 (5−1)/6=+0.67 ⇒ +10、E-HIGH 净多 1 条 ⇒ +3、E-SCOPE 有市场整体级利好 ⇒ +5、E-SUBJECT 未给标的 ⇒ null ⇒ 18 */
const BULLISH: EventInput = {
  ref_date: REF,
  events: [
    sig("e1", { impact_direction: "利好", importance: "高", impact_scope: MARKET_WIDE_SCOPE, confidence: 0.7 }),
    sig("e2", { impact_direction: "利好", importance: "中", impact_scope: "行业", confidence: 0.6 }),
    sig("e3", { impact_direction: "利空", importance: "低", impact_scope: "个股", confidence: 0.5 }),
    sig("e4", { impact_direction: "双向", importance: "中", confidence: 0.4 }),
  ],
};
/** 同一批事件，但调用方给了标的且 P6-B 判了两条相关 ⇒ E-SUBJECT 净多 2 条 ⇒ +4，总分 22 */
const BULLISH_SUBJECT: EventInput = {
  ...BULLISH, subject: "300750.SZ",
  events: BULLISH.events.map((e) => ({ ...e, relates_to_subject: e.event_id === "e1" || e.event_id === "e2" })),
};
/** 四个分项全取地板：−10 −6 −5 −4 = −25 = EVENT_EXTREMES.min */
const FLOOR: EventInput = {
  ref_date: REF, subject: "宁德时代",
  events: [
    sig("b1", { impact_direction: "利空", importance: "高", impact_scope: MARKET_WIDE_SCOPE, confidence: 0.8, relates_to_subject: true }),
    sig("b2", { impact_direction: "利空", importance: "高", impact_scope: "行业", confidence: 0.9, relates_to_subject: true }),
  ],
};
/** 镜像的另一端：+10 +6 +5 +4 = +25 = EVENT_EXTREMES.max */
const CEILING: EventInput = {
  ...FLOOR,
  events: FLOOR.events.map((e) => ({ ...e, impact_direction: "利好" })),
};
/** 利多利空对冲：读数存在 ⇒ 0 分，不是「算不出」 */
const OFFSET: EventInput = {
  ref_date: REF,
  events: [
    sig("p1", { impact_direction: "利好", importance: "中" }),
    sig("p2", { impact_direction: "利好", importance: "中" }),
    sig("q1", { impact_direction: "利空", importance: "中" }),
    sig("q2", { impact_direction: "利空", importance: "中" }),
  ],
};
/** 市场面的接线对照（四维齐全时用） */
const MARKET_STRONG: MarketInput = {
  advancers: 3300, decliners: 1700, total: 5000, median_pct: 0.8,
  index: { symbol: "000001.SH", label: "上证指数", change_pct: 0.5 },
  limit_up: 45, limit_down: 6, break_rate: 15, main_net_sum_yi: 210,
  risk_level: "正常", themes: { main_count: 4, top_score: 78 }, trade_date: REF, live: false,
};

const byRule = (items: ScoreItem[], rule: string) => items.find((i) => i.rule === rule)!;
const fullTech: TechnicalInput = { ma5: 12, ma10: 11, ma20: 10, close: 12.5, dif: 0.4, dea: 0.2, dif_prev: 0.1, dea_prev: 0.15, bar: 0.4, bar_prev: 0.3, rsi: 62, rsi_period: 14 };
const probHigh = (win_rate: number): ProbabilityInput => ({
  engine: "similar_env",
  readings: [{ horizon: 1, win_rate, sample_size: 200, trade_date: REF, period: { start: "2024-08-06", end: "2026-08-20" } }],
});

test("P7-③ 出处：事件面版本号不是 taskbook 前缀，note 全带出处；P7-④ 接线后内核登记的仍是这张表", () => {
  assert.equal(EVENT_RULE_VERSION, "p7.s3.event.v1");
  assert.ok(!EVENT_RULE_VERSION.startsWith("p7.taskbook"), "本层的表标成任务书原文 = 给一个没人定过的分数找出处（市场面同一条纪律）");
  // P7-① 那一格是 null，因为那时没有这张表；现在内核登记的就是本表的版本号，前缀区分仍然成立。
  assert.equal(RULE_VERSIONS.event, EVENT_RULE_VERSION);
  assert.match(EVENT_RULE_PROVENANCE, /非任务书原文/);
  for (const i of eventItems(BULLISH).items) {
    if (i.points !== null) assert.ok((i.note ?? "").includes(EVENT_RULE_PROVENANCE), `${i.rule} 的 note 没带出处声明`);
  }
  const bare = buildDecision({ external: [{ key: "event", score: 18, rule_version: "" }] });
  assert.equal(bare.included.includes("event"), false);
  assert.match(bare.excluded.find((e) => e.key === "event")!.reason, /没有传入打分结果|不替它把「没算」写成 0 分/);
});

test("P7-③ 缺失三条路之一「算不出」：当日 0 条事件 ⇒ 四个分项全 null、score=null，不补一个 0 分的中性", () => {
  const d = eventDimension({ ref_date: REF, events: [] });
  assert.equal(d.items.length, 4);
  assert.ok(d.items.every((i) => i.points === null), "库里当日没有事件与「消息面中性」是两件事，全给 0 就是伪造");
  assert.equal(d.score, null);
  assert.equal(d.status, "MISSING");
  assert.match(d.missing.join(" / "), /不会用空分母/);
  assert.match(byRule(d.items, "E-TILT").note ?? "", /不是 0 分，也不是「消息面中性」/);
  assert.equal(d.tally.total, 0);
  const dec = buildDecision({ external: [eventExternal({ ref_date: REF, events: [] })] });
  assert.equal(dec.final_score, null);
  assert.equal(dec.grade, null);
  assert.deepEqual(dec.excluded.map((e) => e.key).sort(), ["event", "market", "probability", "technical"]);
});

test("P7-③ 正常输入：逐项档位、总分 18，给了标的且判为相关才涨到 22", () => {
  const s = eventDimension(BULLISH);
  assert.equal(s.score, 18, "E-TILT +10、E-HIGH +3、E-SCOPE +5，E-SUBJECT 无标的不计");
  assert.equal(byRule(s.items, "E-TILT").points, 10, "加权倾向 (5−1)/6 = +0.67 ⇒ 一边倒档");
  assert.equal(byRule(s.items, "E-HIGH").points, 3);
  assert.equal(byRule(s.items, "E-SCOPE").points, EVENT_SCOPE_POINTS.bull);
  assert.equal(byRule(s.items, "E-SUBJECT").points, null);
  const withSubject = eventDimension(BULLISH_SUBJECT);
  assert.equal(byRule(withSubject.items, "E-SUBJECT").points, 4);
  assert.equal(withSubject.score, 22);
  assert.equal(withSubject.status, "AI_INTERPRETATION");
  assert.deepEqual(eventDimension(FLOOR).missing, [], "FLOOR 这批事件字段齐全、方向齐全 ⇒ 缺口清单为空，不靠兜底文案凑数");
});

test("P7-③ 值域自证：CEILING/FLOOR 真打到 ±25，事件面天然对称，与 scoreBounds 的对账写清两维口径", () => {
  assert.equal(eventDimension(CEILING).score, EVENT_EXTREMES.max);
  assert.equal(eventDimension(FLOOR).score, EVENT_EXTREMES.min);
  assert.deepEqual(EVENT_EXTREMES, { min: -25, max: 25 });
  assert.equal(EVENT_EXTREMES.min, -EVENT_EXTREMES.max, "四个分项都是净差/倾向的双向档 ⇒ 不该出现市场面那种 ±不对称");
  const w = DEFAULT_WEIGHTS;
  assert.equal(Math.round(EVENT_EXTREMES.max * w.event * 100) / 100, 2.5, "事件面 10/100 权重下最多贡献 ±2.5，短期扰动就该是这个量级");
  // P7-④ 接线：极值随 eventExternal() 的 bounds 进内核后，四维区间就是 −33.6 ~ +41；
  // 而**不带极值**时仍是两维口径的 32.5（差 8.5 分）。两个数都钉住，是为了让人一眼看出
  // 「漏传 bounds」会静默把区间报窄，而不是让某个调用方拿两维区间当四维区间读。
  const b = scoreBounds(DEFAULT_WEIGHTS);
  assert.equal(b.max, 32.5, "55×0.4 + 35×0.3：这是不建模外部维度时的上限");
  const four = scoreBounds(DEFAULT_WEIGHTS, { market: MARKET_EXTREMES, event: EVENT_EXTREMES });
  assert.equal(four.max, 41, "四维真实上限：55×0.4 + 35×0.3 + 30×0.2 + 25×0.1");
  assert.equal(four.min, -33.6, "四维真实地板：−35×0.4 − 35×0.3 − 33×0.2 − 25×0.1");
  assert.equal(Math.round((b.max + MARKET_EXTREMES.max * w.market + EVENT_EXTREMES.max * w.event) * 10) / 10, 41, "两维口径与四维口径的差值恰好等于两张表极值的加权和");
});

test("P7-③ 防越界①：confidence 不参与计算 —— 同批事件换把握度分数一字不变，只在 raw 里回显", () => {
  const hi = eventDimension({ ...FLOOR, events: FLOOR.events.map((e) => ({ ...e, confidence: 0.99 })) });
  const lo = eventDimension({ ...FLOOR, events: FLOOR.events.map((e) => ({ ...e, confidence: 0.01 })) });
  assert.equal(hi.score, lo.score, "把模型的自我把握当系数去乘分数 = 把 AI 的口气伪装成市场概率");
  assert.equal(hi.score, -25);
  assert.match(byRule(hi.items, "E-TILT").raw, /模型把握度 0\.99/);
  assert.match(byRule(hi.items, "E-TILT").raw, /不参与打分/);
  const none = eventDimension({ ...FLOOR, events: FLOOR.events.map((e) => ({ ...e, confidence: null })) });
  assert.equal(none.score, -25, "没有 confidence 也照样算，缺的只是可解释性");
  assert.match(none.missing.join(" / "), /没有 confidence/);
  assert.match(byRule(none.items, "E-TILT").raw, /本批无读数/);
});

test("P7-③ 防越界②：不被条数灌分 —— 1 条利好与 10 条利好的 E-TILT 同档（事件面答的是偏向，不是抓到几条）", () => {
  const one = eventDimension({ ref_date: REF, events: [sig("x1", { impact_direction: "利好", importance: "中" })] });
  const ten = eventDimension({
    ref_date: REF,
    events: Array.from({ length: 10 }, (_, i) => sig(`x${i + 1}`, { impact_direction: "利好", importance: "中" })),
  });
  assert.equal(one.score, 10);
  assert.equal(ten.score, one.score, "10 条同样一边倒的利好不该比 1 条多 9 分：那只反映抓取窗口的长短");
  assert.equal(byRule(ten.items, "E-TILT").points, byRule(one.items, "E-TILT").points);
  assert.match(byRule(ten.items, "E-TILT").raw, /与条数无关/);
  assert.match(byRule(ten.items, "E-TILT").raw, /10 条\[x1、x2…另 8 条\]/, "样本条数与 event_id 要留在血缘里，但只列前两条");
  // 真正起作用的是重要度权重而不是条数：条数多的一侧完全可能落在 0 档
  const weighted = eventDimension({
    ref_date: REF,
    events: [
      sig("y1", { impact_direction: "利好", importance: "低" }),
      sig("y2", { impact_direction: "利好", importance: "低" }),
      sig("y3", { impact_direction: "利空", importance: "高" }),
    ],
  });
  assert.equal(byRule(weighted.items, "E-TILT").points, 0, "(2−3)/5 = −0.2 ⇒ 相抵档：3 条里有 2 条利好也不给加分，1 条高级利空就把方向抵掉了");
});

test("P7-③ 防越界③：旧闻不算今天的扰动 —— 超过 stale_after_days 剔除并登记，收紧/放宽窗口都走调用方", () => {
  const OLD: EventInput = { ref_date: REF, events: [sig("o1", { impact_direction: "利好", importance: "高", trade_date: "2026-09-01" })] };
  const d = eventDimension(OLD);
  assert.equal(d.score, null, "唯一的利好是 18 天前的旧闻：整维度算不出，而不是给一个「消息面偏多」");
  assert.equal(d.tally.stale, 1);
  assert.match(d.missing.join(" / "), /剔除 1 条早于参考日 3 天以上/);
  assert.equal(eventDimension({ ...OLD, stale_after_days: 30 }).score, 13, "窗口放宽到 30 天后同一条事件就能吃 E-TILT +10 与 E-HIGH +3（范围是 板块，故 E-SCOPE 记 0）");
  assert.equal(EVENT_STALE_AFTER_DAYS_DEFAULT, 3);
  const mixed = eventDimension({ ...BULLISH, events: [sig("fresh", { impact_direction: "利空", importance: "高", trade_date: REF }), ...BULLISH.events.map((e) => ({ ...e, trade_date: "2026-01-05" }))] });
  assert.equal(mixed.tally.stale, 4);
  assert.equal(byRule(mixed.items, "E-TILT").points, -10, "剔除旧闻后这批只剩一条高级利空 ⇒ 一边倒偏空");
});

test("P7-③ 不采信的状态：REJECTED 与没跑过解读的一律不进净差，剔除原因留在 missing[]（不静默少算）", () => {
  const MIXED: EventInput = {
    ref_date: REF,
    events: [
      sig("m1", { impact_direction: "利好", importance: "高", interpretation_status: "REJECTED" }),
      sig("m2", { impact_direction: "利好", importance: "高", interpretation_status: null }),
      sig("m3", { impact_direction: "利好", importance: "中" }),
    ],
  };
  const d = eventDimension(MIXED);
  assert.deepEqual(d.tally, { total: 3, usable: 1, rejected: 1, not_interpreted: 1, stale: 0, no_date: 0, non_directional: 0, unknown_importance: 0 });
  assert.equal(byRule(d.items, "E-HIGH").points, 0, "两条高级利好一条被服务端判 REJECTED、一条没解读过 ⇒ 高重要度净差不为它们计数");
  assert.equal(byRule(d.items, "E-TILT").points, 10, "剩下那条中等重要度的利好是真的可采信 ⇒ 该给的档照给");
  assert.equal(d.score, 10);
  const miss = d.missing.join(" / ");
  assert.match(miss, /REJECTED/);
  assert.match(miss, /没有可用的 AI 解读/);
  assert.match(miss, /只有标题不足以定方向/);
});

test("P7-③ 缺失三条路之二「读数存在按表归 0」：利多利空对冲是 0 分，与「算不出」不同一条路", () => {
  const d = eventDimension(OFFSET);
  assert.equal(d.score, 0);
  assert.equal(d.status, "AI_INTERPRETATION");
  const tilt = byRule(d.items, "E-TILT");
  assert.equal(tilt.points, 0);
  assert.match(tilt.note ?? "", /读数存在、按表归入 0 分，不是算不出/);
  assert.equal(byRule(d.items, "E-HIGH").points, 0);
  assert.equal(byRule(d.items, "E-SCOPE").points, EVENT_SCOPE_POINTS.none);
  assert.match(byRule(d.items, "E-SCOPE").note ?? "", /不是缺数据；0 分不等于利好/);
  assert.match(d.missing.join(" / "), /有 1 个事件面分项算不出/, "只有 E-SUBJECT 没标的 ⇒ 登记而不是当成 0");
});

test("P7-③ 方向取值决定采信：双向/中性/未知 不进净差也不猜成利好；枚举外的值同样不判定", () => {
  const ND = eventDimension({ ref_date: REF, events: [sig("n1", { impact_direction: "中性" }), sig("n2", { impact_direction: "未知" }), sig("n3", { impact_direction: "双向" })] });
  assert.equal(byRule(ND.items, "E-TILT").points, null, "三条都不带方向 ⇒ 倾向无定义，不判成 +0 也不判成「消息面偏多」");
  assert.match(byRule(ND.items, "E-TILT").note ?? "", /倾向无定义，不判成 \+0/);
  assert.equal(ND.score, 0, "E-HIGH/E-SCOPE 仍是可算读数 ⇒ 整维度不是 MISSING");
  assert.equal(ND.status, "AI_INTERPRETATION");
  assert.match(ND.missing.join(" / "), /3 条事件的影响方向是 双向\/中性\/未知/);
  assert.deepEqual([...DIRECTIONAL], ["利好", "利空"]);
  const dirty = eventDimension({ ref_date: REF, events: [sig("d1", { impact_direction: "偏多" as never })] });
  assert.equal(byRule(dirty.items, "E-TILT").points, null);
  assert.match(dirty.missing.join(" / "), /不在 P6-B 枚举里/);
  assert.equal(byRule(eventDimension({ ref_date: REF, events: [sig("i1", { impact_direction: "利好", importance: "无法判断" })] }).items, "E-TILT").points, null, "重要度「无法判断」的带方向事件不做「默认按中」的凑数");
});

test("P7-③ E-SCOPE 三态：偏多 +5 / 偏空 −5 / 并存取 0 且明写不净相消", () => {
  const scope = (list: EventSignal[]) => byRule(eventDimension({ ref_date: REF, events: list }).items, "E-SCOPE");
  assert.equal(scope([sig("s1", { impact_direction: "利好", impact_scope: MARKET_WIDE_SCOPE })])!.points, 5);
  assert.equal(scope([sig("s2", { impact_direction: "利空", impact_scope: MARKET_WIDE_SCOPE })])!.points, -5);
  const both = scope([
    sig("s3", { impact_direction: "利好", impact_scope: MARKET_WIDE_SCOPE }),
    sig("s4", { impact_direction: "利空", impact_scope: MARKET_WIDE_SCOPE }),
  ]);
  assert.equal(both!.points, 0);
  assert.match(both!.note ?? "", /不净相消/);
  assert.equal(both!.label, "市场整体级事件利多利空并存或均无方向");
  const nd = scope([sig("s5", { impact_direction: "双向", impact_scope: MARKET_WIDE_SCOPE })]);
  assert.equal(nd!.points, 0, "有市场整体级事件但都没方向 ⇒ 也是 0，并写清「均无方向」");
  const none = scope([sig("s6", { impact_direction: "利好", impact_scope: "个股" })]);
  assert.equal(none!.points, 0);
  assert.match(none!.label, /当日没有影响范围＝市场整体 的事件/);
});

test("P7-③ E-SUBJECT 三种「不打分」：没标的（不适用）/ 没有相关性判定（不猜）/ 判定全为不相关（另有含义）", () => {
  const noSubject = byRule(eventItems({ ref_date: REF, events: BULLISH.events }).items, "E-SUBJECT");
  assert.equal(noSubject.points, null);
  assert.match(noSubject.note ?? "", /不适用与算不出都不是 0 分/);
  const unflagged = byRule(eventItems({ ...BULLISH, subject: "300750.SZ" }).items, "E-SUBJECT");
  assert.equal(unflagged.points, null);
  assert.match(unflagged.note ?? "", /不拿标题去猜相关/);
  const allFalse = byRule(eventItems({ ...BULLISH, subject: "300750.SZ", events: BULLISH.events.map((e) => ({ ...e, relates_to_subject: false })) }).items, "E-SUBJECT");
  assert.equal(allFalse.points, null);
  assert.match(allFalse.note ?? "", /「不相关」不等于/);
  const rel = byRule(eventItems(BULLISH_SUBJECT).items, "E-SUBJECT");
  assert.equal(rel.points, 4);
  const withNonDir = byRule(eventItems({
    ...BULLISH, subject: "宁德时代",
    events: BULLISH.events.map((e) => ({ ...e, relates_to_subject: e.event_id !== "e3" })),
  }).items, "E-SUBJECT");
  assert.match(withNonDir.note ?? "", /另有 1 条相关事件不带方向，未计入净差/, "e4 是双向：算进「相关」条数但不进净差，得写出来");
});

test("P7-③ 分档：幅度档不重不漏，且多空两侧端点完全对称（±0.6、±0.3 同档不同号）", () => {
  for (const b of EVENT_TILT_MAGNITUDE_BANDS) {
    if (b.max === null) continue;
    assert.equal(EVENT_TILT_MAGNITUDE_BANDS.filter((x) => x.min === b.max).length, 1, `右端 ${b.max} 必须被下一档的 min 接住`);
    assert.equal(pickBand(EVENT_TILT_MAGNITUDE_BANDS, b.max)!.min, b.max);
  }
  assert.equal(tiltBand(0.6).points, 10);
  assert.equal(tiltBand(-0.6).points, -10, "带符号写法会把 −0.6 判进 −6 档而 +0.6 判进 +10 档：同幅度不同分是查表边角，不是设计");
  assert.equal(tiltBand(0.3).points, 6);
  assert.equal(tiltBand(-0.3).points, -6);
  assert.equal(tiltBand(0.29).points, 0);
  assert.equal(tiltBand(-0.29).points, 0);
  assert.equal(tiltBand(1).points, 10);
  assert.equal(tiltBand(-1).points, -10);
  assert.match(tiltBand(-0.65).label, /偏空/);
  for (const v of [1, 2, 3]) {
    assert.equal(-pickBand(EVENT_HIGH_BANDS, v)!.points, pickBand(EVENT_HIGH_BANDS, -v)!.points, `E-HIGH 在 ±${v} 处必须对称`);
    assert.equal(-pickBand(EVENT_SUBJECT_BANDS, v)!.points, pickBand(EVENT_SUBJECT_BANDS, -v)!.points);
  }
  assert.deepEqual(IMPORTANCE_WEIGHTS, { 高: 3, 中: 2, 低: 1 });
});

test("P7-③ dayGap 纯日期差：格式不合法返回 null（不用本地时区、不猜日期）", () => {
  assert.equal(dayGap(REF, REF), 0);
  assert.equal(dayGap(REF, "2026-09-16"), 3);
  assert.equal(dayGap("2026-09-01", "2026-08-31"), 1, "跨月按日历日");
  assert.equal(dayGap(REF, "2026-09-21"), -2, "未来日期为负：本层不按过期处理");
  for (const bad of [null, "", "   ", "2026/09/16", "09/16/2026", "2026-13-01", "not-a-date"]) {
    assert.equal(dayGap(REF, bad), null, `${JSON.stringify(bad)} 不是合法 ISO 日期，必须返回 null 而不是猜一个`);
  }
  assert.equal(eventDimension({ ref_date: "参考日不明", events: [sig("z1", { impact_direction: "利好", importance: "高" })] }).tally.no_date, 1, "参考日不合法 ⇒ 该条按「无日期」登记并仍参与计算，不静默剔除");
});

test("P7-③ 分层诚实：可算分项一律 AI_INTERPRETATION，绝不写成 REAL/DERIVED", () => {
  for (const input of [BULLISH, BULLISH_SUBJECT, FLOOR, CEILING, OFFSET]) {
    for (const i of eventItems(input).items) {
      assert.equal(i.status, i.points === null ? "MISSING" : "AI_INTERPRETATION", `${i.rule} 的分层被写成了 ${i.status}`);
    }
    assert.notEqual(eventDimension(input).status, "DERIVED");
    assert.notEqual(eventDimension(input).status, "REAL");
  }
  const dec = buildDecision({ technical: fullTech, probability: probHigh(60), external: [eventExternal(BULLISH)] });
  assert.ok(dec.layers.includes("AI_INTERPRETATION"), "layers 里要能看到这一维的解释成分来自模型");
  assert.ok(!dec.layers.includes("REAL"), "事件面不得借道把 AI 解释抬成事实层");
});

test("P7-③ 文案：不出现「概率/胜率/可信度/置信度」，把握度必须与「不参与打分」同句，且不出现任何百分号", () => {
  for (const input of [BULLISH, BULLISH_SUBJECT, FLOOR, CEILING, OFFSET]) {
    const items = eventItems(input).items;
    const text = items.map((i) => `${i.label} ${i.points ?? "无"}｜${i.raw}｜${i.note ?? ""}`).join("\n");
    assert.ok(!/概率|胜率|可信度|置信度/.test(text), text);
    assert.ok(!text.includes("%"), "事件面没有任何百分比读数（模型把握度是 0~1 的小数），出现 % 就是凭空造的");
    for (const line of text.split("\n")) {
      if (line.includes("把握度")) assert.ok(line.includes("不参与打分") || line.includes("不影响分数"), `把握度出现在没有「不参与打分」声明的行里：${line}`);
    }
    for (const m of eventDimension(input).missing) assert.ok(!/概率|胜率/.test(m), m);
  }
});

test("P7-③ 接进决策内核：事件面参与加权（缺市场面时重归一为 13/100，四维齐全时是 10/100），并真的改变字面结论", () => {
  const three = buildDecision({ technical: fullTech, probability: probHigh(60), external: [eventExternal(BULLISH)] });
  assert.deepEqual(three.included, ["technical", "probability", "event"], "没传市场面 ⇒ 仍按未计入处理");
  assert.equal(three.weights.applied.event, 0.125, "0.1 / (0.4+0.3+0.1) 重归一");
  assert.equal(three.final_score, 31.6, "55×0.5 + 5×0.375 + 18×0.125");
  const ev = three.dimensions.find((x) => x.key === "event")!;
  assert.equal(ev.score, 18);
  assert.equal(ev.rule_version, EVENT_RULE_VERSION);
  const marketOnly = buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(MARKET_STRONG)] });
  assert.equal(marketOnly.final_score, 31, "带上市场面、还没事件面时是 看涨");
  const four = buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(MARKET_STRONG), eventExternal(BULLISH)] });
  assert.deepEqual(four.included, ["technical", "probability", "market", "event"]);
  assert.equal(four.weights.renormalized, false, "四维齐全 ⇒ 就是任务书 §七 的 40/30/20/10，没有重归一");
  assert.equal(four.weights.applied.event, 0.1);
  assert.equal(four.final_score, 29.7, "55×0.4 + 5×0.3 + 22×0.2 + 18×0.1：事件面这 1.8 分把结论按在「看涨」线（30）下面");
  assert.equal(four.grade, "偏强震荡", "同一份技术/概率/市场读数，只因为带上了事件面就换了字面结论 ⇒ 加权是真的发生了");
  const text = decisionToText(four);
  assert.match(text, /事件影响：\+18 分（生效权重 10\/100，分层 AI_INTERPRETATION）/);
  assert.match(text, /· 消息面一边倒偏多（\|加权倾向\| ≥ 0\.6） \+10｜利好 2 条（权重 5）／利空 1 条（权重 1）/, "分项归因、加权倾向与真实条数都要进文本");
  assert.match(text, /缺口【事件影响】1 条事件的影响方向是 双向\/中性\/未知/, "剔除登记也走 decisionToText 的缺口行，不只留在 JSON 里");
  const subjectText = decisionToText(buildDecision({ external: [eventExternal(BULLISH_SUBJECT)] }));
  assert.match(subjectText, /与「300750\.SZ」相关：利好 2 条 \/ 利空 0 条/, "标的相关的原始计数要见人");
  assert.match(subjectText, /事件影响：\+22 分（生效权重 100\/100/);
});

test("P7-④ 接线后：不传 external 时事件面仍走「未计入」出口，且本层依旧不查库、不取时钟", () => {
  const d = buildDecision({});
  assert.match(d.basis, /事件=p7\.s3\.event\.v1/, "口径行印的是 P7-③ 那张表的版本号（出处仍是 p7.s3.*，不是 taskbook）");
  const ev = d.dimensions.find((x) => x.key === "event")!;
  assert.equal(ev.rule_version, null, "没有传入读数 ⇒ 本层不替它把版本号填上，规则版本只能由调用方带进来");
  assert.match(ev.missing.join(""), /没有传入打分结果/, "没传读数就还是未计入 —— 补表不等于给缺失数据兜底");
  assert.equal(d.final_score, null, "四维一条都没传 ⇒ 依旧不给综合分，P7-① 的空输入出口一字未改");
  assert.equal(eventDimension(BULLISH).tally.total, 4, "本层只吃传入的事件数组：不查库、不取时钟（ref_date 由调用方给）");
});
