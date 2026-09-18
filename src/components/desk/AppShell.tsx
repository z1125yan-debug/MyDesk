"use client";
import { useEffect } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import OverviewPage from "./pages/OverviewPage";
import BoardPage from "./pages/BoardPage";
import AnalysisPage from "./pages/AnalysisPage";
import TrackerPage from "./pages/TrackerPage";
import HistoryPage from "./pages/HistoryPage";
import CopilotPage from "./pages/AssistantPage";
import ExtensionPage from "./pages/ExtensionPage";
import SettingsPage from "./pages/SettingsPage";
import { useDesk } from "@/lib/desk/store";
import { PAGE_TITLES, type PageKey } from "@/lib/desk/types";

export default function AppShell() {
  const page = useDesk((s) => s.page);
  const collapsed = useDesk((s) => s.sidebarCollapsed);
  const go = useDesk((s) => s.go);

  // hash 路由：刷新后停留当前页
  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#\/?/, "") as PageKey;
    if (fromHash && PAGE_TITLES[fromHash] && fromHash !== page) go(fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          {page === "dashboard" && <OverviewPage />}
          {page === "board" && <BoardPage />}
          {page === "analysis" && <AnalysisPage />}
          {page === "tracker" && <TrackerPage />}
          {page === "history" && <HistoryPage />}
          {page === "copilot" && <CopilotPage />}
          {page === "extension" && <ExtensionPage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
