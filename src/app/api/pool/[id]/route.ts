// GET /api/pool/[id] — 候选池详情（冻结原始 rows + verify 回填）
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pool = await db.candidatePool.findUnique({ where: { poolId: id } });
  if (!pool) {
    return NextResponse.json({ error: `候选池不存在：${id}` }, { status: 404 });
  }

  let rows: unknown[] = [];
  try { rows = JSON.parse(pool.rows); } catch { /* ignore */ }

  let verify: unknown = null;
  if (pool.verify) {
    try { verify = JSON.parse(pool.verify); } catch { /* ignore */ }
  }

  let conditions: unknown = [];
  try { conditions = JSON.parse(pool.conditions); } catch { /* ignore */ }

  return NextResponse.json({
    ok: true,
    pool_id: pool.poolId,
    created_at: pool.createdAt.toISOString(),
    as_of: pool.asOf,
    universe: pool.universe,
    conditions,
    source: pool.source,
    data_source: pool.dataSource,
    // §四：价格口径显式标注——冻结行=真实未复权快照价；verify=K线序列口径（同序列内算收益）
    price_basis: "rows.close=冻结时点真实价（未复权）；verify.open/close=日K序列口径（通达信网关原始价/腾讯前复权价，同一序列内自洽）；除权除息日附近两者不相等属正常，不是数据错误",
    rows,
    verify,
  });
}
