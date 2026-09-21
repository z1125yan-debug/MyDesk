"use client";
// P7-⑪ 任务1：大模块内部的「左窄栏列表 + 右宽栏详情」两栏壳。
// 左栏只画 nav-core 登记的分组与列表；右栏原样渲染既有页面组件（业务逻辑零改动）。
// AI 决策工作台不走这里——它的左栏（模式切换 + 会话历史）长在 AssistantPage 里，重复画会两份历史。
// 已并入对话的旧页面（#/agent 这类兼容路由）：不画左栏，顶部挂一条横幅指回对话，而不是让页面凭空出现。
import { MessageSquareReply } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { NAV, isLegacyPage, workbenchOf, type Workbench } from "@/lib/desk/nav-core";
import type { PageKey } from "@/lib/desk/types";

function LeftRail(props: { wb: Workbench }) {
  // ai 的左栏在 AssistantPage 里，这条分支理论上到不了；真到了也只画一个 copilot 项，不会崩
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const nav = NAV[props.wb];
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto desk-scroll border-r border-border bg-card/60 p-2.5 xl:w-80">
      {nav.groups.length > 0 && (
        <div className="flex flex-wrap gap-1 px-0.5 pt-0.5">
          {nav.groups.map((g) => {
            const active = page === g.target;
            return (
              <button
                key={g.title}
                onClick={() => go(g.target)}
                className={
                  "rounded-md px-2 py-1 text-[11.5px] transition-colors " +
                  (active ? "bg-sky-500/15 text-sky-300 font-medium" : "bg-accent/60 text-muted-foreground hover:text-foreground")
                }
              >
                {g.title}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-1 space-y-0.5">
        {nav.items.map((item: { key: PageKey; label: string }) => {
          const active = page === item.key;
          return (
            <button
              key={item.key}
              onClick={() => go(item.key)}
              className={
                "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors " +
                (active ? "bg-sky-500/10 text-sky-300 font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              {item.label}
              {active && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function WorkbenchShell(props: { children: React.ReactNode }) {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const wb = workbenchOf(page);

  // AI 决策：copilot 本身（AssistantPage 三栏已含左栏）直接铺满
  if (wb === "ai" && !isLegacyPage(page)) return <>{props.children}</>;

  // 兼容路由进来的「已并入」页面：横幅指回，右栏照常渲染原组件
  if (isLegacyPage(page)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[12px] text-amber-300">
          <MessageSquareReply size={13} aria-hidden />
          此页已并入 AI 决策对话（旧路由保留直达）；同类问题在对话里问即可，AI 会自动选分析框架。
          <button onClick={() => go("copilot")} className="ml-auto rounded-md border border-amber-500/40 px-2 py-0.5 hover:bg-amber-500/15">
            回到对话
          </button>
        </div>
        <div className="min-h-0 flex-1">{props.children}</div>
      </div>
    );
  }

  if (wb === null) return <>{props.children}</>; // 未登记的键（理论到不了）：原样渲染，不做半个新壳
  return (
    <div className="flex h-full min-h-0">
      <LeftRail wb={wb} />
      <div className="min-w-0 flex-1 overflow-y-auto desk-scroll">{props.children}</div>
    </div>
  );
}
