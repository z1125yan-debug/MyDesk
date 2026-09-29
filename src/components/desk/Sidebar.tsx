"use client";
// P15-R3a 侧栏：对齐稳智左侧菜单——一级平铺（大盘情绪·量化选股·行业·行情·自选·事件雷达·LLM分析·板块风险·AI分析），
// 血缘近的次级页挂在所属项下面展开，不再有两层「工作台」互点。
// 2026-09-29 用户拍板：「奇门遁甲」撤出一级菜单（#qimen 页与助手页奇门解盘模式保留），「板块风险」顶替其位。
// 设置/扩展收进底部齿轮（对方「订阅账号与点数」位）；工程状态文案（数据源/REAL_DATA_ONLY）不外露。
// P20 侧栏底部加「最近」会话历史区：从 useDesk.sessions 读最近 5 条（按 updatedAt 倒序），
// 只列有消息的会话，点击切到 AI 对话页并把 activeSessionId 切过去。
// P32 稳智对齐 P3 #17：品牌区加折叠按钮（稳智 nav-header 位置），点击后折叠侧栏。
import { useMemo, useState } from "react";
import { Bot, Brain, ChevronDown, ChevronUp, Flame, Gauge, History, LayoutGrid, ListVideo, MessageSquare, PanelLeftClose, Puzzle, Settings, ShieldAlert, Star, Wand2, X } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { MENU, SYSTEM_ITEMS, entryTarget, menuGroupOf, type MenuEntry } from "@/lib/desk/nav-core";
import { prefetchPage } from "@/lib/desk/api-cache";
import { titleFromMessages, type ChatSession } from "@/lib/desk/chat-core";

// 图标只活在这一层（React 侧）；nav-core 纯核不认 lucide。
const GROUP_ICONS: Record<string, React.ComponentType<{ size?: number | string; className?: string }>> = {
  market: Gauge,
  quant: Wand2,
  sectors: Flame,
  quotes: ListVideo,
  watch: Star,
  events: LayoutGrid,
  // P25：LLM 分析用 Brain 图标（深度分析），AI 对话用 Bot 图标（快速问答）
  assistant: Brain,
  ai: Bot,
  // 2026-09-29：奇门遁甲撤出一级菜单，「板块风险」（见顶预警）顶替其位——图标用 ShieldAlert（与风险监控页同线）
  sectortop: ShieldAlert,
  settings: Settings,
  extension: Puzzle,
};

export default function Sidebar() {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);
  const sessions = useDesk((s) => s.sessions);
  const activeSessionId = useDesk((s) => s.activeSessionId);
  const switchSession = useDesk((s) => s.switchSession);
  const dropSession = useDesk((s) => s.dropSession);
  const toggleSidebar = useDesk((s) => s.toggleSidebar); // P32：折叠按钮
  const [menuOpen, setMenuOpen] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const activeGroup = menuGroupOf(page)?.id ?? null;

  // P20：最近会话（按 updatedAt 倒序）。2026-09-29 用户拍板：只留最新 3 条（上限闸在 store 的
  // MAX_SESSIONS=3，被顶掉的会话直接删）；悬停条目出现 ❌，可手动删除该会话。
  // - 空消息会话（"新会话"骨架）跳过，避免一堆"新会话"占位
  // - 标题从消息里现算，和 titleFromMessages 一致（会话被重命名过就用重命名后的）
  const recent = useMemo(() => {
    return sessions
      .filter((s) => s.messages.length > 0)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .map((s) => ({
        id: s.id,
        title: s.title && s.title !== "新会话" ? s.title : titleFromMessages(s.messages),
        msgCount: s.messages.length,
      }));
  }, [sessions]);

  // 组展开态：所在组默认展开（用户看得到自己在哪条血缘线上）；手动折叠优先于默认。
  const isOpen = (e: MenuEntry) => (folded[e.id] !== undefined ? !folded[e.id] : activeGroup === e.id);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/70 bg-sidebar">
      {/* 品牌区 */}
      <div className="flex items-center justify-between px-5 pb-5 pt-6">
        <div className="flex items-center gap-3">
          {/* 2026-09-23 换图标：黑色立方体 Z（用户附图 imagef8c6a346），用户要求"完全占满"——
              立方体撑满 36x36 圆角方形，不留白色底衬、不留四周留白。 */}
          <div className="h-10 w-10 overflow-hidden rounded-[11px] shadow-lg shadow-black/25">
            <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden>
              <defs>
                <clipPath id="brand-clip">
                  <rect width="32" height="32" rx="7" ry="7"/>
                </clipPath>
              </defs>
              <g clipPath="url(#brand-clip)">
                <rect width="32" height="32" fill="#111418"/>
                <polygon points="0,8 16,2 32,8 16,14" fill="#2a2e35"/>
                <polygon points="32,8 32,24 16,30 16,14" fill="#1a1e24"/>
                <polygon points="0,8 16,14 16,30 0,24" fill="#16191e"/>
                <path d="M8,16 L24,16 L10,24 L24,24" fill="none" stroke="white" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round"/>
              </g>
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[17px] font-semibold tracking-tight">Kairo</div>
            <div className="text-[13px] text-muted-foreground">工作室</div>
          </div>
        </div>
        {/* P32 稳智对齐 P3 #17：折叠侧栏按钮（稳智 nav-header 位置） */}
        <button
          onClick={toggleSidebar}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground"
          title="折叠侧栏"
        >
          <PanelLeftClose size={16} />
        </button>
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
                onMouseEnter={() => prefetchPage(entryTarget(entry))}
                title={expandable ? "展开/收起该组的页面" : entry.label}
                className={
                  "group flex w-full items-center gap-3.5 rounded-[12px] px-4 py-3 text-[15.5px] transition-all duration-200 " +
                  (active
                    ? "bg-overlay-strong text-foreground font-medium shadow-inner"
                    : "text-muted-foreground hover:bg-overlay hover:text-foreground")
                }
              >
                <Icon size={19} className={active ? "text-sky-300" : "opacity-60 group-hover:opacity-90"} />
                {entry.label}
                {expandable && <ChevronDown size={15} className={"ml-auto opacity-50 transition-transform " + (open ? "" : "-rotate-90")} aria-hidden />}
                {active && !expandable && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-400 shadow shadow-sky-400/50" />}
              </button>
              {open && (
                <div className="mb-1 ml-[24px] mt-0.5 space-y-0.5 border-l border-border/60 pl-2.5">
                  {entry.children!.map((c) => {
                    const on = page === c.key;
                    return (
                      <button
                        key={c.key}
                        onClick={() => go(c.key)}
                        onMouseEnter={() => prefetchPage(c.key)}
                        className={
                          "flex w-full items-center rounded-lg px-3.5 py-2 text-left text-[14px] transition-colors " +
                          (on ? "bg-overlay-strong text-foreground font-medium" : "text-muted-foreground hover:bg-overlay hover:text-foreground")
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

      {/* P20 最近会话（对齐稳智左栏底部「最近」区） */}
      {recent.length > 0 && (
        <div className="border-t border-border/60 px-3 pb-2 pt-3">
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <History size={12} className="opacity-60" aria-hidden />
            <span className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground">最近</span>
            <span className="ml-auto text-[12px] text-muted-foreground/70">{recent.length}</span>
          </div>
          <ul className="space-y-0.5">
            {recent.map((r) => {
              const active = page === "copilot" && activeSessionId === r.id;
              return (
                <li key={r.id} className="group relative flex items-center">
                  <button
                    onClick={() => {
                      switchSession(r.id);
                      go("copilot");
                    }}
                    title={r.title}
                    className={
                      "flex w-full items-start gap-2 rounded-lg py-2 pl-3 pr-8 text-left text-[14px] transition-colors " +
                      (active
                        ? "bg-overlay-strong text-foreground"
                        : "text-muted-foreground hover:bg-overlay hover:text-foreground")
                    }
                  >
                    <MessageSquare size={12} className="mt-0.5 shrink-0 opacity-60" aria-hidden />
                    <span className="flex-1 truncate leading-tight">{r.title}</span>
                    {active && <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-sky-400" />}
                  </button>
                  {/* 悬停出现的 ❌：删这条会话（store 的 dropSession，删的是真会话） */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      dropSession(r.id);
                    }}
                    title="删除该会话"
                    aria-label={`删除会话：${r.title}`}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-overlay hover:text-red-400 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

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
                    "flex w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-[15px] transition-colors " +
                    (page === it.key ? "bg-overlay-strong text-foreground" : "text-muted-foreground hover:bg-overlay-strong hover:text-foreground")
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
          className="flex items-center gap-2.5 text-[14px] text-muted-foreground transition-colors hover:text-foreground"
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
