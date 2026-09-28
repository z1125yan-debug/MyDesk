"use client";
import { useEffect, useMemo, useState } from "react";
import { Plus, LineChart, BarChart3, MessageSquareText, Info, Loader2 } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { fetchQuoteCards, searchSymbols, type QuoteCardsResult } from "@/lib/desk/market";
import { useLivePoll } from "@/hooks/use-live-poll";
import LiveStamp from "@/components/desk/LiveStamp";
import Sparkline from "../Sparkline";

export default function OverviewPage() {
  const watchlist = useDesk((s) => s.watchlist);
  const addWatch = useDesk((s) => s.addWatch);
  const removeWatch = useDesk((s) => s.removeWatch);
  const go = useDesk((s) => s.go);
  // R17b：原来这页自带一套 setInterval + 写 ref 的倒计时（休市暂停的口径各页一份，还漏了「数据截至」）。
  // 换成全站共用的轮询钩子 + 活体戳：开盘才刷、休市暂停、屏幕上写明这批数是几点取的。
  const poll = useLivePoll();
  const [sym, setSym] = useState("");
  const [addError, setAddError] = useState("");

  const watchKey = watchlist.map((w) => w.symbol).join(",");
  const [data, setData] = useState<QuoteCardsResult>({ cards: [], source: "demo" });
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState("");

  useEffect(() => {
    let dead = false;
    const symbols = watchKey ? watchKey.split(",") : [];
    setLoading(true);
    fetchQuoteCards(symbols)
      .then((r) => {
        if (dead) return;
        setData(r);
        // 时刻＝本轮取数完成的本机时刻（跟看板 asOf 同一口径）：一张卡片取到真报价才算真取到
        setFetchedAt(r.cards.some((c) => !c.missing) ? new Date().toISOString() : "");
      })
      .catch(() => {
        if (dead) return;
        setData({ cards: [], source: "demo" });
        setFetchedAt("");
      })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [watchKey, poll.tick]);

  const nameOf = useMemo(() => new Map(watchlist.map((w) => [w.symbol, w.name])), [watchlist]);
  const sourceLabel =
    data.source === "real" ? "本地实时数据源" : data.source === "mixed" ? "实时 + 演示混合（演示品种不是实时行情）" : "演示数据（非实时行情）";

  const submit = async () => {
    const kw = sym.trim();
    if (!kw) return;
    setAddError("");
    try {
      const items = await searchSymbols(kw);
      const first = items[0];
      if (!first) { setAddError(`没找到“${kw}”，试试 6 位代码或名称/拼音`); return; }
      addWatch({ symbol: first.symbol, name: first.name || first.symbol, kind: "watch" });
      setSym("");
    } catch {
      setAddError("搜索服务暂时不可用，请稍后再试");
    }
  };

  return (
    <div className="w-full space-y-5 p-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold">总览</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            自选行情卡片 · {sourceLabel} · 涨跌幅为当日 · {poll.open ? `交易时段每 ${poll.interval}s 自动刷新` : `A股${poll.sessionLabel}，自动刷新已暂停`}
          </p>
        </div>
        <LiveStamp poll={poll} iso={fetchedAt} />
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {loading && !data.cards.length && (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-[13.5px] text-muted-foreground">
            <Loader2 size={14} className="animate-spin text-sky-400" /> 正在获取行情…
          </div>
        )}
        {data.cards.map((quote) => {
          const wname = nameOf.get(quote.symbol) || quote.name;
          if (quote.missing) {
            return (
              <div key={quote.symbol} className="group rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[14.5px] font-medium">{wname}</div>
                    <div className="font-mono text-[12px] text-muted-foreground">{quote.symbol}</div>
                  </div>
                  <button
                    onClick={() => removeWatch(quote.symbol)}
                    className="text-[12px] text-muted-foreground opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
                  >移除</button>
                </div>
                <div className="mt-4 text-[13.5px] text-muted-foreground">行情暂不可用（数据源断开或停牌）</div>
              </div>
            );
          }
          const up = quote.changePct >= 0;
          return (
            <div key={quote.symbol} className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-sky-500/40">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[14.5px] font-medium">{wname}</div>
                  <div className="font-mono text-[12px] text-muted-foreground">{quote.symbol}</div>
                </div>
                <button
                  onClick={() => removeWatch(quote.symbol)}
                  className="text-[12px] text-muted-foreground opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
                >移除</button>
              </div>
              <div className="mt-2.5 flex items-end justify-between">
                <div>
                  <div className="font-mono text-[23px] font-bold leading-6 tabular-nums">{quote.price.toFixed(2)}</div>
                  <div className={"mt-0.5 font-mono text-[13.5px] " + (up ? "text-rose-400" : "text-emerald-400")}>
                    {up ? "+" : ""}{quote.changePct.toFixed(2)}%<span className="ml-1 text-[11.5px] text-muted-foreground">当日</span>
                  </div>
                  {quote.data_status === "DEMO" && (
                    <div className="mt-0.5 text-[11.5px] text-amber-300">演示品种 · 不是实时行情</div>
                  )}
                </div>
                {quote.series.length > 1 && <Sparkline data={quote.series} up={up} width={110} height={38} />}
              </div>
              <button
                onClick={() => { useDesk.getState().setFocusSymbol(quote.symbol); go("analysis"); }}
                className="mt-3 w-full rounded-md border border-border py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-sky-500/40 hover:text-sky-300"
              >去分析 →</button>
            </div>
          );
        })}

        <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
          <div className="text-[14px] font-medium text-muted-foreground">添加自选</div>
          <div className="mt-2.5 space-y-2">
            <input value={sym} onChange={(e) => { setSym(e.target.value); setAddError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="代码/名称/拼音，如 688256 或 寒武纪"
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[13px] outline-none focus:border-sky-500/60" />
            <button onClick={submit}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-sky-500/90 text-[13.5px] font-medium text-white hover:bg-sky-500">
              <Plus size={14} /> 搜索并添加
            </button>
            {addError && <div className="text-[12px] text-amber-300">{addError}</div>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        {[
          { icon: LineChart, title: "AI 图表分析", desc: "真实K线 + 支撑/阻力 + 结构化解读", to: "analysis" as const },
          { icon: BarChart3, title: "数据看板", desc: "板块/个股资金榜与资金去向图（交易时段实时）", to: "board" as const },
          { icon: MessageSquareText, title: "智能助手", desc: "多会话 AI 对话，随问随答", to: "copilot" as const },
        ].map((c) => {
          const Icon = c.icon;
          return (
            <button key={c.title} onClick={() => go(c.to)}
              className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-sky-500/40">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/12 text-sky-400">
                <Icon size={19} />
              </div>
              <div>
                <div className="text-[14.5px] font-medium">{c.title}</div>
                <div className="text-[13px] text-muted-foreground">{c.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
