// P36-D 因子真相：把 factor_test 表里的检验结果变成界面能直接说的实话。
//
// 背景（任务书 2.5 节实证）：219 条因子检验里 193 条 rankIc 为负、只有 12 条为正。
// 也就是说——**绝大多数"看起来是买入信号"的条件，历史上是反着走的**。
// 这个事实原来只在后端日志里，界面上一个字都不提，用户会把它当买入信号用。
//
// 本核只做三件事：判方向、判是否过检、把结论翻译成人话。
// 不做：不替用户决定用不用、不隐藏坏消息、不为了"看着专业"写术语。
//
// 第 0 节硬约束：文案里不许出现 IC / 截面 / 样本外 / 超额 / 置信区间 这类词。

/** 因子方向：由 rankIc 的符号决定（rankIc 是"因子值排名次日的收益排名"的相关性） */
export type FactorDirection = "positive" | "negative" | "unknown";

export interface FactorTruth {
  key: string;
  /** positive=数值越高之后越强；negative=数值越高之后越弱（反向因子）；unknown=没检验过或结果为 0 */
  direction: FactorDirection;
  rankIc: number | null;
  icIr: number | null;
  /** 是否通过因子检验（factor_test.passed） */
  passed: boolean;
  /** 检验样本规模，给页面写明"看过多少票多少天" */
  samples: { stocks: number; dates: number } | null;
  dataRange: string | null;
}

export interface FactorTruthFile {
  generatedAt: string;
  source: string;
  counts: {
    /** factor_test 原始行数 */
    rows: number;
    /** 去重后的因子个数 */
    keys: number;
    passed: number;
    negative: number;
    positive: number;
    unknown: number;
  };
  factors: Record<string, FactorTruth>;
}

/** 符号定方向；|rankIc| 小到可以忽略（<0.005）时判 unknown，免得把噪声说成方向 */
export function directionOfRankIc(rankIc: number | null | undefined): FactorDirection {
  if (rankIc == null || !Number.isFinite(rankIc) || Math.abs(rankIc) < 0.005) return "unknown";
  return rankIc > 0 ? "positive" : "negative";
}

/** 单个因子的真相短句（给条件卡片的角标用，说人话） */
export function truthBadgeOf(t: FactorTruth | undefined): string | null {
  if (!t) return null;
  if (t.direction === "negative") return "反着走";
  if (!t.passed) return "没验过";
  return null;
}

/** 单个因子的完整说明（给 hover / 展开用，说人话 + 带样本量） */
export function truthDetailOf(t: FactorTruth | undefined, zh: string): string | null {
  if (!t) return `${zh}：这个条件没做过历史检验，不知道历史上有没有用`;
  const seen = t.samples ? `看过 ${t.samples.stocks} 只票 × ${t.samples.dates} 天` : "样本量未知";
  if (t.direction === "negative") {
    return `${zh}：历史上是反着走的——数值越高，之后几天反而越容易跌。命中它更接近「该回避」，不是「该买」（${seen}）`;
  }
  if (!t.passed) {
    return `${zh}：没通过历史检验，历史上看不出稳定效果（${seen}），别把它当买入理由`;
  }
  return `${zh}：通过了历史检验（${seen}），但历史有效不代表以后有效`;
}

/** 一次筛选用到的条件的体检结果（真实计数，不是写死的提示） */
export interface CondAudit {
  total: number;
  /** 没通过历史检验的条数 */
  unverified: number;
  /** 历史上反着走的条数（最危险：会被当成买入信号用） */
  negative: number;
  /** 没做过检验的条数 */
  untested: number;
  /** 汇总文案，给结果区顶部常驻显示 */
  summary: string | null;
  /** 逐条说明（展开看） */
  lines: string[];
}

/**
 * 对一组条件做体检。
 * 关键：`negative` 必须单独数出来——把反向因子包装成买入信号是本项目当前最危险的误用，
 * 不能跟"没验过"混在一起报个总数就完事。
 */
export function condAuditOf(
  conds: readonly { field: string; zh?: string }[],
  truth: Record<string, FactorTruth>,
): CondAudit {
  let unverified = 0;
  let negative = 0;
  let untested = 0;
  const lines: string[] = [];
  for (const c of conds) {
    const t = truth[c.field];
    const name = c.zh ?? c.field;
    if (!t) {
      untested++;
      lines.push(`${name}：没做过历史检验`);
      continue;
    }
    if (t.direction === "negative") {
      // 反向是最危险的一类，单独报；它同时没过检也不再重复计进 unverified，
      // 否则总数看着比条件数还多，用户反而看不懂
      negative++;
      lines.push(truthDetailOf(t, name) as string);
      continue;
    }
    if (!t.passed) {
      unverified++;
      lines.push(truthDetailOf(t, name) as string);
    }
  }
  const total = conds.length;
  let summary: string | null = null;
  if (total > 0 && (unverified + untested + negative) > 0) {
    const parts: string[] = [];
    if (negative > 0) parts.push(`${negative} 个历史上是反着走的（命中更接近该回避）`);
    if (unverified > 0) parts.push(`${unverified} 个没通过历史检验`);
    if (untested > 0) parts.push(`${untested} 个压根没验过`);
    summary = `这次用了 ${total} 个条件，其中 ${parts.join("、")}——结果仅供参考，别当成买入依据`;
  }
  return { total, unverified, negative, untested, summary, lines };
}
