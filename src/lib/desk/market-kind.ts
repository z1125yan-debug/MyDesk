// 市场分流（A / HK / US）— API / 页面侧的接线层。
//
// 口径唯一事实源是 market-scope-core.ts（LLM 链路已在用）：
// 本文件不另造一套判定，只复用它，并补 API/页面需要的源标注与响应字段。
//   - classifySymbol = inferMarketScopeFromSymbol（只认符号形状，不查库；认不出 → null，不猜）
//   - parseMarketParam = asMarketScope（?market= 白名单，认不出 → null，不默认成 A 股）
//
// 数据源隔离（与 market-scope-core 的事故说明一致，见该文件头注释）：
//   A 股：通达信网关 + 本地 DB（东财/腾讯兜底）；港股：长桥 MCP 港股；
//   美股：长桥 MCP 美股（未接通时回退 Yahoo 公开行情）。
//   A 股接口收到港股/美股符号 → null/missing，不拿它查 A 股库；
//   港股/美股接口收到 A 股符号 → 400/missing，不拿它查长桥；
//   前端切市场时只调该市场的接口，旧市场的数据不清零但不展示、不混算。

import {
  inferMarketScopeFromSymbol,
  asMarketScope,
  MARKET_SCOPE_LABEL,
  MARKET_SCOPE_CURRENCY,
  type MarketScope,
} from "./market-scope-core";

export type MarketKind = MarketScope;

/** A 股符号：6 位数字 + 交易所后缀（SH 沪 / SZ 深 / BJ 北）。 */
export const A_SYMBOL_RE = /^\d{6}\.(SH|SZ|BJ)$/i;
/** 港股符号：5 位数字，可带 .HK。 */
export const HK_SYMBOL_RE = /^\d{5}(\.HK)?$/i;
/** 美股符号：1~6 位字母（可含 .B 这类类别后缀），可带 .US。 */
export const US_SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?(\.US)?$/i;

/**
 * 按符号形态判定市场。返回 null = 认不出市场（调用方按缺失处理，不猜）。
 * 形态约定：.SH/.SZ/.BJ 或裸 6 位数字 = A；.HK 或裸 5 位数字 = HK；
 * .US 或裸字母 = US。实现复用 market-scope-core，与 LLM 链路同一份判定。
 */
export function classifySymbol(symbol: string): MarketKind | null {
  return inferMarketScopeFromSymbol(symbol);
}

export function isASymbol(symbol: string): boolean {
  return classifySymbol(symbol) === "A";
}

/** 解析 ?market= 参数：只认 A / HK / US（大小写不限），其余返回 null（调用方报 400，不默认）。 */
export function parseMarketParam(v: string | null | undefined): MarketKind | null {
  if (v == null) return null;
  return asMarketScope(v.trim().toUpperCase());
}

export const MARKET_META: Record<MarketKind, { label: string; short: string; source: string; currency: string }> = {
  A: { label: MARKET_SCOPE_LABEL.A, short: "A", source: "通达信网关 + 本地 DB（东财/腾讯兜底）", currency: MARKET_SCOPE_CURRENCY.A },
  HK: { label: MARKET_SCOPE_LABEL.HK, short: "HK", source: "长桥 MCP（港股）", currency: MARKET_SCOPE_CURRENCY.HK },
  US: { label: MARKET_SCOPE_LABEL.US, short: "US", source: "长桥 MCP（美股），未接通时回退 Yahoo 公开行情", currency: MARKET_SCOPE_CURRENCY.US },
};

/** 服务端响应统一带 market 字段：让调用方一眼看出这份数是哪个市场的。 */
export function marketField(market: MarketKind): { market: MarketKind; market_label: string; market_source: string } {
  const meta = MARKET_META[market];
  return { market, market_label: meta.label, market_source: meta.source };
}
