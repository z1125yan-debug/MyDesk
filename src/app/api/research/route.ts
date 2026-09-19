// /api/research — 市场环境研究报告的读取与落库（P6-C）
//
// GET  ?date=YYYY-MM-DD&scope=market   只读回看已落库的报告（含生成当时冻结的台账与采集器观测）
// POST { raw, question?, model?, scope? }
//      raw = 模型原文（字符串）。服务端**重新现取一次台账**做复校验，再落库。
//
// 为什么必须服务端复校验（§十三/§十四/§二十二 变成代码的地方）：
// - 解释的每一条判断都要引用台账行 id，id 不存在就是 AI 发明了证据 ⇒ 剔除并留档，该条标为不可回溯；
// - 解释里带百分号/亿/涨幅动词的数字必须能在台账里找到出处 ⇒ 找不到就逐条标注（原文不删，读者看得见）；
// - 概率与涨幅预测在落库前剥掉并把原话存进 dropped.probability_claims（复用 P6-B 那一套剥离）；
// - 「过去 713 个样本胜率 51.75%」写成「所以今天上涨概率 51.75%」这一类历史≠当前的措辞被抓出来并降级；
// - 台账不接受客户端传来的事实字段：前端改了 FACTS 行没有任何作用，报告里存的引用原文由服务端回填。
//
// 本接口不会自动调模型、也不会自动定时生成报告：那需要凭据与服务端调度，属于未实现范围（见 worklog）。
import { NextResponse } from "next/server";
import { shanghaiDate } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import {
  loadResearchReport, storeResearchReport,
  type ResearchLoadResult, type ResearchStoreResult,
} from "@/lib/quant/screener/research";
import {
  MAX_RAW_CHARS, RESEARCH_NOT_RUN_STATUSES, researchDateError, researchScopeErrorText, researchScopeOf,
} from "@/lib/quant/screener/research-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  // POST 路径要重新现取一次台账（同样要调引擎），引导放在两个入口里做，不依赖调用顺序
  quantBootstrap();
  const sp = new URL(req.url).searchParams;
  const scopeRaw = sp.get("scope");
  // 读取失败/参数非法时返回同一组字段（§三十一：错误结构稳定），页面不必为错误分支单写一套渲染。
  // 显式标注 ResearchLoadResult：骨架一旦少写一个键，编译期就报错，而不是等到前端 undefined。
  const loadError = (error: string): ResearchLoadResult => ({
    // as_of 只放服务端真实的时间口径：参数非法时它是 ""，不会把「用户传进来的那个串」冒充成一次取数时间。
    ok: false, as_of: "", today: shanghaiDate(), scope: "market" as const,
    report: null, evidence: [], sources: [], missing: [error], available_dates: [],
    counts: { rows: 0, interpreted: 0, partial: 0, rejected: 0 },
    layering: "本次没有读到任何报告：错误结构保持与成功时一致，页面按 missing 原文显示原因",
    self_check: { broken_payload: [] }, basis: "未读库：参数校验未通过", probed_at: "", error,
  });
  if (scopeRaw !== null && !researchScopeOf(scopeRaw)) {
    return NextResponse.json(loadError(researchScopeErrorText(scopeRaw)), { status: 400 });
  }
  // 非法日期必须在读库之前挡掉：放到后面就只能得到「那天没有报告」，那是把参数错误说成空数据。
  // 只校验传进来的那个值：没传（null/空串）由服务层回落到当天，属于合法路径。
  const dateErr = researchDateError(sp.get("date"));
  if (dateErr) {
    return NextResponse.json(loadError(dateErr), { status: 400 });
  }
  try {
    const r = await loadResearchReport({ date: sp.get("date") ?? undefined, scope: scopeRaw });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json(
      loadError(`研究报告读取失败：${(e as Error).message}`),
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  quantBootstrap();
  const body = (await req.json().catch(() => null)) as {
    raw?: unknown; question?: unknown; model?: unknown; scope?: unknown;
  } | null;

  // 参数校验阶段的返回与成功阶段用同一组字段（§三十一：错误结构稳定），前端不需要为 400/413 单写一套渲染。
  // 类型标注成「成功结果 + report_status」：字段漂移会在编译期暴露，而不是在前端显示成 undefined。
  const rejected = (error: string, status: string): ResearchStoreResult & { report_status: string } => ({
    ok: false, persisted: false, scope: researchScopeOf(body?.scope === undefined || body?.scope === null ? null : String(body.scope)) ?? "market",
    date: shanghaiDate(), report_key: "", report: null, evidence_total: 0, missing: [error], sources: [],
    error, report_status: status,
    basis: "参数校验未通过：未取台账、未写库（这一层不会替模型生成一份市场环境报告）",
  });

  const raw = typeof body?.raw === "string" ? body.raw : "";
  if (!raw.trim()) {
    return NextResponse.json(rejected(
      "缺少 raw：本次没有可校验的模型原文，未落库（服务端不会替你生成一份市场环境报告）",
      RESEARCH_NOT_RUN_STATUSES.ai_failed,
    ), { status: 400 });
  }
  if (raw.length > MAX_RAW_CHARS) {
    return NextResponse.json(rejected(
      `模型原文长度 ${raw.length} 超过 ${MAX_RAW_CHARS} 字符上限：拒绝入库（防止把整段无关对话塞进研究报告表）`,
      RESEARCH_NOT_RUN_STATUSES.ai_failed,
    ), { status: 413 });
  }
  const scopeRaw = body?.scope === undefined || body?.scope === null ? null : String(body.scope);
  if (!researchScopeOf(scopeRaw)) {
    return NextResponse.json({ ...rejected(researchScopeErrorText(scopeRaw), "BAD_PARAM"), scope: "market" }, { status: 400 });
  }
  try {
    const r = await storeResearchReport({
      raw,
      question: typeof body?.question === "string" ? body.question : undefined,
      model: typeof body?.model === "string" ? body.model : undefined,
      scope: scopeRaw,
    });
    // 状态要能区分三种「没产出可用报告」：模型回复解析不出（AI_FAILED）、服务端没有台账（NO_EVIDENCE）、
    // 以及报告落库但被判 REJECTED —— 最后这一种是数据在库里、结论不可用，页面不能显示成「0 条所以正常」
    const status = r.report
      ? r.report.interpretation_status
      : r.evidence_total === 0 ? RESEARCH_NOT_RUN_STATUSES.no_evidence : RESEARCH_NOT_RUN_STATUSES.ai_failed;
    return NextResponse.json({ ...r, report_status: status }, { status: r.ok ? 200 : 422 });
  } catch (e) {
    // 异常分支沿用同一组字段（§三十一：错误结构稳定、无 silent failure），并写明「未写库」
    return NextResponse.json(
      rejected(`研究报告落库失败：${(e as Error).message}（未写库，也不会有半份报告进表）`, RESEARCH_NOT_RUN_STATUSES.ai_failed),
      { status: 502 },
    );
  }
}
