// GET /api/quant/strategy-forecast —— 「预测」按钮的数据源（量化选股页，筛选按钮左边那颗）。
//
// 聚合三路：
//   ① 今日见顶压力分（0–100 + 档位 + 六分量读数）：computeSentiment + computeTopPressure，
//      与 /api/market/sentiment 同一套算法。冷启动 15~25s（一次全A快照+通达信主力净额），
//      进程内 TTL 缓存 5 分钟——档位不需要 55 秒级新鲜度，用户点「预测」时基本命中热缓存。
//   ② 社区策略闸门：data/strategies.json（纯本地只读）× 档位分 → 143 条带前提的策略逐条判定，
//      外加「组合/单条」推荐打包（纯核 packForecast）。
//   ③ 攒样本进度：daily_snapshot 行数（Prisma count）——概率列 v1 只报进度不出数字。
//
// 纪律：
// - 档位分算不出来 → tier.error 带原因、items=[]，前端如实显示「档位分没算出来」，不猜；
// - 每条推荐的 record 恒 null（还没建使用台账），绝不把市场级概率复制到单条头上；
// - 不给仓位建议、不给买卖指令——这个接口只回答「今天哪些策略的前提成立」。

import { NextRequest, NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { computeTopPressure } from "@/lib/quant/screener/top-pressure";
import { marketMainNetTdx } from "@/lib/desk/fund-flow";
import type { MainNetTdxClient } from "@/lib/desk/main-net-core";
import { strategyLibrary } from "@/lib/quant/data/strategy-library";
import { packForecast, type GateStrategy } from "@/lib/quant/strategy/strategy-gate-core";
// P34-2：分档回测推荐（治「非高风险日恒空」）——口径只有 regime-core 一处，这里只接线
import { regimeAt, regimeRankOf } from "@/lib/quant/strategy/regime-core";
import { regimeLibrary, regimeRows } from "@/lib/quant/strategy/regime-library";
import { fetchKlinesReal } from "@/lib/desk/em";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FORECAST_TTL_MS = 5 * 60_000;
const SAMPLE_TARGET = 30;
/** 大盘档位判据：上证指数日线（与调度器判交易日同源，不另起一套指数） */
const INDEX_SYMBOL = "000001.SH";

export async function GET(req: NextRequest) {
  // P34：?date=YYYY-MM-DD = 历史回放（看那天该用什么策略）；不传 = 今天。
  // 回放与实况分开缓存，别用同一把 key 互相顶掉。
  const dateParam = (req.nextUrl.searchParams.get("date") ?? "").trim() || null;
  const cacheKey = `quant/strategy-forecast${dateParam ? `?date=${dateParam}` : ""}`;
  return ttlCache(cacheKey, FORECAST_TTL_MS, async () => {
    quantBootstrap();

    // ① 档位分：失败不拖垮整条接口——降级为 score=null，策略闸门按「待判」发
    let score: number | null = null;
    let tier = "";
    let tierLine = "";
    let components: { name: string; score: number | null; available: boolean; reading: string }[] = [];
    let tierError = "";
    try {
      const data = await computeSentiment();
      const tdx = await marketMainNetTdx();
      const p = await computeTopPressure(data, (tdx as { main_net_tdx?: MainNetTdxClient }).main_net_tdx ?? null);
      score = p.pressure.score;
      tier = p.pressure.tier ?? "";
      tierLine = p.pressure.line;
      components = p.pressure.components.map((c) => ({
        name: c.name, score: c.score, available: c.available, reading: c.reading,
      }));
    } catch (e) {
      tierError = `档位分没算出来：${(e as Error).message}`;
    }

    // ② 策略闸门 + 推荐打包（纯核）
    const strategies: GateStrategy[] = strategyLibrary().map((s) => ({
      id: s.id,
      name: s.name,
      like: s.like ?? 0,
      dislike: s.dislike ?? 0,
      n_mapped: s.n_mapped,
      threshold: (s.backtest_params?.sentiment_threshold as number | undefined) ?? null,
      mode: (s.backtest_params?.sentiment_mode as string | undefined) ?? ">=",
    }));

    // ③ 攒样本进度（读失败按 0，进度行照发）
    let snapshotRows = 0;
    try {
      snapshotRows = await db.dailySnapshot.count();
    } catch {
      snapshotRows = 0;
    }

    // ④ 大盘档位（上证 MA20 趋势法）+ 该档回测排名（P34-2）
    // 为什么单独一路：档位分（0–100 压力分）越高=市场越危险，而它判「过不过闸」用的是社区拍的门槛
    // （最低 50，正常市况永远够不到 → 推荐恒空）。分档回测走的是另一条线：
    // 按大盘强/震/弱直接给该档历史表现最好的几条，理由行写真实命中数与胜率，不依赖那些门槛。
    let regime: {
      regime: string | null; asOf: string | null; isReplay: boolean; items: unknown[];
      method: string; window: string; note: string; error: string;
    } = {
      regime: null, asOf: null, isReplay: !!dateParam, items: [], method: "", window: "", note: "", error: "",
    };
    try {
      const ks = await fetchKlinesReal(INDEX_SYMBOL, "day", 160);
      const bars = ks ?? [];
      const closes = bars.map((k) => k.c);
      const dates = bars.map((k) => k.date);
      // 定位：回放=找该日期下标（不在序列里=不是交易日/无行情，如实说，不往前凑最近一天）
      const idx = dateParam ? dates.indexOf(dateParam) : dates.length - 1;
      const r = idx >= 0 ? regimeAt(closes, idx) : null;
      const lib = regimeLibrary();
      const ranked = regimeRankOf(regimeRows(), r, { minHits: 20, minTotal: 30, limit: 5 });
      regime = {
        regime: r,
        asOf: idx >= 0 ? dates[idx] ?? null : null,
        isReplay: !!dateParam,
        items: ranked.items,
        method: lib?.regimeMethod ?? "上证指数 MA20 趋势法",
        window: lib ? `${lib.window.universe} 只 × 约 ${lib.window.bars} 根日K（${lib.window.note}）` : "",
        note: lib?.thresholds?.note ?? "",
        error: !lib
          ? "回测榜没读到（data/strategy-regime.json 缺失），本区不显示排名"
          : idx < 0
            ? (dateParam ? `${dateParam} 不在上证日K序列里（可能非交易日），无法回放` : "上证日K不足，档位算不出")
            : r == null
              ? "MA20 不足 20 根，档位算不出"
              : "",
      };
    } catch (e) {
      regime.error = `档位/回测榜读取失败：${(e as Error).message}`;
    }

    const pack = packForecast({ score, tier, strategies, snapshotRows, target: SAMPLE_TARGET });
    return NextResponse.json({
      ok: true,
      as_of: new Date().toISOString(),
      tier: { score, tier, line: tierLine, components, error: tierError },
      ...pack,
      regime,
    });
  });
}
