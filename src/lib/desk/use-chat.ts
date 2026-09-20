"use client";
// P7-⑤ 三个对话入口（AI 首页 / 智能助手页 / 右下角随问小窗）共用的一份发送逻辑。
//
// 原来每个入口各写一遍 send()：各自的 slice(-12)、各自的快照拼接、各自的错误处理，
// 结果就是「改一处口径要记得改三处」——这一版把发送、流式回填、降级、价格校验收敛成一个 hook，
// 页面只留下自己真正不同的部分（提示词、快照来源、兜底调用）。
import { useCallback, useRef, useState } from "react";
import { useDesk } from "./store";
import { aiConfigured, priceBandOk } from "./ai";
import { streamChat, playTypewriter } from "./chat-stream-client";
import {
  applyEvent, buildPromptMessages, newId, settleRunningSteps, titleFromMessages,
  type ChatMessage, type ChatRequestMessage, type ChatSession,
} from "./chat-core";
import type { StreamEvent } from "./chat-stream-core";
import type { AiSettings } from "./types";

export interface SnapshotResult {
  /** 注入模型的行情上下文（含来源分层），没有数据就返回空串 */
  snapshot: string;
  /** 数量级校验锚点：只有真实报价才允许传（见 ai-context-core.guardPriceOf） */
  guardPrice: number | null;
  /** 本轮识别到的标的，会写进会话，供后续追问沿用 */
  stock?: string;
}

export interface ChatEndpointCfg {
  endpoint: "plain" | "tools";
  /**
   * 系统提示词：各入口口径不同（助手页有生活问答、首页是交易员工具调用），这里只做注入位。
   * 省略＝这一路不在客户端加 system 件：AI 交易员的提示词（含因子目录）由服务端出，两份都发会让模型分不清以哪份为准。
   */
  systemPrompt?: (context: string) => string;
  /** 端点专属参数（mode / focusSymbol / contextWindow） */
  extra?: () => Record<string, unknown>;
  /** 每轮提问前取实时快照；不取则不注入 */
  snapshot?: (session: ChatSession, question: string) => Promise<SnapshotResult | null>;
  /** 流式失败时的非流式兜底：拿全一句真话，而不是干脆不回答 */
  fallback: (ai: AiSettings, messages: ChatRequestMessage[]) => Promise<{ text: string; steps?: ChatMessage["steps"] }>;
  /** AI 未配置时怎么办（页面通常跳设置页） */
  onNotConfigured?: () => void;
}

const FLUSH_MS = 70;

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
    if (!aiConfigured(ai)) {
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
    // 工具端点的系统提示词在服务端（那份带因子目录），所以 systemPrompt 允许省略；
    // 空内容的件一律不发 —— 一个空串 system 会把轻量模型的整轮口径带偏。
    const sysPrompt = cfg.systemPrompt?.(snap?.snapshot || "") ?? "";
    const pieces = buildPromptMessages({ messages: history }, { snapshot: snap?.snapshot || null });
    const prompt: ChatRequestMessage[] = [{ role: "system", content: sysPrompt }, ...pieces];
    const callMessages = prompt.filter((m) => m.content.trim());

    let timer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      patchChatMessage(sessionId, draftId, { content: cur.content, steps: cur.steps, warning: cur.warning, streaming: cur.streaming });
    };
    const scheduleFlush = () => {
      if (timer) return;
      timer = setTimeout(flushNow, FLUSH_MS);
    };
    const onEvent = (ev: StreamEvent) => {
      if (ev.type === "error") streamError = ev.data?.message ?? "未知错误";
      if (ev.type === "delta") sawDelta = true;
      // done 只是把累计全文再回放一遍时丢掉；上游整体返回（没有 delta）时它是唯一的内容来源
      if (ev.type === "done" && sawDelta && (ev.data?.fullText == null || ev.data.fullText === cur.content)) return;
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
        const fb = await cfg.fallback(ai, callMessages);
        usedFallback = true;
        for (const s of fb.steps ?? []) onEvent({ type: "step", data: s });
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
        endpoint: cfg.endpoint,
        messages: callMessages,
        extra: { contextWindow: 12, ...(cfg.extra?.() ?? {}) },
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
          const fb = await cfg.fallback(ai, correctiveMessages);
          cur = { ...cur, content: fb.text };
        } else {
          await streamChat({
            ai,
            endpoint: cfg.endpoint,
            messages: correctiveMessages,
            extra: { contextWindow: 12, ...(cfg.extra?.() ?? {}) },
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
