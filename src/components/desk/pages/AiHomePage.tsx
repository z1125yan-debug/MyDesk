"use client";
// AI 首页：居中大输入框 + 模式选择 + 推荐问题 + 今日市场速览。
// 呈现层走纯黑苹果风；工程口径（取数链路、会话链说明）不再外露。
import { useCallback, useEffect, useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { PctText } from "../SourceBadge";
import ChatModeMenu from "../ui/ChatModeMenu";
import { useDesk } from "@/lib/desk/store";
import { aiReady } from "@/lib/desk/ai";
import { fetchSentiment, type SentimentClient } from "@/lib/desk/quant-api";

const SUGGESTIONS = [
  "今天大盘情绪怎么样？风险高不高？",
  "帮我找：放量上涨 + 主力净流入 + 换手大于3%",
  "今天哪些板块主力资金流入最强？",
  "帮我看看 688256 现在怎么样，能不能追？",
  "现在市场里最强的主线是什么？",
];

export default function AiHomePage() {
  const ai = useDesk((s) => s.ai);
  const go = useDesk((s) => s.go);
  const askInAssistant = useDesk((s) => s.askInAssistant);
  const [input, setInput] = useState("");
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

  const submit = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setInput("");
    askInAssistant(q);
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6">
      <div className="flex flex-1 flex-col justify-center py-8">
        {/* Hero */}
        <div className="apple-slide-up text-center">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-border/70 bg-white/[0.03] px-3.5 py-1.5 text-[12px] text-muted-foreground">
            <Sparkles size={13} className="text-sky-300" />
            你的 AI 投资助手
          </div>
          <h1 className="mt-4 text-[30px] font-semibold tracking-tight">有什么想问问市场？</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">问行情、问个股、描述你想要的条件，剩下的交给我。</p>
        </div>

        {/* 大输入框 */}
        <div className="apple-card apple-fade-in mt-7 p-2 shadow-2xl">
          <div className="flex items-center gap-2 px-2 pt-1">
            {/* 风格菜单与对话页 composer 同一个组件（一份定义两处消费，画法也不再各写各的） */}
            <ChatModeMenu />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
              placeholder="输入股票、板块，或说说你的疑问…"
              className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-[15px] outline-none placeholder:text-muted-foreground/50"
            />
            <button onClick={() => submit()} disabled={!input.trim()} className="apple-primary-btn flex h-10 w-10 items-center justify-center">
              <Send size={16} />
            </button>
          </div>
        </div>

        {!aiReady(ai) && (
          <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3.5 py-2.5 text-[13px] text-amber-200">
            还没配置 AI 模型。<button onClick={() => go("settings")} className="ml-1 underline">去设置</button>
          </div>
        )}

        {/* 推荐问题 */}
        <div className="apple-stagger mt-6 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => submit(s)}
              className="rounded-full border border-border/70 bg-white/[0.02] px-4 py-2 text-[12.5px] text-muted-foreground transition-all hover:border-sky-400/30 hover:text-sky-200">
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* 今日市场速览 */}
      <div className="pb-8">
        <div className="apple-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[14px] font-medium">今日市场</div>
            <button onClick={() => go("market")} className="text-[12.5px] text-sky-300 hover:underline">看大盘 →</button>
          </div>
          {sentLoading && <div className="text-[12.5px] text-muted-foreground">正在获取…</div>}
          {sentErr && <div className="text-[12.5px] text-amber-300/90">市场数据暂时取不到。</div>}
          {sent && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="上涨 / 下跌" value={<span><span className="text-red-400">{sent.advancers}</span> / <span className="text-emerald-400">{sent.decliners}</span></span>} />
                <Stat label="涨停 / 跌停" value={<span><span className="text-red-400">{sent.limit_up}</span> / <span className="text-emerald-400">{sent.limit_down}</span></span>} />
                <Stat label="成交额" value={`${sent.amount_total_yi.toFixed(0)} 亿`} />
                <Stat label="风险等级" value={<span className="text-amber-300">{sent.risk.level}</span>} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border/60 pt-3">
                {sent.indices.map((ix) => (
                  <div key={ix.symbol} className="text-[12.5px]">
                    <span className="text-muted-foreground">{ix.name}</span>{" "}
                    <span className="font-medium">{ix.price.toFixed(2)}</span>{" "}
                    <PctText value={ix.changePct} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="apple-inset px-4 py-3">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-[16px] font-semibold">{value}</div>
    </div>
  );
}
