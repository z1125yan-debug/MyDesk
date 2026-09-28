// 跨市场预警·纯判定核（零 IO、零时钟）——外盘日K连跌判定 + 板块映射 + 人话文案。
// 数据见 data/overseas-daily.ts；UI 见 SectorTopPage；API 见 /api/market/sectors/cross-market。
//
// 用户需求原话（2026-09-29）：「能接美国那边期货，对于某个板块的看空或者看跌持续了几天，
// 然后给我发出预警」——所以判的是**持续**（连续收跌天数 + 累计跌幅），不是单日快照。
// 文案纪律（用户同日拍板）：不堆黑话，写人话；读数缺失就说没读到，不装作没有信号。

export interface CrossInstrumentInput {
  key: string;
  label: string;
  kind: "etf" | "futures";
  bars: { date: string; close: number }[]; // 升序，尾部最新
  missing: string;
}

export interface CrossInstrumentJudgement {
  key: string;
  label: string;
  kind: "etf" | "futures";
  lastDate: string | null;
  downStreak: number | null; // 连续收跌天数（最新一根往前数；最后一根涨=0）
  cum3: number | null; // 近3个交易日累计涨跌 %
  cum5: number | null; // 近5个交易日累计涨跌 %
  bearish: boolean | null; // null = 读数不足，判不了
  line: string; // 人话一句
}

// ── 判定刻度（本机定的数，不是交易所规则；要改只改这张表）──
// ETF 日波动 ~1-2%，商品各有性格：黄金低波动、原油高波动，阈值分开写。
export const CROSS_TH: Record<string, { streak: number; cum3: number; cum5: number }> = {
  usSMH: { streak: 3, cum3: -3, cum5: -5 },
  usNQ: { streak: 3, cum3: -2.5, cum5: -4 },
  comexGold: { streak: 3, cum3: -1.5, cum5: -2.5 },
  nymexCrude: { streak: 3, cum3: -4, cum5: -6 },
};

const pctText = (v: number | null, d = 1): string => (v == null ? "无读数" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);

/** 单品种判定：连续收跌天数 + 近3/5日累计 */
export function judgeInstrument(input: CrossInstrumentInput): CrossInstrumentJudgement {
  const base: CrossInstrumentJudgement = {
    key: input.key,
    label: input.label,
    kind: input.kind,
    lastDate: null,
    downStreak: null,
    cum3: null,
    cum5: null,
    bearish: null,
    line: "",
  };
  if (input.missing || input.bars.length < 4) {
    const why = input.missing || `只有 ${input.bars.length} 天日K，不够判持续`;
    return { ...base, line: `${input.label}：读数没拿到（${why}），不装作没有信号` };
  }
  const closes = input.bars.map((b) => b.close);
  const n = closes.length;
  let streak = 0;
  for (let i = n - 1; i > 0 && closes[i] < closes[i - 1]; i--) streak++;
  const cum = (k: number): number | null => (n > k ? +((closes[n - 1] / closes[n - 1 - k] - 1) * 100).toFixed(1) : null);
  const cum3 = cum(3);
  const cum5 = cum(5);
  const th = CROSS_TH[input.key];
  const bearish = th
    ? (streak >= th.streak && cum3 !== null && cum3 <= th.cum3) || (cum5 !== null && cum5 <= th.cum5)
    : false;
  const lastDate = input.bars[n - 1].date;
  const streakText = streak >= 2 ? `连跌 ${streak} 天` : streak === 1 ? "昨天收跌" : "最近收涨";
  const line = bearish
    ? `${input.label} ${streakText}、近5天累计 ${pctText(cum5)}——隔夜方向对相关板块不利`
    : `${input.label} ${streakText}，近5天累计 ${pctText(cum5)}，外盘没有明显拖累`;
  return { ...base, lastDate, downStreak: streak, cum3, cum5, bearish, line };
}

// ── 板块 ↔ 外盘品种映射（板块名与 sector-daily-snapshots.json 的 89 个申万行业逐字对齐）──
// 只挂真实有对应关系的品种，不硬套；没列进来的板块 = 没有贴近的外盘品种，如实说。
// 化学原料/化学制品：原油是其上游成本端（与 Phase2 ch_basic 用原油同口径），文案里明说"成本端"。
export const SECTOR_OVERSEAS_MAP: Record<string, string[]> = {
  半导体: ["usSMH", "usNQ"],
  元件: ["usSMH", "usNQ"],
  电子化学品: ["usSMH", "usNQ"],
  其他电子: ["usSMH", "usNQ"],
  光学光电子: ["usSMH", "usNQ"],
  消费电子: ["usSMH", "usNQ"],
  军工电子: ["usSMH", "usNQ"],
  计算机设备: ["usSMH", "usNQ"],
  通信设备: ["usSMH", "usNQ"],
  IT服务: ["usNQ"],
  软件开发: ["usNQ"],
  游戏: ["usNQ"],
  通信服务: ["usNQ"],
  互联网电商: ["usNQ"],
  黑色家电: ["usNQ"],
  文化传媒: ["usNQ"],
  影视院线: ["usNQ"],
  贵金属: ["comexGold"],
  石油加工贸易: ["nymexCrude"],
  油气开采及服务: ["nymexCrude"],
  化学原料: ["nymexCrude"],
  化学制品: ["nymexCrude"],
};

export interface CrossSectorSignal {
  sector: string;
  /** true = 至少一个对应外盘持续走弱，页面挂预警标 */
  warn: boolean;
  tone: "red" | "amber" | "blue";
  tag: string; // 列表行小标（预警时才有意义）
  line: string; // 详情区人话
  instrumentKeys: string[];
}

/** 单板块预警判定：对应外盘里有持续走弱的 → 预警 */
export function judgeSectorOverseas(
  sector: string,
  judgements: CrossInstrumentJudgement[],
): CrossSectorSignal {
  const keys = SECTOR_OVERSEAS_MAP[sector];
  if (!keys || !keys.length) {
    return {
      sector,
      warn: false,
      tone: "blue",
      tag: "",
      line: "这个板块没有贴近的外盘品种，不硬套跨市场信号。",
      instrumentKeys: [],
    };
  }
  const byKey = new Map(judgements.map((j) => [j.key, j]));
  const picked = keys.map((k) => byKey.get(k)).filter((j): j is CrossInstrumentJudgement => !!j);
  if (!picked.length) {
    return { sector, warn: false, tone: "blue", tag: "", line: "外盘读数没拿到，判不了。", instrumentKeys: keys };
  }
  if (picked.every((j) => j.bearish === null)) {
    return {
      sector,
      warn: false,
      tone: "blue",
      tag: "",
      line: `外盘读数没拿到（${picked.map((j) => j.label).join("、")}），判不了持续看跌。`,
      instrumentKeys: keys,
    };
  }
  const weak = picked.filter((j) => j.bearish === true);
  if (weak.length) {
    return {
      sector,
      warn: true,
      tone: "red",
      tag: "外盘连跌",
      line: `${weak.map((j) => j.line).join("；")}。这些是${sector}对应的外盘方向，隔夜压力不小，留意开盘。`,
      instrumentKeys: keys,
    };
  }
  return {
    sector,
    warn: false,
    tone: "blue",
    tag: "",
    line: picked.map((j) => j.line).join("；") + "。这些方向的隔夜压力不大。",
    instrumentKeys: keys,
  };
}

/** 成本端备注（化学类用原油作代理，文案要讲清楚这不是"化工品期货"） */
export function sectorOverseasNote(sector: string): string {
  if (sector === "化学原料" || sector === "化学制品") return "原油挂的是它们的成本端，不是化工品本身的价格。";
  return "";
}

// ── 近期风险综合结论（用户 2026-09-29 点名要的「经过这个面板所有数据算法之后」的那一行）──
// 把详情页全部读数（阶段/四分数/隔夜外盘）合成一句人话，每个板块因输入不同而不同。
// 刻度是本机定的加法表（透明、可单测），不是统计拟合——后续攒够数据再谈校准。

export interface RecentRiskInput {
  stage: string; // 引擎阶段（趋势反转/顶部形成中/下行延续/趋势内回撤/趋势健康）
  midTop: number;
  trendDamage: number;
  shortPullback: number;
  deltaUp: boolean; // 风险在升温（delta=up_up）
  crossWarn: boolean; // 外盘连跌触发
  /** 外盘短句，如「COMEX黄金 连跌5天、5日 -4.9%」；没有对应品种/没读到 = null */
  crossShort: string | null;
}

export interface RecentRiskVerdict {
  tone: "red" | "orange" | "amber" | "green";
  label: string;
  line: string;
}

const STAGE_RISK: Record<string, number> = {
  趋势反转: 3,
  顶部形成中: 2,
  下行延续: 1.5,
  趋势内回撤: 1,
  趋势健康: 0,
};

export function recentRiskVerdict(i: RecentRiskInput): RecentRiskVerdict {
  let score = STAGE_RISK[i.stage] ?? 0;
  const reasons: string[] = [];
  if (i.stage === "趋势反转" || i.stage === "顶部形成中" || i.stage === "下行延续") {
    reasons.push(`板块处于「${i.stage}」`);
  }
  if (i.midTop >= 70) { score += 2; reasons.push(`中期顶风险 ${i.midTop}`); }
  else if (i.midTop >= 40) { score += 1; reasons.push(`中期顶风险 ${i.midTop} 偏高`); }
  if (i.trendDamage >= 70) { score += 1.5; reasons.push(`趋势破坏 ${i.trendDamage}`); }
  else if (i.trendDamage >= 40) { score += 0.5; reasons.push(`趋势破坏 ${i.trendDamage}`); }
  if (i.shortPullback >= 70) { score += 1; reasons.push(`短线急跌 ${i.shortPullback}`); }
  if (i.deltaUp) { score += 0.5; reasons.push("风险还在升温"); }
  if (i.crossWarn && i.crossShort) { score += 1.5; reasons.push(`隔夜外盘：${i.crossShort}`); }

  const tone: RecentRiskVerdict["tone"] = score >= 5 ? "red" : score >= 3 ? "orange" : score >= 1.5 ? "amber" : "green";
  const label = score >= 5 ? "高风险" : score >= 3 ? "风险偏高" : score >= 1.5 ? "有风险苗头" : "暂时安全";
  if (!reasons.length) reasons.push("各路读数都还平稳，没有触发项");
  return { tone, label, line: `综合本页全部读数：${reasons.join("；")}——综合判定：${label}。` };
}
