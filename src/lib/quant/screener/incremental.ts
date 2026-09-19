// P3 第三阶段 增量扫描的落库层：游标读写、老行补自然键、把增量计划原子写入数据库。
//
// 三条硬口径在这里的实现位置：
// 1) 游标只在「本次数据已全部落库成功」之后写（persist.ts 里先 apply、再 commitCursor；抛错就直接退出，游标不动）；
// 2) 写入以库内自然键为准（不是只信游标）：游标被裁剪、进程重启、甚至手工删过行，都不会造成重复插入或静默丢数据；
// 3) 所有写动作放进一个 $transaction：要么整批生效，要么整批不生效，避免出现「插了一半 + 游标已推进」。
//
// 只处理目标交易日的数据：回填与写入的 where 一律带 asOf = 当日，跨日历史行不触碰（沿用 P2 定稿的边界）。
import { db } from "@/lib/db";
import {
  eventKeyOf, radarKeyOf, type CursorLite, type EventDelta, type ExistingRowLite, type RadarDelta,
} from "./incremental-core";

export type ScanKind = "radar" | "events";

const parseKeys = (s: string): Record<string, string> => {
  try {
    const v = JSON.parse(s || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
    return out;
  } catch {
    return {}; // 游标损坏不等于「已确认」：返回空集，下次走完整比对重建
  }
};

const parseList = (s: string): string[] => {
  try {
    const v = JSON.parse(s || "[]") as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** 读当日游标；没有当日游标 ⇒ 首次（调用方据此走全量口径），绝不拿昨天的游标跳过今天 */
export async function loadCursor(kind: ScanKind, tradeDate: string): Promise<{ cursor: CursorLite | null; cursorTradeDate: string | null }> {
  const row = await db.scanCursor.findUnique({ where: { kind_tradeDate: { kind, tradeDate } } });
  if (!row) return { cursor: null, cursorTradeDate: null };
  return {
    cursor: { watermark: row.watermark, doneKeys: parseKeys(row.doneKeys), scannedUnmatched: parseList(row.unmatched), updatedAt: row.updatedAt.getTime() },
    cursorTradeDate: row.tradeDate,
  };
}

export interface CursorMeta { scanned: number; results: number; basis: string; note: string }

/**
 * 事务提交成功后才允许调用（函数名即口径）。
 * doneKeys 直接由「库里当前的 live 行」构建 —— 而不是把计划里的键原样记下：
 * 这样游标说的永远是「数据库里确实有这些行」，即使写入过程中有行为被合并或改判。
 */
export async function commitCursor(kind: ScanKind, tradeDate: string, cursor: CursorLite, meta: CursorMeta): Promise<void> {
  const data = {
    watermark: cursor.watermark,
    doneKeys: JSON.stringify(cursor.doneKeys),
    unmatched: JSON.stringify(cursor.scannedUnmatched),
    scanned: meta.scanned,
    results: meta.results,
    basis: meta.basis,
    note: meta.note,
    updatedAt: new Date(cursor.updatedAt),
  };
  await db.scanCursor.upsert({
    where: { kind_tradeDate: { kind, tradeDate } },
    create: { kind, tradeDate, ...data },
    update: data,
  });
}

const jsonOf = <T,>(s: string, fallback: T): T => {
  try {
    const v = JSON.parse(s || "") as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
};

/**
 * 老行补自然键（P2 时期写入的行没有键/指纹）。
 * 只补目标交易日、且 dedupeKey 为空的行；已有键的行不动 ⇒ 反复调用无副作用。
 * 不做这件事的话，增量扫描会把每条老行都当成「库里没有的键」再插一遍 —— 那正是本阶段要禁止的重复。
 */
export async function backfillRadarKeys(tradeDate: string): Promise<number> {
  const rows = await db.radarFinding.findMany({
    where: { asOf: tradeDate, dedupeKey: "" },
    select: { id: true, kind: true, title: true, detail: true, evidence: true },
  });
  if (!rows.length) return 0;
  await db.$transaction(rows.map((r) => db.radarFinding.update({
    where: { id: r.id },
    data: radarKeyOf({ kind: r.kind, title: r.title, detail: r.detail, evidence: jsonOf<Record<string, unknown>>(r.evidence, {}) }),
  })));
  return rows.length;
}

export async function backfillEventKeys(tradeDate: string): Promise<number> {
  const rows = await db.globalEvent.findMany({
    where: { asOf: tradeDate, dedupeKey: "" },
    select: { id: true, time: true, title: true, level: true, category: true, mappedSectors: true, relatedStocks: true, fundCheck: true, stage: true, source: true },
  });
  if (!rows.length) return 0;
  await db.$transaction(rows.map((r) => db.globalEvent.update({
    where: { id: r.id },
    data: eventKeyOf({
      time: r.time, title: r.title, level: r.level, category: r.category,
      mappedSectors: jsonOf<string[]>(r.mappedSectors, []),
      relatedStocks: jsonOf<string[]>(r.relatedStocks, []),
      fundCheck: jsonOf<Record<string, unknown>>(r.fundCheck, {}),
      stage: r.stage, source: r.source,
    }),
  })));
  return rows.length;
}

export interface ExistingSnapshot {
  /** 当日全部行（含已标记消失的），供规划阶段做键比对 */
  rows: ExistingRowLite[];
  /** 当日 live 行数：游标快速判定的完整性校验用 */
  liveCount: number;
  /** 当日 live 行的「键→指纹」：成功后写入游标 */
  liveKeys: Record<string, string>;
}

export async function radarSnapshot(tradeDate: string): Promise<ExistingSnapshot> {
  const rows = await db.radarFinding.findMany({
    where: { asOf: tradeDate },
    select: { id: true, dedupeKey: true, contentHash: true, state: true },
    orderBy: { createdAt: "asc" },
  });
  const live = rows.filter((r) => r.state !== "superseded");
  return {
    rows: rows.map((r) => ({ id: r.id, dedupeKey: r.dedupeKey, contentHash: r.contentHash, state: r.state })),
    liveCount: live.length,
    liveKeys: Object.fromEntries(live.filter((r) => r.dedupeKey).map((r) => [r.dedupeKey, r.contentHash])),
  };
}

export async function eventSnapshot(tradeDate: string): Promise<ExistingSnapshot> {
  const rows = await db.globalEvent.findMany({
    where: { asOf: tradeDate },
    select: { id: true, dedupeKey: true, contentHash: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    rows: rows.map((r) => ({ id: r.id, dedupeKey: r.dedupeKey, contentHash: r.contentHash })),
    liveCount: rows.length,
    liveKeys: Object.fromEntries(rows.filter((r) => r.dedupeKey).map((r) => [r.dedupeKey, r.contentHash])),
  };
}

export interface ApplyStats { inserted: number; updated: number; superseded: number }

/**
 * 雷达增量写入：新增、原地更新（含把再次算出的信号复活）、把本次不再产出的 live 行标记 superseded。
 * 全部动作在一个事务里；标记是改状态而不是删除，当天真实出现过的信号留给第四阶段复盘。
 */
export async function applyRadarDelta(tradeDate: string, d: RadarDelta): Promise<ApplyStats> {
  if (!d.insert.length && !d.update.length && !d.supersedeIds.length) return { inserted: 0, updated: 0, superseded: 0 };
  await db.$transaction(async (tx) => {
    for (const it of d.insert) {
      await tx.radarFinding.create({
        data: {
          asOf: tradeDate, kind: it.kind, title: it.title, detail: it.detail,
          evidence: JSON.stringify(it.evidence), dedupeKey: it.dedupeKey, contentHash: it.contentHash, state: "live",
        },
      });
    }
    for (const it of d.update) {
      await tx.radarFinding.update({
        where: { id: it.id },
        data: {
          kind: it.kind, title: it.title, detail: it.detail,
          evidence: JSON.stringify(it.evidence), dedupeKey: it.dedupeKey, contentHash: it.contentHash, state: "live",
        },
      });
    }
    if (d.supersedeIds.length) {
      await tx.radarFinding.updateMany({ where: { id: { in: d.supersedeIds } }, data: { state: "superseded" } });
    }
  });
  return { inserted: d.insert.length, updated: d.update.length, superseded: d.supersedeIds.length };
}

/** 事件增量写入：只有新增与变化；不删行、不标记消失（上游窗口是滚动的，滑出窗口不代表它错了） */
export async function applyEventDelta(tradeDate: string, d: EventDelta): Promise<ApplyStats> {
  if (!d.insert.length && !d.update.length) return { inserted: 0, updated: 0, superseded: 0 };
  await db.$transaction(async (tx) => {
    for (const it of d.insert) {
      await tx.globalEvent.create({
        data: {
          asOf: tradeDate, time: it.time, title: it.title,
          level: it.fields.level, category: it.fields.category,
          mappedSectors: JSON.stringify(it.fields.mappedSectors),
          relatedStocks: JSON.stringify(it.fields.relatedStocks),
          fundCheck: JSON.stringify(it.fields.fundCheck),
          stage: it.fields.stage, source: it.fields.source,
          dedupeKey: it.dedupeKey, contentHash: it.contentHash,
        },
      });
    }
    for (const it of d.update) {
      await tx.globalEvent.update({
        where: { id: it.id },
        data: {
          level: it.fields.level, category: it.fields.category,
          mappedSectors: JSON.stringify(it.fields.mappedSectors),
          relatedStocks: JSON.stringify(it.fields.relatedStocks),
          fundCheck: JSON.stringify(it.fields.fundCheck),
          stage: it.fields.stage, source: it.fields.source,
          dedupeKey: it.dedupeKey, contentHash: it.contentHash,
        },
      });
    }
  });
  return { inserted: d.insert.length, updated: d.update.length, superseded: 0 };
}

/** 游标摘要：/api/tasks/status 与页面用，回答「上次成功扫到哪一批数据」 */
export async function cursorSummary(kind: ScanKind, tradeDate: string) {
  const row = await db.scanCursor.findUnique({ where: { kind_tradeDate: { kind, tradeDate } } });
  if (!row) return { kind, trade_date: tradeDate, exists: false, watermark: "", done_keys: 0, unmatched_keys: 0, scanned: 0, results: 0, basis: "", note: "", updated_at: null };
  return {
    kind,
    trade_date: row.tradeDate,
    exists: true,
    watermark: row.watermark,
    done_keys: Object.keys(parseKeys(row.doneKeys)).length,
    unmatched_keys: parseList(row.unmatched).length,
    scanned: row.scanned,
    results: row.results,
    basis: row.basis,
    note: row.note,
    updated_at: row.updatedAt.toISOString(),
  };
}
