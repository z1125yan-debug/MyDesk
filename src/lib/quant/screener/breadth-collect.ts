// P15-R2b 收盘后宽度沉淀（服务端）：把全A快照里每票的当日收盘价写成 stock_daily_close 行。
// 这是「低5日/低3日/5日线占比」当日往后的数据来源；早于部署日的历史由 P15-R19 用真实日K一次性回填
// （/api/market/breadth/backfill，不复权原始价、只补库里没有的键）。两条路都不许造史：
// 攒不够根数就不出数，缺就是缺。
//
// 三条硬口径（与 schema 注释同源）：
// 1) 北京 15:05 之前拒跑（含盘前/集合竞价/盘中/午间）：那时的快照价不是收盘价，
//    盘中手工点一次就把「上午 10 点的价」钉成当日收盘价写进历史，重写不了也删不干净——宁可拒。
// 2) 周末拒跑：周六的快照是周五收盘价，拿周六日期入库等于造了个不存在的交易日；
//    要补周五就在周五晚跑（调度器本来只在窗口内跑，这里挡的是手动 force 的口子）。
// 3) (symbol, tradeDate) 唯一键 + 先查当日已有键再纯插：同日重跑只补新票、不重写已有收盘价——收盘价不可变。
// 停牌/无价格行不写：缺就是缺，宽度统计的分母只数当日真实有行的票。
import { db } from "@/lib/db";
import { getProvider } from "@/lib/quant/data/index";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { beijingParts, weekdayOf } from "@/lib/quant/scheduler/rules";
import type { ArchiveResult, ScanMode } from "./persist.ts";

/** 收盘时刻下限：北京 15:05（给收盘集合竞价/快照落定留 5 分钟缓冲，口径写进任务记录） */
const CLOSE_MINUTE = 15 * 60 + 5;
const CHUNK = 500; // sqlite 单语句参数上限保守分块（与 radar 落库同风格）

export async function archiveBreadthScan(now = new Date()): Promise<ArchiveResult<never>> {
  const p = beijingParts(now);
  const wd = weekdayOf(p.date);
  if (wd === 0 || wd === 6) {
    throw new Error(`宽度沉淀拒绝在周末执行（${p.date}）：周六日的快照是周五收盘价，按周六入库就是造假交易日；要补哪个交易日，就在那天收盘后跑`);
  }
  if (p.minuteOfDay < CLOSE_MINUTE) {
    throw new Error(`宽度沉淀拒绝在收盘前执行（北京 ${p.date} ${String(Math.floor(p.minuteOfDay / 60)).padStart(2, "0")}:${String(p.minuteOfDay % 60).padStart(2, "0")} < 15:05）：盘中快照价不是收盘价，不拿它钉死历史`);
  }

  const provider = await getProvider("em");
  const tradeDate = shanghaiDate(now);
  const metas = await provider.listUniverse({ kind: "all" }, tradeDate);
  if (!metas.length) throw new Error("全A快照为空（数据源无返回）——本次一条都不写");

  const seen = new Set<string>();
  const rows: { symbol: string; tradeDate: string; close: number; name: string }[] = [];
  let noPrice = 0;
  for (const m of metas) {
    if (seen.has(m.symbol)) continue; // 快照重票防御：同票取首行
    seen.add(m.symbol);
    if (typeof m.price !== "number" || !isFinite(m.price) || m.price <= 0) { noPrice++; continue; }
    rows.push({ symbol: m.symbol, tradeDate, close: m.price, name: m.name });
  }
  if (!rows.length) throw new Error(`全A快照 ${metas.length} 家里没有一只有有效收盘价——本次一条都不写（不产出空存档冒充「今日已沉淀」）`);

  // SQLite 方言没有 createMany.skipDuplicates（类型层就挡掉）——先一次性查当日已有键过滤，
  // 再分块纯插：语义等同「不重写已有收盘价」，同日并发撞 running 互斥由调度器挡。
  const existing = new Set(
    (await db.stockDailyClose.findMany({ where: { tradeDate }, select: { symbol: true } })).map((r) => r.symbol),
  );
  const fresh = rows.filter((r) => !existing.has(r.symbol));
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const r = await db.stockDailyClose.createMany({ data: fresh.slice(i, i + CHUNK) });
    inserted += r.count;
  }
  const unchanged = rows.length - inserted;

  const missing: string[] = [];
  if (noPrice > 0) missing.push(`${noPrice} 只当日无有效价格（停牌/无成交/快照缺价）——未写入，宽度分母不含它们`);
  if (unchanged > 0) missing.push(`${unchanged} 只当日已有收盘价行——不重写（收盘价不可变，重跑只补新票）`);

  return {
    as_of: shanghaiStamp(now),
    trade_date: tradeDate,
    missing,
    scanned: metas.length,
    results: rows.length,
    items: [],
    unmatched: null,
    source: "em 全A快照（收盘后一次性读取，逐票 price → stock_daily_close.close）",
    mode: "incremental" as ScanMode, // 同日重跑只补不写旧行；不存在「先删后插重刷」口径——历史不可变
    delta: { scanned: metas.length, inserted, updated: 0, unchanged, skippedByCursor: 0, superseded: 0, kept: 0, collapsed: seen.size - metas.length },
  };
}
