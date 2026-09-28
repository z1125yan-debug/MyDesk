// 持仓上下文 → 提示词片段（服务端唯一拼装处）。
//
// 为什么要从 hold-core 里分出来：hold-core 是零 IO 纯核（清洗/拼句/算天数都能单测），
// 而「已持有几个交易日」必须问真实交易日历（tdx.ts 的 workdays.range，含法定节假日）。
// 把 IO 留在这一层、判定留在纯核，两边各自都能测。
//
// 消费方：/api/ai/chat（工具端点）与 /api/ai/proxy（纯对话端点）。
// 两条链路必须吃同一个函数——否则「我持有 X，成本 C」这句话会在两个端点长成两句不一样的，
// 而用户根本分不清自己走的是哪条路。

import { latestTradeDate } from "./trade-date";
import { tdxTradingDaysBetween } from "./tdx";
import { hasHold, heldTradeDays, renderHoldLine, sanitizeHold } from "./hold-core";

export interface HoldNote {
  /** 拼好的那一句（例：用户持仓：标的 688698，成本价 23.80，建仓日期 2026-09-01（到最近交易日 2026-09-24 已持有 17 个交易日）。） */
  line: string;
}

/**
 * 请求体里的 hold → 注入提示词的那一段。
 * 返回 null 表示「没有可注入的持仓条件」，调用方据此整段不加——不加空壳是纪律，不是可选优化。
 *
 * 日历取不到（网关未启动）时退化成只报建仓日期：宁可少说一个天数，
 * 也不许用「自然日 × 5/7」估一个出来 —— 估出来的数会被模型当事实写进答案。
 */
export async function holdNoteOf(raw: unknown): Promise<HoldNote | null> {
  const hold = sanitizeHold(raw);
  if (!hasHold(hold) || !hold) return null;
  const openDate = hold.openDate ?? "";
  if (!openDate) return { line: renderHoldLine(hold) };
  const tradeDate = await latestTradeDate().catch(() => "");
  if (!tradeDate) return { line: renderHoldLine(hold) };
  // 建仓日期晚于最近交易日（例如填了今天）→ 区间非法，天数按未知处理
  const days = openDate < tradeDate ? await tdxTradingDaysBetween(openDate, tradeDate).catch(() => null) : null;
  return { line: renderHoldLine(hold, { tradeDate, heldDays: heldTradeDays(days, openDate, tradeDate) }) };
}
