"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  PageKey, WatchItem, TrackerPlan, HistoryEntry, ChatMsg, AiSettings, McpServerConfig,
} from "./types";

interface DeskState {
  page: PageKey;
  sidebarCollapsed: boolean;
  focusSymbol: string;         // 分析页当前品种
  watchlist: WatchItem[];
  tracker: TrackerPlan[];
  history: HistoryEntry[];
  chats: ChatMsg[][];          // 多会话，每个元素是一个会话的消息数组
  activeChat: number;
  ai: AiSettings;
  mcpServers: McpServerConfig[];
  refreshInterval: number;     // 秒
  extensionKey: string;

  go: (p: PageKey) => void;
  toggleSidebar: () => void;
  setFocusSymbol: (s: string) => void;
  addWatch: (w: WatchItem) => void;
  removeWatch: (symbol: string) => void;
  addTracker: (t: TrackerPlan) => void;
  updateTrackerStatus: (id: string, status: TrackerPlan["status"]) => void;
  removeTracker: (id: string) => void;
  addHistory: (h: HistoryEntry) => void;
  clearHistory: () => void;
  newChat: () => void;
  dropChat: (i: number) => void;
  setChats: (c: ChatMsg[][]) => void;
  setActiveChat: (i: number) => void;
  setAi: (s: Partial<AiSettings>) => void;
  setMcpServers: (s: McpServerConfig[]) => void;
  setRefreshInterval: (n: number) => void;
  regenExtensionKey: () => void;
}

const DEFAULT_AI: AiSettings = {
  provider: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
};

function randKey() {
  return "mdk_" + Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
}

export const useDesk = create<DeskState>()(
  persist(
    (set) => ({
      page: "dashboard",
      sidebarCollapsed: false,
      focusSymbol: "000001.SH",
      watchlist: [
        { symbol: "000001.SH", name: "上证指数", kind: "watch" },
        { symbol: "000300.SH", name: "沪深300", kind: "watch" },
        { symbol: "688256.SH", name: "寒武纪", kind: "watch" },
      ],
      tracker: [],
      history: [],
      chats: [[]],
      activeChat: 0,
      ai: DEFAULT_AI,
      mcpServers: [
        {
          id: "demo-market",
          name: "demo-market",
          command: "py",
          args: ["scripts/mcp/demo_market.py"],
          trusted: false,
        },
      ],
      refreshInterval: 60,
      extensionKey: randKey(),

      go: (p) => set({ page: p }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setFocusSymbol: (sym) => set({ focusSymbol: sym }),
      addWatch: (w) => set((s) => (s.watchlist.some((x) => x.symbol === w.symbol) ? s : { watchlist: [w, ...s.watchlist] })),
      removeWatch: (sym) => set((s) => ({ watchlist: s.watchlist.filter((x) => x.symbol !== sym) })),
      addTracker: (t) => set((s) => ({ tracker: [t, ...s.tracker] })),
      updateTrackerStatus: (id, status) =>
        set((s) => ({ tracker: s.tracker.map((t) => (t.id === id ? { ...t, status } : t)) })),
      removeTracker: (id) => set((s) => ({ tracker: s.tracker.filter((x) => x.id !== id) })),
      addHistory: (h) => set((s) => ({ history: [h, ...s.history].slice(0, 100) })),
      clearHistory: () => set({ history: [] }),
      newChat: () => set((s) => ({ chats: [[], ...s.chats], activeChat: 0 })),
      dropChat: (i) => set((s) => {
        const chats = s.chats.filter((_, idx) => idx !== i);
        return { chats: chats.length ? chats : [[]], activeChat: 0 };
      }),
      setChats: (c) => set({ chats: c }),
      setActiveChat: (i) => set({ activeChat: i }),
      setAi: (p) => set((s) => ({ ai: { ...s.ai, ...p } })),
      setMcpServers: (sv) => set({ mcpServers: sv }),
      setRefreshInterval: (n) => set({ refreshInterval: n }),
      regenExtensionKey: () => set({ extensionKey: randKey() }),
    }),
    {
      name: "mydesk-state",
      partialize: (s) => ({
        page: s.page,
        sidebarCollapsed: s.sidebarCollapsed,
        focusSymbol: s.focusSymbol,
        watchlist: s.watchlist,
        tracker: s.tracker,
        history: s.history,
        chats: s.chats,
        activeChat: s.activeChat,
        ai: s.ai,
        mcpServers: s.mcpServers,
        refreshInterval: s.refreshInterval,
        extensionKey: s.extensionKey,
      }),
    }
  )
);
