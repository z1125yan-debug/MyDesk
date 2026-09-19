"use client";
import { useCallback, useEffect, useState } from "react";
import { Radar, Loader2, RefreshCw } from "lucide-react";
import { SourceBadge } from "../SourceBadge";
import { AutoTaskLine } from "../AutoTaskLine";
import { fetchRadar, scanRadar, scanResultNote, type RadarItemClient } from "@/lib/desk/quant-api";
import { useDesk } from "@/lib/desk/store";

const KIND_GO: Record<string, "risk" | "themes" | "events" | "market"> = {
  risk: "risk", anomaly: "risk", theme: "themes", fund: "themes", news: "events",
};

export default function RadarPage() {
  const go = useDesk((s) => s.go);
  const [items, setItems] = useState<RadarItemClient[]>([]);
  const [asOf, setAsOf] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taskTick, setTaskTick] = useState(0); // 手动扫描后自增 → 让任务状态条重读 task_run
  const [scanNote, setScanNote] = useState(""); // 本次手动扫描的口径与写库明细（服务端返回，不在前端算）
  const [superseded, setSuperseded] = useState(0); // 今日曾成立、最近一次扫描未再算出的条数（增量口径只标记消失，不删除）

  const load = useCallback(async () => {
    try {
      const j = await fetchRadar();
      setItems(j.items); setAsOf(j.as_of); setSuperseded(j.superseded_today ?? 0);
      if (!j.scanned) { /* 空库不自动扫描，避免打开页面就打满数据源 */ }
    } catch (e) { setError(String((e as Error).message || e)); }
  }, []);

  const scan = async () => {
    setBusy(true); setError(""); setScanNote("");
    try {
      const j = await scanRadar();
      setItems(j.items); setAsOf(j.trade_date || j.as_of); setMissing(j.missing ?? []);
      setSuperseded(j.superseded_today ?? 0);
      setScanNote(scanResultNote("radar", j.mode, j.delta));
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); setTaskTick((t) => t + 1); }
  };

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Radar size={18} className="text-sky-400" /> AI 主动发现</div>
          <div className="text-[11px] text-muted-foreground">规则扫描市场状态 / 主线 / 资金 / 映射事件 · 服务进程内的调度器在交易日收盘后自动扫描，也可点「立即扫描」手动执行一次</div>
        </div>
        <div className="flex items-center gap-2">
          {asOf && <SourceBadge status="HISTORICAL" source="radar_finding 当日库行（自动/手动来源见下方任务状态）" time={asOf.slice(0, 16)} />}
          <button onClick={scan} className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs text-white hover:bg-sky-400">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 立即扫描
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <AutoTaskLine kind="radar" refreshKey={taskTick} />
      {scanNote && <div className="text-[10.5px] text-muted-foreground">{scanNote}；手动「立即扫描」按全量重刷当日结果，收盘后的自动扫描在当日已有成功游标时按增量写入。</div>}
      {!items.length && <div className="text-xs text-muted-foreground">今日尚未扫描。交易日收盘后调度器会自动执行一次；也可点击「立即扫描」马上生成（需真实行情源）。</div>}
      {superseded > 0 && (
        <div className="text-[10.5px] text-muted-foreground/80">
          另有 {superseded} 条今日曾成立、最近一次扫描未再算出的信号：已标记为消失、不再列示，但仍在 radar_finding 里保留（供后续复盘）。
        </div>
      )}
      <div className="space-y-2">
        {items.map((it) => (
          <button key={it.id ?? it.title} onClick={() => go(KIND_GO[it.kind] ?? "market")}
            className="block w-full rounded-xl border border-border bg-card px-4 py-3 text-left hover:border-sky-500/40">
            <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{it.kind}</div>
            <div className="text-sm font-medium">{it.title}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{it.detail}</div>
          </button>
        ))}
      </div>
      {!!missing.length && <div className="text-[10.5px] text-muted-foreground/80">口径：{missing.join("；")}</div>}
    </div>
  );
}
