"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Plus, Trash2, Settings2, Bot } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { aiChat, aiConfigured, assistantSystemPrompt, priceBandOk } from "@/lib/desk/ai";
import { fetchQuoteCards, fetchTechSnapshot, searchSymbols, fetchNewsBlock } from "@/lib/desk/market";
import Markdown from "../Markdown";

const QUICK_ASKS = [
  "分析一下当前品种的结构",
  "寒武纪关键支撑和阻力在哪？",
  "帮我把这笔持仓列一个风控清单",
  "均线多头排列该怎么理解？",
];

// 为指定品种生成行情快照文本块（含真实价格，供数量级校验使用）
async function marketBlockFor(symbol: string): Promise<{ block: string; price: number | null }> {
  try {
    const [cards, snap] = await Promise.all([
      fetchQuoteCards([symbol]),
      fetchTechSnapshot(symbol).catch(() => null),
    ]);
    const q = cards.cards[0];
    const price = q && !q.missing ? q.price : null;
    const lines = [
      `${q?.name ?? symbol}（${symbol}）`,
      price != null
        ? `最新价 ${price.toFixed(2)} 元（${q!.changePct >= 0 ? "+" : ""}${q!.changePct.toFixed(2)}%）`
        : "最新价暂不可用（非A股品种为演示数据）",
      snap ? `多周期趋势: ${snap.tfs.map((t) => `${t.tf}=${t.trend}`).join(", ")}；RSI: ${snap.tfs.map((t) => `${t.tf} ${t.rsi?.toFixed(0) ?? "—"}`).join(", ")}` : "",
      snap?.support != null ? `最近支撑 ${snap.support.toFixed(2)} / 最近阻力 ${snap.resistance?.toFixed(2)}` : "",
      snap?.rangePos != null ? `近半年区间位置 ${snap.rangePos.toFixed(0)}%（${snap.rangeLow?.toFixed(2)} ~ ${snap.rangeHigh?.toFixed(2)}）` : "",
    ].filter(Boolean);
    return { block: lines.join("\n"), price };
  } catch {
    return { block: "", price: null };
  }
}

// 价格数量级校验：回答里至少要有一个接近现价的数字，否则视为幻觉
// 从自然语言问题中提取品种搜索词（整句搜索接口是不认的）
export function questionCandidates(q: string): string[] {
  const out = new Set<string>();
  out.add(q.trim());
  const code = q.match(/\d{6}/);
  if (code) out.add(code[0]);
  const stripped = q
    .replace(/^(帮我|请你|请|麻烦|帮忙|看看|看下|看一下|分析一下|分析下|分析|聊聊|说说|讲讲|查一下|查下|查查|对比一下|对比)+/g, "")
    .replace(/(的?结构|的?走势|的?行情|的?基本面|怎么样|怎么看待|怎么看|如何看|如何|现在|当前|最新|的情况|情况|支撑|阻力|关键位|价位|价格|在哪|哪里|吗|呢|？|\?)+$/g, "");
  if (stripped.length >= 2) out.add(stripped);
  return [...out].filter((s) => s.length >= 2).slice(0, 3);
}

export default function AssistantPage() {
  const chats = useDesk((s) => s.chats);
  const activeChat = useDesk((s) => s.activeChat);
  const setActiveChat = useDesk((s) => s.setActiveChat);
  const setChats = useDesk((s) => s.setChats);
  const newChat = useDesk((s) => s.newChat);
  const dropChat = useDesk((s) => s.dropChat);
  const go = useDesk((s) => s.go);
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const messages = chats[activeChat] ?? [];
  const configured = aiConfigured(ai);

  // 关注品种的行情上下文（进入页面时注入一次）
  useEffect(() => {
    let dead = false;
    marketBlockFor(focusSymbol).then((r) => { if (!dead) setCtx(r.block); });
    return () => { dead = true; };
  }, [focusSymbol]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, busy]);

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim();
    if (!content || busy) return;
    if (!configured) { go("settings"); return; }
    setBusy(true); setInput("");
    const base = chats.map((c, i) => (i === activeChat ? [...c, { role: "user" as const, content, ts: Date.now() }] : c));
    setChats(base);
    try {
      // 从问题里识别提到的品种（整句搜不到时用提取出的候选词逐个试），连同关注品种一起注入实时快照
      let targets = [focusSymbol];
      try {
        for (const cand of questionCandidates(content)) {
          const found = await searchSymbols(cand);
          if (found.length) {
            targets = [...new Set([found[0].symbol, focusSymbol])].slice(0, 2);
            break;
          }
        }
      } catch { /* 识别失败则仅注入关注品种 */ }
      const blocks = await Promise.all(targets.map((s) => marketBlockFor(s)));
      const marketBlock = blocks.map((b) => b.block).filter(Boolean).join("\n\n");
      const guardPrice = blocks[0]?.price ?? null;
      const newsBlock = await fetchNewsBlock();

      // 快照注入最后一条用户消息：部分轻量模型对 system 消息的遵循度低
      const sent = [...base[activeChat].slice(-12)];
      const lastMsg = sent[sent.length - 1];
      sent[sent.length - 1] = {
        ...lastMsg,
        content: marketBlock ? `[实时行情快照]\n${marketBlock}\n\n用户问题：${lastMsg.content}` : lastMsg.content,
      };
      const callMessages = [
        { role: "system" as const, content: assistantSystemPrompt([marketBlock, newsBlock].filter(Boolean).join("\n\n")) },
        ...sent.map((m) => ({ role: m.role, content: m.content })),
      ];
      let reply = await aiChat(ai, callMessages);

      // 价格数量级校验：不符则带警告自动重试一次，仍不符则在回答上标注
      if (guardPrice && !priceBandOk(reply, guardPrice)) {
        const corrective = [
          { role: "system" as const, content: assistantSystemPrompt([marketBlock, newsBlock].filter(Boolean).join("\n\n")) },
          {
            role: "system" as const,
            content: `警告：你上一次回答中的价位数值与实时行情快照严重不符（最新价应为 ${guardPrice.toFixed(2)} 元），属于幻觉，已被系统拦截。重新回答：所有价位只允许来自快照，数量级必须与最新价一致。`,
          },
          ...sent.map((m) => ({ role: m.role, content: m.content })),
        ];
        const reply2 = await aiChat(ai, corrective);
        reply = priceBandOk(reply2, guardPrice)
          ? reply2
          : `${reply2}\n\n> ⚠ 系统提示：本回答中的价位与实时行情可能不符，请以快照中的最新价 ${guardPrice.toFixed(2)} 元为准。`;
      }

      setChats(base.map((c, i) => (i === activeChat ? [...c, { role: "assistant" as const, content: reply, ts: Date.now() }] : c)));
    } catch (e) {
      setChats(base.map((c, i) => (i === activeChat ? [...c, { role: "assistant" as const, content: `请求出错：${(e as Error).message}`, ts: Date.now() }] : c)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] w-full gap-4 px-5 py-4">
      {/* 会话列表 */}
      <div className="hidden w-56 shrink-0 flex-col rounded-xl border border-border bg-card md:flex">
        <button onClick={newChat}
          className="m-2.5 inline-flex items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-2 text-[12.5px] font-medium text-white hover:bg-sky-500">
          <Plus size={14} /> 新会话
        </button>
        <div className="desk-scroll flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          {chats.map((c, i) => (
            <div key={i}
              onClick={() => setActiveChat(i)}
              className={"group flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-2 text-[12.5px] " +
                (i === activeChat ? "bg-sky-500/12 text-sky-300" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              <span className="truncate">{c[0]?.content.slice(0, 14) || `会话 ${i + 1}`}</span>
              <button onClick={(e) => { e.stopPropagation(); dropChat(i); }}
                className="ml-auto opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100">
                <Trash2 size={12.5} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 对话区 */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600">
              <Bot size={16} className="text-white" />
            </div>
            <div>
              <div className="text-[14px] font-semibold">智能助手</div>
              <div className="text-[11.5px] text-muted-foreground">像 AI 分析师一样拆解品种：结构 · 关键位 · 思路 · 风险</div>
            </div>
          </div>
          {!configured && (
            <button onClick={() => go("settings")}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-300 hover:bg-amber-500/20">
              <Settings2 size={13} /> 先去配置 AI
            </button>
          )}
        </div>

        <div className="desk-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="text-[13.5px] font-medium">问点什么吧</div>
              <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                {QUICK_ASKS.map((q) => (
                  <button key={q} onClick={() => send(q)}
                    className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "user" ? (
                <div className="max-w-[70%] whitespace-pre-wrap rounded-lg bg-sky-500/90 px-4 py-2.5 text-[14.5px] leading-7 text-white">
                  {m.content}
                </div>
              ) : (
                <div className="w-full rounded-lg border border-border bg-background/70 px-4 py-3 text-[14.5px] leading-7">
                  <Markdown content={m.content} />
                </div>
              )}
            </div>
          ))}
          {busy && <Loader2 size={15} className="ml-1 animate-spin text-sky-400" />}
          <div ref={endRef} />
        </div>

        <div className="flex flex-wrap gap-1.5 border-t border-border px-3.5 pt-2.5">
          {["关键位在哪", "多周期趋势总结", "现在适合进场吗", "给我一个风控清单"].map((q) => (
            <button key={q} onClick={() => send(q)} disabled={busy || !configured}
              className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3.5">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={configured ? "输入问题，回车发送…" : "配置 AI 接口后即可对话"}
            disabled={!configured}
            className="h-11 flex-1 rounded-md border border-border bg-background px-4 text-[14px] outline-none focus:border-sky-500/60 disabled:opacity-60" />
          <button onClick={() => send()} disabled={busy || !configured}
            className="flex h-11 w-11 items-center justify-center rounded-md bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50">
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
