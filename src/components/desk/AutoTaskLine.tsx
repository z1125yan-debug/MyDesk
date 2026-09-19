"use client";
// 后台自动任务状态条（P2-自动化 13 + P3 增量口径）：只渲染 /api/tasks/status 从 task_run / scan_cursor 读回的真实记录。
// 口径纪律：
// - 「已自动运行」只有当日存在 trigger=schedule 且 success 的行时才说；手动扫描单独标「手动」。
// - 服务进程没启动 / DESK_SCHEDULER=0 时如实显示，不写成「每天自动运行」。
// - 「增量」只说明本次写库口径（少写、不重复写），不得用它暗示「扫描次数更多」或「数据更实时」。
import { useCallback, useEffect, useState } from "react";
import { MODE_TEXT, fetchTaskStatus, modeFromBasis, type TaskStatusClient } from "@/lib/desk/quant-api";

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
  // P3 口径：从已落库的 basis 文本读回（写与读同一份实现），读不到就直说「未记录」，不拿「增量」二字猜
  const mode = shown ? modeFromBasis(shown.basis) : "";
  const modeText = shown ? (mode ? MODE_TEXT[mode] : "未记录（该次扫描早于增量口径上线）") : "";
  const cur = sum?.cursor;
  const cursorText = !cur
    ? ""
    : !cur.exists
      ? "今日尚无成功游标 → 下一次执行按全量口径（先删后插重刷当日结果）"
      : `已确认 ${cur.done_keys} 条键${cur.unmatched_keys ? `、未命中记录 ${cur.unmatched_keys} 条` : ""}（${bjTime(cur.updated_at)}）→ 下一次自动执行按增量口径，只写新增与内容变化的行（手动点「立即扫描」仍按全量重刷）`;

  return (
    <div className="text-[10.5px] text-muted-foreground" title={st.boundary}>
      后台任务（{kind}）：{state}
      {origin && <>；当日最近一次为 <span className="text-sky-400">{origin}</span> 触发{counts ? ` · ${counts}` : ""}{modeText ? ` · 写库口径 ${modeText}` : ""}</>}
      {sum?.last_status === "failure" && sum.last_error && <>；最近错误：{sum.last_error.slice(0, 60)}</>}
      {skippedBasis && !autoDone && <>；{skippedBasis}</>}
      {last && <>；最近记录 {STATUS_TEXT[last.status] ?? last.status}/{last.trigger === "schedule" ? "自动" : "手动"} {bjTime(last.finished_at ?? last.started_at)}</>}
      {cursorText && <div className="text-[10px] text-muted-foreground/70">增量游标（{st.today}）：{cursorText}</div>}
      <div className="text-[10px] text-muted-foreground/70">
        口径：{st.boundary}；窗口=交易日 {hhmm(st.config.closeMinute)} 收盘后 {st.config.delayMinutes} 分钟，每 {st.tick_seconds}s 检查，每日每任务最多 {st.config.maxAttempts} 次尝试。
      </div>
    </div>
  );
}
