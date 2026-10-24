// GET /api/daily-report/sectors?category=全部|分类名
// 日报按板块整理分类：板块卡按分类过滤后返回 + 分组 + 美股 + 板块资金段落 +
// 美联储/预测市场 + 动态相关（股票）。
// category 缺省 = 全部；非法分类 → 400。缺数据返回空卡 + “没取到”，不编数据。

import { NextResponse } from "next/server";
import { fetchDailyReportBySector } from "@/lib/desk/daily-report-by-sector";
import {
  CATEGORY_FILTERS,
  CATEGORY_ORDER,
  filterSectorsByCategory,
  groupSectorsByCategory,
  type SectorCategoryFilter,
} from "@/lib/desk/daily-report-by-sector-core";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const category = new URL(req.url).searchParams.get("category") ?? "全部";
  if (!CATEGORY_FILTERS.includes(category as SectorCategoryFilter)) {
    return NextResponse.json(
      { ok: false, error: `category 非法：${category}，可选：${CATEGORY_FILTERS.join("、")}` },
      { status: 400 },
    );
  }
  try {
    const report = await fetchDailyReportBySector();
    const cards = filterSectorsByCategory(report.cards, category as SectorCategoryFilter);
    const groups = groupSectorsByCategory(cards);
    return NextResponse.json({
      market: "A+US", market_label: "A股板块 + 美股/美联储环境", market_note: "cards/groups/sectorFlow 为 A股；usMarket/fed 为美股与美联储（外盘环境），已分块标注",
      ok: true,
      category,
      categories: CATEGORY_FILTERS,
      categoryOrder: CATEGORY_ORDER,
      cards,
      groups,
      usMarket: report.usMarket,
      sectorFlow: report.sectorFlow,
      fed: report.fed,
      feedRelated: report.feedRelated,
      plain: report.hasData
        ? category === "全部"
          ? report.plain
          : `今日板块日报（${category}）：共 ${cards.length} 个板块。${report.sectorFlow.plain} ${report.usMarket.plain} ${report.fed.plain} ${report.feedRelated.plain}`
        : "日报按板块：没取到，算不出今天各板块的情况。",
      hasData: report.hasData,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `日报按板块读取失败：${(e as Error).message}`, cards: [], groups: [] },
      { status: 502 },
    );
  }
}
