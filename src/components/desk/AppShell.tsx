"use client";
import { useEffect } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import OverviewPage from "./pages/OverviewPage";
import BoardPage from "./pages/BoardPage";
import AnalysisPage from "./pages/AnalysisPage";
import WatchlistPage from "./pages/WatchlistPage";
import HistoryPage from "./pages/HistoryPage";
import CopilotPage from "./pages/AssistantPage";
import QimenPanel from "./QimenPanel";
import QuantPage from "./QuantPage";
import ExtensionPage from "./pages/ExtensionPage";
import SettingsPage from "./pages/SettingsPage";
import AiHomePage from "./pages/AiHomePage";
import AiScanPage from "./pages/AiScanPage";
import PoolPage from "./pages/PoolPage";
import ScreenerPage from "./pages/ScreenerPage";
import SectorsPage from "./pages/SectorsPage";
import FactorLabPage from "./pages/FactorLabPage";
import ProfilePage from "./pages/ProfilePage";
import MarketPage from "./pages/MarketPage";
import AllStocksPage from "./pages/AllStocksPage";
import RiskPage from "./pages/RiskPage";
import ProbabilityPage from "./pages/ProbabilityPage";
import ThemesPage from "./pages/ThemesPage";
import ThemeOverviewPage from "./pages/ThemeOverviewPage";
import RadarPage from "./pages/RadarPage";
import EventsPage from "./pages/EventsPage";
import ResearchPage from "./pages/ResearchPage";
import AgentPage from "./pages/AgentPage";
import { useDesk } from "@/lib/desk/store";
import { PAGE_TITLES, type PageKey } from "@/lib/desk/types";
import { resolveRoute } from "@/lib/desk/nav-core";
import WorkbenchShell from "./WorkbenchShell";

export default function AppShell() {
  const page = useDesk((s) => s.page);
  const collapsed = useDesk((s) => s.sidebarCollapsed);
  const go = useDesk((s) => s.go);

  // hash 路由：①刷新后停留当前页 ②监听 hashchange——浏览器前进/后退或手改 #/xxx 时同步页面，
  // 避免出现「URL 已变、渲染未变」的不一致；无效 hash 回写为当前页，保证 URL 与实际页面一致。
  useEffect(() => {
    const syncFromHash = () => {
      const fromHash = window.location.hash.replace(/^#\/?/, "") as PageKey;
      const cur = useDesk.getState().page;
      if (fromHash && PAGE_TITLES[fromHash]) {
        // R3c：别名 hash（#/aiscan）先回写成收口目标再放行——go 收口后状态常已是 quant，
        // 若只是「URL 变了、page 没变」，下面的自愈 effect 因依赖未变不会重跑，地址栏会卡在别名上。
        const target = resolveRoute(fromHash);
        if (target !== fromHash) { window.location.hash = `#/${target}`; return; }
        if (target !== cur) go(target);
      } else if (window.location.hash !== `#/${cur}`) {
        window.location.hash = `#/${cur}`;
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [go]);

  useEffect(() => {
    // R3c 双入口合并：存档里可能还躺着旧页 aiscan（persist 恢复不过 go()）——状态自愈到统一入口，
    // URL/标题都按收口后的目标写，避免「#/aiscan 还挂在地址栏但内容已是门户」的口径分裂。
    const target = resolveRoute(page);
    if (target !== page) { go(target); return; }
    window.location.hash = `#/${page}`;
    document.title = `${PAGE_TITLES[page]} · MyDesk`;
  }, [page, go]);

  useEffect(() => {
    // R13（用户拍板）：每次冷启动清一次「整 7 天没动过」的旧对话——开着页面不盯时钟，
    // 当天还在用的会话 updatedAt 自然新，不会被误伤；判定口径全在 chat-core.pruneStaleSessions。
    useDesk.getState().pruneStaleChats();
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {!collapsed && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto desk-scroll">
          {/* P7-⑪ 任务1：外面包一层工作台壳（左窄栏列表 + 右详情）。
              下面 25 个分支一个不删——旧 hash 路由全部保留做兼容跳转，右栏渲染的就是原页面组件本身。 */}
          <WorkbenchShell>
            {page === "aihome" && <AiHomePage />}
            {/* R3c 合并后 go("aiscan") 已在 store 收口到 quant 门户，此分支是「分支一个不删」的兼容兜底：
                persist 恢复出 aiscan 的瞬间也会先渲染这里，effect 随即自愈改判——不留双窗口的第二份入口。 */}
            {page === "aiscan" && <AiScanPage />}
            {page === "pool" && <PoolPage />}
            {page === "screener" && <ScreenerPage />}
            {page === "profile" && <ProfilePage />}
            {page === "market" && <MarketPage />}
            {page === "sectors" && <SectorsPage />}
            {page === "allstocks" && <AllStocksPage />}
            {page === "dashboard" && <OverviewPage />}
            {page === "board" && <BoardPage />}
            {page === "analysis" && <AnalysisPage />}
            {page === "tracker" && <WatchlistPage />}
            {page === "history" && <HistoryPage />}
            {page === "copilot" && <CopilotPage />}
            {page === "qimen" && <QimenPanel />}
            {page === "quant" && <QuantPage />}
            {page === "factorlab" && <FactorLabPage />}
            {page === "risk" && <RiskPage />}
            {page === "problab" && <ProbabilityPage />}
            {page === "themes" && <ThemesPage />}
            {page === "themeoverview" && <ThemeOverviewPage />}
            {page === "radar" && <RadarPage />}
            {page === "events" && <EventsPage />}
            {page === "research" && <ResearchPage />}
            {page === "agent" && <AgentPage />}
            {page === "extension" && <ExtensionPage />}
            {page === "settings" && <SettingsPage />}
          </WorkbenchShell>
        </main>
      </div>
    </div>
  );
}
