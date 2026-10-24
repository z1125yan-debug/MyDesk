// GET /api/market/sectors/top-risk          — 全市场板块顶部风险扫描器（列表）
// GET /api/market/sectors/top-risk?sector=半导体 — 单板块诊断详情（四分数+状态+产业链诊断+证据）
// 引擎：src/lib/quant/screener/top-risk-engine.ts（读 data/sector-daily-snapshots.json + sector-industry-map.json）
import { NextResponse } from "next/server";
import { scanAll, analyzeSector } from "@/lib/quant/screener/top-risk-engine";
import { runBacktest } from "@/lib/quant/screener/top-risk-backtest";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 2026-09-29 菜单打开提速：本路由算一次要几秒（实测冷启动 1.3~6 秒），
 * 而菜单/切页会反复打它。包一层进程内 TTL 缓存（默认 60s，与页面轮询同档）：
 * 第二次起直接命中热缓存（几十毫秒），响应里的 asOf/tradeDate 照旧如实标数据时间。
 */
export async function GET(req: Request) {
  return ttlCache(`market/sectors/top-risk${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  const sp = new URL(req.url).searchParams;
  const sector = sp.get("sector");
  const backtest = sp.get("backtest");
  try {
    if (backtest) return NextResponse.json(await runBacktest());
    if (sector) {
      const r = analyzeSector(sector);
      if (!r) return NextResponse.json({ ok: false, error: `未找到板块：${sector}` }, { status: 404 });
      return NextResponse.json({ market: "A", market_label: "A股", ok: true, detail: r });
    }
    return NextResponse.json({ market: "A", market_label: "A股", ok: true, scanner: scanAll() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `计算失败：${(e as Error).message}` }, { status: 500 });
  }
}
