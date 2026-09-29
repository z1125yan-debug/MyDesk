// 全A市场列表 API（快照口径：真实 clist 全量，内存分页）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { getProvider } from "@/lib/quant/data/index";
import { universeSource } from "@/lib/quant/data/tc-universe";
import { shanghaiDate } from "@/lib/desk/session";
import { latestTradeDate } from "@/lib/desk/trade-date";
import type { AssetMeta } from "@/lib/quant/types";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

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

/**
 * 2026-09-29 菜单打开提速：本路由算一次要几秒（实测冷启动 1.3~6 秒），
 * 而菜单/切页会反复打它。包一层进程内 TTL 缓存（默认 60s，与页面轮询同档）：
 * 第二次起直接命中热缓存（几十毫秒），响应里的 asOf/tradeDate 照旧如实标数据时间。
 */
export async function GET(request: Request) {
  return ttlCache(`market/allstocks${new URL(request.url).search}`, DEFAULT_TTL_MS, () => getHandler(request));
}
async function getHandler(request: Request) {
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
    // 数据日走行情源真值：休市日回最近交易日（节假日自动识别），不拿服务器时钟当数据日；
    // 行情源全挂才退回服务器当天（此时本来也取不到多少数，标日期没有更真）
    const tradeDate = await latestTradeDate().catch(() => shanghaiDate());
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
            ? "腾讯批量快照（本快照不含行业/上市日/主力净额列，这几列显「—」）"
            : "东财榜单接口（全A快照）",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `全A列表获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
