// S0 图表底座·令牌：全站 ECharts 的动画参数与配色只定义在这一处，页面不得自带颜色。
// 色板对齐稳智实抓截图（大盘情绪页 2026-09-24），坐标轴色按本项目深色主题调；
// 本站 UI 约定为深色主题（P1P2 任务书第一节），浅色模式轴色偏亮属已知限制，暂不分支。
export const CHART = {
  anim: { duration: 900, easing: "cubicOut" },
  labelSize: 10.5,
  color: {
    barBlue: "#3f6ff7", // 稳智成交额柱
    maYellow: "#f3c744", // 柱图上的平滑均线
    up: "#ef4444", // A股红涨
    down: "#10b981", // 绿跌
    breadth: "#f56c6c", // 高于5日线占比主线（稳智红）
    selfComputed: "#38bdf8", // 同一指标的「本地真实收盘自算」对照线（P15-R19：种子口径与自算口径并排摆，不做静默替换；2026-09-29 用户拍板恢复第五条点线）
    group1: "#e6a23c", // 微盘股分组（外部同步口径的三条虚线）
    group2: "#409eff", // 中盘股分组
    group3: "#67c23a", // 大盘股分组
    idxSh: "#f87171",
    idxSz: "#38bdf8",
    idxCyb: "#fbbf24",
    axisLine: "rgba(255,255,255,0.30)",
    splitLine: "rgba(255,255,255,0.08)",
    label: "rgba(255,255,255,0.55)",
    tooltipBg: "rgba(15,18,24,0.96)",
    tooltipBorder: "rgba(255,255,255,0.14)",
  },
} as const;

/** 全站统一的 tooltip 底样式（深色卡片+浅字），页面只覆盖 trigger/formatter 等行为字段 */
export const chartTooltip = (trigger: "item" | "axis" = "axis") => ({
  trigger,
  backgroundColor: CHART.color.tooltipBg,
  borderColor: CHART.color.tooltipBorder,
  borderWidth: 1,
  padding: [6, 10] as [number, number],
  textStyle: { color: "#e5e7eb", fontSize: 11 },
  axisPointer: { lineStyle: { color: "rgba(255,255,255,0.35)" } },
});

/** 全站统一的图例底样式（圆形小标+浅字，稳智同款观感） */
export const chartLegend = (extra?: Record<string, unknown>) => ({
  icon: "circle",
  itemWidth: 9,
  itemHeight: 9,
  itemGap: 14,
  textStyle: { color: CHART.color.label, fontSize: CHART.labelSize },
  ...extra,
});
