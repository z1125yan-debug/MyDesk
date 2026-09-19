// Quant Screener — 混合取K线层（服务端）
// eltdx（通达信网关，~30ms/只，带量额）优先；失败/数据不足回退 emProvider（腾讯日K）。
// 熔断：eltdx 连续 8 只失败视为网关不可用，本批剩余直接走腾讯（不再逐只等超时）。
import { tdxDayBars, type TdxDailyBar } from "@/lib/desk/tdx";
import { getProvider } from "./index";
import type { BarsLike } from "../factors/fields.ts";

export async function fetchBarsHybrid(
  symbols: string[],
  asOf: string,
  lookback: number,
): Promise<Map<string, BarsLike[]>> {
  const out = new Map<string, BarsLike[]>();
  let consecutiveFail = 0;
  let tdxDown = false;
  const provider = await getProvider("em");
  const count = Math.min(800, Math.max(120, Math.ceil(lookback * 1.35)));
  for (const sym of symbols) {
    let bars: TdxDailyBar[] | null = null;
    if (!tdxDown) {
      try {
        bars = await tdxDayBars(sym, count);
        consecutiveFail = bars && bars.length >= 20 ? 0 : consecutiveFail + 1;
        if (consecutiveFail >= 8) tdxDown = true;
      } catch {
        consecutiveFail++;
        if (consecutiveFail >= 8) tdxDown = true;
      }
    }
    if (!bars || bars.length < 20) {
      // 腾讯兜底（慢 ~250ms/只，但接口口径稳定）
      try {
        const m = await provider.getBars({ symbols: [sym], tf: "day", asOf, lookback });
        const tcBars = (m.get(sym) ?? []) as BarsLike[];
        out.set(sym, tcBars);
        continue;
      } catch {
        out.set(sym, []);
        continue;
      }
    }
    out.set(sym, bars.filter((b) => b.date <= asOf).slice(-lookback) as BarsLike[]);
  }
  return out;
}
