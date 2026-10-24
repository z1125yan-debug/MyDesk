// AI 优选「温度」纯核（无 IO / 无时钟）：与台账脚本 build_pick_horizons.py 的 heat 计算
// 一字不差地对齐（2026-10-24 排雷盖章接生产时移植；台账是 20 天评审的对账基准，口径不许漂移）。
//
// 输入 barsDesc = 某票截至决策日的 qfq 日 K（close, volume），按日期倒序
// （barsDesc[0] = 最近一日；与 Python 的 SELECT ... ORDER BY tradeDate DESC LIMIT 61 一致，
// 最多 61 根，取的是「≤ 决策日的最近若干根」，不要求最近一根恰好是决策日——Python 同此）。
// 不足 21 根 → null（Python：len(bars) < 21 时 heat 为 None）；关键收盘缺失/非有限 → null，
// 记「未取到」，绝不拿 0 冒充。
//
// 三读数（阈值与 Python 完全一致，hot 用未舍入原值判定）：
//   chg   = 最近收盘 / 前一收盘 − 1（%）           热：chg ≥ 7
//   ret20 = 最近收盘 / 20 日前收盘 − 1（%）         热：ret20 ≥ 20
//   rsi   = 最近 14 个涨跌的简单平均口径 RSI14     热：rsi ≥ 60
//     （Python 对升序收盘取最后 14 个差分：涨幅和 g、跌幅和 l；
//       rsi = l 为 0 时 100，否则 100 − 100 / (1 + (g/14)/(l/14))。不是 Wilder 平滑，别改）
//   volr  = 当日量 / 前 20 日均量（只随台账展示，hot 不用它；量缺失/均量 0 → null）
// hot = 三读数里热的个数（0..3）；judge：≥2「过热」/ 1「留意」/ 0「正常」。

export interface PickHeat {
  chg: number;
  ret20: number;
  rsi: number;
  volr: number | null;
  hot: number;
  judge: "过热" | "留意" | "正常";
}

export interface HeatBar {
  close: number | null;
  volume: number | null;
}

function fin(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function computePickHeat(barsDesc: readonly HeatBar[]): PickHeat | null {
  if (barsDesc.length < 21) return null;
  const closes: number[] = [];
  for (const b of barsDesc) {
    if (!fin(b.close)) return null;
    closes.push(b.close);
  }
  const c0 = closes[0];
  const c1 = closes[1];
  const c20 = closes[20];
  if (c1 === 0 || c20 === 0) return null;
  const chg = (c0 / c1 - 1) * 100;
  const ret20 = (c0 / c20 - 1) * 100;
  // RSI 的最后 14 个差分（升序口径）== 倒序下相邻收盘差 closes[k] − closes[k+1]（k = 0..13）
  let g = 0;
  let l = 0;
  for (let k = 0; k < 14; k++) {
    const dd = closes[k] - closes[k + 1];
    if (dd > 0) g += dd;
    else l -= dd;
  }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + (g / 14) / (l / 14));
  let volr: number | null = null;
  const v0 = barsDesc[0].volume;
  if (fin(v0)) {
    let sum = 0;
    let ok = true;
    for (let k = 1; k <= 20; k++) {
      const v = barsDesc[k].volume;
      if (!fin(v)) { ok = false; break; }
      sum += v;
    }
    if (ok && sum > 0) volr = v0 / (sum / 20);
  }
  const hot = (rsi >= 60 ? 1 : 0) + (chg >= 7 ? 1 : 0) + (ret20 >= 20 ? 1 : 0);
  return { chg, ret20, rsi, volr, hot, judge: hot >= 2 ? "过热" : hot === 1 ? "留意" : "正常" };
}

/** 位置乖离 dev（%）= 最近收盘 / MA20 − 1；MA20 = 最近 20 根收盘均值（含最近一日，
 * 与 2026-10-24 回溯 recalc.py 的 ma20 口径一致）。不足 20 根 / 收盘缺失 → null。 */
export function deviationFromMa20Pct(barsDesc: readonly HeatBar[]): number | null {
  if (barsDesc.length < 20) return null;
  let sum = 0;
  for (let k = 0; k < 20; k++) {
    const c = barsDesc[k].close;
    if (!fin(c)) return null;
    sum += c;
  }
  const ma20 = sum / 20;
  const c0 = barsDesc[0].close;
  if (!fin(c0) || ma20 === 0) return null;
  return (c0 / ma20 - 1) * 100;
}
