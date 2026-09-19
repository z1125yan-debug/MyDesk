// /api/events/interpret — AI 事件理解的读取与落库（P6-B）
//
// GET  ?date=YYYY-MM-DD        只读回看已落库的解释，并与当天 global_event 行对照出 stale / orphan
// POST { raw, model?, date?, ids?, limit? }
//      raw = 模型原文（字符串）。服务端**重新**从库里取事实、重新校验，再落库。
//
// 为什么要服务端复校验（而不是信前端传来的结构化结果）：§八 的两句「AI 不负责发现不存在的事件」
// 「AI 不得自己生成概率」如果只写在提示词里，就只是一句愿望。这里把它们变成代码：
// - event_id 必须在当日库行里，对不上的整条拒收（unknown_ids）→ AI 造不出事件；
// - evidence 必须能在原标题里找到出处，找不到就剔除并留痕 → AI 造不出证据；
// - affected_symbols 只留在标题/映射/关联名单里出现过的名称，其余降级进 hypothesized_symbols（AI_HYPOTHESIS）；
// - summary/unknowns/follow_up_queries 里出现的概率或涨幅预测一律剥掉并把原话存进 dropped.probability_claims，
//   同时记一条 violation 并把状态降为 PARTIAL → 不静默删，让人看得见被改了什么。
// 落库的 payload 永远是服务端解析后的结构，客户端无法直接往表里塞字段。
import { NextResponse } from "next/server";
import { loadInterpretations, storeInterpretations } from "@/lib/quant/screener/event-interpret";
import { MAX_RAW_CHARS, NOT_RUN_STATUSES } from "@/lib/quant/screener/event-interpret-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    const r = await loadInterpretations({ date: sp.get("date") ?? undefined });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `事件理解结果读取失败：${(e as Error).message}` }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    raw?: unknown; model?: unknown; date?: unknown; ids?: unknown; limit?: unknown;
  } | null;

  const raw = typeof body?.raw === "string" ? body.raw : "";
  if (!raw.trim()) {
    return NextResponse.json({
      ok: false, persisted: 0, items: [],
      error: "缺少 raw：本次没有可校验的模型原文，未落库（服务端不会替你生成一段解释）",
      interpretation_status: NOT_RUN_STATUSES.ai_failed,
    }, { status: 400 });
  }
  if (raw.length > MAX_RAW_CHARS) {
    return NextResponse.json({
      ok: false, persisted: 0, items: [],
      error: `模型原文长度 ${raw.length} 超过 ${MAX_RAW_CHARS} 字符上限：拒绝入库（防止把整段无关对话塞进解释表）`,
    }, { status: 413 });
  }
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).map((x) => String(x)) : undefined;
  const limitRaw = Number.parseInt(String(body?.limit ?? ""), 10);
  try {
    const r = await storeInterpretations({
      raw,
      model: typeof body?.model === "string" ? body.model : undefined,
      date: typeof body?.date === "string" ? body.date : undefined,
      ids,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    // 未落库时状态要能区分：AI 回复解析不出（ai_failed）、当日没有事件行（no_events），
    // 而不是给页面留一个「0 条」自己去猜原因
    const status = r.persisted > 0
      ? (r.items.some((i) => i.interpretation_status !== "INTERPRETED") ? "PARTIAL" : "INTERPRETED")
      : r.parse_failed ? NOT_RUN_STATUSES.ai_failed : NOT_RUN_STATUSES.no_events;
    return NextResponse.json({ ...r, interpretation_status: status }, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, persisted: 0, items: [], error: `事件理解落库失败：${(e as Error).message}` }, { status: 502 });
  }
}
