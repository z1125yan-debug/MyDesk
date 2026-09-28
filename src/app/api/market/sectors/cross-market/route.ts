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

export const dynamic = "force-dynamic";

export async function GET() {
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
