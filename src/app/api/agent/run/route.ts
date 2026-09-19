// POST /api/agent/run — 开一次研究运行（P6-D）；GET /api/agent/run — 回看这次运行跑过什么。
//
// POST { run_id, question, budget?, model? }
// - 幂等：同一个 run_id 再提交 ⇒ resumed:true，库里已有的调用行一条都不动、也不重打上游。
//   这不是省事：页面刷新/网络重试如果重建一次运行，「刚才调用了什么」就答不出来了（§十八）。
// - 返回的 prompt.turn 是下一轮喂给模型的文本（含预算余量、已调用记录、台账、缺口）。
//   模型由客户端调（AI 凭据只在客户端），服务端不代发请求。
//
// GET ?run_id=xxx        → 时间线 + 台账 + 血缘 + 预算余量 + 停止原因 + 答案与违规项
// GET（不带 run_id）      → 最近若干次运行的摘要列表
// 找不到 run_id ⇒ ok:false + 404：它和「跑过但一条读数都没取到」是两件事，后者会有行并带停止原因。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiStamp } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { agentRunView, listAgentRuns, startAgentRun, type AgentStartResult } from "@/lib/quant/screener/agent-run";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function clock() {
  const now = shanghaiStamp();
  return { now, now_ms: Date.now() };
}

export async function POST(req: Request) {
  quantBootstrap();
  const body = (await req.json().catch(() => null)) as {
    run_id?: unknown; question?: unknown; budget?: unknown; model?: unknown;
  } | null;
  const rejected = (error: string): AgentStartResult => ({
    ok: false, error, http: 400, run_id: String(body?.run_id ?? ""), resumed: false, status: "", question: "",
    budget: null, budget_notes: [], missing: [error],
    prompt: { system: "", turn: "", protocol: "p6d.agent.v1" },
    next_turn: { action: "stop", reason: "not_run", detail: error }, summary: {},
    basis: "参数校验未通过：没有建账（这一层不会替模型编一个研究问题，也不会开一条空运行冒充在跑）",
  });
  if (!body) return NextResponse.json(rejected("请求体不是合法 JSON：Agent 的每一步都要挂在明确的 run_id 上，不能靠猜"), { status: 400 });
  try {
    const r = await startAgentRun({
      run_id: body.run_id, question: body.question, budget: body.budget,
      model: typeof body.model === "string" ? body.model : undefined,
    }, db, clock());
    return NextResponse.json(r, { status: r.http });
  } catch (e) {
    // 库里读写异常：http 字段与真实状态码保持一致（页面只看 body 时也不会读到「400」而实际回了 502）
    return NextResponse.json({ ...rejected(`建账失败：${(e as Error).message}（未写库）`), http: 502 }, { status: 502 });
  }
}

export async function GET(req: Request) {
  quantBootstrap();
  const sp = new URL(req.url).searchParams;
  const runId = (sp.get("run_id") ?? "").trim();
  try {
    if (!runId) {
      const take = Math.max(1, Math.min(100, Number(sp.get("take") ?? 20) || 20));
      return NextResponse.json({
        ok: true, error: null, http: 200, mode: "list", runs: await listAgentRuns(db, take), take,
        basis: `库里最近 ${take} 次 Agent 运行的摘要（按开始时间倒序）。明细请带 run_id 再查一次。`,
      });
    }
    const view = await agentRunView(runId, db, clock());
    return NextResponse.json({ ...view, mode: "run" }, { status: view.http });
  } catch (e) {
    return NextResponse.json({
      ok: false, error: `运行回看失败：${(e as Error).message}`, http: 502, run_id: runId, mode: runId ? "run" : "list", runs: [],
      basis: "本次没有读到库：错误结构与成功时同名，页面按 error 原文显示",
    }, { status: 502 });
  }
}
