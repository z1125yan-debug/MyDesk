import test from "node:test";
import assert from "node:assert/strict";
import {
  ma20Of, regimeSeriesOf, latestRegimeOf, regimeAt, regimeRankOf, fmtPct,
  type RegimeRow, type Regime,
} from "../../src/lib/quant/strategy/regime-core.ts";

test("ma20Of：前 19 根不足 → null，第 20 根起给出均值", () => {
  const closes = Array.from({ length: 25 }, (_, i) => i + 1); // 1..25
  const ma = ma20Of(closes);
  assert.equal(ma[18], null, "第 19 根（下标 18）不足 20 根，必须是 null 不是 0");
  assert.ok(ma[19] != null);
  // 1..20 的均值 = 10.5
  assert.equal(Number(ma[19]!.toFixed(4)), 10.5);
  // 2..21 的均值 = 11.5
  assert.equal(Number(ma[20]!.toFixed(4)), 11.5);
});

test("ma20Of：序列里的非法值不污染后续窗口（按 null 处理，不按 0 累加）", () => {
  const closes = [10, 10, NaN, ...Array.from({ length: 20 }, () => 10)];
  const ma = ma20Of(closes);
  // 尾部全是 10，MA20 应稳定 = 10，NaN 不能把它拽成别的值
  assert.equal(Number(ma[ma.length - 1]!.toFixed(4)), 10);
});

test("regimeSeriesOf：强势=收盘在 MA20 上且 MA20 向上；弱势=都反过来；其余=震荡", () => {
  // 单调上升 → 收盘永远在 MA20 上方、MA20 永远向上 → 强势（首日方向未定归震荡）
  const up = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
  const sUp = regimeSeriesOf(up);
  // 下标 0~18 不足 20 根，MA20 算不出 → null（「算不出」≠「震荡」，不许用震荡占位）
  assert.equal(sUp[0], null, "不足 20 根时档位算不出，必须是 null");
  // 下标 19 是第一个能算出 MA20 的日子，但它没有前值可比方向 → 方向未定归「震荡」
  assert.equal(sUp[19], "震荡", "第一个有 MA20 的日子方向未定，不许猜强/弱");
  assert.ok(sUp.slice(22).every((r) => r === "强势"), "单调上升应判强势");

  // 单调下降 → 弱势
  const down = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
  const sDown = regimeSeriesOf(down);
  assert.ok(sDown.slice(22).every((r) => r === "弱势"), `单调下降应判弱势，实际=${JSON.stringify(sDown.slice(22))}`);

  // 先涨后跌（MA20 已向下但价格在其上方）→ 震荡，不是强势
  const mixed = [...Array.from({ length: 25 }, (_, i) => 100 + i * 3), ...Array.from({ length: 15 }, (_, i) => 175 - i * 1)];
  const sMixed = regimeSeriesOf(mixed);
  const tail = sMixed[sMixed.length - 1];
  assert.ok(tail === "震荡" || tail === "弱势", `价上均线但均线向下→不该判强势，实际=${tail}`);
});

test("regimeSeriesOf 与 latestRegimeOf / regimeAt 同源（不各判一套）", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const s = regimeSeriesOf(closes);
  assert.equal(latestRegimeOf(closes), s[s.length - 1]);
  assert.equal(regimeAt(closes, 30), s[30]);
  assert.equal(regimeAt(closes, 9999), null, "越界返回 null 不猜");
  assert.equal(latestRegimeOf([1, 2, 3]), null, "不足 20 根算不出档位，返回 null");
});

const row = (id: number, name: string, st: Partial<Record<Regime, { n: number; win: number; avg: number; avg5: number } | null>>, n1 = 100) =>
  ({
    id, name, condsText: "", n1, win1: 55, avg1: 1, avg5: 1, n110: 10, win110: 50,
    强势: st.强势 ?? null, 震荡: st.震荡 ?? null, 弱势: st.弱势 ?? null,
  }) as RegimeRow;

test("regimeRankOf：按该档次日均益降序，且只排有该档成绩的", () => {
  const rows = [
    row(1, "低收益", { 弱势: { n: 50, win: 50, avg: 0.5, avg5: 0.5 } }),
    row(2, "高收益", { 弱势: { n: 50, win: 60, avg: 2.5, avg5: 3 } }),
    row(3, "无该档成绩", { 强势: { n: 50, win: 60, avg: 9, avg5: 9 } }),
    row(4, "中收益", { 弱势: { n: 50, win: 55, avg: 1.5, avg5: 1 } }),
  ];
  const r = regimeRankOf(rows, "弱势");
  assert.equal(r.regime, "弱势");
  assert.deepEqual(r.items.map((i) => i.name), ["高收益", "中收益", "低收益"]);
});

test("regimeRankOf：双门槛过滤（该档≥20、全期≥30），噪声样本不上榜", () => {
  const rows = [
    row(1, "样本不足该档", { 弱势: { n: 5, win: 100, avg: 99, avg5: 99 } }, 1000),
    row(2, "全期不足", { 弱势: { n: 100, win: 60, avg: 3, avg5: 3 } }, 10),
    row(3, "够格", { 弱势: { n: 100, win: 60, avg: 1, avg5: 1 } }, 100),
  ];
  const r = regimeRankOf(rows, "弱势");
  assert.deepEqual(r.items.map((i) => i.name), ["够格"], "5 次 100% 不许压过 100 次的真实样本");
});

test("regimeRankOf：档位为 null（算不出）→ 空榜，不猜、不退回全期榜", () => {
  const rows = [row(1, "放大量", { 弱势: { n: 100, win: 69, avg: 2.86, avg5: 4.76 } })];
  const r = regimeRankOf(rows, null);
  assert.deepEqual(r.items, []);
  assert.equal(r.regime, null);
});

test("regimeRankOf：limit 生效（弹卡只摆 5 条）", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row(i + 1, `s${i}`, { 强势: { n: 100, win: 50 + i, avg: i, avg5: i } }));
  assert.equal(regimeRankOf(rows, "强势", { limit: 5 }).items.length, 5);
});

test("fmtPct：正负号与缺值口径", () => {
  assert.equal(fmtPct(2.3456), "+2.35%");
  assert.equal(fmtPct(-1.2), "-1.20%");
  assert.equal(fmtPct(0), "+0.00%");
  assert.equal(fmtPct(null), "—");
  assert.equal(fmtPct(NaN), "—", "NaN 同为缺失，不许显示成 0%");
});
