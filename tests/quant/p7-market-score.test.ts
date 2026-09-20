// P7-⑦ 市场面打分规则表的单元测试（node --test 直跑，无 DB / 无网络 / 无时钟）。
//
// 这份文件从 v2（P7-③ 那张自认表）升到 v3（P7-⑦ 新表为主 + 旧表并入）。**没有删除任何一条测试意图，
// 也没有放宽任何一处断言**；数字变化处逐条写明为什么变（刻度换了、表换代了、同指标并入 basis 了），
// 并补上 v2 没有的更强断言：
//   · 版本号：p7.s3.market.v1 → p7.s7.market.v1（维度级）；旧表两个撞指标项停在 p7.s3.market.v1；
//   · items 8 → 12（新表 4 条主判据 + 旧表 6 条附加项 + 2 条判定依据 basis）；
//   · 极值 ±30/−33 → 任务书的单维限制 ±50（账面 +60/−57 另立常量，夹取必须在 missing 里留痕）；
//   · 「市场面对综合得分的贡献」从字面加权和改成**折算刻度**（本维极值当尺子折到 ±100 再加权）。
//
// 这套测试钉住的是「一张换成任务书口径的表凭什么可信」，五件事：
// 1) 出处要分得开：哪四条是 P7-⑦ 任务书表、哪六条是 P7-③ 自认表的附加项、哪两条只是判定依据 —— 版本号与 note 两处都能追；
// 2) 缺失走三条路：算不出（null）/ 读数存在按表归 0 / 越界或枚举外的脏数据不判定，三者不得压成同一个数字；
// 3) 值域要自证：MARKET_EXTREMES 的 ±50 必须真有一组输入打得到（并且是**夹取后**的 ±50，账面 −55/+60 都在 missing 里），
//    并与 decision-core 的 scoreBounds／attainable 对得上账；
// 4) 单维限制不是装饰：超出 ±50 要夹，还要把「从几分夹到几分」登记出来 —— 静默夹取等于偷偷改分；
// 5) 文案不得出现「可信度 xx%」，出现的百分号只能属于真实读数（涨跌家数占比、涨跌幅、炸板率、均线偏离）。
//
// 测试里的输入全部是**合成读数**（用来验查表逻辑），不是任何一天的真实行情；这一点在各条断言里不冒充事实。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BREADTH_NEAR_BAND, BREADTH_PUDIE_MAX_SHARE, IDX_MA20_FLAT_BAND, MARKET_BREADTH_BANDS, MARKET_BREADTH_LEVEL_BANDS,
  MARKET_BREAK_BANDS, MARKET_DIMENSION_LIMIT, MARKET_EXTREMES, MARKET_EXTREMES_UNCLAMPED, MARKET_INDEX_BANDS,
  MARKET_LEGACY_RULE_VERSION, MARKET_LIMITNET_BANDS, MARKET_MAFLOW_BANDS, MARKET_MA20_BANDS, MARKET_MEDIAN_BANDS,
  MARKET_RISK_NOTE, MARKET_RISK_POINTS, MARKET_RULE_PROVENANCE, MARKET_RULE_VERSION, MARKET_RPS_BANDS,
  MARKET_S7_PROVENANCE, MARKET_THEME_BANDS, MARKET_TURNOVER_BANDS, MARKET_VOLUME_SHRINK_RATIO,
  MARKET_VOLUME_SURGE_RATIO, marketDimension, marketExternal, marketItems, pickBand, type MarketInput,
} from "../../src/lib/quant/screener/market-score-core.ts";
import {
  DECISION_PROTOCOL_VERSION, DEFAULT_WEIGHTS, RULE_VERSIONS, SUPPLEMENT_MARKER, buildDecision, decisionSections,
  decisionToText, gradeForScore, scoreBounds, type ProbabilityInput, type ScoreItem, type TechnicalInput,
} from "../../src/lib/quant/screener/decision-core.ts";

/** v2 那组「偏强但不极端」的合成读数：故意只带旧表字段，用来验「新表三项缺失时怎么降级」 */
const STRONG: MarketInput = {
  advancers: 3300, decliners: 1700, total: 5000, median_pct: 0.8,
  index: { symbol: "000001.SH", label: "上证指数", change_pct: 0.5 },
  limit_up: 45, limit_down: 6, break_rate: 15, main_net_sum_yi: 210,
  risk_level: "正常", themes: { main_count: 4, top_score: 78 }, trade_date: "2026-09-19", live: false,
};
/** v2 的 WEAK（旧表口径 −33）：v3 里涨跌家数按新三档给 −10、指数当日涨跌幅降为 basis ⇒ −32 */
const WEAK: MarketInput = {
  advancers: 600, decliners: 4500, total: 5100, median_pct: -2.3,
  index: { symbol: "000001.SH", label: "上证指数", change_pct: -2.1 },
  limit_up: 4, limit_down: 42, break_rate: 63, main_net_sum_yi: -580,
  risk_level: "高风险", themes: { main_count: 0, top_score: null }, trade_date: "2026-09-19", live: false,
};
/** v2 的 CEILING：只带旧表字段 ⇒ 新表三项算不出，本组只到 30（用它证明「缺主判据时不会假装满档」） */
const CEILING: MarketInput = { ...STRONG, advancers: 5200, decliners: 0, median_pct: 9.99, index: { symbol: "000001.SH", label: "上证指数", change_pct: 10 }, limit_up: 100, limit_down: 0, break_rate: 0, main_net_sum_yi: 1000, themes: { main_count: 6, top_score: 95 } };
/** v3 上限实证：十条计分分项全取最高档 ⇒ 账面 +60，被任务书的单维限制夹到 +50 */
const CEILFULL: MarketInput = {
  ...CEILING,
  index_ma20: { symbol: "000001.SH", label: "上证指数", close: 3500, ma20: 3400 },
  turnover: { scope: "全A", today_yi: 16000, avg_yi: 12000 },
  themes: { main_count: 6, top_score: 95, top_rps: 92, rps_scope: "主线榜" },
};
/** v3 地板实证：计分档全取最低 ⇒ 账面 −55（账面 −57 要 M-RPS −10 与 M-THEME 0 同时成立，而 RPS 要求有主线、0 分主线要求没主线，互相排斥），夹到 −50 */
const DEEPWEAK: MarketInput = {
  advancers: 400, decliners: 4700, total: 5100, median_pct: -2.3,
  index: { symbol: "000001.SH", label: "上证指数", change_pct: -2.1 },
  index_ma20: { symbol: "000001.SH", label: "上证指数", close: 3200, ma20: 3400 },
  turnover: { scope: "全A", today_yi: 7000, avg_yi: 12000 },
  limit_up: 4, limit_down: 42, break_rate: 63, main_net_sum_yi: -580,
  risk_level: "高风险", themes: { main_count: 1, top_score: null, top_rps: 30, rps_scope: "主线榜" },
  trade_date: "2026-09-19", live: false,
};
const EMPTY: MarketInput = {
  advancers: null, decliners: null, median_pct: null, index: null, limit_up: null, limit_down: null,
  break_rate: null, main_net_sum_yi: null, risk_level: null, themes: null,
};

const byRule = (items: ReturnType<typeof marketItems>, rule: string) => items.find((i) => i.rule === rule)!;
const scored = (items: ScoreItem[]) => items.filter((i) => i.role !== "basis");
const basisItems = (items: ScoreItem[]) => items.filter((i) => i.role === "basis");
const fullTech: TechnicalInput = { ma5: 12, ma10: 11, ma20: 10, close: 12.5, dif: 0.4, dea: 0.2, dif_prev: 0.1, dea_prev: 0.15, bar: 0.4, bar_prev: 0.3, rsi: 62, rsi_period: 14 };
/** v3：概率面必须声明主周期，否则整维不打分（decision-core 的硬规则）⇒ 对照用例得带上 primary_horizon */
const probHigh = (win_rate: number): ProbabilityInput => ({
  engine: "similar_env",
  primary_horizon: 1,
  readings: [{ horizon: 1, win_rate, sample_size: 200, trade_date: "2026-09-19", period: { start: "2024-08-06", end: "2026-08-20" } }],
});

test("P7-⑦ 出处：维度级版本是任务书新表、附加项与 basis 各自带旧表版本；内核登记的仍是这张表", () => {
  assert.equal(MARKET_RULE_VERSION, "p7.s7.market.v1");
  assert.ok(!MARKET_RULE_VERSION.startsWith("p7.taskbook"), "任务书的表由本层落成代码，版本号仍带本层前缀：写成 taskbook 等于把补的数值线冒充原文");
  assert.equal(MARKET_LEGACY_RULE_VERSION, "p7.s3.market.v1");
  assert.equal(RULE_VERSIONS.market, MARKET_RULE_VERSION);
  assert.match(MARKET_RULE_PROVENANCE, /非任务书原文/);
  assert.match(MARKET_S7_PROVENANCE, /P7-⑦ 任务书市场面表/);
  // 三种出处必须互相看得见：主判据挂新表、附加项挂旧表、basis 明写自己是被并入的旧项
  const items = marketItems(CEILFULL);
  for (const rule of ["M-IDX-MA20", "M-BREADTH", "M-TURNOVER", "M-RPS"]) {
    const i = byRule(items, rule);
    assert.equal(i.rule_version, MARKET_RULE_VERSION, `${rule} 不是新表四判据之一？`);
    assert.ok((i.note ?? "").includes(MARKET_S7_PROVENANCE), `${rule} 的 note 没带新表出处`);
  }
  for (const rule of ["M-MEDIAN", "M-LIMITNET", "M-BREAK", "M-MAINFLOW", "M-RISK", "M-THEME"]) {
    const i = byRule(items, rule);
    assert.equal(i.role, "scored", `${rule} 是新表没有这个指标的附加项，应当继续计分而不是降级成 basis`);
    assert.equal(i.rule_version, MARKET_LEGACY_RULE_VERSION, `${rule} 的出处仍是 P7-③ 那张自认表`);
    assert.ok((i.note ?? "").includes(MARKET_RULE_PROVENANCE), `${rule} 的 note 没带旧表出处声明`);
  }
  for (const i of basisItems(items)) {
    assert.equal(i.rule_version, MARKET_LEGACY_RULE_VERSION);
    assert.match(i.note ?? "", /P7-⑦ 新表/);
  }
  // 本层补的数值线必须能被认出来：普跌线、放量线、缩量线是三条最容易被人当成任务书原文的线
  const notes = new Set([STRONG, WEAK, CEILING, CEILFULL, DEEPWEAK].flatMap((x) => marketItems(x).map((i) => i.note ?? "")));
  const marked = [...notes].filter((n) => n.includes(SUPPLEMENT_MARKER));
  assert.ok(marked.length >= 3, JSON.stringify(marked));
  for (const re of [/普跌线 35% 是本层补的/, /放量线 1\.2 倍是本层补的/, /缩量线 0\.8 倍是本层补的/]) {
    assert.ok(marked.some((n) => re.test(n)), `${re} 这条补的线没带补充标记`);
  }
  // P7-① 的入口纪律不变：不带 rule_version 就等于没带规则 ⇒ 仍然未计入，不给 0 分
  const bare = buildDecision({ external: [{ key: "market", score: 22, rule_version: "" }] });
  assert.equal(bare.included.includes("market"), false);
  assert.match(bare.excluded.find((e) => e.key === "market")!.reason, /没有传入打分结果|不替它把「没算」写成 0 分/);
});

test("P7-⑦ 全缺输入：10 个计分分项全 null、整维度 score=null，理由进 missing[] 而不是补一个 0", () => {
  const d = marketDimension(EMPTY);
  assert.equal(d.items.length, 12, "12 条 = 新表 4 判据 + 旧表 6 附加项 + 2 条判定依据");
  assert.equal(scored(d.items).length, 10);
  assert.ok(scored(d.items).every((i) => i.points === null), "一条读数都没有时任何分项给 0 分都是伪造");
  assert.ok(basisItems(d.items).every((i) => i.points === null));
  assert.equal(d.score, null);
  assert.equal(d.status, "MISSING");
  assert.match(d.missing[0] ?? "", /市场面 10 个计分分项本次全部算不出/);
  assert.match(d.missing.join(" / "), /不会用空分母/);
  const dec = buildDecision({ external: [marketExternal(EMPTY)] });
  assert.equal(dec.final_score, null);
  assert.equal(dec.grade, null);
  assert.deepEqual(dec.excluded.map((e) => e.key).sort(), ["event", "market", "probability", "technical"]);
});

test("P7-⑦ 正常输入：逐项档位、总分、以及「缺一项只说那一项」的降级（v2 的 22/−33 变成 27/−32）", () => {
  const s = marketDimension(STRONG);
  // v2 是 22（涨跌家数五档 +3、指数五档 +2 都在计分）；v3 涨跌家数改按新表三档给 +10、指数当日涨跌幅降为 basis 不再计分，
  // 而新表另外三条主判据（20 日线 / 成交额 / RPS）在这组只带旧字段的读数下算不出 ⇒ 27。
  assert.equal(s.score, 27, "广度+10 中位+2 涨跌停净差+4 炸板+2 主力+1 风险+4 主线+4；三项新判据缺失不计");
  assert.equal(s.status, "DEGRADED", "旧字段齐全的合成读数，在新表下本来就是缺主判据的 ⇒ 降级而不是当它 DERIVED");
  assert.deepEqual(basisItems(s.items).map((i) => [i.rule, i.points]), [["M-BREADTH-SHARE", 3], ["M-INDEX-PCT", 2]], "basis 照常显示旧五档读数，但不进求和");
  assert.equal(scored(s.items).filter((i) => i.points === null).map((i) => i.rule).join(","), "M-IDX-MA20,M-TURNOVER,M-RPS");
  assert.equal(marketDimension(WEAK).score, -32, "v2 的 −33 含「指数当日跌幅 −5」与「涨跌家数 −6」；v3 指数跌幅进 basis、涨跌家数按三档 −10 ⇒ −32");
  const partial = marketDimension({ ...STRONG, themes: null, break_rate: null });
  assert.equal(partial.status, "DEGRADED", "两项算不出 ⇒ 降级，但其余项照算（P7-① 技术面同一条纪律）");
  assert.equal(partial.score, 27 - 4 - 2, "缺的两项不进求和，也不用 0 顶替");
  assert.match(partial.missing.join(" / "), /有 5 个市场面分项算不出/, "themes=null 会同时带走 M-RPS 与 M-THEME（加上本就缺的三项）");
  assert.equal(byRule(partial.items, "M-BREADTH").points, 10, "一项缺不会让别的项归零");
});

test("P7-⑦ 值域自证：CEILFULL/DEEPWEAK 真打到 ±50（夹取留痕），账面极值另立一个常量", () => {
  assert.ok(scored(marketItems(CEILFULL)).every((i) => i.points !== null), "上限那组必须十条计分分项全可算，否则极值对账不成立");
  assert.equal(marketDimension(CEILFULL).score, MARKET_EXTREMES.max);
  assert.equal(marketDimension(DEEPWEAK).score, MARKET_EXTREMES.min);
  assert.deepEqual(MARKET_EXTREMES, { min: -50, max: 50 });
  assert.equal(MARKET_DIMENSION_LIMIT, 50);
  assert.deepEqual(MARKET_EXTREMES_UNCLAMPED, { min: -57, max: 60 }, "账面（未夹）极值必须单独留着：它说明 ±50 是任务书的限制，不是本表算不出更高的分");
  assert.equal(MARKET_EXTREMES.max, Math.min(MARKET_EXTREMES_UNCLAMPED.max, MARKET_DIMENSION_LIMIT));
  assert.equal(MARKET_EXTREMES.min, Math.max(MARKET_EXTREMES_UNCLAMPED.min, -MARKET_DIMENSION_LIMIT));
  // 夹取必须留痕：静默把 +60 写成 +50 就是本层自己改了任务书的分
  assert.match(marketDimension(CEILFULL).missing.join(" / "), /本维字面分 \+60 超出任务书的单维限制 ±50，按 \+50 计入/);
  assert.match(marketDimension(DEEPWEAK).missing.join(" / "), /本维字面分 -55 超出任务书的单维限制 ±50，按 -50 计入/);
  assert.equal(marketDimension(CEILFULL).status, "DERIVED", "夹取不是缺失：读数齐全、按任务书限制收口 ⇒ 不降级");
  // v3 的贡献口径：折算到 ±100 后乘生效权重，不再是字面分×权重
  const w = DEFAULT_WEIGHTS;
  assert.equal(Math.round(100 * w.market * 100) / 100, 20, "市场面满档时对综合得分的最大贡献 = 100×0.2");
  assert.equal(Math.round(-100 * w.market * 100) / 100, -20);
  const b = buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(WEAK)] }).attainable;
  assert.deepEqual(b, { min: -87.49, max: 99.99, unreachable_grades: [] }, "三维生效时区间由各维的折算尺子决定：市场面满档就是 ±100×22/100");
  assert.equal(b.unreachable_grades.length, 0, "带极值声明的维度进区间后六档全可达（逐档可达性总账在 p7-decision.test.ts 里核）");
  assert.equal(gradeForScore(50), "偏强看多", "六档边界：+50 属偏强看多（左闭右开）");
  assert.equal(gradeForScore(49.9), "震荡偏强");
  assert.equal(gradeForScore(80), "强势看多");
});

test("P7-⑦ 新表三条主判据的口径纪律：没供日K/成交额就是缺失，指标不明不合并、口径不明不采信", () => {
  // M-IDX-MA20：需要日K序列算出的 close/ma20，实时快照给不出 ⇒ 接线层没供就是缺失，不拿当日涨跌幅代替
  const ma = byRule(marketItems(STRONG), "M-IDX-MA20");
  assert.equal(ma.points, null);
  assert.match(ma.note ?? "", /调用方没有声明这条均线是哪条指数的：本层不替它选/);
  const up = byRule(marketItems({ ...STRONG, index_ma20: { symbol: "000001.SH", label: "上证指数", close: 3500, ma20: 3400 } }), "M-IDX-MA20");
  assert.equal(up.points, 10);
  assert.match(up.raw, /收盘 3500 vs MA20 3400 ⇒ 偏离 \+2\.94%/);
  const flat = byRule(marketItems({ ...STRONG, index_ma20: { symbol: "000001.SH", label: "上证指数", close: 3410, ma20: 3400 } }), "M-IDX-MA20");
  assert.equal(flat.points, 0, "贴着均线穿来穿去时判成站上/跌破都只是噪声");
  assert.match(flat.note ?? "", /±0\.5% 的「震荡」带宽是本层补的（任务书只写了三档）/);
  assert.match(flat.note ?? "", new RegExp(SUPPLEMENT_MARKER));
  assert.equal(IDX_MA20_FLAT_BAND, 0.5);
  // 两条读数不是同一条指数时不合并：上证站上线、创业板跌破，合成一句就是假话
  const mixed = byRule(marketItems({ ...STRONG, index_ma20: { symbol: "399006.SZ", label: "创业板指", close: 3500, ma20: 3400 } }), "M-IDX-MA20");
  assert.equal(mixed.points, null);
  assert.match(mixed.raw, /均线取自 399006\.SZ，而涨跌幅取自 000001\.SH/);
  assert.match(mixed.note ?? "", /说成一句就是假话/);
  // M-TURNOVER：scope 必须写清是谁的成交额
  const turn = (o: Partial<MarketInput>) => byRule(marketItems({ ...STRONG, ...o }), "M-TURNOVER");
  assert.equal(turn({ turnover: { scope: "全A", today_yi: 16000, avg_yi: 12000 } }).points, 10);
  assert.match(turn({ turnover: { scope: "全A", today_yi: 16000, avg_yi: 12000 } }).raw, /全A当日成交 16000 亿 \/ 近期均值 12000 亿 = 1\.33 倍/);
  assert.equal(turn({ turnover: { scope: "全A", today_yi: 9000, avg_yi: 12000 } }).points, -5, "缩量任务书给的是 −5，不是 −10");
  assert.equal(turn({ turnover: { scope: "全A", today_yi: 12600, avg_yi: 12000 } }).points, 0);
  assert.match(turn({ turnover: { scope: "全A", today_yi: 12600, avg_yi: 12000 } }).note ?? "", /读数存在、按表归入 0 分，不是算不出/);
  const noscope = turn({ turnover: { scope: null, today_yi: 16000, avg_yi: 12000 } });
  assert.equal(noscope.points, null, "口径不明的读数不进结论：全 A 放量与某个指数放量不是一回事");
  assert.match(noscope.note ?? "", /没说清这是全 A、沪深两市还是某条指数的成交额/);
  assert.equal(turn({ turnover: { scope: "全A", today_yi: 16000, avg_yi: null } }).points, null, "有当日没均值 ⇒ 判不了放大还是缩量");
  // M-RPS：没有主线分组时榜首百分位必然虚高 ⇒ 按算不出处理
  const rps = (t: MarketInput["themes"]) => byRule(marketItems({ ...STRONG, themes: t }), "M-RPS");
  assert.equal(rps({ main_count: 4, top_score: 78, top_rps: 88 }).points, 10);
  assert.match(rps({ main_count: 4, top_score: 78, top_rps: 88 }).raw, /榜首主线 RPS 88（主线 4 个）/);
  assert.match(rps({ main_count: 4, top_score: 78, top_rps: 88 }).raw, /RPS 的榜单口径未声明/, "没声明是哪份榜就得在 raw 里留一句风险提示");
  assert.match(rps({ main_count: 4, top_score: 78, top_rps: 60, rps_scope: "主线榜" }).raw, /｜口径：主线榜/);
  assert.equal(/未声明/.test(rps({ main_count: 4, top_score: 78, top_rps: 60, rps_scope: "主线榜" }).raw), false);
  assert.equal(rps({ main_count: 4, top_score: 78, top_rps: 60 }).points, 5, "RPS 50–80 是 +5 档：新表中间这一档旧表没有，是净新增的判据");
  assert.equal(rps({ main_count: 0, top_score: null, top_rps: 95 }).points, null, "当日没有主线分组时榜内第一名的百分位必然偏高，不能当「强势板块 RPS」");
  assert.match(rps({ main_count: 0, top_score: null, top_rps: 95 }).note ?? "", /虚高，本项按算不出处理/);
  assert.equal(rps(null).points, null);
  assert.match(rps(null).note ?? "", /themes 引擎本次没有产出主线分组结果/);
});

test("P7-⑦ basis 并入不重复计权：同一指标只有新表那份计分，旧读数照常显示", () => {
  const items = marketItems(STRONG);
  assert.equal(scored(items).reduce((a, i) => a + (i.points ?? 0), 0), marketDimension(STRONG).score, "本维求和只走 role!=='basis' 的分项");
  const share = byRule(items, "M-BREADTH-SHARE");
  assert.equal(share.role, "basis");
  assert.equal(share.points, 3, "旧五档占比读数保留：它是「上涨 3300/下跌 1700」的另一种说法，不是新证据");
  assert.match(share.note ?? "", /旧的五档占比只作判定依据/);
  assert.match(share.note ?? "", /表 p7\.s3\.market\.v1/);
  assert.match(byRule(items, "M-INDEX-PCT").note ?? "", /旧的五档当日涨跌幅只作判定依据/);
  assert.equal(byRule(items, "M-BREADTH").points, 10, "同一个涨跌家数指标在新表下计 10 分，旧档那 3 分不会叠加进去");
  // missing 里要说清有几项是判定依据、各自读成几分 —— 否则事后复看会以为漏算了
  assert.match(marketDimension(STRONG).missing.join(" / "), /另有 2 项作为判定依据展示、未重复计分（M-BREADTH-SHARE=\+3、M-INDEX-PCT=\+2）/);
  // 只有 basis 有读数时整维度仍算不出：判定依据不顶替计分分项
  const onlyBasis = marketDimension({ ...EMPTY, index: { symbol: "000001.SH", label: "上证指数", change_pct: 1.5 } });
  assert.equal(onlyBasis.score, null);
  assert.equal(onlyBasis.status, "MISSING");
  assert.equal(byRule(onlyBasis.items, "M-INDEX-PCT").points, 4, "basis 照常给出读数");
  assert.match(onlyBasis.missing[0] ?? "", /市场面 10 个计分分项本次全部算不出/);
  assert.equal(basisItems(onlyBasis.items).some((i) => i.points !== null), true);
});

test("P7-⑦ 缺数据 ≠ 0 分 ≠ 脏数据：炸板率与主力净额这两个「引擎会补 0」的坑分开走", () => {
  const br = (v: number | null) => byRule(marketItems({ ...STRONG, break_rate: v }), "M-BREAK");
  assert.equal(br(null).points, null);
  assert.match(br(null).note ?? "", /触板 0 家、比率无定义/, "sentiment 里 breakRate 的 null 必须原样传上来");
  assert.match(br(null).note ?? "", /按 0% 计入会白送 \+2 分/);
  assert.equal(br(0)!.points, 2, "真 0% 炸板才吃 +2");
  assert.equal(br(120).points, null, "越界读数不判定：脏数据不能变成一个分数");
  assert.match(br(120).note ?? "", /越界读数一律不判定/);
  assert.equal(br(40)!.points, -3, "左闭右开：40 归 ≥40 档");
  assert.equal(br(39.9)!.points, 0);

  const flow = (v: number | null) => byRule(marketItems({ ...STRONG, main_net_sum_yi: v }), "M-MAINFLOW");
  assert.equal(flow(null).points, null);
  assert.match(flow(null).note ?? "", /\?\? 0/, "文案点名 sentiment 里的累加写法，接线的人才知道那个 0 是从哪来的");
  assert.equal(flow(0)!.points, 0);
  assert.match(flow(0)!.note ?? "", /读数存在、按表归入 0 分/, "0 亿是读数，不是算不出");
});

test("P7-⑦ 涨跌家数：0/0 不判定（不当接近也不给 0）；任务书没定义的那段区间取 0 并登记", () => {
  const zero = marketItems({ ...STRONG, advancers: 0, decliners: 0, total: 0 });
  assert.equal(byRule(zero, "M-BREADTH").points, null);
  // v2 的文案是「占比无定义」（旧表按占比分五档）；v3 按新表三档判定 ⇒ 文案变成「三档都无定义」，
  // 「0/0 拒算」这件事本身一字未改，改的只是它由哪张表来说。
  assert.match(byRule(zero, "M-BREADTH").note ?? "", /三档都无定义/, "把 0/0 当成「接近」或当成 0 分都是编");
  assert.ok(!/上涨占比 50%/.test(byRule(zero, "M-BREADTH").raw), "不得把 0/0 当成五五开");
  assert.equal(byRule(marketItems({ ...STRONG, decliners: 0 }), "M-BREADTH").points, 10, "下跌 0 家 ⇒ 占比 1 ⇒ 多于下跌档（v2 的普涨档 +6 已由新表三档 +10 接管）");
  assert.equal(BREADTH_NEAR_BAND, 0.05);
  assert.equal(BREADTH_PUDIE_MAX_SHARE, 0.35);
  const between = byRule(marketItems({ ...STRONG, advancers: 2000, decliners: 3000 }), "M-BREADTH");
  assert.equal(between.points, 0, "占比 40%：跌得多但没到普跌线，任务书只写了三档 ⇒ 取 0 不猜");
  assert.match(between.label, /下跌家数偏多但未达普跌线/);
  assert.match(between.note ?? "", /这一段未定义 ⇒ 本层取 0 不猜/);
  const near = byRule(marketItems({ ...STRONG, advancers: 2500, decliners: 2550 }), "M-BREADTH");
  assert.equal(near.points, 0, "±5% 以内算接近");
  assert.match(near.label, /涨跌家数接近/);
  assert.equal(byRule(marketItems({ ...STRONG, advancers: 900, decliners: 4000 }), "M-BREADTH").points, -10, "占比 18% < 35% ⇒ 普跌档");
  // 旧五档仍在 basis 里可供复看，只是不再计第二份分
  assert.equal(byRule(marketItems({ ...STRONG, advancers: 900, decliners: 4000 }), "M-BREADTH-SHARE").points, -6);
});

test("P7-⑦ 基准指数不猜身份：没给指数时 basis 不判定；匿名读数的 raw 里不出现「上证指数」", () => {
  const none = byRule(marketItems({ ...STRONG, index: null }), "M-INDEX-PCT");
  assert.equal(none.points, null);
  assert.equal(none.raw.startsWith("未指定基准指数"), true);
  const anonymous = marketItems({ ...STRONG, index: { symbol: null, label: null, change_pct: 1.2 } });
  assert.equal(byRule(anonymous, "M-INDEX-PCT").points, 4, "读数是真实的 ⇒ basis 仍照旧档记 4 分，只是不进本维求和");
  assert.equal(scored(anonymous).some((i) => i.rule === "M-INDEX-PCT"), false);
  assert.equal(scored(anonymous).some((i) => i.rule === "M-INDEX"), false, "v2 那条计分的 M-INDEX 已被新表 M-IDX-MA20 取代");
  assert.match(byRule(anonymous, "M-INDEX-PCT").raw, /未命名指数（代码未给出）/);
  assert.ok(!/上证指数/.test(byRule(anonymous, "M-INDEX-PCT").raw), "来源不明的指数读数不能在结论里长得像有出处的上证指数");
  const named = marketItems({ ...STRONG, index: { symbol: "399006.SZ", label: "创业板指", change_pct: null } });
  assert.equal(byRule(named, "M-INDEX-PCT").points, null, "有名字没读数 ⇒ 仍算不出");
  assert.match(byRule(named, "M-INDEX-PCT").raw, /创业板指（399006\.SZ）本次无涨跌幅读数/, "有名字没读数：raw 仍点名是哪一条指数缺了读数（v2 的 M-INDEX 就有这一格，不能因为降级就丢）");
  // 上证 +0.5% 与创业板 +0.5% 在血缘里必须长得不一样
  const cy = marketItems({ ...STRONG, index: { symbol: "399006.SZ", label: "创业板指", change_pct: 0.5 } });
  assert.notEqual(byRule(cy, "M-INDEX-PCT").raw, byRule(marketItems(STRONG), "M-INDEX-PCT").raw);
});

test("P7-⑦ 风险等级：四档逐档给分，枚举外的值不判定；note 明写它与其它分项同源", () => {
  assert.deepEqual(MARKET_RISK_POINTS, { 正常: 4, 注意: -2, 偏高: -4, 高风险: -6 });
  for (const lv of Object.keys(MARKET_RISK_POINTS) as (keyof typeof MARKET_RISK_POINTS)[]) {
    assert.equal(byRule(marketItems({ ...STRONG, risk_level: lv }), "M-RISK").points, MARKET_RISK_POINTS[lv]);
  }
  assert.equal(byRule(marketItems({ ...STRONG, risk_level: "极端" as never }), "M-RISK").points, null, "不在引擎枚举里的等级不映射，也不新增一档");
  assert.match(byRule(marketItems({ ...STRONG, risk_level: null }), "M-RISK").note ?? "", /不是 0 分/);
  assert.match(byRule(marketItems(STRONG), "M-RISK").note ?? "", /同源/);
  assert.equal(byRule(marketItems(STRONG), "M-RISK").rule_version, MARKET_LEGACY_RULE_VERSION, "风险等级这一项新表没有 ⇒ 出处仍是旧表");
  assert.match(MARKET_RISK_NOTE, /不能当成独立证据/);
});

test("P7-⑦ 主线：0 个主线是读数（计 0），引擎没跑是缺失（不判定），口径异常的组合登记而不硬给分", () => {
  const none = marketItems({ ...STRONG, themes: { main_count: 0, top_score: null } });
  assert.equal(byRule(none, "M-THEME").points, 0);
  assert.match(byRule(none, "M-THEME").note ?? "", /不是缺数据/);
  assert.equal(byRule(marketItems({ ...STRONG, themes: null }), "M-THEME").points, null);
  assert.equal(byRule(marketItems({ ...STRONG, themes: { main_count: null, top_score: null } }), "M-THEME").points, null);
  const odd = marketItems({ ...STRONG, themes: { main_count: 4, top_score: 40 } });
  assert.equal(byRule(odd, "M-THEME").points, null, "主线数量够但榜首强度 <60：登记为口径异常，不解释成强势也不给 0");
  assert.match(byRule(odd, "M-THEME").note ?? "", /口径异常/);
  assert.equal(byRule(marketItems({ ...STRONG, themes: { main_count: 2, top_score: 90 } }), "M-THEME").points, 2);
  const noTop = marketItems({ ...STRONG, themes: { main_count: 3, top_score: null } });
  assert.equal(byRule(noTop, "M-THEME").points, 4, "没给榜首强度时只按主线数量判定");
  assert.match(byRule(noTop, "M-THEME").raw, /榜首强度未给出（只按主线数量判定）/);
});

test("P7-⑦ 分档边界：每张表每个档的 min 只命中自己一档，右开端点必被下一档接住（不重不漏）", () => {
  const tables: (typeof MARKET_BREADTH_BANDS)[] = [
    MARKET_MA20_BANDS, MARKET_BREADTH_LEVEL_BANDS, MARKET_TURNOVER_BANDS, MARKET_RPS_BANDS,
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
  // 净差 −20 归「−20~−6 家」这一档（左闭），−21 才进 <−20 档：标签与判定必须同向
  assert.equal(pickBand(MARKET_LIMITNET_BANDS, -20)!.points, -2);
  assert.equal(pickBand(MARKET_LIMITNET_BANDS, -21)!.points, -5);
  assert.equal(pickBand(MARKET_LIMITNET_BANDS, -5)!.points, 0, "−5 属于「相当」档：跌停多于涨停从 −6 家起算");
  assert.equal(pickBand(MARKET_BREADTH_BANDS, 0.399)!.points, -3, "旧五档表的端点仍然自洽：它还在 basis 里给读数");
  // 新表四条的端点单独钉一次：它们是全维最容易被读错的地方
  assert.equal(pickBand(MARKET_MA20_BANDS, 0.5)!.points, 10, "偏离正好 +0.5% 算站上（左闭）");
  assert.equal(pickBand(MARKET_MA20_BANDS, 0.49)!.points, 0);
  // 「震荡」档是 [-0.5, +0.5) 左闭右开：正好 −0.5 归震荡（不硬凑一个跌破档），−0.51 才进 −10
  assert.equal(pickBand(MARKET_MA20_BANDS, -0.5)!.points, 0);
  assert.equal(pickBand(MARKET_MA20_BANDS, -0.51)!.points, -10);
  assert.equal(pickBand(MARKET_BREADTH_LEVEL_BANDS, 0.55)!.points, 10);
  assert.equal(pickBand(MARKET_BREADTH_LEVEL_BANDS, 0.54)!.points, 0);
  assert.equal(pickBand(MARKET_BREADTH_LEVEL_BANDS, 0.35)!.points, 0, "35% 是普跌档的右开边界：正好 35% 不判普跌");
  assert.equal(pickBand(MARKET_BREADTH_LEVEL_BANDS, 0.34)!.points, -10);
  assert.equal(pickBand(MARKET_TURNOVER_BANDS, MARKET_VOLUME_SURGE_RATIO)!.points, 10);
  // 缩量线 0.8 本身归「持平」档（<0.8 才是缩量）：标签写的是「<」，判定就必须是右开
  assert.equal(pickBand(MARKET_TURNOVER_BANDS, MARKET_VOLUME_SHRINK_RATIO)!.points, 0);
  assert.equal(pickBand(MARKET_TURNOVER_BANDS, MARKET_VOLUME_SHRINK_RATIO - 0.01)!.points, -5);
  assert.equal(pickBand(MARKET_RPS_BANDS, 80)!.points, 10, "80 这一端任务书两头都写了 ⇒ 本层按左闭归强势档，label 必须写 ≥80 而不是嘴上 >80");
  assert.match(pickBand(MARKET_RPS_BANDS, 80)!.label, /≥80/);
  assert.match(pickBand(MARKET_RPS_BANDS, 80)!.note ?? "", /本层补充/);
  assert.equal(pickBand(MARKET_RPS_BANDS, 79.99)!.points, 5);
  assert.equal(pickBand(MARKET_RPS_BANDS, 50)!.points, 5);
  assert.equal(pickBand(MARKET_RPS_BANDS, 49.9)!.points, -10);
  // 极值必须与表同步：漏更新 = 内核拿错尺子（按十条计分档 + 风险等级四档重算一遍，与常量对账）
  const scoredTables = [MARKET_MA20_BANDS, MARKET_BREADTH_LEVEL_BANDS, MARKET_TURNOVER_BANDS, MARKET_RPS_BANDS,
    MARKET_MEDIAN_BANDS, MARKET_LIMITNET_BANDS, MARKET_BREAK_BANDS, MARKET_MAFLOW_BANDS, MARKET_THEME_BANDS];
  const risk = Object.values(MARKET_RISK_POINTS);
  assert.equal(scoredTables.reduce((a, g) => a + Math.max(...g.map((b) => b.points)), 0) + Math.max(...risk), MARKET_EXTREMES_UNCLAMPED.max);
  assert.equal(scoredTables.reduce((a, g) => a + Math.min(...g.map((b) => b.points)), 0) + Math.min(...risk), MARKET_EXTREMES_UNCLAMPED.min);
  assert.equal(MARKET_BREADTH_BANDS.length, 5, "旧五档占比表还在：它是 basis 的尺子，删了就没有「并入」这回事");
});

test("P7-⑦ 时间戳：盘内外状态回显；没有 trade_date 时整维度降级并登记，不静默", () => {
  assert.match(byRule(marketItems({ ...STRONG, live: true }), "M-BREADTH").raw, /盘中实时（收盘前会变）/);
  assert.match(byRule(marketItems({ ...STRONG, live: false }), "M-BREADTH").raw, /收盘\/休市/);
  const undated = marketDimension({ ...STRONG, trade_date: null });
  assert.equal(undated.status, "DEGRADED");
  assert.match(undated.missing.join(" / "), /没有 trade_date/);
  assert.match(byRule(undated.items, "M-BREADTH").raw, /读数所属日未给出/);
  assert.equal(undated.score, 27, "日期缺失不改变数字（读数是真的），改的是它能不能被当成当日事实引用");
  // 每条分项的 raw 都要带上所属日：decision-core 的 sources[] 只覆盖概率面，市场面的血缘只能挂在这里
  for (const i of marketItems(STRONG)) assert.match(i.raw, /读数所属日 2026-09-19/, `${i.rule} 的 raw 没带时间戳`);
});

test("P7-⑦ 文案：不出现「可信度/置信度/把握度 xx%」，每个百分号都有真实读数出处，且不出现概率字样", () => {
  for (const input of [STRONG, WEAK, CEILING, CEILFULL, DEEPWEAK, EMPTY]) {
    const text = marketItems(input).map((i) => `${i.label} ${i.points ?? "无"}｜${i.raw}｜${i.note ?? ""}`).join("\n");
    assert.ok(!/可信度|置信度|把握度/.test(text), text);
    assert.ok(!/概率|胜率/.test(text), "市场面不得出现概率字样：那是概率面的口径，凭空出现会牵动 probabilityCheck 的三项概率要求");
    for (const m of text.match(/(\d+(\.\d+)?)%/g) ?? []) {
      const line = text.split("\n").find((l) => l.includes(m))!;
      assert.ok(/占比|中位|涨跌幅|指数|涨跌|炸板|偏离|均线/.test(line), `百分号 ${m} 出现在没有真实读数出处的行里：${line}`);
    }
    for (const msg of marketDimension(input).missing) assert.ok(!/概率|胜率|可信度/.test(msg), msg);
  }
});

test("P7-⑦ 接进决策内核：市场面按折算刻度参与加权（22/100），并真的改变字面结论", () => {
  const withMarket = buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(DEEPWEAK)] });
  const without = buildDecision({ technical: fullTech, probability: probHigh(60) });
  assert.deepEqual(withMarket.included, ["technical", "probability", "market"], "事件面本次没传 ⇒ 仍按未计入处理");
  assert.equal(without.final_score, 70.2, "技术 +38→折算 +76×57/100 ＋ 概率 +25→折算 +62.5×43/100");
  assert.equal(without.grade, "偏强看多");
  assert.equal(withMarket.weights.applied.market, 0.2222, "0.2 / (0.4+0.3+0.2) 重归一");
  const mk = withMarket.dimensions.find((x) => x.key === "market")!;
  assert.equal(mk.score, -50, "字面分：夹到任务书的单维地板");
  assert.equal(mk.raw_score, -50);
  assert.equal(mk.norm_score, -100, "折算分：字面 −50 按本维极值 50 折算 ⇒ 满档反向");
  assert.deepEqual(mk.bounds, MARKET_EXTREMES, "折算用的尺子要随维度一起进输出，否则事后复看没法还原");
  assert.equal(mk.rule_version, MARKET_RULE_VERSION);
  assert.equal(withMarket.final_score, 32.4, "76×0.4444 + 62.5×0.3333 − 100×0.2222");
  assert.equal(withMarket.grade, "震荡偏强", "弱市场把「偏强看多」拉回「震荡偏强」：这才叫参与了加权，而不是挂个名字");
  assert.ok(withMarket.weights.renormalized);
  assert.equal(marketDimension(STRONG).score, 27);
  assert.equal(buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(STRONG)] }).final_score, 66.6, "同一份技术/概率读数，只因为市场面从 −50 换成 +27 就涨 34.2 分");
  const text = decisionToText(withMarket);
  assert.match(text, /市场环境：字面 -50｜本维极值 -50~50｜折算 -100 × 22\/100｜分层 DERIVED/, "记账行要把「字面分／尺子／折算分／生效权重」四件事一次说清");
  assert.match(text, /· 市场环境·普跌（上涨占比 <35%） -10（字面）｜上涨 400 家 \/ 下跌 4700 家（上涨占比 7\.8%）/, "分项归因带上维度名，与真实读数一起出现在文本里");
  assert.match(text, /【判定依据（已并入上表，不重复计分）】/);
  assert.match(text, /市场环境 M-BREADTH-SHARE 普跌（上涨占比 <25%） -6/, "basis 项要在专门分区里出现，且不混进加权的分项列表");
  const basisLine = text.split("\n").find((l) => l.startsWith("  · 市场环境 M-BREADTH-SHARE "))!;
  assert.equal((basisLine.match(/表 p7\.s3\.market\.v1/g) ?? []).length, 1, "出处在行尾只出现一次：同一行印两遍会被读成「这是两张不同的表」");
  assert.ok(text.includes("未计入【事件影响】"), "没传事件面时仍走未计入出口（v3 把它列在第三段：这次缺什么、什么在反对）");
  assert.ok(!/可信度\s*[:：]?\s*\d+(\.\d+)?%/.test(text));
  const s = decisionSections(buildDecision({ technical: fullTech, probability: probHigh(60), external: [marketExternal(STRONG)] }));
  assert.match(s.headline, /^① 综合评分 \+66\.6（−100~\+100 折算刻度）／趋势等级「偏强看多」$/);
  assert.ok(s.basis.some((b) => b.startsWith("市场环境·上涨家数多于下跌家数 +10（字面）")), "第二段取的是参与加权的字面分项");
  assert.equal(s.basis.some((b) => b.includes("M-BREADTH-SHARE")), false, "basis 项不进第二段：它不计分，进依据会被读成额外一票");
  assert.ok(s.risk.some((r) => r.includes("缺口【技术结构】")), "第三段是缺口清单");
});

test("P7-⑦ 只传市场面：权重重归一为 100/100，区间就是市场面这把尺子本身", () => {
  const only = buildDecision({ external: [marketExternal(CEILFULL)] });
  assert.deepEqual(only.included, ["market"]);
  assert.deepEqual(only.weights.applied, { technical: 0, probability: 0, market: 1, event: 0 });
  assert.equal(only.final_score, 100);
  assert.equal(only.grade, "强势看多", "单维满档 ⇒ 折算 +100、六档顶格：这就是「每一维各自归一到 ±100」的口径");
  assert.deepEqual(only.attainable, { min: -100, max: 100, unreachable_grades: [] });
  const text = decisionToText(only);
  assert.match(text, /市场环境：字面 \+50｜本维极值 -50~50｜折算 \+100 × 100\/100/);
  assert.ok(text.includes("未计入【技术结构】") && text.includes("未计入【历史概率】"), "其余三维仍走未计入出口，不是被静默丢掉");
});

test("P7-⑦ scoreBounds 对账：不带极值声明时仍是保守区间，带市场面后按各自尺子加宽", () => {
  const b = scoreBounds(DEFAULT_WEIGHTS);
  assert.deepEqual(b, { min: -58.75, max: 70, unreachable_grades: ["强势看多"] }, "这是内核只建模技术/概率两维时的口径");
  const withMarket = scoreBounds(DEFAULT_WEIGHTS, { market: MARKET_EXTREMES });
  assert.deepEqual(withMarket, { min: -78.75, max: 90, unreachable_grades: [] }, "市场面满档 ±100 ⇒ 区间加宽到 −78.75~90");
  assert.ok(withMarket.max > b.max && withMarket.min < b.min, "漏传 bounds 会静默把区间报窄：这条差值就是它的代价");
});

test("P7-⑦ 接线后：不传 external 时内核仍走「未计入」出口，只是把该找的表指出来", () => {
  const d = buildDecision({});
  assert.match(d.basis, /市场=p7\.s7\.market\.v1/, "口径行印的是新表的版本号");
  assert.doesNotMatch(d.basis, /市场=p7\.s3\.market\.v1/, "维度级登记不能退回旧表，否则页面会把新表的分数挂到旧出处");
  // 两条出口要分开钉：完全没传 external 与「传了维度但一条分项都没算出来」是两种缺失，
  // 前者的文案是「没有传入打分结果」，后者要说清「规则在、这次没算出来」，不得压成同一句。
  assert.match(d.dimensions.find((x) => x.key === "market")!.missing.join(""), /没有传入打分结果/, "没传读数就还是未计入 —— 补表不等于给缺失数据兜底");
  const emptyMarket = buildDecision({ external: [marketExternal(EMPTY)] });
  assert.equal(emptyMarket.included.includes("market"), false, "十个分项全算不出 ⇒ 整维度仍未计入，不给 0 分");
  assert.match(emptyMarket.dimensions.find((x) => x.key === "market")!.missing.join(""), /自带规则「p7\.s7\.market\.v1」，但本次没算出得分/);
  assert.equal(emptyMarket.final_score, null, "四维一条都没算出 ⇒ 依旧不给综合分，P7-① 的空输入出口一字未改");
  assert.equal(d.protocol_version, DECISION_PROTOCOL_VERSION);
  assert.equal(DECISION_PROTOCOL_VERSION, "p7.decision.v3");
});
