"use client";
import {
  LayoutDashboard, BarChart3, LineChart, Target, History,
  Bot, FlaskConical, Puzzle, Settings,
} from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import type { PageKey } from "@/lib/desk/types";

const NAV: { key: PageKey; label: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }[] = [
  { key: "dashboard", label: "总览", icon: LayoutDashboard },
  { key: "board", label: "数据看板", icon: BarChart3 },
  { key: "analysis", label: "AI 分析", icon: LineChart },
  { key: "tracker", label: "追踪", icon: Target },
  { key: "history", label: "历史", icon: History },
  { key: "copilot", label: "智能助手", icon: Bot },
  { key: "quant", label: "量化研究", icon: FlaskConical },
  { key: "extension", label: "扩展", icon: Puzzle },
  { key: "settings", label: "设置", icon: Settings },
];

export default function Sidebar() {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 shadow-md shadow-sky-500/20">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="5" y="9" width="4" height="9" rx="1" fill="white" opacity="0.9" />
            <line x1="7" y1="5" x2="7" y2="20" stroke="white" strokeWidth="1.6" />
            <rect x="14" y="6" width="4" height="8" rx="1" fill="white" opacity="0.7" />
            <line x1="16" y1="3" x2="16" y2="17" stroke="white" strokeWidth="1.6" />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-wide">MyDesk</div>
          <div className="text-[11px] text-muted-foreground">个人行情工作台</div>
        </div>
      </div>

      <nav className="mt-1 flex-1 space-y-0.5 px-2.5">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = page === item.key;
          return (
            <button
              key={item.key}
              onClick={() => go(item.key)}
              className={
                "group flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] transition-colors " +
                (active
                  ? "bg-sky-500/10 text-sky-300 font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              <Icon size={17} className={active ? "text-sky-400" : "opacity-70"} />
              {item.label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400" />}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-border px-4 py-3.5 text-[11px] leading-5 text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          本地运行 · 无账号无订阅
        </div>
        <div className="mt-0.5">A股实时行情 · 本机直连</div>
      </div>
    </aside>
  );
}
