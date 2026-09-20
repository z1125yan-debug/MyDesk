"use client";
// 智能助手页 —— P7-⑥⑥ 起它是**唯一的对话页**：AI 首页的大输入框和右下角随问小窗都把话交到这里发。
//
// 这一页只保留「本页特有的东西」：行情快照怎么取、系统提示词怎么拼；
// 发送、流式回填、降级、价格校验、端点选择都在 useChatSend 里，和首页 / 小窗共用同一份实现。
// 会话是同一份 store：从小窗「在助手页继续」＝切到同一条会话，不复制消息。
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, PenLine, Plus, Settings2, Send, Square, Trash2 } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured, assistantSystemPrompt } from "@/lib/desk/ai";
import { fetchQuoteCards, fetchTechSnapshot, fetchNewsBlock, isDemoSymbol, searchSymbols } from "@/lib/desk/market";
import { shanghaiStamp } from "@/lib/desk/session";
import {
  guardPriceOf, provenanceOfQuote, provenanceOfTechSnapshot, renderMarketContext, type CtxRow,
} from "@/lib/desk/ai-context-core";
import { isFollowUp, type ChatMessage, type ChatSession } from "@/lib/desk/chat-core";
import { pickChatEndpoint } from "@/lib/desk/chat-stream-core";
import { CHAT_MODES } from "@/lib/desk/modes";
import { useChatSend, type SnapshotResult } from "@/lib/desk/use-chat";
import Markdown from "../Markdown";
import SceneBadge from "../SceneBadge";
import StepTimeline from "../StepTimeline";

// 回答风格的清单一处定义在 @/lib/desk/modes（首页的下拉用的就是同一份），
// 当前选中的值存在 store.assistantMode：两个画法共享一个设置，不会出现「首页选了研判、这里按决策发」。
// 只有落到工具调用端点（服务端按 mode 改口径）时它才生效，纯对话端点上这一项会显式禁用。

const QUICK_ASKS = [
  "分析一下当前品种的结构",
  "寒武纪关键支撑和阻力在哪？",
  "帮我把这笔持仓列一个风控清单",
  "均线多头排列该怎么理解？",
];

// 为指定品种生成行情快照文本块。
// P6-A：每条都带来源分层（真实/派生/演示/缺失），只有标 REAL 的价格才允许当数量级校验的锚点——
// 原来演示品种（非 A 股）的假价格既被写成「最新价」当事实注入，又被拿去做幻觉校验，两处都已修正。
async function marketBlockFor(symbol: string): Promise<{ rows: CtxRow[]; block: string; price: number | null }> {
  try {
    const [cards, snap] = await Promise.all([
      fetchQuoteCards([symbol]),
      fetchTechSnapshot(symbol).catch(() => null),
    ]);
    const q = cards.cards[0];
    const prov = provenanceOfQuote(q, isDemoSymbol(symbol));
    const lines: string[] = [];
    if (prov === "REAL") {
      lines.push(`最新价 ${q.price.toFixed(2)} 元（${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%）`);
    } else if (prov === "MISSING") {
      lines.push("最新价：本次未取到（数据源断开或停牌）——不知道就不要给价格，也不要用 0");
    } else {
      lines.push(`展示值 ${q ? q.price.toFixed(2) : "—"} 元：本机演示数据，不是行情，禁止引用为价格事实`);
    }
    const snapProv = snap ? provenanceOfTechSnapshot(snap.source) : null;
    const snapLines = snap && snapProv && snapProv !== "MISSING"
      ? [
        `多周期趋势: ${snap.tfs.map((t) => `${t.tf}=${t.trend}`).join(", ")}；RSI: ${snap.tfs.map((t) => `${t.tf} ${t.rsi?.toFixed(0) ?? "—"}`).join(", ")}`,
        snap.support != null ? `最近支撑 ${snap.support.toFixed(2)} / 最近阻力 ${snap.resistance?.toFixed(2)}` : "",
        snap.rangePos != null ? `近半年区间位置 ${snap.rangePos.toFixed(0)}%（${snap.rangeLow?.toFixed(2)} ~ ${snap.rangeHigh?.toFixed(2)}）` : "",
      ].filter(Boolean)
      : [];
    const rows: CtxRow[] = [
      {
        label: `${q?.name ?? symbol}（${symbol}）报价`,
        provenance: prov,
        lines,
        note: prov === "REAL" && q?.series_synthetic ? "分时序列为按现价合成的展示序列，只用于画缩略图，不是真实成交轨迹" : undefined,
      },
    ];
    if (snapLines.length) {
      rows.push({
        label: `${q?.name ?? symbol}（${symbol}）技术面`,
        provenance: snapProv === "DERIVED_ON_DEMO" ? "DERIVED_ON_DEMO" : "DERIVED",
        lines: snapLines,
        note: snapProv === "DERIVED_ON_DEMO" ? "K 线为演示数据：趋势/RSI/关键位只是算法演示，不构成任何结论" : "由本机引擎对真实 K 线计算（MA/RSI/区间），不是交易所发布的指标",
      });
    } else if (snap && snapProv === "MISSING") {
      rows.push({ label: `${q?.name ?? symbol}（${symbol}）技术面`, provenance: "MISSING", lines: ["K 线未取得：趋势/RSI/关键位全部缺，不要凭印象补"] });
    }
    return { rows, block: renderMarketContext(rows, { takenAt: shanghaiStamp() }), price: guardPriceOf(prov, q?.price) };
  } catch {
    return { rows: [], block: "", price: null };
  }
}

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
  const go = useDesk((s) => s.go);
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const switchSession = useDesk((s) => s.switchSession);
  const newSession = useDesk((s) => s.newSession);
  const dropSession = useDesk((s) => s.dropSession);
  const renameSession = useDesk((s) => s.renameSession);

  const [input, setInput] = useState("");
  // 模式来自 store（与首页下拉同一份设置）；发送时按 use-chat 的口径在「真要发的那一刻」读当前值，
  // 所以这里不需要再养一份 ref 来绕开 setState 的异步性。
  const mode = useDesk((s) => s.assistantMode);
  const setMode = useDesk((s) => s.setAssistantMode);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const takePendingAsk = useDesk((s) => s.takePendingAsk);

  // 本轮快照：识别问题里的品种（关注品种兜底），带来源分层；追问则沿用会话已关联的标的
  const snapshot = useCallback(async (session: ChatSession, question: string): Promise<SnapshotResult | null> => {
    const carried = isFollowUp(question) ? session.stock : undefined;
    let targets = [carried ?? focusSymbol];
    let hit: string | undefined = carried;
    if (!carried) {
      try {
        for (const cand of questionCandidates(question)) {
          const found = await searchSymbols(cand);
          if (found.length) {
            targets = [...new Set([found[0].symbol, focusSymbol])].slice(0, 2);
            hit = found[0].symbol;
            break;
          }
        }
      } catch { /* 识别失败则仅注入关注品种 */ }
    }
    const blocks = await Promise.all(targets.map((s) => marketBlockFor(s)));
    const allRows = blocks.flatMap((b) => b.rows);
    const marketBlock = allRows.length
      ? `[行情快照·逐条标注来源分层]\n${renderMarketContext(allRows, { takenAt: shanghaiStamp() })}`
      : "";
    const newsBlock = await fetchNewsBlock().catch(() => "");
    return {
      // 快照为空时返回空串：提示词会写「状态 MISSING」，比塞一段假装有数据的文本诚实
      snapshot: [marketBlock, newsBlock].filter(Boolean).join("\n\n"),
      // 校验锚点只认真实报价：演示品种/缺失品种的 price 已经是 null，不会再拿假价判模型幻觉
      guardPrice: blocks.map((b) => b.price).find((p) => p != null) ?? null,
      stock: hit,
    };
  }, [focusSymbol]);

  const { send, busy, stop, sessions, activeSessionId } = useChatSend({
    // 端点按服务商能力选：OpenAI 兼容接口走工具调用环（模型能自己补取数），其余退回纯对话端点。
    // 两条路的场景识别与自动取数是同一份接线，所以换端点不会换「这一轮按哪个场景答」的口径。
    endpoint: "auto",
    systemPrompt: assistantSystemPrompt,
    snapshot,
    // 当前关注品种交给服务端：说「这只股」时它才知道指谁，并且会如实标注「分析页当前品种」
    // 模式在发送那一刻从 store 现读：首页刚改完风格就提交，这一轮用的就是新值，不依赖渲染节奏
    extra: () => ({ focusSymbol, mode: useDesk.getState().assistantMode }),
    onNotConfigured: () => go("settings"),
  });

  const endpoint = pickChatEndpoint(ai.provider, "auto");
  const toolsOn = endpoint === "tools";

  // 首页交过来的那一句：进页面取一次就清掉，刷新不会重发。
  // 这里刻意不做任何 setState：模式已经在 store 里由首页那次点击写好了，本轮发送时现读即可。
  useEffect(() => {
    const pending = takePendingAsk();
    if (!pending) return;
    void send(pending);
  }, [send, takePendingAsk]);

  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages: ChatMessage[] = session?.messages ?? [];
  const configured = aiConfigured(ai);

  const submit = (preset?: string) => {
    const content = (preset ?? input).trim();
    if (!content) return;
    setInput("");
    void send(content);
  };

  // 自动跟随：流式期间内容一直在长，只按条数滚动会停在半屏
  const tail = `${messages.length}:${messages.at(-1)?.content.length ?? 0}`;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [tail]);

  return (
    <div className="flex h-[calc(100vh-8.5rem)] w-full gap-4 px-5 py-4">
      {/* 会话列表：新建 / 切换 / 重命名 / 删除（存档在浏览器 localStorage，跨刷新保留） */}
      {/* 窄屏也要能管会话：原来写的是 hidden + md:flex，小于 768px 时整套会话操作直接没有入口，
          而「新建/切换/删除会话」正是这一项要交付的能力，不能只在宽屏存在。窄屏收一点宽度，不换第二套控件。 */}
      <div className="flex w-40 shrink-0 flex-col rounded-xl border border-border bg-card md:w-56">
        <button onClick={() => { newSession(); }}
          className="m-2.5 inline-flex items-center justify-center gap-1.5 rounded-md bg-sky-500/90 py-2 text-[12.5px] font-medium text-white hover:bg-sky-500">
          <Plus size={14} /> 新会话
        </button>
        <div className="desk-scroll flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          {sessions.map((c) => (
            <div key={c.id}
              onClick={() => switchSession(c.id)}
              className={"group flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-2 text-[12.5px] " +
                (c.id === activeSessionId ? "bg-sky-500/12 text-sky-300" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              {renaming === c.id ? (
                <input autoFocus value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { renameSession(c.id, renameText); setRenaming(null); }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => { renameSession(c.id, renameText); setRenaming(null); }}
                  className="min-w-0 flex-1 rounded border border-sky-500/50 bg-background px-1 text-[12.5px] outline-none" />
              ) : (
                <span className="truncate" title={c.title}>{c.title}</span>
              )}
              <button onClick={(e) => { e.stopPropagation(); setRenaming(c.id); setRenameText(c.title); }}
                title="重命名"
                className="shrink-0 opacity-0 transition-opacity hover:text-sky-300 group-hover:opacity-100">
                <PenLine size={12} />
              </button>
              <button onClick={(e) => { e.stopPropagation(); dropSession(c.id); }}
                title="删除会话"
                className="shrink-0 opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100">
                <Trash2 size={12.5} />
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-border/70 px-3 py-2 text-[10px] leading-4 text-muted-foreground/80">
          会话存在本机浏览器里，最多保留最近 30 个；删除只清本机记录，不动任何行情数据。
        </div>
      </div>

      {/* 对话区 */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600">
              <Bot size={16} className="text-white" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold">{session?.title ?? "智能助手"}</div>
              <div className="text-[11.5px] text-muted-foreground">
                {session?.stock ? <>关联标的 <span className="font-mono text-sky-300">{session.stock}</span> · 追问沿用</> : "结构 · 关键位 · 思路 · 风险"}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 这里说的是「模型接口通不通」，不是行情数据来源，所以不用 SourceBadge（避免把配置状态画成数据状态） */}
            <span className={"rounded border px-1.5 py-0.5 text-[10px] " + (configured ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300")}>
              {configured
                ? `接口已配置 · ${ai.model} · ${toolsOn ? "工具调用端点" : "纯对话端点（该服务商无工具环）"}`
                : "接口未配置"}
            </span>
            {!configured && (
              <button onClick={() => go("settings")}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-300 hover:bg-amber-500/20">
                <Settings2 size={13} /> 先去配置 AI
              </button>
            )}
          </div>
        </div>

        <div className="desk-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="text-[13.5px] font-medium">问点什么吧</div>
              <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                {QUICK_ASKS.map((q) => (
                  <button key={q} onClick={() => submit(q)}
                    className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300">
                    {q}
                  </button>
                ))}
              </div>
              <div className="max-w-sm text-[11px] leading-5 text-muted-foreground/80">
                每轮都会现取一次行情快照（真实/派生/演示/缺失逐条标注），旧对话按窗口压缩后带入，不替模型宣称事实。
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "user" ? (
                <div className="max-w-[70%] whitespace-pre-wrap rounded-lg bg-sky-500/90 px-4 py-2.5 text-[14.5px] leading-7 text-white">
                  {m.content}
                </div>
              ) : (
                <div className="w-full rounded-lg border border-border bg-background/70 px-4 py-3 text-[14.5px] leading-7">
                  {/* 场景徽章：这一轮按哪个场景答、依据哪个词、取了哪些数、什么没取，都在这条里 */}
                  <SceneBadge intent={m.intent} />
                  <Markdown content={m.content} />
                  {m.streaming && <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 animate-pulse bg-sky-400" />}
                  <StepTimeline steps={m.steps} warning={m.warning} streaming={m.streaming} />
                </div>
              )}
            </div>
          ))}
          {busy && messages.at(-1)?.role !== "assistant" && <Loader2 size={15} className="ml-1 animate-spin text-sky-400" />}
          <div ref={endRef} />
        </div>

        {/* 回答风格：只有工具调用端点会按 mode 改服务端口径，纯对话端点上这条禁用并说明原因，
            而不是让用户以为选了就会变。场景本身不用选：服务端每轮按这句话自动判（见场景徽章）。 */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3.5 pt-2.5">
          <span className="text-[10.5px] text-muted-foreground">回答风格</span>
          {CHAT_MODES.map((m) => (
            <button key={m.key} onClick={() => setMode(m.key)} disabled={!configured || !toolsOn} title={m.desc}
              className={"rounded-full border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40 " +
                (mode === m.key && toolsOn ? "border-sky-500/50 bg-sky-500/12 text-sky-300" : "border-border text-muted-foreground hover:text-foreground")}>
              {m.label}
            </button>
          ))}
          {!toolsOn && <span className="text-[10.5px] text-muted-foreground/80">（当前服务商无工具调用环，风格项不生效）</span>}
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-border px-3.5 pt-2.5">
          {["关键位在哪", "多周期趋势总结", "现在适合进场吗", "给我一个风控清单"].map((q) => (
            <button key={q} onClick={() => submit(q)} disabled={busy || !configured}
              className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3.5">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
            placeholder={configured ? "输入问题，回车发送…（流式输出，可随时停止）" : "配置 AI 接口后即可对话"}
            disabled={!configured}
            className="h-11 flex-1 rounded-md border border-border bg-background px-4 text-[14px] outline-none focus:border-sky-500/60 disabled:opacity-60" />
          {busy ? (
            <button onClick={stop} title="停止本次回答（保留已生成的部分）"
              className="flex h-11 w-11 items-center justify-center rounded-md border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
              <Square size={15} />
            </button>
          ) : (
            <button onClick={() => submit()} disabled={!configured}
              className="flex h-11 w-11 items-center justify-center rounded-md bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50">
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
