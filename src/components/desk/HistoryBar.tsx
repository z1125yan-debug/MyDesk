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
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <SourceBadge status="ARCHIVED 历史归档" source={`只读 ${kind === "radar" ? "radar_finding" : "global_event"} 中 asOf=${resp.date ?? "无"} 的行`} time={resp.date ?? ""} />
            <span className="text-[10.5px] text-muted-foreground">{resp.view_basis}</span>
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            当前查看日期：<b className="text-foreground">{resp.date ?? "（库里没有可查询的归档日）"}</b>
            {resp.is_today && <span className="ml-1 text-sky-300">（恰好是今天：这一天的行仍会随扫描被重写，历史归档视图不锁定内容）</span>}
            {kind === "radar" && (
              <>
                {" · "}当前成立 {resp.counts.live} 条 · 已标记消失 {resp.counts.superseded ?? 0} 条 · 本视图 {resp.items.length} 条
              </>
            )}
            {kind === "events" && <> · 共 {resp.counts.rows} 条（事件表没有 state 列，历史行全部原样保留）</>}
          </div>
          <div className="text-[10px] text-muted-foreground/80">
            归档说明：{resp.date_basis}。{resp.state_filter_basis}
            {onState && (
              <span className="ml-1">
                切换：
                {(["all", "live", "superseded"] as const).map((s) => (
                  <button key={s} onClick={() => onState(s)} disabled={busy}
                    className={`mr-1 rounded border px-1.5 py-0.5 ${resp.state_filter === s ? "border-sky-500/50 text-sky-200" : "border-border text-muted-foreground hover:border-sky-500/40"}`}>
                    {s === "all" ? "全部" : s === "live" ? "只看成立" : "只看已消失"}
                  </button>
                ))}
              </span>
            )}
          </div>
          {!!resp.runs.length && (
            <div className="space-y-0.5 text-[10px] text-muted-foreground/80">
              <div>
                这一天的扫描记录（task_run，真实落库，当日共 {resp.runs_total} 条，接口按倒序返回最近 {resp.runs.length} 条，这里展示前 5 条）：
              </div>
              {resp.runs.slice(0, 5).map((r) => (
                <div key={r.id} className="truncate" title={`${r.basis}；${r.note}${r.error ? `；错误：${r.error}` : ""}`}>
                  {bjTime(r.finished_at ?? r.started_at)} · {r.trigger_label} · {RUN_STATUS[r.status] ?? r.status}
                  {r.status === "success" ? ` · 落库 ${r.results} 条 · 口径 ${r.mode_label}` : r.error ? ` · ${r.error.slice(0, 40)}` : ""}
                </div>
              ))}
              {resp.runs.length > 5 && <div>（另有 {resp.runs.length - 5} 条更早的记录未列出，接口已返回）</div>}
              {resp.runs_total > resp.runs.length && (
                <div>（更早的 {resp.runs_total - resp.runs.length} 条不在接口返回的最近 {resp.runs.length} 条里：真正落过库的那次可能在更早的记录里，本页面只保证「如实少列」，不保证列全）</div>
              )}
            </div>
          )}
          {!!resp.missing.length && (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300/90">
              缺失口径：{resp.missing.join("；")}
            </div>
          )}
        </div>
      )}

      {view === "today" && (
        <div className="text-[10px] text-muted-foreground/80">
          当前查看日期：<b className="text-foreground">今天{today ? `（${today}）` : "（服务端日期未读到）"}</b> ·
          {" "}{label}当日库行视图：读的是 {kind === "radar" ? "radar_finding" : "global_event"} 里 asOf=今天的库行，
          会被「立即扫描」按全量口径重写、被收盘后的自动扫描按增量口径更新；这是当天的入库结果，不是行情实时推送。
          {latest && <> 需要回看过去的某一天，用上面的日期入口（库内已有 {dates.filter((d) => d.rows > 0).length} 个可查询归档日，最近 {latest.date}）。</>}
          {!latest && resp && <> 库内当前没有可查询的归档日（扫描跑过但当日落库 0 行、或当日行被全量重刷后为 0，都会是这种状态）：历史查询只读库行，不会重算、也不会补造数据。</>}
          {!resp && <> 库内可查询归档日：正在读取…</>}
        </div>
      )}
    </div>
  );
}
