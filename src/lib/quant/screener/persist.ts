// P2 归档写入的唯一实现：扫描 → 当日先删后插 → 回读。
// HTTP 路由（手动点击）与后台调度器（收盘后自动）都走这里，避免两处各写一份幂等逻辑而口径漂移。
// 幂等策略（P2 定稿，见 prisma/schema.prisma 注释）：deleteMany 只限 asOf = 本次扫描的交易日，跨日历史行不触碰。
import { db } from "@/lib/db";
import { buildRadarFindings, type RadarItem } from "./radar";
import { scanGlobalEvents } from "./events";

export interface RadarRow {
  id: string; kind: string; title: string; detail: string; evidence: Record<string, unknown>;
}
export interface EventRow {
  id: string; title: string; time: string; level: string; category: string;
  mappedSectors: string[]; relatedStocks: string[]; fundCheck: Record<string, unknown>; stage: string; source: string;
}

export interface ArchiveResult<T> {
  as_of: string;
  trade_date: string;
  missing: string[];
  /** 上游产出条数（落库前的候选数） */
  scanned: number;
  /** 实际落库条数 */
  results: number;
  items: T[];
  /** 未映射/未采纳计数（事件用），雷达为 null */
  unmatched: number | null;
  source: string;
}

const radarRow = (r: {
  id: string; kind: string; title: string; detail: string; evidence: string;
}): RadarRow => ({
  id: r.id, kind: r.kind, title: r.title, detail: r.detail,
  evidence: JSON.parse(r.evidence || "{}") as Record<string, unknown>,
});

export async function archiveRadarScan(): Promise<ArchiveResult<RadarRow>> {
  const scan = await buildRadarFindings();
  await db.radarFinding.deleteMany({ where: { asOf: scan.trade_date } });
  const data = scan.items.map((it: RadarItem) => ({
    asOf: scan.trade_date,
    kind: it.kind,
    title: it.title,
    detail: it.detail,
    evidence: JSON.stringify(it.evidence ?? {}),
  }));
  if (data.length) await db.radarFinding.createMany({ data });
  const rows = await db.radarFinding.findMany({ where: { asOf: scan.trade_date }, orderBy: { createdAt: "asc" } });
  return {
    as_of: scan.as_of,
    trade_date: scan.trade_date,
    missing: scan.missing,
    scanned: scan.items.length,
    results: rows.length,
    items: rows.map(radarRow),
    unmatched: null,
    source: "computeSentiment + discoverThemes + scanGlobalEvents → radar_finding",
  };
}

export async function archiveEventScan(): Promise<ArchiveResult<EventRow>> {
  const scan = await scanGlobalEvents();
  await db.globalEvent.deleteMany({ where: { asOf: scan.trade_date } });
  const data = scan.items.map((it) => ({
    asOf: scan.trade_date,
    title: it.title,
    time: it.time,
    level: it.level,
    category: it.category,
    mappedSectors: JSON.stringify(it.mappedSectors ?? []),
    relatedStocks: JSON.stringify(it.relatedLeaders ?? []),
    fundCheck: JSON.stringify(it.fund ?? {}),
    stage: it.fund.stage,
    source: it.source,
  }));
  if (data.length) await db.globalEvent.createMany({ data });
  const rows = await db.globalEvent.findMany({ where: { asOf: scan.trade_date }, orderBy: { createdAt: "desc" } });
  return {
    as_of: scan.as_of,
    trade_date: scan.trade_date,
    missing: scan.missing,
    scanned: scan.items.length + scan.unmatched,
    results: rows.length,
    items: rows.map((r) => ({
      id: r.id, title: r.title, time: r.time, level: r.level, category: r.category,
      mappedSectors: JSON.parse(r.mappedSectors || "[]") as string[],
      relatedStocks: JSON.parse(r.relatedStocks || "[]") as string[],
      fundCheck: JSON.parse(r.fundCheck || "{}") as Record<string, unknown>,
      stage: r.stage, source: r.source,
    })),
    unmatched: scan.unmatched,
    source: scan.source,
  };
}
