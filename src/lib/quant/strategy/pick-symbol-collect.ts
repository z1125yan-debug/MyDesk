// P36-C 补记具体票（2026-10-01）：台账只记「推荐了哪条策略」，次日无从对账——
// 必须把当天这组条件**实际命中了哪几只票**补进去，"跟着推荐赚没赚"才答得上来。
//
// 为什么不在推荐那一刻现算：单次全A筛选实测 23s（K线现场计算），接口 maxDuration 60s，
// 五条就爆。而且那一刻算出来的名单存在前端、可以事后挑——不算证据。
// 所以放在收盘后跑：数据已经定死，谁都改不了，跑出来是什么就是什么。
//
// 三条纪律：
// 1) 只从本地粮仓 stock_daily_bar（前复权）算，不发外部请求——名单必须可复核；
// 2) 条件含当日快照字段（换手率/市盈率/板块RPS）→ 判「算不出来」，写空数组 + 原因，
//    绝不拿今天的读数填满历史（B 段已实证：旧榜 Top1「底分型」就是这么造出来的 +1.40%）；
// 3) 命中很多只时，按当日成交额取前 10（理由见 hit-scan-core 的 topByAmountOf）。

import { db } from "../../db.ts";
import { shanghaiStamp } from "../../desk/session.ts";
import { strategyLibrary } from "../data/strategy-library.ts";
import { FACTOR_FIELD_MAP, type BarsLike } from "../factors/fields.ts";
import { condKeyOf, type MatCond } from "./cond-matrix-core.ts";
import { scanHitsOnDate, topByAmountOf } from "./hit-scan-core.ts";
import type { PickSym } from "./pick-fill-core.ts";
import type { ArchiveResult, ScanMode } from "../screener/persist.ts";

/** 回溯多少根日K（要盖住 MA60/RPS120 这类长窗口，宁多勿少） */
const BARS = 320;
/** 一次读多少只票的K线（与 B 回测脚本同量级，避免单次 SQL 绑定变量爆上限） */
const CHUNK = 120;
/** 每个策略每天最多记几只票 */
const TOP_N = 10;
/** 指数不是股票，不参与推荐（与 B 回测同一份黑名单） */
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);

interface CondBundle { ok: boolean; reason: string | null; conds: MatCond[] }

interface PendingRow {
  id: string;
  tradeDate: string;
  strategyId: number;
  strategyName: string;
}

/** 策略条件能不能用历史K线复算：返回不可用的原因（null=可以） */
function blockReasonOf(conds: readonly { field?: string }[]): string | null {
  const snapshot: string[] = [];
  const pending: string[] = [];
  for (const c of conds) {
    const field = String(c.field ?? "");
    const def = FACTOR_FIELD_MAP.get(field);
    if (!def) { pending.push(field || "空字段"); continue; }
    if (def.implemented === false) pending.push(def.zh);
    else if (def.source === "snapshot") snapshot.push(def.zh);
  }
  const parts: string[] = [];
  if (snapshot.length) parts.push(`条件里有「${[...new Set(snapshot)].join("、")}」这种只有当天才有的数，历史K线里没有每一天的读数，算不出当天命中了谁（也不许拿今天的数冒充）`);
  if (pending.length) parts.push(`条件里有还没实现的因子「${[...new Set(pending)].join("、")}」`);
  return parts.length ? parts.join("；") : null;
}

export interface SyncPickSymbolsOptions {
  /** 只补某一天（默认补所有还没补的日子） */
  date?: string;
  /** 最多处理多少行 */
  limit?: number;
}

export async function syncPickSymbols(opts: SyncPickSymbolsOptions = {}): Promise<ArchiveResult<never>> {
  const maxRow = await db.$queryRawUnsafe<{ d: string }[]>(
    `SELECT MAX(tradeDate) AS d FROM stock_daily_bar`,
  );
  const maxDate = maxRow[0]?.d ?? "";
  if (!maxDate) {
    return {
      as_of: shanghaiStamp(), trade_date: shanghaiStamp().slice(0, 10),
      missing: ["本地日K粮仓是空的（先跑 scripts/backfill-daily-bars.ts）"],
      scanned: 0, results: 0, items: [], unmatched: null,
      source: "本地日K粮仓 stock_daily_bar（前复权）", mode: "full" as ScanMode,
      delta: { scanned: 0, inserted: 0, updated: 0, unchanged: 0, skippedByCursor: 0, superseded: 0, kept: 0, collapsed: 0 },
    };
  }

  const where: Record<string, unknown> = { symbols: null, tradeDate: { lte: maxDate } };
  if (opts.date) where.tradeDate = opts.date;
  const pending = (await db.strategyPick.findMany({
    where, orderBy: { tradeDate: "asc" }, take: opts.limit ?? 200,
    select: { id: true, tradeDate: true, strategyId: true, strategyName: true },
  })) as PendingRow[];

  const lib = strategyLibrary();
  const byId = new Map(lib.map((s) => [s.id, s]));
  const missing: string[] = [];
  let updated = 0;
  let empty = 0;
  let blocked = 0;

  // 按推荐日聚合：同一天共用一份K线面板，别每行都重读一遍全市场
  const byDate = new Map<string, PendingRow[]>();
  for (const r of pending) {
    const arr = byDate.get(r.tradeDate) ?? [];
    arr.push(r);
    byDate.set(r.tradeDate, arr);
  }

  for (const [targetDate, rows] of byDate) {
    // 该日往前 BARS 根的交易日轴
    const dateRows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
      `SELECT tradeDate FROM stock_daily_bar WHERE tradeDate <= ? GROUP BY tradeDate
       HAVING COUNT(*) >= 1000 ORDER BY tradeDate DESC LIMIT ?`,
      targetDate, BARS,
    );
    const dates = dateRows.map((r) => r.tradeDate).reverse();
    if (!dates.length || dates[dates.length - 1] !== targetDate) {
      missing.push(`${targetDate}：粮仓里没有这一天的全A行情，跳过`);
      continue;
    }
    const from = dates[0];

    // 条件去重：同一天的不同行可能共用策略
    const condsByStrategy = new Map<number, CondBundle>();
    for (const r of rows) {
      if (condsByStrategy.has(r.strategyId)) continue;
      const st = byId.get(r.strategyId);
      const conds = st?.conds ?? [];
      if (!conds.length) {
        condsByStrategy.set(r.strategyId, { ok: false, reason: "这条策略没有条件（库里没存），无从算命中", conds: [] });
        continue;
      }
      const reason = blockReasonOf(conds);
      if (reason) {
        condsByStrategy.set(r.strategyId, { ok: false, reason, conds: [] });
        continue;
      }
      condsByStrategy.set(r.strategyId, {
        ok: true, reason: null,
        conds: conds.map((c) => ({ ...c, key: condKeyOf(c as never) }) as MatCond),
      });
    }

    // 命中的票按策略累积（分块读全市场）
    const hitsByStrategy = new Map<number, { symbol: string; close: number; amount: number }[]>();
    const symRows = await db.$queryRawUnsafe<{ symbol: string }[]>(
      `SELECT symbol FROM stock_daily_bar WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol ASC`,
      targetDate,
    );
    // 指数不在推荐范围里（成分股汇总口径，个股买不了）
    const universe = symRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));

    for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
      const chunk = universe.slice(c0, c0 + CHUNK);
      const ph = chunk.map(() => "?").join(",");
      const barRows = await db.$queryRawUnsafe<{
        symbol: string; tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number;
      }[]>(
        `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar
         WHERE symbol IN (${ph}) AND tradeDate >= ? ORDER BY symbol ASC, tradeDate ASC`,
        ...chunk, from,
      );
      const bySym = new Map<string, BarsLike[]>();
      for (const r of barRows) {
        let arr = bySym.get(r.symbol);
        if (!arr) { arr = []; bySym.set(r.symbol, arr); }
        arr.push({ date: r.tradeDate, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, amount: r.amount });
      }
      const syms = chunk.filter((s) => (bySym.get(s)?.length ?? 0) > 0);
      if (!syms.length) continue;
      const barsList = syms.map((s) => bySym.get(s) as BarsLike[]);

      for (const [sid, info] of condsByStrategy) {
        if (!info.ok) continue;
        const hits = scanHitsOnDate({ syms, barsList, conds: info.conds, targetDate });
        if (!hits.length) continue;
        const arr = hitsByStrategy.get(sid) ?? [];
        arr.push(...hits);
        hitsByStrategy.set(sid, arr);
      }
    }

    // 写回
    for (const r of rows) {
      const info = condsByStrategy.get(r.strategyId);
      if (!info?.ok) {
        await db.strategyPick.update({
          where: { id: r.id },
          data: { symbols: "[]", symbolsNote: info?.reason ?? "算不出当天命中了哪些票" },
        });
        blocked++;
        continue;
      }
      const top = topByAmountOf(hitsByStrategy.get(r.strategyId) ?? [], TOP_N);
      if (!top.length) {
        await db.strategyPick.update({
          where: { id: r.id },
          data: { symbols: "[]", symbolsNote: "那天这组条件一只票都没命中（回测命中少，属正常）" },
        });
        empty++;
        continue;
      }
      const syms: PickSym[] = top.map((h) => ({ symbol: h.symbol, name: "", close: h.close }));
      await db.strategyPick.update({
        where: { id: r.id },
        data: {
          symbols: JSON.stringify(syms),
          symbolsNote: `当天这组条件命中 ${hitsByStrategy.get(r.strategyId)?.length ?? top.length} 只，按成交额取前 ${top.length} 只`,
        },
      });
      updated++;
    }
  }

  return {
    as_of: shanghaiStamp(),
    trade_date: maxDate,
    missing,
    scanned: pending.length,
    results: updated,
    items: [],
    unmatched: null,
    source: "本地日K粮仓 stock_daily_bar（前复权，按当日成交额取前 10）",
    mode: "full" as ScanMode,
    delta: {
      scanned: pending.length,
      inserted: 0,
      updated,
      unchanged: empty + blocked,
      skippedByCursor: 0,
      superseded: 0,
      kept: 0,
      collapsed: 0,
    },
  };
}
