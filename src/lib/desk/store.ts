"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  PageKey, WatchItem, TrackerPlan, HistoryEntry, ChatMsg, AiSettings, McpServerConfig,
} from "./types";
// 值导入：PAGE_TITLES 是 page 落盘时的白名单（存档被手改成不存在的页名 ⇒ 收敛回默认页，避免白屏）
import { PAGE_TITLES } from "./types";
import {
  appendMessage as appendToSession, emptySession, migrateLegacyChats,
  pruneStaleSessions as pruneStaleCore,
  removeSession as dropSessionById, updateMessage as patchSessionMessage,
  upsertSession, type ChatMessage, type ChatSession,
} from "./chat-core";
import type { ChatHorizon, ChatMode } from "./modes";
import { sanitizeHold, type HoldCtx } from "./hold-core";
// P14：自选分组的三个纯操作（建/删/移）住在零 IO 纯核里，store 只做接线——行为可直接 node --test
import { addGroupCore, removeGroupCore, moveWatchCore } from "./watchlist-group-core";
// R3c：导航重定向表住在 nav-core 纯核里，store.go 只是照表收口——菜单/递棒/旧 hash 共用一条裁决
import { isMenuVisible, resolveRoute } from "./nav-core";

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
  source: string;        // 产生方式（AI扫描/因子选股/手工/AI优选）
  rows: { symbol: string; name: string; close: number | null; changePct: number | null; score?: number; reason?: string }[];
  nextVerify?: { date: string; results: Record<string, { open: number; high: number; low: number; close: number; ret1d: number | null }> };
  /** 2026-09-26 稳智「AI优选」对齐：建池时按稳智模板拼好的问句——「再次前往AI」原样重发，不重拼 */
  prompt?: string;
  /** 展示用标签（策略名 · N只 · 交易日），对齐稳智 `candidate_pool_label` */
  label?: string;
}

/**
 * 2026-09-26 稳智「AI优选」对齐：选股工作台把「冻结候选池 + 拼好的问句 + 所选周期」交给对话页。
 *
 * 与 `pendingAsk` 的关键区别：**pendingAsk 是立即发送**（落地页点一下卡片就发出去）；
 * 本交接是**预填不发送**——对齐稳智 /screener「创建候选池并前往稳智AI」的行为：
 * 跳过去之后 `B.value = prompt`，用户自己点发送（稳智源码实证：onMounted 只赋值、不 submit）。
 *
 * 一次性交接、不进 partialize：刷新后还替用户预填一段问句会莫名其妙（与 pendingAsk 同纪律）。
 */
export interface AiPoolHandoff {
  poolId: string;
  /** 候选池徽章文案（对齐稳智 candidate_pool_label） */
  label: string;
  /** 预填进输入框的问句（稳智 5 行模板 + 本地候选清单） */
  prompt: string;
  /** 所选周期收敛到本地口径（稳智 3 档 → 本地 ChatHorizon，映射见 ScreenerWorkbench） */
  horizon: ChatHorizon;
}

interface DeskState {
  page: PageKey;
  sidebarCollapsed: boolean;
  focusSymbol: string;         // 分析页当前品种
  /** 行情市场选项卡：A股 | 港股 | 美股（四行情页共用，持久化，默认 A股） */
  marketTab: "A" | "HK" | "US";
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
   * 持仓上下文（标的 / 成本价 / 仓位 / 建仓日期）。null＝没填过，一个字都不注入。
   * 放 store 而不是页面 useState：composer 上填一次之后，这一页的每一轮追问都要带同一份，
   * 否则第二句「那现在要不要减」就退回成没有成本、不知道拿了多久的泛泛之谈。
   * 八张卡的持仓卡填完也会写回这里（同一份，不是第二套）。
   */
  holdCtx: HoldCtx | null;
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
   * 2026-09-26 稳智「AI优选」对齐：选股工作台冻结候选池后，把「池 + 问句 + 周期」交给对话页预填。
   * 与 pendingAsk 的差别见 AiPoolHandoff 的注释（那个是立即发，这个是预填不发）。一次性、不进 partialize。
   */
  aiPoolHandoff: AiPoolHandoff | null;
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
  /**
   * P48：板块页点板块名 → 量化因子选股页的一棒（对齐稳智 /sectors 点板块名开 /screener?sector=）。
   * 选股页挂载后据此把一条 `sector_concept like <关键词>` 条件加进「已选条件」并自动筛一轮。
   * 与 scanBoard 同类：一次性交接、读完即清、不进 partialize。
   */
  screenerHandoff: { sectorLike: string; kind: "industry" | "concept" } | null;

  go: (p: PageKey) => void;
  toggleSidebar: () => void;
  setFocusSymbol: (s: string) => void;
  /** 行情市场选项卡切换（A股 | 港股 | 美股） */
  setMarketTab: (m: "A" | "HK" | "US") => void;
  /** 请板块榜页展开某个板块（跳页联动用），读完即清 */
  setFocusSector: (code: string | null) => void;
  takeFocusSector: () => string | null;
  /** 请 AI 选股页把股票池切到该板块成分（跳页联动用），读完即清 */
  setScanBoard: (b: { code: string; name: string; kind: "industry" | "concept" } | null) => void;
  takeScanBoard: () => { code: string; name: string; kind: "industry" | "concept" } | null;
  /** P48：请量化因子选股页预置一条板块/概念条件（跳页联动用），读完即清 */
  setScreenerHandoff: (h: { sectorLike: string; kind: "industry" | "concept" } | null) => void;
  takeScreenerHandoff: () => { sectorLike: string; kind: "industry" | "concept" } | null;
  setAssistantMode: (m: ChatMode) => void;
  setAssistantHorizon: (h: ChatHorizon | null) => void;
  /** 整份替换持仓上下文；传 null / 空对象 = 清空（之后每轮都不再带持仓条件） */
  setHoldCtx: (h: HoldCtx | null) => void;
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
  /**
   * 2026-09-26 AI优选：把冻结好的候选池交给对话页（跳 copilot + 一次性交接）。
   * 顺带把用户刚选的周期写进 assistantHorizon——发送时 use-chat 现读它进请求（对齐稳智 payload 的 trading_horizon）；
   * 也让 composer 的周期选择器如实显示这一次的周期，用户发之前还能改。
   */
  askAiWithPool: (h: AiPoolHandoff) => void;
  /** 对话页取走 AI优选 交接：取一次就清掉（预填完即消费，刷新不重填） */
  takeAiPoolHandoff: () => AiPoolHandoff | null;
  newSession: () => string;
  switchSession: (id: string) => void;
  dropSession: (id: string) => void;
  /** R13：整 7 天没动过的对话自动清出存档（冷启动挂一次，见 AppShell）；活动会话若被清则收口到最新一条 */
  pruneStaleChats: () => void;
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

// R9 通达信接入：tdx-mcp（PyPI，走通达信公开行情服务器，非本地 vipdoc 文件）。
// 命令是绝对路径 ⇒ spawn 无 shell 不会查 PATH；--with "mcp<2" 是硬约束（mcp 2.x 把
// FastMCP 改名成 MCPServer，tdx-mcp 0.2.4 仍在 import mcp.server.fastmcp，不加就会崩在启动）。
// trusted:true 是用户拍板「把通达信接进去」的授权项——不信任时 callTool 会 TRUST_REQUIRED 拦截。
// 33 个工具里 symbol_zjlx（个股资金流向）上游有 bug（返回 dict 但声明 list ⇒ 输出校验必炸），
// 不能当第二家资金口径。
const TDX_MCP_SERVER: McpServerConfig = {
  id: "tdx-mcp",
  name: "通达信行情（tdx-mcp）",
  command: "C:\\Users\\Lenovo\\.local\\bin\\uvx.exe",
  args: ["--from", "tdx-mcp", "--with", "mcp<2", "tdx-mcp"],
  env: { UV_CACHE_DIR: "D:\\Zai\\uv-cache" },
  trusted: true,
};

/** 会话上限：只留最新 3 个（2026-09-29 用户拍板：被顶掉的最旧会话直接删，不进回收） */
const MAX_SESSIONS = 3;

function byUpdatedDesc(a: ChatSession, b: ChatSession): number {
  return b.updatedAt - a.updatedAt;
}

export const useDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      // P7-⑪ 任务1：默认落 AI 决策对话（旧默认 aihome 页已并入对话，hash `#/aihome` 仍兼容直达）
      page: "market",
      sidebarCollapsed: false,
      focusSymbol: "000001.SH",
      marketTab: "A",
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
        TDX_MCP_SERVER,
      ],
      refreshInterval: 60,
      extensionKey: randKey(),
      frozenPools: [],
      assistantMode: "decision",
      assistantHorizon: null,
      holdCtx: null,
      deskMode: "chat",
      debugPanel: false,
      pendingAsk: null,
      aiPoolHandoff: null,
      focusSector: null,
      scanBoard: null,
      screenerHandoff: null,

      // R3c 双入口合并（用户拍板「合并成一条」）：导航目标先过 nav-core 重定向表收口在这一处——
      // go("aiscan") 自动落 quant 门户（主 Tab 挂的就是 AiScanPage 本体），页面侧调用方一个字不用改。
      go: (p) => set({ page: resolveRoute(p) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setFocusSymbol: (sym) => set({ focusSymbol: sym }),
      setMarketTab: (m) => set({ marketTab: m }),
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
      setScreenerHandoff: (h) => set({ screenerHandoff: h }),
      takeScreenerHandoff: () => {
        const h = get().screenerHandoff;
        if (h) set({ screenerHandoff: null });
        return h;
      },
      setAssistantMode: (m) => set({ assistantMode: m }),
      setAssistantHorizon: (h) => set({ assistantHorizon: h }),
      // 空对象也按「没填」存 null：不往请求体里塞一个四个字段全空的壳
      setHoldCtx: (h) => set({ holdCtx: h && Object.keys(h).length ? h : null }),
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
        // 2026-09-27 用户实测：从 AI 首页提问会**接在上一次那条旧会话后面**，问几轮下来上下文越堆越长，
        // 模型既慢又贵，翻回去还找不到本轮从哪儿开始。口径改成「入口决定语义」：
        //   · 跨页交接（首页 / 扫描页 / 选股台）＝ 开一轮新对话；
        //   · 侧栏「最近」点某条旧会话 ＝ 回到那条继续（switchSession，不经过这里）；
        //   · 对话页自己的输入框 ＝ 就在当前会话里续问（AssistantPage.submit，也不经过这里）。
        // newSession() 自带「当前会话是空的就复用」，所以连着问不会刷出一排空壳会话。
        get().newSession();
        set({ pendingAsk: question, page: "copilot" });
      },
      takePendingAsk: () => {
        const pending = get().pendingAsk;
        if (pending) set({ pendingAsk: null });
        return pending;
      },
      askAiWithPool: (h) => {
        // 空问句不交接：跳过去看到一个空输入框，比留在原页更让人困惑（与 askInAssistant 同口径）
        if (!h?.prompt.trim()) return;
        // 与 askInAssistant 同一条语义：从选股台交接过来的是「一个新问题」，不该续在旧会话尾巴上。
        get().newSession();
        // 跳对话页 + 一次性交接；顺带把这次选的周期落到 assistantHorizon（发送时现读，见 use-chat 的 extra）
        set({ aiPoolHandoff: h, assistantHorizon: h.horizon, page: "copilot" });
      },
      takeAiPoolHandoff: () => {
        const h = get().aiPoolHandoff;
        if (h) set({ aiPoolHandoff: null });
        return h;
      },
      // 已有空会话时不重复创建：连着点「新会话」不该刷出一排空壳
      newSession: () => {
        const s = get();
        const current = s.sessions.find((x) => x.id === s.activeSessionId);
        if (current && current.messages.length === 0) return current.id;
        const session = emptySession();
        // 上限闸与 addChatMessage 同一条：超过 3 条时最旧的直接删（被顶掉即删，用户拍板）
        const merged = [session, ...s.sessions];
        set({
          sessions: merged.length > MAX_SESSIONS ? merged.slice(0, MAX_SESSIONS) : merged,
          activeSessionId: session.id,
        });
        return session.id;
      },
      switchSession: (id) => {
        if (get().sessions.some((x) => x.id === id)) set({ activeSessionId: id });
      },
      dropSession: (id) => set((s) => {
        const sessions = dropSessionById(s.sessions, id);
        return { sessions, activeSessionId: s.activeSessionId === id ? sessions[0].id : s.activeSessionId };
      }),
      // R13（用户拍板）：整 7 天没动过的对话清出存档。判定与兜底全在 chat-core 纯核里，
      // 这里只做两件事：调纯核、把 activeSessionId 收口（活动那条若被清就换最新留下的）。
      // 没清掉任何东西时原样返回 {}——不给 persist 多写一次盘，也不惊动订阅者重渲染。
      pruneStaleChats: () => set((s) => {
        // R13：7 天没动的清出；2026-09-29 上限改 3 后，老存档（>3 条）也在冷启动时一并收敛
        let sessions = pruneStaleCore(s.sessions);
        if (sessions.length > MAX_SESSIONS) sessions = sessions.slice().sort(byUpdatedDesc).slice(0, MAX_SESSIONS);
        if (sessions.length === s.sessions.length && sessions.every((x, i) => x.id === s.sessions[i].id)) return {};
        const activeSessionId = sessions.some((x) => x.id === s.activeSessionId) ? s.activeSessionId : sessions[0].id;
        return { sessions, activeSessionId };
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
      // v3（R9）：MCP 列表补上通达信登记项——只按 id 判缺补种一次，用户之后在设置页删掉不会再回来。
      version: 3,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as {
          chats?: ChatMsg[][]; activeChat?: number; sessions?: ChatSession[];
          activeSessionId?: string; mcpServers?: McpServerConfig[];
        };
        // 旧存档带着 MCP 列表却没有 tdx-mcp ⇒ 补种；存档压根没有该键时不动（走 store 默认值，别把 demo 挤丢）
        const seedTdx = Array.isArray(state.mcpServers) && !state.mcpServers.some((m) => m.id === "tdx-mcp")
          ? { mcpServers: [...state.mcpServers, TDX_MCP_SERVER] }
          : {};
        if (version < 2 && !state.sessions) {
          const sessions = migrateLegacyChats(state.chats);
          const activeIndex = Math.min(Math.max(0, state.activeChat ?? 0), sessions.length - 1);
          const active = state.chats?.length ? sessions[activeIndex] : sessions[0];
          // 迁移出的会话按更新时间排序后，活动会话取原来那一条（下标语义不能悄悄换人）
          return {
            ...state,
            ...seedTdx,
            sessions: sessions.slice().sort(byUpdatedDesc),
            activeSessionId: active?.id ?? sessions[0].id,
          };
        }
        const sessions = state.sessions?.length ? state.sessions : [emptySession()];
        return {
          ...state,
          ...seedTdx,
          sessions,
          activeSessionId: sessions.some((x) => x.id === state.activeSessionId) ? state.activeSessionId! : sessions[0].id,
        };
      },
      partialize: (s) => ({
        // 2026-09-26 用户实测修正：page **落盘**（原来不落盘，理由是「稳智同款：打开默认进大盘情绪」）。
        // 用户的实际诉求相反——「重新打开应停在我上次那一页，而不是每次都回大盘情绪」。
        // 优先级：URL 带 #/xxx 时 hash 优先（AppShell 的 hash 同步 effect 会 go(hash 页)）；
        // 无 hash（桌面端冷启动就是根地址）时用这份存档恢复。
        // 白名单收敛：存档被手改成不存在的页名时回 market——否则 AppShell 一个分支都不匹配 ⇒ 白屏。
        // 2026-09-29 修正：光校「页名合法」不够，还要校「这页在菜单上还画不画得出来」。
        // 奇门遁甲从一级菜单撤下后，qimen 为保留 #/qimen 直达仍留在 PAGE_TITLES 里 ⇒ 旧存档的
        // "qimen" 照样通过白名单 ⇒ 冷启动闪出用户已经删掉的页面。菜单上没有的页回 market；
        // hash 直达（#/qimen）走 AppShell 的 hash 同步，不经过这里，因此不受影响。
        page: (PAGE_TITLES as Record<string, string | undefined>)[s.page] && isMenuVisible(s.page)
          ? s.page
          : "market",
        sidebarCollapsed: s.sidebarCollapsed,
        focusSymbol: s.focusSymbol,
        marketTab: s.marketTab === "HK" || s.marketTab === "US" ? s.marketTab : "A",
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
        // 持仓上下文与 assistantMode 同类（长期偏好，刷新后还在）。落盘前过一遍白名单清洗：
        // 存档被手改成乱值时收敛成 null，绝不让一个「openDate: 昨天」进请求体。
        holdCtx: sanitizeHold(s.holdCtx),
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
