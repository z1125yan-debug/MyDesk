// Quant Research Lab — 数据接入契约（数据原则：不绑定具体数据源）
// 量化模块只依赖 DataProvider 接口；具体实现见 em-provider.ts（腾讯/东财）与
// demo-provider.ts（本机确定性演示数据）。数据中心不由本实验室建设。
import type { AssetMeta, BarsRequest, DataCoverage, DataProvider, UniverseSpec } from "../types.ts";

export type { DataProvider, DataCoverage, AssetMeta, UniverseSpec };

// 股票池过滤的公共实现（历史回放与实时选股共用同一实现）
export function applyUniverseFilters(
  metas: AssetMeta[],
  asOf: string,
  filters?: {
    excludeST?: boolean;
    excludeSuspended?: boolean;
    minListDays?: number;
    minMarketCap?: number;
    maxMarketCap?: number;
  },
): { kept: AssetMeta[]; excluded: { st: number; suspended: number; listDays: number; filters: number } } {
  const kept: AssetMeta[] = [];
  const excluded = { st: 0, suspended: 0, listDays: 0, filters: 0 };
  const asOfMs = Date.parse(asOf);
  for (const m of metas) {
    if (filters?.excludeST !== false && m.st) { excluded.st++; continue; }
    if (filters?.excludeSuspended !== false && m.suspended) { excluded.suspended++; continue; }
    if (filters?.minListDays && m.listDate) {
      const listedMs = Date.parse(m.listDate);
      if (isFinite(asOfMs) && isFinite(listedMs) && (asOfMs - listedMs) / 86400000 < filters.minListDays) {
        excluded.listDays++;
        continue;
      }
    }
    if (filters?.minMarketCap && m.marketCap && m.marketCap < filters.minMarketCap) { excluded.filters++; continue; }
    if (filters?.maxMarketCap && m.marketCap && m.marketCap > filters.maxMarketCap) { excluded.filters++; continue; }
    kept.push(m);
  }
  return { kept, excluded };
}

// 合同自检：两个 Provider 之间的公共行为断言（测试用）
export async function assertProviderContract(p: DataProvider, asOf: string): Promise<string[]> {
  const problems: string[] = [];
  const universe = await p.listUniverse({ kind: "all" }, asOf);
  if (!universe.length) problems.push("listUniverse(all) 返回空");
  for (const m of universe) {
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(m.symbol)) { problems.push(`非法符号 ${m.symbol}`); break; }
    if (m.listDate && m.listDate > asOf) { problems.push(`listDate 晚于 asOf：${m.symbol}`); break; }
  }
  const sample = universe.slice(0, 5).map((m) => m.symbol);
  const bars = await p.getBars({ symbols: sample, tf: "day", asOf, lookback: 30 });
  for (const [sym, arr] of bars) {
    if (!arr.length) { problems.push(`${sym} K线为空`); continue; }
    for (const b of arr) {
      if (b.date.slice(0, 10) > asOf) { problems.push(`发现未来数据：${sym} ${b.date} > asOf ${asOf}`); break; }
    }
  }
  return problems;
}
