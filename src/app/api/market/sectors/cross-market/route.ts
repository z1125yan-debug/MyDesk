// 跨市场预警 API：外盘（美股ETF/国际期货）日K连跌 → 板块预警。
// 数据层 overseas-daily.ts（30 分钟缓存）；判定核 cross-market-core.ts（纯、可单测）。
import { NextResponse } from "next/server";
import { fetchOverseasDailyAll, beijingTodayStr } from "@/lib/quant/data/overseas-daily";
import {
  SECTOR_OVERSEAS_MAP,
  judgeInstrument,
  judgeSectorOverseas,
  sectorOverseasNote,
  type CrossInstrumentJudgement,
} from "@/lib/quant/screener/cross-market-core";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";

/**
 * 2026-09-29 菜单打开提速：本路由算一次要几秒（实测冷启动 1.3~6 秒），
 * 而菜单/切页会反复打它。包一层进程内 TTL 缓存（默认 60s，与页面轮询同档）：
 * 第二次起直接命中热缓存（几十毫秒），响应里的 asOf/tradeDate 照旧如实标数据时间。
 */
export async function GET() {
  return ttlCache("market/sectors/cross-market", DEFAULT_TTL_MS, () => getHandler());
}
async function getHandler() {
  try {
    const series = await fetchOverseasDailyAll();
    const instruments: CrossInstrumentJudgement[] = series.map(judgeInstrument);
    const sectors: Record<string, ReturnType<typeof judgeSectorOverseas>> = {};
    for (const sector of Object.keys(SECTOR_OVERSEAS_MAP)) {
      const sig = judgeSectorOverseas(sector, instruments);
      const note = sectorOverseasNote(sector);
      sectors[sector] = note ? { ...sig, line: `${sig.line}${sig.line ? " " : ""}${note}` } : sig;
    }
    return NextResponse.json({
      market: "cross", market_label: "跨市场", market_note: "美股ETF/国际期货（外盘）→ A股板块预警；instruments 为外盘，sectors 为 A股板块判定",
      ok: true,
      today: beijingTodayStr(),
      instruments,
      sectors,
      basis: "美股ETF=腾讯 usfqkline 日K；COMEX黄金/NYMEX原油=新浪全球期货日K。连续收跌+累计跌幅判定，阈值见 cross-market-core.ts",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
