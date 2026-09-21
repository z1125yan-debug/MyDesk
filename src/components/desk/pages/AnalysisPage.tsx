"use client";
import { useEffect, useMemo, useState } from "react";
import { Play, Loader2, Crosshair, TrendingUp, Plus, Settings2, Bot } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { autoLevels, TIMEFRAMES, CATALOG, HOT_SYMBOLS } from "@/lib/desk/data";
import { fetchCandlesFor, fetchQuoteCards, searchSymbols, fetchTechSnapshot, fetchNewsBlock, normalizeTradingViewSymbol, trendLabel, isDemoSymbol, type SuggestItem, type TechSnapshot } from "@/lib/desk/market";
import { aiChat, aiReady, assistantSystemPrompt, parseLooseJson } from "@/lib/desk/ai";
import { marketSession, shanghaiStamp } from "@/lib/desk/session";
import {
  provenanceOfQuote, provenanceOfTechSnapshot, renderMarketContext, type CtxRow,
} from "@/lib/desk/ai-context-core";
import type { TrackerPlan, Candle, QuoteCard } from "@/lib/desk/types";
import CandleChart from "../CandleChart";
import Markdown from "../Markdown";
import AssistantWidget from "../AssistantWidget";

interface AnalysisResult {
  structure?: string;
  support?: number[];
  resistance?: number[];
  bias?: string;
  entry?: number;
  stop?: number;
  targets?: number[];
  risk?: string;
}

export default function AnalysisPage() {
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const go = useDesk((s) => s.go);
  const ai = useDesk((s) => s.ai);
  const addTracker = useDesk((s) => s.addTracker);
  const addHistory = useDesk((s) => s.addHistory);

  const [tf, setTf] = useState("日线");
  const [showChannel, setShowChannel] = useState(true);
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [rawText, setRawText] = useState("");
  const [dlgOpen, setDlgOpen] = useState(false);
  const [plan, setPlan] = useState({ direction: "long" as "long" | "short", entry: "", stop: "", targets: "", note: "" });
  const [chatOpen, setChatOpen] = useState(false);

  // 书签/外部链接直达：#/analysis?symbol=SSE:688256 自动换算并聚焦
  useEffect(() => {
    const applyHash = () => {
      const m = /[?#&]symbol=([^&]+)/.exec(window.location.hash + window.location.search);
      if (!m) return;
      const sym = normalizeTradingViewSymbol(decodeURIComponent(m[1]));
      if (sym && sym !== focusSymbol) {
        setFocusSymbol(sym);
        setResult(null);
        setRawText("");
        // 清掉参数避免刷新时重复应用
        window.location.hash = "#/analysis";
      }
    };
    applyHash();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const symbol = focusSymbol || "000001.SH";
  const [candles, setCandles] = useState<Candle[]>([]);
  const [kSource, setKSource] = useState<"real" | "demo">("demo");
  const [kLoading, setKLoading] = useState(false);
  const [quote, setQuote] = useState<QuoteCard | null>(null);
  const [results, setResults] = useState<SuggestItem[]>([]);
  const [snap, setSnap] = useState<TechSnapshot | null>(null);

  useEffect(() => {
    let dead = false;
    setSnap(null);
    fetchTechSnapshot(symbol).then((s) => { if (!dead) setSnap(s); }).catch(() => {});
    return () => { dead = true; };
  }, [symbol]);

  useEffect(() => {
    let dead = false;
    setKLoading(true);
    fetchCandlesFor(symbol, tf)
      .then((r) => { if (!dead) { setCandles(r.candles); setKSource(r.source); } })
      .finally(() => { if (!dead) setKLoading(false); });
    return () => { dead = true; };
  }, [symbol, tf]);

  useEffect(() => {
    let dead = false;
    const load = () => {
      // 非交易时段上游不会有新数据：跳过周期轮询（首次加载仍执行，显示最近收盘数据）
      if (!marketSession().open) return;
      fetchQuoteCards([symbol]).then((r) => { if (!dead) setQuote(r.cards[0] ?? null); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => { dead = true; clearInterval(t); };
  }, [symbol]);

  // 关键位只看最近 60 根：才是贴近现价、有操作意义的支撑/阻力
  const levels = useMemo(() => (candles.length ? autoLevels(candles.slice(-60)) : null), [candles]);

  // 面板主数值跟随当前选中的周期（与图表通道/关键位完全一致）
  const tfTrend = useMemo(() => trendLabel(candles.slice(-60).map((c) => c.c)), [candles]);
  const lastPrice = quote?.price ?? candles[candles.length - 1]?.c ?? 0;
  const sup = levels?.supports.length ? levels.supports[levels.supports.length - 1] : null;
  const res = levels?.resistances.length ? levels.resistances[0] : null;
  const rr = sup != null && res != null && res > lastPrice && lastPrice > sup
    ? (res - lastPrice) / Math.max(1e-9, lastPrice - sup)
    : null;
  const name = quote?.name || CATALOG.find((c) => c.symbol === symbol)?.name || symbol;

  const configured = aiReady(ai);

  // 图表上下文：每条都带来源分层（P6-A）。原来整段被提示词称为「真实行情数据」，
  // 但 K 线可能是演示回退、报价可能是缺失行、分时可能是合成序列——分层写进文本里，模型无从混用。
  const chartContext = () => {
    if (!candles.length) return "行情上下文：本次没有取得 K 线（状态 MISSING）。没有数据就不做技术面判断，先说明缺什么。";
    const recent = candles.slice(-14);
    const hi = Math.max(...candles.map((c) => c.h));
    const lo = Math.min(...candles.map((c) => c.l));
    const quoteProv = provenanceOfQuote(quote, isDemoSymbol(symbol));
    const rows: CtxRow[] = [];
    if (quote) {
      rows.push({
        label: `${symbol}（${name}）报价`,
        provenance: quoteProv,
        lines: quoteProv === "REAL"
          ? [`最新价 ${(quote.price ?? 0).toFixed(2)}（${(quote.changePct ?? 0) >= 0 ? "+" : ""}${(quote.changePct ?? 0).toFixed(2)}%）`]
          : quoteProv === "MISSING"
            ? ["本次未取到报价：不知道现价就不要给价位，也不要用 0"]
            : [`展示值 ${(quote.price ?? 0).toFixed(2)}：本机演示数据，不是行情`],
        note: quoteProv === "REAL" && quote.series_synthetic ? "分时缩略序列按现价合成，只用于绘图，不是真实成交轨迹" : undefined,
      });
    }
    rows.push({
      label: `${symbol}（${name}）${tf} K线序列与本机算法识别结果`,
      provenance: provenanceOfTechSnapshot(kSource),
      lines: [
        `区间最高/最低: ${hi.toFixed(2)} / ${lo.toFixed(2)}`,
        `算法识别支撑: ${levels?.supports.map((v) => v.toFixed(2)).join(", ") || "无"}`,
        `算法识别阻力: ${levels?.resistances.length ? levels.resistances.map((v) => v.toFixed(2)).join(", ") : "无"}`,
        ...(snap ? [
          `多周期趋势: ${snap.tfs.map((t) => `${t.tf}=${t.trend}`).join(", ")}`,
          `RSI(14): ${snap.tfs.map((t) => `${t.tf} ${t.rsi?.toFixed(1) ?? "—"}`).join(", ")}`,
          ...(snap.rangePos != null ? [`近半年区间位置: ${snap.rangePos.toFixed(0)}%（${snap.rangeLow?.toFixed(2)} ~ ${snap.rangeHigh?.toFixed(2)}）`] : []),
        ] : []),
        `最近14根收盘: ${recent.map((c) => c.c.toFixed(2)).join(", ")}`,
      ],
      note: kSource === "demo"
        ? "K 线为演示回退数据：以下数字只是算法演示，不构成对真实市场的任何结论"
        : "K 线为真实行情；支撑/阻力/趋势/RSI 由本机算法对这段 K 线计算得出，不是交易所发布的指标",
    });
    return renderMarketContext(rows, { takenAt: shanghaiStamp() });
  };

  const runAnalysis = async () => {
    if (!configured) { go("settings"); return; }
    setRunning(true); setResult(null); setRawText("");
    const sys = [
      "你是 MyDesk 行情工作台的图表分析引擎，面向个人投资者做技术面解读。",
      "只基于【用户提供的行情上下文】分析：价格、支撑、阻力、RSI、趋势等数值只能取自数据本身，禁止编造数据里没有的数值，禁止引用外部消息。",
      "上下文里每条都标了来源：标 DEMO（演示数据）/ MISSING（缺失）的部分不得当成真实行情；只有标 REAL 的可以直接引用，标 DERIVED 的要说明是本机算法算出来的。",
      "只输出一个 JSON 对象，不要 markdown 代码块，字段：",
      '{"structure":"当前趋势/结构/形态解读，120字内","support":[数字],"resistance":[数字],"bias":"看多|看空|震荡","entry":数字,"stop":数字,"targets":[数字,数字],"risk":"风险提示，80字内"}',
      "support/resistance 必须取自数据中的算法识别支撑/阻力；bias 必须与结构解读一致；entry 取最新价附近；语言简明中文。risk 里提醒：分析仅供参考，不构成投资建议。",
      "如果上下文里根本没有可用的最新价（MISSING/DEMO），就在 structure 里第一句写明「未取得真实行情，以下为演示口径」，不要把演示数字包装成真实结论。",
    ].join("\n");
    try {
      const text = await aiChat(ai, [
        { role: "system", content: sys },
        { role: "user", content: `请基于以下行情上下文（已逐条标注来源分层）做技术面分析：\n${chartContext()}` },
      ]);
      const parsed = parseLooseJson<AnalysisResult>(text);
      if (parsed && (parsed.structure || parsed.bias)) setResult(parsed);
      else setRawText(text);
      addHistory({
        id: String(Date.now()), symbol, name, style: "技术面", timeframe: tf,
        summary: parsed?.structure || text.slice(0, 120), createdAt: new Date().toLocaleString("zh-CN"),
        meta: {
          bias: parsed?.bias,
          entry: parsed?.entry,
          stop: parsed?.stop,
          targets: parsed?.targets,
          risk: parsed?.risk,
          trend: tfTrend,
          rsi: snap?.tfs.find((t) => t.tf === tf)?.rsi ?? null,
          rangeHigh: snap?.rangeHigh ?? null,
          rangeLow: snap?.rangeLow ?? null,
          rangePos: snap?.rangePos ?? null,
        },
      });
    } catch (e) {
      setRawText(`分析失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const openTracker = () => {
    setPlan({
      direction: (result?.bias === "看空" ? "short" : "long"),
      entry: String(result?.entry ?? (quote?.price ?? candles[candles.length - 1]?.c ?? 0).toFixed(2)),
      stop: String(result?.stop ?? ""),
      targets: (result?.targets ?? []).join(", "),
      note: result?.structure ?? "",
    });
    setDlgOpen(true);
  };

  const saveTracker = () => {
    const t: TrackerPlan = {
      id: String(Date.now()), symbol, name, direction: plan.direction,
      entry: Number(plan.entry) || 0, stop: Number(plan.stop) || 0,
      targets: plan.targets.split(/[,，\s]+/).map(Number).filter((n) => !isNaN(n) && n > 0),
      note: plan.note, status: "watching", createdAt: new Date().toLocaleString("zh-CN"),
    };
    addTracker(t);
    setDlgOpen(false);
  };

  useEffect(() => {
    const kw = search.trim();
    if (!kw) { setResults([]); return; }
    const t = setTimeout(() => {
      searchSymbols(kw).then((r) => setResults(r.slice(0, 6))).catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-5 xl:flex-row">
      {/* 左：图表 */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex h-9 items-center overflow-hidden rounded-md border border-border">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索：代码/名称/拼音"
                className="h-full w-32 bg-transparent px-2.5 font-mono text-[12.5px] outline-none"
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto">
              {(search.trim()
                ? results.map((r) => ({ symbol: r.symbol, label: `${r.name} ${r.symbol}` }))
                : HOT_SYMBOLS.map((c) => ({ symbol: c.symbol, label: c.name }))
              ).map((c) => (
                <button key={c.symbol}
                  onClick={() => { setFocusSymbol(c.symbol); setSearch(""); setResults([]); setResult(null); setRawText(""); }}
                  className={"shrink-0 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors " +
                    (c.symbol === symbol ? "border-sky-500/50 bg-sky-500/12 text-sky-300" : "border-border text-muted-foreground hover:text-foreground")}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
              <div>
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[26px] font-bold tabular-nums">{(quote?.price ?? candles[candles.length - 1]?.c ?? 0).toFixed(2)}</span>
                  <span className={"font-mono text-[14px] " + ((quote?.changePct ?? 0) >= 0 ? "text-rose-400" : "text-emerald-400")}>
                    {(quote?.changePct ?? 0) >= 0 ? "+" : ""}{(quote?.changePct ?? 0).toFixed(2)}%
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  {name} · {symbol} · {kSource === "real" ? "真实行情" : "演示数据"}{kLoading ? " · K线加载中" : ""}
                </div>
              </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button onClick={() => setShowChannel((v) => !v)}
                className={"inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors " +
                  (showChannel ? "border-sky-500/50 bg-sky-500/12 text-sky-300" : "border-border text-muted-foreground hover:text-foreground")}>
                <Crosshair size={12.5} /> 趋势通道 {showChannel ? "开" : "关"}
              </button>
              <button onClick={() => setChatOpen((v) => !v)}
                className={"inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors " +
                  (chatOpen ? "border border-sky-500/50 bg-sky-500/12 text-sky-300" : "bg-sky-500/90 text-white hover:bg-sky-400")}>
                <Bot size={12.5} /> 智能助手
              </button>
            </div>
          </div>

          <div className="flex gap-1.5 overflow-x-auto border-b border-border px-4 pb-2.5">
            {TIMEFRAMES.map((t) => (
              <button key={t} onClick={() => { setTf(t); setResult(null); setRawText(""); }}
                className={"shrink-0 rounded-md px-2.5 py-1.5 font-mono text-[12px] transition-colors " +
                  (tf === t ? "bg-sky-500/15 font-semibold text-sky-300" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                {t}
              </button>
            ))}
          </div>

          <div className="px-2 pb-2 pt-1">
            <CandleChart candles={candles} prevClose={quote?.prevClose} symbol={symbol} showChannel={showChannel} />
          </div>
        </div>
      </div>

      {/* 右：AI 分析 + 副驾驶 */}
      <div className="w-full shrink-0 space-y-4 xl:w-[400px]">
        {/* 技术快照 · 多周期 */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-[13px] font-semibold">技术快照 · 多周期</span>
            <span className="text-[11px] text-muted-foreground">
              {snap ? (snap.source === "real" ? "真实行情" : "演示数据") : "计算中…"}
            </span>
          </div>
          {snap && (
            <div className="space-y-3.5 px-4 py-3.5">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-lg border border-border bg-background/60 p-2.5">
                  <div className="text-[11px] text-muted-foreground">信号（{tf} 趋势）</div>
                  <div className={"mt-0.5 text-[16px] font-bold " +
                    (tfTrend === "上行" ? "text-rose-400" : tfTrend === "下行" ? "text-emerald-400" : "text-sky-300")}>
                    {tfTrend}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-2.5">
                  <div className="text-[11px] text-muted-foreground">盈亏比（支撑→阻力）</div>
                  <div className="mt-0.5 font-mono text-[16px] font-bold text-sky-300">
                    {rr ? `${rr.toFixed(2)} : 1` : "—"}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-lg bg-emerald-500/10 p-2.5">
                  <div className="text-[11px] text-emerald-300/80">最近支撑</div>
                  <div className="font-mono text-[14px] text-emerald-300">{sup != null ? sup.toFixed(2) : "—"}</div>
                </div>
                <div className="rounded-lg bg-rose-500/10 p-2.5">
                  <div className="text-[11px] text-rose-300/80">最近阻力</div>
                  <div className="font-mono text-[14px] text-rose-300">{res != null ? res.toFixed(2) : "—"}</div>
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">多周期趋势</div>
                <div className="space-y-1">
                  {snap.tfs.map((t) => (
                    <div key={t.tf} className="flex items-center gap-2 text-[12px]">
                      <span className="w-9 font-mono text-muted-foreground">{t.tf}</span>
                      <span className={"w-14 " + (t.trend === "上行" ? "text-rose-400" : t.trend === "下行" ? "text-emerald-400" : "text-sky-300")}>
                        {t.trend === "上行" ? "↑ " : t.trend === "下行" ? "↓ " : "→ "}{t.trend}
                      </span>
                      <span className="ml-auto rounded bg-accent px-1.5 py-0.5 font-mono text-[11px]">
                        RSI {t.rsi != null ? t.rsi.toFixed(1) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {snap.rangePos != null && (
                <div>
                  <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                    <span className="font-mono">{snap.rangeLow?.toFixed(2)}</span>
                    <span>区间位置 {snap.rangePos.toFixed(0)}%</span>
                    <span className="font-mono">{snap.rangeHigh?.toFixed(2)}</span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-gradient-to-r from-emerald-500/60 via-accent to-rose-500/60">
                    <div className="absolute h-3 w-1 rounded bg-sky-400"
                      style={{ left: `calc(${Math.min(98, Math.max(2, snap.rangePos))}% - 2px)`, top: -2 }} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold">
              <TrendingUp size={15} className="text-sky-400" /> AI 结构化分析
            </div>
            <button onClick={runAnalysis} disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-3.5 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-60">
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {running ? "分析中…" : "开始分析"}
            </button>
          </div>

          <div className="px-4 py-3.5">
            {!configured ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-[12.5px] leading-5 text-amber-200/90">
                AI 还没配置：需要填入你自己的模型接口（OpenAI / Claude / Gemini / DeepSeek / Ollama 等）。
                <button onClick={() => go("settings")} className="ml-1 inline-flex items-center gap-1 font-medium text-sky-300 underline underline-offset-2">
                  <Settings2 size={12} /> 去设置
                </button>
              </div>
            ) : !result && !rawText && !running ? (
              <div className="py-3 text-center text-[12.5px] leading-5 text-muted-foreground">
                点击「开始分析」，基于当前图表的<br />结构、支撑/阻力与回归通道生成解读
              </div>
            ) : null}

            {running && (
              <div className="flex items-center gap-2 py-3 text-[12.5px] text-muted-foreground">
                <Loader2 size={14} className="animate-spin text-sky-400" />
                正在读取图表上下文并请求模型…
              </div>
            )}

            {result && (
              <div className="space-y-3">
                <Section title="结构解读" body={result.structure} />
                {(result.support?.length || result.resistance?.length) ? (
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">关键价位</div>
                    <div className="flex flex-wrap gap-1.5">
                      {result.resistance?.map((v, i) => (
                        <span key={"r" + i} className="rounded-md bg-rose-500/12 px-2 py-1 font-mono text-[11.5px] text-rose-300">阻力 {v}</span>
                      ))}
                      {result.support?.map((v, i) => (
                        <span key={"s" + i} className="rounded-md bg-emerald-500/12 px-2 py-1 font-mono text-[11.5px] text-emerald-300">支撑 {v}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className={"rounded px-1.5 py-0.5 font-medium " +
                      (result.bias === "看多" ? "bg-rose-500/15 text-rose-300" : result.bias === "看空" ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300")}>
                      {result.bias || "—"}
                    </span>
                    {result.entry != null && <span className="font-mono text-[11.5px] text-muted-foreground">入场 {result.entry}</span>}
                    {result.stop != null && <span className="font-mono text-[11.5px] text-muted-foreground">止损 {result.stop}</span>}
                    {result.targets?.length ? <span className="font-mono text-[11.5px] text-muted-foreground">目标 {result.targets.join(" / ")}</span> : null}
                  </div>
                </div>
                <Section title="风险提示" body={result.risk} />
                <button onClick={openTracker}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 py-2 text-[12.5px] font-medium text-sky-300 hover:bg-sky-500/20">
                  <Plus size={14} /> 加入追踪（入场 / 止损 / 目标）
                </button>
              </div>
            )}

            {rawText && (
              <div className="desk-scroll max-h-[280px] overflow-auto rounded-lg border border-border bg-background/60 p-3 text-[12.5px] leading-5">
                <Markdown content={rawText} />
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 加入追踪弹窗 */}
      {dlgOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onClick={() => setDlgOpen(false)}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[14px] font-semibold">加入追踪 · {symbol}</div>
            <div className="mt-3 space-y-2.5 text-[12.5px]">
              <div className="flex gap-2">
                {(["long", "short"] as const).map((d) => (
                  <button key={d} onClick={() => setPlan((p) => ({ ...p, direction: d }))}
                    className={"flex-1 rounded-md border py-1.5 font-medium " +
                      (plan.direction === d
                        ? d === "long" ? "border-rose-500/50 bg-rose-500/12 text-rose-300" : "border-emerald-500/50 bg-emerald-500/12 text-emerald-300"
                        : "border-border text-muted-foreground")}>
                    {d === "long" ? "做多" : "做空"}
                  </button>
                ))}
              </div>
              {([["entry", "入场价"], ["stop", "止损价"], ["targets", "目标价（逗号分隔）"]] as const).map(([k, label]) => (
                <label key={k} className="block">
                  <span className="text-muted-foreground">{label}</span>
                  <input value={plan[k]} onChange={(e) => setPlan((p) => ({ ...p, [k]: e.target.value }))}
                    className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus:border-sky-500/60" />
                </label>
              ))}
              <label className="block">
                <span className="text-muted-foreground">备注</span>
                <textarea value={plan.note} onChange={(e) => setPlan((p) => ({ ...p, note: e.target.value }))} rows={2}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-2 text-[12.5px] outline-none focus:border-sky-500/60" />
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setDlgOpen(false)} className="flex-1 rounded-md border border-border py-2 text-[12.5px] text-muted-foreground hover:text-foreground">取消</button>
              <button onClick={saveTracker} className="flex-1 rounded-md bg-sky-500 py-2 text-[12.5px] font-medium text-white hover:bg-sky-400">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 浮动智能助手（右下角小窗） */}
      {chatOpen && <AssistantWidget onClose={() => setChatOpen(false)} chartContext={chartContext} />}
    </div>
  );
}

function Section({ title, body }: { title: string; body?: string }) {
  if (!body) return null;
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-muted-foreground">{title}</div>
      <p className="rounded-lg border border-border bg-background/60 p-3 text-[12.5px] leading-5">{body}</p>
    </div>
  );
}
