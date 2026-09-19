// P0P1验收修复·§八 ZSB 庄家宝体系因子单元测试（无网络 / 无DB / 纯逻辑，node:test 直跑）
// 纪律：不改公式、不改参数；pending 因子只验登记状态；不造数、不用演示数据冒充真实。
// 运行：node --test tests/quant/zsb-factors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFieldPanel, FACTOR_FIELD_MAP, FACTOR_FIELD_DEFS, factorCatalog,
  tdxSma, retailCalc, rsiVCalc, dealerCalc, bdwCalc, macdCalc, kongpanCalc,
  crossUp, sma,
  evalLimitSnapshot,
  ZSB_RSI_V_N, ZSB_BDW_N, ZSB_DEALER_RSV_N, ZSB_DEALER_EMA_N, ZSB_RETAIL_M,
  type BarsLike,
} from "../../src/lib/quant/factors/fields.ts";

type S = (number | null)[];
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// 确定性伪随机游走（避免依赖 Math.random），产出合法 OHLCV
function walk(n: number, seed = 12345): BarsLike[] {
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

function flat(n: number, o: number, h: number, l: number, c: number, v: number): BarsLike[] {
  return Array.from({ length: n }, (_, t) => ({ date: `d${String(t).padStart(4, "0")}`, o, h, l, c, v, amount: c * v }));
}

const ZSB_IMPLEMENTED = [
  "zsb_dealer", "zsb_retail", "zsb_rsi_v", "acc_dif", "acc_dea", "acc_macd",
  "zsb_rsi_reduce", "zsb_accum", "zsb_attack", "zsb_trigger", "zsb_bdw",
];
const ZSB_PENDING = ["zsb_height_control", "acc_base", "strong_acc_conds_met", "strong_acc_pick"];

// ---------- tdxSma 递归精确（≠简单均线；种子=首个有效值；null 沿用前值） ----------

test("tdxSma: SMA(X,3,1) 递归值逐步精确", () => {
  const r = tdxSma([2, 5, 5, 8], 3, 1);
  assert.ok(near(r[0]!, 2));                 // 种子=首个有效 X
  assert.ok(near(r[1]!, (5 + 2 * 2) / 3));    // 3
  assert.ok(near(r[2]!, (5 + 2 * 3) / 3));    // 11/3
  assert.ok(near(r[3]!, (8 + 2 * (11 / 3)) / 3));
});

test("tdxSma: 首值为 null 时不种子；后续 null 输入沿用前值", () => {
  const r = tdxSma([null, 4, null, 7], 3, 1);
  assert.equal(r[0], null);
  assert.ok(near(r[1]!, 4));                 // 首个有效值=4 作种子
  assert.ok(near(r[2]!, 4));                 // null → 沿用 prev
  assert.ok(near(r[3]!, (7 + 2 * 4) / 3));
});

// ---------- retailCalc：区间 [0,100] + 手算 + hh==ll 拒绝 ----------

test("retailCalc: 窗口不足为 null；命中窗口精确 40；全程 [0,100]", () => {
  const h = [10, 12, 11, 13, 12];
  const l = [8, 9, 7, 6, 8];
  const c = [9, 11, 10, 12, 9];
  const r = retailCalc(h, l, c, 3);
  assert.equal(r[0], null);
  assert.equal(r[1], null);
  // t=2: hh=max(10,12,11)=12, ll=min(8,9,7)=7 → 100*(12-10)/(12-7)=40
  assert.ok(near(r[2]!, 40));
  for (const x of r) if (x !== null) assert.ok(x >= 0 && x <= 100, `越界 ${x}`);
});

test("retailCalc: hh==ll（无波动）→ 明确 null，不伪造 0/100", () => {
  const r = retailCalc([10, 10, 10], [10, 10, 10], [10, 10, 10], 2);
  assert.ok(r.every((x) => x === null));
});

// ---------- rsiVCalc：量能单调性决定 0 / 100 / null，且始终 [0,100] ----------

test("rsiVCalc: 严格递增量→100；严格递减→0；恒定量→null", () => {
  const inc: S = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const rInc = rsiVCalc(inc, 3);
  assert.equal(rInc[0], null);
  for (let t = 1; t < rInc.length; t++) assert.ok(near(rInc[t]!, 100), `递增 t=${t} 应=100，实得 ${rInc[t]}`);

  const dec: S = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const rDec = rsiVCalc(dec, 3);
  for (let t = 1; t < rDec.length; t++) assert.ok(near(rDec[t]!, 0), `递减 t=${t} 应=0`);

  const flatV: S = [5, 5, 5, 5, 5];
  assert.ok(rsiVCalc(flatV, 3).every((x) => x === null));

  // 混合游走：仅 [0,100] 或 null
  const mixed = rsiVCalc(walk(60).map((b) => b.v), 14);
  for (const x of mixed) if (x !== null) assert.ok(x >= 0 && x <= 100, `RSI_V 越界 ${x}`);
});

// ---------- dealerCalc：平坦通道 → RSV 恒定 → J 恒定 → 庄家=该常数，且 [0,100] ----------

test("dealerCalc: 平坦通道 (h12 l8 c10) → 庄家线≈50 且在 [0,100]", () => {
  const b = flat(120, 10, 12, 8, 10, 1000);
  const d = dealerCalc(b.map((x) => x.h), b.map((x) => x.l), b.map((x) => x.c));
  const last = d[d.length - 1]!;
  assert.ok(near(last, 50, 1e-6), `期望≈50，实得 ${last}`);
  for (const x of d) if (x !== null) assert.ok(x >= 0 && x <= 100, `庄家越界 ${x}`);
  // 参数固定为原始口径
  assert.equal(ZSB_DEALER_RSV_N, 81);
  assert.equal(ZSB_DEALER_EMA_N, 6);
  assert.equal(ZSB_RETAIL_M, 34);
});

// ---------- acc_dif/dea/macd：与现有 macdCalc 完全一致（复用同序列，不重算） ----------

test("acc_* 与 macdCalc 输出逐点相等（复用口径一致）", () => {
  const b = walk(150);
  const c = b.map((x) => x.c);
  const ref = macdCalc(c);
  const panel = buildFieldPanel(["000001.SZ"], [b], [{ symbol: "000001.SZ" }]);
  assert.deepEqual(panel.fields.get("acc_dif")![0], ref.dif);
  assert.deepEqual(panel.fields.get("acc_dea")![0], ref.dea);
  assert.deepEqual(panel.fields.get("acc_macd")![0], ref.bar);
});

// ---------- 0/1 信号：值域恒为 {0,1,null} ----------

test("accum/attack/trigger/rsi_reduce 值域仅 {0,1,null}", () => {
  const b = walk(200);
  const panel = buildFieldPanel(["000001.SZ"], [b], [{ symbol: "000001.SZ" }]);
  for (const k of ["zsb_accum", "zsb_attack", "zsb_trigger", "zsb_rsi_reduce"]) {
    const series = panel.fields.get(k)![0];
    assert.ok(series, `面板缺 ${k}`);
    for (const x of series) assert.ok(x === null || x === 0 || x === 1, `${k} 出现非布尔值 ${x}`);
  }
});

// ---------- bdwCalc：N 参数化（不硬编码），默认用 ZSB_BDW_N ----------

test("bdwCalc: 默认 N=20；显式传 N 精确；参数占位待确认", () => {
  assert.equal(ZSB_BDW_N, 20);
  assert.equal(ZSB_RSI_V_N, 14);
  const c: S = Array.from({ length: 30 }, (_, t) => 10 + t * 0.1);
  const v: S = Array.from({ length: 30 }, () => 1000);
  const dft = bdwCalc(c, v);
  assert.equal(dft[19], null);                 // t<n 无值
  // 默认与显式 N=20 完全一致
  assert.deepEqual(dft, bdwCalc(c, v, 20));
  // t=20 手算：((c20-c0)/c0)*v20*100
  const exp20 = ((c[20]! - c[0]!) / c[0]!) * v[20]! * 100;
  assert.ok(near(dft[20]!, exp20));
  // 自定义 N=5 不硬编码
  const n5 = bdwCalc(c, v, 5);
  assert.equal(n5[4], null);
  assert.ok(near(n5[5]!, ((c[5]! - c[0]!) / c[0]!) * v[5]! * 100));
});

// ---------- registry：11 实现 + 4 pending 状态 ----------

test("ZSB registry：实现项 source=kline/verified=false；pending 标记不删除", () => {
  for (const k of ZSB_IMPLEMENTED) {
    const def = FACTOR_FIELD_MAP.get(k);
    assert.ok(def, `未登记 ${k}`);
    assert.equal(def!.category, "庄家宝体系");
    assert.equal(def!.source, "kline");
    assert.equal(def!.verified, false);
    assert.notEqual(def!.implemented, false, `${k} 不应为 pending`);
    assert.ok(def!.formula, `${k} 缺 formula 原文`);
  }
  for (const k of ZSB_PENDING) {
    const def = FACTOR_FIELD_MAP.get(k);
    assert.ok(def, `pending 项被删除：${k}`);
    assert.equal(def!.implemented, false);
    assert.equal(def!.status, "pending_dependency");
    assert.equal(def!.verified, false);
  }
});

test("factorCatalog：庄家宝体系分类含 11 实现项、排除 4 pending；fields 保留全部", () => {
  const cat = factorCatalog();
  const group = cat.category["庄家宝体系"] ?? [];
  assert.equal(group.length, ZSB_IMPLEMENTED.length);
  for (const k of ZSB_IMPLEMENTED) assert.ok(group.includes(k), `分类缺 ${k}`);
  for (const k of ZSB_PENDING) assert.ok(!group.includes(k), `分类误含 pending ${k}`);
  // fields 保留全部登记（含 pending）
  for (const k of [...ZSB_IMPLEMENTED, ...ZSB_PENDING]) {
    assert.ok(cat.fields.some((f) => f.key === k), `fields 缺 ${k}`);
  }
});

test("buildFieldPanel：pending 因子不产出计算列", () => {
  const b = walk(150);
  const panel = buildFieldPanel(["000001.SZ"], [b], [{ symbol: "000001.SZ" }]);
  for (const k of ZSB_IMPLEMENTED) assert.ok(panel.fields.has(k), `面板缺实现项 ${k}`);
  for (const k of ZSB_PENDING) assert.ok(!panel.fields.has(k), `面板误算 pending ${k}`);
});

// ---------- evalLimitSnapshot：快照优先 + UNKNOWN 回归（A~D） ----------

test("evalLimitSnapshot A：主板封板（价=涨停价）→ touched+sealed", () => {
  const r = evalLimitSnapshot({ symbol: "600000.SH", name: "浦发银行", prevClose: 10, price: 11, high: 11 });
  assert.ok(r);
  assert.ok(near(r!.limitPrice, 11));
  assert.equal(r!.touched, true);
  assert.equal(r!.sealed, true);
});

test("evalLimitSnapshot B：触板未封（高价=涨停、现价回落）→ touched 非 sealed", () => {
  const r = evalLimitSnapshot({ symbol: "600000.SH", name: "浦发银行", prevClose: 10, price: 10.5, high: 11 });
  assert.ok(r);
  assert.equal(r!.touched, true);
  assert.equal(r!.sealed, false);
});

test("evalLimitSnapshot C：缺字段/非正值 → null（UNKNOWN，不冒充 false）", () => {
  assert.equal(evalLimitSnapshot({ symbol: "600000.SH", name: "浦发银行", price: 11, high: 11 }), null); // 缺 prevClose
  assert.equal(evalLimitSnapshot({ symbol: "600000.SH", name: "浦发银行", prevClose: 0, price: 11, high: 11 }), null);
  assert.equal(evalLimitSnapshot({ symbol: "600000.SH", name: "浦发银行", prevClose: 10, price: 11 }), null); // 缺 high
});

test("evalLimitSnapshot D：新股（N/C 前缀）无涨跌幅限制 → null", () => {
  assert.equal(evalLimitSnapshot({ symbol: "301999.SZ", name: "N新上", prevClose: 10, price: 20, high: 20 }), null);
  assert.equal(evalLimitSnapshot({ symbol: "688999.SH", name: "C次新", prevClose: 10, price: 12, high: 12 }), null);
});

test("evalLimitSnapshot：注册制/北交所/ST 涨停比例正确", () => {
  // 创业板 300 → 20%
  assert.ok(near(evalLimitSnapshot({ symbol: "300750.SZ", name: "宁德", prevClose: 10, price: 12, high: 12 })!.limitPrice, 12));
  // 科创板 688 → 20%
  assert.ok(near(evalLimitSnapshot({ symbol: "688001.SH", name: "华兴", prevClose: 10, price: 12, high: 12 })!.limitPrice, 12));
  // 北交所 .BJ → 30%
  assert.ok(near(evalLimitSnapshot({ symbol: "830001.BJ", name: "艾录", prevClose: 10, price: 13, high: 13 })!.limitPrice, 13));
  // 主板 ST → 5%
  assert.ok(near(evalLimitSnapshot({ symbol: "600001.SH", name: "ST 某", prevClose: 10, price: 10.5, high: 10.5 })!.limitPrice, 10.5));
});

// ---------- 目录总览完整性（ZSB 15 项均在 FACTOR_FIELD_DEFS） ----------

test("FACTOR_FIELD_DEFS 含全部 15 个庄家宝体系项", () => {
  const keys = FACTOR_FIELD_DEFS.filter((f) => f.category === "庄家宝体系").map((f) => f.key);
  for (const k of [...ZSB_IMPLEMENTED, ...ZSB_PENDING]) assert.ok(keys.includes(k), `DEFS 缺 ${k}`);
  assert.equal(keys.length, 15);
});
