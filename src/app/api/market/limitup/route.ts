// GET /api/market/limitup — 涨停梯队/连板池（P0补齐·任务B）
// P15-R12 优化：进程内缓存 90s（涨停名单分钟级变化，90s 内重复请求直接命中）
import { NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeLimitUp } from "@/lib/quant/screener/limitup";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const TTL_MS = 90_000;
let cache: { at: number; data: unknown } | null = null;
let inflight: Promise<unknown> | null = null;

export async function GET(req: Request) {
  // 涨停榜冷算可达 6~7 秒：30s 内只算一次。
  // P67 体检 #11：?force=1 不得进缓存 key——旧码把 force 当独立 key，60s 内连点两次「强制刷新」
  // 第二次直接 HIT 同一份快照（要 force 却被静默节流）。force 一律绕过外层 ttlCache 同步重算。
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (force) return getHandler(req);
  return ttlCache(`market/limitup?${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  quantBootstrap();
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ ok: true, ...(cache.data as object), market: "A", market_label: "A股", }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }
  if (!inflight) {
    inflight = computeLimitUp()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => { inflight = null; });
  }
  try {
    const data = await inflight;
    return NextResponse.json({ ok: true, ...(data as object), market: "A", market_label: "A股", }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `涨停梯队计算失败：${(e as Error).message}` }, { status: 502 });
  }
}
