// AI 优选「位置格」纯核（无 IO）：个股决策日乖离 dev（close/MA20 − 1，%）按当日市场档位
// 查 790 天位置表分格。2026-10-24 排雷盖章接生产时落进仓库。
//
// 数据出处：position-check/chase-risk-table-790d.json（Z 本地 WorkBuddy 跑的位置体检表，
// 样本 2023-04-03 ~ 2026-10-20 共 790 个交易日，全市场口径、买入后 5 天胜率）。
// 分格边界与 win790 数值与 2026-10-24 全批回溯（mine-recalc-2026-10-24/recalc.py 的
// position_of）逐条一致——回溯与生产共用这一份定义，不许两边漂移。
//
// 判级：win790 ≥ 52 → green；48 ~ 52 → gray；< 48 → red。
// 原表未列格 / 合并格（震荡「其余各格」只知胜率 ≤49.3、无单格数值）win790 记 null，
// 一律 gray（只备忘、不扣章），与回溯口径一致。
// 注：震荡 −2~+2% 格 win790 = 47.2 < 48，按现行代码口径判 red（回溯附录亿嘉和即按此出「注意」）。

export type PositionRegime = "强势" | "震荡" | "弱势";
export type PositionClass = "green" | "gray" | "red";

export interface PositionCell {
  band: string;
  /** 790 天表胜率 %；未列格 / 合并格为 null */
  win790: number | null;
  cls: PositionClass;
}

export function positionOf(regime: PositionRegime, devPct: number): PositionCell {
  const d = devPct;
  if (regime === "弱势") {
    if (d < -20) return { band: "跌超 20%", win790: 57.2, cls: "green" };
    if (d < -15) return { band: "跌 20~15%", win790: 56.1, cls: "green" };
    if (d < -10) return { band: "跌 15~10%", win790: 54.3, cls: "green" };
    if (d < -5) return { band: "跌 10~5%（表未列）", win790: null, cls: "gray" };
    if (d <= 2) return { band: "跌 5% 以内/-2~+2%", win790: 48.0, cls: "gray" };
    if (d <= 20) return { band: "涨 2~20%（表未列）", win790: null, cls: "gray" };
    return { band: "涨超 20%", win790: 46.8, cls: "red" };
  }
  if (regime === "震荡") {
    if (d > 20) return { band: "涨超 20%", win790: 53.4, cls: "green" };
    if (d > 15) return { band: "涨 15~20%", win790: 55.6, cls: "green" };
    if (d < -15 && d >= -20) return { band: "跌 20~15%", win790: 42.0, cls: "red" };
    if (d >= -2 && d <= 2) return { band: "-2~+2%", win790: 47.2, cls: "red" };
    return { band: "其余各格", win790: null, cls: "gray" };
  }
  // 强势
  if (d > 20) return { band: "涨超 20%", win790: 45.1, cls: "red" };
  if (d >= 10 && d <= 15) return { band: "涨 10~15%", win790: 50.9, cls: "gray" };
  if (d >= -10 && d < -5) return { band: "跌 10~5%", win790: 43.1, cls: "red" };
  if (d > 2 && d < 20) return { band: "涨 2~20%", win790: null, cls: "gray" };
  return { band: "表未列", win790: null, cls: "gray" };
}
