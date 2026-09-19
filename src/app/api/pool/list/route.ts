// GET /api/pool/list — 候选池列表
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const pools = await db.candidatePool.findMany({
    orderBy: { createdAt: "desc" },
  });

  const list = pools.map((p) => {
    let rows: unknown[] = [];
    try { rows = JSON.parse(p.rows); } catch { /* ignore */ }
    let verify: unknown = null;
    if (p.verify) {
      try { verify = JSON.parse(p.verify); } catch { /* ignore */ }
    }
    return {
      pool_id: p.poolId,
      created_at: p.createdAt.toISOString(),
      as_of: p.asOf,
      universe: p.universe,
      source: p.source,
      data_source: p.dataSource,
      row_count: rows.length,
      has_verify: verify !== null,
    };
  });

  return NextResponse.json({ ok: true, list });
}
