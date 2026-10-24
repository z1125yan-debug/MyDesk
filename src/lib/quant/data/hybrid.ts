// Quant Screener — 混合取K线层（服务端）
// eltdx（通达信网关，~30ms/只，带量额）优先；失败/数据不足回退 emProvider（腾讯日K）。
// 熔断：eltdx 连续 8 只失败视为网关不可用，本批剩余直接走腾讯（不再逐只等超时）。
//
// P6-A：本层新增「每只股票最终为什么是这个结果」的记录（见 hybrid-core.ts 的判定口径）。
// fetchBarsHybrid 的返回结构、顺序、公式全部不变（0 改动风险）；需要区分「取数失败 / 真的没数据」的
// 调用方改用 fetchBarsHybridTracked，把 outcomeWarning 写进 warnings —— 不再让一次限流伪装成「不符合条件」。
import { tdxDayBars, type TdxDailyBar } from "@/lib/desk/tdx";
import { getProvider } from "./index";
import { sinaDayBars } from "./sina-kline";
import type { BarsLike } from "../factors/fields.ts";
import { classifyBarOutcome, type BarAttempt, type BarOutcome } from "./hybrid-core.ts";

const TDX_MIN_BARS = 20;
// 2026-10-23 与本地修复对齐（本地 WorkBuddy 实证）：8 太敏感——网关 502 突发抖动连续 8 只
// 就判死整批，剩余全市场掉到腾讯日K（无成交额）→ VWAP/成本族整列算空。改 24 + 单只重试
// + 熔断后半开探测（见 fetchBarsHybridTracked）。
const CIRCUIT_FAILS = 24;
/** 熔断后每跳过这么多只，拿下一只当探针再试一次 TDX：通了整批拉回主通道 */
const HALF_OPEN_EVERY = 250;
/** 腾讯日K对北交所（.BJ）实测只返回 1 根 → 低于这个根数就再试新浪源 */
const TC_MIN_BARS = 5;

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
  // 全A 几千只逐只拉K线，串行循环（30~250ms/只）会把一次筛选拖到分钟级：
  // 改成固定并发池（TDX_GATEWAY 是本机网关，6 路实测无压力；腾讯兜底量在熔断正常时占比很小）。
  // 熔断语义：连续 CIRCUIT_FAILS 只 TDX 失败（单只先重试一次）→ tdxDown=true，此后股票
  // 直接走腾讯兜底；但每跳过 HALF_OPEN_EVERY 只半开探测一次，网关恢复就整批拉回主通道。
  const CONCURRENCY = 6;
  const outcomes: BarOutcome[] = new Array(symbols.length);
  let consecutiveFail = 0;
  let tdxDown = false;
  let skippedSinceProbe = 0;
  let cursor = 0;
  const provider = await getProvider("em");
  const count = Math.min(800, Math.max(120, Math.ceil(lookback * 1.35)));

  /** TDX 取数：失败/根数不足先重试一次再判死（502 抖动不直接记成「没K线」） */
  const tryTdx = async (sym: string): Promise<TdxDailyBar[] | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const b = await tdxDayBars(sym, count);
        if (b && b.length >= TDX_MIN_BARS) return b;
      } catch {
        // 落到重试/判死逻辑
      }
    }
    return null;
  };

  const fetchOne = async (sym: string, idx: number): Promise<void> => {
    let bars: TdxDailyBar[] | null = null;
    // 半开探测：熔断中每跳过 HALF_OPEN_EVERY 只，拿当前这只探一次；通了整批回主通道。
    let probe = false;
    if (tdxDown) {
      skippedSinceProbe++;
      if (skippedSinceProbe >= HALF_OPEN_EVERY) {
        skippedSinceProbe = 0;
        probe = true;
      }
    }
    if (!tdxDown || probe) {
      bars = await tryTdx(sym);
      if (bars) {
        consecutiveFail = 0;
        tdxDown = false;
      } else if (!tdxDown) {
        consecutiveFail++;
        if (consecutiveFail >= CIRCUIT_FAILS) tdxDown = true;
      }
    }
    if (!bars || bars.length < TDX_MIN_BARS) {
      // 腾讯兜底（慢 ~250ms/只，但接口口径稳定）
      let tcBars: BarsLike[] = [];
      try {
        const m = await provider.getBars({ symbols: [sym], tf: "day", asOf, lookback });
        tcBars = (m.get(sym) ?? []) as BarsLike[];
      } catch {
        tcBars = [];
      }
      // 第三级兜底：新浪日K。
      // 触发条件：腾讯也没拿到足够根数（北交所实测只有 1 根）——没有它，
      // 北交所 344 只股票的 K线类字段（形态/趋势压力线/均线）会整列为 null。
      if (tcBars.length < TC_MIN_BARS) {
        try {
          const sb = await sinaDayBars(sym, count);
          const real = sb.filter((b) => b.date <= asOf).slice(-lookback);
          if (real.length >= TC_MIN_BARS) {
            out.set(sym, real);
            outcomes[idx] = classifyBarOutcome({ symbol: sym, channel: "sina", ok: true, count: real.length });
            return;
          }
          // 新浪也不够 → 保留腾讯拿到的（哪怕是 1 根），但如实记录为数据不足
          out.set(sym, tcBars);
          outcomes[idx] = classifyBarOutcome({ symbol: sym, channel: "sina", ok: false, count: real.length, error: `新浪日K仅 ${real.length} 根，不足 ${TC_MIN_BARS} 根` });
          return;
        } catch (e) {
          out.set(sym, tcBars);
          if (tcBars.length) {
            outcomes[idx] = classifyBarOutcome({ symbol: sym, channel: "tencent", ok: true, count: tcBars.length });
          } else {
            outcomes[idx] = classifyBarOutcome({
              symbol: sym, channel: "sina", ok: false, count: 0,
              error: `通达信、腾讯、新浪三条K线通道均未取到：${(e as Error)?.message ?? "请求失败"}`,
            });
          }
          return;
        }
      }
      out.set(sym, tcBars);
      outcomes[idx] = classifyBarOutcome({ symbol: sym, channel: "tencent", ok: true, count: tcBars.length });
      return;
    }
    const real = bars.filter((b) => b.date <= asOf).slice(-lookback) as BarsLike[];
    out.set(sym, real);
    outcomes[idx] = classifyBarOutcome({ symbol: sym, channel: "tdx", ok: true, count: real.length });
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= symbols.length) return;
        await fetchOne(symbols[i]!, i);
      }
    }),
  );
  return { bars: out, outcomes, tdx_down: tdxDown };
}
