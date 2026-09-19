"use client";
import { useCallback, useEffect, useState } from "react";
import { Globe2, Loader2, RefreshCw } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
import { AutoTaskLine } from "../AutoTaskLine";
import { fetchEvents, scanEvents, scanResultNote, type EventItemClient } from "@/lib/desk/quant-api";

const LEVEL_TONE: Record<string, string> = {
  全球级事件: "border-violet-500/40 text-violet-300",
  重大产业事件: "border-orange-500/40 text-orange-300",
  重要行业事件: "border-sky-500/40 text-sky-300",
  行业新闻: "border-border text-muted-foreground",
  普通新闻: "border-border text-muted-foreground",
};

export default function EventsPage() {
  const [items, setItems] = useState<EventItemClient[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState<number | null>(null);
  const [asOf, setAsOf] = useState("");
  // 数据来源标注：页面展示的始终是 global_event 库行（GET 读当日；POST 扫描后回读同一天的库行），
  // 不是实时快讯流，故徽章不得写 LIVE（REAL_DATA_ONLY：徽章口径必须等于真实数据链）。
  const [origin, setOrigin] = useState<"db" | "scan">("db");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taskTick, setTaskTick] = useState(0); // 手动扫描后自增 → 任务状态条重读 task_run
  const [scanNote, setScanNote] = useState(""); // 本次手动扫描的口径与写库明细（服务端返回，不在前端算）

  const load = useCallback(async () => {
    setError("");
    try {
      const j = await fetchEvents();
      setItems(j.items); setAsOf(j.as_of); setOrigin("db");
      setMissing([]); setUnmatched(null);
    } catch (e) { setError(String((e as Error).message || e)); }
  }, []);

  const scan = async () => {
    setBusy(true); setError(""); setScanNote("");
    try {
      const j = await scanEvents();
      setItems(j.items); setAsOf(j.trade_date); setMissing(j.missing ?? []); setUnmatched(j.unmatched ?? null);
      setScanNote(scanResultNote("events", j.mode, j.delta));
      setOrigin("scan");
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); setTaskTick((t) => t + 1); }
  };

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Globe2 size={18} className="text-sky-400" /> 全球事件雷达</div>
          <div className="text-[11px] text-muted-foreground">快讯关键词映射 → 板块资金验证 · 未命中映射的新闻不入库 · 交易日收盘后由服务进程内的调度器自动扫描一次，也可点「扫描今日」</div>
        </div>
        <div className="flex items-center gap-2">
          {asOf && (
            <SourceBadge
              status="HISTORICAL"
              source={origin === "scan" ? "本次扫描写入 global_event 后回读" : "global_event 当日库行"}
              time={asOf.slice(0, 10)}
            />
          )}
          <button onClick={scan} className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs text-white hover:bg-sky-400">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 扫描今日
          </button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <AutoTaskLine kind="events" refreshKey={taskTick} />
      {scanNote && (
        <div className="text-[10.5px] text-muted-foreground">
          {scanNote}；手动「扫描今日」按全量重刷当日事件；收盘后的自动扫描在当日已有成功游标时按增量写入——窗口内没有新快讯就不写库、也不再请求板块榜，已入库事件的资金验证保持首次扫描时的数值。
        </div>
      )}
      {unmatched !== null && <div className="text-[11px] text-muted-foreground">未映射快讯 {unmatched} 条（已忽略，未编造产业链）</div>}
      {!items.length && !busy && <div className="text-xs text-muted-foreground">尚无入库事件：等待收盘后自动任务，或点击「扫描今日」。</div>}
      <div className="space-y-2">
        {items.map((ev) => (
          <div key={ev.id} className={`rounded-xl border bg-card px-4 py-3 ${LEVEL_TONE[ev.level] ?? "border-border"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-medium">{ev.title}</div>
              <div className="shrink-0 text-[10.5px]">{ev.time} · {ev.level}</div>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{ev.category} · 映射 {(ev.mappedSectors ?? []).join("、") || "—"}</div>
            <div className="mt-1 text-[11px]">阶段 <b>{ev.stage || ev.fundCheck?.stage}</b> · {ev.fundCheck?.note}</div>
            {!!ev.fundCheck?.boards?.length && (
              <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                {ev.fundCheck.boards.map((b) => (
                  <span key={b.name} className="rounded border border-border px-2 py-0.5">
                    {b.name} <PctText value={b.changePct} /> · {b.mainYi >= 0 ? "+" : ""}{b.mainYi.toFixed(1)}亿 · 第{b.rank}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {!!missing.length && <div className="text-[10.5px] text-muted-foreground/80">{missing.join("；")}</div>}
    </div>
  );
}
