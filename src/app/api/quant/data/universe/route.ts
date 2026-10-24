// Quant Research Lab — 数据探测：股票池样本（验证 Provider 链路）
import { NextResponse } from "next/server";
import { shanghaiDate } from "@/lib/desk/session";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { applyUniverseFilters } from "@/lib/quant/data/provider";
import type { UniverseKind } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const kind = (url.searchParams.get("kind") ?? "all") as UniverseKind;
  const boardCode = url.searchParams.get("board") ?? undefined;
  const symbols = url.searchParams.get("symbols")?.split(",").filter(Boolean);
  const asOf = url.searchParams.get("asOf") ?? shanghaiDate();
  const source = url.searchParams.get("source") ?? "em";
  const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "30", 10) || 30);
  const excludeST = url.searchParams.get("excludeST") !== "0";

  try {
    const provider = await getProvider(source);
    const metas = await provider.listUniverse({ kind, boardCode, symbols }, asOf);
    const { kept, excluded } = applyUniverseFilters(metas, asOf, { excludeST });
    return NextResponse.json({
      market: "A", market_label: "A股",
      asOf,
      source,
      total: metas.length,
      kept: kept.length,
      excluded,
      coverage: provider.coverage(),
      rows: kept.slice(0, limit),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
