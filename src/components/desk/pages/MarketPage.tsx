"use client";
// 大盘情绪（S1 稳智复刻）：版式/图表/动效对齐稳智 /home（照片像素基准），数据全部本站真实接口。
// 数据源：eltdx 通达信日K（带成交额）→ 腾讯兜底（2026-09-25 去东财）。
// 纪律不变：真实接口失败显式报错；缺历史序列的位置如实标「S2 回填中」，不画假线。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import {
  fetchSentiment, fetchLimitUp, fetchTrend, fetchBreadth, fetchReviewStats,
  type SentimentClient, type LimitUpClient, type TrendClient, type TrendDayPoint, type BreadthClient, type ReviewRow,
} from "@/lib/desk/quant-api";
// 情绪温度：与对话工具同一份纯核；牛/熊/震荡只换权重、不重取数
import { computeTemperature, REGIMES, type MarketRegime } from "@/lib/quant/screener/sentiment-temperature-core";
// P15-R19：种子口径的5日线占比 vs 本地真实收盘自算，同一段窗口摆在一起算差多少（纯核，不另取数）
import { compareBreadthWithSeed } from "@/lib/quant/review/breadth-crosscheck-core";
// P15-R16c：几点取的数 + 开盘自动重取
import { useLivePoll } from "@/hooks/use-live-poll";
// 当日沉淀缓存：下面的历史图每天只回源一次，当天内秒开（收盘后自动换掉盘中那份）
import { readSettled, writeSettled, decideSettled, beijingDayTime, CLOSE_HM } from "@/lib/desk/settled-cache-core";
import { useTradeDate } from "@/lib/desk/use-trade-date";
import LiveStamp from "@/components/desk/LiveStamp";
import EChart, { type EChartState } from "@/components/desk/charts/EChart";
import ChartCard from "@/components/desk/charts/ChartCard";
import { CHART, chartTooltip, chartLegend } from "@/components/desk/charts/chart-tokens";
import type { EChartsCoreOption } from "echarts/core";

// —— 图表 option 构造（纯函数，进 S0 底座统一渲染）——

/** 大盘成交额趋势：蓝柱=沪深北/两市合计（万亿），黄平滑线=最近5天平均（头部不足 5 根不画） */
function turnoverOption(days: TrendDayPoint[], marketLabel = "两市"): EChartsCoreOption {
  const pts = days.filter((d) => d.totalYi !== null);
  const dates = pts.map((d) => d.date);
  const vals = pts.map((d) => +((d.totalYi as number) / 1e4).toFixed(3));
  const totalName = `${marketLabel}合计`;
  const fmtWan = (v: number | null) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(2)} 万亿`);
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 46, right: 16, top: 34, bottom: 28 },
    tooltip: { ...chartTooltip("axis"), valueFormatter: (v: number | null) => fmtWan(v) },
    legend: { ...chartLegend({ top: 2, right: 4 }), data: [totalName, "最近5天平均"] },
    xAxis: {
      type: "category", data: dates, boundaryGap: true,
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, hideOverlap: true },
    },
    yAxis: {
      type: "value", name: "万亿", scale: true,
      nameTextStyle: { color: CHART.color.label, fontSize: CHART.labelSize },
      splitLine: { lineStyle: { color: CHART.color.splitLine } },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, formatter: (v: number) => v.toFixed(1) },
    },
    series: [
      { name: totalName, type: "bar", data: vals, barMaxWidth: 22, itemStyle: { color: CHART.color.barBlue, borderRadius: [2, 2, 0, 0] }, animationDelay: (i: number) => i * 22 },
      {
        // 稳智同款画法：黄线贴着柱顶走（柱值的平滑连线，非均线值），spline 过点视觉一致
        name: "最近5天平均", type: "line", data: vals, smooth: true, connectNulls: false,
        symbol: "circle", symbolSize: 6.5, animationDuration: 1400,
        itemStyle: { color: CHART.color.maYellow, borderColor: "rgba(255,255,255,0.85)", borderWidth: 1 },
        lineStyle: { color: CHART.color.maYellow, width: 2 },
      },
    ],
  };
}

/** 大盘情绪（5日线占比）趋势：默认「同步·两市」四线 + 本地自算第五条点线（2026-09-29 用户拍板恢复）。
 *  · 主线（稳智红实线）+ 微/中/大盘三条虚线 = 外部同步口径的四个分组，只有那份种子里有。
 *  · 第五条「自算·真实收盘」点线（蓝）= 本库真实收盘价三市全A自算，两个口径并排摆、不静默替换
 *    （P15-R19 定稿；R19c 曾按「太拥挤」撤成单线，现按用户要求恢复五线）。
 *  差多少由 breadth-crosscheck-core 现算，压成卡片口径行里一行字。 */
function breadthOption(
  main: { date: string; v: number }[],
  groups: { micro: { date: string; v: number | null }[]; mid: { date: string; v: number | null }[]; large: { date: string; v: number | null }[] } | null,
  self: { date: string; v: number }[] | null,
): EChartsCoreOption {
  const dates = main.map((p) => p.date);
  const series: Record<string, unknown>[] = [
    {
      name: "高于5日线占比", type: "line", data: main.map((p) => +p.v.toFixed(1)),
      smooth: true, symbol: "circle", symbolSize: 6.5,
      itemStyle: { color: CHART.color.breadth, borderColor: "rgba(255,255,255,0.85)", borderWidth: 1 },
      lineStyle: { color: CHART.color.breadth, width: 2.2 },
    },
  ];
  if (groups) {
    const defs: [string, { date: string; v: number | null }[], string][] = [
      ["微盘股", groups.micro, CHART.color.group1],
      ["中盘股", groups.mid, CHART.color.group2],
      ["大盘股", groups.large, CHART.color.group3],
    ];
    for (const [name, pts, color] of defs) {
      series.push({
        name, type: "line",
        data: dates.map((d) => { const f = pts.find((x) => x.date === d); return f?.v != null ? +f.v.toFixed(1) : null; }),
        smooth: true, symbol: "circle", symbolSize: 5, connectNulls: false,
        itemStyle: { color: "rgba(0,0,0,0)", borderColor: color, borderWidth: 1.3 },
        lineStyle: { color, width: 1.5, type: "dashed" },
      });
    }
  }
  if (self) {
    const byDate = new Map(self.map((p) => [p.date, p.v]));
    series.push({
      name: "自算·真实收盘", type: "line",
      data: dates.map((d) => { const v = byDate.get(d); return v != null ? +v.toFixed(1) : null; }),
      smooth: true, symbol: "circle", symbolSize: 4.5, connectNulls: false,
      itemStyle: { color: "rgba(0,0,0,0)", borderColor: CHART.color.selfComputed, borderWidth: 1.3 },
      lineStyle: { color: CHART.color.selfComputed, width: 1.6, type: "dotted" },
    });
  }
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 42, right: 16, top: 34, bottom: 28 },
    tooltip: { ...chartTooltip("axis"), valueFormatter: (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`) },
    legend: { ...chartLegend({ top: 2, right: 4 }), data: series.map((s) => s.name as string) },
    xAxis: {
      type: "category", data: dates,
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, hideOverlap: true },
    },
    yAxis: {
      type: "value", min: 0, max: 100, name: "%",
      nameTextStyle: { color: CHART.color.label, fontSize: CHART.labelSize },
      splitLine: { lineStyle: { color: CHART.color.splitLine } },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize },
    },
    series,
  };
}

/** 涨跌停板分布对比（当日实数；历史逐日正负柱+趋势线等 S2 回填） */
function limitTodayOption(limitUp: number, limitDown: number): EChartsCoreOption {
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 40, right: 16, top: 26, bottom: 28 },
    tooltip: { ...chartTooltip("item"), valueFormatter: (v: number | null) => (v == null ? "—" : `${v} 家`) },
    xAxis: {
      type: "category", data: ["涨停", "跌停"],
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: CHART.color.splitLine } },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize },
    },
    series: [{
      type: "bar", barWidth: 52, data: [
        { value: limitUp, itemStyle: { color: CHART.color.up, borderRadius: [3, 3, 0, 0] } },
        { value: limitDown, itemStyle: { color: CHART.color.down, borderRadius: [3, 3, 0, 0] } },
      ],
      label: { show: true, position: "top", color: CHART.color.label, fontSize: CHART.labelSize },
    }],
  };
}

/** 连板梯队结构（当日）：首板/2连板/3板/4板/5板+（配色对应稳智 3板绿/4板黄/5板+红） */
function tierOption(first: number, second: number, n3: number, n4: number, n5: number): EChartsCoreOption {
  const colors = [CHART.color.barBlue, CHART.color.barBlue, "#67c23a", "#f3c744", "#ef4444"];
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 40, right: 16, top: 26, bottom: 28 },
    tooltip: { ...chartTooltip("item"), valueFormatter: (v: number | null) => (v == null ? "—" : `${v} 家`) },
    xAxis: {
      type: "category", data: ["首板", "2连板", "3板", "4板", "5板+"],
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: CHART.color.splitLine } },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize },
    },
    series: [{
      type: "bar", barWidth: 30, data: [first, second, n3, n4, n5].map((v, i) => ({
        value: v, itemStyle: { color: colors[i], borderRadius: [3, 3, 0, 0] },
      })),
      label: { show: true, position: "top", color: CHART.color.label, fontSize: CHART.labelSize },
    }],
  };
}

/** 指数涨跌幅：稳智同款 = 区间累计涨跌幅（自窗口首日起逐日复利累计），七条线 */
function indexDailyOption(idx: NonNullable<TrendClient["idx"]>): EChartsCoreOption {
  const palette = ["#4f8ef7", "#a3e635", "#94a3b8", "#f97316", "#22d3ee", "#facc15", "#f472b6"];
  const series = idx.filter((s) => s.pts.length > 1);
  const dates = [...new Set(series.flatMap((s) => s.pts.map((p) => p.date)))].sort();
  const byDate = new Map(series.map((s) => [s.key, new Map(s.pts.map((p) => [p.date, p.pct]))]));
  const cum = (key: string) => {
    let prod = 1;
    return dates.map((d) => {
      const p = byDate.get(key)?.get(d);
      if (p == null) return null;
      prod *= 1 + p / 100;
      return +((prod - 1) * 100).toFixed(2);
    });
  };
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 48, right: 16, top: 34, bottom: 28 },
    tooltip: { ...chartTooltip("axis"), valueFormatter: (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`) },
    legend: {
      ...chartLegend({ top: 2, right: 4, type: "scroll" }),
      data: series.map((s) => s.name),
    },
    xAxis: {
      type: "category", data: dates,
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, hideOverlap: true },
    },
    yAxis: {
      type: "value", name: "%", scale: true,
      nameTextStyle: { color: CHART.color.label, fontSize: CHART.labelSize },
      splitLine: { lineStyle: { color: CHART.color.splitLine } },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, formatter: (v: number) => `${v.toFixed(2)}%` },
    },
    series: series.map((s, i) => ({
      name: s.name, type: "line", data: cum(s.key),
      smooth: true, symbol: "circle", symbolSize: 5.5, connectNulls: false,
      itemStyle: { color: "rgba(0,0,0,0)", borderColor: palette[i % palette.length], borderWidth: 1.4 },
      lineStyle: { color: palette[i % palette.length], width: 1.8 },
    })),
  };
}

/** 涨跌停板分布对比（历史）：稳智同款取窗口内最后 10 个交易日；涨停红柱向上/跌停绿柱向下 + 两条平滑趋势线 */
function limitHistoryOption(allRows: ReviewRow[]): EChartsCoreOption {
  const rows = allRows.slice(-10);
  const dates = rows.map((r) => r.date);
  const zt = rows.map((r) => r.limitUp);
  const dt = rows.map((r) => r.limitDown);
  const smooth = (arr: number[]) => arr.map((_, i) => {
    const w = arr.slice(Math.max(0, i - 2), i + 1);
    return +(w.reduce((s, x) => s + x, 0) / w.length).toFixed(1);
  });
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 44, right: 16, top: 34, bottom: 28 },
    tooltip: { ...chartTooltip("axis") },
    legend: { ...chartLegend({ top: 2, right: 4 }), data: ["涨停", "跌停", "涨停趋势", "跌停趋势"] },
    xAxis: {
      type: "category", data: dates,
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: CHART.color.splitLine } },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize },
    },
    series: [
      { name: "涨停", type: "bar", stack: "l", data: zt, barMaxWidth: 26, itemStyle: { color: CHART.color.up, borderRadius: [2, 2, 0, 0] }, label: { show: true, position: "top", color: "rgba(255,160,160,0.9)", fontSize: 9.5 }, animationDelay: (i: number) => i * 45 },
      { name: "跌停", type: "bar", stack: "l", data: dt.map((v) => -v), barMaxWidth: 26, itemStyle: { color: CHART.color.down, borderRadius: [0, 0, 2, 2] }, label: { show: true, position: "bottom", color: "rgba(140,220,180,0.9)", fontSize: 9.5 }, animationDelay: (i: number) => i * 45 },
      { name: "涨停趋势", type: "line", data: smooth(zt), smooth: true, symbol: "none", animationDuration: 1500, itemStyle: { color: CHART.color.up }, lineStyle: { color: CHART.color.up, width: 1.8 } },
      { name: "跌停趋势", type: "line", data: smooth(dt), smooth: true, symbol: "none", animationDuration: 1500, itemStyle: { color: CHART.color.down }, lineStyle: { color: CHART.color.down, width: 1.8 } },
    ],
  };
}

/** 连板梯队结构（历史）：稳智同款取窗口内最后 10 个交易日；3板/4板/5板+ 堆叠柱 + 最高板蓝线（右轴高度） */
function tierHistoryOption(allRows: ReviewRow[]): EChartsCoreOption {
  const rows = allRows.slice(-10);
  const dates = rows.map((r) => r.date);
  return {
    animationDuration: CHART.anim.duration,
    animationEasing: CHART.anim.easing,
    grid: { left: 40, right: 42, top: 34, bottom: 28 },
    tooltip: { ...chartTooltip("axis") },
    legend: { ...chartLegend({ top: 2, right: 4 }), data: ["3板", "4板", "5板+", "最高板"] },
    xAxis: {
      type: "category", data: dates,
      axisLine: { lineStyle: { color: CHART.color.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize, hideOverlap: true },
    },
    yAxis: [
      { type: "value", name: "家数", max: 10, nameTextStyle: { color: CHART.color.label, fontSize: CHART.labelSize }, splitLine: { lineStyle: { color: CHART.color.splitLine } }, axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize } },
      { type: "value", name: "高度", max: 6, nameTextStyle: { color: CHART.color.label, fontSize: CHART.labelSize }, splitLine: { show: false }, axisLabel: { color: CHART.color.label, fontSize: CHART.labelSize } },
    ],
    series: [
      { name: "3板", type: "bar", stack: "t", data: rows.map((r) => r.t3), barMaxWidth: 16, itemStyle: { color: "#67c23a" } },
      { name: "4板", type: "bar", stack: "t", data: rows.map((r) => r.t4), itemStyle: { color: "#f3c744" } },
      { name: "5板+", type: "bar", stack: "t", data: rows.map((r) => r.t5), itemStyle: { color: "#ef4444", borderRadius: [2, 2, 0, 0] } },
      { name: "最高板", type: "line", yAxisIndex: 1, data: rows.map((r) => r.maxBoards), smooth: true, symbol: "circle", symbolSize: 5.5, itemStyle: { color: "#5b8ff7" }, lineStyle: { color: "#5b8ff7", width: 2 } },
    ],
  };
}

// 温度档位色（与 TempGauge 色带同线）
function bandColor(v: number | null): string | undefined {
  if (v === null) return undefined;
  if (v < 25) return "#38bdf8";
  if (v < 45) return "#34d399";
  if (v < 60) return "#94a3b8";
  if (v < 80) return "#fb923c";
  return "#f87171";
}

export default function MarketPage() {
  const [sent, setSent] = useState<SentimentClient | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [tiers, setTiers] = useState<LimitUpClient | null>(null);
  const [tiersBusy, setTiersBusy] = useState(true);
  // 行情类型（牛/熊/震荡）只影响温度权重，是本机视图状态、不发请求
  const [regime, setRegime] = useState<MarketRegime>("range");
  // 复盘统计：日期范围是本机视图参数，默认近 90 天（约 64 个交易日，看中期趋势）；
// 注意：「大盘情绪（5日线占比）趋势」是另一条独立链路（loadBreadth 固定 30 天），不受这个选择器影响。
  const [trend, setTrend] = useState<TrendClient | null>(null);
  const [trendBusy, setTrendBusy] = useState(true);
  const shDay = (offset: number) => {
    const d = new Date(Date.now() - offset * 864e5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [trendFrom, setTrendFrom] = useState(() => shDay(90));
  // 结束日期默认「最近交易日」而不是系统当天：休市日（周末/节假日）系统当天没有行情，
  // 拿它当区间终点等于把一个没开过盘的日子摆进图里。
  // 派生值而非 effect 同步：拿到真交易日之前 trendTo 为空（不取），拿到后自动取一次。
  const { tradeDate } = useTradeDate();
  const [trendToPick, setTrendToPick] = useState("");
  const trendTo = trendToPick || tradeDate;
  const [trendError, setTrendError] = useState("");
  // 复盘统计历史（稳智账号同步种子：P15-R19 已照抄进 market_daily_stats，读侧只把晚于种子终点的自产行续上图）
  const [review, setReview] = useState<{ rows: ReviewRow[]; source: string; seedEnd?: string; indexChanges?: { d: string; allA: number; sh: number; dividend: number; small: number; mid: number; sz: number; cyb: number }[] } | null>(null);
  // 逐日宽度（站上5日线占比）：来自 stock_daily_close 的收盘后沉淀
  const [breadth, setBreadth] = useState<BreadthClient | null>(null);
  const [breadthBusy, setBreadthBusy] = useState(true);
  // 这张图画哪条口径：local = 本库真实收盘价自算（三市全A，默认，我们的数）；
  // sync = 外部同步种子（两市票池，带微/中/大盘分组，稳智同款四线）。图上同时只摆一条，不并排。
  const [breadthSrc, setBreadthSrc] = useState<"local" | "sync">("sync");
  /**
   * 下方这些「收盘后沉淀」的图，当天已经取过一次就固定下来（用户 2026-09-29：
   * 「像下面这些需要收盘后的就固定……再点击除了首页四个卡片实时更新，而不是得等待」）。
   * settledAt 只用于如实标注「这批数是几点取的」，不参与判定。
   */
  const [settledAt, setSettledAt] = useState("");
  const poll = useLivePoll();

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      setSent(await fetchSentiment());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadTrend = useCallback(async (from = "", to = "", opts: { force?: boolean; cacheKey?: string } = {}) => {
    // 当日沉淀缓存（settled-cache-core）：下方这些「收盘后才沉淀」的图每天只回源一次，
    // 当天内再进页面一律秒开；若上次是盘中取的、现在已经收盘，则先摆旧值再后台换新（不阻塞）。
    const cacheKey = opts.cacheKey ?? `market-trend:${from}:${to}`;
    const cached = cacheKey ? readSettled<{ t: TrendClient; rv: typeof review }>(cacheKey) : null;
    const decision = cached ? decideSettled(cached, beijingDayTime()) : { use: false, refetch: true, reason: "missing" as const };
    if (cached && decision.use && !opts.force) {
      setTrend(cached.data.t); setReview(cached.data.rv); setTrendBusy(false); setSettledAt(cached.at);
      return;
    }
    const instant = !!cached;                       // 有旧值：先渲染，避免白屏等待
    if (instant) { setTrend(cached!.data.t); setReview(cached!.data.rv); setSettledAt(cached!.at); setTrendBusy(false); }
    else setTrendBusy(true);
    setTrendError("");
    try {
      const [t, rv] = await Promise.all([
        fetchTrend(from, to),
        fetchReviewStats(from, to).catch(() => null),
      ]);
      setTrend(t);
      setReview(rv);
      if (cacheKey) setSettledAt(writeSettled(cacheKey, { t, rv }).at);
    } catch (e) {
      if (!instant) { setTrend(null); setTrendError(String((e as Error).message || e)); }
    } finally {
      setTrendBusy(false);
    }
    // 依赖只放「取数函数」：review 只用于类型标注，不该把本函数身份搅动起来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadBreadth = useCallback(async (opts: { force?: boolean } = {}) => {
    const KEY = "market-breadth:30";
    const cached = readSettled<BreadthClient>(KEY);
    const decision = cached ? decideSettled(cached, beijingDayTime()) : { use: false, refetch: true, reason: "missing" as const };
    if (cached && decision.use && !opts.force) { setBreadth(cached.data); setBreadthBusy(false); return; }
    const instant = !!cached;
    if (instant) { setBreadth(cached!.data); setBreadthBusy(false); } else setBreadthBusy(true);
    try {
      // 30 天窗口：这张「大盘情绪（5日线占比）趋势」看的是近期宽度变化，
      // 与上面成交额图的 90 天窗口刻意分开（两条链路独立，互不影响）。
      const fresh = await fetchBreadth(30);
      setBreadth(fresh);
      writeSettled(KEY, fresh);
    } catch {
      if (!instant) setBreadth(null); // 宽度失败不打掉情绪主体
    } finally {
      setBreadthBusy(false);
    }
  }, []);

  /**
   * 涨停梯队 = **当日实时结构**，必须跟盘中一起走（用户 2026-09-29 拍板：
   * 「连板梯队肯定跟着实时走啊，盘中和盘后能一样吗」）。
   * 所以它**不进**当日沉淀缓存——和顶四卡一样挂 useLivePoll 的 tick，开盘自动重取、休市自然停。
   */
  const loadTiers = useCallback(async () => {
    setTiersBusy(true);
    try {
      setTiers(await fetchLimitUp());
    } catch {
      setTiers(null);
    } finally {
      setTiersBusy(false);
    }
  }, []);

  useEffect(() => {
    // 三个首屏取数都丢进 setTimeout(0)：它们第一行就 set*Busy(true)，同步进 effect
    // 会吃 set-state-in-effect 告警（HEAD 基线本页 1 条，不新增）；轮询那份保持原样。
    const t = setTimeout(() => { void load(); void loadBreadth(); void loadTiers(); }, 0);
    // 复盘统计（成交额/5日线占比/涨跌停/连板/指数五张图的历史）由下面那个 effect 负责：
    // 必须等真交易日到位才取，这里不能顺手取 —— 空终点传下去就是拿系统当天当区间末日。
    return () => clearTimeout(t);
  }, [load, loadBreadth, loadTiers]);

  // 首屏复盘统计：等「最近交易日」到位后自动取一次（不是挂载就取）。
  // 这里踩过一次坑：交易日是异步来的，把 `if (trendTo) loadTrend(...)` 写在挂载 effect 里、
  // 又不把 trendTo 放进依赖，交易日到了 effect 早跑完了 —— 整页历史一次都没取过（2026-09-28 实测）。
  // 现在按「第一次拿到非空终点」触发；之后再改窗口仍只走「加载复盘数据统计」按钮，
  // 免得日期 input 每敲一下就打一次上游。
  // setTimeout(0) 只为绕开 set-state-in-effect：loadTrend 第一行就 setTrendBusy(true)，
  // 同步调用会在 effect 里触发级联渲染告警（本页既有基线 1 条，不再新增）。
  const trendAutoRef = useRef(false);
  useEffect(() => {
    if (!trendTo || trendAutoRef.current) return;
    trendAutoRef.current = true;
    const t = setTimeout(() => void loadTrend(trendFrom, trendTo), 0);
    return () => clearTimeout(t);
  }, [trendTo, trendFrom, loadTrend]);

  useEffect(() => {
    if (poll.tick > 0) { load(); void loadTiers(); }
  }, [poll.tick, load, loadTiers]);

  // 轮询周期里顺带问一句「下方的当日沉淀数据需不需要换新」：
  // 两个 load 内部先查缓存判定——命中就**一次网络都不发**（秒回，不打扰用户），
  // 只有「昨天那份」或「盘中取的、现在已经收盘」才回源。于是页面一直开着跨过 15:00 时，
  // 下方历史图会自己换成收盘口径；连板梯队/四卡则按上面的实时轮询走。
  useEffect(() => {
    if (poll.tick <= 0) return;
    const t = setTimeout(() => {
      void loadTrend(trendFrom, trendTo);
      void loadBreadth();
    }, 0);
    return () => clearTimeout(t);
  }, [poll.tick, trendFrom, trendTo, loadTrend, loadBreadth]);

  // —— 派生量（全部由已回传字段推得，不产生新事实）——
  const temp = sent ? computeTemperature({
    advancers: sent.advancers, decliners: sent.decliners, median_pct: sent.median_pct,
    limit_up: sent.limit_up, limit_down: sent.limit_down, break_rate: sent.break_rate,
    main_net_sum_yi: sent.main_net_sum_yi, main_net_known: sent.main_net_known,
  }, regime) : null;
  /**
   * 已完成的交易日（口径）：15:00 之后算今天，否则算到昨天。
   *
   * 为什么需要：行情源在盘中会给**今天那根未收盘的半截柱**（实测 10:22 是 6199 亿）。
   * 半截柱不能进「当日沉淀」——否则页面上会同时出现两个今天（卡片说 0.62 万亿、图说 0.48），
   * 而且那根柱子会一整天定在第一次打开时的值上。所以：
   *   · 图 = 只画已完成交易日（收盘后今天自然入列）
   *   · 卡 = 实时累计（见下面 turnoverLive，走 sentiment 轮询源）
   */
  const completedThrough = useMemo(() => {
    const { day, hm } = beijingDayTime();
    if (hm >= CLOSE_HM) return day;
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
    // 跟轮询一起走：跨过 15:00 后这一行自动把今天纳入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.tick]);
  const trendDaysDone = useMemo(
    () => (trend?.days ?? []).filter((d) => d.date <= completedThrough),
    [trend, completedThrough],
  );
  /**
   * 成交额卡片＝**实时**口径（用户实测过：刷新后还停在 0.48 是因为它读了被定住的趋势序列）。
   * 「一家都没抓到」时 `amount_total_yi` 也是 0——那是**没读到**，不是「今天只成交了 0 亿」，
   * 所以必须过 `amount_known` 这道闸，缺读数就显「—」（P14 定下的口径，不许出 0.00 万亿）。
   */
  const turnoverLiveYi = sent && (sent.amount_known ?? 0) > 0 ? sent.amount_total_yi : null;
  const turnoverLiveWan = turnoverLiveYi != null ? turnoverLiveYi / 1e4 : null;
  /** 昨日全天成交额（已收盘口径，来自沉淀序列）——用来算「盘中已达昨日 X%」 */
  const yesterdayYi = [...trendDaysDone].reverse().find((d) => d.totalYi != null)?.totalYi ?? null;
  const turnoverPctOfYesterday = turnoverLiveYi != null && yesterdayYi ? (turnoverLiveYi / yesterdayYi) * 100 : null;
  const bLatest = breadth?.latest ?? null;
  // 5日线占比有两个口径，**图上同一时刻只画一个**（用户：四条线已经够挤，别再并排摆第五条对照线）：
  //   本地·三市（默认）＝本库真实收盘价自算，票池是沪+深+北交所，收盘后自己往前长，往后分位数也吃这条；
  //   同步·两市＝稳智同步那份（整体 + 微/中/大盘共四条），票池实测剔了北交所。
  // 两者差多少由 breadth-crosscheck-core 当场算、写在口径行里——不静默替换，也不把外部口径藏掉。
  const reviewRows = review?.rows ?? [];
  // 指数涨跌幅：稳智 index-changes 同源种子优先（全A/上证/红利/小盘/中小盘/深成/创业板），eltdx 目录兜底
  const IDX_NAMES: [string, string, string][] = [
    ["allA", "全A", "#4f8ef7"], ["sh", "上证", "#a3e635"], ["dividend", "红利", "#94a3b8"],
    ["small", "小盘", "#f97316"], ["mid", "中小盘", "#22d3ee"], ["sz", "深成", "#facc15"], ["cyb", "创业板", "#f472b6"],
  ];
  const idxSeries = useMemo(() => {
    const ic = review?.indexChanges;
    if (ic && ic.length >= 2) {
      return IDX_NAMES.map(([k, name]) => ({ key: k, name, pts: ic.map((r) => ({ date: r.d, pct: r[k] as number })) }));
    }
    return trend?.idx ?? [];
  }, [review, trend]);
  // 5日线占比图的时间窗口：**固定「近一个月」**，口径逐字对齐稳智（源码实证）。
  // 稳智 Home.js 里默认区间就是这么算的：
  //     const t = Te(e, -30);   // e = 数据里的最新日期；往前推 30 天（UTC 算法）
  //     兜底：ce(new Date(Date.now() - 2592e6))   // 2592e6 ms = 30 天
  // 所以基准是**最新数据日**而不是"今天"（休市日两者会差一天，跟稳智对齐要用前者）。
  // 与上方成交额图的 90 天选择器解耦，也与「涨跌停板/连板梯队」的近 10 日不同 —— 三张图口径各自独立。
  const bFrom = useMemo(() => {
    const latest = reviewRows.length ? String(reviewRows[reviewRows.length - 1].date) : "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(latest);
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  }, [reviewRows]);
  const bWindow = useMemo(() => (bFrom ? reviewRows.filter((x) => x.date >= bFrom) : reviewRows), [reviewRows, bFrom]);
  // 本地自算那条（三市全A）：起头按同一个月窗口切，尾巴跟着库里最新沉淀日往前走
  const bLocal = useMemo(
    () => (breadth?.series ?? []).filter((p) => p.above_ma5_pct !== null).map((p) => ({ date: p.date, v: p.above_ma5_pct as number })),
    [breadth],
  );
  const bLocalWin = useMemo(() => (bFrom ? bLocal.filter((p) => p.date >= bFrom) : bLocal), [bLocal, bFrom]);
  // 同步那条（两市票池）：**只取种子覆盖到的那些日子**。种子终点之后库里是自产行（三市口径），
  // 混进来这张图就挂着「同步·两市」的名字画我们的数——那是口径错标（R17 板块榜写死「个股」同一个坑）。
  // 窗口内不足 2 天就退回全量，别画一个孤点。
  const seedEnd = review?.seedEnd ?? "";
  const bSyncRows = useMemo(() => {
    const seedOnly = seedEnd ? reviewRows.filter((x) => x.date <= seedEnd) : reviewRows;
    const win = bWindow.filter((x) => x.aboveMa5Pct !== null && (!seedEnd || x.date <= seedEnd));
    return win.length >= 2 ? win : seedOnly.filter((x) => x.aboveMa5Pct !== null);
  }, [bWindow, reviewRows, seedEnd]);
  const bSync = useMemo(() => bSyncRows.map((x) => ({ date: x.date, v: x.aboveMa5Pct as number })), [bSyncRows]);
  // 画哪条由开关定；本地那条还没攒够两天时如实退回同步，不空着一张图。
  // bDrawn = **实际画出来的**那条：退回时口径行跟着改成同步的措辞，不挂着「自算」画别人的数。
  const bLocalReady = bLocalWin.length >= 2;
  const bDrawn: "local" | "sync" = breadthSrc === "sync" || !bLocalReady ? "sync" : "local";
  const bMain = bDrawn === "sync" ? bSync : bLocalWin;
  const bGroups = useMemo(() => {
    // 分组三条虚线只有画同步那条时才配出现（它们是同一份种子出来的），且必须与主线同一段切片
    if (bDrawn !== "sync" || bSyncRows.length < 2) return null;
    const col = (k: "microPct" | "midPct" | "largePct") => bSyncRows.map((x) => ({ date: x.date, v: x[k] }));
    return { micro: col("microPct"), mid: col("midPct"), large: col("largePct") };
  }, [bDrawn, bSyncRows]);
  // 两个口径差多少：算法在 breadth-crosscheck-core，这里只喂当眼前这段窗口的事实（跟画哪条无关，两段都有读数才算）
  const bCheck = useMemo(
    () => (bLocalWin.length >= 2 && bSync.length >= 2
      ? compareBreadthWithSeed(
        bSync.map((p) => ({ date: p.date, aboveMa5Pct: p.v })),
        bLocalWin.map((p) => ({ date: p.date, above_ma5_pct: p.v })),
      )
      : null),
    [bSync, bLocalWin],
  );
  // 口径行：一行字说清「这条线是谁算的、票池几个市场、跟另一条差多少」——
  // 数字全部现算（bCheck 走纯核），不写死；写死的话明天数据变了它还自信地报旧差值。
  const bNote = bMain.length < 2
    ? "站上5日线占比要拿每票收盘价对 5 日线：历史已按真实日K回填到 2026-04-20，之后每个交易日收盘后自产"
    : `近一个月 · 站上5日线占比 ${bMain.length} 个统计日（${bMain[0].date} ~ ${bMain[bMain.length - 1].date}）· `
      + (bDrawn === "local"
        ? `本库真实收盘价自算，票池三市全A（当日 ${breadth?.latest?.universe ?? "—"} 只）`
          + (bCheck
            ? `；跟同步那份（只有沪+深）比：这 ${bCheck.comparable_days} 天平均差 ${bCheck.mean_abs_pt ?? "—"} 个百分点、`
              + `最大 ${bCheck.max_abs_pt ?? "—"}（110 天全量实测：去掉北交所只少 0.26 点，票池不是主因，剩下是同步那条在弱市更平）`
            : "")
        : `外部同步口径，票池只有沪+深（剔北交所 347 只）；三条虚线是它的微盘/中盘/大盘分组，蓝色点线是我们本库三市全A自算（两条差多少见下）`
          + `${seedEnd ? ` · 同步那份止于 ${seedEnd}，之后库里是我们自己算的（三市），不混进这条线` : ""}`);
  const belowMa5 = bLatest && bLatest.ma5_eligible > 0 ? bLatest.ma5_eligible - bLatest.above_ma5 : null;
  const p3 = tiers?.tiers.find((t) => t.label === "3连板+")?.stocks ?? [];
  const n3 = p3.filter((s) => s.boards === 3).length;
  const n4 = p3.filter((s) => s.boards === 4).length;
  const n5 = p3.filter((s) => s.boards >= 5).length;
  const nFirst = tiers?.tiers.find((t) => t.label === "首板")?.stocks.length ?? 0;
  const nSecond = tiers?.tiers.find((t) => t.label === "2连板")?.stocks.length ?? 0;
  const ratio = sent && sent.decliners > 0 ? sent.advancers / sent.decliners : null;
  const asOfDay = sent?.as_of ? sent.as_of.slice(0, 10) : "";
  const delta = trend?.delta ?? null;

  const turnoverState: EChartState = trendBusy ? "loading"
    : trend && trend.days.some((d) => d.totalYi !== null) ? "ok" : "empty";
  const breadthState: EChartState = breadthBusy && bMain.length < 2 ? "loading" : bMain.length >= 2 ? "ok" : "empty";
  const limitRows = reviewRows.filter((r) => r.limitUp > 0 || r.limitDown > 0);
  const limitState: EChartState = limitRows.length >= 2 ? "ok" : busy && !sent ? "loading" : sent ? "ok" : "empty";
  const tierRows = reviewRows.filter((r) => r.maxBoards > 0);
  const tierState: EChartState = tierRows.length >= 2 ? "ok" : tiersBusy ? "loading" : tiers ? "ok" : "empty";
  const idxHas = idxSeries.some((s) => s.pts.length > 1);
  const idxState: EChartState = trendBusy ? "loading" : idxHas ? "ok" : "empty";

  return (
    <div className="w-full space-y-5 px-8 py-6">
      {/* 页头：稳智同款居中标题+免责口径；实时戳/刷新挂右侧 */}
      <div className="relative apple-slide-up">
        <div className="text-center">
          <h1 className="text-[25px] font-semibold tracking-tight">市场情绪分析</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">基于本站实时行情与收盘沉淀的市场资金流向与指标研究 · 仅供研究参考，不构成投资建议。</p>
        </div>
        <div className="absolute right-0 top-0 flex items-center gap-2">
          <LiveStamp poll={poll} iso={sent?.as_of ?? ""} />
          <button onClick={load} title="只刷新上面四个实时卡片（下方历史图是「收盘后沉淀」口径，每天首次打开自动更新一次）" className="flex items-center gap-1.5 rounded-full border border-border/70 bg-overlay px-3.5 py-2 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} 刷新
          </button>
        </div>
      </div>

      {error && <div className="apple-card border-red-400/25 px-4 py-3 text-[14px] text-red-300">{error}</div>}

      {/* 顶四卡：稳智同款合并大卡，竖线分四列，数字居中 */}
      <div className="apple-slide-up rounded-2xl border border-border/60 bg-overlay px-2 py-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 lg:divide-x divide-border/40">
          <div className="px-4 py-2 text-center">
            <div className="text-[14.5px] font-medium">情绪温度</div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <span className="text-[35px] font-semibold leading-none tracking-tight" style={{ color: bandColor(temp?.temperature ?? null) }}>
                {temp?.temperature ?? "—"}{temp?.temperature != null && <span className="text-[17px]">%</span>}
              </span>
              <TempGauge value={temp?.temperature ?? null} label="" compact />
            </div>
            <div className="mt-2 text-[12.5px] text-muted-foreground">{temp?.label ?? "无读数"}{temp?.temperature != null ? " / 100" : ""}</div>
          </div>
          <div className="px-4 py-2 text-center">
            <div className="text-[14.5px] font-medium">成交额</div>
            {/* 实时口径：盘中＝当日累计（跟着轮询涨），收盘后＝全天值。数据源与四卡其他张一致（sentiment）。 */}
            <div className="mt-3 text-[35px] font-semibold leading-none tracking-tight">
              {turnoverLiveWan != null ? `${turnoverLiveWan.toFixed(2)}万亿` : "—"}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[12.5px]">
              {turnoverLiveYi != null && (
                <span className={poll.open ? "text-sky-300" : "text-muted-foreground"}>
                  {poll.open ? "盘中累计" : "全天"}
                </span>
              )}
              {turnoverPctOfYesterday != null && poll.open && (
                <span className="text-muted-foreground">已达昨日 {turnoverPctOfYesterday.toFixed(0)}%</span>
              )}
              {!poll.open && delta?.yi != null && (
                <span className={delta.yi < 0 ? "text-emerald-400" : "text-red-400"}>
                  {delta.yi < 0 ? "↓" : "↑"}{Math.abs(Math.round(delta.yi))}亿 <span className="text-muted-foreground">vs昨日</span>
                </span>
              )}
              {yesterdayYi != null && (
                <span className="text-muted-foreground" title="昨日全天（沪深北合计，已收盘口径）">
                  昨日 {(yesterdayYi / 1e4).toFixed(2)}万亿
                </span>
              )}
              {sent?.as_of && <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11.5px] text-muted-foreground">{sent.as_of.slice(0, 10)}</span>}
            </div>
          </div>
          <div className="px-4 py-2 text-center">
            <div className="text-[14.5px] font-medium">连板高度</div>
            <div className="mt-3 text-[35px] font-semibold leading-none tracking-tight">{tiers ? `${tiers.max_boards}板` : "—"}</div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1 text-[11.5px]">
              {sent && <span className="rounded border border-red-400/25 bg-red-400/10 px-1.5 py-0.5 text-red-300">涨停:{sent.limit_up}</span>}
              {sent && <span className="rounded border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-emerald-300">跌停:{sent.limit_down}</span>}
              {tiers && <>
                <span className="rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground">三板:{n3}</span>
                <span className="rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground">四板:{n4}</span>
                <span className={`rounded border px-1.5 py-0.5 ${n5 > 0 ? "border-red-400/25 bg-red-400/10 font-medium text-red-300" : "border-border/60 text-muted-foreground"}`}>五板+:{n5}</span>
              </>}
            </div>
          </div>
          <div className="px-4 py-2 text-center">
            <div className="text-[14.5px] font-medium">涨跌比</div>
            <div className="mt-3 text-[35px] font-semibold leading-none tracking-tight" style={{ color: ratio == null ? undefined : ratio >= 1 ? CHART.color.up : CHART.color.down }}>
              {ratio == null ? "—" : ratio.toFixed(2)}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[13px] text-muted-foreground">
              {sent && <span>跌:{sent.decliners}</span>}
              <span>低5日:{belowMa5 ?? "—"}</span>
              {asOfDay && <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11.5px]">{asOfDay}</span>}
            </div>
          </div>
        </div>
      </div>

      {!sent && !error && (
        <div className="apple-card flex items-center gap-2 px-4 py-3 text-[13.5px] text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> 正在加载市场快照...
        </div>
      )}

      {/* 大盘情绪区：日期范围 + 行情状态 + 加载复盘数据统计（稳智同款控件行） */}
      <div className="apple-fade-in flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="text-[17px] font-semibold">大盘情绪</div>
          {/* 口径如实标注：这批历史数是当天几点取的（每天首次打开取一次，当天不再重复请求→秒开） */}
          {settledAt && (
            <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11.5px] text-muted-foreground"
              title={`下方历史口径（成交额趋势/5日线占比/涨跌停分布/指数区间涨跌）为当日沉淀：${settledAt} 取回后固定，收盘后自动更新一次。实时部分＝顶四卡与连板梯队，按交易时段轮询刷新。`}>
              当日沉淀 {settledAt}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-overlay px-2.5 py-1.5">
            <input type="date" value={trendFrom} max={trendTo || undefined} onChange={(e) => setTrendFrom(e.target.value)}
              className="bg-transparent text-[13px] text-foreground [color-scheme:dark] outline-none" title="开始日期（不设=近 90 天）" />
            <span className="text-muted-foreground">至</span>
            <input type="date" value={trendTo} min={trendFrom || undefined} onChange={(e) => setTrendToPick(e.target.value)}
              className="bg-transparent text-[13px] text-foreground [color-scheme:dark] outline-none" title="结束日期（不设=至今）" />
          </div>
          <select value={regime} onChange={(e) => setRegime(e.target.value as MarketRegime)} title="行情状态只切换情绪温度的权重口径，不重新取数"
            className="rounded-lg border border-border/70 bg-overlay px-2 py-1.5 text-[13px] text-foreground">
            {REGIMES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <button onClick={() => void loadTrend(trendFrom, trendTo, { force: true }) } disabled={trendBusy}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-[13.5px] font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50">
            {trendBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 加载复盘数据统计
          </button>
        </div>
      </div>

      {trendError && <div className="rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[13.5px] text-red-300">{trendError}</div>}

      {/* 图表区（稳智同款：标题居中、两栏+通栏；动画/配色走 S0 底座） */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard
          centerTitle
          title="大盘成交额趋势"
          note={trend
            ? `沪深北 指数日成交额合计 · ${trend.range.from} ~ ${trend.range.to}（${trend.days.length} 个交易日）${trend.cached ? " · 本地快照" : ""}`
            : "未取数"}
          warnings={[...(trend?.cached ? [`本页数据来自本地快照回放（${trend.cached_at ? new Date(trend.cached_at).toLocaleString("zh-CN") : ""} 落档）：${trend.cache_note ?? "上游取数不完整"}`] : []), ...trend?.missing ?? [], ...(trend?.notes ?? [])]}
        >
          <EChart ariaLabel="大盘成交额趋势" height={300} state={turnoverState}
            emptyText="趋势数据未取到或合计没配齐过一天" option={turnoverOption(trendDaysDone, trend?.market_label ?? "两市")} />
        </ChartCard>

        <ChartCard
          centerTitle
          title="大盘情绪（5日线占比）趋势"
          right={
            <div className="flex shrink-0 gap-1">
              {([["local", "本地·三市"], ["sync", "同步·两市"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setBreadthSrc(k)}
                  title={k === "local" ? "用本库真实收盘价自算，票池沪+深+北交所" : "外部同步口径，票池只有沪+深"}
                  className={"rounded px-2 py-0.5 text-[11.5px] transition-colors " +
                    (breadthSrc === k ? "bg-sky-500/15 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
          }
          note={bNote}
          warnings={breadthSrc === "local" && !bLocalReady ? ["本地自算这条还没攒够两天，暂时画的是同步口径（不是我们的数）"] : []}
        >
          <EChart ariaLabel="大盘情绪（5日线占比）趋势" height={300} state={breadthState}
            emptyText="暂无数据（本地真实收盘价没攒够 5 天，同步口径也没到位）"
            option={breadthOption(bMain, bGroups, bDrawn === "sync" && bLocalReady ? bLocalWin : null)} />
        </ChartCard>

      </div>

      {/* 涨跌停板分布对比：稳智同款独立一整行 */}
      <div className="apple-fade-in">
        <ChartCard centerTitle title="涨跌停板分布对比" note={limitRows.length >= 2 ? `近10个交易日（同源切片）· ${limitRows.slice(-10)[0].date} ~ ${limitRows[limitRows.length - 1].date} · ${review?.source ?? ""}` : "当日真实快照 · 历史逐日正负柱与趋势线等数据同步后开放"} right={asOfDay ? <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11.5px] text-muted-foreground">{asOfDay}</span> : undefined}>
          <EChart ariaLabel="涨跌停板分布对比" height={300} state={limitState}
            emptyText="市场快照未取到" option={limitRows.length >= 2 ? limitHistoryOption(limitRows) : limitTodayOption(sent?.limit_up ?? 0, sent?.limit_down ?? 0)} />
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard centerTitle title="连板梯队结构" note={tierRows.length >= 2 ? `近10个交易日（同源切片）· ${tierRows.slice(-10)[0].date} ~ ${tierRows[tierRows.length - 1].date} · 3板/4板/5板+ 堆叠家数 + 最高板（右轴）` : `当日涨停梯队${tiers?.trade_date ? ` · ${tiers.trade_date}` : ""} · 历史堆叠柱与最高板线等数据同步后开放`}>
          <EChart ariaLabel="连板梯队结构" height={300} state={tierState}
            emptyText="涨停梯队未取到" option={tierRows.length >= 2 ? tierHistoryOption(tierRows) : tierOption(nFirst, nSecond, n3, n4, n5)} />
        </ChartCard>

        <ChartCard centerTitle title="指数涨跌幅" note={trend ? `区间累计涨跌幅（自窗口首日起累计 · 同源算法）· ${trend.range.from} ~ ${trend.range.to} · ${review?.indexChanges?.length ? "指数数据为离线快照种子" : trend.source}` : "未取数"}>
          <EChart ariaLabel="指数涨跌幅" height={300} state={idxState}
            emptyText="指数日K本次未取到" option={indexDailyOption(idxSeries)} />
        </ChartCard>
      </div>
    </div>
  );
}

// 半环温度计表盘（P11 几何；顶卡里用 compact 迷你版，完整版留给详情卡复用）
function TempGauge({ value, label, compact = false }: { value: number | null; label: string; compact?: boolean }) {
  const w = compact ? 96 : 200;
  const h = compact ? 60 : 118;
  const cx = w / 2, cy = compact ? 56 : 96, r = compact ? 38 : 74;
  const pt = (pct: number) => {
    const a = Math.PI * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
  };
  const arc = (from: number, to: number) => {
    const p1 = pt(from), p2 = pt(to);
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${r} ${r} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  };
  const bands = [
    { from: 0, to: 25, color: "#38bdf8" },
    { from: 25, to: 45, color: "#34d399" },
    { from: 45, to: 60, color: "#94a3b8" },
    { from: 60, to: 80, color: "#fb923c" },
    { from: 80, to: 100, color: "#f87171" },
  ];
  const active = bands.find((b) => (value ?? -1) >= b.from && (value ?? -1) < b.to)?.color ?? "#94a3b8";
  const needle = value === null ? null : pt(value);
  return (
    <div className="relative shrink-0" style={{ width: w }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`情绪温度 ${value ?? "无读数"}${label ? ` ${label}` : ""}`}>
        {bands.map((b) => (
          <path key={b.from} d={arc(b.from + 0.8, b.to - 0.8)} stroke={b.color}
            strokeOpacity={value === null ? 0.2 : b.color === active ? 0.95 : 0.3}
            strokeWidth={compact ? 6 : 10} fill="none" strokeLinecap="round" />
        ))}
        {needle && <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={active} strokeWidth={compact ? 2.5 : 3} strokeLinecap="round" />}
        {needle && <circle cx={cx} cy={cy} r={compact ? 3 : 4.5} fill={active} />}
      </svg>
    </div>
  );
}
