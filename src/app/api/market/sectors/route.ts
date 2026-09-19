// GET /api/market/sectors — 行业板块排行（P1-2）
// 复用既有封装 fetchBoardReal（东财板块榜，流入+流出两侧合并）；
// RPS 为本榜单内涨幅截面百分位（派生指标，口径随榜单范围变化，前端已警示）。
// 现有数据源封装不含成交额/上涨家数/涨停家数/持续天数 → 显式列入 missing，不做演示兜底。
import { NextResponse } from "next/server";
import { fetchBoardReal } from "@/lib/desk/em";
import { shanghaiStamp } from "@/lib/desk/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") === "concept" ? "concept" : "industry";
  const size = Math.max(20, Math.min(500, Number(url.searchParams.get("size") ?? 200)));

  const [inRows, outRows] = await Promise.all([
    fetchBoardReal(kind, "in", size),
    fetchBoardReal(kind, "out", size),
  ]);
  if (inRows === null && outRows === null) {
    return NextResponse.json({ ok: false, error: "板块数据源暂不可用（东财 clist 无返回）" }, { status: 502 });
  }

  const merged = new Map<string, {
    code: string; secid: string; name: string;
    changePct: number; main: number; ratio: number; superBig: number; big: number; leader: string;
  }>();
  for (const r of [...(inRows ?? []), ...(outRows ?? [])]) {
    if (!r.code || merged.has(r.code)) continue;
    merged.set(r.code, r);
  }
  const list = [...merged.values()].sort((a, b) => b.changePct - a.changePct);

  // 榜单内涨幅百分位（0-100）
  const n = list.length;
  list.forEach((row, i) => {
    (row as Record<string, unknown>).rps = n > 1 ? ((n - 1 - i) / (n - 1)) * 100 : 100;
  });

  return NextResponse.json({
    ok: true,
    kind,
    list,
    as_of: shanghaiStamp(),
    missing: [
      "成交额（现有 fetchBoardReal 封装不含 f6 字段）",
      "上涨家数/涨停家数（现有封装不含板块广度字段）",
      "持续强势天数（需板块历史序列，现有封装无板块日K）",
    ],
    note: "RPS=本榜单内涨幅截面百分位（非全市场口径）；主力净额缺失的板块不参与榜单",
  });
}
