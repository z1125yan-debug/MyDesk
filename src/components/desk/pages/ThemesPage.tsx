"use client";
import { useCallback, useEffect, useState } from "react";
import { Compass, Loader2, RefreshCw } from "lucide-react";
import { PctText, NumText, SourceBadge } from "../SourceBadge";
import { fetchThemes, type ThemeDiscoveryClient, type ThemeRowClient } from "@/lib/desk/quant-api";
import { useDesk } from "@/lib/desk/store";

function Block({ title, rows, tone }: { title: string; rows: ThemeRowClient[]; tone: string }) {
  const go = useDesk((s) => s.go);
  if (!rows.length) return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className={`text-sm font-semibold ${tone}`}>{title}</div>
      <div className="mt-2 text-xs text-muted-foreground">当日无符合规则的板块（不编造主线）</div>
    </div>
  );
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className={`mb-2 text-sm font-semibold ${tone}`}>{title}</div>
      <div className="space-y-2">
        {rows.map((r) => (
          <button key={r.code} onClick={() => go("sectors")} className="block w-full rounded-lg border border-border/70 px-3 py-2 text-left hover:border-sky-500/40">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{r.name}</span>
              <span className="text-[11px] text-muted-foreground">{r.code}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
              <span>涨幅 <PctText value={r.changePct} /></span>
              <span>主力 <NumText value={r.mainYi} digits={1} suffix=" 亿" /></span>
              <span>扩散 {r.diffusion == null ? "—" : `${(r.diffusion * 100).toFixed(0)}%`}</span>
              <span>连续强势 {r.streakPct ?? "—"} 日</span>
              <span>连续流入 {r.streakInflow ?? "—"} 日</span>
            </div>
            <div className="mt-1 text-[10.5px] text-muted-foreground">{r.reasons.join(" · ")}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ThemesPage() {
  const [data, setData] = useState<ThemeDiscoveryClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    setBusy(true); setError("");
    try { setData(await fetchThemes(force)); }
    catch (e) { setError(String((e as Error).message || e)); setData(null); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(false); }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Compass size={18} className="text-sky-400" /> 主线发现</div>
          <div className="text-[11px] text-muted-foreground">规则版：涨幅/RPS/扩散/资金同步/连续强势 · 不接 LLM</div>
        </div>
        <div className="flex items-center gap-2">
          {data && <SourceBadge status="LIVE" source="东财板块" time={data.as_of.slice(11, 19)} />}
          <button onClick={() => load(true)} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {data && (
        <>
          <Block title="主线" rows={data.main} tone="text-red-400" />
          <Block title="次主线" rows={data.sub} tone="text-sky-300" />
          <Block title="轮动/跟风" rows={data.rotation} tone="text-amber-400" />
          {!!data.missing.length && <div className="text-[10.5px] text-muted-foreground/80">口径：{data.missing.join("；")}</div>}
        </>
      )}
    </div>
  );
}
