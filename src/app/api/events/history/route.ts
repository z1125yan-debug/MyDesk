// GET 事件历史查询（P4 第四阶段）：按 asOf 读取 global_event 已落库的行 —— 只读，不重算、不写库、不改落库逻辑。
//
// GET /api/events 的今日口径保持原样（P2/P3 已验收）；本路由只做「指定日期的归档视图」。
// 事件表没有 state 列：快讯滑出上游窗口不代表它当时是错的，所以历史行原样全读，页面也不显示「消失」计数。
// 指定日期没有数据 ⇒ 明确空结果 + 说明，绝不回退到今天的事件列表。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import {
  availableDates, dayRunItems, emptyDayNote, eventHistoryItem, parseQueryDate, parseStateFilter,
  stateFilterBasis, viewBasis,
} from "@/lib/quant/screener/history-core";
import { countDayRuns, dateBuckets, dayCounts, readDayRuns, readEventDay } from "@/lib/quant/screener/history";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const today = shanghaiDate();
    const sp = new URL(req.url).searchParams;
    const rawDate = sp.get("date");
    const filter = parseStateFilter(sp.get("state")) ?? "all";
    const buckets = availableDates(await dateBuckets(db, "events"), today);
    let date = "";
    let dateBasis = "";
    if (rawDate === null || String(rawDate).trim() === "") {
      date = buckets.find((b) => b.rows > 0)?.date ?? "";
      dateBasis = date ? `未指定 date → 取库内最近有数据的归档日（${date}）` : "未指定 date，且库里还没有任何事件归档：没有可查询的历史日期";
    } else {
      const parsed = parseQueryDate(rawDate, today);
      if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
      date = parsed.date;
      dateBasis = `按请求参数 date=${date} 查询（历史查询只读留档日等于该日的库行）`;
    }

    if (!date) {
      return NextResponse.json({
        ok: true, kind: "events", date: null, is_today: false, today,
        date_basis: dateBasis, view_basis: "库里尚无事件归档：历史查询无可读日期",
        state_filter: "all", state_filter_basis: stateFilterBasis("events", filter),
        counts: { rows: 0, live: 0, superseded: null },
        items: [], available_dates: buckets, runs: [], runs_total: 0,
        missing: ["全球事件留档库当前一行都没有：没有任何一天的事件留在库里（扫描跑过但落库 0 条、或当日行被全量重刷后为 0，都属于这种状态）；历史查询不重算、不补造"],
      });
    }

    const rows = await readEventDay(db, date);
    const counts = await dayCounts(db, "events", date);
    const runRows = await readDayRuns(db, "events", date);
    const runs = dayRunItems(runRows);
    const runsTotal = await countDayRuns(db, "events", date);
    const missing: string[] = [];
    if (!rows.length) missing.push(emptyDayNote("events", date, filter, counts.rows, { isToday: date === today, runCount: runs.length }));
    if (!runs.length) missing.push("当天没有 task_run 记录：无法说明这批事件是哪次扫描、用什么口径写入的（如实缺失，不推测）");
    const items = rows.map(eventHistoryItem);
    const unmapped = items.filter((i) => !i.chain_mapped).length;
    if (items.length && unmapped === items.length) missing.push("本批事件全部没有产业链映射记录（mappedSectors 为空）：入库时就未命中映射表，历史查询不会补造板块归属");
    return NextResponse.json({
      ok: true,
      kind: "events",
      date,
      is_today: date === today,
      today,
      date_basis: dateBasis,
      state_filter: "all",
      state_filter_basis: stateFilterBasis("events", filter),
      view_basis: viewBasis("events", date, date === today, filter),
      counts: { rows: counts.rows, live: counts.live, superseded: null },
      items,
      available_dates: buckets,
      runs,
      runs_total: runsTotal,
      missing,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `事件历史读取失败：${(e as Error).message}` }, { status: 502 });
  }
}
