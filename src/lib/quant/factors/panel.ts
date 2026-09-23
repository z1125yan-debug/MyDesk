// Quant Research Lab — 面板数据（因子计算的统一数据结构）
// 面板 = 日期轴 × 股票轴 的对齐矩阵；缺失值为 null。
// 严格性：只包含 asOf 及之前的数据，因子/指标层因此天然看不到未来。
import type { AssetMeta, Bar, BarsRequest, DataProvider, UniverseSpec } from "../types.ts";

export interface Panel {
  dates: string[]; // 升序交易日轴（日线）
  symbols: string[];
  meta: AssetMeta[]; // 与 symbols 对齐
  // fields[字段名][股票下标][日期下标]；可用字段：o h l c v amount（及 turnover cap pe pb 快照字段按日填充）
  fields: Map<string, (number | null)[][]>;
  industry: (string | null)[]; // 与 symbols 对齐
  coverageNotes: string[]; // 数据降级/幸存者偏差提示
}

export interface PanelRequest {
  universe: UniverseSpec;
  asOf: string;
  lookback: number; // 交易日数
  maxSymbols?: number; // 上限保护（防限流/内存）
  source?: string;
}

export async function buildPanel(provider: DataProvider, req: PanelRequest): Promise<Panel> {
  const maxSymbols = req.maxSymbols ?? 300;
  let metas = await provider.listUniverse(req.universe, req.asOf);
  if (metas.length > maxSymbols) {
    // 按成交额降序取流动性最好的前 maxSymbols 只（研究样本约定，记录于 coverageNotes）
    metas = [...metas]
      .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
      .slice(0, maxSymbols);
  }
  const symbols = metas.map((m) => m.symbol);

  const barsReq: BarsRequest = { symbols, tf: "day", asOf: req.asOf, lookback: req.lookback };
  const barsMap = await provider.getBars(barsReq);

  // 日期轴：取所有符号日期的并集中，出现频次最高的连续段（简化：全部日期并集排序）
  const dateSet = new Set<string>();
  for (const bars of barsMap.values()) for (const b of bars) dateSet.add(b.date);
  const dates = [...dateSet].sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));

  const fieldNames = ["o", "h", "l", "c", "v", "amount"] as const;
  const fields = new Map<string, (number | null)[][]>();
  for (const f of fieldNames) {
    fields.set(f, symbols.map(() => new Array<number | null>(dates.length).fill(null)));
  }

  let symbolsWithData = 0;
  for (let si = 0; si < symbols.length; si++) {
    const bars: Bar[] = barsMap.get(symbols[si]) ?? [];
    if (bars.length) symbolsWithData++;
    for (const b of bars) {
      const di = dateIdx.get(b.date);
      if (di === undefined) continue;
      fields.get("o")![si][di] = b.o;
      fields.get("h")![si][di] = b.h;
      fields.get("l")![si][di] = b.l;
      fields.get("c")![si][di] = b.c;
      fields.get("v")![si][di] = b.v;
      if (b.amount !== undefined) fields.get("amount")![si][di] = b.amount;
    }
  }
  if (symbolsWithData === 0) {
    throw new Error("数据源不可用：全部股票K线拉取失败（大概率被数据源限流），已中止；请稍后重试，或在数据源里改选「演示数据」");
  }

  // 快照字段按日填充（东财 clist 快照：换手/市值/PE/PB；历史快照不可得 → 标注降级）
  const snapFields: [string, keyof AssetMeta][] = [
    ["turnover", "turnover"], ["cap", "marketCap"], ["floatcap", "floatCap"], ["pe", "pe"], ["pb", "pb"],
  ];
  for (const [name, key] of snapFields) {
    fields.set(name, metas.map((m) => dates.map(() => (typeof m[key] === "number" ? (m[key] as number) : null))));
  }

  // 日收益率 ret[t] = c[t+1]/c[t] - 1（作为可引用字段）
  {
    const c = fields.get("c")!;
    fields.set("ret", c.map((series) => series.map((v, t) => (v !== null && series[t + 1] !== null && v > 0 ? series[t + 1]! / v - 1 : null))));
  }

  const coverageNotes: string[] = [];
  if (metas.length > symbols.length) coverageNotes.push(`股票池截断为流动性前 ${maxSymbols} 只`);
  if (symbolsWithData < symbols.length) coverageNotes.push(`${symbols.length - symbolsWithData} 只无K线数据`);
  const cov = provider.coverage();
  if (cov.universeMembership === "current_only") {
    coverageNotes.push("成分股名单为当前快照：历史回放存在幸存者偏差风险（已退市股票不在池中）");
  }
  coverageNotes.push(`基本面字段为当日快照口径（pe/pb/cap/turnover），非历史时点数据`);

  return { dates, symbols, meta: metas, fields, industry: metas.map((m) => m.industry ?? null), coverageNotes };
}

// 日收益率（收盘到收盘）：ret[t] = c[t+1]/c[t] - 1
export function dailyReturns(panel: Panel): (number | null)[][] {
  const c = panel.fields.get("c")!;
  return c.map((series) => series.map((v, t) => (v !== null && series[t + 1] !== null ? series[t + 1]! / v - 1 : null)));
}

// 前向收益（因子标签）：fwd[t] = c[t+h]/c[t] - 1；h 日后无数据 → null
export function forwardReturns(panel: Panel, horizon: number): (number | null)[][] {
  const c = panel.fields.get("c")!;
  return c.map((series) =>
    series.map((v, t) => {
      const future = t + horizon < series.length ? series[t + horizon] : null;
      return v !== null && future !== null && v > 0 ? future / v - 1 : null;
    }),
  );
}
