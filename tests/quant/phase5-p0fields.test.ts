// P0补齐·任务C 因子扩军第一批：纯公式单元测试（无网络、无DB）
// 运行：node --test tests/quant/phase5-p0fields.test.ts （Node ≥24 原生直跑 .ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vwapCalc, chanMerge, chanFractalFlags, chanZhongshuSignals, tdSeq, gaussChannel, gannSupportSig,
  buildFieldPanel, FACTOR_FIELD_DEFS, FACTOR_FIELD_MAP, type BarsLike,
} from "../../src/lib/quant/factors/fields.ts";

type S = (number | null)[];
const seq = (n: number, f: (t: number) => number | null): S => Array.from({ length: n }, (_, t) => f(t));

// ---------- VWAP20：成交额纪律（宁缺勿假） ----------

test("vwapCalc: 无量额（0/null）整段为 null，不做收盘价近似", () => {
  const c = seq(30, (t) => 10 + t * 0.1);
  const v = seq(30, () => 1000);
  const noAmt = seq(30, () => 0);
  const r = vwapCalc(c, v, noAmt, 20);
  assert.ok(r.vwap.every((x) => x === null));
  assert.ok(r.pos.every((x) => x === null));
});

test("vwapCalc: 累计成交额/累计成交量 精确值", () => {
  const c = seq(25, () => 10);
  const v = seq(25, () => 100);
  const amt = seq(25, () => 1000); // 均价 10
  const r = vwapCalc(c, v, amt, 20);
  assert.equal(r.vwap[18], null); // 未满20根
  assert.ok(Math.abs((r.vwap[19] as number) - 10) < 1e-9);
});

// ---------- 缠论 ----------

test("chanMerge: 包含K线并入前一根（向上取高高），end 指向被并入的原始K", () => {
  // bar2 (11.5,10.5) 完全落在 bar1 (12,10) 区间内 → 包含；向上合并：hi=12, lo=max(10,10.5)=10.5, end=2
  const merged = chanMerge([10, 12, 11.5, 14] as S, [9, 10, 10.5, 13] as S);
  assert.equal(merged.length, 3);
  assert.equal(merged[1].hi, 12);
  assert.equal(merged[1].lo, 10.5);
  assert.equal(merged[1].end, 2);
});

test("chanFractalFlags: 顶分型在第三根确认日点亮", () => {
  const h = [11, 13, 12, 15] as S;
  const l = [9, 11, 10, 13] as S;
  const { top, bottom } = chanFractalFlags(h, l);
  assert.equal(top[2], 1); // bars[1]=(13,11) 为顶，第三根(12,10)在 idx2 确认
  assert.equal(bottom[2], 0);
  assert.equal(top[0], null); // 序列头部数据不足
});

test("chanZhongshuSignals: 简化中枢上破 + 三买", () => {
  // 6根递进不重叠处理K（中枢ZG=min(highs)，含第7根后为11.2），第8根跳空站上并收阳
  const o: S = [9.5, 9.6, 9.8, 10.0, 10.2, 10.4, 10.5, 11.35];
  const c: S = [10.9, 10.9, 10.9, 10.9, 10.9, 10.9, 10.9, 11.5];
  const h: S = [11, 11.2, 11.4, 11.6, 11.8, 12, 12.2, 12.4];
  const l: S = [9, 9.2, 9.4, 9.6, 9.8, 10, 10.2, 11.3];
  const m = chanZhongshuSignals(h, l, c, o);
  assert.equal(m.breakUp[7], 1); // 昨收10.9≤昨ZG11，今收11.5>今ZG11.2
  assert.equal(m.thirdBuy[7], 1); // 今low11.3>ZG11.2 且收阳
  assert.equal(m.thirdBuy[6], 0); // 区间内回踩不成立三买
  assert.equal(m.breakUp[5], null); // 中枢未成立（不足6根已完成）
});

// ---------- TD序列 ----------

test("tdSeq: 连续13根「close低于4根前」→ 第13根 Setup9 完成", () => {
  const c = seq(20, (t) => 100 - 2 * t);
  const l = seq(20, (t) => (100 - 2 * t) - 0.5);
  const h = seq(20, (t) => (100 - 2 * t) + 0.5);
  const r = tdSeq(h, l, c);
  assert.equal(r.buy[11], 8);
  assert.equal(r.buy[12], 9);
  assert.equal(r.signal[12], 1); // TD9 完成日
  assert.equal(r.signal[11], 0);
  assert.equal(r.sell[12], 0);
});

test("tdSeq: Setup完成后倒计时13 → td13_buy_qualified", () => {
  const c = seq(30, (t) => 100 - 2 * t);
  const l = seq(30, (t) => (100 - 2 * t) - 0.5);
  const h = seq(30, (t) => (100 - 2 * t) + 0.5);
  const r = tdSeq(h, l, c);
  assert.equal(r.buy13q[24], 0); // 第12个倒计时（t=24, lastB=12）未到13
  assert.equal(r.buy13q[25], 1); // t=25 → cdB=13 且 25-12=13≤21
});

// ---------- 高斯通道 ----------

test("gaussChannel: 线性上行 → 中轨上行；末端突刺 → 收盘破上轨", () => {
  const lin = seq(60, (t) => 10 + 0.1 * t);
  const r = gaussChannel(lin);
  assert.equal(r.mid[38], null); // 窗口未满（win=40）
  assert.ok(r.mid[45] !== null && r.mid[44] !== null && (r.mid[45] as number) > (r.mid[44] as number));
  const spike = [...lin.slice(0, 59), 100];
  const r2 = gaussChannel(spike);
  assert.ok(r2.upper[59] !== null && 100 > (r2.upper[59] as number)); // 突刺远超 2×std 上轨
});

// ---------- 江恩 ----------

test("gannSupportSig: 以≈1x1斜率上行回踩线上 → sig11 命中、sig12/sig21 不命中", () => {
  // bar0..10 低点持平 9.95（锚定首个最低点），此后 low=9.95+0.1×(t-10) 与 1x1 线同速 → 中段必然穿带
  const n = 140;
  const lOf = (t: number) => (t <= 10 ? 9.95 : 9.95 + 0.1 * (t - 10));
  const l = seq(n, lOf);
  const c = seq(n, (t) => lOf(t) + 0.05);
  const o = seq(n, (t) => c[t]! - 0.02);
  const h = seq(n, (t) => c[t]! + 0.05);
  const r = gannSupportSig(h, l, c, o, 120);
  assert.equal(r.sig11[119], null);
  assert.equal(r.sig11[125], 0); // 未到带
  assert.equal(r.sig11[130], 1); // t=130: dL=10, k=120, line=21.89, low=21.95∈带内, close 收回线上
  assert.equal(r.sig12[130], 0); // 1x2 线在下方远处
  assert.equal(r.sig21[130], 0); // 2x1 线在上方远处
});

// ---------- buildFieldPanel 集成：新字段全存在 + VWAP 无量额纪律 ----------

function bars(n: number, f: (t: number) => { o: number; h: number; l: number; c: number; v: number; amount?: number }): BarsLike[] {
  return Array.from({ length: n }, (_, t) => ({ date: `2026-01-0${1 + (t % 9)}`, ...f(t) })).map((b, i) => ({ ...b, date: `d${String(i).padStart(4, "0")}` }));
}

test("buildFieldPanel: 任务C 新字段全部产出且目录登记", () => {
  const withAmt = bars(160, (t) => {
    const c0 = 10 + 0.05 * t;
    return { o: c0 - 0.05, h: c0 + 0.2, l: c0 - 0.2, c: c0, v: 1000, amount: c0 * 1000 };
  });
  const noAmt = withAmt.map(({ amount: _a, ...rest }) => ({ ...rest }) as BarsLike);
  const panel = buildFieldPanel(["000001.SZ", "000002.SZ"], [withAmt, noAmt], [{ symbol: "a" }, { symbol: "b" }]);
  const newKeys = [
    "chan_top_fractal", "chan_bottom_fractal", "chan_third_buy", "chan_third_sell", "cz_break_up", "cz_break_down",
    "td_buy_seq", "td_sell_seq", "td_signal", "td13_buy_qualified", "td13_sell_qualified",
    "gann_support_sig_1_1", "gann_support_sig_1_2", "gann_support_sig_2_1",
    "gauss_mid", "gauss_upper", "gauss_lower", "gauss_trend_up", "gauss_trend_flip_up", "gauss_trend_flip_down", "gauss_overheat",
    "vwap20", "vwap20_slope3", "vwap_score", "allow_long", "entry_signal",
    "support_near_60", "support_bounce_60", "resistance_breakout_60", "resistance_breakout_144",
  ];
  for (const k of newKeys) {
    assert.ok(FACTOR_FIELD_MAP.has(k), `目录缺字段 ${k}`);
    assert.ok(panel.fields.has(k), `面板缺字段 ${k}`);
  }
  // 有成交额 → VWAP 有值；无成交额 → VWAP 全 null（宁缺勿假）
  const vwapRows = panel.fields.get("vwap20")!;
  assert.ok(vwapRows[0][159] !== null);
  assert.ok(vwapRows[1].every((x) => x === null));
  assert.ok(panel.fields.get("allow_long")![1].every((x) => x === null));
  // 目录完整性：新字段均 verified:false 且为 kline 口径
  for (const k of newKeys) {
    const def = FACTOR_FIELD_MAP.get(k)!;
    assert.equal(def.verified, false);
    assert.equal(def.source, "kline");
  }
  assert.ok(FACTOR_FIELD_DEFS.length >= 75);
});
