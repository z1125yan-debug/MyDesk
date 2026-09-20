// P7-④/⑦ 接线层单元测试（tests/quant/p7-wiring.test.ts）。
//
// 覆盖对象是 decision-wiring-core.ts 里那些「把上游补出来的 0 还原成缺失」的判断 —— 它们是全流程里最容易
// 悄悄失真的一格：规则表只看见一个数字，看不出它是真读数还是 `?? 0` 的产物。所以这里的断言重点不是算得对不对，
// 而是**什么情况下本层必须拒绝把数字交下去**。
//
// v2 → v3 的升级（P7-⑦⑤，逐条写明为什么变，不删测试意图、不降低断言强度）：
// 1) 市场面从 8 个计分分项变成「10 计分 + 2 判定依据」，且当日涨跌幅那条（v2 的 M-INDEX）已降为 basis
//    ⇒ 原来按 M-INDEX 取分项的两处改取 M-INDEX-PCT，并额外钉住「raw 里仍要看得出本来要读哪一条指数」这条老纪律；
// 2) 接线层新增两格读数（全 A 成交额 amount_total_yi/amount_known、榜首主线 top_rps/rps_scope）与两个可选输入
//    （基准指数日K、成交额历史基线）⇒ fixture 补齐，并新增「新读数没供上时必须登记缺失而不是凑分」的专项测试；
// 3) 概率面 v3 必须有 primary_horizon ⇒ 打分项变成 P-SAMPLE/P-WINRATE/P-PAYOFF（非主周期降为 basis），
//    原来按 P-1D 取分项的一处改取 P-WINRATE；
// 4) 刻度从「字面分直接加权」变成「每维按本维极值折算到 ±100 再加权」⇒ 所有分值/区间断言按实测出的新数字改写，
//    并且每个维度都同时钉 score（字面）／norm_score（折算）／bounds（尺子）三件事，防止只看一个数字就对不上账。
//
// 全部输入都是合成读数：收盘价序列是等比/等差构造，sentiment / themes / similar-env / event_interpretation 的
// 形状按各自源码的返回结构手写。**这些数字不是任何一天的真实行情，也不是任何一条真实快讯的解释**，
// 只用于验字段语义。真实数据的端到端行为在 `next build` + `next start` 下另行实测（不在 node --test 里打网络）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_INDEX, INDEX_MA_WINDOW_DEFAULT, PROBABILITY_SCOPE_NOTE, PRIMARY_HORIZON_DEFAULT, RSI_PERIOD_DEFAULT, TURNOVER_MIN_PRIOR_DAYS, TURNOVER_SCOPE, WIRING_VERSION,
  eventsFromInterpretations, interpretationWireFromRow, marketFromWiring,
  probabilityFromSimilarEnv, relatesToSubject, technicalFromBars, themesWire, turnoverBaseline, windowStart,
  type InterpretationWire, type SentimentWire, type TurnoverDayWire,
} from "../../src/lib/quant/screener/decision-wiring-core.ts";
import { buildDecision, DECISION_PROTOCOL_VERSION, DEFAULT_WEIGHTS, type Decision } from "../../src/lib/quant/screener/decision-core.ts";
import { marketExternal, MARKET_EXTREMES, MARKET_LEGACY_RULE_VERSION, MARKET_RULE_VERSION } from "../../src/lib/quant/screener/market-score-core.ts";
import { eventExternal, EVENT_EXTREMES, EVENT_LEGACY_RULE_VERSION, EVENT_RULE_VERSION } from "../../src/lib/quant/screener/event-score-core.ts";
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

/**
 * computeSentiment 的返回形状（合成）。v3 比 v2 多两格：全 A 成交额与其「真实有值」的家数 ——
 * 它和主力净额是同一个 `?? 0` 累加套路，缺这一格就等于把「一家都没读到」说成「今日成交 0 亿」。
 */
function sentimentWire(over: Partial<SentimentWire> = {}): SentimentWire {
  return {
    trade_date: "2026-09-18", live: false, total: 5000, advancers: 3000, decliners: 1800,
    limit_up: 60, limit_down: 8, break_rate: 25, main_net_sum_yi: 120, main_net_known: 4800,
    amount_total_yi: 9800, amount_known: 4900,
    median_pct: 0.6, indices: [{ symbol: "000001.SH", changePct: 0.52 }, { symbol: "399006.SZ", changePct: 1.9 }],
    risk_level: "正常", ...over,
  };
}

/** 近 6 个交易日的成交额留档（合成）：9050~9300 亿，六个一起用时日均 9175 亿 ⇒ today 9800/9175=1.07 落「持平」档 */
function priorTurnover(over: Partial<TurnoverDayWire> = {}): TurnoverDayWire[] {
  return [1, 2, 3, 4, 5, 6].map((i) => ({ trade_date: `2026-09-${10 + i}`, amount_total_yi: 9000 + i * 50, amount_known: 4800, ...over }));
}

/** 基准指数日K（合成等比序列）：够 20 根 ⇒ M-IDX-MA20 可算，且收盘在均线之上 */
function indexBars(n = 30) {
  return rampBars(n).map((b) => ({ date: b.date, c: b.c }));
}

/** 把三样外部读数一次性接齐（市场面「四维齐全」那条测试用的就是这个组合） */
function marketWired(s: SentimentWire | null = sentimentWire(), themes = themesWire([{ score: 82, rps: 91 }], "合并榜内涨幅百分位")) {
  return marketFromWiring(s, themes, { index_bars: indexBars(), prior_turnover: priorTurnover(), exclude_trade_date: "2026-09-18" });
}

function simStats(over: Partial<SimilarEnvStats> = {}): SimilarEnvStats {
  return {
    today_return: 0.5, band: 0.8, sample_size: 220, sample_ok: true,
    period: { start: "2024-08-06", end: "2026-08-20" },
    horizons: [
      { h: 1, win_rate: 55, sample_size: 220, avg_return: 0.2, median_return: 0.1, worst_return: -4, payoff_ratio: 1.4, avg_win: 0.9, avg_loss: -0.64, win_samples: 121, loss_samples: 99 },
      { h: 5, win_rate: 52, sample_size: 210, avg_return: 0.8, median_return: 0.5, worst_return: -9, payoff_ratio: 1.6, avg_win: 2.4, avg_loss: -1.5, win_samples: 109, loss_samples: 101 },
      { h: 20, win_rate: 48, sample_size: 180, avg_return: 2.1, median_return: 1.4, worst_return: -15, payoff_ratio: 1.1, avg_win: 5.2, avg_loss: -4.7, win_samples: 86, loss_samples: 94 },
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
const roleOf = (d: Decision, key: string, rule: string) => itemOf(d, key, rule).role;

// ---------- 市场面接线 ----------

test("P7-④ 主力净额：一家都没抓到 mainNet 时，?? 0 累加出来的 0 亿必须还原成缺失", () => {
  const { input, notes } = marketFromWiring(sentimentWire({ main_net_known: 0, main_net_sum_yi: 0 }), themesWire([]));
  assert.equal(input.main_net_sum_yi, null, "0 家是「没读到」，不能宣称「今日主力净额 0 亿」");
  assert.ok(notes.some((n) => n.includes("?? 0")), notes.join("｜"));
  // 对照：确认过口径（有 4800 家带字段）时 0 亿是真读数，原样交下去
  assert.equal(marketFromWiring(sentimentWire({ main_net_known: 4800, main_net_sum_yi: 0 }), null).input.main_net_sum_yi, 0);
  // 服务层没能确认家数时同样按缺失处理，不替它猜一个口径
  const unknown = marketFromWiring(sentimentWire({ main_net_known: null }), null);
  assert.equal(unknown.input.main_net_sum_yi, null);
  assert.ok(unknown.notes.some((n) => n.includes("没能确认")), unknown.notes.join("｜"));
});

test("P7-⑦ 全 A 成交额：同一把 `?? 0` 尺子，未确认家数时当日值与基线各自按缺失处理", () => {
  const zero = marketFromWiring(sentimentWire({ amount_known: 0, amount_total_yi: 0 }), null);
  assert.equal(zero.input.turnover?.today_yi, null, "0 家带 amount 字段 ⇒ 「今日成交 0 亿」是一句伪造的结论");
  assert.ok(zero.notes.some((n) => n.includes("0 家真实带 amount 字段")), zero.notes.join("｜"));
  const unconfirmed = marketFromWiring(sentimentWire({ amount_known: null }), null);
  assert.equal(unconfirmed.input.turnover?.today_yi, null);
  assert.ok(unconfirmed.notes.some((n) => n.includes("没能确认")), unconfirmed.notes.join("｜"));
  // 当日值可信但基线不可信 ⇒ 只交当日值，比值由打分表判成算不出（本层不拿一天当基线）
  const noBase = marketFromWiring(sentimentWire(), null);
  assert.equal(noBase.input.turnover?.today_yi, 9800, "当日成交额确认过就照交，不因基线缺失一起丢掉");
  assert.equal(noBase.input.turnover?.avg_yi, null);
  assert.ok(noBase.notes.some((n) => n.includes("不拿一天或自造基线")), noBase.notes.join("｜"));

  const base = turnoverBaseline(priorTurnover(), { exclude_trade_date: "2026-09-16" });
  assert.equal(base.window, 5, "被 exclude 的那一天不能当自己的基线（今日 vs 今日 = 1 倍，是恒等式不是放量）");
  assert.equal(Math.round((base.avg_yi as number) * 100) / 100, 9150, "剩下的 9050/9100/9150/9200/9250 五个可信日均值");
  assert.equal(base.note, null);
  const allDropped = turnoverBaseline(priorTurnover({ amount_known: null }), {});
  assert.equal(allDropped.avg_yi, null, "旧留档没确认过成交额口径 ⇒ 一天都不采信");
  assert.equal(allDropped.dropped_unconfirmed, TURNOVER_MIN_PRIOR_DAYS + 1);
  assert.match(allDropped.note ?? "", /没有确认过成交额口径/, "丢掉了多少天要说出来，否则读者以为库里就没有留档");
  assert.equal(turnoverBaseline(null, {}).avg_yi, null, "服务层没查 = 缺失，不等于基线为 0");
  //  scope 文案要跟着读数一起交上去：RPS/成交额这类「哪份榜、哪个口径」的问题只能由供数方回答
  assert.equal(marketWired().input.turnover?.scope, TURNOVER_SCOPE);
});

test("P7-⑦ M-IDX-MA20 的均线由接线层算：日K不足窗口就是缺失，不缩短窗口也不拿当日涨跌幅凑", () => {
  const noBars = marketFromWiring(sentimentWire(), null);
  assert.equal(noBars.input.index_ma20?.ma20, null);
  assert.equal(noBars.input.index_ma20?.close, null);
  assert.ok(noBars.notes.some((n) => n.includes("不会拿当日涨跌幅代替均线位置")), noBars.notes.join("｜"));
  const short = marketFromWiring(sentimentWire(), null, { index_bars: indexBars(INDEX_MA_WINDOW_DEFAULT - 5) });
  assert.equal(short.input.index_ma20?.ma20, null, "15 根算不出 20 日均线");
  assert.equal(short.input.index_ma20?.close, indexBars(15)[14].c, "收盘价是真的，缺的只是均线 —— 两者要分开登记");
  assert.ok(short.notes.some((n) => n.includes(`不足 ${INDEX_MA_WINDOW_DEFAULT} 根`)), short.notes.join("｜"));
  // 脏行（日期不合法 / 收盘价非正）丢掉而不是当 0
  const dirty = marketFromWiring(sentimentWire(), null, {
    index_bars: [...indexBars(25), { date: "不是日期", c: 1 }, { date: "2026-02-30", c: -5 }, { date: "2026-03-02", c: Number.NaN }],
  });
  assert.equal(dirty.input.index_ma20?.ma20 !== null, true, "脏行剔除后仍够窗口 ⇒ 均线照算");
  assert.equal(dirty.input.index_ma20?.close, indexBars(25)[24].c, "排序取最后一根时不能把脏行当有效日期挤掉真读数");
  const d = buildDecision({ external: [marketExternal(noBars.input)] });
  assert.equal(itemOf(d, "market", "M-IDX-MA20").points, null, "没供日K ⇒ 计分主判项不判定");
  assert.match(itemOf(d, "market", "M-IDX-MA20").raw, /上证指数/, "主判项也要说清本来读的是哪一条指数");
  assert.equal(itemOf(d, "market", "M-INDEX-PCT").points, 2, "当日涨跌幅是另一条读数（basis），均线缺失不牵连它");
  assert.equal(roleOf(d, "market", "M-INDEX-PCT"), "basis");
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
  assert.equal(itemOf(d, "market", "M-INDEX-PCT").points, null, "v2 的计分项 M-INDEX 在 v3 是判定依据 M-INDEX-PCT：没读数照样不判定");
  assert.match(itemOf(d, "market", "M-INDEX-PCT").raw, /上证指数/, "raw 里要看得出「本来要读的是哪一条指数」");
  assert.ok(missingIdx.notes.some((n) => n.includes("M-INDEX-PCT")), "登记的缺项名必须对得上表里真有的那条规则，否则页面上找不到");

  const badNum = marketFromWiring(sentimentWire({ indices: [{ symbol: BASE_INDEX.symbol, changePct: null }] }), null);
  assert.equal(badNum.input.index?.change_pct, null);
});

test("P7-④ 市场面整面取数失败：10 个计分分项全部算不出，而不是市场环境 0 分", () => {
  const { input, notes } = marketFromWiring(null, null);
  assert.ok(notes.some((n) => n.includes("没有取到任何读数")), notes.join("｜"));
  const d = buildDecision({ external: [marketExternal(input)] });
  const m = dim(d, "market");
  assert.equal(m.score, null, "整维度全缺 ⇒ null，交给内核把权重从分母里拿掉");
  assert.equal(m.status, "MISSING");
  assert.equal(d.final_score, null);
  assert.equal(d.excluded.find((e) => e.key === "market") !== undefined, true);
  // v2 只有 8 项 ⇒ v3 是「10 计分 + 2 判定依据」。计分项一条都不给兜底，basis 项也不许变成 0 分
  assert.equal(m.items.filter((i) => i.role !== "basis").length, 10);
  assert.equal(m.items.filter((i) => i.role === "basis").length, 2);
  assert.ok(m.items.every((i) => i.points === null), m.items.map((i) => `${i.rule}=${i.points}`).join(","));
  assert.match(m.missing.join(" / "), /市场面 10 个计分分项本次全部算不出/);
});

test("P7-④ 主线：themes 读取失败(null) 与 跑了但 0 条主线 是两个不同的事实", () => {
  const noRun = marketFromWiring(sentimentWire(), null);
  assert.equal(noRun.input.themes, null);
  const zeroMain = marketFromWiring(sentimentWire(), themesWire([]));
  assert.deepEqual(zeroMain.input.themes, { main_count: 0, top_score: null, top_rps: null, rps_scope: null }, "v3 多带两格：榜首 RPS 与它的榜单口径");
  const d = buildDecision({ external: [marketExternal(zeroMain.input)] });
  const t = itemOf(d, "market", "M-THEME");
  assert.equal(t.points, 0, "「未判出主线」是读数，按表归 0 分");
  assert.match(t.raw, /主线 0 个/, t.raw);
  const rps = itemOf(d, "market", "M-RPS");
  assert.equal(rps.points, null, "没有主线 ⇒ 榜首 RPS 无定义，v3 的新计分项不能拿它凑");
  assert.match(rps.note ?? "", /本项不判定/, "「引擎没给这一格」要说成缺失，不是「RPS=0」");
  // 更阴的一种：引擎确实给了榜首 RPS，但当日一个主线都没判出来 ⇒ 榜内第一名的百分位必然偏高，
  // 拿它当「强势板块 RPS」就是虚高（themes 的 rps 是合并榜内涨幅百分位）。这一格必须是缺失而不是 +10。
  const oddRps = marketFromWiring(sentimentWire(), { main_count: 0, top_score: null, top_rps: 95, rps_scope: null });
  const dOdd = buildDecision({ external: [marketExternal(oddRps.input)] });
  assert.equal(itemOf(dOdd, "market", "M-RPS").points, null);
  assert.match(itemOf(dOdd, "market", "M-RPS").note ?? "", /虚高/);
  assert.equal(itemOf(dOdd, "market", "M-THEME").points, 0, "同一天的 M-THEME 是真读数（0 个），两者并存才说明「不是没跑」");
  const d2 = buildDecision({ external: [marketExternal(noRun.input)] });
  assert.equal(itemOf(d2, "market", "M-THEME").points, null, "没跑成 ⇒ 不判定，与「跑了但 0 个」不共享一个 0");
});

test("P7-⑦ themesWire：不假设引擎排过序，榜首取真实最大值；RPS 跟着榜首那条走，不取 max", () => {
  assert.deepEqual(themesWire([{ score: 61 }, { score: 88 }, { score: 73 }]), { main_count: 3, top_score: 88, top_rps: null, rps_scope: null });
  assert.deepEqual(themesWire([]), { main_count: 0, top_score: null, top_rps: null, rps_scope: null });
  assert.deepEqual(themesWire([{ score: NaN }, { score: 40 }]), { main_count: 2, top_score: 40, top_rps: null, rps_scope: null }, "NaN 不是榜首强度");
  // rps 与 score 是两套排序：拿 max(rps) 会把「别的板块 RPS 高」说成「榜首板块 RPS 高」
  assert.deepEqual(themesWire([{ score: 61, rps: 20 }, { score: 88, rps: 70 }, { score: 73, rps: 99 }], "榜内百分位"),
    { main_count: 3, top_score: 88, top_rps: 70, rps_scope: "榜内百分位" });
  assert.deepEqual(themesWire([{ score: 88, rps: 99 }, { score: 90 }], null).top_rps, null, "榜首那条没有 rps 就是没有，不退回次大的那条");
  assert.equal(marketWired(sentimentWire(), themesWire([{ score: 82, rps: 91 }], null)).input.themes?.rps_scope, null, "口径不声明时原样交 null，由打分表登记「口径未知」");
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

test("P7-⑦ 技术面：等比上涨的合成序列 ⇒ 新表逐项分值、basis 项不重复计权、字面分与折算分各留一格", () => {
  const bars = rampBars(60);
  const w = technicalFromBars(bars);
  const c = bars.map((b) => b.c);
  const mean20 = c.slice(-20).reduce((a, b) => a + b, 0) / 20;
  assert.equal(Math.round((w.input.ma20 as number) * 1e6), Math.round(mean20 * 1e6), `MA20=${w.input.ma20} 对照 ${mean20}`);
  assert.ok((w.input.ma5 as number) > (w.input.ma10 as number) && (w.input.ma10 as number) > (w.input.ma20 as number));
  assert.equal(w.input.rsi_period, RSI_PERIOD_DEFAULT, "周期由本层选定并记账（任务书 §六 没指定）");
  assert.equal(w.bars_used, 60);
  const d = buildDecision({ technical: w.input });
  const td = dim(d, "technical");
  // v2 期望 +20（旧表的多头排列档），v3 新表把它降到 +15：同一份读数，分值以登记的 p7.s7.technical.v1 为准
  assert.equal(itemOf(d, "technical", "T-MA-STRUCT").points, 15, "v3 均线多头排列 = +15（不是旧表的 +20）");
  assert.equal(itemOf(d, "technical", "T-MA-STRUCT").rule_version, "p7.s7.technical.v1");
  assert.equal(itemOf(d, "technical", "T-BREAKOUT").points, 10, "突破 20 日压力是新表并进来的第 5 个计分项（v2 没有这一项）");
  // v2 的 T-VOLUME 是「§六 无成交量打分表 ⇒ 不判定」；v3 补了成交量档，但本组合（上涨且量持平）落在未定义区，取 0 且必须留痕
  const vol = itemOf(d, "technical", "T-VOLUME");
  assert.equal(vol.points, 0);
  assert.equal(vol.role, "scored");
  assert.match(vol.note ?? "", /未定义[\s\S]*本层补充/, "补的档要打上补充标记，不能把本层的选择写成任务书的规定");
  assert.equal(itemOf(d, "technical", "T-RSI").points, 0, "RSI=100 越出任务书写到的 55–70 段 ⇒ 本层取 0，既不沿旧表扣超买也不给强势分");
  assert.equal(itemOf(d, "technical", "T-MA-BREAK").role, "basis", "旧表的「跌破 MA20」信息已并进新表 ⇒ 只作判定依据");
  assert.equal(itemOf(d, "technical", "T-MACD-ZERO").role, "basis");
  assert.equal(itemOf(d, "technical", "T-MA-BREAK").rule_version, "p7.taskbook.s6", "basis 项保留自己那张表的版本号");
  assert.equal(td.items.filter((i) => i.role === "scored").length, 5);
  assert.equal(td.items.filter((i) => i.role === "basis").length, 2);
  assert.equal(td.score, 25, "字面分只加 5 个计分项（15+0+0+10+0）");
  assert.equal(td.raw_score, 25);
  assert.deepEqual(td.bounds, { min: -50, max: 50 }, "技术面单维限制 ±50：这是折算用的尺子，必须随输出交出去");
  assert.equal(td.norm_score, 50, "25/50 ⇒ 折算 +50");
  assert.equal(d.final_score, 50);
  assert.match(td.missing.join(" / "), /未重复计分/, "basis 不计权这件事要在缺口里说一次，免得有人把 7 个分项加起来");
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

test("P7-⑦ 概率面：口径声明与主周期随读数一起交上去，打分表没有的期限丢弃并登记", () => {
  const stats = simStats({ horizons: [...simStats().horizons, { h: 60, win_rate: 40, sample_size: 60, avg_return: null, median_return: null, worst_return: null } as never] });
  const { input, notes } = probabilityFromSimilarEnv(stats, { trade_date: "2026-09-18" });
  assert.equal(input?.engine, "similar_env");
  assert.deepEqual(input?.readings.map((r) => r.horizon), [1, 5, 20]);
  assert.equal(input?.readings[0].period?.start, "2024-08-06", "样本区间必须带进血缘，否则事后无法重建");
  assert.equal(input?.primary_horizon, PRIMARY_HORIZON_DEFAULT, "v3 内核不替调用方挑周期：不声明就整维不打分，本层带默认值并记账");
  assert.ok(notes.some((n) => n.includes(`按 ${PRIMARY_HORIZON_DEFAULT} 日期限打分`) && n.includes("本层补充")), notes.join("｜"));
  assert.ok(notes[0] === PROBABILITY_SCOPE_NOTE, notes.join("｜"));
  assert.ok(notes.some((n) => n.includes("60 日期限")), notes.join("｜"));
  const d = buildDecision({ probability: input! });
  assert.equal(dim(d, "probability").status, "HISTORICAL", "概率面是历史统计，不是对今天的预测");
  // 盈亏比四格原样透传：本层不重算、不换算
  assert.equal(input?.readings[0].payoff_ratio, 1.4);
  assert.equal(input?.readings[0].avg_loss, -0.64);
  assert.equal(itemOf(d, "probability", "P-PAYOFF").points, 10, "1.4 ≥ 1.2 ⇒ 盈亏比显著占优");
  assert.match(itemOf(d, "probability", "P-SAMPLE").raw, /盈亏比 1\.4[\s\S]*赢 121 次\/亏 99 次/, "样本量/胜率/盈亏比/两侧均值要在同一行 raw 里，页面才凑得出任务书要求的三项概率展示");
  assert.equal(itemOf(d, "probability", "P-5D").role, "basis", "非主周期的读数只作依据，不重复计权");
});

test("P7-⑦ 概率面：win_rate=null 保持 null；period 缺失与整面缺失各登记一条", () => {
  const noRate = probabilityFromSimilarEnv(simStats({
    sample_ok: false, sample_size: 0, period: null,
    horizons: [
      { h: 1, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null },
      { h: 5, win_rate: 52, sample_size: 12, avg_return: null, median_return: null, worst_return: null },
      { h: 20, win_rate: null, sample_size: 0, avg_return: null, median_return: null, worst_return: null },
    ],
  } as never), { trade_date: "2026-09-18" });
  assert.equal(noRate.input?.readings[0].win_rate, null, "引擎给 null 就是算不出，不许换成 0%");
  assert.ok(noRate.notes.some((n) => n.includes("样本区间") || n.includes("给不出")), noRate.notes.join("｜"));
  const d = buildDecision({ probability: noRate.input! });
  // v2 的 P-1D 分项在 v3 拆成 P-SAMPLE / P-WINRATE / P-PAYOFF（按主周期），非主周期才叫 P-5D/P-20D
  assert.equal(itemOf(d, "probability", "P-WINRATE").points, null);
  assert.match(dim(d, "probability").missing.join(""), /1 日：本次没有可用的上涨概率读数/);
  assert.equal(itemOf(d, "probability", "P-PAYOFF").points, null, "这批合成读数没带盈亏比 ⇒ 同样是不判定，不是 0");
  assert.match(itemOf(d, "probability", "P-PAYOFF").note ?? "", /不按 0 计|没有亏损/);
  const none = probabilityFromSimilarEnv(null, { trade_date: null });
  assert.equal(none.input, null);
  assert.ok(none.notes.some((n) => n.includes("按缺失处理")), none.notes.join("｜"));
});

// ---------- 事件面接线 ----------

test("P7-⑦ 事件面：库里为空 / 读取失败，两种「没有分」都不落到 0 上", () => {
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
    // 这跟「什么都不传 ⇒ rule_version 为 null」是两条不同的路，两者都要钉住。
    assert.equal(dim(d, "event").rule_version, EVENT_RULE_VERSION, "版本由接线层带进来，内核不改写（v3 是任务书新表 p7.s7.event.v1）");
    assert.equal(dim(d, "event").status, "MISSING");
    assert.equal(dim(d, "event").weight_applied, 0, "算不出的维度权重要从分母拿掉");
    // v2 是 4 个计分分项；v3 只剩 1 个计分项（EV-LEVEL），旧四项降为判定依据但仍在归因里露着
    assert.equal(dim(d, "event").items.length, 5, `${label}`);
    assert.equal(dim(d, "event").items.filter((i) => i.role === "scored").length, 1);
    assert.equal(dim(d, "event").items.filter((i) => i.role === "basis").length, 4);
    assert.ok(dim(d, "event").items.every((i) => i.points === null), `${label}：一条读数都没有时给 0 就是伪造`);
    assert.equal(dim(d, "event").items.find((i) => i.rule === "E-TILT")!.rule_version, EVENT_LEGACY_RULE_VERSION, "basis 项保留旧表版本号，出处不冒充新表");
    assert.match(dim(d, "event").items.find((i) => i.rule === "E-TILT")!.note ?? "", /算不出/, "为什么没分要写在意见里，不能只剩一句「没算出得分」");
    assert.match(d.excluded.find((e) => e.key === "event")!.reason, /全部算不出/, "剔除原因要说这一维一条都没算出来");
    assert.match(dim(d, "event").missing.join(""), /自带规则/, "并说明它带了规则却没算出分");
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
  // 没给标的 ⇒ E-SUBJECT 不判定（v3 它是判定依据项；EV-LEVEL 由其余三项的合计定档，照算）
  const noSubject = eventsFromInterpretations(rows, { ref_date: "2026-09-18" });
  assert.equal(noSubject.input.subject, null);
  assert.equal(noSubject.input.events[1].relates_to_subject, null);
  const d = buildDecision({ external: [eventExternal(noSubject.input)] });
  assert.equal(itemOf(d, "event", "E-SUBJECT").points, null);
  assert.equal(itemOf(d, "event", "E-SUBJECT").role, "basis");
  assert.ok(dim(d, "event").score !== null, "标的项不适用不影响这一维计分");
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

// ---------- 端到端：接线层的输出必须能被四张表直接吃下 ----------

test("P7-⑦ 四维齐全时接线产物直接进 buildDecision：规则版本、bounds、字面分与折算分都由接线层带齐", () => {
  const market = marketWired();
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
  // 每一维交三件事：字面分（本维那张表）、bounds（折算用的尺子）、norm_score（折算到 ±100 的结果）
  assert.deepEqual([dim(d, "technical").score, dim(d, "probability").score, dim(d, "market").score, dim(d, "event").score], [25, 25, 43, 10]);
  assert.deepEqual([dim(d, "technical").norm_score, dim(d, "probability").norm_score, dim(d, "market").norm_score, dim(d, "event").norm_score], [50, 62.5, 86, 50]);
  assert.deepEqual(dim(d, "market").bounds, MARKET_EXTREMES, "市场面满档 ±50");
  assert.deepEqual(dim(d, "event").bounds, EVENT_EXTREMES, "事件面满档 ±20：v2 的 ±25 是旧表求和，v3 按任务书五档收成 ±20");
  assert.equal(d.final_score, 61, "50×0.4 + 62.5×0.3 + 86×0.2 + 50×0.1");
  assert.equal(d.grade, "偏强看多");
  // 接线层的成果：极值随 marketExternal/eventExternal 带进内核 ⇒ 区间是四维口径，六档全可达
  assert.deepEqual(d.attainable, { min: -88.75, max: 100, unreachable_grades: [] }, "四维齐全且每维都声明了 ±50/±20 的尺子：区间就是 −88.75~100");
  assert.doesNotMatch(d.basis, /区间比真实区间窄/, "接线后每一维都带了 bounds，不该再有这条登记");
  assert.match(d.basis, /折算记账[^\n]*norm_score/, "口径行要把「页面显示的分数不是任何一张表字面分之和」说清楚");
  assert.ok(WIRING_VERSION.startsWith("p7.s7."), `接线层版本跟着升到 v3：${WIRING_VERSION}`);
  assert.equal(MARKET_EXTREMES.max, 50);
  assert.equal(EVENT_EXTREMES.min, -20);
});

test("P7-⑦ 接线层不发明维度：只传技术面时，市场/事件/概率仍走「未计入」并且不报错", () => {
  const tech = technicalFromBars(rampBars(60));
  const d = buildDecision({ technical: tech.input });
  assert.deepEqual(d.included, ["technical"]);
  assert.equal(d.final_score, 50, "v3 的刻度：技术面字面 +25 按本维极值 50 折算成 +50，权重被归一到 100/100");
  assert.equal(d.weights.applied.technical, 1);
  assert.deepEqual(d.attainable, { min: -100, max: 100, unreachable_grades: [] }, "单维时区间就是这一维折算后的上下限 ±100（v2 那是 55/−35 的字面口径）");
  assert.ok(d.excluded.length === 3);
  assert.deepEqual(d.excluded.map((e) => e.key).sort(), ["event", "market", "probability"]);
});
