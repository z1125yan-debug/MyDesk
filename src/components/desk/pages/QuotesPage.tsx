"use client";
// 行情 — 分时与日K技术指标（对齐稳智 /overview）。
// 稳智该页 = 个股行情图页：股票搜索（代码/名称）+ 周期 + 复权 + 分时/日K + 关键数字 + 加自选 + 买卖盘五档。
// 本地数据全走真实源：/api/market/search、/api/market/quote、/api/market/kline（含服务端算的 MACD）、
// /api/market/depth（通达信五档盘口）。取不到就如实说「暂无」，不拿演示数据顶包（全站 REAL_DATA_ONLY）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Loader2, Star, CandlestickChart } from "lucide-react";
import CandleChart from "../CandleChart";
import EChart from "../charts/EChart";
import { LineageCard, LineageSection, StatCard } from "../ui/LineageCard";
import { useDesk } from "@/lib/desk/store";
import { searchSymbols, fetchQuoteCards, fetchCandlesFor, type SuggestItem, type MacdSeries } from "@/lib/desk/market";
import type { Candle, QuoteCard } from "@/lib/desk/types";

// 周期（稳智：分时 + 日K；本地 kline 支持 1分/日/周/月）
const TFS = [
  { k: "分时", tf: "1分" },
  { k: "日线", tf: "日线" },
  { k: "周线", tf: "周线" },
  { k: "月线", tf: "月线" },
] as const;

const AUTYPES = [
  { k: "qfq", label: "前复权(qfq)" },
  { k: "hfq", label: "后复权(hfq)" },
  { k: "none", label: "不复权(none)" },
] as const;

// 日期区间（以最后一根K线为锚往前推；稳智是服务端区间，本地 kline 无区间参数，故在前端截窗）
const SPANS = [
  { k: "全部", days: 0 },
  { k: "近1月", days: 30 },
  { k: "近3月", days: 90 },
  { k: "近半年", days: 180 },
] as const;

type Level = { price: number; volume: number };
type Depth = {
  symbol: string; lastPrice: number;
  bids: Level[]; asks: Level[];
  insideHand: number; outerHand: number; activeHand: number;
};

export default function QuotesPage() {
  const addWatch = useDesk((s) => s.addWatch);

  const [kw, setKw] = useState("000001");
  const [sug, setSug] = useState<SuggestItem[]>([]);
  // 默认给一只（打开即有图，不用先输）；换成你自选里的第一只更贴心，但 SSR/持久化时序下会闪，先用稳定默认
  const [symbol, setSymbol] = useState("000001.SZ");
  const [name, setName] = useState("平安银行");
  const [tfIdx, setTfIdx] = useState(1); // 默认日线
  const [autype, setAutype] = useState<"qfq" | "hfq" | "none">("qfq");
  const [spanIdx, setSpanIdx] = useState(0); // 默认全部
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [macd, setMacd] = useState<MacdSeries | null>(null);
  const [quote, setQuote] = useState<QuoteCard | null>(null);
  const [depth, setDepth] = useState<Depth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const sugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tf = TFS[tfIdx].tf;

  // 搜索建议（防抖 220ms）
  useEffect(() => {
    const k = kw.trim();
    if (sugTimer.current) clearTimeout(sugTimer.current);
    if (!k) { setSug([]); return; }
    sugTimer.current = setTimeout(() => {
      void searchSymbols(k).then(setSug).catch(() => setSug([]));
    }, 220);
    return () => { if (sugTimer.current) clearTimeout(sugTimer.current); };
  }, [kw]);

  const pick = (it: SuggestItem) => {
    setSymbol(it.symbol); setName(it.name); setSug([]); setKw(it.symbol); setAdded(false);
  };

  // 取数：报价 + K线(含MACD) + 五档盘口（symbol / 周期 / 复权 变化都重取）
  const load = useCallback(async () => {
    if (!symbol) return;
    setBusy(true); setError("");
    try {
      const [qc, cc, dr] = await Promise.all([
        fetchQuoteCards([symbol]),
        fetchCandlesFor(symbol, tf, autype),
        fetch(`/api/market/depth?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json()).catch(() => ({ depth: null })),
      ]);
      setQuote(qc.cards[0] ?? null);
      setCandles(cc.candles);
      setMacd(cc.macd ?? null);
      setDepth((dr?.depth as Depth | null) ?? null);
      if (!cc.candles?.length) setError("该周期未取到K线数据（数据源无返回）");
    } catch (e) {
      setError(String((e as Error).message || e));
      setCandles(null);
    } finally { setBusy(false); }
  }, [symbol, tf, autype]);

  useEffect(() => { void load(); }, [load]);

  const onAdd = () => {
    if (!symbol) return;
    addWatch({ symbol, name: name || symbol, kind: "watch" });
    setAdded(true);
  };

  // 日期区间：以最后一根为锚往前推 N 天（K线与MACD同段切片，避免错位）
  const vis = useMemo(() => {
    const all = candles ?? [];
    const days = SPANS[spanIdx].days;
    if (!days || !all.length) return { candles: all, macd };
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(all[all.length - 1].date ?? "");
    if (!m) return { candles: all, macd };
    const cut = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - days * 864e5).toISOString().slice(0, 10);
    const startIdx = all.findIndex((c) => (c.date ?? "") >= cut);
    if (startIdx <= 0) return { candles: all, macd };
    return {
      candles: all.slice(startIdx),
      macd: macd ? { dif: macd.dif.slice(startIdx), dea: macd.dea.slice(startIdx), bar: macd.bar.slice(startIdx) } : null,
    };
  }, [candles, macd, spanIdx]);

  // MACD 副图（EChart：DIF/DEA 双线 + 柱）
  const macdOption = useMemo(() => {
    const m = vis.macd;
    if (!m) return {};
    return {
      grid: { left: 8, right: 56, top: 16, bottom: 18 },
      tooltip: { trigger: "axis" },
      legend: { data: ["DIF", "DEA", "MACD"], right: 0, top: 0, textStyle: { color: "#8b949e", fontSize: 9 } },
      xAxis: {
        type: "category", data: vis.candles.map((c) => c.date ?? ""),
        axisLabel: { color: "#8b949e", fontSize: 9, hideOverlap: true },
        axisLine: { lineStyle: { color: "#30363d" } },
      },
      yAxis: { type: "value", axisLabel: { color: "#8b949e", fontSize: 9 }, splitLine: { lineStyle: { type: "dashed", color: "#30363d" } } },
      series: [
        { name: "DIF", type: "line", data: m.dif, showSymbol: false, lineStyle: { width: 1, color: "#f0b90b" } },
        { name: "DEA", type: "line", data: m.dea, showSymbol: false, lineStyle: { width: 1, color: "#38bdf8" } },
        { name: "MACD", type: "bar", barMaxWidth: 4, data: m.bar.map((v) => ({ value: v, itemStyle: { color: (v ?? 0) >= 0 ? "#fb7185" : "#34d399" } })) },
      ],
    };
  }, [vis]);

  const last = vis.candles.length ? vis.candles[vis.candles.length - 1] : null;
  const quoteMissing = !quote || quote.missing;
  const up = (quote?.changePct ?? 0) >= 0;

  return (
    <div className="w-full space-y-4 px-6 py-4">
      <LineageCard
        title={<span className="flex items-center gap-2"><CandlestickChart size={17} className="text-sky-400" />行情</span>}
        note="分时与日K技术指标"
      >
        <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
          输入股票代码或名称查行情；数据来自本地真实源（通达信优先、腾讯兜底；五档盘口来自本机通达信网关）。所示内容仅供市场研究与分析，不构成任何投资建议。
        </p>

        {/* 搜索 + 周期 + 复权 + 加自选 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-overlay/40 px-3 py-2 text-[12.5px]">
          <div className="relative">
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5">
              <Search size={13} className="text-muted-foreground" />
              <input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                placeholder="股票代码 / 名称，如 000001 或 平安银行"
                className="w-60 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            {sug.length > 0 && (
              <div className="absolute z-20 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
                {sug.slice(0, 8).map((it) => (
                  <button key={it.symbol} onClick={() => pick(it)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-overlay">
                    <span className="font-mono text-[12.5px] text-muted-foreground">{it.symbol}</span>
                    <span className="text-[13px]">{it.name}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{it.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 周期 */}
          <div className="flex rounded-lg border border-border p-0.5 text-xs">
            {TFS.map((t, i) => (
              <button key={t.k} onClick={() => setTfIdx(i)}
                className={"rounded-md px-2.5 py-1.5 transition-all duration-200 " + (tfIdx === i ? "bg-sky-500/20 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")}>
                {t.k}
              </button>
            ))}
          </div>

          {/* 复权 */}
          <span className="text-muted-foreground">复权</span>
          <select value={autype} onChange={(e) => setAutype(e.target.value as "qfq" | "hfq" | "none")}
            className="rounded-md border border-border bg-card px-2 py-1 text-[12.5px] outline-none hover:border-sky-400/40">
            {AUTYPES.map((a) => <option key={a.k} value={a.k}>{a.label}</option>)}
          </select>

          {/* 日期区间 */}
          <span className="text-muted-foreground">区间</span>
          <div className="flex rounded-lg border border-border p-0.5 text-xs">
            {SPANS.map((s, i) => (
              <button key={s.k} onClick={() => setSpanIdx(i)}
                className={"rounded-md px-2 py-1 transition-all duration-200 " + (spanIdx === i ? "bg-sky-500/20 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")}>
                {s.k}
              </button>
            ))}
          </div>

          <button onClick={onAdd} disabled={!symbol}
            className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 px-3 py-1.5 text-xs text-sky-300 transition-all active:scale-95 hover:bg-sky-500/10 disabled:opacity-40">
            <Star size={12} /> {added ? "已加自选" : "加自选"}
          </button>
        </div>

        {/* 关键数字 */}
        {!quoteMissing && quote && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="现价" value={quote.price != null ? quote.price.toFixed(2) : "—"}
              toneClass={up ? "text-red-400" : "text-emerald-400"} title={`${quote.name} ${quote.symbol}`} />
            <StatCard label="涨跌幅" value={quote.changePct == null ? "—" : `${quote.changePct > 0 ? "+" : ""}${quote.changePct.toFixed(2)}%`}
              toneClass={up ? "text-red-400" : "text-emerald-400"} />
            <StatCard label="昨收" value={quote.prevClose != null ? quote.prevClose.toFixed(2) : "—"} />
            <StatCard label="最高 / 最低" value={last ? `${last.h.toFixed(2)} / ${last.l.toFixed(2)}` : "—"}
              title="最近一根K线的最高 / 最低价" />
          </div>
        )}

        {/* 图 + 买卖盘五档 */}
        <LineageSection
          title={symbol ? `${name || symbol} · ${TFS[tfIdx].k}` : "个股行情图"}
          hint={symbol ? "Ctrl+滚轮缩放 · 拖动平移 · 双击复位" : undefined}
          divided={false}
          actions={busy ? <Loader2 size={13} className="animate-spin text-sky-400" /> : undefined}
        >
          {error && (
            <div className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/90">{error}</div>
          )}
          {!symbol ? (
            <div className="py-16 text-center text-sm text-muted-foreground">输入股票代码或名称，开始查行情</div>
          ) : (
            <div className="flex flex-col gap-3 lg:flex-row">
              <div className="min-w-0 flex-1">
                {vis.candles.length ? (
                  <CandleChart candles={vis.candles} prevClose={quote?.prevClose} symbol={symbol} showChannel enableDrawing />
                ) : (
                  <div className="py-16 text-center text-sm text-muted-foreground">{busy ? "加载中…" : "暂无K线数据"}</div>
                )}
              </div>
              {/* 买卖盘五档（通达信网关） */}
              <div className="w-full shrink-0 rounded-xl border border-border bg-card p-2.5 lg:w-52">
                <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">五档盘口</div>
                {depth ? (
                  <div className="space-y-0.5 font-mono text-[12px]">
                    {[...depth.asks].slice(0, 5).reverse().map((l, i) => (
                      <div key={`a${i}`} className="flex items-center justify-between px-1">
                        <span className="text-muted-foreground">卖{5 - i}</span>
                        <span className="text-emerald-400">{l.price?.toFixed(2)}</span>
                        <span className="text-muted-foreground">{l.volume}</span>
                      </div>
                    ))}
                    <div className="my-1 flex items-center justify-between border-y border-border/60 px-1 py-1">
                      <span className="text-muted-foreground">现价</span>
                      <span className={up ? "text-red-400" : "text-emerald-400"}>{depth.lastPrice?.toFixed(2)}</span>
                      <span />
                    </div>
                    {depth.bids.slice(0, 5).map((l, i) => (
                      <div key={`b${i}`} className="flex items-center justify-between px-1">
                        <span className="text-muted-foreground">买{i + 1}</span>
                        <span className="text-red-400">{l.price?.toFixed(2)}</span>
                        <span className="text-muted-foreground">{l.volume}</span>
                      </div>
                    ))}
                    <div className="mt-1.5 flex justify-between border-t border-border/60 px-1 pt-1 text-[11px] text-muted-foreground">
                      <span>内盘 {depth.insideHand}</span>
                      <span>外盘 {depth.outerHand}</span>
                    </div>
                  </div>
                ) : (
                  <div className="py-6 text-center text-[12px] text-muted-foreground">五档盘口暂不可用（本机通达信行情网关未开启）</div>
                )}
              </div>
            </div>
          )}
        </LineageSection>

        {/* MACD 副图 */}
        {symbol && vis.macd && (
          <LineageSection title="MACD" hint="DIF / DEA / 柱（服务端 macdCalc 口径，与选股因子一致）" divided>
            <EChart ariaLabel="MACD 副图" height={150} state="ok" option={macdOption} />
          </LineageSection>
        )}
      </LineageCard>
    </div>
  );
}
