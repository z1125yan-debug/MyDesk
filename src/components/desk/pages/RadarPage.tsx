"use client";
// AI 主动发现页（P2 建页 → P3 增量口径 → P4 历史复盘）
// 两套视图严格分开，且都必须能被库里的真实行追溯到：
// - 「今天」：GET/POST /api/radar（当日 state=live 行，会被扫描重写）——P2/P3 已验收的口径原样保留；
// - 「历史」：GET /api/radar/history?date=…（按 asOf 只读归档行，含 superseded，不重算、不改写）。
import { useCallback, useEffect, useState } from "react";
import { Radar, Loader2, RefreshCw } from "lucide-react";
import { SourceBadge } from "../SourceBadge";
import MarketScopeBadge from "../MarketScopeBadge";
import { AutoTaskLine } from "../AutoTaskLine";
import { HistoryBar } from "../HistoryBar";
import {
  fetchRadar, scanRadar, scanResultNote, fetchRadarHistory,
  type RadarHistoryItemClient, type RadarItemClient, type HistoryRespClient,
} from "@/lib/desk/quant-api";
import { useDesk } from "@/lib/desk/store";
// P15-R15：kind 与来源推导里的引擎函数名（computeSentiment/discoverThemes）是工程记号，
// 库行与纯核原文不动（p4 钉在 radarSourceOf 上），页面上只换读法。
import { plainify } from "@/lib/desk/plain-core";

const KIND_ZH: Record<string, string> = {
  risk: "风险", anomaly: "异动", theme: "主线", fund: "资金", news: "消息",
};

const KIND_GO: Record<string, "risk" | "themes" | "events" | "market"> = {
  risk: "risk", anomaly: "risk", theme: "themes", fund: "themes", news: "events",
};

type HistState = "all" | "live" | "superseded";

/** 库里的 createdAt 是 UTC 时刻，页面上换算成北京时间显示（与任务状态条同一套换算，不写成"裸 ISO 串"让人误读成本地时间） */
const bjTime = (iso: string | null | undefined): string => {
  if (!iso) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
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
  // P4 历史视图：日期与筛选都交给服务端判定，前端只记「用户点了哪天、要哪种状态」
  const [view, setView] = useState<"today" | "history">("today");
  const [hist, setHist] = useState<HistoryRespClient<RadarHistoryItemClient> | null>(null);
  const [histState, setHistState] = useState<HistState>("all");
  const [histLoading, setHistLoading] = useState(false);
  const [metaTick, setMetaTick] = useState(0); // 扫描后自增 → 重读「库里有哪几天可查」，不碰用户所选日期

  const load = useCallback(async () => {
    try {
      const j = await fetchRadar();
      setItems(j.items); setAsOf(j.as_of); setSuperseded(j.superseded_today ?? 0);
      if (!j.scanned) { /* 空库不自动扫描，避免打开页面就打满数据源 */ }
    } catch (e) { setError(String((e as Error).message || e)); }
  }, []);

  const openHistory = useCallback(async (date: string | undefined, state: HistState) => {
    setHistLoading(true); setError("");
    try {
      setHist(await fetchRadarHistory({ ...(date ? { date } : {}), state }));
      setView("history");
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setHistLoading(false); }
  }, []);

  // 只取「库里有哪几天可查」这份元信息（服务端 groupBy 聚合，与筛选无关），不切视图：
  // 否则今天视图里的日期入口拿不到归档清单，会把"其实有数据"显示成"库内暂无归档"。
  // 只在挂载与扫描后刷新（扫描会改变当日行数）；用户在历史视图里换日期/筛选走 openHistory，不会被这里覆盖。
  const loadHistoryMeta = useCallback(async () => {
    try { setHist(await fetchRadarHistory({ state: "all" })); } catch { /* 元信息读不到不影响今日视图，日期入口自己会显示"未知" */ }
  }, []);

  const scan = async () => {
    setBusy(true); setError(""); setScanNote("");
    try {
      const j = await scanRadar();
      setItems(j.items); setAsOf(j.trade_date || j.as_of); setMissing(j.missing ?? []);
      setSuperseded(j.superseded_today ?? 0);
      setScanNote(scanResultNote("radar", j.mode, j.delta));
      setView("today"); // 扫描写的是今天：结果只允许覆盖今天视图，不拿去冒充历史某天
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); setTaskTick((t) => t + 1); setMetaTick((t) => t + 1); }
  };

  useEffect(() => { void load(); void loadHistoryMeta(); }, [load, loadHistoryMeta, metaTick]);

  const histDate = hist?.date ?? "";

  return (
    <div className="w-full space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Radar size={18} className="text-sky-400" /> AI 主动发现</div>
          <div className="text-[12px] text-muted-foreground">自动扫描市场，发现资金、主线和异动信号。</div>
          <div className="mt-2"><MarketScopeBadge note="本页雷达仅扫描 A 股；港股/美股事件在「事件雷达」页的港股/美股分支看" /></div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={scan} disabled={busy || view === "history"}
            title={view === "history" ? "当前在历史归档视图：扫描只会写今天，请先切回「今天」" : "按全量口径重刷今天的雷达信号"}
            className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 立即扫描
          </button>
        </div>
      </div>
      <HistoryBar
        kind="radar" view={view} resp={hist} busy={busy || histLoading} loading={histLoading}
        onToday={() => { setView("today"); void load(); }}
        onDate={(d) => void openHistory(d, histState)}
        onState={(s) => { setHistState(s); void openHistory(histDate || undefined, s); }}
      />
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {view === "today" && <AutoTaskLine kind="radar" refreshKey={taskTick} />}
      {view === "today" && !items.length && (
        <div className="text-xs text-muted-foreground">今天还没有扫描。收盘后会自动跑一次，也可以点右上角「立即扫描」。</div>
      )}
      {view === "today" && superseded > 0 && (
        <div className="text-[11.5px] text-muted-foreground/80">
另有 {superseded} 条信号在最近一次扫描中已消失，不再显示。
        </div>
      )}

      {view === "today" && (
        <div className="space-y-2">
          {items.map((it) => (
            <button key={it.id ?? it.title} onClick={() => go(KIND_GO[it.kind] ?? "market")}
              className="block w-full rounded-xl border border-border bg-card px-4 py-3 text-left hover:border-sky-500/40">
              <div className="text-[11.5px] uppercase tracking-wide text-muted-foreground">{KIND_ZH[it.kind] ?? it.kind}</div>
              <div className="text-sm font-medium">{it.title}</div>
              <div className="mt-1 text-[12px] text-muted-foreground">{it.detail}</div>
            </button>
          ))}
        </div>
      )}

      {/* 历史复盘列表：每条都带 asOf、状态、来源推导，消失行不隐藏、只是标出来 */}
      {view === "history" && (
        <div className="space-y-2">
          {!hist && <div className="text-xs text-muted-foreground">选择日期后读取该日的归档行（只读，不会触发扫描）。</div>}
          {hist && !hist.items.length && <div className="text-xs text-muted-foreground">该日没有符合当前筛选的归档信号（缺失说明见上方「缺失口径」）。</div>}
          {hist?.items.map((it) => (
            <div key={it.id} className={`rounded-xl border px-4 py-3 ${it.superseded ? "border-dashed border-border bg-card/40" : "border-border bg-card"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="text-[11.5px] uppercase tracking-wide text-muted-foreground">
                  类型 {KIND_ZH[it.kind] ?? it.kind} · 留档日 {it.as_of}
                </div>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${it.superseded ? "border-amber-500/40 text-amber-300" : "border-emerald-500/40 text-emerald-300"}`}>
                  {it.state_label}
                </span>
              </div>
              <div className={`text-sm font-medium ${it.superseded ? "text-muted-foreground line-through decoration-amber-500/40" : ""}`}>{it.title}</div>
              <div className="mt-1 text-[12px] text-muted-foreground">{it.detail || "（这条没有存正文）"}</div>
              <div className="mt-1.5 text-[11px] text-muted-foreground/80" title={plainify(it.source_basis)}>
                来源：{plainify(it.source)} · 首次入库 {bjTime(it.created_at)}（北京）
                {it.evidence_broken && <span className="ml-1 text-amber-300">证据字段无法解析（库内原文损坏，未当作空值）</span>}
              </div>
              {!it.superseded && (
                <button onClick={() => go(KIND_GO[it.kind] ?? "market")} className="mt-1 text-[11.5px] text-sky-400 hover:text-sky-300">
                  跳转到对应板块（按当前实时口径，非该日口径）
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
