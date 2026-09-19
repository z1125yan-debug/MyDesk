// P5 第五阶段 每日留档的库操作层：写入三张快照表 + 读回看清单。
//
// 与 lifecycle.ts 同样的分层理由：本文件不 import 任何 @/ 模块（client 由调用方注入），
// 因此 node --test 可以在真实库的临时副本上真跑「写入 → 读回 → 按日分组」，
// 验证的是写入/读取实现本身，而不是把口径复制一份进测试。
//
// 本层不做的事：不计算任何指标（计算在调用方，走页面同源链路）、不改 radar_finding / global_event、
// 不参与第五阶段的过期清理（快照表不在清理授权范围内）。
import type { PrismaClient } from "@prisma/client";
import type { ProbabilityColumns, RiskColumns, SnapshotKind, ThemeColumns } from "./snapshot-core";

export type SnapshotDb = Pick<PrismaClient, "riskSnapshot" | "themeSnapshot" | "probabilitySnapshot">;
export type SnapshotRow = Record<string, unknown>;

function j(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return "null";
  }
}

export async function insertRiskSnapshot(db: SnapshotDb, computedAt: string, columns: RiskColumns, payload: unknown): Promise<SnapshotRow> {
  return db.riskSnapshot.create({
    data: {
      tradeDate: columns.tradeDate, computedAt, level: columns.level, total: columns.total,
      advancers: columns.advancers, decliners: columns.decliners, limitUp: columns.limitUp, limitDown: columns.limitDown,
      breakRate: columns.breakRate, mainNetYi: columns.mainNetYi, medianPct: columns.medianPct, live: columns.live,
      payload: j(payload), missing: j(columns.missing), source: columns.source,
    },
  }) as unknown as SnapshotRow;
}

export async function insertThemeSnapshot(db: SnapshotDb, computedAt: string, columns: ThemeColumns, payload: unknown): Promise<SnapshotRow> {
  return db.themeSnapshot.create({
    data: {
      tradeDate: columns.tradeDate, computedAt, mainCount: columns.mainCount, subCount: columns.subCount,
      rotationCount: columns.rotationCount, watchCount: columns.watchCount,
      topMain: j(columns.topMain), payload: j(payload), missing: j(columns.missing), source: columns.source,
    },
  }) as unknown as SnapshotRow;
}

export async function insertProbabilitySnapshot(
  db: SnapshotDb, computedAt: string, columns: ProbabilityColumns, payload: unknown,
): Promise<SnapshotRow> {
  return db.probabilitySnapshot.create({
    data: {
      tradeDate: columns.tradeDate, computedAt, tradeDateIsHistorical: columns.tradeDateIsHistorical,
      scope: columns.scope, conditions: j(columns.conditions), universe: columns.universe, lookback: columns.lookback,
      pooled: j(columns.pooled), sampleOk: columns.sampleOk, benchmark: columns.benchmark,
      payload: j(payload), missing: j(columns.missing), source: columns.source,
    },
  }) as unknown as SnapshotRow;
}

const MODEL: Record<SnapshotKind, "riskSnapshot" | "themeSnapshot" | "probabilitySnapshot"> = {
  risk: "riskSnapshot",
  themes: "themeSnapshot",
  probability: "probabilitySnapshot",
};

/** 某天（或最近 take 条）的留档行：按留档时刻倒序 —— 同日多条是多次真实计算，都保留 */
export async function listSnapshotRows(db: SnapshotDb, kind: SnapshotKind, date = "", take = 10): Promise<SnapshotRow[]> {
  const model = db[MODEL[kind]] as never as {
    findMany(a: unknown): Promise<SnapshotRow[]>;
    count(a: unknown): Promise<number>;
  };
  return model.findMany({ where: date ? { tradeDate: date } : {}, orderBy: { computedAt: "desc" }, take: date ? 20 : take });
}

/** 有留档的日期 + 当天条数（只取 tradeDate 列，不把 payload 读进内存） */
export async function snapshotDateRows(db: SnapshotDb, kind: SnapshotKind): Promise<{ tradeDate: string }[]> {
  const model = db[MODEL[kind]] as never as { findMany(a: unknown): Promise<{ tradeDate: string }[]> };
  return model.findMany({ select: { tradeDate: true }, orderBy: { tradeDate: "desc" } });
}

export async function countSnapshots(db: SnapshotDb, kind: SnapshotKind): Promise<number> {
  const model = db[MODEL[kind]] as never as { count(a: unknown): Promise<number> };
  return model.count({});
}
