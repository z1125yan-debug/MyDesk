"use client";
// 智能助手页 —— P7-⑥⑥ 起它是**唯一的对话页**：AI 首页的大输入框和右下角随问小窗都把话交到这里发。
//
// 这一页只保留「本页特有的东西」：行情快照怎么取、系统提示词怎么拼；
// 发送、流式回填、降级、价格校验、端点选择都在 useChatSend 里，和首页 / 小窗共用同一份实现。
// 会话是同一份 store：从小窗「在助手页继续」＝切到同一条会话，不复制消息。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot, History, Loader2, Plus, Send, Square, Trash2,
  TrendingUp, BarChart3, Filter, Target, Scale, PieChart, LineChart,
} from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured, assistantSystemPrompt } from "@/lib/desk/ai";
import { fetchQuoteCards, fetchTechSnapshot, fetchNewsBlock, isDemoSymbol, searchSymbols } from "@/lib/desk/market";
import { shanghaiStamp } from "@/lib/desk/session";
import {
  guardPriceOf, provenanceOfQuote, provenanceOfTechSnapshot, renderMarketContext, type CtxRow,
} from "@/lib/desk/ai-context-core";
import { isFollowUp, type ChatMessage, type ChatSession } from "@/lib/desk/chat-core";
import { nameCandidates } from "@/lib/desk/intent-core";
import { useChatSend, type SnapshotResult } from "@/lib/desk/use-chat";
import { useServerLlm } from "@/lib/desk/use-server-llm";
import { useDeskLinks } from "@/lib/desk/use-desk-links";
import Markdown from "../Markdown";
import StepTimeline from "../StepTimeline";
import ChatBacktestCards from "../ChatBacktestCards";
import ChatModeMenu from "../ui/ChatModeMenu";
// P11 持仓周期：与风格菜单同一套「一处定义、发送时现读」的画法（modes.ts 唯一正身）
import HorizonPicker from "../ui/HorizonPicker";

// 回答风格：清单与文案唯一出处是 @/lib/desk/modes（CHAT_MODES 画界面、MODE_NOTES 进提示词），
// 首页下拉与本页 composer 都经共享组件 ChatModeMenu 出，选中值存 store.assistantMode，
// 发送那一刻现读——不会出现「首页选了研判、这里按决策发」。

const SUGGESTION_CARDS = [
  { q: "现在能不能买入？帮我看看", icon: TrendingUp },
  { q: "分析一下板块现在处于什么阶段", icon: BarChart3 },
  { q: "筛选资金持续流入的板块", icon: Filter },
  { q: "按我的成本制定一个持仓计划", icon: Target },
  { q: "帮我对比几只股票谁更强", icon: Scale },
  { q: "今天仓位策略应该怎么定", icon: PieChart },
  { q: "帮我做一个股票交易计划", icon: LineChart },
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
// R10b：候选切法与服务端 intent-core.nameCandidates 同一份口径（停用词表就在纯核里）。
// 3014 实测教训：问「中国电影卖的怎么样」时旧切法只产出「整句/中国电影卖」两种形状，
// 搜索接口全不认 → 客户端快照落回关注品种、价位校验锚错票；服务端却能把「中国电影」解析成 600977。
// 两边各切一套，就会出现「答的是这只票、注入的是那只票」的口径分裂。
export function questionCandidates(q: string): string[] {
  const out = new Set<string>();
  out.add(q.trim());
  const code = q.match(/\d{6}/);
  if (code) out.add(code[0]);
  for (const n of nameCandidates(q)) out.add(n);
  const stripped = q
    .replace(/^(帮我|请你|请|麻烦|帮忙|看看|看下|看一下|分析一下|分析下|分析|聊聊|说说|讲讲|查一下|查下|查查|对比一下|对比)+/g, "")
    .replace(/(的?结构|的?走势|的?行情|的?基本面|怎么样|怎么看待|怎么看|如何看|如何|现在|当前|最新|的情况|情况|支撑|阻力|关键位|价位|价格|在哪|哪里|吗|呢|？|\?)+$/g, "");
  if (stripped.length >= 2) out.add(stripped);
  return [...out].filter((s) => s.length >= 2).slice(0, 5);
}

export default function AssistantPage() {
  const go = useDesk((s) => s.go);
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  // P8-⑤：调试视图开关（默认关、只存本机）。改版把顶栏收成「新对话+状态」两件套，
  // 调试入口移到对话态顶栏右侧的小按钮——功能不丢，但不再占日常视觉。
  const debugPanel = useDesk((s) => s.debugPanel);
  const setDebugPanel = useDesk((s) => s.setDebugPanel);
  const switchSession = useDesk((s) => s.switchSession);
  const newSession = useDesk((s) => s.newSession);
  const dropSession = useDesk((s) => s.dropSession);

  const [input, setInput] = useState("");
  // 模式来自 store（与首页下拉同一份设置）；发送时按 use-chat 的口径在「真要发的那一刻」读当前值，
  // 所以这里不需要再养一份 ref 来绕开 setState 的异步性。
  const endRef = useRef<HTMLDivElement>(null);
  const takePendingAsk = useDesk((s) => s.takePendingAsk);
  // P7-⑧②：正文里的 6 位代码 / 清单内板块名渲染成可点片段。板块白名单与跳转动作出自共用 hook
  // （右下角小窗用的是同一份），这里只负责把它递给 Markdown。
  const { sectors, openLink } = useDeskLinks();

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
    const gi = blocks.findIndex((b) => b.price != null);
    return {
      // 快照为空时返回空串：提示词会写「状态 MISSING」，比塞一段假装有数据的文本诚实
      snapshot: [marketBlock, newsBlock].filter(Boolean).join("\n\n"),
      // 校验锚点只认真实报价：演示品种/缺失品种的 price 已经是 null，不会再拿假价判模型幻觉
      guardPrice: gi >= 0 ? blocks[gi].price : null,
      // R10b：这份价来自哪个标的要一起交出去——use-chat 拿它和本轮场景徽章的真实标的对账，
      // 锚定的不是同一只票就没有资格判「价位幻觉」（详见 use-chat 的 anchorMismatch 注释）
      anchorSymbol: gi >= 0 ? targets[gi] : null,
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
    // P11：周期同 rule——没选就是 null，请求体连 horizon 键都不带（未选≠默认某周期）
    extra: () => ({ focusSymbol, mode: useDesk.getState().assistantMode, horizon: useDesk.getState().assistantHorizon }),
    onNotConfigured: () => go("settings"),
  });

  // 首页交过来的那一句：进页面取一次就清掉，刷新不会重发。
  // 这里刻意不做任何 setState：模式已经在 store 里由首页那次点击写好了，本轮发送时现读即可。
  useEffect(() => {
    const pending = takePendingAsk();
    if (!pending) return;
    void send(pending);
  }, [send, takePendingAsk]);

  // P10（用户裁定改口径）：切到别的页面再回来，这一轮对话要还在——刷新也还在。
  // 旧行为是挂载即 newSession()（P8 设计：回 Hello 首页），用户实测反馈「切换后再回来对话就没了」，
  // 判定那是把工程上的「新开会话干净」错当成了用户预期。会话本来就整份存在 zustand persist
  // （localStorage，删了才真没了），这里只是不再每次挂载强行开新会话；
  // 「新对话」按钮保留：想清空时点它，或直接删对应会话（空状态最近对话里的垃圾桶）。
  // 副作用口径：进页不再动会话，首页/小窗交来的 pendingAsk 就落在当前会话里续着说。

  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages: ChatMessage[] = session?.messages ?? [];
  // P7-⑩：徽章说的是「这一轮会走哪条模型路」。浏览器凭据与服务端 .env 通道是两条路，
  // 各写各的名字；两条都没有才说「未配置」。订阅 useServerLlm 让 available:false 落回时徽章翻面。
  const serverLlm = useServerLlm();
  const browserCfg = aiConfigured(ai);
  const configured = browserCfg || !(serverLlm && serverLlm.available === false);
  // 最近对话（有内容的历史会话，按更新时间倒序）：新会话顶掉了视图，但话还在原会话里
  const recents = sessions
    .filter((s) => s.id !== activeSessionId && s.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);

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
    <div className="flex h-[calc(100vh-8.5rem)] w-full flex-col gap-3 px-5 py-4">
      {messages.length === 0 && !busy ? (
      /* ===== 空状态：居中 Hello + 宽输入 + 两列建议卡片（对齐参考站） ===== */
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto desk-scroll px-6">
        <div className="w-full max-w-3xl py-8">
          <h1 className="apple-slide-up text-center text-[44px] font-semibold tracking-tight">Hello</h1>
          <p className="apple-slide-up mt-3 text-center text-[15px] text-muted-foreground">
            问行情、问个股，或描述你想要的条件，剩下的交给我。
          </p>

          {/* 宽输入框 */}
          <div className="apple-slide-up mt-8 rounded-[20px] border border-white/10 bg-[#17191f] p-2 shadow-2xl">
            <div className="flex items-center gap-2 px-1.5 py-1.5">
              <ChatModeMenu disabled={!configured} />
              <HorizonPicker disabled={!configured} />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                placeholder={configured ? "输入股票、板块，或说说你的疑问…" : "配置 AI 后即可对话"}
                disabled={!configured}
                className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-muted-foreground/50 disabled:opacity-60"
              />
              <button onClick={() => submit()} disabled={!configured || !input.trim()}
                className="apple-primary-btn flex h-10 w-10 shrink-0 items-center justify-center">
                <Send size={16} />
              </button>
            </div>
          </div>

          {/* 两列建议卡片 */}
          <div className="apple-stagger mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SUGGESTION_CARDS.map((c) => (
              <button key={c.q} onClick={() => submit(c.q)} disabled={!configured}
                className="group flex items-center gap-3.5 rounded-2xl border border-border/60 bg-white/[0.02] px-4 py-4 text-left transition-all duration-200 hover:border-sky-400/30 hover:bg-white/[0.04] disabled:opacity-50">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-sky-300 transition-colors group-hover:bg-sky-400/15">
                  <c.icon size={18} />
                </span>
                <span className="text-[14px] text-foreground/90">{c.q}</span>
              </button>
            ))}
          </div>

          {/* 最近对话：改版删掉了常驻会话列表栏，但「续上之前的话」这条能力不删——
              收进空状态底部，一眼扫过不占视觉主线；没有历史时整块不出现（对齐参考站「暂无历史」的克制）。 */}
          {recents.length > 0 && (
            <div className="apple-fade-in mt-8">
              <div className="mb-2 text-[12px] text-muted-foreground/70">最近对话</div>
              <div className="space-y-1">
                {recents.map((s) => (
                  <div key={s.id} className="group flex items-center gap-2 rounded-xl px-3 py-2 transition-colors hover:bg-white/[0.04]">
                    <button onClick={() => switchSession(s.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                      <History size={13} className="shrink-0 text-muted-foreground/60" />
                      <span className="truncate text-[13px] text-foreground/80">{s.title || "未命名对话"}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground/50">{s.messages.length} 条</span>
                    </button>
                    <button onClick={() => dropSession(s.id)} title="删除这段对话"
                      className="opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-60">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 顶栏：新对话 + 状态（对话态走居中单列阅读，不再常驻会话列表 / 右栏） */}
        <div className="flex items-center justify-between px-2 py-1.5">
          <button onClick={() => { newSession(); }}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-sky-400/40 hover:text-sky-200">
            <Plus size={13} /> 新对话
          </button>
          <div className="flex items-center gap-2">
            {/* P8-⑤ 调试开关：默认关；开着时步骤时间线展开三段调试视图。小按钮收在右侧，不进日常视觉主线 */}
            <button onClick={() => setDebugPanel(!debugPanel)} title="调试：展示本轮真实取数步骤与留底（只存本机）"
              className={"rounded-full border px-2.5 py-1 text-[11px] transition-colors " + (debugPanel ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-border/60 text-muted-foreground hover:text-foreground")}>
              调试
            </button>
            <span className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] " + (configured ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-amber-400/25 bg-amber-400/10 text-amber-300")}>
              <span className={"h-1.5 w-1.5 rounded-full " + (configured ? "bg-emerald-400" : "bg-amber-400")} />
              {configured ? "AI 已就绪" : "AI 待配置"}
            </span>
          </div>
        </div>

        {/* 居中消息流 */}
        <div className="desk-scroll flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-6">
          {messages.map((m) => (
            <div key={m.id} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "user" ? (
                <div className="max-w-[80%] whitespace-pre-wrap rounded-3xl rounded-br-md bg-white/[0.08] px-5 py-3 text-[15px] leading-7 text-foreground">
                  {m.content}
                </div>
              ) : (
                <div className="flex w-full gap-3.5">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-blue-600 shadow-lg shadow-sky-500/20">
                    <Bot size={15} className="text-white" />
                  </div>
                  <div className="min-w-0 flex-1 pt-1 text-[15px] leading-8 text-foreground/95">
                    <Markdown content={m.content} sectors={sectors} onLink={openLink} />
                    {m.streaming && <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-1 animate-pulse bg-sky-400" />}
                    <div className="mt-1.5">
                      <StepTimeline steps={m.steps} warning={m.warning} streaming={m.streaming}
                        intent={m.intent} debug={m.debug} debugOn={debugPanel} />
                    </div>
                    <ChatBacktestCards steps={m.steps} />
                  </div>
                </div>
              )}
            </div>
          ))}
          {busy && messages.at(-1)?.role !== "assistant" && (
            <div className="flex items-center gap-2 text-[14px] text-muted-foreground">
              <Loader2 size={15} className="animate-spin text-sky-400" /> 正在思考…
            </div>
          )}
          <div ref={endRef} />
          </div>
        </div>

        {/* 底部简洁输入条 */}
        <div className="px-6 pb-4 pt-1">
          <div className="mx-auto w-full max-w-6xl">
            <div className="flex items-center gap-2 rounded-[20px] border border-white/10 bg-[#17191f] p-2">
              <ChatModeMenu disabled={!configured} />
              <HorizonPicker disabled={!configured} />
              <input value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                placeholder={configured ? "输入股票代码、板块或您的投资疑问…" : "配置 AI 后即可对话"}
                disabled={!configured}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[14.5px] outline-none placeholder:text-muted-foreground/50 disabled:opacity-60" />
              {busy ? (
                <button onClick={stop} title="停止本次回答"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
                  <Square size={14} />
                </button>
              ) : (
                <button onClick={() => submit()} disabled={!configured || !input.trim()}
                  className="apple-primary-btn flex h-10 w-10 shrink-0 items-center justify-center">
                  <Send size={15} />
                </button>
              )}
            </div>
            <div className="mt-1.5 text-center text-[10.5px] text-muted-foreground/50">对话只保存在本机，不会上传</div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
