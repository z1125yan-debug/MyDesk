"use client";
// AI 对话首页（需求文档 P0：居中大输入框 + 模式选择 + 推荐问题 + 市场状态摘要）
import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Sparkles, RotateCcw, ChevronDown } from "lucide-react";
import Markdown from "../Markdown";
import { SourceBadge, PctText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured } from "@/lib/desk/ai";
import { aiChatTools, type AiChatTrace, fetchSentiment, type SentimentClient } from "@/lib/desk/quant-api";

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

interface Msg { role: "user" | "assistant"; content: string; trace?: AiChatTrace[] }

export default function AiHomePage() {
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const [mode, setMode] = useState<Mode>("decision");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modeOpen, setModeOpen] = useState(false);
  const [sent, setSent] = useState<SentimentClient | null>(null);
  const [sentErr, setSentErr] = useState("");
  const [sentLoading, setSentLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setError("");
    if (!aiConfigured(ai)) {
      setError("AI 未配置：请到「设置 → AI 接口」配置 OpenAI 兼容接口（如 DeepSeek）后再使用 AI 交易员。");
      return;
    }
    setInput("");
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setBusy(true);
    try {
      const { content, trace } = await aiChatTools(
        { provider: ai.provider, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, proxy: ai.proxy },
        next.filter((m) => !m.trace).map((m) => ({ role: m.role, content: m.content })),
        { mode, focusSymbol },
      );
      setMsgs([...next, { role: "assistant", content, trace }]);
    } catch (e) {
      setError(String((e as Error).message || e));
      setMsgs(next);
    } finally {
      setBusy(false);
    }
  };

  const openProfile = (raw: string) => {
    const m = /^(\d{6})/.exec(raw.trim());
    if (!m) return;
    const code = m[1];
    const symbol = /^(60|68|9)/.test(code) ? `${code}.SH` : /^(43|83|87|92)/.test(code) ? `${code}.BJ` : `${code}.SZ`;
    setFocusSymbol(symbol);
    go("profile");
  };

  const started = msgs.length > 0;

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6">
      {/* 顶部状态 */}
      <div className="flex items-center justify-between pt-4">
        <SourceBadge status={sent?.live ? "LIVE" : sent ? "HISTORICAL" : sentErr ? "OFFLINE" : "…"} source={sent?.source.provider.split("（")[0]} time={sent?.as_of.slice(11)} />
        {started && (
          <button onClick={() => { setMsgs([]); setError(""); }} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <RotateCcw size={13} /> 新对话
          </button>
        )}
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
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) send(); }}
                placeholder="问行情、问个股、描述选股条件…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
              <button onClick={() => send()} disabled={busy || !input.trim()}
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
                <button key={s} onClick={() => send(s)}
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
        <div className="flex-1 space-y-4 overflow-y-auto desk-scroll py-4">
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[85%] rounded-xl bg-sky-500/10 px-3.5 py-2 text-sm">{m.content}</div>
              ) : (
                <div className="max-w-full rounded-xl border border-border bg-card px-4 py-3 text-sm">
                  <Markdown content={m.content} />
                  {!!m.trace?.length && (
                    <details className="mt-2 border-t border-border/60 pt-2">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">证据链 · {m.trace.length} 次工具调用</summary>
                      <div className="mt-1 space-y-1">
                        {m.trace.map((t, k) => (
                          <div key={k} className="font-mono text-[10.5px] text-muted-foreground">
                            <span className={t.status === "ok" ? "text-emerald-400" : "text-red-400"}>{t.status}</span>{" "}
                            {t.name}({JSON.stringify(t.args).slice(0, 80)}) · {t.ms}ms · {t.summary}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="text-xs text-muted-foreground">AI 正在调用真实数据接口…</div>}
          {error && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{error}</div>}
          <div ref={bottomRef} />
        </div>
      )}

      {/* 底部输入（会话态） */}
      {started && (
        <div className="pb-4">
          <div className="rounded-xl border border-border bg-card p-3 focus-within:border-sky-500/50">
            <div className="flex items-center gap-2">
              <button onClick={() => setModeOpen((v) => !v)} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs hover:bg-sky-500/10 hover:text-sky-300">
                {MODES.find((m) => m.key === mode)?.label} <ChevronDown size={12} />
              </button>
              {modeOpen && (
                <div className="absolute bottom-20 left-8 z-20 w-52 rounded-lg border border-border bg-popover p-1 shadow-lg">
                  {MODES.map((m) => (
                    <button key={m.key} onClick={() => { setMode(m.key); setModeOpen(false); }} className="block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-accent">
                      <div className="font-medium">{m.label}</div>
                      <div className="text-[10.5px] text-muted-foreground">{m.desc}</div>
                    </button>
                  ))}
                </div>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) send(); }}
                placeholder="继续提问…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
              <button onClick={() => send()} disabled={busy || !input.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500 text-white disabled:opacity-40 hover:bg-sky-400">
                <Send size={15} />
              </button>
            </div>
          </div>
          <div className="mt-1.5 text-center text-[10px] text-muted-foreground/60">
            AI 输出区分【事实 / 模型推断 / 风险提示】，数据缺失会显式标注 · 关注 {focusSymbol}
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
