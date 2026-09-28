import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ramp, tierOfPressureScore, topPressure, PRESSURE_WEIGHTS, PRESSURE_BANDS, MIN_COMPONENTS_FOR_TIER,
  US_STALE_DAYS, type PressureInputs,
} from "../../src/lib/quant/screener/top-pressure-core.ts";
import { leaderStall, type Ladder, type LeaderStall, type PromotionResult, type RosterRow } from "../../src/lib/quant/screener/limit-up-roster-core.ts";
import type { Divergence } from "../../src/lib/quant/data/overseas-core.ts";

// P15-R20b 见顶压力分纯核钉测：刻度只有一份（top-pressure-core），这里把它每一条写死的规矩钉住。
// 最要紧的三件事：
//   ① 缺读数**整块退出并把权重摊出去**，不是当 0 分——当 0 分等于「今天没数据」洗成「今天很安全」；
//   ② 分量内取最差的一条子读数，**不相加**（炸板率和跌停家数经常是同一件事的两面）；
//   ③ 可用分量不足 3 条不出档，档位词只有 正常/注意/偏高/高风险 那四个。
// 期望值都是按锚点表手算的（表在 core 里，注释里写着），不是「跑出来多少就钉多少」。

const readSrc = (p: string) => readFileSync(new URL(p, new URL("../../", import.meta.url)), "utf8");

// ---------- 各形状的构造器（默认值都能出数，单条测试只改自己要改的那格） ----------

const promo = (rate1: number | null): PromotionResult => ({
  prevPool: 60, todayPool: 40,
  oneToTwo: { base: 40, promoted: 8, rate: rate1 },
  twoToThree: { base: 15, promoted: 3, rate: 20 },
  threePlus: { base: 9, promoted: 4, rate: 44.4 },
  computed: rate1 !== null,
  reason: rate1 === null ? "库里没有两份可比的涨停名单" : "",
});
// rate1=20 → ANCHOR_PROMO_RATE 上正好 25 分；44.4 ≥ 30 端点 → 0 分；断层 0 → 0 分 ⇒ 接力取最差的一条 = 25

const ladder = (gaps: number[] = [], highest = 5): Ladder => ({ highest, counts: [], gaps, unknownBoards: 0, total: 30 });

const leader = (o: Partial<LeaderStall> = {}): LeaderStall => ({
  date: "2026-09-24", highest: 5, tier: 4, sample: 4, read: 4, avg: -0.4, median: 0,
  benchmark: -2, gap: 0, verdict: "同步", available: true, reason: "", line: "龙头梯队一行", ...o,
});
// gap=0 → ANCHOR_LEADER_GAP 上 30 分

const diver = (o: Partial<Divergence> = {}): Divergence => ({
  kind: "外盘与A股同向下跌", a50_pct: -2, hk_pct: -1.1, us_tech_pct: 0.48, a_share_median: -2,
  not_priced_in: false, line: "背离判定：外盘与A股同向下跌。", evidence: [], missing: [], ...o,
});
// a50=-2 → ANCHOR_A50 上 85 分，同向下跌 factor 0.5 ⇒ 42.5

/** 六格全能出数的基准输入：25/25/30/76/40/42.5 → 加权 37.4（注意） */
const base = (o: Partial<PressureInputs> = {}): PressureInputs => ({
  as_of: "2026-09-28 10:30:00",
  breaker: { break_rate: 25, touched: 100, limit_up: 100, limit_down: 5, as_of: "盘中 · 全 A 快照" },
  relay: { promotion: promo(20), ladder: ladder(), roster_date: "2026-09-24" },
  leader: leader(),
  breadth: { slope_pt: -46, from_pct: 72.4, to_pct: 26.2, from_date: "2026-09-18", to_date: "2026-09-24", reason: "" },
  flow: { main_net_yi: -300, known: 5200, universe: 5569, as_of: "盘中 · 全 A 快照", alt: null },
  overseas: { divergence: diver(), us_age_days: 3, a50_as_of: "2026-09-28 10:29:51（上游原样）" },
  threshold_level: "偏高",
  ...o,
});
// 手算：炸板 25%(25) vs 跌停/涨停 0.05(3.3) 取最差 25 ｜ 接力 25 ｜ 龙头 gap 0 → 30
//       ｜ 宽度 −46 在 −40(70)~−60(90) 之间 → 76 ｜ 净额 −300 → 40 ｜ 外盘 85×0.5 → 42.5
//       Σ = 25*25+25*20+30*15+76*15+40*15+42.5*10 = 3740，/100 = 37.4

const comp = (r: ReturnType<typeof topPressure>, key: string) => r.components.find((c) => c.key === key)!;

const rosterRow = (symbol: string, boards: number | null): RosterRow => ({
  symbol, name: symbol.slice(0, 6), industry: "半导体", boards, changePct: 10,
  firstSeal: "09:30:00", lastSeal: "14:00:00", breakCount: 0, sealFund: 1e8, floatCap: 5e9,
});

// ---------- 刻度本体 ----------

test("R20b-纯① ramp：端点外夹紧、中间线性内插，降序写的表也要先按 x 排序（否则正常读数会静默落 0 分）", () => {
  const asc: (readonly [number, number])[] = [[0, 0], [10, 50]];
  assert.equal(ramp(asc, -3), 0, "低于下界夹紧在下界");
  assert.equal(ramp(asc, 5), 25, "中间内插");
  assert.equal(ramp(asc, 99), 50, "高于上界夹紧在上界（不是外推爆掉）");

  // 接力那条锚点是**按「压力从小到大」写的**（30%→0 分 … 0%→90 分），x 轴是降序。
  // 不在 ramp 里排序的话，21% 会被当成「低于下界」直接吃 0 分——刻度错得毫无动静。
  const desc: (readonly [number, number])[] = [[30, 0], [20, 25], [10, 55], [5, 75], [0, 90]];
  assert.equal(ramp(desc, 21), 22.5, "降序表：21% 该在 20%(25 分)~30%(0 分) 之间内插出 22.5，不是 0");
  assert.equal(ramp(desc, -5), 90, "比 0% 还低 → 夹紧在最紧那一端 90");
  assert.equal(ramp(desc, 45), 0, "比 30% 还松 → 夹紧在 0");
  assert.ok(Number.isFinite(ramp(desc, 21)), "任何输入都不该返回 NaN");
});

test("R20b-纯② 档位带：只有那四个词，边界含下不含上（30 分即「注意」）", () => {
  assert.deepEqual(PRESSURE_BANDS.map((b) => b.tier), ["高风险", "偏高", "注意", "正常"]);
  assert.equal(tierOfPressureScore(70), "高风险");
  assert.equal(tierOfPressureScore(69.9), "偏高");
  assert.equal(tierOfPressureScore(50), "偏高");
  assert.equal(tierOfPressureScore(49.9), "注意");
  assert.equal(tierOfPressureScore(30), "注意");
  assert.equal(tierOfPressureScore(29.9), "正常");
  assert.equal(tierOfPressureScore(0), "正常");
  assert.deepEqual(Object.values(PRESSURE_WEIGHTS).reduce((a, b) => a + b, 0), 100, "六分量权重合计 100");
});

test("R20b-纯③ 六分量全在：总分 = Σ(权重×分)/100，line 里点出压力最大的两条", () => {
  const r = topPressure(base());
  assert.equal(r.available_weight, 100);
  assert.equal(r.renormalized, false);
  assert.equal(r.score, 37.4, "手算 3740/100");
  assert.equal(r.tier, tierOfPressureScore(37.4));
  // 复算一遍：不许 core 里另有一条加权公式和这里对不上
  const recompute = r.components.reduce((s, c) => s + (c.available ? c.weight * (c.score as number) : 0), 0) / r.available_weight;
  assert.equal(Math.round(recompute * 10) / 10, r.score);
  assert.ok(r.line.includes("宽度骤降 76 分") && r.line.includes("外盘与 A50 43 分"), `主要压力来源要挑出最坏两条：${r.line}`);
  assert.ok(r.line.includes("六分量全在"));
  assert.equal(r.dropped.length, 0);
});

// ---------- 规矩 2：缺读数整块退出 ----------

test("R20b-纯④ 主力净额一家都没读到：这一格退出且权重摊给其余五条，绝不是当 0 分", () => {
  const r = topPressure(base({
    flow: { main_net_yi: 0, known: 0, universe: 5569, as_of: "盘中 · 全 A 快照", alt: null },
  }));
  const f = comp(r, "flow");
  assert.equal(f.available, false);
  assert.equal(f.score, null, "缺读数时 score 是 null，不是 0");
  assert.equal(r.available_weight, 85);
  assert.equal(r.renormalized, true);
  assert.equal(r.score, 36.9, "(3740-600)/85 = 36.94 → 36.9：分母换成 85，不是还除 100");
  assert.ok(f.reason.includes("?? 0 累出来的"), `要说清那个 0 是累出来的：${f.reason}`);
  assert.ok(r.dropped.some((d) => d.includes("主力资金净额")));
  assert.ok(r.line.includes("权重已摊给其余"), "line 要交代有几条没进来");
});

test("R20b-纯⑤ 缺读数当 0 分就是洗白：只剩三条能出数时按 55 归一（当 0 分会掉进「正常」）", () => {
  const r = topPressure(base({
    relay: { promotion: promo(null), ladder: null, roster_date: null },
    flow: { main_net_yi: null, known: 0, universe: 5569, as_of: "—", alt: null },
    overseas: { divergence: null, us_age_days: null, a50_as_of: "外盘这一路没取到" },
  }));
  assert.equal(r.available_weight, 25 + 15 + 15); // 炸板 25 + 龙头 15 + 宽度 15
  assert.equal(r.score, 40.3, "(625+450+1140)/55 = 40.27 → 缺的三条没被当 0 分拉低");
  assert.equal(r.tier, "注意", "若把缺失当 0 分，2215/100=22.2 会被说成「正常」——那正是这套分最不能犯的错");
  assert.equal(r.dropped.length, 3);
});

test("R20b-纯⑥ 可用分量不足 3 条：不出档、不猜分，缺的逐条说原因", () => {
  const r = topPressure(base({
    relay: { promotion: promo(null), ladder: null, roster_date: null },
    flow: { main_net_yi: null, known: 0, universe: 5569, as_of: "—", alt: null },
    overseas: { divergence: null, us_age_days: null, a50_as_of: "—" },
    leader: null,
  }));
  assert.ok(MIN_COMPONENTS_FOR_TIER === 3);
  assert.equal(r.score, null, "两条读数拼出来的 0–100 是噪声，宁可不给分");
  assert.equal(r.tier, "");
  assert.ok(r.line.includes("算不出") && r.line.includes("只有 2 条"), r.line);
  assert.ok(r.crosscheck.includes("档位以五阈值那边为准"), r.crosscheck);
  assert.equal(r.components.length, 6, "六格仍然全部摆出来，只是退出那几格写着原因");
  assert.ok(r.components.every((c) => c.available || c.reason.length > 0), "退出的格子必须带原因，不能空着");
});

// ---------- 规矩 1：分量内取最差，不相加 ----------

test("R20b-纯⑦ 炸板率与跌停/涨停比同拍时取更差的一条（相加会把一次坏消息记两次）", () => {
  const r = topPressure(base({
    breaker: { break_rate: 25, touched: 100, limit_up: 40, limit_down: 40, as_of: "盘中 · 全 A 快照" },
  }));
  const b = comp(r, "breaker");
  assert.equal(b.score, 60, "炸板 25%→25 分、跌停/涨停=1→60 分：取 60，不是 25+60");
  assert.ok(b.from.includes("分量内取更差的一档"), b.from);
  assert.ok(b.from.includes("炸板率") && b.from.includes("跌停/涨停"), "两条子读数都要露出来");
});

test("R20b-纯⑧ 涨停 0 家 / 触板 0 家：分母为 0 不折成「无穷大」，也不留一格空的", () => {
  const noUp = topPressure(base({
    breaker: { break_rate: 20, touched: 50, limit_up: 0, limit_down: 8, as_of: "盘中 · 全 A 快照" },
  }));
  const b = comp(noUp, "breaker");
  assert.equal(b.score, 60, "比值算不出来：按「跌停反超」这一档记 60");
  assert.ok(b.from.includes("比值算不出来"), b.from);

  const noTouch = topPressure(base({
    breaker: { break_rate: null, touched: 0, limit_up: 0, limit_down: 0, as_of: "盘中 · 全 A 快照" },
  }));
  const t = comp(noTouch, "breaker");
  assert.equal(t.available, false);
  assert.ok(t.reason.includes("没有分母") && t.reason.includes("整块退出"), t.reason);
});

// ---------- 外盘那格的三条规矩：同向减半 / 前瞻满额 / 陈旧不进打分 ----------

test("R20b-纯⑨ 外盘与 A 股同向跌 → 半额；外盘弱而 A 股扛住 → 满额；外盘强而 A 股弱 → 0 分", () => {
  const same = topPressure(base({ overseas: { divergence: diver({ kind: "外盘与A股同向下跌" }), us_age_days: 1, a50_as_of: "—" } }));
  assert.equal(comp(same, "overseas").score, 42.5, "85 × 0.5：同一件事不扣两次");
  assert.ok(comp(same, "overseas").reason.includes("半额"), comp(same, "overseas").reason);

  const ahead = topPressure(base({
    overseas: { divergence: diver({ kind: "外盘弱而A股没跟", not_priced_in: true }), us_age_days: 1, a50_as_of: "—" },
  }));
  assert.equal(comp(ahead, "overseas").score, 85, "还没进价格的前瞻背离按满额记");

  const internal = topPressure(base({
    overseas: { divergence: diver({ kind: "外盘强而A股弱", a50_pct: 0.9, not_priced_in: false }), us_age_days: 1, a50_as_of: "—" },
  }));
  assert.equal(comp(internal, "overseas").score, 0, "问题在内部：外盘这格不加分");
  assert.ok(comp(internal, "overseas").reason.includes("不加分"), comp(internal, "overseas").reason);
});

test("R20b-纯⑩ 唯一能读到的外盘是几天前的隔夜美股：整格退出，不带着 0 分占权重", () => {
  const r = topPressure(base({
    overseas: {
      divergence: diver({ kind: "读数不足", a50_pct: null, us_tech_pct: -3 }),
      us_age_days: US_STALE_DAYS + 2,
      a50_as_of: "A50 无读数，用隔夜美股",
    },
  }));
  const o = comp(r, "overseas");
  assert.ok(o.reading.includes("超出隔夜窗口"), o.reading);
  assert.equal(o.available, false, "手里一条都没用上 → 这格等于没读数（当 0 分就是把总分往「正常」拽）");
  assert.ok(o.reason.includes("不是「外盘没有压力」"), o.reason);
  assert.equal(r.available_weight, 90);
});

// ---------- 每格都要说自己属于哪个时间 ----------

test("R20b-纯⑪ 六格各带 as_of：名单日期、收盘位、盘中快照不许混成「今天」", () => {
  const r = topPressure(base());
  const by = (k: string) => comp(r, k);
  assert.ok(by("relay").as_of.includes("2026-09-24 名单"), by("relay").as_of);
  assert.ok(by("leader").as_of.includes("2026-09-24") && by("leader").as_of.includes("盘中"), by("leader").as_of);
  assert.ok(by("breadth").as_of.includes("2026-09-24 收盘位"), by("breadth").as_of);
  assert.ok(by("breaker").as_of.includes("全 A 快照"), by("breaker").as_of);
  assert.equal(r.as_of, "2026-09-28 10:30:00", "总表时刻是调用方喂进来的，纯核不看钟");
});

test("R20b-纯⑫ 宽度只有单点 / 龙头没有基准：都不出结论，但读数原样亮着", () => {
  const onePoint = topPressure(base({
    breadth: { slope_pt: null, from_pct: null, to_pct: 26.2, from_date: null, to_date: "2026-09-24", reason: "只攒到一天" },
  }));
  const b = comp(onePoint, "breadth");
  assert.equal(b.available, false);
  assert.ok(b.reading.includes("26.2%"), `单点仍要亮出来给人看：${b.reading}`);
  assert.ok(!b.reading.includes("0.0%"), "缺的那一头不许被写成 0%");

  // 龙头那一格走**真链路**：让 roster-core 的 leaderStall 自己判「没有基准」，
  // 压力分这边只负责把它转成「整格退出 + 原话摆在 reason」，不在测试里替它编一句假原因。
  const raw = leaderStall("2026-09-24",
    [rosterRow("600001.SH", 5), rosterRow("600002.SH", 4)],
    new Map<string, number | null>([["600001.SH", 0.8], ["600002.SH", 0.2]]), null);
  assert.equal(raw.available, false);
  const noBenchmark = topPressure(base({ leader: raw }));
  const l = comp(noBenchmark, "leader");
  assert.equal(l.available, false);
  assert.ok(l.reason.includes("不拿 0 当基准"), l.reason);
});

test("R20b-纯⑬ 与原有五阈值只对照、不改档：一致 / 高一档 / 低一档 三种话都要说清", () => {
  assert.ok(topPressure(base({ threshold_level: "注意" })).crosscheck.includes("与五阈值档位一致（都是「注意」）"));
  const lower = topPressure(base({ threshold_level: "高风险" }));
  assert.ok(lower.crosscheck.includes("比五阈值档位低一档") && lower.crosscheck.includes("取更保守的那一档"), lower.crosscheck);
  const higher = topPressure(base({ threshold_level: "正常" }));
  assert.ok(higher.crosscheck.includes("比五阈值档位高一档"), higher.crosscheck);
  assert.ok(topPressure(base({ threshold_level: null })).crosscheck.includes("没有读数可对照"));
  assert.equal(lower.tier, "注意", "对照不改档：阈值那边说高风险，压力分这边仍按自己的 37.4 出「注意」");
});

// ---------- 口径防线：宽度那一格不许回落到种子列 ----------

test("R20b-纯⑭ 宽度读数只许吃 stock_daily_close 自算的那条三市序列（防回落到 market_daily_stats 的种子列）", () => {
  const src = readSrc("src/lib/quant/screener/top-pressure.ts");
  assert.ok(src.includes("computeBreadthSeries"), "宽度分量要吃 breadth-core 那条纯核序列");
  assert.ok(src.includes("DEFAULT_BREADTH_SCOPE"), "票池默认口径要跟大盘页同一个常量，不在这里另写一套");
  assert.ok(!/marketDailyStats/.test(src), "market_daily_stats.aboveMa5Pct 一根 09-24 前是种子两市、09-24 后是自产三市，"
    + "拿它做「4 日落差」会把两种票池混进一次减法（R19c 已定案的错标形状）");
  assert.ok(src.includes("stockDailyClose"), "取数落在逐票收盘价表上");
  assert.ok(src.includes("breadthCalendarLookback"), "交易日→日历日的分母跟大盘页同一条，不许本地再写一个乘数");
});
