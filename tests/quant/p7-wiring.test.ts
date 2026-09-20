// P7-④ 接线层单元测试（tests/quant/p7-wiring.test.ts）。
//
// 覆盖对象是 decision-wiring-core.ts 里那些「把上游补出来的 0 还原成缺失」的判断 —— 它们是全流程里最容易
// 悄悄失真的一格：规则表只看见一个数字，看不出它是真读数还是 `?? 0` 的产物。所以这里的断言重点不是算得对不对，
// 而是**什么情况下本层必须拒绝把数字交下去**。
//
// 全部输入都是合成读数：收盘价序列是等比/等差构造，sentiment / themes / similar-env / event_interpretation 的
// 形状按各自源码的返回结构手写。**这些数字不是任何一天的真实行情，也不是任何一条真实快讯的解释**，
// 只用于验字段语义。真实数据的端到端行为在 `next build` + `next start` 下另行实测（不在 node --test 里打网络）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_INDEX, PROBABILITY_SCOPE_NOTE, RSI_PERIOD_DEFAULT, WIRING_VERSION,
  eventsFromInterpretations, interpretationWireFromRow, marketFromWiring,
  probabilityFromSimilarEnv, relatesToSubject, technicalFromBars, themesWire, windowStart,
  type InterpretationWire, type SentimentWire,
} from "../../src/lib/quant/screener/decision-wiring-core.ts";
import { buildDecision, DECISION_PROTOCOL_VERSION, DEFAULT_WEIGHTS, type Decision } from "../../src/lib/quant/screener/decision-core.ts";
import { marketExternal, MARKET_EXTREMES, MARKET_RULE_VERSION } from "../../src/lib/quant/screener/market-score-core.ts";
import { eventExternal, EVENT_EXTREMES, EVENT_RULE_VERSION } from "../../src/lib/quant/screener/event-score-core.ts";
import type { BarsLike } from "../../src/lib/quant/factors/fields.ts";
import type { SimilarEnvStats } from "../../src/lib/quant/screener/similar-env.ts";

/** 合成日期序列：从 2026-01-02 起逐日递增（纯 UTC 算法，不吃本地时区，保证严格升序可排序） */
const ymd = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

/** 等比上涨的合成日K：前 n 根，每日 +1%（不是行情，只是让 MA/MACD/RSI 有确定取值） */
function rampBars(n: number, start = 100): BarsLike[] {
  const out: BarsLike[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = +(c * 1.01).toFixed(4);
    out.push({ date: ymd(i + 1), o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1000 + i });
  }
  return out;
}

function sentimentWire(over: Partial<SentimentWire> = {}): SentimentWire {
  return {
    trade_date: "2026-09-18", live: false, total: 5000, advancers: 3000, decliners: 1800,
    limit_up: 60, limit_down: 8, break_rate: 25, main_net_sum_yi: 120, main_net_known: 4800,
    median_pct: 0.6, indices: [{ symbol: "000001.SH", changePct: 0.52 }, { symbol: "399006.SZ", changePct: 1.9 }],
    risk_level: "正常", ...over,
  };
}

function simStats(over: Partial<SimilarEnvStats> = {}): SimilarEnvStats {
  return {
    today_return: 0.5, band: 0.8, sample_size: 220, sample_ok: true,
    period: { start: "2024-08-06", end: "2026-08-20" },
    horizons: [
      { h: 1, win_rate: 55, sample_size: 220, avg_return: 0.2, median_return: 0.1, worst_return: -4 },
      { h: 5, win_rate: 52, sample_size: 210, avg_return: 0.8, median_return: 0.5, worst_return: -9 },
      { h: 20, win_rate: 48, sample_size: 180, avg_return: 2.1, median_return: 1.4, worst_return: -15 },
    ],
    warnings: [], ...over,
  };
}

function itpRow(over: Partial<InterpretationWire> = {}): InterpretationWire {
  return {
    event_id: "k-1", trade_date: "2026-09-18", title: "合成事件标题",
    impact_direction: "利好", impact_scope: "行业", importance: "高", confidence: 0.7,
    interpretation_status: "INTERPRETED", affected_symbols: ["600519"], entities: [], ...over,
  };
}

const dim = (d: Decision, key: string) => d.dimensions.find((x) => x.key === key)!;
const itemOf = (d: Decision, key: string, rule: string) => dim(d, key).items.find((i) => i.rule === rule)!;

// ---------- 市场面接线 ----------

test("P7-④ 主力净额：一家都没抓到 mainNet 时，?? 0 累加出来的 0 亿必须还原成缺失", () => {
  const { input, notes } = marketFromWiring(sentimentWire({ main_net_known: 0, main_net_sum_yi: 0 }), { main_count: 2, top_score: 71 });
  assert.equal(input.main_net_sum_yi, null, "0 家是「没读到」，不能宣称「今日主力净额 0 亿」");
  assert.ok(notes.some((n) => n.includes("?? 0")), notes.join("｜"));
  // 对照：确认过口径（有 4800 家带字段）时 0 亿是真读数，原样交下去
  assert.equal(marketFromWiring(sentimentWire({ main_net_known: 4800, main_net_sum_yi: 0 }), null).input.main_net_sum_yi, 0);
  // 服务层没能确认家数时同样按缺失处理，不替它猜一个口径
  const unknown = marketFromWiring(sentimentWire({ main_net_known: null }), null);
  assert.equal(unknown.input.main_net_sum_yi, null);
  assert.ok(unknown.notes.some((n) => n.includes("没能确认")), unknown.notes.join("｜"));
});

test("P7-④ 中位涨跌幅与基准指数：total=0 时引擎补的 0 不进门；指数取不到就带着名字记缺失", () => {
  const empty = marketFromWiring(sentimentWire({ total: 0, median_pct: 0 }), null);
  assert.equal(empty.input.median_pct, null, "pcts 为空时 sentiment 的 median 是补出来的 0，不是「中位数正好 0%」");
  assert.ok(empty.notes.some((n) => n.includes("还原成缺失")), empty.notes.join("｜"));

  const missingIdx = marketFromWiring(sentimentWire({ indices: [{ symbol: "399001.SZ", changePct: 1.2 }] }), null);
  assert.deepEqual(missingIdx.input.index, { symbol: BASE_INDEX.symbol, label: BASE_INDEX.label, change_pct: null });
  assert.ok(missingIdx.notes.some((n) => n.includes(BASE_INDEX.label)), missingIdx.notes.join("｜"));
  // 别的指数涨幅再大也不顶：换基准指数＝换结论口径，接线层不擅自换
  const d = buildDecision({ external: [marketExternal(missingIdx.input)] });
  assert.equal(itemOf(d, "market", "M-INDEX").points, null);
  assert.match(itemOf(d, "market", "M-INDEX").raw, /上证指数/, "raw 里要看得出「本来要读的是哪一条指数」");

  const badNum = marketFromWiring(sentimentWire({ indices: [{ symbol: BASE_INDEX.symbol, changePct: null }] }), null);
  assert.equal(badNum.input.index?.change_pct, null);
});

test("P7-④ 市场面整面取数失败：8 个分项全部算不出，而不是市场环境 0 分", () => {
  const { input, notes } = marketFromWiring(null, null);
  assert.ok(notes.some((n) => n.includes("没有取到任何读数")), notes.join("｜"));
  const d = buildDecision({ external: [marketExternal(input)] });
  const m = dim(d, "market");
  assert.equal(m.score, null, "整维度全缺 ⇒ null，交给内核把权重从分母里拿掉");
  assert.equal(m.status, "MISSING");
  assert.equal(d.final_score, null);
  assert.equal(d.excluded.find((e) => e.key === "market") !== undefined, true);
});

test("P7-④ 主线：themes 读取失败(null) 与 跑了但 0 条主线 是两个不同的事实", () => {
  const noRun = marketFromWiring(sentimentWire(), null);
  assert.equal(noRun.input.themes, null);
  const zeroMain = marketFromWiring(sentimentWire(), { main_count: 0, top_score: null });
  assert.deepEqual(zeroMain.input.themes, { main_count: 0, top_score: null });
  const d = buildDecision({ external: [marketExternal(zeroMain.input)] });
  const t = itemOf(d, "market", "M-THEME");
  assert.equal(t.points, 0, "「未判出主线」是读数，按表归 0 分");
  assert.match(t.raw, /主线 0 个/, t.raw);
  const d2 = buildDecision({ external: [marketExternal(noRun.input)] });
  assert.equal(itemOf(d2, "market", "M-THEME").points, null, "没跑成 ⇒ 不判定，与「跑了但 0 个」不共享一个 0");
});

test("P7-④ themesWire：不假设引擎排过序，榜首取真实最大值；缺分数的行不参与", () => {
  assert.deepEqual(themesWire([{ score: 61 }, { score: 88 }, { score: 73 }]), { main_count: 3, top_score: 88 });
  assert.deepEqual(themesWire([]), { main_count: 0, top_score: null });
  assert.deepEqual(themesWire([{ score: NaN }, { score: 40 }]), { main_count: 2, top_score: 40 }, "NaN 不是榜首强度");
});

// ---------- 技术面接线 ----------

test("P7-④ 技术面读数按序列位置取：只有 1 根日K时拿不到前一日，金叉分项就是不判定（不回退到上一个非空值）", () => {
  const one = technicalFromBars([{ date: "2026-09-18", o: 10, h: 10.2, l: 9.9, c: 10.1, v: 100 }]);
  assert.equal(one.input.close, 10.1);
  assert.equal(one.input.dif_prev, null, "lastValues 会回退到「最后一个非 null」，这里绝不允许：没有前一日就是没有");
  assert.equal(one.input.bar_prev, null);
  assert.equal(one.input.ma20, null, "20 日均线要够长才算得出，本层不补值");
  assert.equal(one.bar_date, "2026-09-18");
  assert.equal(one.bars_used, 1);
  const d = buildDecision({ technical: one.input });
  assert.equal(itemOf(d, "technical", "T-MACD-CROSS").points, null);
  assert.match(itemOf(d, "technical", "T-MACD-CROSS").note ?? "", /缺前一天/, "note 仍要点明为什么不复用因子面板的 crossUp");
  assert.ok(one.notes.every((n) => !n.includes("重复日期")));
});

test("P7-④ 技术面：等比上涨的合成序列 ⇒ 多头排列 + MA20 精确等于末 20 根均值", () => {
  const bars = rampBars(60);
  const w = technicalFromBars(bars);
  const c = bars.map((b) => b.c);
  const mean20 = c.slice(-20).reduce((a, b) => a + b, 0) / 20;
  assert.equal(Math.round((w.input.ma20 as number) * 1e6), Math.round(mean20 * 1e6), `MA20=${w.input.ma20} 对照 ${mean20}`);
  assert.ok((w.input.ma5 as number) > (w.input.ma10 as number) && (w.input.ma10 as number) > (w.input.ma20 as number));
  assert.equal(w.input.rsi_period, RSI_PERIOD_DEFAULT, "周期由本层选定并记账（任务书 §六 没指定）");
  assert.equal(w.bars_used, 60);
  const d = buildDecision({ technical: w.input });
  assert.equal(itemOf(d, "technical", "T-MA-STRUCT").points, 20);
  assert.equal(itemOf(d, "technical", "T-VOLUME").points, null, "§六 无成交量打分表：只登记不计分");
});

test("P7-④ 技术面：乱序与重复日期的日K先归正再取数，无可用K线时明确登记", () => {
  const bars = rampBars(40);
  const dup = [...bars.slice(0, 20), ...bars.slice(15)]; // 制造 5 根重复日期
  const w = technicalFromBars(dup);
  assert.equal(w.bars_used, bars.length, "重复日期只留一根");
  assert.ok(w.notes.some((n) => n.includes("重复日期")), w.notes.join("｜"));
  assert.equal(w.bar_date, bars[bars.length - 1].date.slice(0, 10), "乱序输入按日期升序后取最后一根");
  const none = technicalFromBars([]);
  assert.equal(none.input.close, null);
  assert.ok(none.notes.some((n) => n.includes("没有任何可用日K")), none.notes.join("｜"));
  const short = technicalFromBars(rampBars(12));
  assert.ok(short.notes.some((n) => n.includes("日K只有 12 根")), short.notes.join("｜"));
});

// ---------- 概率面接线 ----------

test("P7-④ 概率面：口径声明随读数一起交上去，打分表没有的期限丢弃并登记", () => {
  const stats = simStats({ horizons: [...simStats().horizons, { h: 60, win_rate: 40, sample_size: 60, avg_return: null, median_return: null, worst_return: null }] });
  const { input, notes } = probabilityFromSimilarEnv(stats, { trade_date: "2026-09-18" });
  assert.equal(input?.engine, "similar_env");
  assert.deepEqual(input?.readings.map((r) => r.horizon), [1, 5, 20]);
  assert.equal(input?.readings[0].period?.start, "2024-08-06", "样本区间必须带进血缘，否则事后无法重建");
  assert.ok(notes[0] === PROBABILITY_SCOPE_NOTE, notes.join("｜"));
  assert.ok(notes.some((n) => n.includes("60 日期限")), notes.join("｜"));
  const d = buildDecision({ probability: input! });
  assert.equal(dim(d, "probability").status, "HISTORICAL", "概率面是历史统计，不是对今天的预测");
});

test("P7-④ 概率面：win_rate=null 保持 null；period 缺失与整面缺失各登记一条", () => {
  const noRate = probabilityFromSimilarEnv(simStats({
    sample_ok: false, sample_size: 0, period: null,
    horizons: [
      { h: 1, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null },
      { h: 5, win_rate: 52, sample_size: 12, avg_return: null, median_return: null, worst_return: null },
      { h: 20, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null },
    ],
  }), { trade_date: "2026-09-18" });
  assert.equal(noRate.input?.readings[0].win_rate, null, "引擎给 null 就是算不出，不许换成 0%");
  assert.ok(noRate.notes.some((n) => n.includes("样本区间") || n.includes("给不出")), noRate.notes.join("｜"));
  const d = buildDecision({ probability: noRate.input! });
  assert.equal(itemOf(d, "probability", "P-1D").points, null);
  assert.match(dim(d, "probability").missing.join(""), /1 日：本次没有可用的上涨概率读数/);
  const none = probabilityFromSimilarEnv(null, { trade_date: null });
  assert.equal(none.input, null);
  assert.ok(none.notes.some((n) => n.includes("按缺失处理")), none.notes.join("｜"));
});

// ---------- 事件面接线 ----------

test("P7-④ 事件面：库里为空 / 读取失败 / 只有不相关标的，三种「没有分」互不合并", () => {
  const failed = eventsFromInterpretations(null, { ref_date: "2026-09-18", subject: "600519.SH" });
  assert.equal(failed.input.events.length, 0);
  assert.ok(failed.notes.some((n) => n.includes("读取失败")), failed.notes.join("｜"));
  const empty = eventsFromInterpretations([], { ref_date: "2026-09-18", subject: "600519.SH" });
  assert.ok(empty.notes.some((n) => n.includes("不会自动生成")), empty.notes.join("｜"));
  for (const [label, rows] of [["读取失败", failed.input], ["当日为空", empty.input]] as const) {
    const d = buildDecision({ external: [eventExternal(rows)] });
    assert.equal(dim(d, "event").score, null, `${label}都不给分`);
    assert.equal(d.final_score, null);
    // 接线层是「带着规则版本进来的」：版本号留在血缘里，分数照样不出——
    // 这跟 P7-③ 那条「什么都不传 ⇒ rule_version 为 null」是两条不同的路，两者都要钉住。
    assert.equal(dim(d, "event").rule_version, "p7.s3.event.v1", "版本由接线层带进来，内核不改写");
    assert.equal(dim(d, "event").status, "MISSING");
    assert.equal(dim(d, "event").weight_applied, 0, "算不出的维度权重要从分母拿掉");
    assert.equal(dim(d, "event").items.length, 4, "四个分项都要以 points=null 的形态留在归因里");
    assert.ok(dim(d, "event").items.every((i) => i.points === null));
    assert.match(dim(d, "event").items.find((i) => i.rule === "E-TILT")!.note ?? "", /算不出/, "为什么没分要写在意见里，不能只剩一句「没算出得分」");
    assert.match(d.excluded.find((e) => e.key === "event")!.reason, /自带规则/, "剔除原因要说明它带了规则却没算出分");
  }
});

test("P7-④ 标的相关性：清单为空是「没判定」，不是「判定为不相关」", () => {
  assert.equal(relatesToSubject({ affected_symbols: [], entities: [] }, ["600519"]), null);
  assert.equal(relatesToSubject({ affected_symbols: ["600519"], entities: [] }, ["600519"]), true);
  assert.equal(relatesToSubject({ affected_symbols: ["000001"], entities: ["某某公司"] }, ["600519", "贵州茅台"]), false);
  const rows = [itpRow({ affected_symbols: [], entities: [] }), itpRow({ event_id: "k-2", affected_symbols: ["600519"] })];
  const { input } = eventsFromInterpretations(rows, { ref_date: "2026-09-18", subject: "600519.SH", subject_tokens: ["600519.SH", "600519", "贵州茅台"] });
  assert.equal(input.events[0].relates_to_subject, null);
  assert.equal(input.events[1].relates_to_subject, true);
  // 没给标的 ⇒ 整分项不适用（E-SUBJECT 不打分，但事件面其它三项照算）
  const noSubject = eventsFromInterpretations(rows, { ref_date: "2026-09-18" });
  assert.equal(noSubject.input.subject, null);
  assert.equal(noSubject.input.events[1].relates_to_subject, null);
  const d = buildDecision({ external: [eventExternal(noSubject.input)] });
  assert.equal(itemOf(d, "event", "E-SUBJECT").points, null);
  assert.ok(dim(d, "event").score !== null, "标的项不适用不影响其余三项计分");
  // 给了标的却没传名称/代码清单 ⇒ 登记为「无判定」，不拿标题猜
  const noTokens = eventsFromInterpretations([itpRow()], { ref_date: "2026-09-18", subject: "600519.SH", subject_tokens: [] });
  assert.ok(noTokens.notes.some((n) => n.includes("没传标的名称与代码") || n.includes("无判定")), noTokens.notes.join("｜"));
});

test("P7-④ payload 解析：坏 JSON / 数组 / 缺字段都按缺失，状态列优先于模型原文", () => {
  const broken = interpretationWireFromRow({ eventKey: "e1", asOf: "2026-09-18", title: "T", status: "INTERPRETED", payload: "{不是JSON" });
  assert.equal(broken.wire, null);
  assert.match(broken.broken ?? "", /e1/, "坏行要能追回是哪一行");
  assert.equal(interpretationWireFromRow({ eventKey: "e2", asOf: null, title: null, status: null, payload: "[1,2]" }).wire, null, "数组不是解释结构");
  const noPayload = interpretationWireFromRow({ eventKey: "e3", asOf: null, title: null, status: null, payload: null });
  assert.equal(noPayload.wire, null, "payload 空列不生成一条字段全空的「读数」");
  assert.match(noPayload.broken ?? "", /没有落库/, "「没落库」与「解析不出对象」是两个事实，措辞要分开");
  assert.match(interpretationWireFromRow({ eventKey: "e3b", asOf: null, title: null, status: null, payload: "   " }).broken ?? "", /没有落库/, "空白串同空列");
  const sparse = interpretationWireFromRow({ eventKey: "e4", asOf: "2026-09-18", title: "标题", status: "PARTIAL", payload: JSON.stringify({ confidence: "0.8", affected_symbols: ["600519.SH", "", 7] }) });
  const w = sparse.wire!;
  assert.equal(w.impact_direction, null, "payload 里没有的字段就是 null，不猜方向");
  assert.equal(w.confidence, null, "字符串「0.8」不是把握度读数：类型不符按缺失");
  assert.deepEqual(w.affected_symbols, ["600519.SH"], "非字符串项剔除");
  assert.equal(w.interpretation_status, "PARTIAL", "以服务端复校验后的状态列为准");
  assert.equal(w.trade_date, "2026-09-18");
});

test("P7-④ 事件新鲜度窗口起点用纯日期算法，跨月跨年不借本地时区", () => {
  assert.equal(windowStart("2026-09-20", 3), "2026-09-17");
  assert.equal(windowStart("2026-09-20", 30), "2026-08-21");
  assert.equal(windowStart("2026-01-05", 10), "2025-12-26");
  assert.equal(windowStart("2026-09-20", 0), "2026-09-20");
  assert.equal(windowStart("不是日期", 3), "不是日期", "格式不符时原样退回，调用方自己按缺失处理");
});

// ---------- 端到端：接线层的输出必须能被三张表直接吃下 ----------

test("P7-④ 四维齐全时接线产物直接进 buildDecision：规则版本、bounds、分层都由接线层带齐", () => {
  const market = marketFromWiring(sentimentWire(), { main_count: 4, top_score: 82 });
  const prob = probabilityFromSimilarEnv(simStats(), { trade_date: "2026-09-18" });
  const tech = technicalFromBars(rampBars(60));
  const events = eventsFromInterpretations([itpRow(), itpRow({ event_id: "k2", impact_direction: "利空", importance: "低" })],
    { ref_date: "2026-09-18", subject: "600519.SH", subject_tokens: ["600519"] });
  const d = buildDecision({
    technical: tech.input,
    probability: prob.input!,
    external: [marketExternal(market.input), eventExternal(events.input)],
    subject: "600519.SH",
  });
  assert.equal(d.protocol_version, DECISION_PROTOCOL_VERSION);
  assert.deepEqual(d.included, ["technical", "probability", "market", "event"]);
  assert.equal(d.weights.renormalized, false);
  assert.deepEqual(d.weights.applied, DEFAULT_WEIGHTS);
  assert.equal(dim(d, "market").rule_version, MARKET_RULE_VERSION);
  assert.equal(dim(d, "event").rule_version, EVENT_RULE_VERSION);
  assert.ok(d.layers.includes("HISTORICAL") && d.layers.includes("AI_INTERPRETATION"), d.layers.join(","));
  assert.equal(typeof d.final_score, "number");
  // P7-④ 第一步的成果：极值由接线层随 marketExternal/eventExternal 带进内核
  assert.deepEqual(d.attainable, { min: -33.6, max: 41, unreachable_grades: [] }, "四维齐全 ⇒ 可达区间就是 −33.6 ~ +41，「看跌」不再是死档");
  assert.doesNotMatch(d.basis, /区间比真实区间窄/, "接线后每一维都带了 bounds，不该再有这条登记");
  assert.ok(WIRING_VERSION.startsWith("p7.s4."), WIRING_VERSION);
  assert.ok(MARKET_EXTREMES.min <= -30 && EVENT_EXTREMES.max >= 20);
});

test("P7-④ 接线层不发明维度：只传技术面时，市场/事件/概率仍走「未计入」并且不报错", () => {
  const tech = technicalFromBars(rampBars(60));
  const d = buildDecision({ technical: tech.input });
  assert.deepEqual(d.included, ["technical"]);
  assert.equal(d.final_score, 25, "只有技术面：55/−35 那张表的实际取值，权重被归一到 100/100");
  assert.equal(d.weights.applied.technical, 1);
  assert.deepEqual(d.attainable, { min: -35, max: 55, unreachable_grades: [] }, "单维时区间就是那张表自身的上下限");
  assert.ok(d.excluded.length === 3);
});
