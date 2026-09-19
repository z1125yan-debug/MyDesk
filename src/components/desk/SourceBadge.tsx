"use client";
// 实时状态徽章（需求文档 三十八）：LIVE / HISTORICAL / DEMO / OFFLINE + 数据源与时间
export function SourceBadge({ status, source, time }: { status: string; source?: string; time?: string }) {
  const live = /LIVE/i.test(status);
  const degraded = /DEGRADED|缺失|暂无/i.test(status);
  const demo = /DEMO/i.test(status);
  const color = degraded
    ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
    : demo
      ? "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30"
      : live
        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
        : "bg-sky-500/10 text-sky-400 border-sky-500/30";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${degraded ? "bg-amber-400" : demo ? "bg-fuchsia-400" : live ? "animate-pulse bg-emerald-400" : "bg-sky-400"}`} />
      {status}
      {source && <span className="text-muted-foreground">· {source}</span>}
      {time && <span className="text-muted-foreground">· {time}</span>}
    </span>
  );
}

// A股约定：红涨绿跌
export function PctText({ value, suffix = "%", digits = 2, className = "" }: { value: number | null | undefined; suffix?: string; digits?: number; className?: string }) {
  if (value === null || value === undefined || !isFinite(value)) {
    return <span className={`text-muted-foreground ${className}`}>—</span>;
  }
  const up = value > 0, down = value < 0;
  return (
    <span className={`${up ? "text-red-500" : down ? "text-emerald-500" : "text-muted-foreground"} ${className}`}>
      {up ? "+" : ""}{value.toFixed(digits)}{suffix}
    </span>
  );
}

export function NumText({ value, digits = 2, suffix = "", className = "" }: { value: number | null | undefined; digits?: number; suffix?: string; className?: string }) {
  if (value === null || value === undefined || !isFinite(value)) return <span className={`text-muted-foreground ${className}`}>—</span>;
  return <span className={className}>{value.toFixed(digits)}{suffix}</span>;
}
