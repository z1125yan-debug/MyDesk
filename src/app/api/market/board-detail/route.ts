import { NextResponse } from "next/server";
import { fetchDetailReal } from "@/lib/desk/em";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";

/**
 * 2026-09-29 菜单打开提速：本路由算一次要几秒（实测冷启动 1.3~6 秒），
 * 而菜单/切页会反复打它。包一层进程内 TTL 缓存（默认 60s，与页面轮询同档）：
 * 第二次起直接命中热缓存（几十毫秒），响应里的 asOf/tradeDate 照旧如实标数据时间。
 */
export async function GET(req: Request) {
  return ttlCache(`market/board-detail${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  const secid = new URL(req.url).searchParams.get("secid")?.trim() ?? "";
  if (!secid) return NextResponse.json({ market: "A", market_label: "A股", detail: null });
  try {
    const detail = await fetchDetailReal(secid);
    return NextResponse.json({ market: "A", market_label: "A股", detail });
  } catch {
    return NextResponse.json({ market: "A", market_label: "A股", detail: null, error: "数据源暂不可用" });
  }
}
