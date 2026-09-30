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
import fs from "fs";
import path from "path";
import { ttlCache } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { computeTopPressure } from "@/lib/quant/screener/top-pressure";
import { marketMainNetTdx } from "@/lib/desk/fund-flow";
import type { MainNetTdxClient } from "@/lib/desk/main-net-core";
import { strategyLibrary } from "@/lib/quant/data/strategy-library";
import { packForecast, type GateStrategy } from "@/lib/quant/strategy/strategy-gate-core";
// P34-2：分档回测推荐（治「非高风险日恒空」）——口径只有 regime-core 一处，这里只接线
import { regimeAt } from "@/lib/quant/strategy/regime-core";
import { regimeLibrary } from "@/lib/quant/strategy/regime-library";
import { fetchKlinesReal } from "@/lib/desk/em";
import { shanghaiDate } from "@/lib/desk/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FORECAST_TTL_MS = 5 * 60_000;
const SAMPLE_TARGET = 30;
/** 大盘档位判据：上证指数日线（与调度器判交易日同源，不另起一套指数） */
const INDEX_SYMBOL = "000001.SH";

// ---------- P3 使用台账（2026-09-30） ----------
// 弹卡此前只展示不记账，「跟着推荐走到底赚没赚」无从回答，Brier/胜率回收缺一半。
// 口径：展示即承诺——弹卡给出的每条推荐落一行（含组合拆成员），同日同策略同来源 upsert 不翻倍；
// 次日靶=全市场中位个股收盘涨跌幅（daily_snapshot.nextDayMktChg 同源），回填后即可算跟单胜率。
// 注意这是「展示留痕」不是「用户操作记录」——用户没点「选它」也记。
interface PickRow {
  tradeDate: string; regime: string; tierScore: number | null;
  strategyId: number; strategyName: string; source: string;
  statN: number | null; statWin: number | null; statAvg: number | null;
}

async function recordPicks(rows: PickRow[]): Promise<void> {
  for (const r of rows) {
    await db.strategyPick.upsert({
      where: { tradeDate_strategyId_source: { tradeDate: r.tradeDate, strategyId: r.strategyId, source: r.source } },
      create: r,
      update: { regime: r.regime, tierScore: r.tierScore, statN: r.statN, statWin: r.statWin, statAvg: r.statAvg },
    });
  }
}

/** 把已有 T+1 读数回填到还没回填的历史 picks；返回回填行数 */
async function backfillPicks(): Promise<number> {
  const snaps = await db.dailySnapshot.findMany({
    where: { nextDayMktChg: { not: null } },
    select: { tradeDate: true, nextDayMktChg: true },
    orderBy: { tradeDate: "desc" },
    take: 400,
  });
  let n = 0;
  for (const s of snaps) {
    const chg = s.nextDayMktChg;
    if (chg == null) continue;
    const r = await db.strategyPick.updateMany({
      where: { tradeDate: s.tradeDate, nextDayMktChg: null },
      data: { nextDayMktChg: chg, nextDayUp: chg > 0, backfilledAt: new Date() },
    });
    n += r.count;
  }
  return n;
}

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
      basis?: { entry?: string; exit?: string; cost?: string; costAdjusted?: boolean; untradeable?: string; split?: string; caveat?: string };
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
      // 直接读数据文件里算好的榜单，不在接口里再排一遍——刻度只有一处（regime-core + build 脚本）。
      // 踩过：这里曾写死 { minHits: 20, minTotal: 30 } 把 regime-core 的 100/150 盖掉，
      // 导致删掉 43 条涨停策略后 n=29 的噪音照样占榜首（胜率 48.3% 排第 1）；
      // 而且现算出来的 items 没有 winCi（CI 是加载层 enrichWinCi 加的）。
      const ranked = { items: (r && lib?.rank?.[r] ? lib.rank[r] : []).slice(0, 5) };
      // P34-4（2026-09-30）：样本外检验警示。validate-regime-oos.ts（前70%训练/后30%检验）结论：
      // 档位排序**不保序**（弱势期全A中位次日收益反而为正）——排序参考价值有限，必须让用户看到，
      // 不能只躺在脚本和 worklog 里。
      let oosNote = "";
      try {
        const oos = JSON.parse(
          fs.readFileSync(path.join(process.cwd(), "data", "regime-oos-report.json"), "utf-8"),
        ) as { verdict?: string; trainOrder?: string[]; testOrder?: string[] };
        // 文案说人话（第 0 节硬约束）：界面不许出现「样本外/保序/强弱差」这类黑话
        if (oos.verdict === "partial") {
          oosNote = `历史检验：拿前 70% 的时间挑出来的强弱顺序（${oos.trainOrder?.join("＞")}），在后面 30% 的时间里变了（${oos.testOrder?.join("＞")}）——大盘强的时候次日未必比弱的时候赚得多，本榜只供复盘，不构成「按档选策略就更赚」的承诺`;
        } else if (oos.verdict === "kept") {
          oosNote = "历史检验：拿前一段挑出来的强弱顺序，在后一段时间里依然成立";
        } else if (oos.verdict === "reversed") {
          oosNote = "历史检验：强弱顺序在后一段时间里反过来了，本榜排名参考价值低，只供复盘";
        }
      } catch { /* 报告不存在就不加警示（首跑前） */ }
      regime = {
        regime: r,
        asOf: idx >= 0 ? dates[idx] ?? null : null,
        isReplay: !!dateParam,
        items: ranked.items,
        method: lib?.regimeMethod ?? "上证指数 MA20 趋势法",
        window: lib ? `${lib.window.universe} 只 × 约 ${lib.window.bars} 根日K（${lib.window.note}）` : "",
        note: [lib?.thresholds?.note ?? "", oosNote].filter(Boolean).join("；"),
        // P36-B：把「成交价/手续费/时间切分」的口径一起给前端——
        // 页面每个胜率/收益旁都要带口径，裸数字不许出门。
        basis: lib?.basis,
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

    // ⑤ P3 使用台账：只对「今天」记（历史回放是复盘不是当时的建议，不污染台账）；写失败不影响预测返回
    if (!dateParam) {
      try {
        const td = shanghaiDate();
        const rows: PickRow[] = [];
        for (const it of regime.items as { id: number; name: string; stat?: { n?: number; win?: number; avg?: number } }[]) {
          rows.push({
            tradeDate: td, regime: regime.regime ?? "", tierScore: score,
            strategyId: it.id, strategyName: it.name, source: "regime",
            statN: it.stat?.n ?? null, statWin: it.stat?.win ?? null, statAvg: it.stat?.avg ?? null,
          });
        }
        for (const it of pack.items) {
          for (const id of it.memberIds) {
            rows.push({
              tradeDate: td, regime: regime.regime ?? "", tierScore: score,
              strategyId: id, strategyName: it.kind === "single" ? it.name : `${it.name}·组合成员`,
              source: "gate", statN: null, statWin: null, statAvg: null,
            });
          }
        }
        if (rows.length) await recordPicks(rows);
        await backfillPicks();
      } catch { /* 台账写失败不影响预测返回 */ }
    }

    return NextResponse.json({
      ok: true,
      as_of: new Date().toISOString(),
      tier: { score, tier, line: tierLine, components, error: tierError },
      ...pack,
      regime,
    });
  });
}
