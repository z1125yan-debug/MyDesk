"use client";
// S0 图表底座：全站唯一 ECharts 入口。
// 按需注册（Bar/Line/Gauge/Pie + Grid/Tooltip/Legend/DataZoom），动画与配色走 chart-tokens；
// loading/error/empty 三态覆盖层由 props 驱动；ResizeObserver 自适应；卸载 dispose；
// 只在 effect 里 init，SSR 安全。页面不得绕过本组件直接引 echarts。
import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, GaugeChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([BarChart, LineChart, GaugeChart, PieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

export type EChartState = "ok" | "loading" | "error" | "empty";

export default function EChart({
  option,
  height = 220,
  state = "ok",
  emptyText = "暂无数据",
  errorText = "图表数据加载失败",
  ariaLabel,
}: {
  option: EChartsCoreOption;
  /** 像素高度；卡片内默认 220 */
  height?: number;
  state?: EChartState;
  emptyText?: string;
  errorText?: string;
  ariaLabel?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const chart = echarts.init(box);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(box);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state !== "ok") return;
    // notMerge：数据窗口/序列整体替换，避免残留上一份 series；整树重建对动画无碍
    chartRef.current?.setOption(option, true);
  }, [option, state]);

  return (
    <div className="relative w-full" style={{ height }} role="img" aria-label={ariaLabel}>
      <div ref={boxRef} className="h-full w-full" />
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> 正在加载图表...
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-red-300">{errorText}</div>
      )}
      {state === "empty" && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[12.5px] leading-4 text-muted-foreground">{emptyText}</div>
      )}
    </div>
  );
}
