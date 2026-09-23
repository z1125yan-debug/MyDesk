// Quant Screener — 混合取K线层（服务端）
// eltdx（通达信网关，~30ms/只，带量额）优先；失败/数据不足回退 emProvider（腾讯日K）。
// 熔断：eltdx 连续 8 只失败视为网关不可用，本批剩余直接走腾讯（不再逐只等超时）。
//
// P6-A：本层新增「每只股票最终为什么是这个结果」的记录（见 hybrid-core.ts 的判定口径）。
// fetchBarsHybrid 的返回结构、顺序、公式全部不变（0 改动风险）；需要区分「取数失败 / 真的没数据」的
// 调用方改用 fetchBarsHybridTracked，把 outcomeWarning 写进 warnings —— 不再让一次限流伪装成「不符合条件」。
import { tdxDayBars, type TdxDailyBar } from "@/lib/desk/tdx";
import { getProvider } from "./index";
import type { BarsLike } from "../factors/fields.ts";
import { classifyBarOutcome, type BarAttempt, type BarOutcome } from "./hybrid-core.ts";

const TDX_MIN_BARS = 20;
const CIRCUIT_FAILS = 8;

export interface HybridResult {
  bars: Map<string, BarsLike[]>;
  /** 与 bars 同序的逐只观测结论（value / no_data / request_failed） */
  outcomes: BarOutcome[];
  /** 本批是否触发了 eltdx 熔断（网关级降级依据） */
  tdx_down: boolean;
}

export async function fetchBarsHybrid(
  symbols: string[],
  asOf: string,
  lookback: number,
): Promise<Map<string, BarsLike[]>> {
  const r = await fetchBarsHybridTracked(symbols, asOf, lookback);
  return r.bars;
}

export async function fetchBarsHybridTracked(
  symbols: string[],
  asOf: string,
  lookback: number,
): Promise<HybridResult> {
  const out = new Map<string, BarsLike[]>();
  const outcomes: BarOutcome[] = [];
  let consecutiveFail = 0;
  let tdxDown = false;
  const provider = await getProvider("em");
  const count = Math.min(800, Math.max(120, Math.ceil(lookback * 1.35)));
  for (const sym of symbols) {
    let bars: TdxDailyBar[] | null = null;
    if (!tdxDown) {
      try {
        bars = await tdxDayBars(sym, count);
        consecutiveFail = bars && bars.length >= TDX_MIN_BARS ? 0 : consecutiveFail + 1;
        if (consecutiveFail >= CIRCUIT_FAILS) tdxDown = true;
      } catch {
        consecutiveFail++;
        if (consecutiveFail >= CIRCUIT_FAILS) tdxDown = true;
      }
    }
    if (!bars || bars.length < TDX_MIN_BARS) {
      // 腾讯兜底（慢 ~250ms/只，但接口口径稳定）
      try {
        const m = await provider.getBars({ symbols: [sym], tf: "day", asOf, lookback });
        const tcBars = (m.get(sym) ?? []) as BarsLike[];
        out.set(sym, tcBars);
        const attempt: BarAttempt = { symbol: sym, channel: "tencent", ok: true, count: tcBars.length };
        outcomes.push(classifyBarOutcome(attempt));
        continue;
      } catch (e) {
        out.set(sym, []);
        const attempt: BarAttempt = {
          symbol: sym, channel: "tencent", ok: false, count: 0,
          error: `通达信与腾讯两条K线通道均未取到：${(e as Error)?.message ?? "请求失败"}`,
        };
        outcomes.push(classifyBarOutcome(attempt));
        continue;
      }
    }
    const real = bars.filter((b) => b.date <= asOf).slice(-lookback) as BarsLike[];
    out.set(sym, real);
    outcomes.push(classifyBarOutcome({ symbol: sym, channel: "tdx", ok: true, count: real.length }));
  }
  return { bars: out, outcomes, tdx_down: tdxDown };
}
