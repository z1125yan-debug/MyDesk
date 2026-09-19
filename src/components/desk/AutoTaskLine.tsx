"use client";
// 后台自动任务状态条（P2-自动化 13）：只渲染 /api/tasks/status 从 task_run 读回的真实记录。
// 口径纪律：
// - 「已自动运行」只有当日存在 trigger=schedule 且 success 的行时才说；手动扫描单独标「手动」。
// - 服务进程没启动 / DESK_SCHEDULER=0 时如实显示，不写成「每天自动运行」。
import { useCallback, useEffect, useState } from "react";
import { fetchTaskStatus, type TaskStatusClient } from "@/lib/desk/quant-api";

const bjTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
};

const hhmm = (minuteOfDay: number): string =>
  `${String(Math.floor(minuteOfDay / 60) % 24).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;

const STATUS_TEXT: Record<string, string> = {
  success: "成功", failure: "失败", running: "执行中", skipped: "跳过",
};

export function AutoTaskLine({ kind, refreshKey = 0 }: { kind: "radar" | "events"; refreshKey?: number }) {
  const [st, setSt] = useState<TaskStatusClient | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setSt(await fetchTaskStatus()); setError(""); }
    catch (e) { setError(String((e as Error).message || e)); }
  }, []);

  // refreshKey 变化 = 手动扫描结束后重读，保证「刚跑完这一次」立刻反映到状态条
  useEffect(() => { void load(); }, [load, refreshKey]);

  if (error) {
    return <div className="text-[10.5px] text-muted-foreground">后台任务状态：读取失败（{error}）</div>;
  }
  if (!st) return <div className="text-[10.5px] text-muted-foreground">后台任务状态：读取中…</div>;

  const sum = st.today_summary.find((s) => s.kind === kind);
  const runs = st.today_runs.filter((r) => r.kind === kind);
  const last = runs[0]; // 今日最近一条（含失败/跳过），只用于「最近记录」提示
  const lastAuto = runs.find((r) => r.status === "success" && r.trigger === "schedule");
  const autoDone = !!lastAuto;
  const manualDone = runs.some((r) => r.status === "success" && r.trigger === "manual");
  const skippedBasis = runs.find((r) => r.status === "skipped")?.basis ?? "";
  // 条数只报「当日成立的那一次扫描」：自动优先，否则取最近一次成功的自动/手动行
  const shown = lastAuto ?? runs.find((r) => r.status === "success") ?? null;

  const state = !st.enabled
    ? "调度器未启用（DESK_SCHEDULER=0）"
    : !st.running
      ? "调度器未随本进程启动"
      : lastAuto
        ? `今日收盘后已自动扫描（${bjTime(lastAuto.finished_at)}）`
        : sum?.last_status === "failure"
          ? `今日自动扫描失败 ${sum.attempts} 次，将按窗口重试`
          : st.due_now
            ? "已到执行窗口，等待本轮检查"
            : `今日未运行（等待 ${bjTime(st.slot_at ?? st.next.at)} 窗口）`;

  const origin = autoDone ? "自动" : manualDone ? "手动" : "";
  const counts = shown ? `扫描 ${shown.scanned} 条 / 落库 ${shown.results} 条` : "";

  return (
    <div className="text-[10.5px] text-muted-foreground" title={st.boundary}>
      后台任务（{kind}）：{state}
      {origin && <>；当日最近一次为 <span className="text-sky-400">{origin}</span> 触发{counts ? ` · ${counts}` : ""}</>}
      {sum?.last_status === "failure" && sum.last_error && <>；最近错误：{sum.last_error.slice(0, 60)}</>}
      {skippedBasis && !autoDone && <>；{skippedBasis}</>}
      {last && <>；最近记录 {STATUS_TEXT[last.status] ?? last.status}/{last.trigger === "schedule" ? "自动" : "手动"} {bjTime(last.finished_at ?? last.started_at)}</>}
      <div className="text-[10px] text-muted-foreground/70">
        口径：{st.boundary}；窗口=交易日 {hhmm(st.config.closeMinute)} 收盘后 {st.config.delayMinutes} 分钟，每 {st.tick_seconds}s 检查，每日每任务最多 {st.config.maxAttempts} 次尝试。
      </div>
    </div>
  );
}
