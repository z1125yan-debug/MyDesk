// P2 Step 3 契约补齐单元测试（任务书§二/§四/§六/§二十二）—— 无网络 / 无DB / 纯逻辑
// 覆盖：in·not in 操作符（与选股引擎共用同一实现）、最大回撤、沪深300同期基准与超额（缺失=null不填0）、
//       分板涨跌停比例（10%/20%/30%/ST5%）、回测点差成本双边生效。
// 运行：node --test tests/quant/p2-contract-fixes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpWithOp, listOf, historicalWinProbability, type ScreenerCond } from "../../src/lib/quant/factors/probability.ts";
import { limitRatio, type BarsLike } from "../../src/lib/quant/factors/fields.ts";
import {
  DEFAULT_COST, limitRatioOf, runBacktestEngine, type BacktestPanel, type PositionSelector,
} from "../../src/lib/quant/backtest/engine.ts";

// ---------- 测试用确定性序列（合成OHLC，仅用于验证计算口径，不当作真实行情） ----------
function geomBars(n: number, ratio: number, start = 100): BarsLike[] {
  const out: BarsLike[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = i === 0 ? c : out[i - 1].c;
    const next = c * ratio;
    out.push({ date: `d${String(i).padStart(3, "0")}`, o, h: Math.max(o, next), l: Math.min(o, next), c: next, v: 1_000_000, amount: next * 1_000_000 });
    c = next;
  }
  return out;
}
const bench = (bars: BarsLike[], level: number): BarsLike[] =>
  bars.map((b) => ({ ...b, o: level, h: level, l: level, c: level }));

// ---------- §四 操作符：in / not in ----------

test("操作符: in/not in 多值解析（逗号/斜杠/分号/顿号/空格，去空）", () => {
  assert.deepEqual(listOf("300,301 / 688、689; 002 600"), ["300", "301", "688", "689", "002", "600"]);
  assert.deepEqual(listOf("  "), []);
  assert.deepEqual(listOf(7), [7]);
  assert.deepEqual(listOf([1, "2"]), [1, "2"]);
});

test("操作符: cmpWithOp 判定契约（in 数值容差 / 字符串枚举 / 空列表 / UNKNOWN）", () => {
  assert.equal(cmpWithOp(80, "in", "60,70,80"), true);
  assert.equal(cmpWithOp(85, "in", "60,70,80"), false);
  assert.equal(cmpWithOp(85, "not in", "60,70,80"), true);
  assert.equal(cmpWithOp(80, "not in", "60,70,80"), false);
  assert.equal(cmpWithOp(0.1 + 0.2, "in", "0.3"), true, "浮点容差：0.30000000000000004 视为 0.3");
  assert.equal(cmpWithOp(1, "in", "是 否"), false, "面板字段均为数值：文本枚举元素与之不相等（不得判真）");
  assert.equal(cmpWithOp(2, "in", "1 2 x"), true, "数字与文本混合列表：数字项按数值比较");
  assert.equal(cmpWithOp(3, "in", "1 2 x"), false);
  assert.equal(cmpWithOp(1, "in", "1,1.0000001"), true);
  assert.equal(cmpWithOp(1, "in", ""), false, "空列表不判真（缺数据不猜）");
  assert.equal(cmpWithOp(1, "not in", ""), false, "空列表时 not in 也不判真");
  assert.equal(cmpWithOp(null, "in", "1,2"), false, "null=UNKNOWN 不为真");
  assert.equal(cmpWithOp(Number.NaN, "not in", "1"), false, "NaN 不为真");
  // 原有操作符行为不回退
  assert.equal(cmpWithOp(5, ">=", "3"), true);
  assert.equal(cmpWithOp(5, "<", 3), false);
  assert.equal(cmpWithOp(5, "=", "5"), true);
  assert.equal(cmpWithOp(5, "!=", "5"), false);
  assert.equal(cmpWithOp(150, "like", "5"), true, "like 为字符串包含");
  assert.equal(cmpWithOp(5, "=", "abc"), false, "非法值不得判真");
});

test("操作符: 概率引擎与选股引擎同一实现（in 单元素 == =，结果完全一致）", () => {
  const bars = geomBars(60, 1.004);
  const eq: ScreenerCond = { field: "above_ma_20", op: "=", value: 1 };
  const inOne: ScreenerCond = { field: "above_ma_20", op: "in", value: "1" };
  const a = historicalWinProbability({ symbol: "600000.SH", bars, conditions: [eq], horizons: [1, 5] })!;
  const b = historicalWinProbability({ symbol: "600000.SH", bars, conditions: [inOne], horizons: [1, 5] })!;
  assert.deepEqual(b.horizons.map((h) => [h.h, h.sample_size, h.win_rate]), a.horizons.map((h) => [h.h, h.sample_size, h.win_rate]));
  // not in 与 in 互补（同一样本域内，命中数之和 = 全部有效日）
  const notIn: ScreenerCond = { field: "above_ma_20", op: "not in", value: "1" };
  const d = historicalWinProbability({ symbol: "600000.SH", bars, conditions: [notIn], horizons: [1] })!;
  assert.equal(d.horizons.length, 0, "单调上涨序列不存在 above_ma_20≠1 的命中样本（horizons 为空而非 0% 假数）");
});

// ---------- §二/§六 最大回撤 + 基准收益 ----------

test("胜率统计: 最大回撤 = 命中样本复利净值回撤（单调下跌/上涨两端可解析验证）", () => {
  const down = historicalWinProbability({
    symbol: "600000.SH", bars: geomBars(40, 0.99), conditions: [{ field: "rsi_14", op: ">=", value: 0 }], horizons: [1],
  })!;
  const hd = down.horizons[0];
  assert.equal(hd.win_rate, 0);
  assert.ok(Math.abs((hd.avg_return ?? 0) + 1) < 1e-9, "每日 -1%");
  // n 个连续 -1% 复利 = (0.99)^n - 1，全程单调下降 → 最大回撤即累计跌幅
  assert.ok(Math.abs((hd.max_drawdown ?? 0) - (Math.pow(0.99, hd.sample_size) - 1) * 100) < 1e-9);
  assert.ok((hd.max_drawdown ?? 1) < 0);

  const up = historicalWinProbability({
    symbol: "600000.SH", bars: geomBars(40, 1.005), conditions: [{ field: "rsi_14", op: ">=", value: 0 }], horizons: [1],
  })!;
  assert.equal(up.horizons[0].win_rate, 100);
  assert.equal(up.horizons[0].max_drawdown, 0, "单调上涨无回撤");
});

test("胜率统计: 样本<2 时最大回撤为 null（不输出 0% 假回撤）", () => {
  // 16 根：RSI14 仅末段可用，h=1 只剩 1 个样本
  const only1 = historicalWinProbability({
    symbol: "600000.SH", bars: geomBars(16, 0.99), conditions: [{ field: "rsi_14", op: ">=", value: 0 }], horizons: [1],
  })!;
  const h = only1.horizons[0];
  assert.equal(h.sample_size, 1);
  assert.equal(h.max_drawdown, null);
});

test("胜率统计: 基准（沪深300）同期按日期对齐，缺失显示 null 且警示，绝不以0代替", () => {
  const bars = geomBars(40, 0.99);
  const cond: ScreenerCond[] = [{ field: "rsi_14", op: ">=", value: 0 }];

  // 1) 完全无基准
  const noBench = historicalWinProbability({ symbol: "600000.SH", bars, conditions: cond, horizons: [1] })!;
  assert.equal(noBench.horizons[0].benchmark_return, null);
  assert.equal(noBench.horizons[0].excess_return, null);
  assert.equal(noBench.horizons[0].benchmark_sample_size, 0);
  assert.ok(noBench.warnings.some((w) => w.includes("基准指数K线缺失")), "必须显式提示基准缺失");

  // 2) 基准恒定 → 基准收益 0（真实计算值），超额 = 平均收益
  const flat = historicalWinProbability({
    symbol: "600000.SH", bars, conditions: cond, horizons: [1],
    benchmarkBars: bench(bars, 4000), benchmarkName: "沪深300",
  })!;
  const h2 = flat.horizons[0];
  assert.ok(Math.abs((h2.benchmark_return ?? 99) - 0) < 1e-12);
  assert.ok(Math.abs((h2.excess_return ?? 99) - (h2.avg_return ?? 0)) < 1e-12);
  assert.equal(h2.benchmark_sample_size, h2.sample_size);

  // 3) 基准日期完全错位 → 有基准K线但无可比对样本 → null（不是 0）
  const shifted = historicalWinProbability({
    symbol: "600000.SH", bars, conditions: cond, horizons: [1],
    benchmarkBars: bench(bars, 4000).map((b) => ({ ...b, date: `x${b.date}` })), benchmarkName: "沪深300",
  })!;
  assert.equal(shifted.horizons[0].benchmark_return, null);
  assert.equal(shifted.horizons[0].benchmark_sample_size, 0);
  assert.ok(!shifted.warnings.some((w) => w.includes("基准指数K线缺失")), "基准存在但不可比对时不应误报缺失");

  // 4) 部分对齐：基准只覆盖前一半日期 → benchmark_sample_size 严格小于样本数
  const half = historicalWinProbability({
    symbol: "600000.SH", bars, conditions: cond, horizons: [1],
    benchmarkBars: bench(bars.slice(0, Math.floor(bars.length / 2)), 4000), benchmarkName: "沪深300",
  })!;
  const h4 = half.horizons[0];
  assert.ok(h4.benchmark_sample_size > 0 && h4.benchmark_sample_size < h4.sample_size, "按日期对齐而非索引对齐");
});

// ---------- §二十二 分板涨跌停 + 点差 ----------

test("涨跌停分板: 主板10% / 创业板·科创板20% / 北交所30% / ST 5%", () => {
  assert.equal(limitRatio("600000.SH", "浦发银行"), 0.10);
  assert.equal(limitRatio("000001.SZ", "平安银行"), 0.10);
  assert.equal(limitRatio("300750.SZ", "宁德时代"), 0.20);
  assert.equal(limitRatio("301000.SZ", "某创业板"), 0.20);
  assert.equal(limitRatio("688256.SH", "寒武纪"), 0.20);
  assert.equal(limitRatio("920002.BJ", "旭杰科技"), 0.30);
  assert.equal(limitRatio("430047.BJ", "诺思兰德"), 0.30);
  assert.equal(limitRatio("600111.SH", "ST大方"), 0.05, "ST 优先于主板比例");
  // 通过 panel 取用（names 缺失 → 按非 ST，不得崩溃）
  const panel: BacktestPanel = {
    dates: ["d0"], symbols: ["600000.SH", "300750.SZ", "688256.SH", "920002.BJ", "600111.SH"],
    names: ["浦发银行", "宁德时代", "寒武纪", "旭杰科技", "ST大方"], fields: new Map(),
  };
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => limitRatioOf(panel, i)), [0.10, 0.20, 0.20, 0.30, 0.05]);
  assert.deepEqual(limitRatioOf({ dates: ["d0"], symbols: ["600000.SH"], fields: new Map() }, 0), 0.10);
});

const allHold = (weight: number): PositionSelector => ({
  name: "all",
  select: ({ symbols }) => new Map(symbols.map((s) => [s, weight])),
});

function limitPanel(): BacktestPanel {
  const symbols = ["600000.SH", "300750.SZ", "920002.BJ", "600111.SH"];
  const names = ["浦发银行", "宁德时代", "旭杰科技", "ST大方"];
  // d0 收盘 10；d1 开盘：主板/ST 涨 15%（各自板块已封板），创业板 +15%（未封），北交所 +29%（未封 30%）
  const opens = [11.5, 11.5, 12.9, 10.6];
  const mat = (vals: (number | null)[][]): (number | null)[][] => vals;
  return {
    dates: ["d0", "d1"],
    symbols,
    names,
    fields: new Map<string, (number | null)[][]>([
      ["o", mat(symbols.map((_, i) => [null, opens[i]]))],
      ["c", mat(symbols.map(() => [10, 10]))],
      ["v", mat(symbols.map(() => [null, 1_000_000]))],
      ["amount", mat(symbols.map(() => [null, 10_000_000]))],
    ]),
  };
}

test("回测: 涨跌停封锁按板块比例判定（同一 +15% 开盘，主板封板拒买、创业板放行）", () => {
  const res = runBacktestEngine(limitPanel(), allHold(0.25), {
    mode: "universe", tf: "day", startDate: "d0", endDate: "d1",
    universe: { kind: "custom", symbols: ["600000.SH"] }, initialCash: 1_000_000, cost: {},
  });
  const reasons = res.blockedOrders.map((b) => b.reason);
  assert.ok(reasons.some((r) => r === "涨停无法买入:600000.SH(10%)"), `主板+15%应封板：${reasons.join(" | ")}`);
  assert.ok(reasons.some((r) => r === "涨停无法买入:600111.SH(5%)"), `ST+6%应封板：${reasons.join(" | ")}`);
  const bought = new Set(res.trades.filter((t) => t.side === "buy").map((t) => t.symbol));
  assert.ok(bought.has("300750.SZ"), "创业板 +15% 未达 20% 涨停，应可买入");
  assert.ok(bought.has("920002.BJ"), "北交所 +29% 未达 30% 涨停，应可买入");
  assert.ok(!bought.has("600000.SH") && !bought.has("600111.SH"));
});

test("回测: 点差成本双边生效（买入按卖一侧、卖出按买一侧），默认 0.001", () => {
  assert.equal(DEFAULT_COST.spreadRate, 0.001);
  const withSpread = runBacktestEngine(limitPanel(), allHold(0.25), {
    mode: "universe", tf: "day", startDate: "d0", endDate: "d1",
    universe: { kind: "custom", symbols: ["300750.SZ"] }, initialCash: 1_000_000, cost: {},
  });
  const noSpread = runBacktestEngine(limitPanel(), allHold(0.25), {
    mode: "universe", tf: "day", startDate: "d0", endDate: "d1",
    universe: { kind: "custom", symbols: ["300750.SZ"] }, initialCash: 1_000_000, cost: { spreadRate: 0 },
  });
  const b1 = withSpread.trades.find((t) => t.symbol === "300750.SZ")!;
  const b0 = noSpread.trades.find((t) => t.symbol === "300750.SZ")!;
  assert.equal(b0.price, 11.5, "无点差：按开盘成交");
  assert.equal(b1.price, 11.51, "买点差：round2(11.5×1.0005)=11.51");
  assert.ok(b1.shares <= b0.shares, "点差抬高成交价 → 同资金买得更少");
  assert.ok(b1.cost > b0.cost, "点差成本计入交易费用");
});

test("回测: 卖出侧点差（次日清仓按买一价成交）", () => {
  const panel = limitPanel();
  // 追加 d2：d1 买入、d2 清仓（rebalanceEvery=1）
  const extend = (arr: (number | null)[][], last: number | null): (number | null)[][] => arr.map((r) => [...r, last]);
  panel.dates.push("d2");
  panel.fields.set("o", extend(panel.fields.get("o")!, 11.4));
  panel.fields.set("c", extend(panel.fields.get("c")!, 11.4));
  panel.fields.set("v", extend(panel.fields.get("v")!, 1_000_000));
  panel.fields.set("amount", extend(panel.fields.get("amount")!, 10_000_000));
  const sellOnly: PositionSelector = { name: "flat-then-empty", select: ({ t }) => (t === 0 ? new Map([["300750.SZ", 0.5]]) : new Map()) };
  const res = runBacktestEngine(panel, sellOnly, {
    mode: "universe", tf: "day", startDate: "d0", endDate: "d2",
    universe: { kind: "custom", symbols: ["300750.SZ"] }, initialCash: 1_000_000,
    cost: {}, constraints: { respectLimitUpDown: false }, rebalanceEvery: 1,
  });
  const sells = res.trades.filter((t) => t.side === "sell");
  assert.ok(sells.length >= 1, "应产生清仓卖出");
  assert.equal(sells[0].price, 11.39, `卖点差一半：round2(11.4×0.9995)=${sells[0].price}`);
});
