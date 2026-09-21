"use client";
// P7-⑪ 任务1：最左侧固定窄边栏只放大模块按钮（AI 决策 / 量化工具 / 行情中心），
// 设置与扩展收进底部状态条的下拉菜单，不再占主边栏位置。
// 导航数据全部来自 nav-core（纯核），这里只画；旧菜单项的去留口径写在 nav-core 注释里。
import { useState } from "react";
import { Bot, FlaskConical, Gauge, Settings, Puzzle, ChevronUp } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { NAV, WORKBENCH_ORDER, workbenchOf, type Workbench } from "@/lib/desk/nav-core";
import type { PageKey } from "@/lib/desk/types";

const WB_ICONS: Record<Workbench, React.ComponentType<{ size?: number | string; className?: string }>> = {
  ai: Bot,
  quant: FlaskConical,
  market: Gauge,
  system: Settings,
};

export default function Sidebar() {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeWb = workbenchOf(page);

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

      <nav className="flex-1 space-y-1.5 overflow-y-auto desk-scroll px-2.5 pb-2 pt-2">
        {WORKBENCH_ORDER.map((wb) => {
          const Icon = WB_ICONS[wb.key];
          const active = activeWb === wb.key;
          return (
            <button
              key={wb.key}
              onClick={() => go(wb.key === "ai" ? "copilot" : NAV[wb.key].items[0].key)}
              className={
                "flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-[14px] transition-colors " +
                (active
                  ? "bg-sky-500/10 text-sky-300 font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              <Icon size={17} className={active ? "text-sky-400" : "opacity-70"} />
              {wb.label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400" />}
            </button>
          );
        })}
      </nav>

      {/* 底部状态条：点齿轮弹出 设置/扩展 —— 系统页不再占主导航位 */}
      <div className="relative border-t border-border px-4 py-3 text-[11px] leading-5 text-muted-foreground">
        {menuOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            {NAV.system.items.map((it: { key: PageKey; label: string }) => (
              <button
                key={it.key}
                onClick={() => { go(it.key); setMenuOpen(false); }}
                className={
                  "flex w-full items-center gap-2 px-3 py-2 text-[12.5px] transition-colors " +
                  (page === it.key ? "bg-sky-500/10 text-sky-300" : "hover:bg-accent")
                }
              >
                {it.key === "settings" ? <Settings size={14} /> : <Puzzle size={14} />}
                {it.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          本地运行 · REAL_DATA_ONLY
        </div>
        <div className="mt-0.5">eltdx / 腾讯 / 东财 · 本机直连</div>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="打开设置与扩展菜单"
          className="absolute right-3 top-2.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {menuOpen ? <ChevronUp size={15} /> : <Settings size={15} />}
        </button>
      </div>
    </aside>
  );
}
