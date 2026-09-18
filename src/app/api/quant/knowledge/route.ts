// Quant Research Lab — 研究知识库 API（Phase 10）
// GET 列表（kind/q 过滤）+ research-context（Agent 研究前必须查询）
// POST 新增条目；PATCH 停用
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { addKnowledge, deactivateKnowledge, listKnowledge } from "@/lib/quant/store";
import { buildResearchContext, contextToPrompt } from "@/lib/quant/research/knowledge";
import type { KnowledgeKind } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") as KnowledgeKind | null;
  const q = url.searchParams.get("q") ?? undefined;
  try {
    const entries = await listKnowledge({ kind: kind ?? undefined, q, activeOnly: url.searchParams.get("activeOnly") === "1" });
    const wantsContext = url.searchParams.get("context") === "1";
    if (wantsContext) {
      const ctx = buildResearchContext(entries);
      return NextResponse.json({ context: ctx, prompt: contextToPrompt(ctx) });
    }
    return NextResponse.json({ entries });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => ({}))) as { kind?: KnowledgeKind; title?: string; content?: string; refs?: string[]; tags?: string[] };
  if (!body.kind || !body.title) {
    return NextResponse.json({ error: "需要 kind 与 title" }, { status: 400 });
  }
  try {
    const entry = await addKnowledge({ kind: body.kind, title: body.title, content: body.content, refs: body.refs, tags: body.tags });
    return NextResponse.json({ entry });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => ({}))) as { id?: string; active?: boolean };
  if (!body.id) return NextResponse.json({ error: "需要 id" }, { status: 400 });
  try {
    if (body.active === false) await deactivateKnowledge(body.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
