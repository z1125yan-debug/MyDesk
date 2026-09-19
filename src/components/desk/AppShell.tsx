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
import RadarPage from "./pages/RadarPage";
import EventsPage from "./pages/EventsPage";
import ResearchPage from "./pages/ResearchPage";
import AgentPage from "./pages/AgentPage";
import { useDesk } from "@/lib/desk/store";
import { PAGE_TITLES, type PageKey } from "@/lib/desk/types";

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
        if (fromHash !== cur) go(fromHash);
      } else if (window.location.hash !== `#/${cur}`) {
        window.location.hash = `#/${cur}`;
      }
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [go]);

  useEffect(() => {
    window.location.hash = `#/${page}`;
    document.title = `${PAGE_TITLES[page]} · MyDesk`;
  }, [page]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {!collapsed && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto desk-scroll">
          {page === "aihome" && <AiHomePage />}
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
          {page === "quant" && <QuantPage />}
          {page === "factorlab" && <FactorLabPage />}
          {page === "risk" && <RiskPage />}
          {page === "problab" && <ProbabilityPage />}
          {page === "themes" && <ThemesPage />}
          {page === "radar" && <RadarPage />}
          {page === "events" && <EventsPage />}
          {page === "research" && <ResearchPage />}
          {page === "agent" && <AgentPage />}
          {page === "extension" && <ExtensionPage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
