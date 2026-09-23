// 全A市场列表 API（快照口径：真实 clist 全量，内存分页）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { universeSource } from "@/lib/quant/data/tc-universe";
import { shanghaiDate } from "@/lib/desk/session";
import type { AssetMeta } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

function snapVal(m: AssetMeta, key: string): number | null {
  switch (key) {
    case "change_pct": return m.changePct ?? null;
    case "amount_yi": return m.amount != null ? m.amount / 1e8 : null;
    case "turnover_rate": return m.turnover ?? null;
    case "volume_ratio": return m.volumeRatio ?? null;
    case "amplitude": return m.amplitude ?? null;
    case "market_cap_yi": return m.marketCap != null ? m.marketCap / 1e8 : null;
    case "floatcap_yi": return m.floatCap != null ? m.floatCap / 1e8 : null;
    case "pe_ttm": return m.pe ?? null;
    case "pb": return m.pb ?? null;
    case "main_net_yi": return m.mainNet != null ? m.mainNet / 1e8 : null;
    case "price": return m.price ?? null;
    default: return null;
  }
}

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const industry = url.searchParams.get("industry") ?? "";
  const orderBy = url.searchParams.get("order_by") ?? "amount_yi";
  const dir = url.searchParams.get("dir") === "asc" ? 1 : -1;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.max(10, Math.min(100, Number(url.searchParams.get("page_size") ?? "50") || 50));

  try {
    const provider = await getProvider("em");
    const tradeDate = shanghaiDate();
    let metas = await provider.listUniverse({ kind: "all" }, tradeDate);
    if (q) metas = metas.filter((m) => m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    if (industry) metas = metas.filter((m) => m.industry === industry);
    const sorted = [...metas].sort((a, b) => {
      const va = snapVal(a, orderBy), vb = snapVal(b, orderBy);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir;
    });
    const start = (page - 1) * pageSize;
    const list = sorted.slice(start, start + pageSize).map((m) => ({
      symbol: m.symbol, name: m.name, industry: m.industry ?? null,
      price: m.price ?? null, change_pct: m.changePct ?? null,
      amount_yi: m.amount != null ? m.amount / 1e8 : null,
      turnover_rate: m.turnover ?? null, volume_ratio: m.volumeRatio ?? null,
      amplitude: m.amplitude ?? null,
      market_cap_yi: m.marketCap != null ? m.marketCap / 1e8 : null,
      pe_ttm: m.pe ?? null, pb: m.pb ?? null,
      main_net_yi: m.mainNet != null ? m.mainNet / 1e8 : null,
      st: !!m.st, suspended: !!m.suspended,
    }));
    return NextResponse.json({
      ok: true,
      list,
      total: sorted.length,
      page,
      page_size: pageSize,
      trade_date: tradeDate,
      source: {
        provider:
          universeSource() === "tc"
            ? "腾讯批量快照兜底（东财榜单接口断源；行业/上市日/主力净额列暂空）"
            : "东财榜单接口（全A快照）",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `全A列表获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
