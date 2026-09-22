"use client";
// P15-R3a 侧栏：对齐稳智左侧菜单——一级平铺（大盘情绪·量化选股·行业板块·行情·自选·AI 对话·奇门遁甲），
// 血缘近的次级页挂在所属项下面展开，不再有两层「工作台」互点。
// 设置/扩展收进底部齿轮（对方「订阅账号与点数」位）；工程状态文案（数据源/REAL_DATA_ONLY）不外露。
import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, Compass, Flame, Gauge, LayoutGrid, ListVideo, Puzzle, Settings, Star, Wand2 } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { MENU, SYSTEM_ITEMS, entryTarget, menuGroupOf, type MenuEntry } from "@/lib/desk/nav-core";

// 图标只活在这一层（React 侧）；nav-core 纯核不认 lucide。
const GROUP_ICONS: Record<string, React.ComponentType<{ size?: number | string; className?: string }>> = {
  market: Gauge,
  quant: Wand2,
  sectors: Flame,
  quotes: ListVideo,
  watch: Star,
  ai: Bot,
  qimen: Compass,
  settings: Settings,
  extension: Puzzle,
};

export default function Sidebar() {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const [menuOpen, setMenuOpen] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const activeGroup = menuGroupOf(page)?.id ?? null;

  // 组展开态：所在组默认展开（用户看得到自己在哪条血缘线上）；手动折叠优先于默认。
  const isOpen = (e: MenuEntry) => (folded[e.id] !== undefined ? !folded[e.id] : activeGroup === e.id);

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

      {/* 一级平铺菜单（顺序即 nav-core MENU 顺序 = 稳智左栏顺序） */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto desk-scroll px-3 pb-2 pt-1" aria-label="主菜单">
        {MENU.map((entry) => {
          const Icon = GROUP_ICONS[entry.id] ?? LayoutGrid;
          const active = activeGroup === entry.id;
          const expandable = (entry.children?.length ?? 0) > 0;
          const open = expandable && isOpen(entry);
          return (
            <div key={entry.id}>
              <button
                onClick={() => {
                  go(entryTarget(entry));
                  if (expandable) setFolded((f) => ({ ...f, [entry.id]: open }));
                }}
                title={expandable ? "展开/收起该组的页面" : entry.label}
                className={
                  "group flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14px] transition-all duration-200 " +
                  (active
                    ? "bg-white/[0.07] text-foreground font-medium shadow-inner"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground")
                }
              >
                <Icon size={17} className={active ? "text-sky-300" : "opacity-60 group-hover:opacity-90"} />
                {entry.label}
                {expandable && <ChevronDown size={13} className={"ml-auto opacity-50 transition-transform " + (open ? "" : "-rotate-90")} aria-hidden />}
                {active && !expandable && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400 shadow shadow-sky-400/50" />}
              </button>
              {open && (
                <div className="mb-1 ml-[22px] mt-0.5 space-y-0.5 border-l border-border/60 pl-2">
                  {entry.children!.map((c) => {
                    const on = page === c.key;
                    return (
                      <button
                        key={c.key}
                        onClick={() => go(c.key)}
                        className={
                          "flex w-full items-center rounded-lg px-3 py-1.5 text-left text-[12.5px] transition-colors " +
                          (on ? "bg-white/[0.06] text-foreground font-medium" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground")
                        }
                      >
                        {c.label}
                        {on && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* 底部：在线状态 + 系统入口（对方「账号与点数」位） */}
      <div className="relative border-t border-border/60 px-5 py-4">
        {menuOpen && (
          <div className="apple-card absolute bottom-full left-3 right-3 mb-2 p-1.5 shadow-2xl">
            {SYSTEM_ITEMS.map((it) => {
              const ItemIcon = GROUP_ICONS[it.key] ?? Settings;
              return (
                <button
                  key={it.key}
                  onClick={() => { go(it.key); setMenuOpen(false); }}
                  className={
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors " +
                    (page === it.key ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground")
                  }
                >
                  <ItemIcon size={14} />
                  {it.label}
                </button>
              );
            })}
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

// 旧 hash 页（已并入对话那 5 个）不进菜单——它们由 WorkbenchShell 挂横幅指回，这里一个都不画。
