// 日报新增两节：今日板块资金 + 美股（纯函数，零 IO、零时钟）。
//
// 用户 2026-10-16 原话：“还有每天板块的流入和流出也要加入日报，以及美股的，
// 因为美股是 A 股的爹”。
//
// 小白口径：不堆术语。板块资金说“钱去了哪 / 钱从哪跑了”；
// 美股说“昨晚美股涨了 / 跌了，A 股今天开盘可能高开 / 低开”。
// openDayLabel：A 股开盘日文案。默认“今天”（交易日完整版）；瘦身版（非交易日）传
// 下一交易日标签（如“周一（10-19）”），绝不把交易日模板的“今天开盘”带进非交易日报告。
// 缺数据就说“没取到”，不编。

import { interpretNewsTitle } from "./news-interpret";

export interface SectorFlowRow {
  name: string;
  /** 当日板块涨跌幅 % */
  changePct: number | null;
  /** 当日板块资金净流入（亿，正 = 流入，负 = 流出） */
  netYi: number | null;
}

export interface SectorFlowSection {
  hasData: boolean;
  /** 流入 Top5（净流入最大的 5 个） */
  topInflow: SectorFlowRow[];
  /** 流出 Top5（净流出最大的 5 个，即 netYi 最小的 5 个） */
  topOutflow: SectorFlowRow[];
  /** 小白语言段落 */
  plain: string;
}

function dirPct(v: number | null): string {
  if (v == null) return "涨跌没取到";
  return v >= 0 ? `涨 ${v.toFixed(2)}%` : `跌 ${Math.abs(v).toFixed(2)}%`;
}

function fmtYi(v: number): string {
  const a = Math.abs(v);
  if (a < 0.01) return "不到 0.01 亿";
  return `${a.toFixed(2)} 亿`;
}

// ── 板块资金分支细分（用户 2026-10-20 亲口定）──
//
// 原话：“以后流入板块细分，我要知道到底去哪了、从哪跑了。”
// 不能只报大板块汇总数：要拆到分支（BK13xx 三级板块）——净流入分支 Top5 /
// 净流出分支 Top5，再对重点大板块做父→子下钻（如半导体拆设备/材料/设计/封测）。
// 父→子映射只收名字在真实数据里核对过的（东财板块名逐个对过）；核不准的不收，
// 数据里缺的子分支如实写“没取到”，绝不猜代码、绝不编数。

export interface BranchFlowRow extends SectorFlowRow {
  /** 东财板块代码（如 BK1326）；没有代码的行不参与分支细分 */
  code: string;
}

/** 分支板块 = 代码 BK13xx（三级板块，如 BK1325 半导体材料 / BK1326 半导体设备） */
const BRANCH_CODE_RE = /^BK13\d{2}$/;

export interface SectorDrilldownDef {
  parentCode: string;
  parentName: string;
  children: { code: string; name: string }[];
}

/**
 * 父→子下钻映射（名字全部与真实数据核对过）：
 * - 半导体 BK1036：子分支名见 2026-10-20 收盘冻结榜 + 东财 fflow 日线接口返回名。
 * - 消费电子 BK1037：子分支名见 2026-10-20 收盘冻结榜，且 BK1338 在东财实时榜复核过。
 * - 电力设备 BK1200：2026-10-20 逐个用东财 fflow 日线接口返回名核对，22 个子分支
 *   净额合计 -39.13 亿 ≈ 父板块 -39.12 亿（0.01 取整差），对得上才收。此前疑心的
 *   “代码冲突”已澄清：BK1309 是电网自动化设备、BK1310 是配电设备，本是两个板块。
 */
export const SECTOR_DRILLDOWNS: SectorDrilldownDef[] = [
  {
    parentCode: "BK1036",
    parentName: "半导体",
    children: [
      { code: "BK1326", name: "半导体设备" },
      { code: "BK1325", name: "半导体材料" },
      { code: "BK1331", name: "数字芯片设计" },
      { code: "BK1330", name: "模拟芯片设计" },
      { code: "BK1328", name: "集成电路封测" },
      { code: "BK1327", name: "分立器件" },
    ],
  },
  {
    parentCode: "BK1037",
    parentName: "消费电子",
    children: [
      { code: "BK1338", name: "消费电子零部件及组装" },
      { code: "BK1337", name: "品牌消费电子" },
    ],
  },
  {
    parentCode: "BK1200",
    parentName: "电力设备",
    children: [
      { code: "BK1303", name: "锂电池" },
      { code: "BK1311", name: "输变电设备" },
      { code: "BK1312", name: "线缆部件及其他" },
      { code: "BK1315", name: "光伏电池组件" },
      { code: "BK1313", name: "风电零部件" },
      { code: "BK1320", name: "逆变器" },
      { code: "BK1318", name: "光伏主材" },
      { code: "BK1319", name: "硅料硅片" },
      { code: "BK1314", name: "风电整机" },
      { code: "BK1302", name: "电池化学品" },
      { code: "BK1323", name: "综合电力设备商" },
      { code: "BK1310", name: "配电设备" },
      { code: "BK1306", name: "蓄电池及其他电池" },
      { code: "BK1316", name: "光伏辅材" },
      { code: "BK1307", name: "电机Ⅲ" },
      { code: "BK1304", name: "锂电专用设备" },
      { code: "BK1305", name: "燃料电池" },
      { code: "BK1308", name: "电工仪器仪表" },
      { code: "BK1322", name: "其他电源设备Ⅲ" },
      { code: "BK1321", name: "火电设备" },
      { code: "BK1309", name: "电网自动化设备" },
      { code: "BK1317", name: "光伏加工设备" },
    ],
  },
];

export interface SectorDrilldown {
  parent: BranchFlowRow;
  /** 取到的子分支（按净额从大到小） */
  children: BranchFlowRow[];
  /** 映射里有、数据里没取到的子分支名 */
  missingChildren: string[];
}

export interface SectorBranchSection {
  hasData: boolean;
  /** 分支净流入 Top5（BK13xx） */
  branchTopInflow: BranchFlowRow[];
  /** 分支净流出 Top5（BK13xx） */
  branchTopOutflow: BranchFlowRow[];
  drilldowns: SectorDrilldown[];
  /** 小白语言段落（分支 Top + 每个下钻一段） */
  plain: string;
}

function flowWord(r: SectorFlowRow): string {
  const v = r.netYi ?? 0;
  return v >= 0 ? `流入 ${fmtYi(v)}` : `流出 ${fmtYi(v)}`;
}

/**
 * 分支细分：BK13xx 分支 Top5 + 父板块下钻 → 小白段落。无分支行 → hasData=false 如实说没取到。
 * rows = 板块全榜极值（算分支 Top5）；drilldownRows = 下钻映射代码的日线资金流
 * （clist 被限流时下钻靠它兜底，覆盖 rows 里的同名行）。两路都空 → 没取到。
 */
export function buildSectorBranchSection(
  rows: readonly BranchFlowRow[],
  drilldownRows: readonly BranchFlowRow[] = [],
): SectorBranchSection {
  const valid = rows.filter((r) => r.netYi != null && r.code);
  const byCode = new Map(valid.map((r) => [r.code, r]));
  for (const r of drilldownRows) {
    if (r.netYi != null && r.code) byCode.set(r.code, r);
  }
  const branchRows = valid.filter((r) => BRANCH_CODE_RE.test(r.code));
  const drilldowns: SectorDrilldown[] = [];
  for (const def of SECTOR_DRILLDOWNS) {
    const parent = byCode.get(def.parentCode);
    if (!parent) continue;
    const children = def.children
      .map((c) => byCode.get(c.code))
      .filter((r): r is BranchFlowRow => r != null)
      .sort((a, b) => (b.netYi ?? 0) - (a.netYi ?? 0));
    const missingChildren = def.children.filter((c) => !byCode.has(c.code)).map((c) => c.name);
    drilldowns.push({ parent, children, missingChildren });
  }
  if (!branchRows.length && !drilldowns.length) {
    return {
      hasData: false, branchTopInflow: [], branchTopOutflow: [], drilldowns,
      plain: "分支细分：分支板块数据没取到，拆不了细账，只能看大板块。",
    };
  }
  const sorted = [...branchRows].sort((a, b) => (b.netYi ?? 0) - (a.netYi ?? 0));
  const branchTopInflow = sorted.filter((r) => (r.netYi ?? 0) > 0).slice(0, 5);
  const branchTopOutflow = sorted.filter((r) => (r.netYi ?? 0) < 0).slice(-5).reverse();
  const lines: string[] = [];
  if (!branchRows.length && drilldowns.length) {
    lines.push("分支细分：分支全榜没取到，下面只拆重点大板块。");
  }
  if (branchRows.length) {
    const inLine = branchTopInflow.length
      ? `钱具体去了这几个分支：${branchTopInflow.map((r) => `${r.name}（${flowWord(r)}，${dirPct(r.changePct)}）`).join("、")}`
      : "没有分支明显流入";
    const outLine = branchTopOutflow.length
      ? `钱从这几个分支跑了：${branchTopOutflow.map((r) => `${r.name}（${flowWord(r)}，${dirPct(r.changePct)}）`).join("、")}`
      : "没有分支明显流出";
    lines.push(`分支细分（大板块拆到分支）：${inLine}；${outLine}。`);
  }
  for (const d of drilldowns) {
    // 流出分支按流出从大到小排（children 本身按净额降序，流出段落照原序会从小流出讲起）
    const outChildren = d.children.filter((r) => (r.netYi ?? 0) < 0).sort((a, b) => (a.netYi ?? 0) - (b.netYi ?? 0));
    const inChildren = d.children.filter((r) => (r.netYi ?? 0) >= 0);
    const parts: string[] = [`${d.parent.name}（汇总${flowWord(d.parent)}，${dirPct(d.parent.changePct)}）拆开看`];
    if (outChildren.length) {
      parts.push(`钱从这几个分支跑了：${outChildren.map((r) => `${r.name}（${flowWord(r)}，${dirPct(r.changePct)}）`).join("、")}`);
    }
    if (inChildren.length) {
      parts.push(`钱去了这几个分支：${inChildren.map((r) => `${r.name}（${flowWord(r)}，${dirPct(r.changePct)}）`).join("、")}`);
    }
    if (!d.children.length) parts.push("子分支一个都没取到，拆不了");
    let line = `${parts.join("；")}。`;
    // 主导分支点评：父汇总的方向主要由一个子分支造成时，明说“主要是它”。
    // 主导分支取净额绝对值最大的那个（children 按净额降序，流出分支里排第一的是
    // 流出最少的，必须按最小净额挑，别拿 outChildren[0]）。
    // 两档：①主导分支一个就超过父净额（其余分支整体反向）→“主要是它一个在跑/进”；
    // ②主导分支占父净额四成以上 →“主要是它在跑/进，一个分支就占了约 X%”。
    const pNet = d.parent.netYi ?? 0;
    if (pNet < 0 && outChildren.length) {
      const top = outChildren.reduce((a, b) => ((b.netYi ?? 0) < (a.netYi ?? 0) ? b : a));
      const topAbs = Math.abs(top.netYi ?? 0);
      const pAbs = Math.abs(pNet);
      if (inChildren.length && topAbs >= pAbs) {
        line += `换句话说，${d.parent.name}今天的净流出主要是${top.name}一个分支在跑，其余分支还在进钱。`;
      } else if (topAbs >= pAbs * 0.4 && topAbs < pAbs) {
        line += `换句话说，${d.parent.name}今天的净流出主要是${top.name}在跑——它一个分支就流出 ${fmtYi(top.netYi ?? 0)}，约占整个板块流出的 ${Math.round((topAbs / pAbs) * 100)}%。`;
      }
    } else if (pNet > 0 && inChildren.length) {
      const top = inChildren.reduce((a, b) => ((b.netYi ?? 0) > (a.netYi ?? 0) ? b : a));
      const topAbs = top.netYi ?? 0;
      if (outChildren.length && topAbs >= pNet) {
        line += `换句话说，${d.parent.name}今天的净流入主要是${top.name}一个分支在进，其余分支还在跑。`;
      } else if (topAbs >= pNet * 0.4 && topAbs < pNet) {
        line += `换句话说，${d.parent.name}今天的净流入主要是${top.name}在进——它一个分支就流入 ${fmtYi(top.netYi ?? 0)}，约占整个板块流入的 ${Math.round((topAbs / pNet) * 100)}%。`;
      }
    }
    if (d.missingChildren.length) {
      line += `（其中${d.missingChildren.join("、")}没取到。）`;
    }
    lines.push(line);
  }
  return { hasData: true, branchTopInflow, branchTopOutflow, drilldowns, plain: lines.join("") };
}

/** 板块资金 Top5 流入 / Top5 流出 → 小白段落 */
export function buildSectorFlowSection(rows: readonly SectorFlowRow[]): SectorFlowSection {
  const valid = rows.filter((r) => r.netYi != null);
  if (!valid.length) {
    return { hasData: false, topInflow: [], topOutflow: [], plain: "今日板块资金：没取到，算不出钱去了哪。" };
  }
  const sorted = [...valid].sort((a, b) => (b.netYi ?? 0) - (a.netYi ?? 0));
  const topInflow = sorted.filter((r) => (r.netYi ?? 0) > 0).slice(0, 5);
  const topOutflow = [...sorted].filter((r) => (r.netYi ?? 0) < 0).slice(-5).reverse();
  const inflowLine = topInflow.length
    ? `钱去了这几个板块：${topInflow.map((r) => `${r.name}（流入 ${fmtYi(r.netYi ?? 0)}，${dirPct(r.changePct)}）`).join("、")}。`
    : "今天没有板块明显流入。";
  const outflowLine = topOutflow.length
    ? `钱从这几个板块跑了：${topOutflow.map((r) => `${r.name}（流出 ${fmtYi(r.netYi ?? 0)}，${dirPct(r.changePct)}）`).join("、")}。`
    : "今天没有板块明显流出。";
  return {
    hasData: true,
    topInflow,
    topOutflow,
    plain: `今日板块资金：${inflowLine}${outflowLine}`,
  };
}

// ── 美联储 / 预测市场 ──

export interface FedMeetingProb {
  /** 如“10月28日”“12月会议” */
  meeting: string;
  /** 加息概率 %（Kalshi + Polymarket 都统一成“加息概率”，不混按兵不动） */
  kalshiHikePct: number | null;
  polymarketHikePct: number | null;
  /** 两家平均；只通一家就用那家 */
  avgHikePct: number | null;
  /** 实际用到的来源，如 ["Kalshi", "Polymarket"] */
  sources: string[];
}

export interface FedPredictionSection {
  hasData: boolean;
  meetings: FedMeetingProb[];
  /** 小白语言段落（含对 A 股的影响） */
  plain: string;
}

function fmtProb(v: number | null): string {
  return v == null ? "没取到" : `${v.toFixed(1)}%`;
}

/** 两家加息概率 → 一次会议的小白段落；缺数据就说“没取到”，不编 */
export function buildFedPredictionSection(meetings: readonly FedMeetingProb[]): FedPredictionSection {
  const hasData = meetings.some((m) => m.avgHikePct != null);
  if (!hasData) {
    return {
      hasData: false,
      meetings: [...meetings],
      plain: "美联储 / 预测市场：Kalshi 和 Polymarket 都没取到，算不出加息概率。",
    };
  }
  const lines = meetings.map((m) => {
    if (m.avgHikePct == null) return `${m.meeting}会议：加息概率没取到。`;
    const holdPct = 100 - m.avgHikePct;
    const parts: string[] = [];
    if (m.kalshiHikePct != null) parts.push(`Kalshi ${fmtProb(m.kalshiHikePct)}`);
    if (m.polymarketHikePct != null) parts.push(`Polymarket ${fmtProb(m.polymarketHikePct)}`);
    const srcNote = parts.length
      ? `（${parts.join("，")}，取平均）`
      : "";
    const lean = m.avgHikePct >= 50
      ? "市场觉得更可能加息"
      : "市场觉得更可能按兵不动";
    return `${m.meeting}会议：加息概率 ${fmtProb(m.avgHikePct)}${srcNote}，按兵不动概率 ${holdPct.toFixed(1)}%，${lean}。`;
  });
  // 对 A 股的影响：小白话——加息 = 钱变贵；按兵不动 = 钱的价格不变
  const oct = meetings[0]?.avgHikePct;
  const dec = meetings[1]?.avgHikePct;
  const impact: string[] = [];
  if (oct != null) {
    impact.push(oct >= 50
      ? "10 月会议加息概率过半：加息就是钱变贵，借钱成本高，股市可能跌，A 股开盘要小心。"
      : "10 月会议更可能按兵不动：钱的价格不变，对 A 股偏中性，不用因为美联储慌。");
  }
  if (dec != null && oct != null && dec > oct) {
    impact.push(`12 月会议的加息预期比 10 月更热（${fmtProb(dec)} vs ${fmtProb(oct)}），12 月会议前后 A 股要小心一点：真加息就是钱变贵，股市可能跌。`);
  } else if (dec != null && dec >= 50) {
    impact.push(`12 月会议加息概率过半（${fmtProb(dec)}），12 月会议前后 A 股要小心一点。`);
  }
  if (!impact.length) impact.push("对 A 股的影响：数据不够，判不了。");
  return {
    hasData: true,
    meetings: [...meetings],
    plain: `美联储 / 预测市场：下次 FOMC 会议是 10月28日。${lines.join("")}${impact.join("")}`,
  };
}

// ── 动态相关（股票）──
//
// 用户 2026-10-16 原话：日报生成前去动态里看看，有和股票相关的就加进来，
// 而不是只加美联储一节。来源标明是“动态”，缺数据就说“没取到”，不编。

export interface FeedRelatedItem {
  title: string;
  summary: string;
  sourceUrl: string | null;
  /** 如 2026-10-15 */
  published: string | null;
  /** 命中的股票关键词 */
  matchedKeywords: string[];
  /** 来源标注，固定为“动态” */
  source: "动态";
}

export interface FeedRelatedSection {
  hasData: boolean;
  /** 和股票相关的动态条目（已按关键词过滤） */
  items: FeedRelatedItem[];
  /** 动态里一共看了几条；null = 动态没取到 */
  checkedCount: number | null;
  /** 小白语言段落 */
  plain: string;
}

/** 股票相关关键词：标题/正文命中任一即算相关（用户喜好：美联储 / FOMC、预测市场、半导体、板块、个股、政策、财报等） */
export const STOCK_KEYWORDS: string[] = [
  "美联储", "FOMC", "预测市场", "Kalshi", "Polymarket",
  "加息", "降息", "利率", "降准", "央行", "证监会",
  "半导体", "芯片", "算力",
  "板块", "个股", "政策", "财报", "IPO", "分红", "回购",
  "股票", "股市", "A股", "美股", "港股", "ETF", "基金", "券商",
  "银行", "保险", "白酒", "医药", "新能源",
  "大盘", "开盘", "收盘", "涨停", "跌停", "主力", "散户",
  "北向资金", "南向资金", "龙头", "牛市", "熊市",
];

/** 标题 + 正文命中了哪些股票关键词（去重，保持 STOCK_KEYWORDS 顺序） */
export function matchStockKeywords(title: string, summary: string): string[] {
  const text = `${title ?? ""}\n${summary ?? ""}`;
  return STOCK_KEYWORDS.filter((k) => text.includes(k));
}

/** 动态条目 → 动态相关（股票）一节：只留股票相关的；动态没取到时 checkedCount 传 null。
 * 能解释的新闻后面直接跟一句自然解释（无“解读：”标签）；分析不出来的只留新闻本身，不追加填充句。
 * windowLabel：时间窗口文案，默认“今天”（交易日完整版）；瘦身版传“最近 24 小时内”。 */
export function buildFeedRelatedSection(
  items: readonly FeedRelatedItem[],
  checkedCount: number | null,
  windowLabel = "今天",
): FeedRelatedSection {
  if (checkedCount == null) {
    return {
      hasData: false,
      items: [],
      checkedCount: null,
      plain: "动态相关（股票）：动态没取到，算不出动态里有没有股票相关的内容。",
    };
  }
  if (!items.length) {
    return {
      hasData: false,
      items: [],
      checkedCount,
      plain: `动态相关（股票）：${windowLabel}动态里看了 ${checkedCount} 条，没有和股票相关的（美联储 / 预测市场、半导体、板块、个股、政策、财报等都没提到）。`,
    };
  }
  const lines = items.map((it, i) => {
    const date = it.published ? `（${it.published}，来源：动态）` : "（来源：动态）";
    const exp = interpretNewsTitle(it.title);
    return `${i + 1}. 《${it.title}》——${it.summary}${date}${exp ? ` ${exp}` : ""}`;
  });
  return {
    hasData: true,
    items: [...items],
    checkedCount,
    plain: `动态相关（股票）：${windowLabel}动态里看了 ${checkedCount} 条，和股票相关的有 ${items.length} 条：${lines.join(" ")}`,
  };
}

export interface UsQuoteRow {
  /** 如 SPY / QQQ / VOO / DIA / NVDA */
  symbol: string;
  /** 中文名，如“标普 500 ETF”“纳指 100 ETF”“道指 ETF”“英伟达” */
  label: string;
  /** 昨晚收盘涨跌幅 % */
  changePct: number | null;
  /** 昨晚收盘价 */
  price: number | null;
  /** 交易日，如 2026-10-15 */
  date: string | null;
}

export interface UsMarketSection {
  hasData: boolean;
  quotes: UsQuoteRow[];
  /** 小白语言段落（含对 A 股的影响） */
  plain: string;
}

/** 美股昨晚收盘 → 小白段落 + 对 A 股的影响 */
export function buildUsMarketSection(
  quotes: readonly UsQuoteRow[],
  opts?: { openDayLabel?: string },
): UsMarketSection {
  const day = opts?.openDayLabel ?? "今天";
  const valid = quotes.filter((q) => q.changePct != null);
  if (!valid.length) {
    return { hasData: false, quotes: [...quotes], plain: "美股：昨晚收盘没取到，算不出对 A 股的影响。" };
  }
  const bySym = new Map(valid.map((q) => [q.symbol, q]));
  const parts = valid.map((q) => `${q.label}${q.changePct! >= 0 ? "涨" : "跌"} ${Math.abs(q.changePct!).toFixed(2)}%`).join("、");
  const date = valid[0].date ? `（${valid[0].date} 收盘）` : "";
  // 对 A 股的影响：看整体方向 + 半导体方向
  const spy = bySym.get("SPY")?.changePct ?? bySym.get("VOO")?.changePct ?? null;
  const qqq = bySym.get("QQQ")?.changePct ?? null;
  const nvda = bySym.get("NVDA")?.changePct ?? null;
  const lines: string[] = [];
  if (spy != null) {
    lines.push(spy >= 0
      ? `美股昨晚涨了，A 股${day}开盘可能高开。`
      : `美股昨晚跌了，A 股${day}开盘可能低开。`);
  }
  if (qqq != null && spy != null && Math.sign(qqq) !== Math.sign(spy)) {
    lines.push(`纳指和标普方向不一样（纳指${qqq >= 0 ? "涨" : "跌"} ${Math.abs(qqq).toFixed(2)}%，标普${spy >= 0 ? "涨" : "跌"} ${Math.abs(spy).toFixed(2)}%），科技股和大盘走得不一样。`);
  }
  if (nvda != null) {
    lines.push(nvda < -1
      ? `英伟达跌了 ${Math.abs(nvda).toFixed(2)}%，A 股半导体${day}可能跟着跌。`
      : nvda > 1
        ? `英伟达涨了 ${nvda.toFixed(2)}%，A 股半导体${day}可能跟着涨。`
        : `英伟达只动了 ${nvda.toFixed(2)}%，对 A 股半导体影响不大。`);
  }
  if (!lines.length) lines.push("美股方向对 A 股的影响：数据不够，判不了。");
  return {
    hasData: true,
    quotes: [...quotes],
    plain: `美股${date}：${parts}。${lines.join("")}`,
  };
}

// ── 减持风险（2026-10-16：用户“巨潮能看到哪个股票的股东减持了比较大的是吧，
// 这个也可以作为风险，因为之前六月份的时候好像蛮多股票的大股东创始人什么的减持比较多”） ──
//
// 输入是已解析的减持风险行（cninfo.ts 的 CninfoReductionPlain，不含 PDF 解析）。
// 诚实边界：标题里没有具体减持股数 / 金额 / 占总股本比例（在公告正文 PDF 里，不解析、不编）。
// 标题带比例的（如“触及1%”）才写比例；不带的写“具体数量看公告正文”。

export interface ReductionRiskRow {
  code: string;
  name: string;
  /** 谁在减：控股股东 / 大股东 / 董监高 / 股东 */
  holder: string;
  /** 计划（还没卖） / 结果（已经卖了 / 期限到了） */
  stage: string;
  /** 标题里带的比例（如 1），不带为 null */
  pctInTitle: number | null;
  /** 风险等级：高 / 中 / 低 */
  riskLevel: "高" | "中" | "低";
  /** 小白一句话 */
  plainLine: string;
}

export interface ReductionRiskSection {
  hasData: boolean;
  /** 当日全市场减持公告总数 */
  total: number;
  /** 其中大股东（控股股东 + 持股5%以上股东）减持数 */
  bigHolderCount: number;
  /** 按风险高→低排序的全部减持行 */
  rows: ReductionRiskRow[];
  /** 小白语言段落 */
  plain: string;
}

/** 减持风险 → 日报“减持风险”一节（小白语言） */
export function buildReductionRiskSection(rows: readonly ReductionRiskRow[]): ReductionRiskSection {
  if (!rows.length) {
    return {
      hasData: true, total: 0, bigHolderCount: 0, rows: [],
      plain: "减持风险：今天全市场没有股票发减持公告，大股东都没在卖。",
    };
  }
  const big = rows.filter((r) => r.holder === "控股股东" || r.holder === "大股东").length;
  const lines = rows.map((r) => r.plainLine).join("；");
  const warn = big >= 10
    ? `今天大股东减持的票有 ${big} 只，比较多，大股东都在卖，小心（像六月份那样，大股东集中减持的时候要当心）。`
    : big > 0
      ? `今天大股东减持的票有 ${big} 只，这几只小心。`
      : "今天没有大股东减持，只有董事/高管或普通股东减持，风险相对小。";
  return {
    hasData: true,
    total: rows.length,
    bigHolderCount: big,
    rows: [...rows],
    plain: `减持风险：今天全市场 ${rows.length} 只票发了减持公告。${warn}${lines}。`,
  };
}
