"use client";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
import { SnapshotBar } from "../SnapshotBar";
import { fetchRisk, type RiskClient } from "@/lib/desk/quant-api";
import { useDesk } from "@/lib/desk/store";

function levelClass(level: string): string {
  if (level === "事件风险") return "text-violet-300 border-violet-500/40 bg-violet-500/10";
  if (level === "高风险") return "text-red-500 border-red-500/40 bg-red-500/10";
  if (level === "偏高") return "text-orange-400 border-orange-500/40 bg-orange-500/10";
  if (level === "注意") return "text-amber-400 border-amber-500/40 bg-amber-500/10";
  return "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";
}

export default function RiskPage() {
  const go = useDesk((s) => s.go);
  const [data, setData] = useState<RiskClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await fetchRisk()); }
    catch (e) { setError(String((e as Error).message || e)); setData(null); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><ShieldAlert size={18} className="text-sky-400" /> 风险监控</div>
          <div className="text-[11px] text-muted-foreground">真实情绪指标 + 上证相似环境统计 · 不编造缺失项 · 不构成投资建议</div>
        </div>
        <div className="flex items-center gap-2">
          {data && <SourceBadge status={data.live ? "LIVE" : "HISTORICAL"} source={data.source.provider.split("（")[0]} time={data.as_of.slice(11, 19)} />}
          <button onClick={load} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <SnapshotBar kind="risk" label="风险监控"
        sideEffect="留档这一下会在服务端真的重算一次（全A快照 + 指数行情 + 相似历史日统计），不是读本页缓存、也不是把上面的数字上传存起来。" />
      {data && (
        <>
          <div className={`rounded-xl border px-5 py-4 ${levelClass(data.risk.level)}`}>
            <div className="text-[11px] opacity-80">市场风险等级</div>
            <div className="text-2xl font-bold">{data.risk.level}</div>
            <div className="mt-1 text-xs opacity-90">炸板率 {data.break_rate === null ? "—" : `${data.break_rate.toFixed(0)}%`} · 涨跌比 {(data.decliners > 0 ? data.advancers / data.decliners : 99).toFixed(2)} · 主力净额 {data.main_net_sum_yi.toFixed(0)} 亿</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-sm font-semibold">触发指标</div>
            <ul className="space-y-1 text-xs">
              {data.risk.triggers.map((t) => <li key={t} className="text-muted-foreground">· {t}</li>)}
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 text-sm font-semibold">建议关注</div>
            <div className="flex flex-wrap gap-2">
              {data.suggestions.map((s) => (
                <span key={s} className="rounded-md border border-border bg-accent/40 px-2 py-1 text-xs">{s}</span>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">历史参考（上证相似涨跌幅环境）</div>
              <button onClick={() => go("problab")} className="text-xs text-sky-400 hover:underline">条件概率页 →</button>
            </div>
            <div className="text-[11px] text-muted-foreground">{data.history_ref_note}</div>
            {data.history_ref && (
              <div className="mt-3 grid grid-cols-3 gap-3">
                {data.history_ref.horizons.map((h) => (
                  <div key={h.h} className="rounded-lg border border-border px-3 py-2 text-xs">
                    <div className="text-muted-foreground">{h.h} 日</div>
                    <div className="text-base font-semibold">{h.win_rate == null ? "—" : `${h.win_rate.toFixed(0)}%`}</div>
                    <div className="text-[10.5px] text-muted-foreground">样本 {h.sample_size} · 均值 {h.avg_return == null ? "—" : `${h.avg_return.toFixed(2)}%`}</div>
                  </div>
                ))}
              </div>
            )}
            {data.history_ref && !data.history_ref.sample_ok && (
              <div className="mt-2 text-[11px] text-amber-400">样本不足，仅供参考</div>
            )}
          </div>
          {!!data.missing.length && (
            <div className="text-[10.5px] leading-4 text-muted-foreground/80">暂缺：{data.missing.join("；")}</div>
          )}
        </>
      )}
    </div>
  );
}
