// P2 剩余因子包（任务书 2026-09-19）单元测试 —— 无网络 / 无DB / 纯逻辑，node:test 直跑
// 纪律：不改公式、不改参数；pending 因子只验登记状态；不造数冒充真实行情。
// 运行：node --test tests/quant/p2-factor-pack.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FACTOR_FIELD_DEFS, FACTOR_FIELD_MAP, factorCatalog, buildFieldPanel,
  hhv, llv, refRollMin, refRollMax, pctChange, vwapFullCalc, vwapCalc,
  czRangeSignals, srSignals, candlePatternCalc, sma,
  type BarsLike,
} from "../../src/lib/quant/factors/fields.ts";

type S = (number | null)[];
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// 确定性伪随机游走（LCG），产出合法 OHLCV（含成交额）
function walk(n: number, seed = 987654): BarsLike[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let c = 20;
  const out: BarsLike[] = [];
  for (let t = 0; t < n; t++) {
    const o = c;
    c = Math.max(5, c * (1 + (rnd() - 0.5) * 0.06));
    const h = Math.max(o, c) * (1 + rnd() * 0.02);
    const l = Math.min(o, c) * (1 - rnd() * 0.02);
    const v = 1000 + Math.floor(rnd() * 500);
    out.push({ date: `d${String(t).padStart(4, "0")}`, o, h, l, c, v, amount: c * v });
  }
  return out;
}

const dateSeq = (n: number) => Array.from({ length: n }, (_, i) => `d${String(i).padStart(4, "0")}`);
void dateSeq;
function toCols(bars: BarsLike[]) {
  return {
    o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l),
    c: bars.map((b) => b.c), v: bars.map((b) => b.v), amount: bars.map((b) => b.amount ?? null),
  };
}

// ---------- hhv / llv（含当日） ----------
test("hhv/llv：含当日窗口 + null 传染", () => {
  const x: S = [3, 1, 4, null, 5];
  // t=1: max(3,1)=3; t=2: max(1,4)=4; t=3/4 窗口含 null → null
  assert.deepEqual(hhv(x, 2), [null, 3, 4, null, null]);
  assert.deepEqual(llv(x, 3), [null, null, 1, null, null]);
});

// ---------- refRollMin/Max（不含当日） ----------
test("refRollMin/Max：t 取 [t-n, t-1]，起点 t=n", () => {
  const x: S = [5, 4, 3, 2, 1, 9];
  assert.deepEqual(refRollMin(x, 3), [null, null, null, 3, 2, 1]);
  assert.deepEqual(refRollMax(x, 3), [null, null, null, 5, 4, 3]);
});

// ---------- pctChange ----------
test("pctChange：正常/基期缺失/基期为0 → null 不伪造", () => {
  const x: S = [100, null, 110, 0, 121];
  assert.equal(pctChange(x, 1)[1], null); // 今日 null
  assert.ok(near(pctChange(x, 2)[2]!, 10, 1e-9)); // 110/100-1（浮点容差）
  assert.equal(pctChange(x, 1)[2], null); // 基期 null
  assert.ok((pctChange(x, 2)[4] ?? NaN) > 0); // 121 vs 110 → +10%
  const withZero: S = [0, 5];
  assert.equal(pctChange(withZero, 1)[1], null); // 基期为 0 不可判
});

// ---------- vwap_full / vwap30 / market_cost_60 ----------
test("vwapFullCalc：只累计有效量额日；全程无有效 → null", () => {
  const v: S = [100, 100, null, 0, 100];
  const amt: S = [1000, 1100, null, 50, 1400];
  const out = vwapFullCalc(v, amt);
  assert.equal(out[0], 10); // 1000/100
  assert.equal(out[1], 10.5); // 2100/200
  assert.equal(out[2], 10.5); // 无效日不改变累计（t=2 无新增）
  assert.equal(out[3], 10.5); // amount=50 但 v=0 → 该日无效（amt>0 且 v>0 才计）
  assert.equal(out[4], (1000 + 1100 + 1400) / 300);
  assert.deepEqual(vwapFullCalc([null], [null]), [null]);
});

test("vwap30/market_cost_60 与 vwapCalc 同口径（等权K线 = 收盘价）", () => {
  const bars = walk(100);
  const { c, v, amount } = toCols(bars);
  const w30 = vwapCalc(c, v, amount, 30).vwap;
  const sumAmt = amount.slice(21, 51).reduce<number>((s, x) => s + (x ?? 0), 0);
  const sumV = v.slice(21, 51).reduce<number>((s, x) => s + x, 0);
  assert.ok(w30[50] !== null && near(w30[50]!, sumAmt / sumV, 1e-9));
  assert.equal(w30[28], null); // 不足 30 根 → null
});

// ---------- vwap_slope3/6/accel ----------
test("vwap_slope3/6/accel：由 vwap_full 递推，数值与手算一致", () => {
  const bars = walk(60);
  const { v, amount } = toCols(bars);
  const vf = vwapFullCalc(v, amount);
  const sl3 = pctChange(vf, 3);
  const accel = pctChange(sl3, 3);
  assert.equal(sl3[10], ((vf[10]! / vf[7]!) - 1) * 100);
  assert.equal(accel[20], ((sl3[20]! / sl3[17]!) - 1) * 100);
  assert.equal(sl3[2], null);
});

// ---------- 缠论简化中枢 czRangeSignals ----------
test("czRangeSignals：区间含当日；start/end/inside 事件正确", () => {
  const h: S = [10, 10, 10, 12, 12, 12, 8];
  const l: S = [8, 8, 8, 8, 8, 8, 6];
  const c: S = [9, 9, 9, 9, 9, 13, 7]; // t=5 突破上沿（c=13 > HHV=12），t=6 跌破下沿
  const r = czRangeSignals(h, l, c, 3);
  assert.deepEqual(r.active.slice(2, 5), [1, 1, 1]);
  assert.equal(r.active[0], null);
  // t=2 进入（此前 t<2 数据不足区间 → start null）；t=5 前一日在区间内、今日 13>zg=12 → end=1
  assert.equal(r.end[5], 1);
  assert.equal(r.start[5], 0);
  assert.equal(r.end[6], 0); // t=5 已不在区间 → 再脱离不算「结束事件」
});

test("czRangeSignals inside：区间宽度收窄日为 1", () => {
  // 窗口3：t=4 宽度=10-8=2；t=5 zg=9.5 zd=9 宽度=0.5 → 收窄
  const h: S = [10, 10, 10, 10, 9.5, 9.5];
  const l: S = [8, 8, 8, 9, 9, 9];
  const c: S = [8.5, 8.5, 8.5, 9, 9.2, 9.1];
  const r = czRangeSignals(h, l, c, 3);
  assert.equal(r.inside[4], 0); // 2 vs 2 未收窄
  assert.equal(r.inside[5], 1); // 0.5 < 2 且仍在区间内
});

// ---------- srSignals（250/144 变体信号族） ----------
test("srSignals：线=不含当日；bounce/break/near/连续确认 逐条验证", () => {
  const n = 3;
  // 10根K：前3根 lows [5,6,7] → t=3 时 sup=min(5,6,7)=5
  const l: S = [5, 6, 7, 4, 7, 7, 7, 7, 3, 3];
  const h: S = [10, 9, 8, 8, 8, 8, 8, 8, 8, 12];
  const c: S = [9, 9, 9, 4.5, 9, 9, 9, 9, 2.5, 2.4];
  const o: S = c.map((x) => x!);
  const v: S = Array(10).fill(100);
  const vma: S = Array(10).fill(100);
  const r = srSignals(h, l, c, v, n, vma);
  assert.equal(r.supLine[2], null); // t<n → null
  assert.equal(r.supLine[3], 5);
  assert.equal(r.resLine[3], 10);
  // t=3: low=4 <= 5*1.02 且 c(4.5)>ref c(9)? 否 → bounce=0
  assert.equal(r.bounce[3], 0);
  // t=4: sup=min(6,7,4)=4；low=7>4.08 → bounce 0；构造 true 用例见下
  // supportBreak：t=4 sup=4, c=9>=? ref: pc=c[3]=4.5 >= supLine[3]=5? 4.5>=5 false → 0
  // 直接构造单调场景断言 near/breakdown：
  const l2: S = [5, 5, 5, 5, 5, 5];
  const h2: S = [10, 10, 10, 10, 10, 10];
  const c2: S = [9, 9, 9, 9.1, 4.9, 4.8];
  const r2 = srSignals(h2, l2, c2, v, 3, vma);
  // t=4: sup=5, c=4.9<5 且 pc=9.1>=5(=sup[3]) → supportBreak=1
  assert.equal(r2.supportBreak[4], 1);
  // t=5: sup=5, c=4.8<5 且 pc=4.9<sup[4]=5 → breakdown2=1
  assert.equal(r2.supportBreakdown2[5], 1);
  assert.equal(r2.supportBreakdown2[4], 0); // 只破一天
  // near：t=3 c=9.1 距 sup=5 太远 → 0
  assert.equal(r2.supportNear[3], 0);
  // resistance 侧：突破并连续确认
  const c3: S = [9, 9, 9, 11, 11.5];
  const r3 = srSignals(h2, l2, c3, v, 3, vma);
  assert.equal(r3.resistanceBreakoutVol[4], 0); // vol=100 不 > 150
  const vBig: S = [1000, 1000, 1000, 1000, 1000];
  const r3b = srSignals(h2, l2, c3, vBig, 3, vma);
  assert.equal(r3b.resistanceBreakoutVol[4], 1); // c=11.5>res=10 且放量
  assert.equal(r3.resistanceBreakoutConf2[4], 1); // 连续两日收在 10 上方
  void o;
});

// ---------- candlePatternCalc ----------
test("candlePatternCalc：六种标签 + 优先级 + t=0 不判", () => {
  // t=0 基准；t=1 大阳；t=2 十字星；t=3 锤头；t=4 大阴；t=5 看涨吞没；t=6 看跌吞没
  const o: S = [10, 10, 10, 10, 10, 8.5, 11.5];
  const h: S = [10.1, 13.1, 13.5, 10.4, 10, 11.2, 11.6];
  const l: S = [9.9, 9.9, 6.5, 8.1, 8.7, 8.4, 7.9];
  const c: S = [10, 13, 10.05, 10.3, 8.8, 11, 8];
  const labels = candlePatternCalc(o, h, l, c);
  assert.equal(labels[0], null);
  assert.equal(labels[1], "大阳"); // 收阳 +30%
  assert.equal(labels[2], "十字星"); // 实体0.05 ≤ 10%×7
  assert.equal(labels[3], "锤头"); // body0.3>0.23(10%振幅,非十字星)；下影1.9≥2×0.3？1.9≥0.6✓ 上影0.1≤0.15✓；涨幅2.5%<3%非大阳
  assert.equal(labels[4], "大阴"); // -13.7% 收阴；吞没条件 ov(10)>=pc(10.2) 不成立 → 非吞没
  assert.equal(labels[5], "看涨吞没"); // 昨阴(10→8.8) 今阳(8.5→11) 实体2.5≥1.2 完全包住
  assert.equal(labels[6], "看跌吞没"); // 昨阳(8.5→11) 今阴(11.5→8) 实体3.5≥2.5 完全包住
});

// ---------- 面板接线 ----------
const panelOf = (bars: BarsLike[]) =>
  buildFieldPanel(["T1.SH"], [bars], [{ symbol: "T1.SH" }]).fields;

test("buildFieldPanel：全部新实现因子出现在面板且值域合法", () => {
  const bars = walk(320); // 覆盖 250 窗口
  const f = panelOf(bars);
  const keys = [
    "vwap30", "vwap_full", "vwap_slope3", "vwap_slope6", "vwap_accel", "vwap_lowpullback", "vwap_break_expand",
    "gauss_entry", "gauss_exit", "gauss_overheat_warn",
    "cz_active", "cz_start", "cz_end", "cz_inside",
    "support_line_250", "resistance_line_250", "support_bounce_250", "resistance_rebound_250",
    "support_break_250", "resistance_breakout_250", "support_near_250", "resistance_near_250",
    "support_breakdown_250", "resistance_breakout_250_conf", "support_144_val", "resistance_144_val",
    "market_cost_60", "vol_spike_ratio", "close_dev_ma120", "amplitude_20d",
  ];
  for (const k of keys) {
    const col = f.get(k);
    assert.ok(col, `面板缺少字段 ${k}`);
    assert.equal(col[0].length, bars.length);
  }
  // 线值字段：250 窗口在 t=249 才有首个值（含当日口径 t>=249）
  assert.equal(f.get("support_line_250")![0][248], null);
  assert.ok(f.get("support_line_250")![0][249] !== null);
  assert.ok(f.get("resistance_line_250")![0][300] !== null);
  // 信号字段值域 {0,1,null}
  for (const k of ["cz_active", "gauss_entry", "support_bounce_250", "vwap_lowpullback", "vwap_break_expand", "gauss_overheat_warn", "resistance_breakout_250_conf"]) {
    for (const v of f.get(k)![0]) assert.ok(v === null || v === 0 || v === 1, `${k} 出现非 0/1/null：${v}`);
  }
  // 无量额K线（腾讯口径 amount=0）→ vwap 族整段 null（宁缺勿假）
  const noAmt: BarsLike[] = bars.map((b) => ({ ...b, amount: undefined }));
  const f2 = panelOf(noAmt);
  assert.ok(f2.get("vwap30")![0].every((v) => v === null));
  assert.ok(f2.get("market_cost_60")![0].every((v) => v === null));
});

test("超级共振：类型 = 高斯入场×主力触发 组合；信号 = 任一命中（稳智口径反推，本地为上界）", () => {
  const bars = walk(320);
  const f = panelOf(bars);
  const K = ["super_resonance_signal", "super_resonance_trend", "super_resonance_main", "super_resonance_force"];
  for (const k of K) {
    const col = f.get(k);
    assert.ok(col, `面板缺少字段 ${k}`);
    assert.equal(col![0].length, bars.length);
    for (const v of col![0]) assert.ok(v === null || v === 0 || v === 1, `${k} 出现非 0/1/null：${v}`);
  }
  const ge = f.get("gauss_entry")![0], zt = f.get("zsb_trigger")![0];
  const sig = f.get("super_resonance_signal")![0], tr = f.get("super_resonance_trend")![0];
  const mn = f.get("super_resonance_main")![0], fo = f.get("super_resonance_force")![0];
  for (let t = 0; t < bars.length; t++) {
    // 依赖任一为 null → 该日整组 null（宁缺勿假，不把缺当 0）
    if (ge[t] === null || zt[t] === null) {
      assert.equal(sig[t], null, `t=${t} 依赖缺失应整组 null`);
      continue;
    }
    const isG = ge[t] === 1, isZ = zt[t] === 1;
    assert.equal(sig[t], isG || isZ ? 1 : 0, `t=${t} signal`);
    assert.equal(tr[t], isG && !isZ ? 1 : 0, `t=${t} trend(仅高斯)`);
    assert.equal(mn[t], isZ && !isG ? 1 : 0, `t=${t} main(仅主力)`);
    assert.equal(fo[t], isG && isZ ? 1 : 0, `t=${t} force(同时)`);
    // 三种类型互斥：同一天至多一个为 1
    assert.ok([tr[t], mn[t], fo[t]].filter((v) => v === 1).length <= 1, `t=${t} 类型必须互斥`);
  }
});

test("行业RPS快照：sector_rps_50/120、in_sector_rps_50/120 由 meta 注入为常数列；缺值→null（不造数）", () => {
  const bars = walk(60);
  // 有种子：四列填充为常数列
  const withSeed = buildFieldPanel(
    ["600000.SH"], [bars],
    [{ symbol: "600000.SH", sectorRps50: 81, sectorRps120: 64, inSectorRps50: 42, inSectorRps120: 33 }],
  ).fields;
  const sr = withSeed.get("sector_rps_50")![0];
  const sr120 = withSeed.get("sector_rps_120")![0];
  const ir = withSeed.get("in_sector_rps_50")![0];
  const ir120 = withSeed.get("in_sector_rps_120")![0];
  assert.equal(sr.length, bars.length);
  assert.ok(sr.every((v) => v === 81), "sector_rps_50 应为常数 81");
  assert.ok(sr120.every((v) => v === 64), "sector_rps_120 应为常数 64");
  assert.ok(ir.every((v) => v === 42), "in_sector_rps_50 应为常数 42");
  assert.ok(ir120.every((v) => v === 33), "in_sector_rps_120 应为常数 33");
  // 无种子：整列 null（如实露缺，不补 0）
  const noSeed = buildFieldPanel(["600000.SH"], [bars], [{ symbol: "600000.SH" }]).fields;
  assert.ok(noSeed.get("sector_rps_50")![0].every((v) => v === null));
  assert.ok(noSeed.get("sector_rps_120")![0].every((v) => v === null));
  assert.ok(noSeed.get("in_sector_rps_50")![0].every((v) => v === null));
  assert.ok(noSeed.get("in_sector_rps_120")![0].every((v) => v === null));
  // 口径：稳智种子快照，非本地 K线重算 → source=snapshot
  assert.equal(FACTOR_FIELD_MAP.get("sector_rps_50")!.source, "snapshot");
  assert.equal(FACTOR_FIELD_MAP.get("sector_rps_120")!.source, "snapshot");
  assert.equal(FACTOR_FIELD_MAP.get("in_sector_rps_50")!.source, "snapshot");
  assert.equal(FACTOR_FIELD_MAP.get("in_sector_rps_120")!.source, "snapshot");
});

test("close / above_cost_60：收盘价=K线c；above_cost_60 = (C>=market_cost_60)", () => {
  const bars = walk(90);
  const f = panelOf(bars);
  const c = bars.map((b) => b.c);
  const close = f.get("close")![0];
  const cost = f.get("market_cost_60")![0];
  const above = f.get("above_cost_60")![0];
  for (let t = 0; t < bars.length; t++) {
    assert.equal(close[t], c[t], `t=${t} close 应等于K线收盘`);
    if (cost[t] === null || c[t] === null) {
      assert.equal(above[t], null, `t=${t} 成本线缺失应整组 null`);
    } else {
      assert.equal(above[t], c[t]! >= cost[t]! ? 1 : 0, `t=${t} above_cost_60`);
    }
  }
  // 无量额 → market_cost_60 整段 null → above_cost_60 也整段 null（不补 0）
  const noAmt: BarsLike[] = bars.map((b) => ({ ...b, amount: undefined }));
  const f2 = panelOf(noAmt);
  assert.ok(f2.get("market_cost_60")![0].every((v) => v === null));
  assert.ok(f2.get("above_cost_60")![0].every((v) => v === null));
});

test("vol_spike_ratio/close_dev_ma120/amplitude_20d 数值与纯公式一致", () => {
  const bars = walk(200);
  const f = panelOf(bars);
  const { o, h, l, c, v } = toCols(bars);
  const mv20 = sma(v, 20);
  assert.ok(near(f.get("vol_spike_ratio")![0][150]!, v[150] / mv20[150]!));
  const m120 = sma(c, 120);
  assert.ok(near(f.get("close_dev_ma120")![0][190]!, (c[190] / m120[190]! - 1) * 100));
  assert.ok(near(f.get("amplitude_20d")![0][190]!, (Math.max(...h.slice(171, 191)) - Math.min(...l.slice(171, 191))) / Math.min(...l.slice(171, 191)) * 100));
  void o;
});

// ---------- 注册表状态 ----------
const NEW_IMPLEMENTED = [
  "vwap30", "vwap_full", "vwap_slope3", "vwap_slope6", "vwap_accel", "vwap_lowpullback", "vwap_break_expand",
  "gauss_entry", "gauss_exit", "gauss_overheat_warn",
  "cz_active", "cz_start", "cz_end", "cz_inside",
  "support_line_250", "resistance_line_250", "support_bounce_250", "resistance_rebound_250",
  "support_break_250", "resistance_breakout_250", "support_near_250", "resistance_near_250",
  "support_breakdown_250", "resistance_breakout_250_conf", "support_144_val", "resistance_144_val",
  "market_cost_60", "vol_spike_ratio", "close_dev_ma120", "amplitude_20d",
  // 2026-09-25：对齐稳智 /screener 的「突破60日成本 / 看涨吞没 / 早晨之星」新增的三个可筛选字段
  "break_cost_60", "candle_bullish_engulf", "candle_morning_star",
  // 2026-09-26：反推稳智「超级共振」——类型 = 高斯入场×主力触发 组合，信号 = 任一命中（本地为上界）
  "super_resonance_signal", "super_resonance_trend", "super_resonance_main", "super_resonance_force",
  // 2026-09-26：稳智行业 RPS 种子（sector_rps_50/120、in_sector_rps_50/120）——快照口径，非本地 K线重算
  "sector_rps_50", "sector_rps_120", "in_sector_rps_50", "in_sector_rps_120",
  // 2026-09-26：为导入稳智 721 条策略补齐的两个 K线因子——close（供无字段 rolling_return）、above_cost_60
  "close", "above_cost_60",
];
const NEW_PENDING = [
  "candle_patterns_text", "pe_dynamic",
  "concept_rps_50", "concept_rps_120", "concept_lead_strength",
  "bidding_reversal_signal", "bidding_reversal_score", "bidding_volume_ratio", "bidding_premium_score",
  "super_resonance_week", "zsb_super_buy",
];

test("注册表：key 唯一；新因子全部注册；总数=92+45+3+4+2=146", () => {
  const keys = FACTOR_FIELD_DEFS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, "存在重复 key");
  for (const k of [...NEW_IMPLEMENTED, ...NEW_PENDING]) assert.ok(FACTOR_FIELD_MAP.has(k), `未注册 ${k}`);
  // 注：sector_rps_120/in_sector_rps_120 本次由 pending 转已实现，字段本就已注册 → 总数不变，仍 146
  assert.equal(keys.length, 146);
});

test("注册表：pending 因子 implemented=false 且带原因/数据依赖", () => {
  for (const k of NEW_PENDING) {
    const d = FACTOR_FIELD_MAP.get(k)!;
    assert.equal(d.implemented, false, `${k} 必须是 implemented=false`);
    assert.equal(d.status, "pending_dependency");
    assert.ok(d.data_requirements, `${k} 必须写明数据依赖`);
    assert.ok(d.description, `${k} 应有不实现原因`);
  }
});

test("factorCatalog：pending 不进分类清单；新实现进对应分类；verified 严格绑定落盘验证账本", () => {
  const cat = factorCatalog();
  const inCat = new Set(Object.values(cat.category).flat());
  for (const k of NEW_IMPLEMENTED) assert.ok(inCat.has(k), `${k} 应出现在分类清单`);
  for (const k of NEW_PENDING) assert.ok(!inCat.has(k), `${k} 不应出现在分类清单`);
  // §五（任务书约束3/4）：catalog 的 verified 只能等于测试台落盘账本（data/factor-verified.json）的结论，
  // 既不得凭空为 true，也不得把已验证因子显示为 false（此前该断言硬编码「初始 false」，Step 1 真实批量验证后已不成立）
  const ledgerPath = path.join(process.cwd(), "data", "factor-verified.json");
  const ledger = fs.existsSync(ledgerPath)
    ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Record<string, boolean>
    : {};
  for (const d of cat.fields) {
    assert.equal(d.verified, ledger[d.key] === true, `${d.key} 的 verified 必须与验证账本一致`);
  }
  for (const k of NEW_PENDING) {
    assert.equal(cat.fields.find((d) => d.key === k)?.verified ?? false, false, `pending 因子 ${k} 不得显示已验证`);
    assert.equal(ledger[k], undefined, `pending 因子 ${k} 不得进入验证账本`);
  }
  assert.ok(Object.values(ledger).every((v) => v === true), "账本只记录已验证（true）条目");
  // 板块与概念：原先整类都是 pending（分类清单为空）；2026-09-26 起
  // sector_rps_50/120、in_sector_rps_50/120 已实现（稳智种子快照口径），
  // 故分类清单应恰好含这四个 key，且不含仍 pending 的概念类字段。
  const sectorCat = cat.category["板块与概念"] ?? [];
  assert.deepEqual(
    [...sectorCat].sort(),
    ["in_sector_rps_120", "in_sector_rps_50", "sector_rps_120", "sector_rps_50"].sort(),
    "板块分类应只含已实现的行业RPS四项",
  );
});

test("因子元数据完整性：新实现因子均有 zh/category/formula 或 description", () => {
  for (const k of NEW_IMPLEMENTED) {
    const d = FACTOR_FIELD_MAP.get(k)!;
    assert.ok(d.zh && d.category);
    assert.ok(d.formula || d.description, `${k} 缺公式/口径说明`);
    assert.equal(d.verified, false);
  }
});

test("重复注册防呆：任务书去重项不误加（vwap_pos/vwap_score 只有一份）", () => {
  assert.equal(FACTOR_FIELD_DEFS.filter((d) => d.key === "vwap_pos").length, 1);
  assert.equal(FACTOR_FIELD_DEFS.filter((d) => d.key === "vwap_score").length, 1);
  assert.equal(FACTOR_FIELD_DEFS.filter((d) => d.key === "gauss_overheat").length, 1);
});
