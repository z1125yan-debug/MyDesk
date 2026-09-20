"use client";
// AI 对话首页（需求文档 P0：居中大输入框 + 模式选择 + 推荐问题 + 市场状态摘要）
// P7-⑤：这一页也走 useChatSend（端点＝AI 交易员工具调用），于是「首页问的那一句」和
// 「智能助手页问的那一句」共用同一份会话存档与同一种步骤时间线；系统提示词在服务端，这里不再重发一份。
import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Sparkles, Square, Trash2, ChevronDown } from "lucide-react";
import Markdown from "../Markdown";
import StepTimeline from "../StepTimeline";
import { SourceBadge, PctText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured } from "@/lib/desk/ai";
import { aiChatTools, fetchSentiment, type SentimentClient } from "@/lib/desk/quant-api";
import { stepsFromTrace } from "@/lib/desk/chat-stream-core";
import type { ChatMessage } from "@/lib/desk/chat-core";
import { useChatSend } from "@/lib/desk/use-chat";

type Mode = "decision" | "judge" | "deep" | "search";
const MODES: { key: Mode; label: string; desc: string }[] = [
  { key: "decision", label: "决策模式", desc: "结论前置，工具调真实数据" },
  { key: "judge", label: "研判模式", desc: "客观描述结构，少主观" },
  { key: "deep", label: "深度思考", desc: "先数据后推演，附风险清单" },
  { key: "search", label: "实时搜索", desc: "优先引用最新快讯" },
];

const SUGGESTIONS = [
  "今天大盘情绪怎么样？风险等级是多少？",
  "扫描全A：放量上涨 + 主力净流入 + 换手率大于3%，按成交额排序",
  "688256 现在的资金面、技术面怎么样？历史条件概率多少？",
  "今天哪些行业板块主力资金流入最强？",
  "找出 RPS50 大于 80 且站上 MA20 的股票",
];

export default function AiHomePage() {
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const go = useDesk((s) => s.go);
  const newSession = useDesk((s) => s.newSession);
  const switchSession = useDesk((s) => s.switchSession);
  const dropSession = useDesk((s) => s.dropSession);
  const [mode, setMode] = useState<Mode>("decision");
  const [input, setInput] = useState("");
  const [modeOpen, setModeOpen] = useState(false);
  const [sent, setSent] = useState<SentimentClient | null>(null);
  const [sentErr, setSentErr] = useState("");
  const [sentLoading, setSentLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { send, busy, stop, sessions, activeSessionId } = useChatSend({
    endpoint: "tools",
    // 这一路的系统提示词（含因子目录、数据纪律）在服务端 systemPrompt()，客户端不再叠一份
    extra: () => ({ mode, focusSymbol }),
    fallback: async (cfg, messages) => {
      const r = await aiChatTools(cfg, messages, { mode, focusSymbol, contextWindow: 12, timeoutMs: 120_000 });
      // 非流式返回的是 trace：归一成与流式 step 事件同一种步骤，时间线才不会两种形状
      return { text: r.content, steps: stepsFromTrace(r.trace) };
    },
    onNotConfigured: () => go("settings"),
  });

  const loadSentiment = useCallback(async () => {
    setSentErr("");
    setSentLoading(true);
    try {
      setSent(await fetchSentiment());
    } catch (e) {
      setSentErr(String((e as Error).message || e));
    } finally {
      setSentLoading(false);
    }
  }, []);

  useEffect(() => { void loadSentiment(); }, [loadSentiment]);

  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const msgs: ChatMessage[] = session?.messages ?? [];
  const started = msgs.length > 0;

  const submit = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setInput("");
    void send(q);
  };

  // 流式期间正文一直在长，只按条数滚动会停在半屏
  const tail = `${msgs.length}:${msgs.at(-1)?.content.length ?? 0}`;
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [tail]);

  // 说明：原来这里有个 openProfile()（把回答里的 6 位代码点进个股画像），但整个页面没有一处调用它，
  // 属于死代码，这次一并删掉；真要加「答案里的代码可点击」时再按需求文档做。

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6">
      {/* 顶部状态 */}
      <div className="flex items-center justify-between gap-2 pt-4">
        <SourceBadge status={sent?.live ? "LIVE" : sent ? "HISTORICAL" : sentErr ? "OFFLINE" : "…"} source={sent?.source.provider.split("（")[0]} time={sent?.as_of.slice(11)} />
        <div className="flex items-center gap-1.5">
          {started && (
            <select
              value={session?.id ?? ""}
              onChange={(e) => switchSession(e.target.value)}
              title="切换会话（会话存在本机浏览器，最多 30 个）"
              className="h-7 max-w-[200px] rounded-md border border-border bg-card px-1.5 text-[11.5px] text-muted-foreground outline-none hover:text-foreground">
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.title}（{s.messages.length} 条）</option>
              ))}
            </select>
          )}
          {started && (
            <button onClick={() => { dropSession(session!.id); }} title="删除当前会话（只删本机记录）"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-rose-500/40 hover:text-rose-400">
              <Trash2 size={13} />
            </button>
          )}
          <button onClick={() => { newSession(); }} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            新对话
          </button>
        </div>
      </div>

      {!started ? (
        <div className="flex flex-1 flex-col justify-center pb-6">
          <div className="mb-1 flex items-center justify-center gap-2 text-2xl font-bold">
            <Sparkles size={22} className="text-sky-400" />
            向 MyDesk 提问
          </div>
          <p className="mb-6 text-center text-xs text-muted-foreground">
            AI 交易员自动调用 eltdx / 东财 / 腾讯真实接口取数 · 事实与推断分离 · 不构成投资建议
          </p>

          {/* 大输入框 */}
          <div className="rounded-xl border border-border bg-card p-3 shadow-sm focus-within:border-sky-500/50">
            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  onClick={() => setModeOpen((v) => !v)}
                  className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs text-foreground hover:bg-sky-500/10 hover:text-sky-300"
                >
                  {MODES.find((m) => m.key === mode)?.label} <ChevronDown size={12} />
                </button>
                {modeOpen && (
                  <div className="absolute left-0 top-9 z-20 w-52 rounded-lg border border-border bg-popover p-1 shadow-lg">
                    {MODES.map((m) => (
                      <button key={m.key} onClick={() => { setMode(m.key); setModeOpen(false); }}
                        className="block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-accent">
                        <div className="font-medium">{m.label}</div>
                        <div className="text-[10.5px] text-muted-foreground">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
                placeholder="问行情、问个股、描述选股条件…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
              <button onClick={() => submit()} disabled={busy || !input.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500 text-white disabled:opacity-40 hover:bg-sky-400">
                <Send size={15} />
              </button>
            </div>
          </div>

          {/* 推荐问题 */}
          <div className="mt-4">
            <div className="mb-2 text-xs text-muted-foreground">💡 试试这样问</div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => submit(s)}
                  className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300">
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* 今日市场状态（市场雷达 P2 上线前，为真实市场状态摘要） */}
          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">🔥 今日市场状态</div>
              <button onClick={() => go("market")} className="text-xs text-sky-400 hover:underline">大盘情绪仪表盘 →</button>
            </div>
            {sentLoading && <div className="text-xs text-muted-foreground">市场状态加载中…</div>}
            {sentErr && <div className="text-xs text-amber-400">市场状态获取失败：{sentErr}</div>}
            {sent && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="上涨 / 下跌" value={<span><span className="text-red-500">{sent.advancers}</span> / <span className="text-emerald-500">{sent.decliners}</span></span>} />
                <Stat label="涨停 / 跌停" value={<span><span className="text-red-500">{sent.limit_up}</span> / <span className="text-emerald-500">{sent.limit_down}</span></span>} />
                <Stat label="成交额" value={`${sent.amount_total_yi.toFixed(0)} 亿`} />
                <Stat label="风险等级" value={<span className="text-amber-400">{sent.risk.level}</span>} />
                <div className="col-span-2 flex items-center gap-3 border-t border-border/60 pt-2 sm:col-span-4">
                  {sent.indices.map((ix) => (
                    <div key={ix.symbol} className="text-xs">
                      <span className="text-muted-foreground">{ix.name}</span>{" "}
                      <span className="font-medium">{ix.price.toFixed(2)}</span>{" "}
                      <PctText value={ix.changePct} />
                    </div>
                  ))}
                  <div className="ml-auto text-[10.5px] text-muted-foreground">主力净额 {sent.main_net_sum_yi.toFixed(0)} 亿</div>
                </div>
              </div>
            )}
            <div className="mt-2 text-[10.5px] leading-4 text-muted-foreground/70">
              「AI 主动发现」属 P2 市场雷达（交易日收盘后由服务进程内的调度器自动扫描一次，也可在雷达页手动扫描；服务未启动时不会自动跑），此处为真实市场状态摘要；{sent?.missing.length ? `暂缺：${sent.missing.join("、")}` : ""}
            </div>
          </div>
        </div>
      ) : (
        /* 会话区 */
        <div className="desk-scroll flex-1 space-y-4 overflow-y-auto py-4">
          {msgs.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-sky-500/10 px-3.5 py-2 text-sm">{m.content}</div>
              ) : (
                <div className="max-w-full rounded-xl border border-border bg-card px-4 py-3 text-sm">
                  <Markdown content={m.content} />
                  {m.streaming && <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 animate-pulse bg-sky-400" />}
                  <StepTimeline steps={m.steps} warning={m.warning} streaming={m.streaming} />
                </div>
              )}
            </div>
          ))}
          {busy && msgs.at(-1)?.role !== "assistant" && <div className="text-xs text-muted-foreground">AI 正在调用真实数据接口…</div>}
          {!aiConfigured(ai) && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              AI 未配置：请到「设置 → AI 接口」配置 OpenAI 兼容接口（如 DeepSeek）后再使用 AI 交易员。
              <button onClick={() => go("settings")} className="ml-2 underline">去设置</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* 底部输入（会话态） */}
      {started && (
        <div className="pb-4">
          <div className="rounded-xl border border-border bg-card p-3 focus-within:border-sky-500/50">
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setModeOpen((v) => !v)} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs hover:bg-sky-500/10 hover:text-sky-300">
                  {MODES.find((m) => m.key === mode)?.label} <ChevronDown size={12} />
                </button>
                {modeOpen && (
                  <div className="absolute bottom-10 left-0 z-20 w-52 rounded-lg border border-border bg-popover p-1 shadow-lg">
                    {MODES.map((m) => (
                      <button key={m.key} onClick={() => { setMode(m.key); setModeOpen(false); }} className="block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-accent">
                        <div className="font-medium">{m.label}</div>
                        <div className="text-[10.5px] text-muted-foreground">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
                placeholder="继续提问…（流式输出，可随时停止）"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
              {busy ? (
                <button onClick={stop} title="停止本次回答（保留已生成的部分）"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
                  <Square size={14} />
                </button>
              ) : (
                <button onClick={() => submit()} disabled={!input.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500 text-white disabled:opacity-40 hover:bg-sky-400">
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>
          <div className="mt-1.5 text-center text-[10px] text-muted-foreground/60">
            AI 输出区分【事实 / 模型推断 / 风险提示】，数据缺失会显式标注 · 关注 {focusSymbol} · 每次点「新对话」都会留着上一条，可切换或删除
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-accent/40 px-3 py-2">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}
