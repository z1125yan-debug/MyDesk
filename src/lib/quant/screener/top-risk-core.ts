// P15-R20 见顶风险纯核（零 IO 零时钟）：把「高风险」这一档从死档变成能走到的档。
//
// 现状与问题：sentiment.ts 的 `risk.level` 类型里一直有「高风险」，页面样式也早就备好了红色，
// 但现有五条规则**没有任何一条**会 `worse("高风险")` —— 单条读数再差也只是「偏高」，
// 于是这一档从来没被命中过（2026-09-28 查 task_run / 页面一致）。
// 一个永远取不到的档位，比缺一个档位更容易骗人：看着像「今天风险不算最高」，其实是尺子上根本没这道刻。
//
// 补活方式（本轮唯一新增判据，已有五条阈值一字未改）：
//   同一时刻命中 **两条及以上**「偏高」级读数 → 升为「高风险」。
//   为什么用「同拍条数」而不是把某条阈值调深：单条指标调深会让「今天差在哪」变成看不出来，
//   而多条同时差才是见顶蓝本（vibe-astock / tradermonty market-top-detector）里共识的形态。
//   阈值 2 是本轮口径，写在常量里、页面原样带出「几条同拍」这个数字，便于回头核对松紧。
export type RiskGrade = "正常" | "注意" | "偏高" | "高风险";

/** 档位从低到高（与 sentiment.ts 里的 worse() 同一套次序，别再抄第二份） */
export const RISK_ORDER: RiskGrade[] = ["正常", "注意", "偏高", "高风险"];

/** 升「高风险」需要的「偏高」级读数同拍最少条数 */
export const HIGH_RISK_MIN_SEVERE = 2;

export interface EscalationResult {
  level: RiskGrade;
  escalated: boolean;
  /** 同拍命中的「偏高」级读数条数（去重后） */
  severe: number;
  /** 升档时给 triggers 用的人话一句；没升档是空串 */
  text: string;
}

const shortLabel = (s: string): string => s.split("（")[0].trim();

/**
 * 单档取最差 + 同拍升档。
 * `base` 是现有五条规则各自 worse() 之后的结果；本函数只在这之上追加一条升档判据，
 * 不回头改任何一条既有阈值，也不参与「缺读数」判定（缺的读数在外面就该进 missing，不进 signals）。
 */
export function escalateToHighRisk(base: RiskGrade, severeSignals: string[]): EscalationResult {
  const uniq = [...new Set(severeSignals.map(shortLabel).filter(Boolean))];
  const severe = uniq.length;
  // 只在「已经因为某条偏高而停在偏高」时升档：正常/注意档下不存在两条偏高读数的可能，
  // 高风险档自己不再往上（往上没有定义）。
  if (base !== "偏高" || severe < HIGH_RISK_MIN_SEVERE) {
    return { level: base, escalated: false, severe, text: "" };
  }
  return {
    level: "高风险",
    escalated: true,
    severe,
    text: `同拍命中 ${severe} 条「偏高」级读数（${uniq.join("、")}）—— 阈值 ≥${HIGH_RISK_MIN_SEVERE} 条同拍即判系统性风险上升，单条指标均未改动`,
  };
}
