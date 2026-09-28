// POST /api/pool/freeze — 冻结候选池（落库后 rows 永不覆盖）
import { NextResponse } from "next/server";
import { invalidateServerCache } from "@/lib/quant/server-cache";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";

interface FreezeRow {
  symbol: string;
  name: string;
  close: number | null;
  changePct: number | null;
  [k: string]: unknown;
}

interface FreezeBody {
  universe: string;
  conditions: unknown;
  source: string;
  data_source?: string; // 数据来源口径（由调用方从 screener 响应 source.provider 透传）
  rows: FreezeRow[];
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as FreezeBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体非法" }, { status: 400 });
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows 不能为空" }, { status: 400 });
  }

  const asOf = shanghaiDate();

  // 当日序号：查已有同日期池数量
  const existing = await db.candidatePool.findMany({
    where: { poolId: { startsWith: `${asOf}-` } },
    select: { poolId: true },
  });
  const seq = String(existing.length + 1).padStart(3, "10");
  const poolId = `${asOf}-${body.universe}-${seq}`;

  await db.candidatePool.create({
    data: {
      poolId,
      asOf,
      universe: body.universe,
      conditions: JSON.stringify(body.conditions ?? []),
      source: body.source ?? "",
      dataSource: typeof body.data_source === "string" ? body.data_source : "",
      rows: JSON.stringify(body.rows),
    },
  });

  invalidateServerCache("pool/list"); // 冻结新池 → 让池列表的短缓存失效
  return NextResponse.json({ ok: true, pool_id: poolId, row_count: body.rows.length });
}
