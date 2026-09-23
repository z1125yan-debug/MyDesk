"use client";
// 数据生命周期面板（P5 第五阶段）：放在设置页，只做「dry-run 预览 + 人工确认后手动执行」。
//
// 口径纪律（REAL_DATA_ONLY）：
// - 天数、候选、行数、指纹全部来自 GET /api/lifecycle/preview 的真实返回，面板自己不数、不估；
// - 保留天数不在这里也不在 API 上提供修改入口：180 天是用户 2026-09-19 定下的数据策略，
//   要改只能改 lifecycle-core 里的 RETENTION_DAYS 常量并留 worklog 记录；
// - 执行按钮要同时满足三件事：预览里有候选、确认串逐字等于 PURGE_CONFIRM_TEXT、带回这份预览的 plan_hash；
//   任何一条不满足按钮就是禁用，服务端还有同样的四道闸门（不依赖前端）。
// - 这里没有调度器、没有「到点自动清理」，所以文案也不出现这类说法。
import { useCallback, useEffect, useState } from "react";
import { Eraser, FileOutput, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { SourceBadge } from "./SourceBadge";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { PURGE_CONFIRM_TEXT } from "@/lib/quant/screener/lifecycle-core";
import {
  fetchLifecyclePreview, purgeLifecycleApi,
  type LifecyclePreviewClient, type PurgeResultClient,
} from "@/lib/desk/quant-api";

const TABLE_TEXT: Record<string, string> = {
  radar_finding: "雷达信号明细",
  global_event: "全球事件明细",
  task_run: "扫描运行记录",
  scan_cursor: "增量扫描游标",
};

export function LifecyclePanel() {
  const [data, setData] = useState<LifecyclePreviewClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PurgeResultClient | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await fetchLifecyclePreview()); }
    catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const candidates = data?.candidates ?? [];
  const canRun = !!data?.can_execute && confirmText === PURGE_CONFIRM_TEXT && !busy && !running;

  const run = async () => {
    if (!data) return;
    setRunning(true); setError(""); setResult(null);
    try {
      const r = await purgeLifecycleApi({ confirm: confirmText, plan_hash: data.plan_hash });
      setResult(r);
      setConfirmText("");
      setData(await fetchLifecyclePreview()); // 删完立刻重新预览：面板显示的永远是重算后的库内现状
    } catch (e) {
      setError(String((e as Error).message || e));
      // 被拒绝时计划可能已过期：把预览刷新，让用户看到「此刻」的指纹与候选
      setData(await fetchLifecyclePreview().catch(() => null));
    } finally { setRunning(false); }
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-1.5 text-[13.5px] font-semibold"><Eraser size={14} className="text-sky-400" /> 数据生命周期（旧信号清理）</div>
        <div className="flex items-center gap-2">
          {data && <SourceBadge status="只预览，不会删改" source="确认后才会生成删除计划" time={data.today} />}
          <button onClick={() => void load()} disabled={busy || running}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新预览
          </button>
        </div>
      </div>

      <div className="space-y-3 px-4 py-4">
        {!data && !busy && (
          <div className="text-[12px] text-muted-foreground">{error || "预览未取到：没有库内现状就不做任何判断。"}</div>
        )}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { k: "保留天数", v: `${data.retention_days} 天`, t: "由用户 2026-09-19 决定，API 不提供可改参数" },
                { k: "过期阈值", v: data.cutoff, t: `留档日严格早于 ${data.cutoff} 才进候选；今天（${data.today}）永不进候选` },
                { k: "候选清理", v: `${data.totals.candidate_days} 个归档日 / ${data.totals.candidate_rows} 行`, t: "按整天清理，不会出现半天的归档" },
                { k: "受保护保留", v: `${data.totals.protected_days} 个归档日 / ${data.totals.protected_rows} 行`, t: "未满期、当日、以及判不出年龄的行" },
              ].map((c) => (
                <div key={c.k} title={c.t} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-[10.5px] text-muted-foreground">{c.k}</div>
                  <div className="text-[13px] font-semibold">{c.v}</div>
                </div>
              ))}
            </div>

            <div className="text-[11px] text-muted-foreground">
              库里现有明细行 <b className="text-foreground">{data.detail_rows_in_db}</b> 行 · 依据：{data.basis} · 计划指纹{" "}
              <span className="cursor-help underline decoration-dotted" title={`两次数值不同＝两次看到的库内容不一样（防「预览的是 A、确认时已变 B」）：${data.plan_hash}`}>已登记</span>
            </div>

            <ul className="space-y-1 text-[11px] leading-4 text-muted-foreground">
              {data.policy_notes.map((n) => <li key={n}>· {n}</li>)}
              <li>· {data.state_note}</li>
            </ul>

            {!!candidates.length ? (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-accent/40 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1">表</th><th className="px-2 py-1">归档日</th>
                      <th className="px-2 py-1 text-right">行数</th><th className="px-2 py-1 text-right">其中成立</th>
                      <th className="px-2 py-1 text-right">已标记消失</th><th className="px-2 py-1 text-right">距今</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr key={`${c.table}@${c.date}`} className="border-t border-border/60">
                        <td className="px-2 py-1">{TABLE_TEXT[c.table] ?? c.table}</td>
                        <td className="px-2 py-1 font-mono">{c.date}</td>
                        <td className="px-2 py-1 text-right">{c.rows}</td>
                        <td className="px-2 py-1 text-right">{c.live}</td>
                        <td className="px-2 py-1 text-right">{c.superseded}</td>
                        <td className="px-2 py-1 text-right">{c.age_days} 天</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-2 text-[11.5px] text-emerald-300/90">
                {data.missing.join("；") || "当前没有任何满 180 天的归档日进入候选：这是库内现状，不是功能没生效。"}
              </div>
            )}

            {!!data.protected_days.length && (
              <DeskCollapse
                className="mt-2"
                title={`受保护未进的归档日 ${data.protected_days.length} 项（为什么一行都不动，逐条写着）`}
                triggerClassName="text-[11px] text-muted-foreground hover:text-foreground"
                contentClassName="text-[11px] text-muted-foreground"
              >
                <ul className="space-y-0.5">
                  {data.protected_days.map((p) => (
                    <li key={`${p.table}@${p.date}`}>· {TABLE_TEXT[p.table] ?? p.table} {p.date}（{p.rows} 行）：{p.reason}</li>
                  ))}
                </ul>
              </DeskCollapse>
            )}

            <div className="rounded-lg border border-border/70 bg-background/40 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
              {data.run_tables.note}
              {!!data.run_tables.expired.length && (
                <span className="mt-0.5 block">
                  超过阈值但不清理的条数：{data.run_tables.expired.map((e) => `${TABLE_TEXT[e.table] ?? e.table} ${e.rows} 条`).join("、")}
                </span>
              )}
            </div>

            <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-red-300">
                <TriangleAlert size={13} /> 执行清理（物理删除，不可一键回滚）
              </div>
              <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11px] leading-4 text-muted-foreground">
                <li>服务端先把候选日的全部明细行导出成 JSON 快照并回读复核行数；导出任一步失败 ⇒ 一行都不删；</li>
                <li>然后按「整天」删除这些行；恢复只能按导出文件的列名手工写回，项目里没有一键回滚；</li>
                <li>必须逐字输入确认串，且执行时的库内现状与上面的指纹一致，否则服务端拒绝（409）并说明「未删除任何行」。</li>
              </ol>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={`逐字输入 ${PURGE_CONFIRM_TEXT}`} spellCheck={false}
                  className="min-w-[15rem] flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11.5px] outline-none focus:border-red-500/50" />
                <button onClick={() => void run()} disabled={!canRun}
                  title={!data?.candidates.length ? "预览里没有候选：没有东西可删，接口也会拒绝执行"
                    : confirmText !== PURGE_CONFIRM_TEXT ? `确认串必须逐字为 ${PURGE_CONFIRM_TEXT}` : "按「先导出再删除」执行一次清理"}
                  className="rounded-md border border-red-500/45 bg-red-500/15 px-3 py-1.5 text-[12px] text-red-200 hover:bg-red-500/25 disabled:opacity-40">
                  {running ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : <FileOutput size={12} className="mr-1 inline" />}
                  {running ? "导出并删除中" : `执行清理${candidates.length ? `（${candidates.length} 个归档日 / ${data.totals.candidate_rows} 行）` : "（当前无候选）"}`}
                </button>
              </div>
            </div>

            {result && (
              <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-2 text-[11px] leading-4 text-emerald-300/90">
                <div>本次已清理 {result.rows_deleted} 行 · 涉及 {result.deleted} 个归档日 · 明细行 {result.detail_rows_in_db_before} → {result.detail_rows_in_db_after}</div>
                {result.export && <div className="mt-0.5">导出快照：<span className="font-mono">{result.export.path}</span>（{result.export.row_count} 行 / {result.export.bytes} 字节，写盘后已回读复核）</div>}
                {!!result.per_day.length && (
                  <div className="mt-0.5 text-muted-foreground">
                    逐日：{result.per_day.map((d) => `${TABLE_TEXT[d.table] ?? d.table} ${d.date} 删 ${d.count} 行`).join("；")}
                  </div>
                )}
                <div className="mt-0.5 text-muted-foreground">{result.note}</div>
              </div>
            )}
            {error && <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
