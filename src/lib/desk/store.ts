"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  PageKey, WatchItem, TrackerPlan, HistoryEntry, ChatMsg, AiSettings, McpServerConfig,
} from "./types";
import {
  appendMessage as appendToSession, emptySession, migrateLegacyChats,
  removeSession as dropSessionById, updateMessage as patchSessionMessage,
  upsertSession, type ChatMessage, type ChatSession,
} from "./chat-core";

// 冻结候选池（需求文档 二十三：冻结后原始候选结果不得被覆盖）
export interface FrozenPool {
  id: string;            // 2026-09-19-AI-001
  createdAt: string;     // HH:mm:ss
  asOf: string;          // 交易日
  universe: string;
  conditions: { field: string; op: string; value: number | string }[];
  source: string;        // 产生方式（AI扫描/因子选股/手工）
  rows: { symbol: string; name: string; close: number | null; changePct: number | null; score?: number; reason?: string }[];
  nextVerify?: { date: string; results: Record<string, { open: number; high: number; low: number; close: number; ret1d: number | null }> };
}

interface DeskState {
  page: PageKey;
  sidebarCollapsed: boolean;
  focusSymbol: string;         // 分析页当前品种
  watchlist: WatchItem[];
  tracker: TrackerPlan[];
  history: HistoryEntry[];
  /** P7-⑤②：会话从「二维消息数组」升级为带 id/标题/关联标的的 ChatSession（旧存档自动迁移） */
  sessions: ChatSession[];
  activeSessionId: string;
  ai: AiSettings;
  mcpServers: McpServerConfig[];
  refreshInterval: number;     // 秒
  extensionKey: string;
  frozenPools: FrozenPool[];

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
  newSession: () => string;
  switchSession: (id: string) => void;
  dropSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setSessionStock: (id: string, stock: Partial<Pick<ChatSession, "stock" | "costPrice" | "holdPeriod">>) => void;
  addChatMessage: (sessionId: string, msg: ChatMessage) => void;
  patchChatMessage: (sessionId: string, msgId: string, patch: Partial<ChatMessage>) => void;
  setAi: (s: Partial<AiSettings>) => void;
  setMcpServers: (s: McpServerConfig[]) => void;
  setRefreshInterval: (n: number) => void;
  regenExtensionKey: () => void;
  addFrozenPool: (p: FrozenPool) => void;
  dropFrozenPool: (id: string) => void;
  attachVerify: (id: string, v: NonNullable<FrozenPool["nextVerify"]>) => void;
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

const FIRST_SESSION = emptySession();

/** 会话上限：只留最近 30 个（老会话不静默丢，按更新时间淘汰最旧的） */
const MAX_SESSIONS = 30;

function byUpdatedDesc(a: ChatSession, b: ChatSession): number {
  return b.updatedAt - a.updatedAt;
}

export const useDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      page: "aihome",
      sidebarCollapsed: false,
      focusSymbol: "000001.SH",
      watchlist: [
        { symbol: "000001.SH", name: "上证指数", kind: "watch" },
        { symbol: "000300.SH", name: "沪深300", kind: "watch" },
        { symbol: "688256.SH", name: "寒武纪", kind: "watch" },
      ],
      tracker: [],
      history: [],
      sessions: [FIRST_SESSION],
      activeSessionId: FIRST_SESSION.id,
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
      frozenPools: [],

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
      // 已有空会话时不重复创建：连着点「新会话」不该刷出一排空壳
      newSession: () => {
        const s = get();
        const current = s.sessions.find((x) => x.id === s.activeSessionId);
        if (current && current.messages.length === 0) return current.id;
        const session = emptySession();
        set({ sessions: [session, ...s.sessions], activeSessionId: session.id });
        return session.id;
      },
      switchSession: (id) => {
        if (get().sessions.some((x) => x.id === id)) set({ activeSessionId: id });
      },
      dropSession: (id) => set((s) => {
        const sessions = dropSessionById(s.sessions, id);
        return { sessions, activeSessionId: s.activeSessionId === id ? sessions[0].id : s.activeSessionId };
      }),
      renameSession: (id, title) => set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: title.trim() || x.title, updatedAt: Date.now() } : x)),
      })),
      setSessionStock: (id, stock) => set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...stock, updatedAt: Date.now() } : x)),
      })),
      // 新消息把会话顶到最前（列表口径 = 最近活跃在前，与迁移后的初始排序一致）
      addChatMessage: (sessionId, msg) => set((s) => {
        const target = s.sessions.find((x) => x.id === sessionId);
        if (!target) return {};
        const next = appendToSession(target, msg);
        const merged = [next, ...s.sessions.filter((x) => x.id !== sessionId)];
        return { sessions: merged.length > MAX_SESSIONS ? merged.sort(byUpdatedDesc).slice(0, MAX_SESSIONS) : merged };
      }),
      // 流式回填只改内容不挪位置：否则每一帧都在重排列表
      patchChatMessage: (sessionId, msgId, patch) => set((s) => {
        const target = s.sessions.find((x) => x.id === sessionId);
        if (!target) return {};
        const next = patchSessionMessage(target, msgId, patch);
        return { sessions: s.sessions.map((x) => (x.id === sessionId ? next : x)) };
      }),
      setAi: (p) => set((s) => ({ ai: { ...s.ai, ...p } })),
      setMcpServers: (sv) => set({ mcpServers: sv }),
      setRefreshInterval: (n) => set({ refreshInterval: n }),
      regenExtensionKey: () => set({ extensionKey: randKey() }),
      addFrozenPool: (p) => set((s) => ({ frozenPools: [p, ...s.frozenPools].slice(0, 30) })),
      dropFrozenPool: (id) => set((s) => ({ frozenPools: s.frozenPools.filter((x) => x.id !== id) })),
      attachVerify: (id, v) => set((s) => ({
        frozenPools: s.frozenPools.map((p) => (p.id === id ? { ...p, nextVerify: v } : p)),
      })),
    }),
    {
      name: "mydesk-state",
      // v0/v1 的会话长这样：chats: ChatMsg[][]（下标即会话）+ activeChat: number。
      // v2 起换成带 id/标题/关联标的的 ChatSession[]。迁移必须无损且幂等：
      // 老浏览器里的历史会话升级后不能消失，也不能第二次刷新再迁一遍。
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as { chats?: ChatMsg[][]; activeChat?: number; sessions?: ChatSession[]; activeSessionId?: string };
        if (version < 2 && !state.sessions) {
          const sessions = migrateLegacyChats(state.chats);
          const activeIndex = Math.min(Math.max(0, state.activeChat ?? 0), sessions.length - 1);
          const active = state.chats?.length ? sessions[activeIndex] : sessions[0];
          // 迁移出的会话按更新时间排序后，活动会话取原来那一条（下标语义不能悄悄换人）
          return {
            ...state,
            sessions: sessions.slice().sort(byUpdatedDesc),
            activeSessionId: active?.id ?? sessions[0].id,
          };
        }
        const sessions = state.sessions?.length ? state.sessions : [emptySession()];
        return {
          ...state,
          sessions,
          activeSessionId: sessions.some((x) => x.id === state.activeSessionId) ? state.activeSessionId! : sessions[0].id,
        };
      },
      partialize: (s) => ({
        page: s.page,
        sidebarCollapsed: s.sidebarCollapsed,
        focusSymbol: s.focusSymbol,
        watchlist: s.watchlist,
        tracker: s.tracker,
        history: s.history,
        // 落盘前清掉「正在生成」的瞬时标记：中途关标签页不该留下一个永远在转的光标
        sessions: s.sessions.map((x) => ({
          ...x,
          messages: x.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        })),
        activeSessionId: s.activeSessionId,
        ai: s.ai,
        mcpServers: s.mcpServers,
        refreshInterval: s.refreshInterval,
        extensionKey: s.extensionKey,
        frozenPools: s.frozenPools,
      }),
    }
  )
);
