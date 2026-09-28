// 大盘趋势数据（P15-R2a 对齐稳智「市场情绪分析」页的图表区；2026-09-25 数据源去东财化）：
// 主源 eltdx 通达信日K（自带成交额）+ 腾讯兜底。两市成交额按日合计 + vs昨日
// + 7 指数逐日涨跌幅（idx）+ 三指数区间累计涨跌（cum，兼容保留）。
// 缺数如实报：一条指数没取到就是 missing 登记，不拿别的凑图。
//
// 本地快照缓存（2026-09-25 增）：成交额主源是本机 eltdx 网关（手动启动的进程）。
// 网关没起来时腾讯备源不含成交额，图会只剩当日一根柱。因此只要当天成功取到过完整数据，
// 就落一份本地快照；之后上游取数不完整时**直接回放快照**，无论网关是否在跑都能看到同一张图。
import { NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import {
  fetchIndexDayBars, fetchTodayAmountYi, INDEX_CATALOG, SH_SYMBOL, SZ_SYMBOL, CYB_SYMBOL, BJ_SYMBOL,
} from "@/lib/quant/screener/market-trend";
import { mergeTurnover, turnoverDeltaVsPrev, cumReturnSeries, inRange, trendNotes } from "@/lib/quant/screener/market-trend-core";
import {
  saveTrendSnapshot, getTrendSnapshot, countTurnoverDays, MIN_USABLE_DAYS,
} from "@/lib/desk/market-trend-cache";

export const dynamic = "force-dynamic";

function shanghaiDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  return ttlCache(`market/trend?${new URL(req.url).search}`, DEFAULT_TTL_MS, () => getHandler(req));
}
async function getHandler(req: Request) {
  quantBootstrap();
  const url = new URL(req.url);
  // 只认 YYYY-MM-DD；认不出的输入一律按「不设边」处理，不把脏串递进上游
  const rawFrom = url.searchParams.get("from") ?? "";
  const rawTo = url.searchParams.get("to") ?? "";
  const from = DATE_RE.test(rawFrom) ? rawFrom : "";
  const to = DATE_RE.test(rawTo) ? rawTo : "";
  // 默认窗口：今天往前 90 个自然日（够画稳智那种月级柱图），结束日不传=至今
  const defFrom = from || shanghaiDateStr(new Date(Date.now() - 90 * 864e5));
  const defTo = to || shanghaiDateStr(new Date());
  // 成交额 MA5 需要窗口前 4 根历史参与平均（稳智同款）：取数起点比窗口提前 20 个自然日
  const extFrom = shanghaiDateStr(new Date(new Date(`${defFrom}T00:00:00+08:00`).getTime() - 20 * 864e5));

  try {
    // 目录指数并行取（eltdx 本地网关 ~30ms/只；腾讯兜底时也是一次性并发）
    const catalog = await Promise.all(
      INDEX_CATALOG.map(async (e) => {
        try {
          const r = await fetchIndexDayBars(e.symbol, extFrom, defTo);
          // 不在取数层截窗：成交额 MA5 需要窗口前 4 根历史才能在窗口第一天就有值（稳智同款）
          return { ...e, bars: r.bars, source: r.source };
        } catch {
          return { ...e, bars: [] as Awaited<ReturnType<typeof fetchIndexDayBars>>["bars"], source: "none" as const };
        }
      }),
    );
    const barsOf = (symbol: string) => catalog.find((c) => c.symbol === symbol) ?? { bars: [], source: "none" as const };
    const sh = barsOf(SH_SYMBOL);
    const sz = barsOf(SZ_SYMBOL);
    const cyb = barsOf(CYB_SYMBOL);
    const bj = barsOf(BJ_SYMBOL);

    // 今日成交额兜底：eltdx 没给今日一根时，用 stock-sdk（腾讯快照）补上，让图至少有今日柱
    const [todaySh, todaySz, todayBj] = await Promise.all([
      fetchTodayAmountYi(SH_SYMBOL),
      fetchTodayAmountYi(SZ_SYMBOL),
      fetchTodayAmountYi(BJ_SYMBOL),
    ]);
    const todayDate = todaySh?.date ?? todaySz?.date ?? todayBj?.date;
    let shForTurnover = sh.bars.filter((b) => Number.isFinite(b.amountYi));
    let szForTurnover = sz.bars.filter((b) => Number.isFinite(b.amountYi));
    let bjForTurnover = bj.bars.filter((b) => Number.isFinite(b.amountYi));
    const todayAppended: string[] = [];
    if (todayDate && !shForTurnover.some((b) => b.date === todayDate) && todaySh) {
      shForTurnover = [...shForTurnover, { date: todayDate, close: 0, amountYi: todaySh.amountYi }];
      todayAppended.push("sh");
    }
    if (todayDate && !szForTurnover.some((b) => b.date === todayDate) && todaySz) {
      szForTurnover = [...szForTurnover, { date: todayDate, close: 0, amountYi: todaySz.amountYi }];
      todayAppended.push("sz");
    }
    if (todayDate && !bjForTurnover.some((b) => b.date === todayDate) && todayBj) {
      bjForTurnover = [...bjForTurnover, { date: todayDate, close: 0, amountYi: todayBj.amountYi }];
      todayAppended.push("bj");
    }

    // 沪深北合计：沪 + 深 + 北证50。北证取不到时自动退化为沪深两市（bj 传空数组即关闭北证口径），
    // 并在 source/missing 里如实标注，绝不拿沪深冒充沪深北。
    const useBj = bjForTurnover.length > 0;
    const pts = mergeTurnover(shForTurnover, szForTurnover, useBj ? bjForTurnover : undefined);
    // 窗口内输出 + 逐日 MA5（用窗口前 4 根历史参与平均，首日即有线，稳智同款）
    const extPts = pts.filter((p) => p.date >= extFrom && p.totalYi !== null);
    const ma5Of = new Map(extPts.map((p, i) => {
      if (i < 4) return [p.date, null] as const;
      const win = extPts.slice(i - 4, i + 1);
      return [p.date, +(win.reduce((s, x) => s + (x.totalYi as number), 0) / win.length).toFixed(1)] as const;
    }));
    const days = pts
      .filter((p) => p.date >= defFrom)
      .map((p) => ({ ...p, ma5Yi: ma5Of.get(p.date) ?? null }));
    const { deltaYi, prevDate } = turnoverDeltaVsPrev(pts);
    const missing: string[] = [];
    if (!sh.bars.length) missing.push("上证指数：通达信日K与腾讯日K均无读数，累计涨跌与指数线缺这条");
    if (!sz.bars.length) missing.push("深证成指：通达信日K与腾讯日K均无读数，累计涨跌与指数线缺这条");
    if (!bj.bars.length) missing.push("北证50：未取到读数，成交额按沪深两市合计（不拿沪深冒充沪深北）");
    else if (!useBj) missing.push("北证50：本次无有效成交额读数，成交额按沪深两市合计");

    // 逐日涨跌幅（稳智「指数涨跌幅」口径）：首日无前收不画，不冒充 0；窗口内
    const winBars = (b: typeof catalog[number]["bars"]) => inRange(b, defFrom, defTo);
    const idx = catalog.map((c) => {
      const bars = winBars(c.bars);
      return {
        key: c.key,
        name: c.name,
        pts: bars.slice(1).map((b, i) => {
          const prev = bars[i].close;
          return { date: b.date, pct: prev > 0 ? +(((b.close / prev) - 1) * 100).toFixed(2) : 0 };
        }),
        source: c.source,
      };
    });

    // 主源分布自报：本次窗口里各指数实际用了哪个源
    const srcSet = new Set(catalog.map((c) => c.source));
    const marketLabel = useBj ? "沪深北" : "两市";
    const sourceLabel = (() => {
      const turnoverDays = pts.filter((p) => p.totalYi !== null && p.date !== todayDate).length;
      if (srcSet.has("eltdx")) {
        return `eltdx 通达信日K（带成交额）· ${marketLabel}成交额合计可用（${turnoverDays} 日）· 指数序列 ${catalog.filter((c) => c.source === "eltdx").length}/${catalog.length} 条`;
      }
      if (todayAppended.length && pts.some((p) => p.date === todayDate && p.totalYi)) {
        return `腾讯日K备源（close）+ stock-sdk 快照（今日成交额）· 成交额仅今日一根柱 · 历史成交额序列等通达信网关恢复`;
      }
      if (srcSet.has("tencent")) {
        return `腾讯日K备源（close）· 累计涨跌可用 · 成交额序列本次无有效数据（等通达信网关恢复）`;
      }
      return "本次无有效数据源";
    })();

    const payload = {
      ok: true,
      range: { from: defFrom, to: defTo },
      days,
      delta: { yi: deltaYi, prev_date: prevDate },
      cum: { sh: cumReturnSeries(inRange(sh.bars, defFrom, defTo)), sz: cumReturnSeries(inRange(sz.bars, defFrom, defTo)), cyb: cumReturnSeries(inRange(cyb.bars, defFrom, defTo)) },
      idx: idx.map(({ key, name, pts: p }) => ({ key, name, pts: p })),
      notes: trendNotes(sh.bars.length, sz.bars.length, cyb.bars.length),
      missing,
      source: sourceLabel,
      sources: { sh: sh.source, sz: sz.source, cyb: cyb.source, bj: bj.source },
      /** 成交额合计口径：沪深北（沪+深+北证50）或沪深两市（北证取不到时的退化） */
      market_label: marketLabel,
      cached: false,
      cached_at: "",
    };

    const turnoverUsableDays = countTurnoverDays({ days });
    if (turnoverUsableDays >= MIN_USABLE_DAYS) {
      // 数据完整 → 落快照（存算好的整份响应；回放时原样返回，保证前后看到同一张图）
      try { saveTrendSnapshot(defTo, payload); } catch { /* 写缓存失败不影响本次返回 */ }
    } else {
      // 数据不完整（网关没起，只剩 1 根）→ 回放当天快照，别让图缩成一根柱
      const snap = getTrendSnapshot(defTo) ?? getTrendSnapshot();
      if (snap && countTurnoverDays(snap.payload) >= MIN_USABLE_DAYS) {
        return NextResponse.json({
          ...(snap.payload as Record<string, unknown>),
          cached: true,
          cached_at: snap.cachedAt,
          cache_note: `本次上游只取到 ${turnoverUsableDays} 根成交额（${sourceLabel}），已回放 ${snap.tradeDate} 的本地快照`,
        });
      }
    }

    return NextResponse.json(payload);
  } catch (e) {
    // 上游整体失败（例如网关没起 + 腾讯也挂）：回放本地快照，别让页面直接空掉
    const snap = getTrendSnapshot();
    if (snap) {
      return NextResponse.json({
        ...(snap.payload as Record<string, unknown>),
        cached: true,
        cached_at: snap.cachedAt,
        cache_note: `上游取数失败（${(e as Error).message}），已回放 ${snap.tradeDate} 的本地快照`,
      });
    }
    return NextResponse.json({ ok: false, error: `趋势数据获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
