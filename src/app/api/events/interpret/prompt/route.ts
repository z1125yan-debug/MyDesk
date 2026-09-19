// GET /api/events/interpret/prompt — 事件理解的提示词组装（P6-B，只读）
//
// 为什么要有这一条而不是让前端自己拼：§八 要求「事件来源必须首先来自真实」，所以能被写进提示词的
// 事件**只能是服务端从 global_event 现取的库行**。前端拼就意味着前端挑数据，也就给了「把没入库的
// 消息喂给模型」这条路；这里堵掉它。
//
// 本路由不写库、不打上游、不调模型：AI Key 只存在客户端（localStorage → /api/ai/proxy 的请求头），
// 服务端没有凭据也不假装有。客户端拿这份 prompt 自己调模型，再把**原文**交给 POST /api/events/interpret，
// 由服务端按库内事实复校验后落库。
import { NextResponse } from "next/server";
import { buildInterpretPrompt } from "@/lib/quant/screener/event-interpret";
import { NOT_RUN_STATUSES } from "@/lib/quant/screener/event-interpret-core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const idsRaw = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const limitRaw = Number.parseInt(sp.get("limit") ?? "", 10);
  try {
    const r = await buildInterpretPrompt({
      date: sp.get("date") ?? undefined,
      ids: idsRaw.length ? idsRaw : undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    return NextResponse.json({
      ...r,
      // 口径先说清楚：这一步只是「备好事实」，模型还没被调用，因此既没有解释也没有失败
      interpretation_status: r.ok ? "PROMPT_READY" : NOT_RUN_STATUSES.no_events,
      how_to_use: r.ok
        ? "把 system+prompt 交给客户端配置的模型（/api/ai/proxy），拿到回复后**原文** POST /api/events/interpret {raw, model, date, ids}；服务端会按库内事实复校验后才落库。AI 未配置时不要 POST，页面应显示 AI_NOT_CONFIGURED。"
        : "本次没有可用事实：没有事件行就没有可理解的东西，不要向模型编造事件，也不要落库。",
      note: "提示词里的事件、来源、时间、板块映射、资金验证阶段全部来自 global_event 库行原文（REAL 层）；模型输出的字段属于 AI_INTERPRETATION 层，不得当事实引用。",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `事件理解提示词组装失败：${(e as Error).message}` }, { status: 502 });
  }
}
