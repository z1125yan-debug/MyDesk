// P15-R20 涨停名单沉淀与回填（服务端）：把「哪几只涨停、几连板」按票按日记进 market_limit_up。
//
// 为什么要这张表：market_daily_stats 只有计数（涨停 52 家、t3/t4/t5、最高板），
// 而「昨天首板 39 只、今天有几个变成二板」问的是**谁**晋级了 —— 计数换算不出名单，
// 晋级率 / 梯队断层 / 昨日涨停股的今日表现这三组读数都必须有名单这根钉。
//
// 三条硬口径（与 breadth/review 两路同源，别改）：
// 1) 北京 15:05 之前拒跑：盘中的池子是「此刻封着板的票」，14:50 的点一次就把午后炸掉的板钉进历史；
// 2) 周末拒跑：周六的行情是周五的，按周六日期入库就是造了个不存在的交易日；
// 3) 池子返回 0 条 → 一行都不写、直接抛错留痕。0 条既可能是休市，也可能超出东财留存窗口
//    （实测约回溯到当月早些时候，响应本身分不出来），写成「当日 0 只涨停」就是造假历史。
//
// 回填（backfill）只碰**本地能证明是交易日**的日期：以 stock_daily_close 里的不同 tradeDate 为准，
// 库里没有那天收盘价就不去问东财，避免「把休市日当成一个空涨停日」。已经有名单的日期默认跳过，
// 想重刷传 force。
import { db } from "@/lib/db";
import { fetchLimitUpPool } from "@/lib/quant/data/em-ztpool";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { beijingParts, weekdayOf } from "@/lib/quant/scheduler/rules";
import type { RosterRow } from "./limit-up-roster-core.ts";
import type { ArchiveResult, ScanMode } from "./persist.ts";

/** 收盘时刻下限：北京 15:05（与宽度/复盘沉淀同一口径，两条路的「今天」才是同一天） */
const CLOSE_MINUTE = 15 * 60 + 5;
/** 本地收盘价表里这天有多少行才算「确实开过盘」：全A五千多只，低于这个数就当没有这一天 */
export const TRADING_DAY_MIN_CLOSE_ROWS = 1000;

const basisFor = (ok: boolean, tc: number, reason: string): string =>
  `东财涨停池 push2ex getTopicZTPool（${ok ? `服务端报 ${tc} 条` : "无有效条数"}）${reason ? `；${reason}` : ""}`
  + "；boards=池子 lbc（连板数），缺读则记 null 不当首板";

/**
 * 写一天的名单：池子行 → market_limit_up。同票同日以最后一次为准（收盘后重跑只可能补上漏读字段）。
 * 返回写入明细，调用方负责回报「新增几条、改了几条」。
 */
async function writeRosterDay(tradeDate: string, rows: RosterRow[], basis: string) {
  const existing = new Set(
    (await db.marketLimitUp.findMany({ where: { tradeDate }, select: { symbol: true } })).map((r) => r.symbol),
  );
  let inserted = 0, updated = 0;
  for (const r of rows) {
    const data = {
      symbol: r.symbol, tradeDate, name: r.name, industry: r.industry,
      boards: r.boards, changePct: r.changePct, firstSeal: r.firstSeal, lastSeal: r.lastSeal,
      breakCount: r.breakCount, sealFund: r.sealFund, floatCap: r.floatCap, basis,
    };
    if (existing.has(r.symbol)) {
      await db.marketLimitUp.update({ where: { symbol_tradeDate: { symbol: r.symbol, tradeDate } }, data });
      updated++;
    } else {
      await db.marketLimitUp.create({ data });
      inserted++;
    }
  }
  return { inserted, updated };
}

/** 收盘后沉淀当日涨停名单（调度器 kind="roster" 与手动接口共用） */
export async function archiveLimitUpRoster(now = new Date()): Promise<ArchiveResult<never>> {
  const p = beijingParts(now);
  const wd = weekdayOf(p.date);
  if (wd === 0 || wd === 6) {
    throw new Error(`涨停名单拒绝在周末执行（${p.date}）：周六日的池子是周五的，按周六入库就是造假交易日`);
  }
  if (p.minuteOfDay < CLOSE_MINUTE) {
    const hh = String(Math.floor(p.minuteOfDay / 60)).padStart(2, "0");
    const mm = String(p.minuteOfDay % 60).padStart(2, "0");
    throw new Error(`涨停名单拒绝在收盘前执行（北京 ${p.date} ${hh}:${mm} < 15:05）：盘中池子只是「此刻封板的票」，午后进的板会被钉成历史`);
  }

  const tradeDate = shanghaiDate(now);
  // 网络/形状异常让它抛：task_run 里要留下「是请求失败」这句话，而不是「那天 0 只涨停」
  const pool = await fetchLimitUpPool(tradeDate);
  if (!pool.ok) {
    throw new Error(`涨停池当日无有效名单（${pool.reason}）——本次一条都不写，不产出空存档冒充「今日已沉淀」`);
  }

  const basis = basisFor(pool.ok, pool.tc, pool.dropped ? `${pool.dropped} 行认不出代码被丢弃` : "");
  const { inserted, updated } = await writeRosterDay(tradeDate, pool.rows, basis);

  const missing: string[] = [];
  const unknownBoards = pool.rows.filter((r) => r.boards === null).length;
  if (unknownBoards) missing.push(`${unknownBoards} 只没读到连板数（lbc）——boards 记 null，不进任何板数桶、不参与晋级率分母`);
  if (pool.dropped) missing.push(`${pool.dropped} 行代码形状不对被丢弃（不是 6 位数字），不猜代码`);
  if (pool.tc >= 0 && pool.tc !== pool.rows.length) {
    missing.push(`服务端报 ${pool.tc} 条、本次落 ${pool.rows.length} 条（差 ${pool.tc - pool.rows.length}）：以库里行数为准，不拿报数冒充`);
  }
  missing.push("名单留存窗口之外（实测早于当月月中旬的日期池子返回 0 条）无法回填：更早的历史仍然是空的，不是「那些天没涨停」");

  return {
    as_of: shanghaiStamp(now),
    trade_date: tradeDate,
    missing,
    scanned: pool.rows.length + pool.dropped,
    results: pool.rows.length,
    items: [],
    unmatched: null,
    source: "东财涨停池（push2ex getTopicZTPool，本地自留档）",
    // 同日重跑以最后一次为准（票×日唯一键 upsert）：不存在「先删后插重刷」也不走增量游标
    mode: "incremental" as ScanMode,
    delta: {
      scanned: pool.rows.length + pool.dropped, inserted, updated,
      unchanged: 0, skippedByCursor: 0, superseded: 0, kept: 0, collapsed: 0,
    },
  };
}

export interface BackfillResult {
  as_of: string;
  dates_checked: { date: string; rows: number; status: string }[];
  written: number;
  skipped_existing: number;
  missing: string[];
  earliest: string | null;
  latest: string | null;
}

/** 本地收盘价表里出现过的交易日（升序）——回填与读侧都只认这份日历，不去猜哪天开盘 */
export async function localTradingDays(): Promise<string[]> {
  const rows = await db.stockDailyClose.groupBy({
    by: ["tradeDate"],
    _count: { tradeDate: true },
    orderBy: { tradeDate: "asc" },
  });
  return rows.filter((r) => r._count.tradeDate >= TRADING_DAY_MIN_CLOSE_ROWS).map((r) => r.tradeDate);
}

/**
 * 回填：把东财涨停池留存窗口内的日期灌进库里来。
 * - 只跑「本地收盘价表证明开过盘」的日期；
 * - 已经有名单的日期默认跳过（force=true 才重刷）；
 * - 池子返回 0 条只记一句 missing，不写空行、也不写「那天 0 只涨停」；
 * - 一次最多 `maxDays` 天（从最近的那天往回数），别把回填变成扫库。
 */
export async function backfillLimitUpRoster(opts?: { days?: number; force?: boolean }): Promise<BackfillResult> {
  const maxDays = Math.max(1, Math.min(opts?.days ?? 30, 90));
  const force = opts?.force === true;
  const all = await localTradingDays();
  const candidates = all.slice(-maxDays);

  const already = new Set(
    (await db.marketLimitUp.findMany({ where: { tradeDate: { in: candidates } }, select: { tradeDate: true }, distinct: ["tradeDate"] }))
      .map((r) => r.tradeDate),
  );

  const checked: BackfillResult["dates_checked"] = [];
  const missing: string[] = [];
  let written = 0, skipped = 0;

  for (const date of candidates) {
    if (already.has(date) && !force) {
      const n = await db.marketLimitUp.count({ where: { tradeDate: date } });
      checked.push({ date, rows: n, status: "库里已有名单，跳过（force 可重刷）" });
      skipped++;
      continue;
    }
    try {
      const pool = await fetchLimitUpPool(date);
      if (!pool.ok) {
        checked.push({ date, rows: 0, status: "池子无有效名单，未写入" });
        missing.push(`${date}：${pool.reason}`);
        continue;
      }
      const { inserted, updated } = await writeRosterDay(date, pool.rows, basisFor(pool.ok, pool.tc, "回填"));
      checked.push({ date, rows: pool.rows.length, status: `写入 新增 ${inserted}、更新 ${updated}` });
      written += pool.rows.length;
    } catch (e) {
      checked.push({ date, rows: 0, status: "取数失败" });
      missing.push(`${date} 回填失败：${(e as Error).message}`);
    }
  }

  const span = await db.marketLimitUp.aggregate({ _min: { tradeDate: true }, _max: { tradeDate: true } });
  if (!written) missing.push("本次一天都没写进新名单：可能全都已在库里，也可能留存窗口内没有可回填的交易日");

  return {
    as_of: shanghaiStamp(new Date()),
    dates_checked: checked,
    written,
    skipped_existing: skipped,
    missing,
    earliest: span._min.tradeDate ?? null,
    latest: span._max.tradeDate ?? null,
  };
}
