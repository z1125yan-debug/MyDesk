"use client";
// P7-⑤ 三个对话入口（AI 首页 / 智能助手页 / 右下角随问小窗）共用的一份发送逻辑。
//
// 原来每个入口各写一遍 send()：各自的 slice(-12)、各自的快照拼接、各自的错误处理，
// 结果就是「改一处口径要记得改三处」——这一版把发送、流式回填、降级、价格校验收敛成一个 hook，
// 页面只留下自己真正不同的部分（提示词、快照来源、兜底调用）。
import { useCallback, useRef, useState } from "react";
import { useDesk, watchlistPayload } from "./store";
import { aiChatPlain, aiReady, priceBandOk, resolveChatEndpoint } from "./ai";
import { aiChatTools } from "./quant-api";
import { streamChat, playTypewriter } from "./chat-stream-client";
import {
  applyEvent, buildPromptMessages, clampTurns, DEFAULT_MAX_TURNS, DEFAULT_PROMPT_BUDGET_CHARS, newId,
  settleRunningSteps, titleFromMessages, type ChatMessage, type ChatRequestMessage, type ChatSession,
} from "./chat-core";
import { stepsFromTrace, type StreamEvent } from "./chat-stream-core";
import type { AiSettings } from "./types";
import type { ChatMode } from "./modes";

export interface SnapshotResult {
  /** 注入模型的行情上下文（含来源分层），没有数据就返回空串 */
  snapshot: string;
  /** 数量级校验锚点：只有真实报价才允许传（见 ai-context-core.guardPriceOf） */
  guardPrice: number | null;
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
  /** 端点专属参数（mode / focusSymbol；追问沿用的 sessionSymbol / prevScene 由本 hook 补，页面不用各写一份） */
  extra?: () => { mode?: ChatMode; focusSymbol?: string };
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
  ) => Promise<{ text: string; steps?: ChatMessage["steps"]; intent?: ChatMessage["intent"]; warning?: string }>;
  /** AI 未配置时怎么办（页面通常跳设置页） */
  onNotConfigured?: () => void;
}

const FLUSH_MS = 70;

/**
 * 每轮请求统一带的参数。
 * 自选清单必须由浏览器带来（服务端不读 localStorage，也不查账号库）；
 * 清单为空时不用特殊处理——工具层会如实回 missing，而不是猜一个默认清单。
 *
 * sessionSymbol / prevScene 同理：服务端看不到浏览器存档里的会话，追问要沿用上一轮的标的与场景，
 * 只能由这一侧把「上一条助手消息的场景徽章」原样带回去（取值见 send）。
 */
function requestExtras(cfgExtra?: { mode?: ChatMode; focusSymbol?: string; sessionSymbol?: string | null; prevScene?: string | null }) {
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
async function defaultFallback(
  endpoint: "plain" | "tools",
  ai: AiSettings,
  messages: ChatRequestMessage[],
  extras: RequestExtras,
): Promise<{ text: string; steps?: ChatMessage["steps"]; intent?: ChatMessage["intent"]; warning?: string }> {
  const scene = { focusSymbol: extras.focusSymbol ?? null, sessionSymbol: extras.sessionSymbol, prevScene: extras.prevScene };
  if (endpoint === "tools") {
    const r = await aiChatTools(ai, messages, {
      mode: extras.mode, focusSymbol: extras.focusSymbol, contextWindow: extras.contextWindow,
      watchlist: extras.watchlist, sessionSymbol: extras.sessionSymbol, prevScene: extras.prevScene, timeoutMs: 120_000,
    });
    // 非流式返回的是 trace：归一成与流式 step 事件同一种步骤，时间线才不会两种形状
    return { text: r.content, steps: r.steps ?? stepsFromTrace(r.trace), intent: r.intent, warning: r.warning };
  }
  const r = await aiChatPlain(ai, messages, { timeoutMs: 120_000, watchlist: extras.watchlist, scene });
  return { text: r.text, steps: r.steps, intent: r.intent, warning: r.warning };
}

export function useChatSend(cfg: ChatEndpointCfg) {
  const ai = useDesk((s) => s.ai);
  const sessions = useDesk((s) => s.sessions);
  const activeSessionId = useDesk((s) => s.activeSessionId);
  const newSession = useDesk((s) => s.newSession);
  const addChatMessage = useDesk((s) => s.addChatMessage);
  const patchChatMessage = useDesk((s) => s.patchChatMessage);
  const setSessionStock = useDesk((s) => s.setSessionStock);

  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(async (raw: string) => {
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
    let streamError: string | null = null;
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
      patchChatMessage(sessionId, draftId, { content: cur.content, steps: cur.steps, warning: cur.warning, intent: cur.intent, streaming: cur.streaming });
    };
    const scheduleFlush = () => {
      if (timer) return;
      timer = setTimeout(flushNow, FLUSH_MS);
    };
    const onEvent = (ev: StreamEvent) => {
      if (ev.type === "error") streamError = ev.data?.message ?? "未知错误";
      if (ev.type === "delta") sawDelta = true;
      // done 只是把累计全文再回放一遍时丢掉内容 —— 但它同时带着场景徽章，徽章不能跟着一起丢：
      // 浏览器实测（首页发一句「今天大盘情绪怎么样」）就是这么发现「有步骤、没徽章」的：
      // 流式那一轮 fullText 与已攒内容相同 → 整件事件被 return 掉，intent 也就没了。
      if (ev.type === "done" && sawDelta && (ev.data?.fullText == null || ev.data.fullText === cur.content)) {
        if (!ev.data?.intent) return;
        cur = { ...cur, intent: ev.data.intent };
        scheduleFlush();
        return;
      }
      cur = applyEvent(cur, ev as Parameters<typeof applyEvent>[1]);
      scheduleFlush();
    };

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    /**
     * 非流式兜底：拿全一句真话，而不是干脆不回答。
     * 说清楚两件事 —— 这次是「一次性返回」（不是上游在逐字流），以及逐字效果来自本机展示节奏。
     */
    const runFallback = async (reason: string) => {
      if (ctrl.signal.aborted) return;
      onEvent({ type: "warning", data: { text: `流式未完成（${reason}），已改用整体请求。` } });
      try {
        const fb = await runNonStream(callMessages, extras);
        usedFallback = true;
        for (const s of fb.steps ?? []) onEvent({ type: "step", data: s });
        // 非流式那条路上 done 事件是不带徽章的（服务端把它放在 JSON 字段里），不接进来徽章就只会在降级时消失
        if (fb.intent) cur = { ...cur, intent: fb.intent };
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

    try {
      const result = await streamChat({
        ai,
        endpoint,
        messages: callMessages,
        extra: extras,
        onEvent,
        signal: ctrl.signal,
      });
      // 一帧都没进来（代理断流 / 网关吞了长连接）＝这次不能算流式成功，走非流式兜底
      if (!ctrl.signal.aborted && (result.events === 0 || (result.error && !result.fullText))) {
        await runFallback(result.error || "流式未送达任何事件");
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        onEvent({ type: "warning", data: { text: "已手动停止，回答到此处为止（未补全）。" } });
      } else {
        await runFallback((e as Error).message || "未知错误");
      }
    }

    // ---------- 价格数量级校验（沿用 P6-A 的锚点口径：只有真实报价能当锚点） ----------
    const guard = snap?.guardPrice ?? null;
    if (!ctrl.signal.aborted && guard && cur.content && !priceBandOk(cur.content, guard)) {
      const correctiveMsg = `警告：你上一次回答中的价位与实时行情快照严重不符（最新价应为 ${guard.toFixed(2)} 元），属于幻觉，已被系统拦截。重新回答：所有价位只允许来自快照，数量级必须与最新价一致。`;
      onEvent({ type: "warning", data: { text: `价位校验未通过（应为 ${guard.toFixed(2)} 元量级），已带警告重新生成一次。` } });
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

    cur = settleRunningSteps({ ...cur, streaming: false });
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
    busyRef.current = false;
    setBusy(false);
  }, [ai, activeSessionId, addChatMessage, cfg, newSession, patchChatMessage, setSessionStock]);

  return { send, busy, stop, sessions, activeSessionId };
}
