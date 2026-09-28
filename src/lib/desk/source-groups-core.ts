// P30 稳智对齐 P2 #13：数据源面板核心逻辑（classifyStep + groupStepsBySource）
//
// 与 SourceStrip.tsx 保持同步的分组规则。核心逻辑抽到这里，方便单元测试
// 独立验证分组口径（不需要渲染 DOM）。

import type { StepInfo } from "./chat-core";

export type SourceGroupKey = "news" | "quote" | "kline" | "fund" | "other";

const NEWS_TOOLS = new Set([
  "stock_news", "market_news",
]);

const QUOTE_TOOLS = new Set([
  "stock_snapshot", "tdx_quotes", "stock_depth", "stock_trades", "tdx_market_overview",
]);

const KLINE_TOOLS = new Set([
  "stock_kline_summary", "tdx_kline",
]);

const FUND_TOOLS = new Set([
  "stock_fund_flow", "market_sentiment", "historical_probability",
]);

/**
 * 把 tool 名映射到数据源分类。
 * 不认识的 tool 归 "other"。
 */
export function classifyStep(tool: string | undefined): SourceGroupKey {
  if (!tool) return "other";
  if (NEWS_TOOLS.has(tool)) return "news";
  if (QUOTE_TOOLS.has(tool)) return "quote";
  if (KLINE_TOOLS.has(tool)) return "kline";
  if (FUND_TOOLS.has(tool)) return "fund";
  return "other";
}

/**
 * 把扁平 steps 数组按数据源分类分组。
 * 只显示已核验的状态（ok/missing/stale），跳过 running/error。
 */
export function groupStepsBySource(steps?: StepInfo[]): Record<SourceGroupKey, StepInfo[]> {
  const result: Record<SourceGroupKey, StepInfo[]> = {
    news: [], quote: [], kline: [], fund: [], other: [],
  };
  if (!steps) return result;
  for (const s of steps) {
    if (s.status === "running" || s.status === "error") continue;
    const key = classifyStep(s.tool);
    result[key].push(s);
  }
  return result;
}
