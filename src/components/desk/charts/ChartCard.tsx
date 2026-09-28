// S0 图表卡容器：标题+右槽+图+脚注+警告行。全站图表统一这个壳（对齐稳智卡片版式），
// 数据源脚注/missing 警告保持本站 SourceBadge 纪律（稳智没有，是本站强项）。
import type { ReactNode } from "react";

export default function ChartCard({
  title,
  right,
  note,
  warnings,
  centerTitle = false,
  children,
}: {
  title: string;
  right?: ReactNode;
  note?: ReactNode;
  warnings?: string[];
  /** 稳智同款居中标题（默认左对齐） */
  centerTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-overlay p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
        <div className={centerTitle ? "flex-1 text-center text-[14.5px] font-semibold" : "text-[13.5px] font-medium"}>{title}</div>
        {right}
      </div>
      {children}
      {note && <div className="mt-1 text-[11.5px] text-muted-foreground/70">{note}</div>}
      {warnings?.map((w, i) => (
        <div key={i} className="text-[11.5px] text-amber-200/70">
          · {w}
        </div>
      ))}
    </div>
  );
}
