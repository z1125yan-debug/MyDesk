// 日报按板块整理分类（纯函数，零 IO、零时钟）。
//
// 用户 2026-10-16 要求：日报按板块放一块（如半导体日报，点进去有详情），
// 自动筛选板块类型整理分类，不要所有板块混在一起看着乱。
//
// 小白口径：分类是按板块名关键词自动归类的，不是上游给的；
// 分歧只说一件事——“钱的方向和价格的方向打架”；
// 缺数据就说“没取到”，不编。

import type { ThsBoardRow } from "./ths";

/** 板块分类（7 类，固定顺序即优先级顺序） */
export type SectorCategory =
  | "成长科技"
  | "医药健康"
  | "消费"
  | "金融"
  | "周期"
  | "防御"
  | "其他";

/** 分类筛选值：全部 + 7 个分类 */
export type SectorCategoryFilter = SectorCategory | "全部";

/** 固定顺序：也是命中多个关键词时的优先级（成长科技 > 医药健康 > 消费 > 金融 > 周期 > 防御） */
export const CATEGORY_ORDER: SectorCategory[] = [
  "成长科技",
  "医药健康",
  "消费",
  "金融",
  "周期",
  "防御",
  "其他",
];

/** 筛选 chips：全部 + 7 个分类 */
export const CATEGORY_FILTERS: SectorCategoryFilter[] = ["全部", ...CATEGORY_ORDER];

/** 关键词映射：板块名包含任一关键词即归入该类。命中多个时按 CATEGORY_ORDER 优先级取第一个。 */
const CATEGORY_KEYWORDS: Record<Exclude<SectorCategory, "其他">, string[]> = {
  成长科技: [
    "半导体", "电子", "计算机", "通信", "芯片", "PCB", "先进封装",
    "集成电路", "元器件", "元件", "软件", "互联网", "算力", "人工智能", "5G", "光模块",
    "传媒", "游戏", "影视", "IT服务",
  ],
  医药健康: [
    "医药", "生物", "医疗", "中药", "化学制药", "生物医药",
    "医疗器械", "健康", "疫苗", "创新药",
  ],
  消费: [
    "白酒", "食品", "饮料", "家电", "消费", "零售", "商贸",
    "纺织", "服装", "美容", "餐饮", "旅游", "酒店", "日用", "乳业", "调味品",
    "电器", "家居", "教育",
  ],
  金融: ["证券", "银行", "保险", "金融", "券商", "信托", "多元金融"],
  周期: [
    "煤炭", "钢铁", "有色", "化工", "化学", "建筑", "建材", "房地产", "地产",
    "石油", "石化", "油气", "航运", "港口", "机械", "工程", "金属", "矿业", "水泥", "玻璃",
    "设备", "电机", "军工", "电池", "光伏", "风电", "塑料", "造纸", "橡胶", "包装", "农化",
  ],
  防御: [
    "电力", "公用事业", "交通", "燃气", "水务", "环保", "环境",
    "农业", "农林牧渔", "高速公路", "铁路", "机场",
    "养殖", "种植", "农产品",
  ],
};

/** 板块名 → 分类：按优先级逐类匹配关键词，命中 0 个 → “其他” */
export function classifySectorCategory(name: string): SectorCategory {
  const n = (name ?? "").trim();
  for (const category of CATEGORY_ORDER) {
    if (category === "其他") continue;
    const keywords = CATEGORY_KEYWORDS[category];
    if (keywords.some((k) => n.includes(k))) return category;
  }
  return "其他";
}

export interface SectorDivergence {
  kind: "资金与价格打架";
  /** 小白话，如“钱在往里进，但价格还在跌，资金和价格打架” */
  plain: string;
}

/** 一个板块的日报卡 */
export interface SectorDailyCard {
  name: string;
  category: SectorCategory;
  /** 当日板块涨跌幅 % */
  changePct: number;
  /** 当日板块资金净流入（亿，正 = 流入，负 = 流出） */
  netYi: number;
  /** 当日板块资金流入（亿） */
  inflowYi: number;
  /** 当日板块资金流出（亿） */
  outflowYi: number;
  /** 板块内公司家数 */
  count: number;
  /** 领涨股 */
  leader: string;
  /** 领涨股涨跌幅 % */
  leaderPct: number;
  /** 资金与价格分歧（方向一致时为 null） */
  divergence: SectorDivergence | null;
  /** 小白语言全文：涨跌 + 资金 + 家数 + 领涨股 + 分歧（如有） */
  plain: string;
}

function fmtYi(v: number): string {
  return `${Math.abs(v).toFixed(2)} 亿`;
}

function dirWord(v: number): string {
  return v >= 0 ? `涨 ${v.toFixed(2)}%` : `跌 ${Math.abs(v).toFixed(2)}%`;
}

function buildCardPlain(
  name: string,
  category: SectorCategory,
  changePct: number,
  netYi: number,
  inflowYi: number,
  outflowYi: number,
  count: number,
  leader: string,
  leaderPct: number,
  divergence: SectorDivergence | null,
): string {
  const flow = netYi > 0
    ? `资金净流入 ${fmtYi(netYi)}（流入 ${fmtYi(inflowYi)}，流出 ${fmtYi(outflowYi)}）`
    : netYi < 0
      ? `资金净流出 ${fmtYi(netYi)}（流入 ${fmtYi(inflowYi)}，流出 ${fmtYi(outflowYi)}）`
      : `资金净流入约 0（流入 ${fmtYi(inflowYi)}，流出 ${fmtYi(outflowYi)}）`;
  const leaderText = leader
    ? `领涨股是${leader}（${dirWord(leaderPct)}）`
    : "领涨股没取到";
  const countText = count > 0 ? `板块内共 ${count} 家公司` : "板块内公司家数没取到";
  const divergenceText = divergence
    ? `⚠️ ${divergence.plain}`
    : netYi === 0 || changePct === 0
      ? "资金和价格没有明显打架（有一边没动）。"
      : "钱和价格方向一致，没有打架。";
  return `${name}（${category}）今天${dirWord(changePct)}，${flow}。${countText}，${leaderText}。${divergenceText}`;
}

/** 同花顺行业榜行 → 板块日报卡（每板块算一次分歧） */
export function buildSectorCards(rows: readonly ThsBoardRow[]): SectorDailyCard[] {
  return rows.map((r) => {
    const changePct = Number.isFinite(r.changePct) ? r.changePct : 0;
    const netYi = Number.isFinite(r.netYi) ? r.netYi : 0;
    const inflowYi = Number.isFinite(r.inflowYi) ? r.inflowYi : 0;
    const outflowYi = Number.isFinite(r.outflowYi) ? r.outflowYi : 0;
    let divergence: SectorDivergence | null = null;
    if (netYi > 0 && changePct < 0) {
      divergence = {
        kind: "资金与价格打架",
        plain: `钱在往里进（净流入 ${fmtYi(netYi)}），但价格还在跌（${dirWord(changePct)}），资金和价格打架：可能是有人在低位接，也可能是拉高出货前的假动作，先别急着追。`,
      };
    } else if (netYi < 0 && changePct > 0) {
      divergence = {
        kind: "资金与价格打架",
        plain: `钱在往外跑（净流出 ${fmtYi(netYi)}），但价格还在涨（${dirWord(changePct)}），资金和价格打架：可能是主力在趁涨卖出，别只看涨就追高。`,
      };
    }
    return {
      name: r.name,
      category: classifySectorCategory(r.name),
      changePct,
      netYi,
      inflowYi,
      outflowYi,
      count: Number.isFinite(r.count) ? r.count : 0,
      leader: r.leader ?? "",
      leaderPct: Number.isFinite(r.leaderPct) ? r.leaderPct : 0,
      divergence,
      plain: buildCardPlain(
        r.name, classifySectorCategory(r.name), changePct, netYi,
        inflowYi, outflowYi, Number.isFinite(r.count) ? r.count : 0,
        r.leader ?? "", Number.isFinite(r.leaderPct) ? r.leaderPct : 0, divergence,
      ),
    };
  });
}

export interface SectorCategoryGroup {
  category: SectorCategory;
  cards: SectorDailyCard[];
}

/** 卡片按分类分组：只返回有卡的组，顺序固定为 CATEGORY_ORDER */
export function groupSectorsByCategory(cards: readonly SectorDailyCard[]): SectorCategoryGroup[] {
  return CATEGORY_ORDER
    .map((category) => ({ category, cards: cards.filter((c) => c.category === category) }))
    .filter((g) => g.cards.length > 0);
}

/** 按分类筛选卡片：“全部”返回全部；其余只返回该分类 */
export function filterSectorsByCategory(
  cards: readonly SectorDailyCard[],
  category: SectorCategoryFilter,
): SectorDailyCard[] {
  if (category === "全部") return [...cards];
  return cards.filter((c) => c.category === category);
}

// ── 主线板块 + 连续减持（2026-10-16 补充：主线板块里也要看减持） ──
//
// 用户：“主线是白酒，白酒里龙头是谁，白酒的钱是进还是出，这里可以加个
// 主线某个股票大股东在连续减持之类的。”
//
// 主线口径（纯函数，不编）：钱进（净流入 > 0）且价涨（涨跌幅 > 0）的板块，按净流入从大到小取前 3。
// 龙头：sector-constituents.json 里该板块 tier=leader 的成员（调用方传进来，本层不读文件）。

export interface MainLineSector {
  name: string;
  category: SectorCategory;
  changePct: number;
  netYi: number;
  inflowYi: number;
  outflowYi: number;
  /** 龙头名（sector-constituents tier=leader，多个用“、”连；无则 ""） */
  leaders: string;
}

/** 板块卡 → 主线板块（钱进且价涨，按净流入从大到小，前 3） */
export function detectMainLineSectors(
  cards: readonly SectorDailyCard[],
  leadersOf: (sectorName: string) => string,
): MainLineSector[] {
  return cards
    .filter((c) => c.netYi > 0 && c.changePct > 0)
    .sort((a, b) => b.netYi - a.netYi)
    .slice(0, 3)
    .map((c) => ({
      name: c.name,
      category: c.category,
      changePct: c.changePct,
      netYi: c.netYi,
      inflowYi: c.inflowYi,
      outflowYi: c.outflowYi,
      leaders: leadersOf(c.name),
    }));
}

export interface ContinuousReductionRow {
  code: string;
  name: string;
  count: number;
  hasBigHolder: boolean;
  plainLine: string;
}

export interface MainLineReductionSection {
  hasData: boolean;
  /** 主线板块（钱进且价涨，前 3） */
  mainLines: MainLineSector[];
  /** 主线板块成员里的连续减持（按次数从多到少） */
  continuous: ContinuousReductionRow[];
  /** 小白语言段落 */
  plain: string;
}

/** 主线板块 + 主线里连续减持 → 小白段落 */
export function buildMainLineReductionSection(
  mainLines: readonly MainLineSector[],
  continuous: readonly ContinuousReductionRow[],
): MainLineReductionSection {
  if (!mainLines.length) {
    return {
      hasData: true, mainLines: [], continuous: [...continuous],
      plain: "主线：今天没有钱进且价涨的板块，没有明确的主线。",
    };
  }
  const lineText = mainLines.map((m) => {
    const leaderText = m.leaders ? `，龙头是${m.leaders}` : "，龙头没取到";
    return `${m.name}（涨 ${m.changePct.toFixed(2)}%，资金净流入 ${Math.abs(m.netYi).toFixed(2)} 亿${leaderText}）`;
  }).join("；");
  const contText = continuous.length
    ? `⚠️ 主线里的连续减持，小心：${continuous.map((c) => c.plainLine).join("；")}`
    : "主线里的票没有大股东连续减持。";
  return {
    hasData: true,
    mainLines: [...mainLines],
    continuous: [...continuous],
    plain: `主线：${lineText}。${contText}`,
  };
}
