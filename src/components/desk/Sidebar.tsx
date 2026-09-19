"use client";
import {
  Sparkles, Radar, Filter, UserSearch, Gauge, ListOrdered, Target,
  LayoutDashboard, BarChart3, LineChart, History, Bot,
  FlaskConical, Puzzle, Settings, Snowflake, LayoutGrid, Microscope,
  ShieldAlert, Compass, Globe2, Percent, ScanSearch,
} from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import type { PageKey } from "@/lib/desk/types";

const GROUPS: { title: string; items: { key: PageKey; label: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }[] }[] = [
  {
    title: "实时选股",
    items: [
      { key: "aihome", label: "AI 首页", icon: Sparkles },
      { key: "aiscan", label: "AI 实时选股", icon: Radar },
      { key: "pool", label: "候选池", icon: Snowflake },
      { key: "screener", label: "因子选股器", icon: Filter },
    ],
  },
  {
    title: "市场",
    items: [
      { key: "market", label: "大盘情绪", icon: Gauge },
      { key: "sectors", label: "行业板块", icon: LayoutGrid },
      { key: "themes", label: "主线发现", icon: Compass },
      { key: "risk", label: "风险监控", icon: ShieldAlert },
      { key: "allstocks", label: "全A列表", icon: ListOrdered },
      { key: "profile", label: "个股画像", icon: UserSearch },
      { key: "tracker", label: "自选股", icon: Target },
    ],
  },
  {
    title: "行情工具",
    items: [
      { key: "board", label: "数据看板", icon: BarChart3 },
      { key: "analysis", label: "AI 分析", icon: LineChart },
      { key: "copilot", label: "智能助手", icon: Bot },
      { key: "history", label: "历史", icon: History },
      { key: "dashboard", label: "总览", icon: LayoutDashboard },
    ],
  },
  {
    title: "研究后台",
    items: [
      { key: "quant", label: "量化研究", icon: FlaskConical },
      { key: "factorlab", label: "因子测试台", icon: Microscope },
      { key: "problab", label: "历史概率", icon: Percent },
      { key: "radar", label: "主动发现", icon: ScanSearch },
      { key: "events", label: "事件雷达", icon: Globe2 },
    ],
  },
  {
    title: "系统",
    items: [
      { key: "extension", label: "扩展", icon: Puzzle },
      { key: "settings", label: "设置", icon: Settings },
    ],
  },
];

export default function Sidebar() {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-3">
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
          <div className="text-[11px] text-muted-foreground">AI 选股 · 量化研究终端</div>
        </div>
      </div>

      <nav className="flex-1 space-y-3 overflow-y-auto desk-scroll px-2.5 pb-2">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="px-3 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">{g.title}</div>
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const Icon = item.icon;
                const active = page === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => go(item.key)}
                    className={
                      "group flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-[13.5px] transition-colors " +
                      (active
                        ? "bg-sky-500/10 text-sky-300 font-medium"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground")
                    }
                  >
                    <Icon size={16} className={active ? "text-sky-400" : "opacity-70"} />
                    {item.label}
                    {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-4 py-3.5 text-[11px] leading-5 text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          本地运行 · REAL_DATA_ONLY
        </div>
        <div className="mt-0.5">eltdx / 腾讯 / 东财 · 本机直连</div>
      </div>
    </aside>
  );
}
