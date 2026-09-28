// GET /api/market/themes — 主线发现（P2-3）
import { NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { discoverThemes } from "@/lib/quant/screener/themes";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  // 短 TTL 缓存（30s）：同一份主题数据只算一次，多个页面/刷新/标签页共用；配合客户端缓存做到「点开即有内容」
  return ttlCache(`market/themes?${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  quantBootstrap();
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    const data = await discoverThemes({ force });
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
