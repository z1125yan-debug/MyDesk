// POST /api/agent/finalize — Agent 收尾：把模型这一轮的回复交给服务端复校验并落库（P6-D）
//
// 请求 { run_id, raw, model? }
//   raw = 模型这一轮的**原文**（不是前端解析后的字段）。服务端自己 parseAgentDirective，
//   所以前端「改一下 answer 再提交」不起作用：答案文本、引用行、判定结论全部以服务端解析为准。
//
// 为什么这一步必须在服务端判（§十九/§三十二 变成代码的地方）：
// - 结论的每一条引用都要命中这次运行真实产生的台账行 ⇒ 引用不存在的行 = AI 发明了出处，逐条留档；
// - 答案里带单位的市场数字必须能在这次的台账里找到出处 ⇒ 找不到就标注（原文不删，读者看得见）；
// - 「过去 N 个样本胜率 X%」写成「所以今天上涨概率 X%」这一类历史≠当前的措辞会被点名；
// - 概率类数字还要求引用带 trade_date/sample/horizon 三个口径字段，缺一个就不成立；
// - 判定为 REJECTED 时不覆盖这次运行已经成立的 ACCEPTED/PARTIAL 结论（与 P6-C 同一条护栏）。
//
// 本接口不会自动调模型、也不会自动决定「该收尾了」：那需要凭据与服务端调度，属于未实现范围（见 worklog）。
// 状态码来自服务层的 r.http（见 agent-run.ts 的 AgentHttp 注释），本层不再用正则猜中文错误。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiStamp } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { finalizeAgentRun, type AgentFinalizeResult } from "@/lib/quant/screener/agent-run";
import { MAX_RAW_CHARS } from "@/lib/quant/screener/research-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  quantBootstrap();
  const body = (await req.json().catch(() => null)) as { run_id?: unknown; raw?: unknown; model?: unknown } | null;
  // 参数阶段与成功阶段同形（§三十一：错误结构稳定），页面不必为 400 单写一套渲染
  const rejected = (error: string): AgentFinalizeResult => ({
    ok: false, error, http: 400, persisted: false, run_id: String(body?.run_id ?? ""),
    directive: null, check: null, summary: {}, missing: [error],
    basis: "参数校验未通过：没有读库、没有落库（这一层不会替模型写一份结论再判它成立）",
  });
  if (!body) return NextResponse.json(rejected("请求体不是合法 JSON：收尾必须挂在明确的 run_id 上"), { status: 400 });
  const raw = typeof body.raw === "string" ? body.raw : "";
  if (!raw.trim()) {
    return NextResponse.json(rejected("缺少 raw：本次没有可校验的模型回复，未落库（服务端不会替你生成一份结论再判它成立）"), { status: 400 });
  }
  if (raw.length > MAX_RAW_CHARS) {
    return NextResponse.json(rejected(`模型原文长度 ${raw.length} 超过 ${MAX_RAW_CHARS} 字符上限：拒绝入库（防止把整段无关对话塞进 Agent 运行表）`), { status: 400 });
  }
  try {
    const now = shanghaiStamp();
    const r = await finalizeAgentRun({
      run_id: body.run_id, raw,
      model: typeof body.model === "string" ? body.model : undefined,
    }, db, { now, now_ms: Date.now() });
    return NextResponse.json(r, { status: r.http });
  } catch (e) {
    return NextResponse.json(
      { ...rejected(`收尾落库失败：${(e as Error).message}（未写库，也不会出现半份结论）`), http: 502 },
      { status: 502 },
    );
  }
}
