"use client";
// 侧栏：纯黑高级风，只保留用户关心的三大工作台入口；
// 设置/扩展收进底部齿轮，工程状态文案（数据源/REAL_DATA_ONLY）不再外露。
import { useState } from "react";
import { Bot, FlaskConical, Gauge, Settings, Puzzle, ChevronUp, Compass } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { NAV, WORKBENCH_ORDER, workbenchOf, type Workbench } from "@/lib/desk/nav-core";
import type { PageKey } from "@/lib/desk/types";

const WB_ICONS: Record<Workbench, React.ComponentType<{ size?: number | string; className?: string }>> = {
  ai: Bot,
  quant: FlaskConical,
  market: Gauge,
  qimen: Compass,
  // system 不在 WORKBENCH_ORDER（收在底部齿轮），但 Record 键型要求登记齐全——
  // 少这一个图标就是 2026-09-22 走查时 tsc 唯一的红点。
  system: Settings,
};

export default function Sidebar() {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const newSession = useDesk((s) => s.newSession);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeWb = workbenchOf(page);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border/70 bg-sidebar">
      {/* 品牌区 */}
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/25">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="5" y="9" width="4" height="9" rx="1" fill="white" opacity="0.9" />
            <line x1="7" y1="5" x2="7" y2="20" stroke="white" strokeWidth="1.6" />
            <rect x="14" y="6" width="4" height="8" rx="1" fill="white" opacity="0.7" />
            <line x1="16" y1="3" x2="16" y2="17" stroke="white" strokeWidth="1.6" />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Kairo</div>
          <div className="text-[11px] text-muted-foreground">AI 选股 · 看懂市场</div>
        </div>
      </div>

      {/* 三大工作台 */}
      <nav className="flex-1 space-y-1 overflow-y-auto desk-scroll px-3 pb-2 pt-1">
        {WORKBENCH_ORDER.map((wb) => {
          const Icon = WB_ICONS[wb.key];
          const active = activeWb === wb.key;
          return (
            <button
              key={wb.key}
              onClick={() => {
                // 点「AI 决策」= 回到 Hello 首页：先清出一个全新空会话，再落到对话页
                if (wb.key === "ai") { newSession(); go("copilot"); }
                else { go(NAV[wb.key].items[0].key); }
              }}
              className={
                "group flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14px] transition-all duration-200 " +
                (active
                  ? "bg-white/[0.07] text-foreground font-medium shadow-inner"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground")
              }
            >
              <Icon size={17} className={active ? "text-sky-300" : "opacity-60 group-hover:opacity-90"} />
              {wb.label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400 shadow shadow-sky-400/50" />}
            </button>
          );
        })}
      </nav>

      {/* 底部：仅一个干净的在线点 + 设置入口 */}
      <div className="relative border-t border-border/60 px-5 py-4">
        {menuOpen && (
          <div className="apple-card absolute bottom-full left-3 right-3 mb-2 p-1.5 shadow-2xl">
            {NAV.system.items.map((it: { key: PageKey; label: string }) => (
              <button
                key={it.key}
                onClick={() => { go(it.key); setMenuOpen(false); }}
                className={
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors " +
                  (page === it.key ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground")
                }
              >
                {it.key === "settings" ? <Settings size={14} /> : <Puzzle size={14} />}
                {it.label}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-2.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="flex h-2 w-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow shadow-emerald-400/60" />
          </span>
          已连接实时行情
          {menuOpen ? <ChevronUp size={14} className="ml-auto" /> : <Settings size={14} className="ml-auto opacity-60" />}
        </button>
      </div>
    </aside>
  );
}
