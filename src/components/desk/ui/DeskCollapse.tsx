"use client";
// 工作台统一折叠面板：任务书要求右栏技术细节用「组件化折叠面板」而不是原生 <details>，
// 但项目里实际可用的是 radix Collapsible 壳（src/components/ui/collapsible.tsx）——
// 用户已确认按它落地，不为 Element Plus 新增依赖。样式走全局圆角卡片口径。
//
// P7-⑫ 铺开时的两条口径：
// - 字号「替换不叠加」：正文/触发器的 text-[..] 默认值由调用方整段顶替（?? 拼接），
//   不做两个尺寸 class 并存——Tailwind 谁赢取决于样式表顺序，不赌。
// - tone="amber" 给警示类面板固定的琥珀配色，同理不靠 className 覆盖 border/bg。
// open/onOpenChange 透传给 radix，供流式等数据驱动的受控场景（StepTimeline）。
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function DeskCollapse(props: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  defaultOpen?: boolean;
  /** 受控展开（与 onOpenChange 成对出现；不传则 radix 自己管） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 根容器：警示面板用 tone，剩下的边距等附加 class 走 className */
  tone?: "neutral" | "amber";
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const root =
    (props.tone === "amber"
      ? "rounded-xl border border-amber-500/25 bg-amber-500/5"
      : "rounded-xl border border-border bg-card") +
    " " + (props.className ?? "");
  const trigger =
    "group flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors " +
    (props.triggerClassName ?? "text-[12.5px] font-medium text-muted-foreground hover:text-foreground");
  const content =
    "border-t border-border/60 px-4 py-3 " +
    (props.contentClassName ?? "text-[12.5px] leading-relaxed text-muted-foreground");
  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange} defaultOpen={props.defaultOpen} className={root}>
      <CollapsibleTrigger className={trigger}>
        {/* data-state 挂在 trigger 上，所以箭头旋转要走 group-data-* */}
        <ChevronDown
          size={14}
          className="shrink-0 transition-transform group-data-[state=closed]:rotate-[-90deg]"
          aria-hidden
        />
        <span className="min-w-0 flex-1">{props.title}</span>
        {props.hint && <span className="ml-auto shrink-0 text-[11px] opacity-70">{props.hint}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className={content}>
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
