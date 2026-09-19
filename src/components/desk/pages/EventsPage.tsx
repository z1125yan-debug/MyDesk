"use client";
// 全球事件雷达页（P2 建页 → P3 增量口径 → P4 历史复盘）
// 「今天」走 GET/POST /api/events（P2/P3 已验收口径不变）；「历史」走 GET /api/events/history?date=…，
// 读的是 global_event 里 asOf 等于该日的真实行：产业链映射与资金验证都是入库当时算好的值，本页面不重算、不改写。
import { useCallback, useEffect, useState } from "react";
import { Globe2, Loader2, RefreshCw } from "lucide-react";
import { SourceBadge, PctText } from "../SourceBadge";
import { AutoTaskLine } from "../AutoTaskLine";
import { HistoryBar } from "../HistoryBar";
import {
  fetchEvents, scanEvents, scanResultNote, fetchEventsHistory,
  type EventHistoryItemClient, type EventItemClient, type HistoryRespClient,
} from "@/lib/desk/quant-api";

const LEVEL_TONE: Record<string, string> = {
  全球级事件: "border-violet-500/40 text-violet-300",
  重大产业事件: "border-orange-500/40 text-orange-300",
  重要行业事件: "border-sky-500/40 text-sky-300",
  行业新闻: "border-border text-muted-foreground",
  普通新闻: "border-border text-muted-foreground",
};

const bjTime = (iso: string | null | undefined): string => {
  if (!iso) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
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
  // P4 历史视图
  const [view, setView] = useState<"today" | "history">("today");
  const [hist, setHist] = useState<HistoryRespClient<EventHistoryItemClient> | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [metaTick, setMetaTick] = useState(0); // 扫描后自增 → 重读「库里有哪几天可查」，不碰用户所选日期

  const load = useCallback(async () => {
    setError("");
    try {
      const j = await fetchEvents();
      setItems(j.items); setAsOf(j.as_of); setOrigin("db");
      setMissing([]); setUnmatched(null);
    } catch (e) { setError(String((e as Error).message || e)); }
  }, []);

  const openHistory = useCallback(async (date?: string) => {
    setHistLoading(true); setError("");
    try {
      const j = await fetchEventsHistory(date ? { date } : {});
      setHist(j); setView("history");
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setHistLoading(false); }
  }, []);

  // 只取「库里有哪几天可查」这份元信息（服务端 groupBy 聚合），不切视图：
  // 否则今天视图里的日期入口拿不到归档清单，会把「其实有数据」显示成「库内暂无归档」。
  const loadHistoryMeta = useCallback(async () => {
    try { setHist(await fetchEventsHistory()); } catch { /* 元信息读不到不影响今日视图，入口自己会显示「正在读取」 */ }
  }, []);

  const scan = async () => {
    setBusy(true); setError(""); setScanNote("");
    try {
      const j = await scanEvents();
      setItems(j.items); setAsOf(j.trade_date); setMissing(j.missing ?? []); setUnmatched(j.unmatched ?? null);
      setScanNote(scanResultNote("events", j.mode, j.delta));
      setOrigin("scan");
      setView("today"); // 扫描写的是今天：不把今天的结果摆成历史某天的归档
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); setTaskTick((t) => t + 1); setMetaTick((t) => t + 1); }
  };

  useEffect(() => { void load(); void loadHistoryMeta(); }, [load, loadHistoryMeta, metaTick]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Globe2 size={18} className="text-sky-400" /> 全球事件雷达</div>
          <div className="text-[11px] text-muted-foreground">快讯关键词映射 → 板块资金验证 · 未命中映射的新闻不入库 · 交易日收盘后由服务进程内的调度器自动扫描一次，也可点「扫描今日」· 历史按 asOf 只读回看</div>
        </div>
        <div className="flex items-center gap-2">
          {view === "today" && asOf && (
            <SourceBadge
              status="HISTORICAL"
              source={origin === "scan" ? "本次扫描写入 global_event 后回读" : "global_event 当日库行"}
              time={asOf.slice(0, 10)}
            />
          )}
          <button onClick={scan} disabled={busy || view === "history"}
            title={view === "history" ? "当前在历史归档视图：扫描只会写今天，请先切回「今天」" : "按全量口径重刷今天的事件"}
            className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 扫描今日
          </button>
        </div>
      </div>
      <HistoryBar
        kind="events" view={view} resp={hist} busy={busy || histLoading} loading={histLoading}
        onToday={() => { setView("today"); void load(); }}
        onDate={(d) => void openHistory(d)}
      />
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {view === "today" && <AutoTaskLine kind="events" refreshKey={taskTick} />}
      {view === "today" && scanNote && (
        <div className="text-[10.5px] text-muted-foreground">
          {scanNote}；手动「扫描今日」按全量重刷当日事件；收盘后的自动扫描在当日已有成功游标时按增量写入——窗口内没有新快讯就不写库、也不再请求板块榜，已入库事件的资金验证保持首次扫描时的数值。
        </div>
      )}
      {view === "today" && unmatched !== null && <div className="text-[11px] text-muted-foreground">未映射快讯 {unmatched} 条（已忽略，未编造产业链）</div>}
      {view === "today" && !items.length && !busy && <div className="text-xs text-muted-foreground">尚无入库事件：等待收盘后自动任务，或点击「扫描今日」。</div>}

      {view === "today" && (
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
      )}

      {/* 历史复盘列表：事件类型 / 来源 / 产业链映射 / asOf 逐条来自库行；库里没有的就写「未记录」 */}
      {view === "history" && (
        <div className="space-y-2">
          {!hist && <div className="text-xs text-muted-foreground">选择日期后读取该日的归档事件（只读，不会触发扫描）。</div>}
          {hist && !hist.items.length && <div className="text-xs text-muted-foreground">该日没有归档事件（缺失说明见上方「缺失口径」）。</div>}
          {hist?.items.map((ev) => (
            <div key={ev.id} className={`rounded-xl border bg-card px-4 py-3 ${LEVEL_TONE[ev.level] ?? "border-border"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium">{ev.title}</div>
                <div className="shrink-0 text-[10.5px]">{ev.time || "时间未记录"} · {ev.level || "级别未记录"}</div>
              </div>
              <div className="mt-1 text-[10.5px] text-muted-foreground">
                事件类型 {ev.category || "未记录"} · asOf {ev.as_of} · 来源 {ev.source || "未记录（库内该行 source 列为空）"}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                产业链映射：{ev.mapped_sectors.length ? ev.mapped_sectors.join("、") : "未命中映射表（入库时即为空，未编造板块）"}
                {ev.related_stocks.length > 0 && <> · 关联标的 {ev.related_stocks.join("、")}</>}
              </div>
              <div className="mt-1 text-[11px]">
                资金验证阶段 <b>{ev.stage || ev.fund_check?.stage || "未记录"}</b> · {String(ev.fund_check?.note ?? "该行未存资金验证说明")}
              </div>
              {!!(ev.fund_check?.boards as { name: string; changePct: number; mainYi: number; rank: number }[] | undefined)?.length && (
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {(ev.fund_check.boards as { name: string; changePct: number; mainYi: number; rank: number }[]).map((b) => (
                    <span key={b.name} className="rounded border border-border px-2 py-0.5">
                      {b.name} <PctText value={b.changePct} /> · {b.mainYi >= 0 ? "+" : ""}{b.mainYi.toFixed(1)}亿 · 第{b.rank}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-[10px] text-muted-foreground/80">
                首次入库 {bjTime(ev.created_at)}（北京）
                {!!ev.broken_columns.length && <span className="ml-1 text-amber-300">字段无法解析：{ev.broken_columns.join("、")}（按缺失处理，未当作空值）</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {view === "today" && !!missing.length && <div className="text-[10.5px] text-muted-foreground/80">{missing.join("；")}</div>}
    </div>
  );
}
