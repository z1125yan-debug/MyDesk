// P36-C 战绩回填执行层（2026-10-01）：把「T 日推荐的那几只票」逐个用 T+1/T+2 真实行情回填。
//
// 为什么单独一层：纯核（pick-fill-core）只管算术，取数/写库必须隔离，否则单测要连库就跑不动了。
//
// 三条硬纪律（与 daily-snapshot-collect 同风格）：
// 1) 只回填「后面两个交易日都真的走完」的行——T+2 还没到就是没到，不拿上一天的数据顶替；
// 2) 已回填过的行绝不重写（symBackfilledAt 有值即跳过）——重跑一次涨一次 = 可以造假 = 没有证据价值；
// 3) 买不进的票（T+1 一字涨停/停牌）剔除不记 0，缺行情的票单列 missing，两者分开报。
//
// 数据源：本地粮仓 stock_daily_bar（前复权日K，B0 落库）。不发任何外部请求——
// 外部行情会随复权调整漂移，回填值必须可复核。

// 用相对路径而不是 @/ 别名：scripts/ 下的回填脚本用 node --experimental-strip-types 直跑，别名解析不了
import { db } from "../../db.ts";
import { shanghaiStamp } from "../../desk/session.ts";
import {
  parseSymbols, symFillOf, fillStatOf, benchNetOf, fillDecisionOf, basisTextOf,
  type PickSym, type SymFill,
} from "./pick-fill-core.ts";
import type { ArchiveResult, ScanMode } from "../screener/persist.ts";

/** 粮仓口径：前复权（与分档回测同一份，不许出现两套价格） */
const ADJUST = "qfq";
/** 少于这么多只票的交易日视为「没沉淀完」，不算交易日（零星补的数据不能当全A） */
const MIN_BAR_SYMBOLS = 1000;
/** 一次最多处理多少行（按推荐日聚合后再查行情，行数不是瓶颈） */
const DEFAULT_LIMIT = 200;

interface DayQuote { open: number | null; close: number | null }

/** 某交易日的全市场 开/收，按票索引 */
async function dayMapOf(tradeDate: string): Promise<Map<string, DayQuote>> {
  const rows = await db.$queryRawUnsafe<{ symbol: string; open: number | null; close: number | null }[]>(
    `SELECT symbol, open, close FROM stock_daily_bar WHERE tradeDate = ? AND adjust = ?`,
    tradeDate, ADJUST,
  );
  const m = new Map<string, DayQuote>();
  for (const r of rows) m.set(r.symbol, { open: r.open, close: r.close });
  return m;
}

/** 推荐日之后最近的两个「已沉淀完」的交易日 */
async function nextTradeDatesOf(tradeDate: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT tradeDate FROM stock_daily_bar WHERE tradeDate > ? AND adjust = ?
     GROUP BY tradeDate HAVING COUNT(*) >= ? ORDER BY tradeDate ASC LIMIT 2`,
    tradeDate, ADJUST, MIN_BAR_SYMBOLS,
  );
  return rows.map((r) => r.tradeDate);
}

export interface FillPicksOptions {
  /** 最多处理多少行待回填记录 */
  limit?: number;
  /** 只回填某个推荐日（调试用） */
  only?: string;
}

/**
 * 回填所有待处理行。返回 ArchiveResult 供调度器记账。
 * 幂等：同一行只会被回填一次；跑第二次 results=0、skipped 全数列出原因。
 */
export async function fillPicks(opts: FillPicksOptions = {}): Promise<ArchiveResult<never>> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const pending = await db.strategyPick.findMany({
    where: { symBackfilledAt: null, symbols: { not: null }, ...(opts.only ? { tradeDate: opts.only } : {}) },
    orderBy: { tradeDate: "asc" },
    take: limit,
    select: { id: true, tradeDate: true, symbols: true, symBackfilledAt: true },
  });

  const missing: string[] = [];
  let filled = 0;
  let skipped = 0;
  const dayCache = new Map<string, Map<string, DayQuote>>();
  const quoteOf = async (d: string): Promise<Map<string, DayQuote>> => {
    const hit = dayCache.get(d);
    if (hit) return hit;
    const m = await dayMapOf(d);
    dayCache.set(d, m);
    return m;
  };

  // 按推荐日聚合：同一天的多行共用一份全市场行情，别每行都查一遍
  const byDate = new Map<string, typeof pending>();
  for (const r of pending) {
    const arr = byDate.get(r.tradeDate) ?? [];
    arr.push(r);
    byDate.set(r.tradeDate, arr);
  }

  for (const [t0, rows] of byDate) {
    const dates = await nextTradeDatesOf(t0);
    const t1 = dates[0] ?? null;
    const t2 = dates[1] ?? null;
    const gate = fillDecisionOf({ symbols: rows[0]?.symbols, symBackfilledAt: null }, t1, t2);
    if (!gate.fill) {
      skipped += rows.length;
      missing.push(`${t0}：${gate.reason}`);
      continue;
    }
    const [m0, m1, m2] = await Promise.all([quoteOf(t0), quoteOf(t1 as string), quoteOf(t2 as string)]);

    // 基准：同一天「随便买一只」的中位净收益（全A，同口径、同剔除规则）
    const benchFills: SymFill[] = [];
    for (const [symbol, q1] of m1) {
      const q2 = m2.get(symbol);
      if (!q2) continue;
      benchFills.push(symFillOf({ symbol, name: "", close: m0.get(symbol)?.close ?? null }, { symbol, t1Open: q1.open, t2Open: q2.open }));
    }
    const benchNets = benchFills.filter((f) => f.tradable && f.net != null).map((f) => f.net as number);
    const benchNet = benchNetOf(benchNets);

    for (const row of rows) {
      const syms: PickSym[] = parseSymbols(row.symbols);
      if (!syms.length) {
        skipped++;
        missing.push(`${t0} #${row.id}：这行没记具体票，补不出来也不拿策略名冒充`);
        continue;
      }
      const fills = syms.map((s) => {
        const q1 = m1.get(s.symbol);
        const q2 = m2.get(s.symbol);
        if (!q1 || !q2) return symFillOf(s, undefined);
        return symFillOf(s, { symbol: s.symbol, t1Open: q1.open, t2Open: q2.open });
      });
      const stat = fillStatOf(fills);
      if (!stat) {
        // 一只都算不出来：也要留痕（写 basis 说明原因），但不写 symBackfilledAt——
        // 明天行情补齐后还能再补，不算「已经回填过」
        missing.push(`${t0} #${row.id}：这批票一只都算不出收益（缺行情 ${fills.filter((f) => f.reason === "库里没有这两天的行情").length} 只、买不进 ${fills.filter((f) => !f.tradable && f.reason !== "库里没有这两天的行情").length} 只）`);
        skipped++;
        continue;
      }
      const basis = basisTextOf({
        t1: t1 as string,
        t2: t2 as string,
        source: "本地日K粮仓（前复权）",
        skipped: stat.skipped,
        benchN: benchNets.length,
      });
      await db.strategyPick.update({
        where: { id: row.id },
        data: {
          nextDaySymWin: Math.round(stat.avgNet * 10000) / 10000,
          nextDaySymUp: stat.up,
          nextDaySymCount: stat.n,
          nextDaySymSkip: stat.skipped,
          nextDayBenchNet: benchNet == null ? null : Math.round(benchNet * 10000) / 10000,
          nextDayBasis: basis,
          nextDaySymDetail: JSON.stringify(
            fills.map((f) => ({
              symbol: f.symbol,
              net: f.net == null ? null : Math.round(f.net * 10000) / 10000,
              reason: f.reason,
            })),
          ),
          symBackfilledAt: new Date(),
        },
      });
      filled++;
    }
  }

  return {
    as_of: shanghaiStamp(),
    trade_date: shanghaiStamp().slice(0, 10),
    missing,
    scanned: pending.length,
    results: filled,
    items: [],
    unmatched: null,
    source: "本地日K粮仓 stock_daily_bar（前复权，T+1 开盘买 / T+2 开盘卖 / 扣费）",
    mode: "full" as ScanMode,
    delta: {
      scanned: pending.length,
      inserted: 0,
      updated: filled,
      unchanged: skipped,
      skippedByCursor: 0,
      superseded: 0,
      kept: 0,
      collapsed: 0,
    },
  };
}
