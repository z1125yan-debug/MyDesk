// POST /api/agent/tool — Agent 走一步：请求执行某个工具，服务端判准入 + 真取数 + 记账（P6-D）
//
// 请求 { run_id, tool, args?, thought?, timeout_ms? }
// 返回 { ok, admitted, call, observation, dead_end, budget_left, next_turn, prompt, summary, basis }
//
// 三条硬口径（都在这一个入口上落地）：
// 1) 能不能调由内核 admitCall 判（注册表→开关→已停止→参数→同参数缓存→步/调用/时长/台账预算→重试上限），
//    被挡下的请求照样写一条 agent_tool_call 行：§十八 要答得出「刚才请求了什么、为什么没跑」；
// 2) 取数失败 ≠ 没有数据 ≠ 该能力不存在：三种情况分别写 failed / empty / not_supported，
//    页面与提示词只能照日志说，不许压成「今天没有行情」；
// 3) 本层不自动调模型、不自己决定下一步：模型的下一条指令由客户端发来，这里只负责执行与记账。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiStamp } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { runAgentStep, type AgentStepResult } from "@/lib/quant/screener/agent-run";
import { budgetRemaining, startRun } from "@/lib/quant/screener/agent-loop-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const EMPTY_LEFT = budgetRemaining(startRun({ run_id: "", question: "", started_at: "", started_ms: 0 }).state, 0);

export async function POST(req: Request) {
  quantBootstrap();
  const body = (await req.json().catch(() => null)) as {
    run_id?: unknown; tool?: unknown; args?: unknown; thought?: unknown; timeout_ms?: unknown;
  } | null;
  // 参数阶段的返回与成功同形（§三十一：错误结构稳定，页面不为 400 单写一套渲染）
  const rejected = (error: string): AgentStepResult => ({
    ok: false, error, http: 400, run_id: String(body?.run_id ?? ""), admitted: false, call: {}, params_effective: {},
    observation: { kind: null, data_status: null, source: null, as_of: null, summary: "", reason: error, notes: [], degraded_from: null, timed_out: false, payload: null },
    dead_end: null, budget_left: EMPTY_LEFT, evidence_lines: 0, missing: [error],
    next_turn: { action: "stop", reason: "not_run", detail: error }, prompt: null, summary: {},
    basis: "参数校验未通过：没有打上游、没有记账（本层不会替模型决定要调哪个工具）",
  });
  if (!body) return NextResponse.json(rejected("请求体不是合法 JSON：工具调用必须带明确的 run_id 与 tool"), { status: 400 });
  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!tool.trim()) return NextResponse.json(rejected("缺少 tool：本层不会猜模型想调哪条工具（猜出来的调用等于伪造一次工具调用）"), { status: 400 });

  // timeout_ms 只允许收紧：填 0/负数/超大都不接受，回落成「按该工具登记的默认超时」并说明
  let timeoutMs: number | undefined;
  let timeoutNote = "";
  if (body.timeout_ms !== undefined && body.timeout_ms !== null && body.timeout_ms !== "") {
    const n = Number(body.timeout_ms);
    if (Number.isInteger(n) && n > 0 && n <= 120_000) timeoutMs = n;
    else timeoutNote = `请求的 timeout_ms「${String(body.timeout_ms)}」不是 1..120000 的整数，已改用该工具登记的默认超时`;
  }

  try {
    const now = shanghaiStamp();
    const r = await runAgentStep({
      run_id: body.run_id, tool, args: body.args ?? {}, thought: typeof body.thought === "string" ? body.thought : "", timeout_ms: timeoutMs,
    }, db, { now, now_ms: Date.now() });
    if (timeoutNote) r.basis = `${r.basis}（${timeoutNote}）`;
    // 状态码由服务层给（见 AgentHttp 注释）：本层不再用正则猜中文错误。
    // 「取数失败/没有数据/该能力不存在」都是 200：它们这一步真的记了账，是这次运行的真实结果，不是接口出错。
    return NextResponse.json(r, { status: r.http });
  } catch (e) {
    return NextResponse.json(rejected(`工具执行失败：${(e as Error).message}（这一步没有记账，页面会显示为「未记录」而不是「结果为空」）`), { status: 502 });
  }
}
