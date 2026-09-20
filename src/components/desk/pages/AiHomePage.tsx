"use client";
// AI 对话首页（需求文档 P0：居中大输入框 + 模式选择 + 推荐问题 + 市场状态摘要）
//
// P7-⑥⑥：这一页收敛成「纯入口」，不再自己发请求。
// 为什么：上一版首页和助手页各挂了一套 useChatSend（首页固定 tools 端点、小窗固定 plain 端点），
// 同一个问题从两个入口进去，走的工具链、步骤编号、系统提示词口径都可能不一样 ——
// 「首页有场景徽章、别处没徽章」就是它吃过的亏。现在首页只决定「问什么 + 用什么回答风格」，
// 问题经 store 的一次性 pendingAsk 交给唯一的对话页发送，全应用只剩一条会话存档和一条工具调用链。
// 两个刻意的取舍：
// 1) 这里不另开会话 —— 从首页接着问，是为了让「那这个股明天怎么看」还能续上当前会话的上下文；
//    要开新对话去助手页顶栏点。
// 2) pendingAsk 不在 store 的 partialize 白名单里，因此不落盘：刷新页面不会把上一句重发一遍。
// 回答风格也读自 store（assistantMode）而不是本页 useState：首页的下拉与对话页的 chip 是同一个设置的
// 两种画法，各存一份就会出现「首页选了研判、对话页按决策发」这种看不出来的错位。
import { useCallback, useEffect, useState } from "react";
import { Send, Sparkles, ChevronDown } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured } from "@/lib/desk/ai";
import { CHAT_MODES, chatModeLabel } from "@/lib/desk/modes";
import { fetchSentiment, type SentimentClient } from "@/lib/desk/quant-api";

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
  const askInAssistant = useDesk((s) => s.askInAssistant);
  const mode = useDesk((s) => s.assistantMode);
  const setMode = useDesk((s) => s.setAssistantMode);
  const [input, setInput] = useState("");
  const [modeOpen, setModeOpen] = useState(false);
  const [sent, setSent] = useState<SentimentClient | null>(null);
  const [sentErr, setSentErr] = useState("");
  const [sentLoading, setSentLoading] = useState(true);

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

  // 交接：写一次性 pendingAsk + 切到对话页，发送由那边的 useChatSend 做。
  // 回答风格不用随行传过去 —— 它已经在 store.assistantMode 上（下拉改动的那一刻就写进去了），
  // 对话页与请求参数读的都是同一个值。
  // 首页不再有 busy/stop：停止与流式进度都属于「那条唯一的对话链」的状态，只在一处显示。
  const submit = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setInput("");
    askInAssistant(q);
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6">
      {/* 顶部状态 */}
      <div className="flex items-center justify-between gap-2 pt-4">
        <SourceBadge status={sent?.live ? "LIVE" : sent ? "HISTORICAL" : sentErr ? "OFFLINE" : "…"} source={sent?.source.provider.split("（")[0]} time={sent?.as_of.slice(11)} />
        <button onClick={() => go("copilot")} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          继续上次对话 →
        </button>
      </div>

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
                title="回答风格（与对话页顶部同一份设置，存在本机）"
                className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs text-foreground hover:bg-sky-500/10 hover:text-sky-300"
              >
                {chatModeLabel(mode)} <ChevronDown size={12} />
              </button>
              {modeOpen && (
                <div className="absolute left-0 top-9 z-20 w-52 rounded-lg border border-border bg-popover p-1 shadow-lg">
                  {CHAT_MODES.map((m) => (
                    <button key={m.key} onClick={() => { setMode(m.key); setModeOpen(false); }}
                      className={"block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-accent" + (m.key === mode ? " text-sky-300" : "")}>
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
              placeholder="问行情、问个股、描述选股条件…（回车后到对话页回答）"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <button onClick={() => submit()} disabled={!input.trim()}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500 text-white disabled:opacity-40 hover:bg-sky-400">
              <Send size={15} />
            </button>
          </div>
          <div className="mt-1.5 text-[10.5px] text-muted-foreground/70">
            回答风格「{chatModeLabel(mode)}」（与对话页顶部同步）· 发送后到对话页看回答、工作过程与场景徽章
          </div>
        </div>

        {!aiConfigured(ai) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            AI 未配置：现在提问只会切到对话页并显示这条提醒，不会真的取数。
            <button onClick={() => go("settings")} className="ml-2 underline">去设置</button>
          </div>
        )}

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

        <div className="mt-3 text-center text-[10px] text-muted-foreground/60">
          全应用只有一条会话链：这里的提问会在对话页接着当前会话回答（关注标的 {focusSymbol} 随问题一起带过去），要开新对话请到对话页顶栏
        </div>
      </div>
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
