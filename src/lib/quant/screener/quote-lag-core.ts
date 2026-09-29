// 「数据日 ≠ 今天」时，页面/工具该怎么表述 —— 纯函数（可单测，不读文件、不看系统时间）。
//
// 为什么单独抽出来：2026-09-29 09:25（集合竞价中，正常交易日）页面角标写着
// 「数据截至 2026-09-28（2026-09-29 休市）」——**把「当日行情还没产生」说成了「今天休市」**。
// 根因是前端只要 quoteDate !== asOf 就硬编码「休市」，从未查交易日历、也没看当前时段。
// 纪律：①「休市」是日历事实，日历说不是交易日才能写；②日历读不到（null）→ 一律不许断言休市；
//      ③交易日没数据 → 如实说是「当日行情尚未产生/尚未更新」，不用「休市」背锅。

export type QuoteLagPhase = "trading" | "auction" | "break" | "closed" | "unknown";

export interface QuoteLagInput {
  /** 行情源数据实际所属交易日（YYYY-MM-DD） */
  quoteDate: string;
  /** 本次求值口径日（通常是今天）（YYYY-MM-DD） */
  asOf: string;
  /** 交易日历判定：true=交易日 / false=休市 / null=日历未知（禁止据此说休市） */
  asOfIsTradingDay: boolean | null;
  /** 当前时段（marketSession().phase） */
  phase: QuoteLagPhase;
  /** 当前时段文案（marketSession().label，如「集合竞价」「交易中」「未开盘」） */
  sessionLabel: string;
}

export type QuoteLagReason = "none" | "not_trading_day" | "trading_day_no_data" | "calendar_unknown";

export interface QuoteLag {
  /** 数据是否滞后于求值口径日（false 时 badge/note 均为空串，页面不显示角标） */
  lagging: boolean;
  /** 界面角标：短，只陈述事实 */
  badge: string;
  /** 完整说明：进 title / warnings，把「为什么不是今天的数据」讲全 */
  note: string;
  reason: QuoteLagReason;
}

const NONE: QuoteLag = { lagging: false, badge: "", note: "", reason: "none" };

export function quoteLagOf(input: QuoteLagInput): QuoteLag {
  const quoteDate = String(input.quoteDate ?? "").trim();
  const asOf = String(input.asOf ?? "").trim();
  // 没有「数据日」或两者相同 → 不存在滞后，不编造说明
  if (!quoteDate || !asOf || quoteDate === asOf) return NONE;

  if (input.asOfIsTradingDay === false) {
    // 「休市」必须由日历背书，这是文件里唯一允许出现「休市」二字的分支
    return {
      lagging: true,
      badge: `数据截至 ${quoteDate}（${asOf} 休市）`,
      note: `行情源最新数据为 ${quoteDate}：${asOf} 非交易日（休市），上一交易日收盘即最新`,
      reason: "not_trading_day",
    };
  }

  if (input.asOfIsTradingDay === true) {
    const label = input.sessionLabel || "交易时段";
    // 盘中（连续竞价）：行情源本该有当日数据，说「尚未更新」，不说「尚未产生」
    if (input.phase === "trading") {
      return {
        lagging: true,
        badge: `数据截至 ${quoteDate}（${asOf} ${label}，当日行情尚未更新）`,
        note: `行情源最新数据为 ${quoteDate}：${asOf} 是交易日、当前${label}，但行情源尚未更新出当日数据`,
        reason: "trading_day_no_data",
      };
    }
    return {
      lagging: true,
      badge: `数据截至 ${quoteDate}（${asOf} ${label}，当日行情尚未产生）`,
      note: `行情源最新数据为 ${quoteDate}：${asOf} 是交易日、当前${label}，当日行情尚未产生，上一交易日收盘即最新`,
      reason: "trading_day_no_data",
    };
  }

  // 日历未知：既不能说休市，也不能说交易日——只陈述「没有当日数据」
  return {
    lagging: true,
    badge: `数据截至 ${quoteDate}（${asOf} 暂无当日数据）`,
    note: `行情源最新数据为 ${quoteDate}，${asOf} 暂无当日数据（交易日历不可用，不对该日是否休市下结论）`,
    reason: "calendar_unknown",
  };
}
