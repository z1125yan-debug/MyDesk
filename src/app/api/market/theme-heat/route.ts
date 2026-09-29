// GET /api/market/theme-heat?date=YYYY-MM-DD — 主题热度（能力分层）：
// ① date=今天 → 本地实时规则计算（板块涨幅贡献50(封顶5%) + 主力资金贡献30(封顶20亿) + RPS贡献20）；
// ② date=2026-09-24 → 离线快照种子（抓取快照，含原版市场环境推理）；
// ③ 其他历史日期 → 热度榜如实返回「无数据」（S2 攒数接入后自动补齐），不造假；
//    但市场环境推理（inferMarketEnv）对所有复盘种子覆盖内的日期都给——
//    输入口径复刻参考站（4 日宽度序列 + 当日情绪读数 + 连板极值），模板化生成、不接 LLM。
import { NextResponse } from "next/server";
import { fetchBoardRowsRescuedV2 } from "@/lib/desk/board-rescue";
import { inferMarketEnv } from "@/lib/quant/review/market-inference";
import { newsWindowLabel } from "@/lib/quant/review/theme-news-core";
import seed from "@/lib/quant/review/theme-heat-seed.json";
import reviewSeed from "@/lib/quant/review/review-stats-seed.json";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";

type HeatItem = { n: string; h: number; pct: number; f: number };

function shanghaiDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// 新闻窗口的「哪三天」也在这里定死（单一出处）：复盘种子 ≤ 请求日的最近 3 个交易日。
// 为什么用种子而不是现算交易日：快讯窗口要与主题卡的「3 日资金」同周期，两者都锚在复盘日历上；
// S2 回填引擎续写种子后这里自动跟着走，不需要改代码。
const REVIEW_DATES: string[] = (reviewSeed as unknown as (string | number)[][])
  .map((r) => String(r[0]))
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .sort();

export function newsWindowDates(date: string): string[] {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  const pool = d ? REVIEW_DATES.filter((x) => x <= d) : REVIEW_DATES;
  return pool.slice(-3);
}

async function computeHeat(kind: "industry" | "concept"): Promise<HeatItem[]> {
  const [inRes, outRes] = await Promise.all([
    fetchBoardRowsRescuedV2(kind, "in", 200),
    fetchBoardRowsRescuedV2(kind, "out", 200),
  ]);
  const merged = new Map<string, RankRowLike>();
  for (const r of [...(inRes.rows ?? []), ...(outRes.rows ?? [])]) {
    if (r.code && !merged.has(r.code)) merged.set(r.code, r);
  }
  return [...merged.values()].map((b) => {
    const pct = typeof b.changePct === "number" ? b.changePct : 0;
    const main = typeof b.main === "number" ? b.main : 0;
    const rps = typeof b.rps === "number" ? b.rps : 0;
    // 热度（本地规则，透明可复核）= 涨幅贡献50(封顶5%) + 主力资金贡献30(封顶20亿) + RPS贡献20
    const h = Math.round(50 * Math.min(Math.max(pct, 0) / 5, 1) + 30 * Math.min(Math.max(main, 0) / 20, 1) + 20 * Math.min(rps, 100) / 100);
    return { n: b.name ?? "", h, pct, f: main };
  }).sort((a, b) => b.h - a.h);
}

interface RankRowLike {
  code?: string; name?: string; changePct?: number; main?: number; rps?: number;
}

/**
 * 2026-09-29 菜单打开提速：本路由算一次要几秒（实测冷启动 1.3~6 秒），
 * 而菜单/切页会反复打它。包一层进程内 TTL 缓存（默认 60s，与页面轮询同档）：
 * 第二次起直接命中热缓存（几十毫秒），响应里的 asOf/tradeDate 照旧如实标数据时间。
 */
export async function GET(req: Request) {
  return ttlCache(`market/theme-heat${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  const date = (new URL(req.url).searchParams.get("date") ?? "").trim();
  const today = shanghaiDateStr(new Date());
  // 新闻窗口（近 3 个交易日）随每一路响应一起给，前端不用自己再算「哪三天」
  const newsDates = newsWindowDates(date || today);
  const newsWindow = { dates: newsDates, label: newsWindowLabel(newsDates) };

  if (date === seed.as_of_news_date) {
    return NextResponse.json({
      ok: true, date, source: `离线快照种子（${seed.as_of_news_date} 抓取）`,
      industries: seed.industries, concepts: seed.concepts,
      market_env: seed.market_env, inference: seed.inference,
      news_window: newsWindow,
    });
  }

  // 市场环境推理：所有复盘种子覆盖内的请求都给（休市日请求“今天”时，落到最近一个有读数的交易日）
  const inference = inferMarketEnv(date || today);
  const marketEnv = inference
    ? { as_of_trade_date: inference.as_of_date, label: inference.market_bucket }
    : undefined;

  if (!date || date === today) {
    try {
      const [ind, con] = await Promise.all([computeHeat("industry"), computeHeat("concept")]);
      const allZero = ind.every((x) => x.h === 0);
      if (allZero) {
        return NextResponse.json({
          ok: true, date: today, empty: true,
          note: "当日尚未产生盘面数据（开盘后自动生成；可先查看最近已完成交易日）",
          // 休市/盘前热度榜为空，但市场环境读数照给（最近交易日口径）
          ...(inference ? { inference, market_env: marketEnv } : {}),
          news_window: newsWindow,
        });
      }
      return NextResponse.json({
        ok: true, date: today, source: "本地实时规则计算（板块涨幅50+资金30+RPS20）",
        industries: ind, concepts: con,
        ...(inference ? { inference, market_env: marketEnv } : {}),
        news_window: newsWindow,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: `热度计算失败：${(e as Error).message}` }, { status: 502 });
    }
  }

  return NextResponse.json({
    ok: true, date, empty: true,
    note: "该日期无主题热度数据（历史板块快照由 S2 攒数接入后自动补齐）",
    ...(inference ? { inference, market_env: marketEnv } : {}),
    news_window: newsWindow,
  });
}
