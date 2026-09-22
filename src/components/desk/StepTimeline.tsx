"use client";
// P7-⑤③ 步骤时间线：把「这次回答到底调过哪些真实接口、每一步什么状态」摆在明面上。
//
// 为什么单独成组件：AI 首页（工具调用）、智能助手页、右下角随问小窗三处都要展示同一种东西，
// 各自画一套就会各自漂移（P6 时已经吃过「同一个来源两种说法」的亏）。
// 口径：running=正在等这一步；ok=真的取到了；missing=没取到（不是 0，也不是失败）；error=调用抛错；
// stale=取到了但比对真实交易日历后滞后/新鲜度无法判定（P8-①，detail 带核对结果原文）。
//
// P8-⑤：debugOn（页面顶栏那个开关，默认关）打开时多画三段调试视图——
// 意图行（徽章字段的一句话汇总）、步骤行的入参/摘要/轮次、结论留底 + 七维计数。
// 数据全部来自已经在发的帧（本轮请求带 debug:true 时路由才在轮末重发富化终帧），
// 组装口径在 debug-core 一处，这里只排版；关着时渲染结果与 A/B 轮逐字一致。
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, AlertTriangle, XCircle, Loader2, CalendarClock } from "lucide-react";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { buildDebugView, stepStatusText } from "@/lib/desk/debug-core";
import type { IntentBadge, StepInfo } from "@/lib/desk/chat-core";

// P8-⑤：状态文案搬进 debug-core.stepStatusText（单一出处），这里只留图标与配色——
// 五态文案与解码兜底不会再各说各话。
const STATUS_META: Record<StepInfo["status"], { icon: typeof Loader2; tone: string }> = {
  running: { icon: Loader2, tone: "text-sky-300" },
  ok: { icon: CheckCircle2, tone: "text-emerald-300" },
  missing: { icon: AlertTriangle, tone: "text-amber-300" },
  error: { icon: XCircle, tone: "text-red-300" },
  // 与 missing 分开画：一个是「没取到」，一个是「取到了但不是新的」，对用户来说是两句不同的话
  stale: { icon: CalendarClock, tone: "text-amber-300" },
};

export default function StepTimeline({
  steps,
  warning,
  streaming,
  defaultOpen,
  intent,
  debug,
  debugOn,
}: {
  steps?: StepInfo[];
  warning?: string;
  streaming?: boolean;
  defaultOpen?: boolean;
  /** P8-⑤：本轮场景徽章（意图小节的全部来源，没有就如实写「未做场景判定」） */
  intent?: IntentBadge | null;
  /** P8-⑤：done 帧带回的结论留底（模型耗时 + 传输档位） */
  debug?: { modelMs?: number; transport?: string };
  /** P8-⑤：调试视图开关（页面顶栏那一个；关着时本组件与改造前渲染同样的东西） */
  debugOn?: boolean;
}) {
  // hooks 一律在 early-return 之前跑完：steps 会从「没有」变「有」，条件之后挂 hook 就是按次数不一致渲染。
  const missing = steps?.filter((s) => s.status === "missing").length ?? 0;
  const failed = steps?.filter((s) => s.status === "error").length ?? 0;
  // 调试视图：只吃已回传字段（intent/steps/debug），不产生新事实；开关关着就不算这一份
  const view = debugOn ? buildDebugView({ intent: intent ?? null, steps: steps ?? [], done: debug ?? null }) : null;
  // 原来靠原生 details 的 open 属性做「开流自动展开、流毕自动收起，中途用户手点也作数」；
  // radix 受控要自己管：派生值翻转时才强制对齐，其余时候 open 状态归用户。
  const pinned = defaultOpen ?? (streaming === true && !!steps?.length);
  const [open, setOpen] = useState(pinned);
  const prevPinned = useRef(pinned);
  useEffect(() => {
    if (prevPinned.current !== pinned) {
      prevPinned.current = pinned;
      setOpen(pinned);
    }
  }, [pinned]);
  if (!steps?.length && !warning) return null;
  return (
    <DeskCollapse
      open={open}
      onOpenChange={setOpen}
      className="text-[11px]"
      triggerClassName="text-[11px]"
      title={
        <>
          {streaming && steps?.some((s) => s.status === "running")
            ? <Loader2 size={11} className="animate-spin text-sky-400" />
            : <CircleDashed size={11} />}
          <span>
            {/* P15 对齐稳智措辞：跑完就说「AI 已完成分析 · N 步」，没跑完如实是进行时；
                缺数据/失败照样挂在标题上——收口是收口，瞒是另一回事 */}
            {streaming && steps?.some((s) => s.status === "running")
              ? `正在分析 · 已走完 ${steps?.length ?? 0} 步`
              : `AI 已完成分析 · 共 ${steps?.length ?? 0} 步`}
            {missing ? ` · ${missing} 步缺数据` : ""}
            {failed ? ` · ${failed} 步失败` : ""}
          </span>
        </>
      }
    >
      <div className="mt-0.5 space-y-1 border-l border-border/70 pl-2.5">
        {/* P8-⑤ 意图小节：徽章里已回传的字段拼成一行话，判不出来就写「本轮未做场景判定」 */}
        {view && (
          <div className="rounded border border-sky-500/25 bg-sky-500/5 px-1.5 py-1 text-[10px] leading-4 text-muted-foreground">
            <span className="font-mono text-[9.5px] text-sky-300/90">意图</span> {view.intentSection.summary}
          </div>
        )}
        {steps?.map((s) => {
          const meta = STATUS_META[s.status] ?? STATUS_META.ok;
          const Icon = meta.icon;
          const row = view?.stepsSection.find((r) => r.step === s.step) ?? null;
          return (
            <div key={`${s.step}-${s.tool ?? s.label}`} className="flex items-start gap-1.5 text-[11px] leading-4">
              <Icon size={11.5} className={"mt-0.5 shrink-0 " + meta.tone + (s.status === "running" ? " animate-spin" : "")} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-accent px-1 font-mono text-[9.5px] text-muted-foreground">步 {s.step}</span>
                  {/* P7-⑥⑥：系统按场景预取的、和模型自己决定要调的，不是一回事。
                      混着画就会出现「模型很能干」的假象 —— 数据其实是这轮提问前我们替它取的。 */}
                  {s.source && (
                    <span className={"rounded border px-1 text-[9.5px] " + (s.source === "prefetch"
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                      : "border-border text-muted-foreground")}>
                      {s.source === "prefetch" ? "系统预取" : "模型自取"}
                    </span>
                  )}
                  {/* P8-⑤：补充轮（B 轮 ④ 对账后补取）的步骤带轮次小徽，两轮并排可见、失败行不折叠 */}
                  {row && row.round >= 2 && (
                    <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1 text-[9.5px] text-indigo-300">第 {row.round} 轮</span>
                  )}
                  <span>{s.label}</span>
                  <span className={meta.tone}>{stepStatusText(s.status)}</span>
                  {s.ms != null && <span className="font-mono text-[10px] text-muted-foreground">{s.ms}ms</span>}
                </div>
                {s.reason && (
                  <div className="mt-0.5 text-[10px] text-muted-foreground/80">{s.reason}</div>
                )}
                {s.detail && (
                  <div className="mt-0.5 break-words font-mono text-[10px] text-muted-foreground/90">{s.detail}</div>
                )}
                {/* P8-⑤ 调试行：入参与返回摘要只在富化帧到达后才有（本轮请求带过 debug:true）；
                    没有就整行不画——不拿「没显示」冒充「没调用」。 */}
                {row?.argsText && (
                  <div className="mt-0.5 break-words font-mono text-[9.5px] text-muted-foreground/70">入参 {row.argsText}</div>
                )}
                {row?.summary && (
                  <div className="mt-0.5 break-words font-mono text-[9.5px] text-muted-foreground/70">摘要 {row.summary}</div>
                )}
              </div>
            </div>
          );
        })}
        {!!steps?.length && (
          <div className="pt-0.5 text-[10px] text-muted-foreground/80">
            以上是本次真实调用过的步骤；标「缺数据」表示接口这次没给值，不是数值为 0；标「数据滞后」表示取到了、但与真实交易日历核对后不新鲜（或无法判定新鲜度），回答里以哪份为准看该步说明；「系统预取」是这轮提问前按场景替你取的，「模型自取」才是模型自己要调的。
          </div>
        )}
        {/* P8-⑤ 结论小节 + 七维计数：只吃 done 留底与步骤终态，running 单列（不收口的步骤不能混进「已取到」）。
            没有任何留底时整节写「未留底」，不拼半成品。 */}
        {view && (
          <div className="pt-0.5 text-[10px] leading-4 text-muted-foreground/80">
            <span className="font-mono text-[9.5px] text-sky-300/90">结论</span>{" "}
            {view.conclusionSection.noted
              ? [view.conclusionSection.transportText, view.conclusionSection.modelMs != null ? `模型 ${view.conclusionSection.modelMs}ms` : ""].filter(Boolean).join(" · ")
              : "未留底（本轮未开调试，或 done 帧未到达）"}
            {` · 计数：共 ${view.counts.total} / 已取到 ${view.counts.ok} / 失败 ${view.counts.error} / 缺数据 ${view.counts.missing} / 滞后 ${view.counts.stale} / 进行中 ${view.counts.running} / 补充轮 ${view.counts.supplemented}`}
          </div>
        )}
        {warning && (
          <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10.5px] leading-4 text-amber-200">
            {warning}
          </div>
        )}
      </div>
    </DeskCollapse>
  );
}
