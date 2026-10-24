"use client";
// 点开即有内容：导入即给同源 GET /api/* 装上 SWR 缓存（必须在页面组件首次 fetch 之前生效）
import { setPrefetchPage, prefetchMenuPages } from "@/lib/desk/api-cache";
import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import OverviewPage from "./pages/OverviewPage";
import BoardPage from "./pages/BoardPage";
import AnalysisPage from "./pages/AnalysisPage";
import WatchlistPage from "./pages/WatchlistPage";
import HistoryPage from "./pages/HistoryPage";
import CopilotPage from "./pages/AssistantPage";
import AiHomePage from "./pages/AiHomePage";
import LlmAnalysisPage from "./LlmAnalysisPage";
import QimenPanel from "./QimenPanel";
import QuantPage from "./QuantPage";
import ExtensionPage from "./pages/ExtensionPage";
import SettingsPage from "./pages/SettingsPage";
import AiScanPage from "./pages/AiScanPage";
import PoolPage from "./pages/PoolPage";
import ScreenerPage from "./pages/ScreenerPage";
import ScreenerWorkbench from "./pages/ScreenerWorkbench";
// P36-C 战绩：跟着推荐到底赚没赚（票级明细 + 跟单 vs 全A中位两条线）
import TrackRecordPage from "./pages/TrackRecordPage";
// 新闻筛选：催化分流器规则版 v1（电报按 9 口子分流展示，仅展示）
import NewsFilterPage from "./pages/NewsFilterPage";
import SectorsPage from "./pages/SectorsPage";
import FactorLabPage from "./pages/FactorLabPage";
import ProfilePage from "./pages/ProfilePage";
import MarketPage from "./pages/MarketPage";
import AllStocksPage from "./pages/AllStocksPage";
import QuotesPage from "./pages/QuotesPage";
import RiskPage from "./pages/RiskPage";
import ProbabilityPage from "./pages/ProbabilityPage";
import ThemesPage from "./pages/ThemesPage";
import ThemeOverviewPage from "./pages/ThemeOverviewPage";
import RadarPage from "./pages/RadarPage";
import SectorTopPage from "./pages/SectorTopPage";
import EventsPage from "./pages/EventsPage";
import DailyReportPage from "./pages/DailyReportPage";
import ResearchPage from "./pages/ResearchPage";
import AgentPage from "./pages/AgentPage";
import { useDesk } from "@/lib/desk/store";
import { PAGE_TITLES, type PageKey } from "@/lib/desk/types";
import { resolveRoute } from "@/lib/desk/nav-core";
import { useTradeDate, shortDate } from "@/lib/desk/use-trade-date";
import WorkbenchShell from "./WorkbenchShell";

/** 全局统一的「今天为什么没数据」说明：非交易日才出现，告诉用户各页看到的是最近交易日的收盘口径，
 *  避免每页各说各话。数据来自行情源真值（useTradeDate），加载中/交易日都不打扰。 */
function HolidayBanner() {
  const { today, tradeDate, isTradingToday, loading } = useTradeDate();
  if (loading || isTradingToday || !today) return null;
  return (
    <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[12.5px] leading-relaxed text-amber-700 dark:text-amber-200/90">
      <span className="shrink-0 rounded bg-amber-500 px-1.5 py-0.5 font-semibold text-amber-950">休市日</span>
      <span>今天（{today}）不交易，所以各页显示的是最近交易日 {shortDate(tradeDate)} 的收盘数据，<span className="font-medium">不是今天实时行情</span>。开盘后会自动更新。</span>
    </div>
  );
}

export default function AppShell() {
  const page = useDesk((s) => s.page);
  const collapsed = useDesk((s) => s.sidebarCollapsed);
  const go = useDesk((s) => s.go);

  /**
   * 2026-09-26 用户实测：「在大盘情绪刷新，又自动被跳到别的页」。
   *
   * 根因是 persist 的 rehydrate 与下面两个 effect 抢跑：
   *   ① 首帧 store.page 还是初始值 market ⇒ 自愈 effect 先把 `#/market` 写进地址栏；
   *   ② rehydrate 随后把 page 覆盖成存档值（用户上次可能停在 copilot / llmportal）⇒ 地址栏被再改一次。
   * 用户看到的就是「先显示大盘情绪，然后自动跳到别的菜单」。
   *
   * 修法：等 rehydrate 真正完成后再让两个 effect 跑；在此之前既不写 hash 也不渲染内容。
   * 这样「URL hash 优先、否则用存档」这条口径才是在**最终状态**上算的，不会出现中间态。
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const p = useDesk.persist;
    if (p.hasHydrated()) { setHydrated(true); return; }
    const unsub = p.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);

  // hash 路由：①刷新后停留当前页 ②监听 hashchange——浏览器前进/后退或手改 #/xxx 时同步页面，
  // 避免出现「URL 已变、渲染未变」的不一致；无效 hash 回写为当前页，保证 URL 与实际页面一致。
  useEffect(() => {
    if (!hydrated) return;
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
  }, [go, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    // R3c 双入口合并：存档里可能还躺着旧页 aiscan（persist 恢复不过 go()）——状态自愈到统一入口，
    // URL/标题都按收口后的目标写，避免「#/aiscan 还挂在地址栏但内容已是门户」的口径分裂。
    const target = resolveRoute(page);
    if (target !== page) { go(target); return; }
    // 防竞态（用户实测「刷新总进 LLM 分析、菜单要点两次」）：hash 同步 effect 在本 commit 先 go(目标页)，
    // 本 effect 若还拿着旧 page 闭包把地址栏写回默认页，会再次触发 hashchange 把页面翻回去。
    // 只有 store 里的 page 仍是本闭包的 page（期间没有被 go() 改过）才允许写 hash。
    if (useDesk.getState().page !== page) return;
    window.location.hash = `#/${page}`;
    document.title = `${PAGE_TITLES[page]} · MyDesk`;
  }, [page, go, hydrated]);

  // 告诉缓存层「当前在哪一页」：它据此记住该页用过的接口，供菜单 hover 预热（点开即有内容）
  useEffect(() => { if (hydrated) setPrefetchPage(page); }, [page, hydrated]);

  // 进站空闲预热（2026-09-29 用户：「优化一下所有菜单打开的缓存」）：
  // 等首屏稳下来后，按声明表把各菜单页的首屏接口依次拉进客户端 SWR 缓存——
  // 这样**每个菜单项的第一次点击**也是秒开（只靠 hover 预热的话，自学习表要访问过那一页才有记录）。
  // 串行 + 700ms 间隔、跳过当前页：预取不许抢当前页的上游。
  useEffect(() => {
    if (!hydrated) return;
    const stop = prefetchMenuPages({ gapMs: 700 });
    return stop;
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    // R13（用户拍板）：每次冷启动清一次「整 7 天没动过」的旧对话——开着页面不盯时钟，
    // 当天还在用的会话 updatedAt 自然新，不会被误伤；判定口径全在 chat-core.pruneStaleSessions。
    useDesk.getState().pruneStaleChats();
  }, [hydrated]);

  // rehydrate 完成前不渲染内容：首帧既不该闪出「初始页」，也不该把中间态 hash 写进地址栏。
  if (!hydrated) return null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {!collapsed && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <HolidayBanner />
        <main className="min-h-0 flex-1 overflow-y-auto desk-scroll">
          {/* P7-⑪ 任务1：外面包一层工作台壳（左窄栏列表 + 右详情）。
              下面 25 个分支一个不删——旧 hash 路由全部保留做兼容跳转，右栏渲染的就是原页面组件本身。 */}
          <WorkbenchShell>
            {/* 2026-09-26 用户拍板（推翻 09-25 的「点进即对话」）：「AI分析」点进**不再**直接进对话，
                先落一个落地页（AiHomePage：Hello + 大输入框 + 推荐问题），从落地页提问才进 copilot 对话页。
                对话本体仍由 copilot / AssistantPage 承载（一键提问走 askInAssistant → pendingAsk → copilot）。 */}
            {page === "aihome" && <AiHomePage />}
            {/* R3c 合并后 go("aiscan") 已在 store 收口到 quant 门户，此分支是「分支一个不删」的兼容兜底：
                persist 恢复出 aiscan 的瞬间也会先渲染这里，effect 随即自愈改判——不留双窗口的第二份入口。 */}
            {page === "aiscan" && <AiScanPage />}
            {page === "pool" && <PoolPage />}
            {page === "screener" && <ScreenerPage />}
            {page === "aiscreener" && <ScreenerWorkbench />}
            {page === "trackrecord" && <TrackRecordPage />}
            {page === "newsfilter" && <NewsFilterPage />}
            {page === "profile" && <ProfilePage />}
            {page === "market" && <MarketPage />}
            {page === "sectors" && <SectorsPage />}
            {page === "sectortop" && <SectorTopPage />}
            {page === "allstocks" && <AllStocksPage />}
            {page === "quotes" && <QuotesPage />}
            {page === "dashboard" && <OverviewPage />}
            {page === "board" && <BoardPage />}
            {page === "analysis" && <AnalysisPage />}
            {page === "tracker" && <WatchlistPage />}
            {page === "history" && <HistoryPage />}
            {page === "copilot" && <CopilotPage />}
            {/* P26：LLM 分析门户（对齐稳智顶部 5 Tab 工作台）——copilot 通过 ROUTE_REDIRECTS 收口到此 */}
            {page === "llmportal" && <LlmAnalysisPage />}
            {page === "qimen" && <QimenPanel />}
            {page === "quant" && <QuantPage />}
            {page === "factorlab" && <FactorLabPage />}
            {page === "risk" && <RiskPage />}
            {page === "problab" && <ProbabilityPage />}
            {page === "themes" && <ThemesPage />}
            {page === "themeoverview" && <ThemeOverviewPage />}
            {page === "radar" && <RadarPage />}
            {page === "events" && <EventsPage />}
            {page === "dailyreport" && <DailyReportPage />}
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
