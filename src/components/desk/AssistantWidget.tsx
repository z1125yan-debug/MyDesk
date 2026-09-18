"use client";
// 右下角浮动智能助手小窗：与分析页侧栏、智能助手页共用同一份会话记录
import { useEffect, useRef, useState } from "react";
import { Bot, Send, X, Loader2, Plus } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { aiChat, aiConfigured, assistantSystemPrompt } from "@/lib/desk/ai";
import { fetchNewsBlock } from "@/lib/desk/market";
import Markdown from "./Markdown";

const CHIPS = ["关键位在哪", "多周期趋势总结", "现在适合进场吗", "给我一个风控清单"];

export default function AssistantWidget({
  onClose,
  chartContext,
}: {
  onClose: () => void;
  chartContext: () => string;
}) {
  const chats = useDesk((s) => s.chats);
  const activeChat = useDesk((s) => s.activeChat);
  const setChats = useDesk((s) => s.setChats);
  const newChat = useDesk((s) => s.newChat);
  const ai = useDesk((s) => s.ai);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = chats[activeChat] ?? [];
  const configured = aiConfigured(ai);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, busy]);

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim();
    if (!content || busy) return;
    setBusy(true); setInput("");
    const base = chats.map((c, i) => (i === activeChat ? [...c, { role: "user" as const, content, ts: Date.now() }] : c));
    setChats(base);
    try {
      const snapshot = chartContext();
      const news = await fetchNewsBlock();
      const sent = [...base[activeChat].slice(-12)];
      const lastMsg = sent[sent.length - 1];
      sent[sent.length - 1] = {
        ...lastMsg,
        content: snapshot ? `${lastMsg.content}\n\n[当前图表实时数据]\n${snapshot}` : lastMsg.content,
      };
      const reply = await aiChat(ai, [
        { role: "system", content: assistantSystemPrompt([snapshot, news].filter(Boolean).join("\n\n")) },
        ...sent.map((m) => ({ role: m.role, content: m.content })),
      ]);
      setChats(base.map((c, i) => (i === activeChat ? [...c, { role: "assistant" as const, content: reply, ts: Date.now() }] : c)));
    } catch (e) {
      setChats(base.map((c, i) => (i === activeChat ? [...c, { role: "assistant" as const, content: `请求出错：${(e as Error).message}`, ts: Date.now() }] : c)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-[90] flex h-[520px] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600">
            <Bot size={14} className="text-white" />
          </div>
          <span className="text-[13px] font-semibold">智能助手 · 随问</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={newChat}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            新会话
          </button>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="收起">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 消息区 */}
      <div className="desk-scroll flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-[13px] font-medium">问点什么吧</div>
            <div className="text-[11.5px] text-muted-foreground">上下文自动带入当前图表品种与行情</div>
            <div className="flex max-w-[300px] flex-wrap justify-center gap-1.5 pt-1">
              {CHIPS.map((q) => (
                <button key={q} onClick={() => send(q)} disabled={!configured}
                  className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "user" ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-sky-500/90 px-3 py-2 text-[12.5px] leading-5 text-white">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[92%] rounded-lg border border-border bg-background/70 px-3 py-2 text-[12.5px] leading-5">
                <Markdown content={m.content} />
              </div>
            )}
          </div>
        ))}
        {busy && <Loader2 size={14} className="ml-1 animate-spin text-sky-400" />}
        <div ref={endRef} />
      </div>

      {/* 快捷指令 + 输入 */}
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 pt-2">
        {CHIPS.map((q) => (
          <button key={q} onClick={() => send(q)} disabled={busy || !configured}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 p-2.5">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={configured ? "问智能助手…" : "先去设置配置 AI 接口"}
          disabled={!configured}
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-[12.5px] outline-none focus:border-sky-500/60 disabled:opacity-60" />
        <button onClick={() => send()} disabled={busy || !configured}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50">
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
