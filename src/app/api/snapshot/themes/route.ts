// POST /api/snapshot/themes — 主线发现的每日留档（P5 第五阶段）
//
// 与 risk 留档同源：服务端调用页面读的 GET /api/market/themes 处理函数，且强制 force=1 绕过 45 秒内存缓存，
// 保证留档行是「点这一刻重算的结果」，不是缓存里那一份的复读。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiStamp } from "@/lib/desk/session";
import { GET as computeThemes } from "@/app/api/market/themes/route";
import { snapshotBasis, themeColumnsFrom, themeHeadline } from "@/lib/quant/screener/snapshot-core";
import { insertThemeSnapshot } from "@/lib/quant/screener/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST() {
  quantBootstrap();
  try {
    const computedAt = shanghaiStamp();
    const resp = await computeThemes(new Request("http://127.0.0.1/api/market/themes?force=1"));
    const payload = await resp.json() as Record<string, unknown>;
    const extracted = themeColumnsFrom(payload, computedAt);
    if (!extracted.ok) {
      return NextResponse.json({ ok: false, error: extracted.error, basis: snapshotBasis("themes") }, { status: 502 });
    }
    const row = await insertThemeSnapshot(db, computedAt, extracted.columns, payload);
    return NextResponse.json({
      market: "A", market_label: "A股",
      ok: true,
      kind: "themes",
      id: String(row.id),
      trade_date: extracted.columns.tradeDate,
      computed_at: computedAt,
      headline: themeHeadline(payload, computedAt),
      missing: extracted.columns.missing,
      source: extracted.columns.source,
      basis: snapshotBasis("themes"),
      note: "留档绕过 45 秒缓存重算一次（会真实拉板块榜与成分扩散），同日再点则新增一条，不覆盖。",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `主线留档失败：${(e as Error).message}` }, { status: 502 });
  }
}
