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
import { deriveAgentPhases, agentPhasesHeadline, groupStepsByPhase, AGENT_PHASES } from "@/lib/desk/agent-phases-core";
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

/**
 * 耗时格式：逐字对齐稳智 agentStepTimeline.h(t)——
 * <1s 给「Nms」、<60s 给「N.Ns」、更久给「R分S秒」/「R分」。没有耗时（null/0）返回空串不画。
 */
function fmtStepDuration(ms: number): string {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return s > 0 ? `${m}分${s}秒` : `${m}分`;
}

export default function StepTimeline({
  steps,
  warning,
  streaming,
  defaultOpen,
  intent,
  debug,
  debugOn,
  message,
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
  /** P18：本轮消息本身（用它的 content 长度和 streaming 判定 answer 阶段状态） */
  message?: { content?: string; streaming?: boolean };
}) {
  // hooks 一律在 early-return 之前跑完：steps 会从「没有」变「有」，条件之后挂 hook 就是按次数不一致渲染。
  const missing = steps?.filter((s) => s.status === "missing").length ?? 0;
  const failed = steps?.filter((s) => s.status === "error").length ?? 0;
  // 调试视图：只吃已回传字段（intent/steps/debug），不产生新事实；开关关着就不算这一份
  const view = debugOn ? buildDebugView({ intent: intent ?? null, steps: steps ?? [], done: debug ?? null }) : null;
  // P36 稳智口径修正（用户实测反馈）：执行过程常态就是**单行流动进度**（见下方 title 的
  // flow-hero 单行），不再自动摊开。旧口径 `streaming === true && !!steps?.length`（含 P34 的
  // 「正文未开始才展开」放宽版）都会在**取数阶段**把整块铺开——用户截图就是「一打开还是这样」。
  // 现在：默认收起；用户点开才看 6 阶段条 + 步骤清单 + 调试段。受控出口仍接回 radix
  // （onOpenChange={setOpen}），用户手点随时作数、不被覆盖。
  const pinned = defaultOpen ?? false;
  const [open, setOpen] = useState(pinned);
  const prevPinned = useRef(pinned);
  useEffect(() => {
    if (prevPinned.current !== pinned) {
      prevPinned.current = pinned;
      setOpen(pinned);
    }
  }, [pinned]);
  if (!steps?.length && !warning) return null;
  // P18 稳智对齐：6 阶段进度条（intent→skills→local_data→external_data→research→answer）
  // 数据来自 agent-phases-core.deriveAgentPhases，从 steps + intent 语义反推。
  // 消息对象从调用方透传：AssistantPage 传的 m 就是 ChatMessage。
  const phases = deriveAgentPhases(steps ?? [], intent ?? null, message ?? {});
  const headline = agentPhasesHeadline(phases);
  // 单行流动进度（对齐稳智 AiMatrixFlowExecutionCard 的 flow-hero + flowVisualRegistry.f()）：
  //   - 主文案：跑的时候优先报「正在进行：<当前步骤 label>」（步骤一换，这一行就跟着换）；
  //     没有活跃步骤（例如正文已经在流式）回落 6 阶段 headline（💡 正在生成结论 / ✅ 结论已形成）。
  //   - 右侧：完成百分比 + 蓝绿渐变流动条（is-running 时 background-position 无限流动）。
  const totalSteps = steps?.length ?? 0;
  const activeStep = steps?.find((s) => s.status === "running") ?? null;
  // 本轮还没跑完（取数中或正文流式中）→ 流动条一直动、图标转；收口后停。
  const isRunning = streaming === true && totalSteps > 0;
  const finishedSteps = steps?.filter((s) => s.status !== "running").length ?? 0;
  const progressPct = totalSteps > 0 ? Math.max(0, Math.min(100, Math.round((finishedSteps / totalSteps) * 100))) : 0;
  return (
    <DeskCollapse
      open={open}
      onOpenChange={setOpen}
      className="text-[13px] wz-strip"
      triggerClassName="text-[13px] wz-strip"
      // 单行头（收起/展开都是这一行）：状态图标 + 实时文案 + 步数 + 缺数据/失败 + 百分比 + 流动条。
      // 不再单独挂 hint——这一行本身就把「在做什么、到哪一步」说全了，用户要细节就点开看。
      title={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {isRunning
            ? <Loader2 size={11} className="shrink-0 animate-spin text-sky-400" />
            : <CircleDashed size={11} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-snug">
            {/* P18 稳智式顶部大字：answer done→"✅ 结论已形成"；跑的时候优先报当前步骤，
                没有活跃步骤（正文已开始流式）就回落 headline（💡 正在生成结论）。
                P61：这一行抬到稳智 .ai-execution-title 的 16px/600 档（这里 15px/600，
                因为整条还在 13px 的条内，再大会把「进度条」那一列挤歪）。 */}
            {activeStep ? `正在进行：${activeStep.label}` : headline}
            {" · "}已完成 {steps?.length ?? 0} 步
            {missing ? ` · ${missing} 步缺数据` : ""}
            {failed ? ` · ${failed} 步失败` : ""}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{progressPct}%</span>
            <span className="flow-hero-track" aria-hidden="true">
              <span className={"flow-hero-fill" + (isRunning ? " is-running" : "")} style={{ width: `${progressPct}%` }} />
            </span>
          </span>
        </span>
      }
    >
      <div className="mt-0.5 space-y-1.5 border-l border-border/70 pl-2.5">
        {/* P18 6 阶段进度条：一横排 6 个圆点 + 中文名，颜色/图标按状态映射 */}
        <div className="mb-1 grid grid-cols-6 gap-1">
          {phases.map((p) => {
            const tone = p.status === "done" ? "bg-emerald-500/20 text-emerald-300"
              : p.status === "active" ? "bg-sky-500/20 text-sky-300"
              : p.status === "error" ? "bg-red-500/20 text-red-300"
              : "bg-overlay text-muted-foreground/60";
            const icon = p.status === "done" ? "✓"
              : p.status === "active" ? "●"
              : p.status === "error" ? "⚠"
              : "○";
            return (
              <div key={p.key} title={p.zh}
                className={"flex flex-col items-center gap-0.5 rounded px-0.5 py-1 text-center " + tone}>
                <span className="text-[13px] leading-none">{p.emoji}</span>
                <span className="text-[10px] font-medium leading-tight">{icon}</span>
              </div>
            );
          })}
        </div>
        {/* P8-⑤ 意图小节：徽章里已回传的字段拼成一行话，判不出来就写「本轮未做场景判定」 */}
        {view && (
          <div className="rounded border border-sky-500/25 bg-sky-500/5 px-1.5 py-1 text-[11px] leading-4 text-muted-foreground">
            <span className="font-mono text-[10.5px] text-sky-300/90">意图</span> {view.intentSection.summary}
          </div>
        )}
        {/* P22 步骤按 6 阶段分组渲染：每组有阶段标题行（emoji + 中文名 + 该组步骤计数），
            下面挂该组的步骤。空阶段跳过。intent/skills/answer 三阶段没有实际步骤行——
            intent 有 view.intentSection 兜底、skills 靠 steps 存在判定、answer 靠消息流本身，
            不硬凑空组（否则用户看到 6 个空标题）。
            分组口径在 agent-phases-core.groupStepsByPhase，tsx 只做排版。 */}
        {(() => {
          const groups = groupStepsByPhase(steps);
          return AGENT_PHASES.map((ph) => {
            const groupSteps = groups[ph.key];
            if (groupSteps.length === 0) return null;
          if (groupSteps.length === 0) return null;
          const phase = phases.find((p) => p.key === ph.key);
          return (
            <div key={ph.key} className="mb-1">
              <div className="flex items-center gap-1.5 rounded bg-accent/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                <span aria-hidden>{ph.emoji}</span>
                <span>{ph.zh}</span>
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/70">{groupSteps.length} 步</span>
                {phase && phase.status === "active" && <span className="text-sky-300">●</span>}
                {phase && phase.status === "error" && <span className="text-red-300">⚠</span>}
                {phase && phase.status === "done" && <span className="text-emerald-300">✓</span>}
              </div>
              {/* 步骤行：对齐稳智 .ai-step —— 16px 图标列 + 内容列；活跃步骤挂 2px 流动条 + 实时文案。
                  本地五态语义（已取到/缺数据/失败/数据滞后）与「步N/系统预取/模型自取/第N轮」信息一个不删。 */}
              <div className="ai-step-list mt-0.5 pl-1">
                {groupSteps.map((s) => {
                  const meta = STATUS_META[s.status] ?? STATUS_META.ok;
                  const Icon = meta.icon;
                  const row = view?.stepsSection.find((r) => r.step === s.step) ?? null;
                  const isRunning = s.status === "running";
                  // 实时进度文案：只在这一步真在跑（且本轮仍在流式）时出现——停笔了就不再自称「正在…」
                  const live = isRunning && streaming ? (s.detail || s.reason || s.label) : "";
                  return (
                    <div key={`${s.step}-${s.tool ?? s.label}`}
                      className={"ai-step " + (isRunning ? "is-active" : s.status === "error" ? "is-error" : "is-done")}>
                      <span className="ai-step-icon"><Icon size={12.5} className={meta.tone + (isRunning ? " animate-spin" : "")} /></span>
                      <div className="ai-step-main">
                        <div className="ai-step-line flex-wrap">
                          <span className="rounded bg-accent px-1 font-mono text-[10.5px] text-muted-foreground">步 {s.step}</span>
                          {/* P7-⑥⑥：系统按场景预取的、和模型自己决定要调的，不是一回事。
                              混着画就会出现「模型很能干」的假象 —— 数据其实是这轮提问前我们替它取的。 */}
                          {s.source && (
                            <span className={"rounded border px-1 text-[10.5px] " + (s.source === "prefetch"
                              ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                              : "border-border text-muted-foreground")}>
                              {s.source === "prefetch" ? "系统预取" : "模型自取"}
                            </span>
                          )}
                          {/* P8-⑤：补充轮（B 轮 ④ 对账后补取）的步骤带轮次小徽，两轮并排可见、失败行不折叠 */}
                          {row && row.round >= 2 && (
                            <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1 text-[10.5px] text-indigo-300">第 {row.round} 轮</span>
                          )}
                          <span className="ai-step-label">{s.label}</span>
                          {s.ms != null && <span className="ai-step-duration">{fmtStepDuration(s.ms)}</span>}
                          <span className={"ai-step-status " + meta.tone}>{stepStatusText(s.status)}</span>
                        </div>
                        {/* 正在执行：稳智 .ai-step-live-progress（2px 流动条 + 实时文案） */}
                        {live && (
                          <span className="ai-step-live-progress" role="status" aria-live="polite" data-live-progress>
                            <span className="ai-step-live-track" aria-hidden="true"><span /></span>
                            <span className="ai-step-live-text">{live}</span>
                          </span>
                        )}
                        {s.reason && (
                          <div className="ai-step-detail">{s.reason}</div>
                        )}
                        {s.detail && (
                          <div className="ai-step-detail break-words font-mono">{s.detail}</div>
                        )}
                        {/* P8-⑤ 调试行：入参与返回摘要只在富化帧到达后才有（本轮请求带过 debug:true）；
                            没有就整行不画——不拿「没显示」冒充「没调用」。 */}
                        {row?.argsText && (
                          <div className="ai-step-detail break-words font-mono opacity-80">参数 {row.argsText}</div>
                        )}
                        {row?.summary && (
                          <div className="ai-step-detail break-words font-mono opacity-80">摘要 {row.summary}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })})()}
        {!!steps?.length && (
          <div className="pt-0.5 text-[11px] text-muted-foreground/80">
            以上是本次真实调用过的步骤；标「缺数据」表示接口这次没给值，不是数值为 0；标「数据滞后」表示取到了、但与真实交易日历核对后不新鲜（或无法判定新鲜度），回答里以哪份为准看该步说明；「系统预取」是这轮提问前按场景替你取的，「模型自取」才是模型自己要调的。
          </div>
        )}
        {/* P8-⑤ 结论小节 + 七维计数：只吃 done 留底与步骤终态，running 单列（不收口的步骤不能混进「已取到」）。
            没有任何留底时整节写「未留底」，不拼半成品。 */}
        {view && (
          <div className="pt-0.5 text-[11px] leading-4 text-muted-foreground/80">
            <span className="font-mono text-[10.5px] text-sky-300/90">结论</span>{" "}
            {view.conclusionSection.noted
              ? [view.conclusionSection.transportText, view.conclusionSection.modelMs != null ? `模型 ${view.conclusionSection.modelMs}ms` : ""].filter(Boolean).join(" · ")
              : "未留底（本轮没开调试，或回复没收到完整收尾包）"}
            {` · 取数统计：共 ${view.counts.total} 项 · 成功 ${view.counts.ok} · 失败 ${view.counts.error} · 没数据 ${view.counts.missing} · 数据滞后 ${view.counts.stale} · 还在跑 ${view.counts.running} · 模型自取补数 ${view.counts.supplemented} 轮`}
          </div>
        )}
        {/* P33 稳智对齐 P3 #16：3 个 perf-block（后端耗时拆解 / LLM 详情 / SSE 事件统计） */}
        {view && (
          <div className="pt-0.5 grid grid-cols-3 gap-1 text-[11px] leading-4 text-muted-foreground/80">
            <div className="rounded border border-border/70 px-1.5 py-1">
              <div className="font-mono text-[10.5px] text-sky-300/90">后端耗时</div>
              <div className="mt-0.5">
                {view.perfBlocks.backendTiming.firstTokenMs != null && <span>首帧 {view.perfBlocks.backendTiming.firstTokenMs}ms</span>}
                {view.perfBlocks.backendTiming.streamDoneMs != null && <span> · 总耗时 {view.perfBlocks.backendTiming.streamDoneMs}ms</span>}
                {view.perfBlocks.backendTiming.firstTokenMs == null && view.perfBlocks.backendTiming.streamDoneMs == null && <span>未留底</span>}
              </div>
            </div>
            <div className="rounded border border-border/70 px-1.5 py-1">
              <div className="font-mono text-[10.5px] text-sky-300/90">LLM 详情</div>
              <div className="mt-0.5">
                {view.perfBlocks.llmDetail.variant ? <span>传输：{view.perfBlocks.llmDetail.variant}</span> : <span>未留底</span>}
              </div>
            </div>
            <div className="rounded border border-border/70 px-1.5 py-1">
              <div className="font-mono text-[10.5px] text-sky-300/90">SSE 事件</div>
              <div className="mt-0.5">
                <span>步骤 {view.perfBlocks.sseEventCount.step} · 错误 {view.perfBlocks.sseEventCount.error} · 总计 {view.perfBlocks.sseEventCount.total}</span>
              </div>
            </div>
          </div>
        )}
        {warning && (
          <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11.5px] leading-4 text-amber-200">
            {warning}
          </div>
        )}
      </div>
    </DeskCollapse>
  );
}
