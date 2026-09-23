// GET 雷达历史查询（P4 第四阶段）：按 asOf 读取 radar_finding 已落库的行 —— 只读，不重算、不写库。
//
// 与今日口径的分工：GET /api/radar 仍然是「今日 + state=live」的实时视图（P2/P3 已验收，一字未改）；
// 本路由负责「指定日期的归档视图」，把 live / superseded 都摊开给人复盘（消失行本来就不该被删，P3 就是这么留的）。
//
// 诚实边界：
// - 未指定 date 时取库内最近有数据的归档日，并在 date_basis 里写明这是"最近有数据的那天"，不冒充"今天"；
// - 库里确实没有那天 ⇒ 返回空 items + missing 说明，绝不回退到今天的数据；
// - 雷达行没有逐行来源列 ⇒ source 字段按 kind/evidence 推导并附推导依据，当日的真实扫描记录另见 runs（task_run）。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import {
  availableDates, dayRunItems, emptyDayNote, parseQueryDate, radarHistoryItem, stateFilterBasis, viewBasis,
  parseStateFilter, type StateFilter,
} from "@/lib/quant/screener/history-core";
import { countDayRuns, dateBuckets, dayCounts, readDayRuns, readRadarDay } from "@/lib/quant/screener/history";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const today = shanghaiDate();
    const sp = new URL(req.url).searchParams;
    const rawDate = sp.get("date");
    const filter = parseStateFilter(sp.get("state"));
    if (!filter) {
      return NextResponse.json({ ok: false, error: `state 只能是 all / live / superseded，收到「${String(sp.get("state")).slice(0, 32)}」` }, { status: 400 });
    }
    const buckets = availableDates(await dateBuckets(db, "radar"), today);
    let date = "";
    let dateBasis = "";
    if (rawDate === null || String(rawDate).trim() === "") {
      // 缺省 = 最近有数据的那天。库里一行都没有时如实给空，而不是拿今天的日期凑一个"可查询日期"
      date = buckets.find((b) => b.rows > 0)?.date ?? "";
      dateBasis = date ? `未指定 date → 取库内最近有数据的归档日（${date}）` : "未指定 date，且库里还没有任何雷达归档：没有可查询的历史日期";
    } else {
      const parsed = parseQueryDate(rawDate, today);
      if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
      date = parsed.date;
      dateBasis = `按请求参数 date=${date} 查询（历史查询只读留档日等于该日的库行）`;
    }

    if (!date) {
      return NextResponse.json({
        ok: true, kind: "radar", date: null, is_today: false, today,
        state_filter: filter as StateFilter, state_filter_basis: stateFilterBasis("radar", filter as StateFilter),
        date_basis: dateBasis, view_basis: "库里尚无雷达归档：历史查询无可读日期",
        counts: { rows: 0, live: 0, superseded: 0 },
        items: [], available_dates: buckets, runs: [], runs_total: 0,
        missing: ["雷达发现留档库当前一行都没有：没有任何一天的雷达信号留在库里（扫描跑过但落库 0 条、或当日行被全量重刷后为 0，都属于这种状态）；历史查询不重算、不补造"],
      });
    }

    const rows = await readRadarDay(db, date, filter as StateFilter);
    const counts = await dayCounts(db, "radar", date);
    const runs = dayRunItems(await readDayRuns(db, "radar", date));
    const runsTotal = await countDayRuns(db, "radar", date);
    const missing: string[] = [];
    if (!rows.length) missing.push(emptyDayNote("radar", date, filter as StateFilter, counts.rows, { isToday: date === today, runCount: runs.length }));
    if (!runs.length) missing.push("当天没有 task_run 记录：无法说明这批行是哪次扫描、用什么口径写入的（如实缺失，不推测）");
    return NextResponse.json({
      ok: true,
      kind: "radar",
      date,
      is_today: date === today,
      today,
      date_basis: dateBasis,
      state_filter: filter,
      state_filter_basis: stateFilterBasis("radar", filter as StateFilter),
      view_basis: viewBasis("radar", date, date === today, filter as StateFilter),
      counts,
      items: rows.map(radarHistoryItem),
      available_dates: buckets,
      runs,
      runs_total: runsTotal,
      missing,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `雷达历史读取失败：${(e as Error).message}` }, { status: 502 });
  }
}
