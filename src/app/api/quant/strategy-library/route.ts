// 稳智「我的策略」社区策略库（只读）。GET /api/quant/strategy-library
//   ?q=<关键字>      按策略名/创建者过滤
//   ?limit=&offset=  分页（默认全部）
// 返回的条件字段已映射为 MyDesk 因子 key（映射脚本见 scrape 工程 scripts/map_strategies.py）。
import { NextResponse } from "next/server";
import { strategyLibrary, strategyLibraryMeta, type LibraryStrategy } from "@/lib/quant/data/strategy-library";

export const dynamic = "force-dynamic";

function strip(s: LibraryStrategy) {
  return {
    id: s.id, name: s.name, owner: s.owner,
    like: s.like ?? 0, dislike: s.dislike ?? 0, vote: s.vote ?? 0,
    n_total: s.n_total, n_mapped: s.n_mapped,
    conds: s.conds, unmapped: s.unmapped ?? [], approx: s.approx ?? [],
    backtest_params: s.backtest_params ?? null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 0) || 2000));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

  let list = strategyLibrary();
  const total = list.length;
  if (q) {
    list = list.filter((s) =>
      String(s.name ?? "").toLowerCase().includes(q) || String(s.owner ?? "").toLowerCase().includes(q));
  }
  const filtered = list.length;
  const page = list.slice(offset, offset + limit).map(strip);
  const meta = strategyLibraryMeta();
  return NextResponse.json({
    ok: true, total, filtered, offset, limit,
    source: meta.source || "aiwuchuan.com /api/strategies/",
    data: page,
  });
}
