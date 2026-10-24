"use client";
// P7-⑤ 三个对话入口（AI 首页 / 智能助手页 / 右下角随问小窗）共用的一份发送逻辑。
//
// 原来每个入口各写一遍 send()：各自的 slice(-12)、各自的快照拼接、各自的错误处理，
// 结果就是「改一处口径要记得改三处」——这一版把发送、流式回填、降级、价格校验收敛成一个 hook，
// 页面只留下自己真正不同的部分（提示词、快照来源、兜底调用）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useDesk, watchlistPayload } from "./store";
import { aiChatPlain, aiReady, priceBandOk, resolveChatEndpoint } from "./ai";
import { aiChatTools } from "./quant-api";
import { resumeChat, streamChat, playTypewriter } from "./chat-stream-client";
import {
  applyEvent, buildPromptMessages, clampTurns, DEFAULT_MAX_TURNS, DEFAULT_PROMPT_BUDGET_CHARS, joinWarnings, newId,
  settleRunningSteps, titleFromMessages, type ChatMessage, type ChatRequestMessage, type ChatSession,
} from "./chat-core";
import { stepsFromTrace, type StreamEvent } from "./chat-stream-core";
import type { AiSettings } from "./types";
import type { ChatHorizon, ChatMode } from "./modes";
import type { HoldCtx } from "./hold-core";
import type { MarketScope } from "./market-scope-core";

export interface SnapshotResult {
  /** 注入模型的行情上下文（含来源分层），没有数据就返回空串 */
  snapshot: string;
  /** 数量级校验锚点：只有真实报价才允许传（见 ai-context-core.guardPriceOf） */
  guardPrice: number | null;
  /**
   * R10b：guardPrice 是从哪只票的快照来的。价位校验只有在「本轮答的就是这只票」时才成立——
   * 3014 实测（中国电影卖的怎么样）：客户端候选名切不出「中国电影」，快照落到了分析页
   * 关注品种（另一只千元票）上，拿 1121 元的锚去判 13.55 元的回答＝假幻觉拦截。
   * 没有锚定标的（价是 null）时留空，校验自然不会跑。
   */
  anchorSymbol?: string | null;
  /** 本轮识别到的标的，会写进会话，供后续追问沿用 */
  stock?: string;
}

export interface ChatEndpointCfg {
  /**
   * "auto" = 按服务商能力选：OpenAI 兼容接口走工具调用端点（模型能自己补取数据），
   * 其余服务商（Anthropic / Gemini 原生）退回纯对话端点。
   * 两条路的场景识别与系统预取共用同一份接线（scene-dispatch.prepareSceneTurn），
   * 所以同一个问题在哪个端点判出来的场景、注入哪批数据都一样，差的只是「模型能不能再自己调一次」。
   */
  endpoint: "plain" | "tools" | "auto";
  /**
   * 系统提示词：各入口口径不同（助手页有生活问答、首页是交易员工具调用），这里只做注入位。
   * 省略＝这一路不在客户端加 system 件：AI 交易员的提示词（含因子目录）由服务端出，两份都发会让模型分不清以哪份为准。
   * 端点落到 tools 时这份同样不会发出去（理由同上）。
   */
  systemPrompt?: (context: string) => string;
  /** 端点专属参数（mode / focusSymbol；追问沿用的 sessionSymbol / prevScene 由本 hook 补，页面不用各写一份）
   *  hold：composer 上填的持仓条件（标的/成本/仓位/建仓日期），与 mode/horizon 同批随请求带出
   *  market：LLM 分流的当前市场（A/HK/US），页面取 store.marketTab 在发送那一刻现读 */
  extra?: () => { mode?: ChatMode; focusSymbol?: string; horizon?: ChatHorizon | null; hold?: HoldCtx | null; market?: MarketScope | null };
  /** 每轮提问前取实时快照；不取则不注入 */
  snapshot?: (session: ChatSession, question: string) => Promise<SnapshotResult | null>;
  /**
   * 流式失败时的非流式兜底：拿全一句真话，而不是干脆不回答。
   * 省略＝用 defaultFallback（按端点调 aiChatTools / aiChatPlain，参数与流式那份完全同源）。
   * extras 与流式请求体里那份是同一个来源（含 contextWindow / 自选清单 / 场景沿用字段）：
   * 两条传输必须带同样的输入，否则「降级后答案口径变了」这种问题根本查不出来。
   * steps / intent 是自动调度与场景徽章在非流式下的唯一出口——那条路上没有 SSE 事件可走。
   */
  fallback?: (
    ai: AiSettings,
    messages: ChatRequestMessage[],
    extras: RequestExtras,
  ) => Promise<{ text: string; steps?: ChatMessage["steps"]; intent?: ChatMessage["intent"]; wzDecision?: ChatMessage["wzDecision"]; warning?: string }>;
  /** AI 未配置时怎么办（页面通常跳设置页） */
  onNotConfigured?: () => void;
}

const FLUSH_MS = 70;

// P31：TTL 判定搬进纯核 task-ttl-core（单测不拉 use-chat 这条带 `@/lib` 别名的重依赖链），
// 这里原样转出，本文件内部调用与既有 import 都不用改。
import { TASK_TTL_MS, isRunRefExpired } from "./task-ttl-core";
export { TASK_TTL_MS, isRunRefExpired };

/**
 * 每轮请求统一带的参数。
 * 自选清单必须由浏览器带来（服务端不读 localStorage，也不查账号库）；
 * 清单为空时不用特殊处理——工具层会如实回 missing，而不是猜一个默认清单。
 *
 * sessionSymbol / prevScene 同理：服务端看不到浏览器存档里的会话，追问要沿用上一轮的标的与场景，
 * 只能由这一侧把「上一条助手消息的场景徽章」原样带回去（取值见 send）。
 *
 * P8-⑥ run：本轮流式的留底 id（浏览器生成；服务端拒挂底就按无 run 正常跑，逐字等同 A/B 轮）。
 * P8-⑤ debug：只有调试面板打开才带 true —— 面板关着时请求体与线上字节一致。
 */
function requestExtras(cfgExtra?: { mode?: ChatMode; horizon?: ChatHorizon | null; focusSymbol?: string; sessionSymbol?: string | null; prevScene?: string | null; run?: string; debug?: boolean; images?: string[]; hold?: HoldCtx | null; market?: MarketScope | null }) {
  return {
    contextWindow: DEFAULT_MAX_TURNS,
    watchlist: watchlistPayload(),
    sessionSymbol: null as string | null,
    prevScene: null as string | null,
    ...(cfgExtra ?? {}),
  };
}
export type RequestExtras = ReturnType<typeof requestExtras>;

/**
 * 按端点自带的非流式兜底。
 * 三个入口原来各写一遍这件事，写完就是三份「降级时带哪些参数」的口径 —— 少带一个 scene，
 * 降级后的回答就会悄悄不做场景自动取数，而这种差别只有把两条传输摆在一起比才看得出来。
 * 现在页面不再需要提供兜底：带什么参数由这一处定，和流式那份用的是同一个 extras。
 */
/**
 * 单轮对话的超时上限。
 * 2026-09-26 用户实测：七维框架这类「多源交叉验证」问题要跑十几步工具，原来 120s 会在服务端
 * 跑完「取数轮 + 收口轮」之前就先掐断，用户只看到「未能生成结论」/超时。
 * 与服务端 /api/ai/chat 的 maxDuration（300s）对齐，客户端不再比服务端更早放弃。
 */
const TURN_TIMEOUT_MS = 300_000;

async function defaultFallback(
  endpoint: "plain" | "tools",
  ai: AiSettings,
  messages: ChatRequestMessage[],
  extras: RequestExtras,
): Promise<{ text: string; steps?: ChatMessage["steps"]; intent?: ChatMessage["intent"]; wzDecision?: ChatMessage["wzDecision"]; warning?: string }> {
  const scene = { focusSymbol: extras.focusSymbol ?? null, sessionSymbol: extras.sessionSymbol, prevScene: extras.prevScene };
  if (endpoint === "tools") {
    const r = await aiChatTools(ai, messages, {
      mode: extras.mode, horizon: extras.horizon, focusSymbol: extras.focusSymbol, contextWindow: extras.contextWindow,
      watchlist: extras.watchlist, sessionSymbol: extras.sessionSymbol, prevScene: extras.prevScene, timeoutMs: TURN_TIMEOUT_MS,
      hold: extras.hold, market: extras.market ?? null,
    });
    // 非流式返回的是 trace：归一成与流式 step 事件同一种步骤，时间线才不会两种形状
    return { text: r.content, steps: r.steps ?? stepsFromTrace(r.trace), intent: r.intent, warning: r.warning };
  }
  const r = await aiChatPlain(ai, messages, { timeoutMs: TURN_TIMEOUT_MS, watchlist: extras.watchlist, scene, mode: extras.mode, horizon: extras.horizon, hold: extras.hold, market: extras.market ?? null });
  return { text: r.text, steps: r.steps, intent: r.intent, wzDecision: r.wzDecision, warning: r.warning };
}

// ---------- P8-⑥ 断点续传（刷新/换页后的独有一条补救路） ----------

/** 同一时刻一条草稿只允许一个续传在跑（三个入口共用这一个 Set，防止都挂载时重复续传） */
const resumeInFlight = new Set<string>();

/**
 * 页面刷新后对「带着 runRef 的未收口草稿」发起续传：按 seq 水位补掉丢失的帧。
 *
 * 口径（细则 §2.3 拍板点 1）：续传拿回来就接着画；拿不回来（服务重启 / 超出留底窗口）
 * 只补一条 warning 并把草稿就地收口 —— 绝不自动重问，那等于用户没点的请求替用户点一遍。
 * 判定「未收口」看 runRef 而不是 streaming：store 落盘前会把 streaming 一律抹成 false（防止
 * 永久转圈），所以刷新后活下来的标记恰好只有 runRef —— done/error/收口时它都会被清掉。
 */
async function resumeRound(sessionId: string, msgId: string, run: string, since: number) {
  const find = () =>
    useDesk.getState().sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === msgId) ?? null;
  const patch = (p: Partial<ChatMessage>) => useDesk.getState().patchChatMessage(sessionId, msgId, p);
  let lastSeq = since;
  let closed = false;
  const onEvent = (ev: StreamEvent) => {
    const msg = find();
    if (!msg) return;
    if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
    if (ev.type === "done" || ev.type === "error") closed = true;
    const next = applyEvent({ ...msg, streaming: true }, ev as Parameters<typeof applyEvent>[1]);
    patch({
      content: next.content,
      steps: next.steps,
      warning: next.warning,
      intent: next.intent,
      wzDecision: next.wzDecision,
      debug: next.debug,
      // done/error 之后这条回答就完整了，界面不该再转圈
      // P31：保留原 createdAt（不重置），续传不延长任务生命周期
      streaming: !closed,
      runRef: closed ? undefined : { id: run, lastSeq, createdAt: msg.runRef?.createdAt },
    });
  };
  /** 就地收口：清 runRef、结算还在 running 的步骤，并把「为什么收口」写在 warning 里 */
  const settleWith = (warnText: string) => {
    const msg = find();
    if (!msg) return;
    const next = settleRunningSteps({ ...msg, streaming: false, runRef: undefined });
    patch({
      content: next.content || "（本轮在刷新时中断，此前没有内容；不自动重问。）",
      steps: next.steps,
      warning: joinWarnings([next.warning, warnText]),
      streaming: false,
      runRef: undefined,
    });
  };
  try {
    const rr = await resumeChat({ run, since, onEvent });
    if (closed) return; // done/error 已在 onEvent 里收口
    if (rr.status === "gone") {
      settleWith(`本轮分析已无法续传（服务端未留底：${rr.error ?? "服务重启或超出保留窗口"}），保留断点前内容，不自动重问。`);
    } else if (rr.status === "error") {
      settleWith(`续传失败（${rr.error ?? "未知错误"}），保留断点前内容，不自动重问。`);
    } else {
      settleWith("续传流结束但未收到收尾事件，内容到此处为止。");
    }
  } catch (e) {
    settleWith(`续传失败（${(e as Error).message || "未知错误"}），保留断点前内容，不自动重问。`);
  } finally {
    resumeInFlight.delete(run);
  }
}

/** 挂载后扫一遍所有会话：把上次没跑完、且服务端还认得的草稿接回来（细则拍板点 1：只补帧，不重问）
 * P31 稳智对齐 P2 #14：加任务过期判定——runRef.createdAt 超过 TASK_TTL_MS 就清掉（不续传，只补 warning）。
 */
function resumePendingDrafts() {
  const now = Date.now();
  for (const s of useDesk.getState().sessions) {
    for (const m of s.messages) {
      const ref = m.role === "assistant" ? m.runRef : null;
      if (!ref?.id || resumeInFlight.has(ref.id)) continue;
      // P31：任务过期判定（createdAt 缺失时按"未过期"处理，向后兼容老存档）
      if (isRunRefExpired(ref, now)) {
        // 过期：清掉 runRef + 结算 running 步骤 + 补一条 warning
        const next = settleRunningSteps({ ...m, streaming: false, runRef: undefined });
        useDesk.getState().patchChatMessage(s.id, m.id, {
          content: next.content || "（本轮分析已过期，保留断点前内容；不自动重问。）",
          steps: next.steps,
          warning: joinWarnings([next.warning, "本轮分析已过期（超过 15 分钟未续传），保留断点前内容，不自动重问。"]),
          streaming: false,
          runRef: undefined,
        });
        continue;
      }
      resumeInFlight.add(ref.id);
      void resumeRound(s.id, m.id, ref.id, Number.isFinite(ref.lastSeq) ? Math.max(0, Math.trunc(ref.lastSeq)) : 0);
    }
  }
}

export function useChatSend(cfg: ChatEndpointCfg) {
  const ai = useDesk((s) => s.ai);
  const sessions = useDesk((s) => s.sessions);
  const activeSessionId = useDesk((s) => s.activeSessionId);
  const newSession = useDesk((s) => s.newSession);
  const addChatMessage = useDesk((s) => s.addChatMessage);
  const patchChatMessage = useDesk((s) => s.patchChatMessage);
  const setSessionStock = useDesk((s) => s.setSessionStock);
  // P8-⑤：调试面板开关（默认关、本机持久化）。开着时请求体多带 debug:true，路由才会轮末重发富化帧。
  const debugPanel = useDesk((s) => s.debugPanel);

  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  // P8-⑥：本轮留底 id —— 停止按钮要把它带给服务端（显式停止是唯一能提前取消上游的出口）
  const activeRunRef = useRef<string | null>(null);

  useEffect(() => {
    resumePendingDrafts();
  }, []);

  const stop = useCallback(() => {
    const run = activeRunRef.current;
    activeRunRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    // 挂了 run 的这一轮，断开连接本身不再取消上游（细则拍板点 3：上游跑完并留底，刷新后还能续传）；
    // 所以「停止」必须显式通知服务端取消，否则点了停止数据还在继续取。fire-and-forget：通知失败不影响本机停止。
    if (run) {
      void fetch("/api/ai/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", run }),
      }).catch(() => { /* 服务端会随 done/超时自然收尾，这里只是提前打招呼 */ });
    }
  }, []);

  const send = useCallback(async (raw: string, images?: string[]) => {
    const content = (raw ?? "").trim();
    if (!content || busyRef.current) return;
    if (!aiReady(ai)) {
      cfg.onNotConfigured?.();
      return;
    }
    busyRef.current = true;
    setBusy(true);

    // 发送时才读最新会话：React 19 的 lint 规则不允许渲染期往 ref 里写，
    // 而 store 本身就是可读的当前值，没必要再造一份「快照」。
    const allSessions = useDesk.getState().sessions;
    let sessionId = activeSessionId;
    if (!sessionId || !allSessions.some((s) => s.id === sessionId)) sessionId = newSession();
    const session = allSessions.find((s) => s.id === sessionId) ?? { id: sessionId, title: "新会话", messages: [], createdAt: Date.now(), updatedAt: Date.now() };

    const userMsg: ChatMessage = { id: newId("u"), role: "user", content, ts: Date.now() };
    addChatMessage(sessionId, userMsg);
    const draftId = newId("a");
    const history: ChatMessage[] = [...session.messages, userMsg];
    // P8-⑥：本轮流式的留底 id。服务端若拒挂（同 id 已有底 / 留底位满）就当没挂底正常跑 ——
    // 那一轮的帧不带 seq，下面的续传门槛（resumeSince>0）自然不会触发，行为逐字回落到 A/B。
    const runId = newId("r");
    activeRunRef.current = runId;

    let snap: SnapshotResult | null = null;
    try {
      snap = (await cfg.snapshot?.(session, content)) ?? null;
    } catch {
      snap = null; // 快照取失败 = 本轮没有行情上下文，交给 MISSING 口径，不能拿旧数据顶上
    }
    if (snap?.stock) setSessionStock(sessionId, { stock: snap.stock });

    // 草稿消息：界面从一开始就在，流式过程是对它的连续 patch
    let cur: ChatMessage = { id: draftId, role: "assistant", content: "", ts: Date.now(), streaming: true };
    addChatMessage(sessionId, cur);
    // 正文是否已逐帧到达：决定 done 事件是「回放」还是「唯一的内容来源」（见 onEvent）
    let sawDelta = false;
    let usedFallback = false;
    // 兜底一轮最多跑一次：续传失败会落兜底，原来的「events===0 也算流式失败」判定也可能落兜底，
    // 两条路都放行就会出现「同一句话重答两遍」。
    let fallbackStarted = false;
    let streamError: string | null = null;
    // P8-⑥ 的三份流水账：收尾与否 / seq 水位（>0 = 服务端认了本轮挂底，续传才有意义）/ 续传已放弃（不再走兜底）
    let sawDone = false;
    let resumeSince = 0;
    let resumeGaveUp = false;
    // 本轮走哪个端点定一次（同一轮里流式、兜底、价位重生成用的是同一个，见下面的 endpoint 用法）。
    // P7-⑩：判定并进 resolveChatEndpoint —— 走服务端 .env 通道时它按模式定 tools/plain，
    // 浏览器凭据齐的旧行为（按服务商能力选）一字不变。
    const endpoint = resolveChatEndpoint(ai, cfg.endpoint);
    const runNonStream = (messages: ChatRequestMessage[], e: RequestExtras) =>
      cfg.fallback ? cfg.fallback(ai, messages, e) : defaultFallback(endpoint, ai, messages, e);
    // 工具端点的系统提示词在服务端（那份带因子目录），所以落到 tools 时不发客户端这份；
    // 空内容的件一律不发 —— 一个空串 system 会把轻量模型的整轮口径带偏。
    const sysPrompt = endpoint === "tools" ? "" : (cfg.systemPrompt?.(snap?.snapshot || "") ?? "");
    // 场景只看最后一条带徽章的助手消息 —— 更早的那轮已经答完了，
    // 拿它的场景去套新问题等于把用户没问的口径带进这一轮。
    const prevIntent = [...session.messages].reverse().find((m) => m.role === "assistant" && m.intent)?.intent ?? null;
    // 标的却是「本会话里最近一次真正问过的那只」，不能跟着场景一起只看上一轮：
    // 浏览器实测（3014 + 假上游）先问「688256 现在什么价」、再点一句没带标的的快捷问、
    // 然后问「那它明天怎么看」，标的被中间那轮清空，退到分析页当前品种 600519.SH，
    // 于是「它」答成了另一只票 —— 徽章上写的还是「分析页当前品种」，用户看不出答错了对象。
    const sessionSymbol = [...session.messages].reverse().find((m) => m.role === "assistant" && m.intent?.symbol)?.intent?.symbol ?? null;
    // 本轮的请求参数算一次就够：流式、兜底、价位重生成三份必须完全一致，
    // 否则同一次提问在不同传输下带的上下文窗口/自选清单都可能不同，答案对不上就没法解释。
    const extras = requestExtras({
      ...(cfg.extra?.() ?? {}),
      // 追问（「那它明天怎么看」「帮我看看刚才那只」）要沿用的东西，全部从助手消息的场景徽章里取：
      // 不新增会话字段 —— 会话上只记代码，场景一旦记在会话上，第 20 轮的追问会继承第 1 轮的场景。
      sessionSymbol: sessionSymbol ?? session.stock ?? null,
      prevScene: prevIntent?.scene ?? null,
      // P8-⑥：留底 id 与问题一起送过去（非流式兜底不带 —— JSON 那条路压根不碰 RunBus，见细则 §2.6）。
      run: runId,
      // P8-⑤：面板没开就一个 debug 键都不带，线上请求体与 A/B 轮逐字节一致。
      ...(debugPanel ? { debug: true } : {}),
      // P34：图片多模态（base64 data URL 数组），有图才带；没图时 body 里不会有 images 键
      ...(images && images.length > 0 ? { images } : {}),
    });
    // 本地裁窗的轮数与服务端兜底裁窗用的是同一个值（extras.contextWindow），两边各写一套迟早对不上。
    const pieces = buildPromptMessages({ messages: history }, {
      maxTurns: clampTurns(extras.contextWindow),
      snapshot: snap?.snapshot || null,
      budgetChars: DEFAULT_PROMPT_BUDGET_CHARS,
      // 本入口这份提示词吃的额度要计进预算；服务端那份（工具目录）不在此列，所以预算本身取的是保守值。
      reservedChars: sysPrompt.length,
    });
    const prompt: ChatRequestMessage[] = [{ role: "system", content: sysPrompt }, ...pieces];
    const callMessages = prompt.filter((m) => m.content.trim());

    let timer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      // intent 也得一起 patch：场景徽章是 done 事件（或兜底返回）之后才有的，漏了它界面就永远不显示
      // runRef 随同一次 70ms 刷盘捎带（细则 §2.4）：不单独加一次写盘 —— 它就是这一轮的「未收口」标记，
      // 刷新后全靠它认出哪条草稿可以续传。
      // debug 同样必须在这份名单里：onEvent 把 done.debug 收进 cur 后，白名单漏了它
      // 结论小节就永远「未留底」——浏览器走查实测（富化入参/摘要都在、唯独结论空）钉出的这条。
      patchChatMessage(sessionId, draftId, { content: cur.content, steps: cur.steps, warning: cur.warning, intent: cur.intent, wzDecision: cur.wzDecision, debug: cur.debug, streaming: cur.streaming, runRef: cur.runRef });
    };
    const scheduleFlush = () => {
      if (timer) return;
      timer = setTimeout(flushNow, FLUSH_MS);
    };
    const onEvent = (ev: StreamEvent) => {
      // P8-⑥：seq 水位在这里记（去重在传输层 chat-stream-client 已做，这里只攒「续传从哪接」）
      if (typeof ev.seq === "number" && ev.seq > resumeSince) resumeSince = ev.seq;
      if (ev.type === "done") sawDone = true;
      if (ev.type === "error") streamError = ev.data?.message ?? "未知错误";
      if (ev.type === "delta") sawDelta = true;
      // runRef 只在收到带 seq 的帧后出现（= 服务端真认了这轮挂底）；done/error 一到就清 —— 收口的消息不留续传钩子
      // P31 稳智对齐 P2 #14：runRef 加 createdAt（任务过期判定用）
      const runPatch =
        ev.type === "done" || ev.type === "error"
          ? { runRef: undefined }
          : typeof ev.seq === "number"
            ? { runRef: { id: runId, lastSeq: resumeSince, createdAt: cur.runRef?.createdAt ?? Date.now() } }
            : null;
      // done 只是把累计全文再回放一遍时丢掉内容 —— 但它同时带着场景徽章，徽章不能跟着一起丢：
      // 浏览器实测（首页发一句「今天大盘情绪怎么样」）就是这么发现「有步骤、没徽章」的：
      // 流式那一轮 fullText 与已攒内容相同 → 整件事件被 return 掉，intent 也就没了。
      if (ev.type === "done" && sawDelta && (ev.data?.fullText == null || ev.data.fullText === cur.content)) {
        // runRef 的清除走在「没徽章就整件丢掉」之前（p7-dispatch 钉住的那句原文一字不动）：
        // done 到了这轮就收口，续传钩子的摘除与徽章在不在没有关系。
        if (runPatch) {
          cur = { ...cur, ...runPatch };
          scheduleFlush();
        }
        // 结论留底也走在「没徽章就整件丢掉」之前（浏览器走查实测：富化帧到了、结论行却报「未留底」——
        // 就是这个回放分支只捡 intent、把 done.debug 落在了原地）。p7-dispatch 钉住的那句原文一字不动。
        if (ev.data?.debug) {
          cur = { ...cur, debug: ev.data.debug };
          scheduleFlush();
        }
        // P19 稳智决策信号：与 intent/debug 同口径，一起捡走，别掉在原地
        if (ev.data?.wzDecision) {
          cur = { ...cur, wzDecision: ev.data.wzDecision };
          scheduleFlush();
        }
        if (!ev.data?.intent) return;
        cur = { ...cur, intent: ev.data.intent };
        scheduleFlush();
        return;
      }
      cur = { ...applyEvent(cur, ev as Parameters<typeof applyEvent>[1]), ...(runPatch ?? {}) };
      scheduleFlush();
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    /**
     * 非流式兜底：拿全一句真话，而不是干脆不回答。
     * 说清楚两件事 —— 这次是「一次性返回」（不是上游在逐字流），以及逐字效果来自本机展示节奏。
     */
    const runFallback = async (reason: string) => {
      if (ctrl.signal.aborted || fallbackStarted) return;
      fallbackStarted = true;
      onEvent({ type: "warning", data: { text: `流式未完成（${reason}），已改用整体请求。` } });
      try {
        const fb = await runNonStream(callMessages, extras);
        usedFallback = true;
        for (const s of fb.steps ?? []) onEvent({ type: "step", data: s });
        // 非流式那条路上 done 事件是不带徽章的（服务端把它放在 JSON 字段里），不接进来徽章就只会在降级时消失
        if (fb.intent) cur = { ...cur, intent: fb.intent };
        if (fb.wzDecision) cur = { ...cur, wzDecision: fb.wzDecision };
        if (fb.warning) onEvent({ type: "warning", data: { text: fb.warning } });
        onEvent({ type: "warning", data: { text: "以下为一次性返回，逐字效果来自本机展示节奏，不是上游流式。" } });
        await playTypewriter(fb.text, (partial) => {
          cur = { ...cur, content: partial };
          scheduleFlush();
        }, { shouldStop: () => ctrl.signal.aborted });
        cur = { ...cur, content: fb.text };
        flushNow();
      } catch (e2) {
        onEvent({ type: "error", data: { message: (e2 as Error).message || reason } });
      }
    };

    /**
     * P8-⑥：流断了但本轮挂了底 → 先续传一次，仍不行才落整体兜底（顺序只插不改，见细则 §2.5）。
     * 续传帧与断点前那批走的是同一个 onEvent：seq 去重、runRef 水位、徽章收口全部复用。
     * gone（服务端没底了）按拍板点 1 只 warning 收口，不再重问 —— 所以置 resumeGaveUp 挡住下面的兜底。
     */
    const tryResumeOnce = async (reason: string) => {
      let rr: Awaited<ReturnType<typeof resumeChat>>;
      try {
        rr = await resumeChat({ run: runId, since: resumeSince, onEvent, signal: ctrl.signal });
      } catch (e2) {
        rr = { status: "error" as const, usedStream: false, fullText: "", error: (e2 as Error).message, events: 0 };
      }
      if (ctrl.signal.aborted) return;
      if (rr.status === "gone") {
        resumeGaveUp = true;
        onEvent({ type: "warning", data: { text: `本轮分析已无法续传（${rr.error ?? "服务端未留底"}），保留断点前内容，不自动重问。` } });
        return;
      }
      if (rr.status === "error" || (!sawDone && rr.events === 0)) {
        await runFallback(`续传失败：${rr.error || reason || "续传流无新事件"}`);
      }
    };

    try {
      const result = await streamChat({
        ai,
        endpoint,
        messages: callMessages,
        extra: extras,
        onEvent,
        timeoutMs: TURN_TIMEOUT_MS,
        signal: ctrl.signal,
      });
      // P8-⑥：有帧进来但流在 done 前断了、且服务端认了这轮挂底（收到过带 seq 的帧 ⇒ resumeSince>0）
      // → 先续传一次补掉丢失的帧。没挂底（run 被拒 / 非流式）时 resumeSince 恒为 0，逐字走原来的老路径。
      if (!ctrl.signal.aborted && !sawDone && result.events > 0 && resumeSince > 0) {
        await tryResumeOnce(result.error || "流在 done 前断开");
      }
      // 一帧都没进来（代理断流 / 网关吞了长连接）＝这次不能算流式成功，走非流式兜底
      // 续传已判定「服务端没底了」的那一轮也走这里 —— 但 done 已到或已放弃续传时不再重答一遍
      if (!ctrl.signal.aborted && !sawDone && !resumeGaveUp && (result.events === 0 || (result.error && !result.fullText))) {
        await runFallback(result.error || "流式未送达任何事件");
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        onEvent({ type: "warning", data: { text: "已手动停止，回答到此处为止（未补全）。" } });
      } else if (!sawDone && resumeSince > 0) {
        // 抛异常这条路原来直接落兜底；挂了底的这一轮先给续传一次机会（顺序只插不改）
        await tryResumeOnce((e as Error).message || "未知错误");
      } else {
        await runFallback((e as Error).message || "未知错误");
      }
    }

    // ---------- 价格数量级校验（沿用 P6-A 的锚点口径：只有真实报价能当锚点） ----------
    // R10b 的适用性闸：锚点必须是「本轮回答的那只票」的报价。服务端场景徽章带着本轮真实标的
    // （intent.symbol，含公司名解析出的），若它和客户端快照锚定的标的（anchorSymbol）对不上——
    // 说明快照锚错了对象（3014 实测：问中国电影、快照落在分析页关注品种上），这时校验没有资格
    // 判幻觉：跳过，而不是拿别人家的价格逼模型重答一遍。intent 没有标的时维持原判定。
    const code6 = (s: string | null | undefined) => (s ?? "").match(/\d{6}/)?.[0] ?? null;
    const anchorMismatch = !!cur.intent?.symbol && !!snap?.anchorSymbol && code6(cur.intent.symbol) !== code6(snap.anchorSymbol);
    const guard = anchorMismatch ? null : snap?.guardPrice ?? null;
    if (!ctrl.signal.aborted && guard && cur.content && !priceBandOk(cur.content, guard)) {
      const correctiveMsg = `警告：你上一次回答中的价位与实时行情快照严重不符（最新价应为 ${guard.toFixed(2)} 元），属于幻觉，已被系统拦截。重新回答：所有价位只允许来自快照，数量级必须与最新价一致。`;
      onEvent({ type: "warning", data: { text: `回答里的价格和实时行情对不上（最新价应在 ${guard.toFixed(2)} 元附近），已提醒模型重答一次` } });
      flushNow();
      cur = { ...cur, content: "" };
      const correctiveMessages = [...callMessages, { role: "system" as const, content: correctiveMsg }];
      try {
        if (usedFallback) {
          // 上游流式本来就没走通，重生成继续走整体请求，别再试第二次流式
          const fb = await runNonStream(correctiveMessages, extras);
          cur = { ...cur, content: fb.text };
        } else {
          await streamChat({
            ai,
            endpoint,
            messages: correctiveMessages,
            extra: extras,
            onEvent,
            timeoutMs: TURN_TIMEOUT_MS,
            signal: ctrl.signal,
          });
        }
      } catch {
        /* 重试失败保留原文，下面照样标注 */
      }
      if (!priceBandOk(cur.content, guard)) {
        onEvent({
          type: "warning",
          data: { text: `本回答中的价位与实时行情可能不符，请以快照中的最新价 ${guard.toFixed(2)} 元为准。` },
        });
      }
      flushNow();
    }

    // 本轮到此收口：runRef 一并清掉 —— 收口的消息没有「未跑完的续传」这回事，刷新后不该再被扫起来
    cur = settleRunningSteps({ ...cur, streaming: false, runRef: undefined });
    // 一个字都没有：把失败原因写在正文里，而不是留一条空回答让人以为「模型没话说」
    if (!cur.content) cur = { ...cur, content: streamError ? `本次请求失败：${streamError}` : "（本次没有收到任何内容）" };
    flushNow();
    // 会话标题：迁移来的旧会话或手工建的空会话，第一轮问答后按首条提问补齐
    const titled = useDesk.getState().sessions.find((x) => x.id === sessionId);
    if (titled && (!titled.title || titled.title === "新会话")) {
      patchChatMessage(sessionId, draftId, { content: cur.content });
      setSessionStock(sessionId, { stock: snap?.stock ?? titled.stock });
      useDesk.setState((s) => ({
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, title: titleFromMessages(x.messages) } : x)),
      }));
    }
    abortRef.current = null;
    activeRunRef.current = null;
    busyRef.current = false;
    setBusy(false);
  }, [ai, activeSessionId, addChatMessage, cfg, debugPanel, newSession, patchChatMessage, setSessionStock]);

  return { send, busy, stop, sessions, activeSessionId };
}
