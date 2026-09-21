"use client";
// 工作台统一折叠面板：任务书要求右栏技术细节用「组件化折叠面板」而不是原生 <details>，
// 但项目里实际可用的是 radix Collapsible 壳（src/components/ui/collapsible.tsx）——
// 用户已确认按它落地，不为 Element Plus 新增依赖。样式走全局圆角卡片口径。
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function DeskCollapse(props: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={props.defaultOpen} className="rounded-xl border border-border bg-card">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        {/* data-state 挂在 trigger 上，所以箭头旋转要走 group-data-* */}
        <ChevronDown
          size={14}
          className="shrink-0 transition-transform group-data-[state=closed]:rotate-[-90deg]"
          aria-hidden
        />
        <span>{props.title}</span>
        {props.hint && <span className="ml-auto text-[11px] opacity-70">{props.hint}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/60 px-4 py-3 text-[12.5px] leading-relaxed">
        {props.children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 右栏统一圆角卡片壳：新壳层用它包页面级内容，页面内部组件不动 */
export function DeskCard(props: { className?: string; children: React.ReactNode }) {
  return (
    <div className={"rounded-xl border border-border bg-card " + (props.className ?? "")}>
      {props.children}
    </div>
  );
}
