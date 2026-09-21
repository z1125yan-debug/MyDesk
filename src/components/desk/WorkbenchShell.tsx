"use client";
// 工作台壳：左窄栏（分组 + 列表）+ 右详情。样式随纯黑苹果风统一。
import { MessageSquareReply } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { NAV, isLegacyPage, workbenchOf, type Workbench } from "@/lib/desk/nav-core";
import type { PageKey } from "@/lib/desk/types";

function LeftRail(props: { wb: Workbench }) {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const nav = NAV[props.wb];
  return (
    <div className="flex w-60 shrink-0 flex-col gap-1.5 overflow-y-auto desk-scroll border-r border-border/60 px-3 py-4 xl:w-64">
      {nav.groups.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1 px-0.5">
          {nav.groups.map((g) => {
            const active = page === g.target;
            return (
              <button
                key={g.title}
                onClick={() => go(g.target)}
                className={
                  "rounded-full px-3 py-1.5 text-[12px] transition-colors " +
                  (active ? "bg-sky-400/15 text-sky-300 font-medium" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground")
                }
              >
                {g.title}
              </button>
            );
          })}
        </div>
      )}
      <div className="space-y-0.5">
        {nav.items.map((item: { key: PageKey; label: string }) => {
          const active = page === item.key;
          return (
            <button
              key={item.key}
              onClick={() => go(item.key)}
              className={
                "flex w-full items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-[13.5px] transition-colors " +
                (active ? "bg-white/[0.07] text-foreground font-medium" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground")
              }
            >
              {item.label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400" />}
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

  if (wb === "ai" && !isLegacyPage(page)) return <>{props.children}</>;

  if (isLegacyPage(page)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border/60 bg-sky-400/[0.07] px-5 py-2.5 text-[12.5px] text-sky-200/90">
          <MessageSquareReply size={14} aria-hidden />
          这类问题直接在对话里问就行，AI 会自动选好分析框架。
          <button onClick={() => go("copilot")} className="ml-auto rounded-full bg-sky-400/15 px-3 py-1 text-sky-200 hover:bg-sky-400/25">
            去对话
          </button>
        </div>
        <div className="min-h-0 flex-1">{props.children}</div>
      </div>
    );
  }

  if (wb === null) return <>{props.children}</>;
  return (
    <div className="flex h-full min-h-0">
      <LeftRail wb={wb} />
      <div className="min-w-0 flex-1 overflow-y-auto desk-scroll">{props.children}</div>
    </div>
  );
}
