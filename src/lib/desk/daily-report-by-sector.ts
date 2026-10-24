// 日报按板块整理分类（带 IO 的拉取层）。
//
// 并行拉四路：同花顺行业资金榜（板块卡）+ 日报四节（板块资金 Top5 / 美股 /
// 美联储-预测市场 / 动态相关-股票）。任一路失败都不抛错：板块卡为空时返回空卡 +
// “没取到”，由调用方如实展示。动态相关：每次日报生成前都去动态里看，
// 有股票相关的就加进来（来源标“动态”），不只加美联储一节。

import { fetchThsBoards } from "@/lib/desk/ths";
import { fetchDailyReportSections } from "@/lib/desk/daily-report-sections";
import { fetchContinuousReductions, membersOfSector } from "@/lib/desk/cninfo";
import { shanghaiDate } from "@/lib/desk/session";
import type {
  FedPredictionSection,
  FeedRelatedSection,
  SectorBranchSection,
  SectorFlowSection,
  UsMarketSection,
} from "@/lib/desk/daily-report-sections-core";
import {
  buildMainLineReductionSection,
  buildSectorCards,
  detectMainLineSectors,
  groupSectorsByCategory,
  type ContinuousReductionRow,
  type MainLineReductionSection,
  type SectorDailyCard,
  type SectorCategoryGroup,
} from "./daily-report-by-sector-core";

export type { ContinuousReductionRow, MainLineReductionSection, SectorDailyCard, SectorCategoryGroup };

export interface DailyReportBySector {
  cards: SectorDailyCard[];
  groups: SectorCategoryGroup[];
  usMarket: UsMarketSection;
  sectorFlow: SectorFlowSection;
  /** 板块资金分支细分（东财 BK13xx 分支 Top5 + 半导体/消费电子下钻） */
  sectorBranches: SectorBranchSection;
  /** 美联储 / 预测市场：FOMC 加息概率（Kalshi + Polymarket 平均）+ 对 A 股的影响 */
  fed: FedPredictionSection;
  /** 动态相关（股票）：动态里和股票相关的条目，来源标“动态” */
  feedRelated: FeedRelatedSection;
  /** 主线板块（钱进且价涨，前 3）+ 主线里连续减持 */
  mainLineReduction: MainLineReductionSection;
  /** 小白语言总览：板块数 + 板块资金段落 + 美股段落 + 美联储段落 + 动态相关段落 + 主线段落；取不到时为“没取到” */
  plain: string;
  hasData: boolean;
}

const NO_DATA_PLAIN = "日报按板块：没取到，算不出今天各板块的情况。";

/** 并行拉取：同花顺行业榜 → 板块日报卡；日报两节（板块资金 + 美股）。usOpenDayLabel 默认“今天”；瘦身版传下一交易日标签。 */
export async function fetchDailyReportBySector(opts?: { usOpenDayLabel?: string }): Promise<DailyReportBySector> {
  const [boardsResult, sectionsResult] = await Promise.allSettled([
    fetchThsBoards("industry"),
    fetchDailyReportSections({ usOpenDayLabel: opts?.usOpenDayLabel }),
  ]);

  const rows = boardsResult.status === "fulfilled" ? boardsResult.value : [];
  const sections = sectionsResult.status === "fulfilled"
    ? sectionsResult.value
    : {
        sectorFlow: { hasData: false, topInflow: [], topOutflow: [], plain: "今日板块资金：没取到，算不出钱去了哪。" },
        sectorBranches: { hasData: false, branchTopInflow: [], branchTopOutflow: [], drilldowns: [], plain: "分支细分：分支板块数据没取到，拆不了细账，只能看大板块。" },
        usMarket: { hasData: false, quotes: [], plain: "美股：昨晚收盘没取到，算不出对 A 股的影响。" },
        fed: { hasData: false, meetings: [], plain: "美联储 / 预测市场：Kalshi 和 Polymarket 都没取到，算不出加息概率。" },
        feedRelated: { hasData: false, items: [], checkedCount: null, plain: "动态相关（股票）：动态没取到，算不出动态里有没有股票相关的内容。" },
      };

  const cards = buildSectorCards(rows);
  const groups = groupSectorsByCategory(cards);
  const hasData = cards.length > 0;

  // 主线 + 主线里连续减持（2026-10-16 补充）：主线 = 钱进且价涨的板块（前 3）；
  // 对主线板块的龙头 + 核心成员查近 30 天连续减持（2 次及以上，或标题写连续/持续）。
  // 失败 → 主线段按“没取到”处理，不阻塞日报其它节。
  let mainLineReduction: MainLineReductionSection = buildMainLineReductionSection([], []);
  if (hasData) {
    try {
      const leadersOf = (sectorName: string): string => {
        const members = membersOfSector(sectorName);
        const leaders = members.filter((m) => m.tier === "leader").map((m) => m.name).filter(Boolean);
        return leaders.join("、");
      };
      const mainLines = detectMainLineSectors(cards, leadersOf);
      const codes: string[] = [];
      for (const m of mainLines) {
        const members = membersOfSector(m.name);
        const leaders = members.filter((x) => x.tier === "leader");
        const cores = members.filter((x) => x.tier === "core");
        const picked = [...leaders, ...cores].slice(0, 20);
        for (const p of picked) codes.push(p.code);
      }
      const cont = codes.length
        ? await fetchContinuousReductions(codes, shanghaiDate(), 30)
        : [];
      mainLineReduction = buildMainLineReductionSection(mainLines, cont.map((c) => ({
        code: c.code,
        name: c.name,
        count: c.count,
        hasBigHolder: c.hasBigHolder,
        plainLine: c.plainLine,
      })));
    } catch {
      mainLineReduction = {
        hasData: false, mainLines: [], continuous: [],
        plain: "主线连续减持：巨潮公告没取到，算不出主线里有没有票在连续减持。",
      };
    }
  }

  const plain = hasData
    ? `今日板块日报：共 ${cards.length} 个板块，分成 ${groups.length} 类。${sections.sectorFlow.plain} ${sections.usMarket.plain} ${sections.fed.plain} ${sections.feedRelated.plain} ${mainLineReduction.plain}`
    : NO_DATA_PLAIN;

  return { cards, groups, usMarket: sections.usMarket, sectorFlow: sections.sectorFlow, sectorBranches: sections.sectorBranches, fed: sections.fed, feedRelated: sections.feedRelated, mainLineReduction, plain, hasData };
}
