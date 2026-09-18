// Quant Research Lab — 单因子详情与生命周期变更（Phase 3/8）
// PATCH 仅允许改 status / note（表达式与 params 不可变，指标由评估流程写入）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { db } from "@/lib/db";
import { updateFactorState } from "@/lib/quant/store";
import { FACTOR_STATUSES, type FactorStatus } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  quantBootstrap();
  const { id } = await params;
  const row = await db.quantFactor.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: `因子不存在：${id}` }, { status: 404 });
  return NextResponse.json({ factor: row });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  quantBootstrap();
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { status?: FactorStatus; note?: string };
  if (body.status && !FACTOR_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `非法状态：${body.status}（可用：${FACTOR_STATUSES.join("|")}）` }, { status: 400 });
  }
  try {
    const factor = await updateFactorState(id, { status: body.status, note: body.note });
    if (!factor) return NextResponse.json({ error: `因子不存在：${id}` }, { status: 404 });
    return NextResponse.json({ factor });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
