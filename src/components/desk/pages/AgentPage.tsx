"use client";
// P6-D Agent 运行页：把一次自主研究循环的每一步、每条台账、每条血缘、每一分预算都摆在页面上。
//
// 任务书 §十九 的原话是「不能变成一个完全不可解释的黑盒聊天机器人」，所以这个页面的主次是反过来的：
// 结论排在自己的调用记录之后——先看见「调了哪条工具、参数是什么、取到没有、为什么停」，再看模型说了什么。
//
// 三件必须写在页面上的事实（不写就会被读者误解）：
// 1) 本项目的 AI 通道没有原生 function-calling（凭据只在浏览器，/api/ai/proxy 只做 messages→content 转发），
//    所以「工具调用」是模型在回复文本里给出的一个 JSON 对象，协议版本 p6d.agent.v1；
// 2) 这一格一格由本机浏览器驱动（服务端拿不到 Key，不会自己调模型）：刷新/关掉页面就停在那里，
//    库里已记账的步不会消失，带同一个 run_id 可以再续；
// 3) 模型自称调用过什么不算数——只有 agent_tool_call 里的行算数，本页的步数与台账一律读服务端返回值。
//
// REAL_DATA_ONLY：没跑过就是空列表；AI 未配置显示 AI_NOT_CONFIGURED 且不去猜工具；
// 内核没登记文案的状态值原样显示并说明「不猜它什么意思」；REJECTED/PARTIAL 的结论照常整段显示，不悄悄丢。
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, RefreshCw, Square } from "lucide-react";
import { SourceBadge } from "../SourceBadge";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { useDesk } from "@/lib/desk/store";
import { aiReady as aiChannelReady } from "@/lib/desk/ai";
import {
  AGENT_LOOP_STATUS_TEXT, CLIENT_TURN_GUARD, runAgentLoop,
  type AgentLoopResult, type AgentLoopStatus, type AgentLoopTurn,
} from "@/lib/desk/agent-loop-client";
import {
  fetchAgentRunList, fetchAgentRunView, fetchAgentTools,
  type AgentCallRowClient, type AgentRunListItemClient,
  type AgentRunViewClient, type AgentToolsCatalogClient,
} from "@/lib/desk/quant-api";
import {
  AGENT_STOP_REASON_TEXT, AGENT_SYSTEM_PROMPT, LOG_STATUS_TEXT, OBS_KIND_TEXT,
} from "@/lib/quant/screener/agent-loop-core";
import { DATA_STATUS_TEXT } from "@/lib/quant/screener/datastatus-core";

/** 接口给的是宽 string，内核表按枚举索引：未知值原样显示，不套一句相近的现成文案 */
const DATA_STATUS_TABLE = DATA_STATUS_TEXT as unknown as Record<string, string>;

/** 内核文案表按枚举索引；接口给的是宽 string，未知值原样显示而不是套一句相近的现成文案 */
function textOf(table: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "未记录";
  return table[key] ?? `${key}（内核没有这条文案：原样显示，不猜它算什么）`;
}

const LOOP_TONE: Record<string, string> = {
  DONE: "text-emerald-300",
  UNFINISHED: "text-amber-300",
  RUN_CLOSED: "text-sky-300",
  RUN_NOT_STARTED: "text-red-300",
  AI_NOT_CONFIGURED: "text-amber-300",
  AI_FAILED: "text-red-300",
  CLIENT_GUARD: "text-amber-300",
  ABORTED: "text-amber-300",
  REQUEST_FAILED: "text-red-300",
};

function newRunId(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 库里回看行 → 与本机那一轮同一种渲染。
 * §三十一 要求「走一步看到的 call」与「回看 timeline」同形，所以这里不另开一套模板；
 * 提示词与模型原文不入库（库里存的是这一步的入参、结果、出处、耗时），那两栏在回看时是空的，页面照实说。
 */
function rowToTurn(c: AgentCallRowClient): AgentLoopTurn {
  return {
    index: c.step ?? 0, prompt: "", prompt_from: "step", raw: "",
    local_kind: "history", local_tool: c.tool ?? "",
    local_note: "回看：这一行读自 agent_tool_call（服务端事实），不是本页内存里的记录；提示词与模型原文不入库，故这两栏为空",
    http: null, call: c,
    observation: {
      kind: c.kind ?? null, data_status: c.data_status ?? null, source: c.source ?? null, as_of: c.as_of ?? null,
      summary: c.summary ?? "", reason: c.error ?? null, notes: c.notes ?? [], degraded_from: c.degraded_from ?? null,
      timed_out: false, payload: null,
    },
    dead_end: null, budget_left: null, next_turn: null, params_effective: null, basis: "", error: null,
  };
}

/** 一步的服务端日志（§十八 的 19 字段：这里把决定「能不能事后重建」的那几样摆在明面上） */
function StepRow({ t }: { t: AgentLoopTurn }) {
  const c = t.call;
  const tone = c?.output_status === "ok" ? "text-emerald-300"
    : c?.output_status === "cached" ? "text-sky-300"
      : c && ["bad_params", "not_supported", "budget", "rejected", "invalid_directive"].includes(c.output_status ?? "") ? "text-red-300" : "text-amber-300";
  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono font-semibold">步 {c?.step ?? t.index}</span>
        <span className="font-mono font-semibold">{c?.tool || "（无工具名）"}</span>
        <span className={`font-mono ${tone}`}>{textOf(LOG_STATUS_TEXT, c?.output_status)}</span>
        {c?.evidence_id ? <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-sky-300">台账 {c.evidence_id}</span>
          : <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">未出台账</span>}
        {c?.cached_from ? <span className="text-sky-300">复用 {c.cached_from}（本次没打上游）</span> : null}
        {c?.fallback_of ? <span className="text-amber-300">这是 {c.fallback_of} 失败后的兜底</span> : null}
        {c?.degraded_from ? <span className="text-amber-300">降级自 {c.degraded_from}</span> : null}
        {t.http !== null ? <span className="text-muted-foreground">HTTP {t.http}</span> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        {c?.data_status ? <SourceBadge status={c.data_status} source={c.source || "出处未记录"} time={c.as_of ? c.as_of.slice(5, 16) : undefined} /> : null}
        {!c?.data_status && t.observation?.kind ? <SourceBadge status="MISSING" source={t.observation.source || "出处未记录"} /> : null}
        <span className="text-muted-foreground">观测：{textOf(OBS_KIND_TEXT, c?.kind ?? t.observation?.kind)}</span>
        <span className="text-muted-foreground">第 {c?.attempt ?? "?"} 次尝试</span>
        <span className="text-muted-foreground">耗时 {c?.latency_ms === null || c?.latency_ms === undefined ? "未记录（没有真的执行）" : `${c.latency_ms}ms`}</span>
        {c?.executor ? <span className="text-muted-foreground">执行器 {c.executor}</span> : null}
      </div>
      {t.observation?.summary ? <div className="mt-1 text-[11.5px] leading-snug">{t.observation.summary}</div> : null}
      {t.observation?.degraded_from ? <div className="mt-0.5 text-[10px] text-amber-300/90">降级自 {t.observation.degraded_from}</div> : null}
      {c?.error ? <div className="mt-1 text-[10.5px] text-red-300">失败原因：{c.error}</div> : null}
      {!!t.observation?.notes?.length && (
        <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">{t.observation.notes.map((n) => <li key={n}>· {n}</li>)}</ul>
      )}
      {t.dead_end ? (
        <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-200">
          碰壁：{t.dead_end.reason} ｜ 可重试={t.dead_end.retryable ? "是" : "否"} ｜ 下一步={t.dead_end.next_action}
          {t.dead_end.has_fallback ? ` ｜ 兜底工具：${t.dead_end.fallback_tools.join("、")}` : " ｜ 这条没有兜底工具"}
          {t.dead_end.user_note ? <div className="mt-0.5">{t.dead_end.user_note}</div> : null}
        </div>
      ) : null}
      {c?.input ? <div className="mt-1 text-[9.5px] text-muted-foreground/90">入参 {JSON.stringify(c.input)}{t.params_effective && Object.keys(t.params_effective).length ? ` ｜ 实际生效 ${JSON.stringify(t.params_effective)}` : ""}</div> : null}
      {c?.refs?.length ? <div className="mt-0.5 text-[9.5px] text-muted-foreground/90">业务主键（点得回数据的那把钥匙）：{c.refs.join("、")}</div> : null}
      {c?.thought ? <div className="mt-1 text-[10px] text-muted-foreground">模型给的理由：{c.thought}</div> : null}
      {c?.capability ? <div className="mt-0.5 text-[9.5px] text-muted-foreground/80">登记能力：{c.capability}</div> : null}
      <div className="mt-1 text-[9.5px] text-muted-foreground/80">{t.basis || t.error || "（回看行：这一步的服务端事实就是上面这些字段；运行依据只在当场驱动那一轮返回）"}</div>
      <div className="mt-1 text-[9.5px] text-sky-300/80">本页：{t.local_note}{t.prompt_from === "final_turn" ? " ｜ 本轮提示词=§十七 受控停止后的「只给结论」轮" : ""}</div>
      {(t.prompt || t.raw) ? (
        <DeskCollapse
          className="mt-1"
          title="这一格喂给模型的原文 + 模型回复原文（一字未改）"
          triggerClassName="text-[9.5px] text-muted-foreground hover:text-foreground"
          contentClassName="text-[9.5px] text-muted-foreground"
        >
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 text-[9.5px] leading-4">{`【发给模型】\n${t.prompt}\n\n【模型原文】\n${t.raw}`}</pre>
        </DeskCollapse>
      ) : null}
      {t.budget_left ? (
        <div className="mt-1 text-[9.5px] text-muted-foreground/80">
          余量：步 {t.budget_left.steps}｜调用 {t.budget_left.tool_calls}｜时长 {Math.round(t.budget_left.ms / 1000)}s｜台账 {t.budget_left.evidence_lines} 行｜该工具重试 {t.budget_left.retries_left} 次
        </div>
      ) : null}
      {t.next_turn && t.next_turn.action === "stop" ? (
        <div className="mt-1 text-[9.5px] text-amber-300/90">内核判定：不再接受新的工具调用（{textOf(AGENT_STOP_REASON_TEXT, t.next_turn.reason)}）</div>
      ) : null}
    </div>
  );
}

/** 台账行（服务端从工具真取到的读数）与血缘行（答案 → 台账 → 工具 → 出处） */
function LedgerRow({ l }: { l: NonNullable<AgentRunViewClient["ledger"]>[number] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono font-semibold">{l.id}</span>
        <span className="text-muted-foreground">{l.layer}</span>
        <SourceBadge status={l.data_status} source={l.source} time={l.as_of ? l.as_of.slice(5, 16) : undefined} />
        <span className="text-muted-foreground">步 {l.step} · {l.tool}</span>
      </div>
      <div className="mt-1 text-[11.5px] leading-snug">{l.text}</div>
      {!!l.refs.length && <div className="mt-0.5 text-[9.5px] text-muted-foreground/80">业务主键：{l.refs.join("、")}</div>}
    </div>
  );
}

function RecentRun({ r, active, onPick }: { r: AgentRunListItemClient; active: boolean; onPick: (id: string) => void }) {
  return (
    <button onClick={() => onPick(r.run_id)}
      title={`${r.question}\n${r.status}｜停止原因 ${r.stop_reason || "未记录"}｜结论 ${r.answer_status || "未收尾"}`}
      className={`w-full rounded-lg border px-2 py-1.5 text-left text-[10px] leading-snug hover:bg-accent ${active ? "border-sky-500/50 bg-sky-500/5" : "border-border/70 bg-card/50"}`}>
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono">{r.run_id}</span>
        <span className={r.status === "finished" ? "text-emerald-300" : "text-amber-300"}>{r.status}</span>
      </div>
      <div className="truncate text-muted-foreground">{r.question || "（没有研究问题）"}</div>
      <div className="text-muted-foreground/80">
        步 {r.steps}｜调用 {r.tool_calls}｜台账 {r.evidence_lines}｜缺 {r.missing_lines}｜{r.answer_status || "未收尾"}｜{r.started_at.slice(5, 16)}
      </div>
    </button>
  );
}

export default function AgentPage() {
  const ai = useDesk((s) => s.ai);
  const [runId, setRunId] = useState(newRunId);
  const [question, setQuestion] = useState("");
  const [budgetSteps, setBudgetSteps] = useState("");
  const [budgetCalls, setBudgetCalls] = useState("");
  const [budgetMs, setBudgetMs] = useState("");
  const [running, setRunning] = useState(false);
  const [turns, setTurns] = useState<AgentLoopTurn[]>([]);
  const [run, setRun] = useState<AgentLoopResult | null>(null);
  const [view, setView] = useState<AgentRunViewClient | null>(null);
  const [viewId, setViewId] = useState("");
  const [list, setList] = useState<AgentRunListItemClient[]>([]);
  const [tools, setTools] = useState<AgentToolsCatalogClient | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);

  const loadView = useCallback(async (id: string) => {
    setBusy(true);
    try {
      setView(await fetchAgentRunView(id)); setViewId(id); setErr("");
    } catch (e) { setErr(String((e as Error).message || e)); setView(null); }
    finally { setBusy(false); }
  }, []);

  const loadList = useCallback(async () => {
    try { setList((await fetchAgentRunList()).runs ?? []); }
    catch (e) { setErr(String((e as Error).message || e)); }
  }, []);

  const loadTools = useCallback(async () => {
    try { setTools(await fetchAgentTools()); }
    catch (e) { setErr(String((e as Error).message || e)); }
  }, []);

  useEffect(() => { void loadList(); void loadTools(); }, [loadList, loadTools]);

  const budget: Record<string, number> = {};
  if (budgetSteps.trim()) budget.max_steps = Number(budgetSteps);
  if (budgetCalls.trim()) budget.max_tool_calls = Number(budgetCalls);
  if (budgetMs.trim()) budget.max_total_ms = Number(budgetMs);

  const start = async () => {
    if (running) return;
    stopRef.current = false; setRunning(true); setTurns([]); setRun(null); setErr("");
    try {
      const r = await runAgentLoop(ai, {
        run_id: runId.trim(), question: question.trim(),
        budget: Object.keys(budget).length ? budget : undefined,
        onTurn: (t) => setTurns((prev) => [...prev, t]),
        shouldStop: () => stopRef.current,
      });
      setRun(r);
      if (r.run_id) await loadView(r.run_id);
      await loadList();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setRunning(false);
    }
  };

  const call = (t: AgentLoopTurn): AgentCallRowClient | null => t.call ?? null;
  const toolCalls = turns.filter((t) => !!call(t));
  const viewLedger = view?.ledger ?? [];
  const viewLineage = view?.lineage ?? [];
  // P7-⑩：门换成 aiReady —— 浏览器没填凭据但服务端 .env 通道可用时，循环照跑（凭据在服务端）。
  const aiReady = aiChannelReady(ai);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Bot size={18} className="text-sky-400" /> Agent 自主研究（只读）</div>
          <div className="text-[11px] leading-snug text-muted-foreground">
            模型每轮只选一条工具，服务端真的去取数并逐条记账，再把观测喂回下一轮<br />
            协议：回复文本里的一个 JSON（无原生 function-calling，凭据只在浏览器）；这一格一格由本机浏览器驱动，关掉页面就停在那里，已记账的步不会丢<br />
            模型自称调用过不算数：<b className="text-foreground">只有下面这些库里读回来的行算数</b>；本层不下单、不改策略、不写任何业务表
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view && (
            <SourceBadge
              status={!aiReady ? "AI_NOT_CONFIGURED 缺失" : "AI_INTERPRETATION"}
              source={!aiReady ? "无可用模型通道（浏览器未配置且服务端 .env 通道不可用）：循环跑不了（读数与工具目录不受影响）" : `agent_run ${view.run_id} · ${view.status}`}
              time={view.started_at?.slice(5, 16)}
            />
          )}
          <button onClick={() => { void loadList(); void loadTools(); if (viewId) void loadView(viewId); }} disabled={busy}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>
      </div>

      {/* ① 研究问题 + 预算收紧（留空=服务端默认；超硬上限会被钳并说明，这里不假装能突破） */}
      <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <input value={runId} onChange={(e) => setRunId(e.target.value.slice(0, 64))}
            title="同一步要挂在同一次运行上；同一个 id 再点一次是续跑（库里已有记录不清空、不重打上游）"
            className="w-[220px] rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-sky-500" />
          <input value={question} onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
            placeholder="研究问题：例：已验证因子账本里有没有能直接引用的条目？半导体板块今天涨得最多的那只靠什么？"
            className="min-w-[260px] flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-sky-500" />
          {running
            ? <button onClick={() => { stopRef.current = true; }}
              className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
              <Square size={12} /> 停止
            </button>
            : <button onClick={() => void start()} disabled={!question.trim() || !aiReady}
              title={!aiReady ? "AI 未配置：这一步要么由本机浏览器带着凭据去问模型，要么服务端 .env 通道可用" : "开一次运行并逐格驱动到收尾（会写 agent_run / agent_tool_call 两张表）"}
              className="flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40">
              <Bot size={12} /> 运行研究循环
            </button>}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>预算收紧（留空=服务端默认；超硬上限会被钳到上限并写进「预算说明」，这里不假装能突破）：</span>
          <label className="flex items-center gap-1">步数
            <input value={budgetSteps} onChange={(e) => setBudgetSteps(e.target.value.replace(/\D/g, "").slice(0, 7))}
              className="w-14 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none focus:border-sky-500" />
          </label>
          <label className="flex items-center gap-1">调用
            <input value={budgetCalls} onChange={(e) => setBudgetCalls(e.target.value.replace(/\D/g, "").slice(0, 7))}
              className="w-14 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none focus:border-sky-500" />
          </label>
          <label className="flex items-center gap-1">总时长ms
            <input value={budgetMs} onChange={(e) => setBudgetMs(e.target.value.replace(/\D/g, "").slice(0, 7))}
              className="w-16 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none focus:border-sky-500" />
          </label>
          <span>本机保险 {CLIENT_TURN_GUARD} 格（内核硬上限步数 + 3）· 到点自己停住并照实标 CLIENT_GUARD</span>
        </div>
        {!aiReady && (
          <div className="mt-1.5 text-[10.5px] text-amber-300">
            没有可用的模型通道（AI_NOT_CONFIGURED）：工具目录、历史运行与每条血缘照常可查，缺的是「问模型选哪条工具」这一步——到设置页填 Base URL / 模型 / Key，或在服务端 .env 配一条可用通道。服务端不会替你跑一轮假的。
          </div>
        )}
        {!question.trim() && aiReady && !running && (
          <div className="mt-1.5 text-[10.5px] text-muted-foreground">
            问题为空时按钮不可点：没有研究问题的自主循环没有目标（服务端会把它记成缺失口径，本页不替模型编一个问题）。
          </div>
        )}
      </div>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</div>}

      {run && (
        <div className={`rounded-lg border border-border bg-card/60 px-3 py-2 text-xs ${LOOP_TONE[run.status as AgentLoopStatus] ?? "text-muted-foreground"}`}>
          <div className="font-semibold">{run.status} · {AGENT_LOOP_STATUS_TEXT[run.status as AgentLoopStatus]}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{run.message}</div>
          <div className="mt-1 text-[10px] text-muted-foreground/90">
            run_id {run.run_id}｜模型 {run.model}｜本机格数 {run.turns.length}（其中带服务端日志 {run.turns.filter((t) => !!t.call).length} 步）
            ｜停止原因 {run.stop_reason ? textOf(AGENT_STOP_REASON_TEXT, run.stop_reason) : "本轮未触发内核停止条件"}
          </div>
          {!!run.notes.length && <ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground/90">{run.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {/* ② 结论（排在调用记录之后：先看跑了什么，再看它说了什么） */}
          {view && (view.answer_text || view.answer_status) ? (
            <div className="rounded-xl border border-fuchsia-500/25 bg-card/50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-sm font-semibold ${view.answer_status === "ACCEPTED" ? "text-emerald-300" : view.answer_status === "PARTIAL" ? "text-amber-300" : "text-red-300"}`}>
                  {view.answer_status || "未收尾"}
                </span>
                <SourceBadge status="AI_INTERPRETATION" source={`模型 ${view.model || "未记录"}`} time={view.finished_at?.slice(5, 16)} />
                <span className="text-[10px] text-muted-foreground">服务端按库内调用行复校验的判定，不是市场结论；这段原文没有被改写</span>
              </div>
              <div className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed">{view.answer_text || "（库里这条结论是空文本）"}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                {(view.answer_cites ?? []).length
                  ? view.answer_cites!.map((c) => (
                    <span key={c} className={`rounded border px-1.5 py-0.5 font-mono ${view.answer_cites_missing?.includes(c) ? "border-red-500/40 text-red-300" : "border-sky-500/30 bg-sky-500/10 text-sky-300"}`}>
                      {c}{view.answer_cites_missing?.includes(c) ? " 台账里没有" : ""}
                    </span>
                  ))
                  : <span className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300">没有引用任何台账行：整段不可回溯</span>}
              </div>
              {!!(view.violations ?? []).length && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[10.5px] text-amber-200">
                  服务端核对结果（逐条留痕，原文没有被静默删除）：
                  <ul className="mt-0.5 list-disc pl-4">{view.violations!.map((v) => <li key={v}>{v}</li>)}</ul>
                </div>
              )}
              {(view.answer_gaps ?? []).length > 0 && (
                <div className="mt-1.5 text-[10.5px] text-muted-foreground">模型自报缺口：{view.answer_gaps!.join("；")}</div>
              )}
              {(view.unused_evidence ?? []).length > 0 && (
                <div className="mt-1 text-[10px] text-muted-foreground">已取到但没被引用的台账行：{view.unused_evidence!.join("、")}（取到不等于用上）</div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
              {view ? `这次运行（${view.run_id}）还没有结论：库里状态 ${view.status}。${view.stop_reason ? `停止原因：${textOf(AGENT_STOP_REASON_TEXT, view.stop_reason)}。` : ""}没收尾就是没收尾，本页不会显示一条编出来的答案。`
                : "还没有选中任何一次运行：填好问题点「运行研究循环」，或在右边列表点一条回看。"}
            </div>
          )}

          {/* ③ 步骤时间线 */}
          <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[11px] font-semibold">步骤时间线（{view ? `${view.timeline?.length ?? 0} 条库内记录` : `${toolCalls.length} 步`}）</div>
              <span className="text-[9.5px] text-muted-foreground">跑动中显示本机这一轮；选中回看时显示库里全部行（同一份字段，接口同一映射）</span>
              {view?.budget_left && (
                <span className="text-[9.5px] text-muted-foreground">
                  余量：步 {view.budget_left.steps}｜调用 {view.budget_left.tool_calls}｜时长 {Math.round(view.budget_left.ms / 1000)}s｜台账 {view.budget_left.evidence_lines}
                </span>
              )}
            </div>
            <div className="mt-1.5 space-y-1.5">
              {(view && !running && viewId
                ? (view.timeline ?? []).map((c, i) => <StepRow key={`${c.step ?? "n"}-${i}-${c.tool ?? ""}`} t={rowToTurn(c)} />)
                : turns.map((t) => <StepRow key={`${t.index}-${t.call?.step ?? "n"}-${t.call?.tool ?? ""}`} t={t} />))}
              {((view && !running ? view.timeline?.length ?? 0 : turns.length) === 0) && (
                <div className="text-[10.5px] text-muted-foreground">
                  {running ? "第一步还在路上：模型正在选工具（这一格没到服务端就没有行）…"
                    : view ? "这次运行 0 条调用记录：没有向服务端请求过任何工具。被预算/参数挡下的请求照样会留一行，所以「0 行」就是真的一次都没请求过。"
                    : "还没有调用记录。"}
                </div>
              )}
            </div>
            {view?.rebuild_check && (
              <div className={`mt-1.5 text-[9.5px] ${view.rebuild_check.consistent ? "text-muted-foreground/80" : "text-red-300"}`}>
                事后重建核对：库里 {view.rebuild_check.rows} 行 → 重算步数 {view.rebuild_check.rebuilt.steps}／调用 {view.rebuild_check.rebuilt.tool_calls}／台账 {view.rebuild_check.rebuilt.evidence_lines}
                ｜{view.rebuild_check.consistent ? "与 agent_run 记的计数一致（结论可以从行里重算出来，不靠内存）" : "与记的计数不一致：以调用行为准并标出来，不静默改库"}
                {!!view.rebuild_check.unknown_layer_rows?.length && ` ｜ 分层值不认识的行 ${view.rebuild_check.unknown_layer_rows.length} 条（原样显示）`}
              </div>
            )}
          </div>

          {/* ④ 台账 + 血缘 */}
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
              <div className="text-[11px] font-semibold">台账（{viewLedger.length} 行，服务端真取到的读数）</div>
              <div className="mt-1.5 space-y-1.5">
                {viewLedger.length ? viewLedger.map((l) => <LedgerRow key={l.id} l={l} />)
                  : <div className="text-[10.5px] text-muted-foreground">没有台账行：这次运行还没有取到任何可读的数（被挡下的调用会留行但不出台账）。</div>}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
              <div className="text-[11px] font-semibold">血缘：结论 → 台账 → 工具 → 出处（{viewLineage.length} 条）</div>
              <div className="mt-1.5 space-y-1.5">
                {viewLineage.length ? viewLineage.map((l) => (
                  <div key={`${l.evidence_id}-${l.call_key}`} className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-[10px] leading-snug">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-accent px-1.5 py-0.5 font-mono font-semibold">{l.evidence_id}</span>
                      <span className="font-mono">{l.tool}</span>
                      <span className="text-muted-foreground">步 {l.step}</span>
                      <SourceBadge status={l.data_status ?? "未分层"} source={l.source} time={l.as_of ? l.as_of.slice(5, 16) : undefined} />
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      分层 {textOf(DATA_STATUS_TABLE, l.data_status_raw)}
                      {l.executor ? ` · 执行器 ${l.executor}` : " · 无执行器（没有真的执行）"} · 调用键 {l.call_key || "未记录"}
                    </div>
                    {!!l.refs.length && <div className="mt-0.5 text-muted-foreground/80">回到数据：{l.refs.join("、")}</div>}
                  </div>
                )) : <div className="text-[10.5px] text-muted-foreground">
                  {view?.answer_status ? "这次收尾没有可用引用：结论里的每一句都回不到取数行（上面已逐条点名）。" : "还没有收尾结论，也就没有「结论 → 出处」这一段；台账行仍然列在左边。"}
                </div>}
              </div>
            </div>
          </div>

          {/* ⑤ 缺失与预算说明：内核报的缺口原样列，不合并成「一切正常」 */}
          <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
            <div className="text-[11px] font-semibold">缺失口径（{(view?.missing ?? []).length} 条）· 预算说明（{(view?.budget_notes ?? []).length} 条）</div>
            {view?.missing?.length ? <ul className="mt-1 space-y-1 text-[10px] leading-snug text-muted-foreground">{view.missing.map((m) => <li key={m} className="list-disc pl-3">{m}</li>)}</ul>
              : <div className="mt-1 text-[10px] text-muted-foreground">这批没有登记缺口（不等于市场没有风险：只是这次没取到缺失自报）。</div>}
            {view?.budget_notes?.length ? <ul className="mt-1 space-y-1 text-[10px] leading-snug text-amber-300/90">{view.budget_notes.map((n) => <li key={n}>· {n}</li>)}</ul> : null}
            {view && (
              <div className="mt-1.5 text-[9.5px] leading-snug text-muted-foreground/80">
                <div>{view.basis}</div>
                <div className="mt-0.5">协议 {view.protocol}｜提示词 {view.prompt_version}｜开始 {view.started_at}｜结束 {view.finished_at || "未收尾"}｜用时 {view.elapsed_ms ?? 0}ms</div>
                <div className="mt-0.5">分层含义：{Object.entries(DATA_STATUS_TABLE).map(([k, v]) => `${k}=${v}`).join("；")}</div>
              </div>
            )}
          </div>
        </div>

        {/* ⑥ 侧栏：工具目录 / 历史运行 / 协议原文 */}
        <div className="space-y-2">
          <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
            <div className="text-[11px] font-semibold">工具目录（{tools ? `${tools.enabled} 可调用 / ${tools.total} 登记，禁用 ${tools.disabled}` : "读取中…"}）</div>
            <div className="mt-0.5 text-[9.5px] leading-snug text-amber-300/90">
              模型能选的只有这张表；表里没有的工具不存在。禁用项留着是为了说清「为什么不能选」，不是等它自己变可用。
            </div>
            {tools?.self_check && (tools.self_check.unimplemented_executors.length > 0 || tools.self_check.read_only_violations.length > 0) && (
              <div className="mt-1 rounded border border-red-500/30 bg-red-500/5 px-2 py-1 text-[9.5px] text-red-300">
                自检点名：假能力 {tools.self_check.unimplemented_executors.join("、") || "无"}｜越界（会写/会下单）{tools.self_check.read_only_violations.join("、") || "无"}
              </div>
            )}
            <div className="mt-1.5 max-h-[420px] space-y-1 overflow-auto pr-1">
              {(tools?.tools ?? []).map((t) => (
                <div key={t.name} className={`rounded-lg border px-2 py-1.5 text-[10px] leading-snug ${t.enabled ? "border-border/70 bg-card/60" : "border-amber-500/25 bg-amber-500/5"}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono font-semibold">{t.name}</span>
                    <span className="text-muted-foreground">{t.title}</span>
                    <span className={t.enabled ? "text-emerald-300" : "text-amber-300"}>{t.enabled ? "可调用" : "禁用"}</span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground">{t.description}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <SourceBadge status={t.data_status} source={t.source} />
                    <span className="text-muted-foreground">能力 {t.capability}</span>
                    {t.timeout_ms ? <span className="text-muted-foreground">超时 {t.timeout_ms}ms</span> : null}
                  </div>
                  <div className="mt-0.5 text-muted-foreground/80">入参：{t.input_note || "无参数"}</div>
                  {t.disabled_reason ? <div className="mt-0.5 text-amber-300">{t.disabled_reason}</div> : null}
                  {!!t.limitations.length && <div className="mt-0.5 text-muted-foreground/80">限制：{t.limitations.join("；")}</div>}
                  {!!t.fallbacks.length && <div className="mt-0.5 text-muted-foreground/80">兜底：{t.fallbacks.join("、")}</div>}
                </div>
              ))}
              {!tools && <div className="text-[10px] text-muted-foreground">正在读取 /api/agent/tools…</div>}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
            <div className="text-[11px] font-semibold">历史运行（库内 {list.length} 次，按开始时间倒序）</div>
            <div className="mt-0.5 text-[9.5px] text-muted-foreground">这些行是真事：模型自称跑过而没有落库的，这里不会有</div>
            <div className="mt-1.5 space-y-1.5">
              {list.length ? list.map((r) => <RecentRun key={r.run_id} r={r} active={r.run_id === viewId} onPick={(id) => { setRunId(id); void loadView(id); }} />)
                : <div className="text-[10px] text-muted-foreground">agent_run 当前 0 行：还没有人带着真实模型回复跑完一轮（不是失败，也不是「自动跑过」）。</div>}
            </div>
          </div>

          <DeskCollapse
            title="状态与停止原因的口径（本页所有文案都来自内核同一份）"
            triggerClassName="text-[11px] font-semibold text-foreground hover:text-foreground"
            contentClassName="text-[10px] text-muted-foreground"
          >
            <div className="space-y-1">
              <div><b className="text-foreground">观测口径（为什么不是「0 就是没有风险」）</b></div>
              {Object.entries(OBS_KIND_TEXT).map(([k, v]) => <div key={k}><span className="font-mono">{k}</span>：{v}</div>)}
              <div className="mt-1"><b className="text-foreground">调用行状态（§十八）</b></div>
              {Object.entries(LOG_STATUS_TEXT).map(([k, v]) => <div key={k}><span className="font-mono">{k}</span>：{v}</div>)}
              <div className="mt-1"><b className="text-foreground">内核停止原因（8 项，与本页那 9 项循环状态是两套）</b></div>
              {Object.entries(AGENT_STOP_REASON_TEXT).map(([k, v]) => <div key={k}><span className="font-mono">{k}</span>：{v}</div>)}
            </div>
          </DeskCollapse>

          <DeskCollapse
            title="本轮系统提示词原文（服务端给模型的，前端不另写一份）"
            triggerClassName="text-[11px] font-semibold text-foreground hover:text-foreground"
            contentClassName="text-[9.5px] leading-snug text-muted-foreground"
          >
            <div>{run?.start?.prompt.system
              ? "下面这份就是本次运行真正发给模型的 system（含工具目录全文），取自 /api/agent/run 的返回值原文："
              : view ? `这次回看的运行（${view.run_id}）当时确实发过一份 system，但提示词原文不入库（库里只存调用行）：下面是内核同一份协议骨架，不含工具目录，所以它不等于当时那一份。`
                : `还没跑过本轮：下面是系统提示词的协议骨架（不含工具目录）。真正的 system 由服务端在 /api/agent/run 里现拼，本页不另写一份。`}</div>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 text-[9.5px]">{run?.start?.prompt.system ?? AGENT_SYSTEM_PROMPT}</pre>
          </DeskCollapse>
        </div>
      </div>
    </div>
  );
}
