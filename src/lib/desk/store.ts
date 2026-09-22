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
import type { ChatHorizon, ChatMode } from "./modes";
// P14：自选分组的三个纯操作（建/删/移）住在零 IO 纯核里，store 只做接线——行为可直接 node --test
import { addGroupCore, removeGroupCore, moveWatchCore } from "./watchlist-group-core";
// R3c：导航重定向表住在 nav-core 纯核里，store.go 只是照表收口——菜单/递棒/旧 hash 共用一条裁决
import { resolveRoute } from "./nav-core";

// 回答风格的清单只有一份（modes.ts），这里原样转出键类型，页面不再各自声明一遍联合类型
export type { ChatMode };
// P11 持仓周期同纪律：键类型唯一正身在 modes.ts，页面从这里转出去而不是各自抄
export type { ChatHorizon };

/**
 * 智能助手页的两种工作模式（P7-⑨⑤）：
 *  - chat  = 对话分析（原有：会话列表 + 流式对话 + 右栏上下文面板）
 *  - qimen = 奇门解盘（本地排盘 + 走既有模型通道生成解盘文本）
 * 放在 store 并持久化：它是页面级选择，刷新后该停在哪一模式就停在哪一模式，
 * 与「回答风格 assistantMode」是两件事，不复用同一个字段。
 */
export type DeskMode = "chat" | "qimen";

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
  /**
   * P14：自选分组（对齐稳智 watchlist groups）。只存 {id,name}——成员关系挂在
   * watch[].groupId 上，一份事实一个正身。「未分组」不是这里的条目，是 groupId 为空。
   */
  watchlistGroups: { id: string; name: string }[];
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
  /**
   * 回答风格（决策/研判/深度/搜索）。放在 store 而不是页面 useState：
   * 首页的下拉和对话页的 chip 是同一个设置的两种画法，各存一份就会出现「首页选了研判、
   * 对话页按决策发」这种看不出来的错位。
   */
  assistantMode: ChatMode;
  /**
   * P11：持仓周期偏好（短/中/长线）。null＝用户没选——不拿「中线」冒充默认，
   * 两端点也就不注入任何周期口径（选没选是模型必须分清的事实）。
   */
  assistantHorizon: ChatHorizon | null;
  /**
   * P7-⑨⑤：智能助手页当前是「对话分析」还是「奇门解盘」。持久化，刷新后停在原模式。
   * 与 assistantMode（回答风格）互不相干：前者决定右栏画哪一套，后者只影响对话端点的口径。
   */
  deskMode: DeskMode;
  /**
   * P8-⑤：Debug 步骤时间线开关（意图三段视图 + 入参/摘要富化帧）。默认关、本机持久化（细则 §5-2 拍板项）：
   * 不开时线上帧与字节数和 A/B 轮完全一致，这是「不改动已收口逻辑」的可证形态。
   */
  debugPanel: boolean;
  /**
   * P7-⑥⑥：首页把「这一句」交给唯一的对话页去发。
   * 一次性交接、不进存档（partialize 不收它）：会话本来就共用同一份 store，
   * 缺的只是「在哪一页发」——再给首页写一套 send() 就是本轮要避免的「两边各做一套」。
   */
  pendingAsk: string | null;
  /**
   * P7-⑧②：对话正文点了某个板块名之后，板块榜页要展开哪一块（存 BK 代码）。
   * 一次性交接、不进 partialize：和 pendingAsk 同理，刷新后还替用户展开一块会莫名其妙。
   */
  focusSector: string | null;
  /**
   * P12-②：板块/概念页点「去选股」递过来的一棒——AI 选股页挂载后据此把股票池切成该板块成分。
   * 与 focusSector 同类：一次性交接、读完即清、不进 partialize（刷新后还自动开一轮板块选股会莫名其妙）。
   */
  scanBoard: { code: string; name: string; kind: "industry" | "concept" } | null;

  go: (p: PageKey) => void;
  toggleSidebar: () => void;
  setFocusSymbol: (s: string) => void;
  /** 请板块榜页展开某个板块（跳页联动用），读完即清 */
  setFocusSector: (code: string | null) => void;
  takeFocusSector: () => string | null;
  /** 请 AI 选股页把股票池切到该板块成分（跳页联动用），读完即清 */
  setScanBoard: (b: { code: string; name: string; kind: "industry" | "concept" } | null) => void;
  takeScanBoard: () => { code: string; name: string; kind: "industry" | "concept" } | null;
  setAssistantMode: (m: ChatMode) => void;
  setAssistantHorizon: (h: ChatHorizon | null) => void;
  setDeskMode: (m: DeskMode) => void;
  setDebugPanel: (v: boolean) => void;
  addWatch: (w: WatchItem) => void;
  removeWatch: (symbol: string) => void;
  /** P14：建组（同名不重建、返回既有 id；空名拒），返回组 id */
  addWatchGroup: (name: string) => string | null;
  /** P14：删组只销组——成员一律回未分组，不拿删组当删自选 */
  removeWatchGroup: (id: string) => void;
  /** P14：把一只票移进/移回分组（groupId=null 回未分组） */
  moveWatch: (symbol: string, groupId: string | null) => void;
  addTracker: (t: TrackerPlan) => void;
  updateTrackerStatus: (id: string, status: TrackerPlan["status"]) => void;
  removeTracker: (id: string) => void;
  addHistory: (h: HistoryEntry) => void;
  clearHistory: () => void;
  /** 把一句话交给助手页发送（跳页 + 一次性交接），首页与小窗都用它，自己不发请求 */
  askInAssistant: (content: string) => void;
  /** 对话页取走待发送的那一句：取一次就清掉，刷新页面不会重发 */
  takePendingAsk: () => string | null;
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

/**
 * 随对话请求带出的自选清单（P7-⑥④）。
 * 服务端不读浏览器存档、也不查任何账号库，所以「我的自选怎么样」这类问题只能靠这份清单；
 * 只带代码与名称：kind、加入时间这些本机界面字段不发出去。清单为空时工具层会如实回 missing。
 */
export function watchlistPayload(): { symbol: string; name: string | null }[] {
  return useDesk.getState().watchlist.map((w) => ({ symbol: w.symbol, name: w.name ?? null }));
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
      // P7-⑪ 任务1：默认落 AI 决策对话（旧默认 aihome 页已并入对话，hash `#/aihome` 仍兼容直达）
      page: "copilot",
      sidebarCollapsed: false,
      focusSymbol: "000001.SH",
      watchlist: [
        { symbol: "000001.SH", name: "上证指数", kind: "watch" },
        { symbol: "000300.SH", name: "沪深300", kind: "watch" },
        { symbol: "688256.SH", name: "寒武纪", kind: "watch" },
      ],
      // P14：默认无组（「未分组」即 groupId 为空，不是一条假分组记录）
      watchlistGroups: [],
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
      assistantMode: "decision",
      assistantHorizon: null,
      deskMode: "chat",
      debugPanel: false,
      pendingAsk: null,
      focusSector: null,
      scanBoard: null,

      // R3c 双入口合并（用户拍板「合并成一条」）：导航目标先过 nav-core 重定向表收口在这一处——
      // go("aiscan") 自动落 quant 门户（主 Tab 挂的就是 AiScanPage 本体），页面侧调用方一个字不用改。
      go: (p) => set({ page: resolveRoute(p) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setFocusSymbol: (sym) => set({ focusSymbol: sym }),
      setFocusSector: (code) => set({ focusSector: code }),
      takeFocusSector: () => {
        const code = get().focusSector;
        if (code) set({ focusSector: null });
        return code;
      },
      setScanBoard: (b) => set({ scanBoard: b }),
      takeScanBoard: () => {
        const b = get().scanBoard;
        if (b) set({ scanBoard: null });
        return b;
      },
      setAssistantMode: (m) => set({ assistantMode: m }),
      setAssistantHorizon: (h) => set({ assistantHorizon: h }),
      setDeskMode: (m) => set({ deskMode: m }),
      setDebugPanel: (v) => set({ debugPanel: v === true }),
      addWatch: (w) => set((s) => (s.watchlist.some((x) => x.symbol === w.symbol) ? s : { watchlist: [w, ...s.watchlist] })),
      removeWatch: (sym) => set((s) => ({ watchlist: s.watchlist.filter((x) => x.symbol !== sym) })),
      addWatchGroup: (name) => {
        // 语义都在 watchlist-group-core（空名拒 / 同名回既有 id / trim）——行为可测，不埋在 action 里
        const { groups, id } = addGroupCore(get().watchlistGroups, name, () => `g${Date.now().toString(36)}`);
        if (id !== null && !get().watchlistGroups.some((g) => g.id === id)) set({ watchlistGroups: groups });
        return id;
      },
      removeWatchGroup: (id) => set((s) => {
        // 键名在这里对回 store 字段（纯核返回的是 {groups, watchlist}）——实机走查抓到过直塞导致的「组删不掉」
        const r = removeGroupCore(s.watchlistGroups, s.watchlist, id);
        return { watchlistGroups: r.groups, watchlist: r.watchlist };
      }),
      moveWatch: (symbol, groupId) => set((s) => ({ watchlist: moveWatchCore(s.watchlist, symbol, groupId) })),
      addTracker: (t) => set((s) => ({ tracker: [t, ...s.tracker] })),
      updateTrackerStatus: (id, status) =>
        set((s) => ({ tracker: s.tracker.map((t) => (t.id === id ? { ...t, status } : t)) })),
      removeTracker: (id) => set((s) => ({ tracker: s.tracker.filter((x) => x.id !== id) })),
      addHistory: (h) => set((s) => ({ history: [h, ...s.history].slice(0, 100) })),
      clearHistory: () => set({ history: [] }),
      askInAssistant: (content) => {
        const question = content.trim();
        // 空正文不交接：跳过去看到一个空会话，比留在原页更让人困惑（也不动页）
        if (!question) return;
        set({ pendingAsk: question, page: "copilot" });
      },
      takePendingAsk: () => {
        const pending = get().pendingAsk;
        if (pending) set({ pendingAsk: null });
        return pending;
      },
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
        watchlistGroups: s.watchlistGroups,
        tracker: s.tracker,
        history: s.history,
        // 落盘前清掉「正在生成」的瞬时标记：中途关标签页不该留下一个永远在转的光标
        sessions: s.sessions.map((x) => ({
          ...x,
          messages: x.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        })),
        activeSessionId: s.activeSessionId,
        ai: s.ai,
        assistantMode: s.assistantMode,
        // P11：与 assistantMode 同类的长期偏好；白名单收敛——存档被手改成别的字符串时落回 null（未选），
        // 而不是落回某个周期：没选过的人刷新后不该莫名带上短线口径。
        assistantHorizon: s.assistantHorizon === "short" || s.assistantHorizon === "mid" || s.assistantHorizon === "long" ? s.assistantHorizon : null,
        // 只落盘合法的两个值：存档被手改成别的字符串时写回时收敛成 chat，页面也只认 "qimen" 一种特例
        deskMode: s.deskMode === "qimen" ? "qimen" : "chat",
        // P8-⑤：与 assistantMode 同类的长期偏好——只认真布尔，坏值收敛成关（默认关是细则 §5-2 的拍板项）
        debugPanel: s.debugPanel === true,
        mcpServers: s.mcpServers,
        refreshInterval: s.refreshInterval,
        extensionKey: s.extensionKey,
        frozenPools: s.frozenPools,
      }),
    }
  )
);
