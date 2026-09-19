"use client";
// 自选股增强（P1-3）：自选实时行情列表（真实报价，/api/market/quote 既有封装）
// 交易计划区完整复用旧 TrackerPage（不改动其逻辑），作为本页下半区呈现。
import { useState, useEffect, useCallback } from "react";
import { Target, Loader2, RefreshCw, Trash2, LineChart } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import Sparkline from "../Sparkline";
import TrackerPage from "./TrackerPage";
import { useDesk } from "@/lib/desk/store";

interface QuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  amountYi?: number | null;
  time?: string;
  spark?: number[] | null;
  missing?: boolean;
}

const BATCH = 30; // /api/market/quote 单次上限（既有路由 slice(0,30)）

export default function WatchlistPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const watchlist = useDesk((s) => s.watchlist);
  const removeWatch = useDesk((s) => s.removeWatch);

  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  const load = useCallback(async () => {
    if (!watchlist.length) { setRows([]); return; }
    setBusy(true); setError("");
    try {
      const symbols = watchlist.slice(0, BATCH).map((w) => w.symbol);
      const res = await fetch(`/api/market/quote?symbols=${encodeURIComponent(symbols.join(","))}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "报价获取失败");
      const quotes: (Partial<QuoteRow> | null)[] = j.quotes ?? [];
      const merged: QuoteRow[] = symbols.map((sym, i) => {
        const q = quotes[i];
        const w = watchlist.find((x) => x.symbol === sym);
        if (!q || q.price === undefined || q.price === null) {
          return { symbol: sym, name: w?.name ?? sym, price: null, changePct: null, missing: true };
        }
        return {
          symbol: sym, name: q.name ?? w?.name ?? sym,
          price: q.price, changePct: q.changePct ?? null,
          high: q.high, low: q.low, prevClose: q.prevClose, amountYi: q.amountYi, time: q.time,
          spark: q.spark && q.spark.length > 1 ? q.spark : null,
        };
      });
      setRows(merged);
      setUpdatedAt(new Date().toTimeString().slice(0, 8));
    } catch (e) {
      setError(String((e as Error).message || e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [watchlist]);

  useEffect(() => { load(); }, [load]);

  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  const openAnalysis = (symbol: string) => { setFocusSymbol(symbol); go("analysis"); };

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Target size={18} className="text-sky-400" /> 自选股行情</div>
          <div className="text-[11px] text-muted-foreground">
            真实报价（eltdx/腾讯优先）· 取不到显示暂无数据 · {updatedAt ? `更新 ${updatedAt}` : ""}
            {watchlist.length > BATCH ? ` · 仅显示前 ${BATCH} 只（接口单次上限）` : ""}
          </div>
        </div>
        <button onClick={load} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {!watchlist.length && (
        <div className="rounded-xl border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
          还没有自选股 · 在「全A列表」或「个股画像」页点「+自选」添加
        </div>
      )}

      {watchlist.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                {["代码", "名称", "现价", "涨跌幅", "昨收", "今高", "今低", "成交额(亿)", "分时", "操作"].map((h) => (
                  <th key={h} className="px-3 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-b border-border/40 hover:bg-sky-500/5">
                  <td className="px-3 py-1.5 font-mono cursor-pointer" onClick={() => openProfile(r.symbol)}>{r.symbol}</td>
                  <td className="px-3 py-1.5 cursor-pointer" onClick={() => openProfile(r.symbol)}>{r.name}</td>
                  <td className="px-3 py-1.5 text-right">{r.missing ? <span className="text-muted-foreground">暂无数据</span> : <NumText value={r.price} />}</td>
                  <td className="px-3 py-1.5 text-right">{r.missing ? <span className="text-muted-foreground">—</span> : <PctText value={r.changePct} />}</td>
                  <td className="px-3 py-1.5 text-right"><NumText value={r.prevClose ?? null} /></td>
                  <td className="px-3 py-1.5 text-right"><NumText value={r.high ?? null} /></td>
                  <td className="px-3 py-1.5 text-right"><NumText value={r.low ?? null} /></td>
                  <td className="px-3 py-1.5 text-right"><NumText value={r.amountYi ?? null} digits={1} /></td>
                  <td className="px-3 py-1.5">
                    {r.spark && r.spark.length > 1
                      ? <Sparkline data={r.spark} up={(r.changePct ?? 0) >= 0} width={90} height={22} />
                      : <span className="text-[10px] text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1">
                      <button title="AI 分析" onClick={() => openAnalysis(r.symbol)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-sky-300"><LineChart size={13} /></button>
                      <button title="移出自选" onClick={() => removeWatch(r.symbol)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-rose-400"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!rows.length && !busy && !error && (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">暂无数据（报价源未返回）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 交易计划区：完整复用旧追踪页 */}
      <div className="border-t border-border pt-2">
        <TrackerPage />
      </div>
    </div>
  );
}
