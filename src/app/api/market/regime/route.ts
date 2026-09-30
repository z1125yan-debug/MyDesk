// GET /api/market/regime —— 档位切换条（强势 / 震荡 / 弱势）的轻量数据源。
//
// 为什么不复用 /api/quant/strategy-forecast：那边要算见顶压力分 + 143 条策略闸门（冷启动 40 秒级），
// 切换条只是「今天什么档 + 这个档历史上什么样」，不需要也等不起。
//
// 三条纪律：
// 1) **判档口径只有 regime-core 一处**（这里调 regimeSnapshotOf，页面不准另算一套）——
//    否则条上写强势、弹卡写弱势，同屏打架（R20b 宽度那格栽过同样的跟头）。
// 2) 优先读**本地前复权日K粮仓**（可复核，不发外部请求）；粮仓没有才回退行情源，
//    并把 source 如实回给前端——「哪来的」必须能说清。
// 3) 参数 ?regime= 只接受 auto / 强势 / 震荡 / 弱势，其余一律 400：
//    口径边界模糊了，分享出去的链接就会指向不同的东西。
//    切到非当天档 = 研究模式（回看），回 banner 让页面顶部出提示条。

import { NextRequest, NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { db } from "@/lib/db";
import { fetchKlinesReal } from "@/lib/desk/em";
import {
  regimeSnapshotOf, parseRegimeParam, isResearchMode, researchBannerOf,
  regimeExplainLinesOf, type RegimeMode, type RegimeSnapshot,
} from "@/lib/quant/strategy/regime-switch-core";
import { regimeReversal } from "@/lib/quant/strategy/regime-reversal";
import { regimeLibrary } from "@/lib/quant/strategy/regime-library";

export const dynamic = "force-dynamic";

/** 上证指数（与 strategy-forecast 弹卡、调度器判交易日同源，不另起一套指数） */
const INDEX_SYMBOL = "000001.SH";
/** 判档只需要最近 20 根 + 一点余量回数「本档从哪天起」 */
const BARS = 160;

type Bar = { date: string; close: number };

async function indexBars(): Promise<{ bars: Bar[]; source: string }> {
  try {
    const rows = await db.stockDailyBar.findMany({
      where: { symbol: INDEX_SYMBOL, adjust: "qfq" },
      orderBy: { tradeDate: "desc" },
      take: BARS,
      select: { tradeDate: true, close: true },
    });
    if (rows.length >= 20) {
      const bars = rows.map((r) => ({ date: r.tradeDate, close: r.close })).reverse();
      return { bars, source: "本地日K粮仓（前复权）" };
    }
  } catch { /* 粮仓读不到就走行情源，不把整条挂掉 */ }
  const ks = await fetchKlinesReal(INDEX_SYMBOL, "day", BARS);
  const bars = (ks ?? []).map((k) => ({ date: String(k.date).slice(0, 10), close: Number(k.c) }))
    .filter((b) => b.date && Number.isFinite(b.close) && b.close > 0);
  return { bars, source: "行情源（本地粮仓没有这几天的上证日K）" };
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("regime");
  const picked = parseRegimeParam(raw);
  if (picked == null) {
    return NextResponse.json(
      { error: `档位参数不对：「${raw}」。只接受 auto / 强势 / 震荡 / 弱势` },
      { status: 400 },
    );
  }
  return ttlCache(`market/regime:${picked}`, DEFAULT_TTL_MS, () => handler(picked));
}

async function handler(picked: RegimeMode): Promise<NextResponse> {
  let snap: RegimeSnapshot;
  let source = "";
  let error = "";
  try {
    const { bars, source: src } = await indexBars();
    source = src;
    snap = regimeSnapshotOf(bars);
    error = snap.error;
  } catch (e) {
    snap = { regime: null, asOf: null, close: null, ma20: null, sinceDate: null, daysInRegime: null, error: "" };
    error = `档位没算出来：${(e as Error).message}`;
  }

  // 展示档：auto 跟随今天实判；手选就用手选的（可能进入研究模式）
  const shown = picked === "auto" ? snap.regime : picked;
  const rev = regimeReversal();
  // 该档历史榜：直接读 data/strategy-regime.json（回测算好的），不在接口里现算一遍——
  // 现算既慢又会漏掉 winCi（CI 是加载层 enrichWinCi 加的）。
  const lib = regimeLibrary();
  const rank = shown ? (lib?.rank?.[shown] ?? []).slice(0, 5) : [];
  return NextResponse.json({
    today: snap,
    picked,
    regime: shown,
    isResearch: isResearchMode(picked, snap.regime),
    banner: researchBannerOf(picked, snap.regime, snap.error),
    explain: regimeExplainLinesOf(rev),
    reversal: rev ? { source: rev.source, window: rev.window, note: rev.note, builtAt: rev.builtAt } : null,
    rank: rank.map((it) => ({
      id: it.id, name: it.name,
      n: it.stat.oos?.n ?? it.stat.n,
      win: it.stat.oos?.win ?? it.stat.win,
      winCi: it.stat.oos?.winCi ?? it.stat.winCi ?? null,
      net: it.stat.oos?.net1 ?? it.stat.avg,
      basis: it.basis ?? null,
    })),
    rankBasis: rank.length ? (lib?.rankBasis ?? "回测榜") : "",
    cost: lib?.basis?.cost ?? null,
    source,
    error,
  });
}
