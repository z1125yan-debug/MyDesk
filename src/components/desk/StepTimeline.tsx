"use client";
// P7-⑤③ 步骤时间线：把「这次回答到底调过哪些真实接口、每一步什么状态」摆在明面上。
//
// 为什么单独成组件：AI 首页（工具调用）、智能助手页、右下角随问小窗三处都要展示同一种东西，
// 各自画一套就会各自漂移（P6 时已经吃过「同一个来源两种说法」的亏）。
// 口径：running=正在等这一步；ok=真的取到了；missing=没取到（不是 0，也不是失败）；error=调用抛错。
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, AlertTriangle, XCircle, Loader2 } from "lucide-react";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import type { StepInfo } from "@/lib/desk/chat-core";

const STATUS_META: Record<StepInfo["status"], { icon: typeof Loader2; text: string; tone: string }> = {
  running: { icon: Loader2, text: "进行中", tone: "text-sky-300" },
  ok: { icon: CheckCircle2, text: "已取到", tone: "text-emerald-300" },
  missing: { icon: AlertTriangle, text: "缺数据", tone: "text-amber-300" },
  error: { icon: XCircle, text: "调用失败", tone: "text-red-300" },
};

export default function StepTimeline({
  steps,
  warning,
  streaming,
  defaultOpen,
}: {
  steps?: StepInfo[];
  warning?: string;
  streaming?: boolean;
  defaultOpen?: boolean;
}) {
  // hooks 一律在 early-return 之前跑完：steps 会从「没有」变「有」，条件之后挂 hook 就是按次数不一致渲染。
  const missing = steps?.filter((s) => s.status === "missing").length ?? 0;
  const failed = steps?.filter((s) => s.status === "error").length ?? 0;
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
            工作过程 · {steps?.length ?? 0} 步
            {missing ? ` · ${missing} 步缺数据` : ""}
            {failed ? ` · ${failed} 步失败` : ""}
          </span>
        </>
      }
    >
      <div className="mt-0.5 space-y-1 border-l border-border/70 pl-2.5">
        {steps?.map((s) => {
          const meta = STATUS_META[s.status] ?? STATUS_META.ok;
          const Icon = meta.icon;
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
                  <span>{s.label}</span>
                  <span className={meta.tone}>{meta.text}</span>
                  {s.ms != null && <span className="font-mono text-[10px] text-muted-foreground">{s.ms}ms</span>}
                </div>
                {s.reason && (
                  <div className="mt-0.5 text-[10px] text-muted-foreground/80">{s.reason}</div>
                )}
                {s.detail && (
                  <div className="mt-0.5 break-words font-mono text-[10px] text-muted-foreground/90">{s.detail}</div>
                )}
              </div>
            </div>
          );
        })}
        {!!steps?.length && (
          <div className="pt-0.5 text-[10px] text-muted-foreground/80">
            以上是本次真实调用过的步骤；标「缺数据」表示接口这次没给值，不是数值为 0；「系统预取」是这轮提问前按场景替你取的，「模型自取」才是模型自己要调的。
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
