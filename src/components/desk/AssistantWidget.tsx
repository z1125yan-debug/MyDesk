"use client";
// 右下角浮动智能助手小窗：与分析页侧栏、智能助手页共用同一份会话记录
// P7-⑤：发送逻辑收敛到 useChatSend（同一套流式回填 / 降级 / 步骤时间线），小窗只保留图表上下文注入。
// P7-⑥⑥：端点改成 auto（按服务商能力选，不再固定 plain），兜底也交回 useChatSend 的默认实现。
// 之前小窗固定纯对话端点、首页固定工具端点，同一句问题在两个入口拿到的能力不同；
// 现在三个入口的端点选择、场景调度与降级参数都出自同一处，小窗独有的只剩「当前图表上下文」。
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, MessagesSquare, Send, Square, X } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured, assistantSystemPrompt } from "@/lib/desk/ai";
import { fetchNewsBlock } from "@/lib/desk/market";
import type { ChatMessage } from "@/lib/desk/chat-core";
import { useChatSend } from "@/lib/desk/use-chat";
import { pickChatEndpoint } from "@/lib/desk/chat-stream-core";
import Markdown from "./Markdown";
import SceneBadge from "./SceneBadge";
import StepTimeline from "./StepTimeline";

const CHIPS = ["关键位在哪", "多周期趋势总结", "现在适合进场吗", "给我一个风控清单"];

export default function AssistantWidget({
  onClose,
  chartContext,
}: {
  onClose: () => void;
  chartContext: () => string;
}) {
  const newSession = useDesk((s) => s.newSession);
  const go = useDesk((s) => s.go);
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);

  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // 小窗的快照来自分析页当前图表（含品种与实时字段）；快讯每次现取，失败就只带图表那一段。
  // guardPrice 留空：图表上下文的组成由分析页决定，小窗不去猜锚点，宁可不校验也不拿可疑数字当现价的量级标准。
  const snapshot = useCallback(async (): Promise<{ snapshot: string; guardPrice: null }> => {
    const chart = chartContext();
    const news = await fetchNewsBlock().catch(() => "");
    return {
      snapshot: [chart ? `[当前图表实时数据]\n${chart}` : "", news].filter(Boolean).join("\n\n"),
      guardPrice: null,
    };
  }, [chartContext]);

  const { send, busy, stop, sessions, activeSessionId } = useChatSend({
    // 与助手页同一个口径：能力够就走工具调用环，否则退回纯对话端点，两条路共用同一份场景接线
    endpoint: "auto",
    systemPrompt: assistantSystemPrompt,
    snapshot,
    // 小窗挂在分析页上，「这只股」指的就是图表里那只：交给服务端，并如实标注来源
    // 回答风格取 store 里那份共享设置（小窗不另画一套选择器，但也不能默默用别的口径）
    extra: () => ({ focusSymbol, mode: useDesk.getState().assistantMode }),
    onNotConfigured: () => go("settings"),
  });

  // 界面要如实写明这一轮走的是哪条端点：工具环不是所有服务商都有，不能话术上假装都有
  const toolsOn = pickChatEndpoint(ai.provider, "auto") === "tools";

  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages: ChatMessage[] = session?.messages ?? [];
  const configured = aiConfigured(ai);

  const submit = (preset?: string) => {
    const content = (preset ?? input).trim();
    if (!content) return;
    setInput("");
    void send(content);
  };

  const tail = `${messages.length}:${messages.at(-1)?.content.length ?? 0}`;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [tail]);

  return (
    <div className="fixed bottom-5 right-5 z-[90] flex h-[520px] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600">
            <Bot size={14} className="text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">智能助手 · 随问</div>
            <div className="truncate text-[10.5px] text-muted-foreground">
              {session?.title} · {session?.stock ?? focusSymbol} · {toolsOn ? "工具调用端点" : "纯对话端点（该服务商无工具环）"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => { newSession(); }}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            新会话
          </button>
          {/* 会话记录本来就共享：这里只是把那页铺满，不是「换一条链重问一遍」 */}
          <button onClick={() => { go("copilot"); onClose(); }} title="在助手页继续（同一份会话）"
            className="rounded-md border border-border p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <MessagesSquare size={14} />
          </button>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="收起">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 消息区：与智能助手页同一种渲染（会话共用，所以这里看到的和那页看到的是同一份记录） */}
      <div className="desk-scroll flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-[13px] font-medium">问点什么吧</div>
            <div className="text-[11.5px] text-muted-foreground">上下文自动带入当前图表品种与行情</div>
            <div className="flex max-w-[300px] flex-wrap justify-center gap-1.5 pt-1">
              {CHIPS.map((q) => (
                <button key={q} onClick={() => submit(q)} disabled={!configured}
                  className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "user" ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-sky-500/90 px-3 py-2 text-[12.5px] leading-5 text-white">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[92%] rounded-lg border border-border bg-background/70 px-3 py-2 text-[12.5px] leading-5">
                <SceneBadge intent={m.intent} />
                <Markdown content={m.content} />
                {m.streaming && <span className="ml-0.5 inline-block h-3.5 w-[6px] translate-y-0.5 animate-pulse bg-sky-400" />}
                <StepTimeline steps={m.steps} warning={m.warning} streaming={m.streaming} />
              </div>
            )}
          </div>
        ))}
        {!configured && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
            未配置 AI 接口：到「设置 → AI 接口」填写后才能对话。
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* 快捷指令 + 输入 */}
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 pt-2">
        {CHIPS.map((q) => (
          <button key={q} onClick={() => submit(q)} disabled={busy || !configured}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 p-2.5">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          placeholder={configured ? "问智能助手…（流式，可停止）" : "先去设置配置 AI 接口"}
          disabled={!configured}
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-[12.5px] outline-none focus:border-sky-500/60 disabled:opacity-60" />
        {busy ? (
          <button onClick={stop} title="停止本次回答（保留已生成的部分）"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
            <Square size={14} />
          </button>
        ) : (
          <button onClick={() => submit()} disabled={!configured}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50">
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
