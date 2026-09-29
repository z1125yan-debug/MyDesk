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

import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { computeTopPressure } from "@/lib/quant/screener/top-pressure";
import { marketMainNetTdx } from "@/lib/desk/fund-flow";
import type { MainNetTdxClient } from "@/lib/desk/main-net-core";
import { strategyLibrary } from "@/lib/quant/data/strategy-library";
import { packForecast, type GateStrategy } from "@/lib/quant/strategy/strategy-gate-core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FORECAST_TTL_MS = 5 * 60_000;
const SAMPLE_TARGET = 30;

export async function GET() {
  return ttlCache("quant/strategy-forecast", FORECAST_TTL_MS, async () => {
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

    const pack = packForecast({ score, tier, strategies, snapshotRows, target: SAMPLE_TARGET });
    return NextResponse.json({
      ok: true,
      as_of: new Date().toISOString(),
      tier: { score, tier, line: tierLine, components, error: tierError },
      ...pack,
    });
  });
}
