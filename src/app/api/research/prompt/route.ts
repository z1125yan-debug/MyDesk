// GET /api/research/prompt — 市场环境研究的提示词组装（P6-C，只读）
//
// 与 P6-B 同一条链路：AI 凭据只在客户端（localStorage → /api/ai/proxy 的请求头），服务端没有 Key，
// 所以「模型调用」这一步必然发生在客户端；服务端负责的是**唯一可信的那份事实台账**。
//
// 为什么不让前端自己拼提示词（§十一/§十二）：能被写进台账的读数只能由服务端从已有引擎与库里现取。
// 前端拼就等于把「喂什么数字给模型」交给客户端，REAL_DATA_ONLY 会被绕过。
//
// 本路由不写库、不落 Key：它调用的采集器里，上游取数走 em.ts 已有的短时缓存，
// 且同一次组装只调一次 computeSentiment（广度/梯队/指数/风险共用一份），不重复打同一个源。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { buildResearchPromptBundle } from "@/lib/quant/screener/research";
import { RESEARCH_NOT_RUN_STATUSES, RESEARCH_PROMPT_VERSION, researchScopeErrorText, researchScopeOf } from "@/lib/quant/screener/research-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  // Provider 注册（幂等）：本路由的采集器要调 computeSentiment/discoverThemes，
  // 不引导会拿到「EM Provider 未注册（仅服务端可用）」——与其它 quant 路由同一入口约定。
  quantBootstrap();
  const sp = new URL(req.url).searchParams;
  const scopeRaw = sp.get("scope");
  // 参数/组装失败时返回同一组字段（§三十一：错误结构稳定），且明确不给提示词
  const skeleton = (error: string) => ({
    ok: false, scope: "market" as const, date: "", as_of: "", lines: [] as unknown[], missing: [error],
    sources: [] as unknown[], truncated: 0, basis: "未取台账：参数校验未通过",
    question: "", system: "", prompt: "", prompt_version: RESEARCH_PROMPT_VERSION, error,
  });
  // 明确拒绝未知 scope：不返回「按 market 处理」的结果，那种静默降级会让人以为拿到的是个股研究
  if (scopeRaw !== null && !researchScopeOf(scopeRaw)) {
    return NextResponse.json({
      ...skeleton(researchScopeErrorText(scopeRaw)),
      report_status: "BAD_PARAM",
    }, { status: 400 });
  }
  try {
    const r = await buildResearchPromptBundle({ question: sp.get("question") ?? undefined, scope: scopeRaw });
    return NextResponse.json({
      ...r,
      // 这一步只是「备好台账」，模型还没被调用：既没有解释，也谈不上失败
      report_status: r.ok ? "PROMPT_READY" : RESEARCH_NOT_RUN_STATUSES.no_evidence,
      how_to_use: r.ok
        ? "把 system+prompt 交给客户端配置的模型（/api/ai/proxy），拿到回复后**原文** POST /api/research {raw, question, model, scope}；服务端会按现取台账复校验后才落库。AI 未配置时不要 POST，页面应显示 AI_NOT_CONFIGURED。"
        : "本次没有可用台账：服务端没取到真实读数就没有可解释的东西，不要向模型编造市场环境，也不要落库。",
      note:
        "台账三层（FACTS / SIGNALS / HISTORICAL_EVIDENCE）由服务端从已注册能力现取，逐行带出处与 asOf；" +
        "模型产出的四层属于 AI_INTERPRETATION，不是事实。指标一律不重算：风险/主线/概率/IC 都是已有引擎的产出。",
    });
  } catch (e) {
    return NextResponse.json(
      { ...skeleton(`研究提示词组装失败：${(e as Error).message}`), report_status: RESEARCH_NOT_RUN_STATUSES.ai_failed },
      { status: 502 },
    );
  }
}
