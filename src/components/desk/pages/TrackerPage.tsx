"use client";
import { CheckCircle2, XCircle, Trash2, Target } from "lucide-react";
import { useDesk } from "@/lib/desk/store";

export default function TrackerPage() {
  const tracker = useDesk((s) => s.tracker);
  const updateStatus = useDesk((s) => s.updateTrackerStatus);
  const remove = useDesk((s) => s.removeTracker);

  return (
    <div className="w-full space-y-4 p-5">
      <div>
        <h1 className="text-xl font-bold">追踪</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">从分析页「加入追踪」的计划会保存在这里（本机浏览器存储）</p>
      </div>

      {tracker.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <Target size={30} className="text-muted-foreground/50" />
          <div className="text-[14px] text-muted-foreground">还没有追踪计划。去 AI 分析页生成解读后一键加入。</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {tracker.map((t) => {
            const long = t.direction === "long";
            return (
              <div key={t.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={"rounded px-1.5 py-0.5 text-[12.5px] font-medium " +
                      (long ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300")}>
                      {long ? "做多" : "做空"}
                    </span>
                    <span className="text-[15px] font-semibold">{t.name}</span>
                    <span className="font-mono text-[12px] text-muted-foreground">{t.symbol}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => updateStatus(t.id, "hit_target")} title="标记触达目标"
                      className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-emerald-400"><CheckCircle2 size={15} /></button>
                    <button onClick={() => updateStatus(t.id, "hit_stop")} title="标记触达止损"
                      className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-rose-400"><XCircle size={15} /></button>
                    <button onClick={() => remove(t.id)} title="删除"
                      className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-rose-400"><Trash2 size={15} /></button>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[13.5px]">
                  <div className="rounded-md bg-accent/50 p-2">
                    <div className="text-[11.5px] text-muted-foreground">入场</div>
                    <div className="mt-0.5 tabular-nums">{t.entry}</div>
                  </div>
                  <div className="rounded-md bg-accent/50 p-2">
                    <div className="text-[11.5px] text-muted-foreground">止损</div>
                    <div className="mt-0.5 tabular-nums text-emerald-400">{t.stop || "—"}</div>
                  </div>
                  <div className="rounded-md bg-accent/50 p-2">
                    <div className="text-[11.5px] text-muted-foreground">目标</div>
                    <div className="mt-0.5 tabular-nums text-rose-400">{t.targets.length ? t.targets.join(" / ") : "—"}</div>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center justify-between text-[12.5px]">
                  <span className={"rounded px-1.5 py-0.5 " +
                    (t.status === "watching" ? "bg-sky-500/12 text-sky-300" : t.status === "hit_target" ? "bg-rose-500/12 text-rose-300" : "bg-emerald-500/12 text-emerald-300")}>
                    {t.status === "watching" ? "观察中" : t.status === "hit_target" ? "已触达目标" : "已触达止损"}
                  </span>
                  <span className="text-muted-foreground">{t.createdAt}</span>
                </div>
                {t.note && <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{t.note}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
