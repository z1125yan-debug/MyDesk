"use client";
// 历史查询条（P4 第四阶段）：Radar / Events 两个页面共用，日期入口 + 查看口径 + 当日扫描运行记录。
//
// 口径纪律（REAL_DATA_ONLY）：
// - 本组件不自己算任何条数、日期、口径：全部字段来自 /api/{radar,events}/history 的真实返回；
// - 「今天」= 当日库行视图（走原有 GET/POST，会被扫描重写；它是「今天的归档行」，不是行情实时推送）；
//   「历史」= 指定 asOf 的归档视图（只读），
//   两者在徽章与文案上必须区分，绝不用 LIVE 一类字样把历史数据说成实时数据，也不把库行说成实时行情。
// - 日期入口只列库里真有的归档日（groupBy 聚合结果），没有数据的日子不会被凭空摆进选择器。
import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { SourceBadge } from "./SourceBadge";
import type { HistoryRespClient } from "@/lib/desk/quant-api";

const bjTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
};

const RUN_STATUS: Record<string, string> = { success: "成功", failure: "失败", running: "执行中", skipped: "跳过" };

export function HistoryBar({
  kind, view, resp, busy, loading, onToday, onDate, onState,
}: {
  kind: "radar" | "events";
  /** today = 当日库行视图（原接口）；history = 指定日期的归档视图 */
  view: "today" | "history";
  resp: HistoryRespClient<unknown> | null;
  busy?: boolean;
  loading?: boolean;
  onToday: () => void;
  onDate: (date: string) => void;
  /** 仅雷达有 state 列；事件页面不传，组件也不显示该控件 */
  onState?: (state: "all" | "live" | "superseded") => void;
}) {
  const [pick, setPick] = useState("");
  const today = resp?.today ?? "";
  const dates = resp?.available_dates ?? [];
  const latest = dates.find((d) => d.rows > 0) ?? null;
  const current = resp?.date ?? "";
  const label = kind === "radar" ? "雷达信号" : "全球事件";
  // 元信息没读回来之前不能断言"库内暂无归档"：那是把「还没查到」说成「查过了、没有」
  const latestLabel = !resp ? "最近有数据（归档清单读取中…）" : latest ? `最近有数据（${latest.date}）` : "最近有数据（库内暂无归档）";
  const latestTitle = !resp ? "正在读取 /api/" + kind + "/history 的归档日期清单"
    : latest ? `库内最近有归档数据的一天：${latest.date}` : "库里还没有任何归档数据";

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-muted-foreground"><CalendarDays size={12} /> 查询范围</span>
        <button onClick={onToday} disabled={busy}
          className={`rounded-md border px-2 py-1 ${view === "today" ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : "border-border text-muted-foreground hover:border-sky-500/40"}`}>
          今天{today ? `（${today}）` : ""}
        </button>
        <button onClick={() => latest && onDate(latest.date)} disabled={busy || !latest}
          title={latestTitle}
          className={`rounded-md border px-2 py-1 ${view === "history" && current === latest?.date ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : "border-border text-muted-foreground hover:border-sky-500/40"} ${latest ? "" : "opacity-50"}`}>
          {latestLabel}
        </button>
        <input type="date" value={pick} max={today || undefined} disabled={busy}
          onChange={(e) => setPick(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px]" />
        <button onClick={() => pick && onDate(pick)} disabled={busy || !pick}
          className="rounded-md bg-sky-500/90 px-2 py-1 text-[11px] text-white hover:bg-sky-400 disabled:opacity-50">
          查指定日期
        </button>
        {loading && <span className="text-[10.5px] text-muted-foreground">读取归档中…</span>}
      </div>

      {view === "history" && resp && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">历史归档 · {resp.date}</span>
            {kind === "radar" && (
              <span className="text-[12px] text-muted-foreground">成立 {resp.counts.live} 条 · 已消失 {resp.counts.superseded ?? 0} 条</span>
            )}
            {kind === "events" && <span className="text-[12px] text-muted-foreground">共 {resp.counts.rows} 条</span>}
          </div>
          {onState && (
            <div className="flex gap-1.5">
              {(["all", "live", "superseded"] as const).map((s) => (
                <button key={s} onClick={() => onState(s)} disabled={busy}
                  className={`rounded border px-2.5 py-1 text-[11.5px] ${resp.state_filter === s ? "border-sky-500/50 text-sky-200" : "border-border text-muted-foreground hover:border-sky-500/40"}`}>
                  {s === "all" ? "全部" : s === "live" ? "只看成立" : "只看已消失"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "today" && (
        <div className="text-[11px] text-muted-foreground/70">
          {latest ? `想看历史？点上面的日期，最近有数据的是 ${latest.date}。` : "收盘后会自动扫描，历史记录会保留下来。"}
        </div>
      )}
    </div>
  );
}
