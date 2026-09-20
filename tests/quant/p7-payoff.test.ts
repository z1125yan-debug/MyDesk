// P7-⑦ 概率面「盈亏比」子项的输入侧单元测试。
//
// 为什么要单独测这一格：任务书把盈亏比列进历史概率维度（显著占优 +10 / 接近 0 / 占优反向 −10），
// 而库里两个概率引擎原本只给 avg_return / worst_return / max_drawdown —— 没有分开的平均盈利与平均亏损，
// 「盈亏比」就没有可追溯的出处。评审定的口径是**扩引擎算真实盈亏比**，不是拿支撑→阻力的价位比代替
// （那个不是历史统计口径，塞进同一维度等于把两种样本定义混成一个数，正是决策层拒绝的事）。
//
// 这里的序列全是**合成夹具**，只用来钉字段语义（哪些进盈利侧、哪些进亏损侧、缺一侧时给什么），
// 不是行情事实，不能当样本引用。
//
// 运行：node --experimental-strip-types --test tests/quant/p7-payoff.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { historicalWinProbability, type ScreenerCond } from "../../src/lib/quant/factors/probability.ts";
import type { BarsLike } from "../../src/lib/quant/factors/fields.ts";
import { similarReturnForward } from "../../src/lib/quant/screener/similar-env.ts";

// 逐日累乘出来的序列必然带浮点尾差（3.000000000000003 这类），断言一律带容差而不是 deepEqual。
// 形参放宽到 `number | null | undefined`：similar-env 的盈亏比四格在类型上是可选的（要兼容升级前的旧快照），
// 但 undefined 在这里判不过 —— 所以「字段没给」和「给了 null」一样都会让这条断言失败，不会因为放宽类型而变松。
const near = (a: number | null | undefined, b: number, msg?: string) =>
  assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-6, `${msg ?? "数值"}：期望 ${b}，实际 ${a}`);

/** 按「逐日涨跌幅（%）」拼合成 K 线：rets[i] 是第 i+1 根相对上一根的涨跌 */
function barsFromRets(rets: number[], start = 100): BarsLike[] {
  const out: BarsLike[] = [];
  let c = start;
  for (let i = 0; i < rets.length + 1; i++) {
    if (i > 0) c = c * (1 + rets[i - 1] / 100);
    out.push({ date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, o: c, h: c, l: c, c, v: 1_000_000, amount: c * 1_000_000 });
  }
  return out;
}
const idxFromRets = (rets: number[]) => barsFromRets(rets).map((b) => ({ date: b.date, c: b.c as number }));

const MA20_UP: ScreenerCond[] = [{ field: "above_ma_20", op: "=", value: 1 }];

/**
 * 交替夹具的样本数是可以手算的，写在这里免得日后被当成「从实现里抄来的断言」：
 * above_ma_20 的 warmup = 0(single) + 20(above_ma_ 后缀) + 5 = 25；44 个涨跌 ⇒ 45 根（下标 0..44），
 * 1 日窗口要求 t+1 ≤ 44 ⇒ 命中日 t = 25..43 共 **19** 天。
 * r_t = rets[t] = (t+1) 为奇 ? +3 : −0.5 ⇒ t 为偶数时 +3%（26,28,…,42 = **9** 天），奇数时 −0.5%（**10** 天）。
 */
test("盈亏比：盈利侧与亏损侧各取均值，payoff = avg_win/|avg_loss|（+3%/-0.5% 交替夹具）", () => {
  const rets = Array.from({ length: 44 }, (_, i) => ((i + 1) % 2 === 1 ? 3 : -0.5));
  const h1 = historicalWinProbability({ symbol: "600000.SH", bars: barsFromRets(rets), conditions: MA20_UP, horizons: [1] })!.horizons[0];
  assert.equal(h1.sample_size, 19, "命中样本数（推导见上）：对不上说明 warmup/匹配日理解错了");
  assert.equal(h1.win_samples, 9);
  assert.equal(h1.loss_samples, 10);
  assert.equal(h1.win_samples + h1.loss_samples, h1.sample_size, "本夹具没有持平日");
  near(h1.avg_win, 3, "平均盈利");
  near(h1.avg_loss, -0.5, "平均亏损带负号（不是绝对值）");
  near(h1.payoff_ratio, 6, "盈亏比 = 3 / 0.5");
  near(h1.win_rate, (9 / 19) * 100, "胜率与盈亏比来自同一批样本");
  near(h1.avg_return, (9 * 3 + 10 * -0.5) / 19, "平均收益仍在，没有被比值替换掉");
});

/**
 * 持平夹具 cyc=[+3,0,−0.5,0]：r_t = cyc[(t+1)%4]，t=25 起依次是 −0.5, 0, +3, 0, …
 * 19 天 = 4 整轮(16 天：5 亏 4 赢 7 平… 逐轮各 1 亏 1 赢 2 平) + 余 3 天(−0.5, 0, +3)
 * ⇒ 亏损 5、盈利 5、持平 9。
 */
test("盈亏比：持平样本两侧都不进，所以 win+loss 可以小于 sample_size", () => {
  const cyc = [3, 0, -0.5, 0];
  const rets = Array.from({ length: 44 }, (_, i) => cyc[(i + 1) % 4]);
  const h1 = historicalWinProbability({ symbol: "600000.SH", bars: barsFromRets(rets), conditions: MA20_UP, horizons: [1] })!.horizons[0];
  assert.equal(h1.sample_size, 19);
  assert.equal(h1.win_samples, 5);
  assert.equal(h1.loss_samples, 5);
  assert.ok(h1.win_samples + h1.loss_samples < h1.sample_size, "9 个持平日两侧都不进");
  near(h1.win_rate, (5 / 19) * 100, "胜率的分母含持平日（不涨不跌不算上涨）");
  near(h1.avg_win, 3);
  near(h1.avg_loss, -0.5);
  near(h1.payoff_ratio, 6, "盈亏比的分母不含持平日：与胜率同一批样本、两套分母");
});

test("没有亏损样本 ⇒ avg_loss/payoff_ratio = null，不是 0（单调上涨夹具）", () => {
  // 全程 +1% ⇒ 恒在 MA20 上方，且 1 日前向收益全为正：盈利侧有值、亏损侧一个样本都没有。
  const h1 = historicalWinProbability({ symbol: "600000.SH", bars: barsFromRets(Array.from({ length: 59 }, () => 1)), conditions: MA20_UP, horizons: [1] })!.horizons[0];
  assert.ok(h1.sample_size > 0, "样本要为正，否则这条只是在测「没数据」");
  near(h1.win_rate, 100);
  assert.equal(h1.loss_samples, 0);
  assert.equal(h1.avg_loss, null, "一次都没亏过 ≠ 亏损幅度 0%");
  assert.equal(h1.payoff_ratio, null, "分母不存在就没有比值；给 0 会被下游读成「亏损占优」而扣 −10");
  assert.ok(h1.avg_win !== null && h1.avg_win > 0, "盈利侧本身仍然有值，不能整项作废");
});

test("没有盈利样本 ⇒ payoff 同样为 null（相似环境：单调下跌，全样本都是亏损）", () => {
  const stats = similarReturnForward(idxFromRets(Array.from({ length: 79 }, () => -1)), 0.8, [1]);
  const h1 = stats.horizons[0];
  assert.ok(h1.sample_size > 30, `夹具要造出足够样本才有意义，实际 ${h1.sample_size}`);
  assert.equal(h1.win_samples, 0);
  assert.equal(h1.avg_win, null);
  near(h1.avg_loss, -1, "亏损侧有值（带负号）");
  assert.equal(h1.payoff_ratio, null, "单边样本不算盈亏比：凭它给 +10 或 −10 都是拿没有依据的数打分");
});

test("相似环境的盈亏比与 win_rate 同批样本（[+2,-1,+3,-2] 循环，带宽 4 时两侧都有值）", () => {
  const rets = Array.from({ length: 80 }, (_, i) => [2, -1, 3, -2][(i + 1) % 4]);
  const h1 = similarReturnForward(idxFromRets(rets), 4, [1]).horizons[0];
  // 这两格在类型上是可选的（兼容升级前的旧快照读取）：先钉「本次引擎确实回带了」，再比大小与合计
  assert.ok(h1.win_samples !== undefined && h1.loss_samples !== undefined, "similarReturnForward 必须回带两侧样本数，否则盈亏比没有出处");
  assert.ok(h1.win_samples > 0 && h1.loss_samples > 0, "本条测的是两侧都有值的分支");
  assert.equal(h1.win_samples + h1.loss_samples, h1.sample_size, "夹具里没有持平日");
  assert.ok((h1.avg_win as number) > 0 && (h1.avg_loss as number) < 0, "盈利侧为正、亏损侧为负");
  near(h1.payoff_ratio as number, (h1.avg_win as number) / -(h1.avg_loss as number), "比值定义");
  near(h1.win_rate, (h1.win_samples / h1.sample_size) * 100, "胜率与盈亏比同源同批");
});

test("多窗口各自独立：1 日有盈有亏，5 日可能全盈 ⇒ 5 日的 payoff 是 null 而不是沿用 1 日的 6", () => {
  const rets = Array.from({ length: 44 }, (_, i) => ((i + 1) % 2 === 1 ? 3 : -0.5));
  const hs = historicalWinProbability({ symbol: "600000.SH", bars: barsFromRets(rets), conditions: MA20_UP, horizons: [1, 5] })!.horizons;
  assert.equal(hs.length, 2);
  const [h1, h5] = hs;
  near(h1.payoff_ratio, 6, "1 日窗口");
  assert.equal(h5.loss_samples, 0, "交替夹具在 5 日窗口上净涨：亏损侧为空");
  assert.equal(h5.payoff_ratio, null, "不得跨窗口借用 1 日的比值");
  assert.ok(h5.avg_win !== null && h5.avg_win > 0, "该窗口自己的盈利侧仍给得出");
});

test("新字段是加进去的，不是换掉的：既有 win_rate/avg_return/sample_size/period 全部在位", () => {
  const rets = Array.from({ length: 44 }, (_, i) => ((i + 1) % 2 === 1 ? 3 : -0.5));
  const stats = historicalWinProbability({ symbol: "600000.SH", bars: barsFromRets(rets), conditions: MA20_UP, horizons: [1] })!;
  const h1 = stats.horizons[0];
  for (const k of ["h", "win_rate", "sample_size", "avg_return", "median_return", "max_return", "worst_return", "max_drawdown",
    "avg_win", "avg_loss", "payoff_ratio", "win_samples", "loss_samples", "benchmark_return", "benchmark_sample_size", "excess_return"]) {
    assert.ok(k in h1, `${k} 必须在返回对象上真实存在（不是只在类型里声明）`);
  }
  assert.ok(stats.period, "样本区间照旧要带：决策层要求概率读数能事后重建");
  // 基准缺失时不填 0（这条口径早于 P7-⑦，加字段不该把它带崩）
  assert.equal(h1.benchmark_return, null, "本夹具没传基准K线");
  assert.ok(stats.warnings.some((w) => /基准/.test(w)), "缺基准要自报，不能静默");
});
