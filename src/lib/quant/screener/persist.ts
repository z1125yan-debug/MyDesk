// P2 归档写入的唯一实现：扫描 → 落库 → 回读；P3 在此之上加增量口径。
// HTTP 路由（手动点击）与后台调度器（收盘后自动）都走这里，避免两处各写一份幂等逻辑而口径漂移。
//
// 两种口径（判定公式完全同一套，只是「写哪些行」不同）：
// - full（P2 定稿，也是手动点击与当日首次扫描的口径）：deleteMany 只限 asOf = 本次交易日，再整批 createMany，
//   跨日历史行不触碰。
// - incremental（P3）：不删行。按自然键 + 内容指纹与库内比对，只插新增、只改内容变了的行；
//   雷达把「本次按原公式不再产出」的当日 live 行标记 superseded（改状态不物理删除），事件不标记消失（上游是滚动窗口）。
// 两种口径成功后都会推进游标；游标只在成功路径写（见 incremental.ts 的 commitCursor 调用位置）。
import { db } from "@/lib/db";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { buildRadarFindings } from "./radar";
import {
  collectNews, fetchBoardContext, scanGlobalEvents, themeMapFingerprint, type EventScanItem, type NewsLite,
} from "./events";
import {
  advanceCursor, cursorCommitsNothing, decideMode, eventKeyOf, eventNaturalKey, freshUnmatched, modeBasisLabel,
  newsFingerprint, planEventDelta, planRadarDelta, radarKeyOf, setFingerprint, unmatchedKeyWithBasis,
} from "./incremental-core";
import {
  applyEventDelta, applyRadarDelta, backfillEventKeys, backfillRadarKeys, commitCursor, eventSnapshot,
  loadCursor, radarSnapshot, type ScanKind,
} from "./incremental";

export interface RadarRow {
  id: string; kind: string; title: string; detail: string; evidence: Record<string, unknown>;
}
export interface EventRow {
  id: string; title: string; time: string; level: string; category: string;
  mappedSectors: string[]; relatedStocks: string[]; fundCheck: Record<string, unknown>; stage: string; source: string;
}

export type ScanMode = "full" | "incremental";
export interface ArchiveOpts {
  /** "auto"（缺省）：当日已有游标就走增量，否则走全量；force（人工点击）视为全量 */
  mode?: "auto" | "full" | "incremental";
  force?: boolean;
}
export interface DeltaStats {
  /** 上游产出条数（雷达=候选数；事件=快讯窗口条数） */
  scanned: number;
  inserted: number;
  updated: number;
  /** 库里已有且内容一致，本次没有重写的行数 */
  unchanged: number;
  /** 被游标快速路径直接判定为「上次成功已确认」而跳过的条数（只有快速路径会产生非零值） */
  skippedByCursor: number;
  /** 本次不再产出、被标记为已消失的当日行数（事件恒为 0：快讯滑出窗口不代表它错了） */
  superseded: number;
  /** 事件专用：已入库但不在本次上游窗口里的行数（原样保留） */
  kept: number;
  /** 同一批候选里撞键被合并掉的条数（不是丢弃数据：合并后仍是同一条信号） */
  collapsed: number;
}

export interface ArchiveResult<T> {
  as_of: string;
  trade_date: string;
  missing: string[];
  /** 上游产出条数（落库前的候选数） */
  scanned: number;
  /** 实际落库条数（= 当日 live 行数） */
  results: number;
  items: T[];
  /** 未映射/未采纳计数（事件用），雷达为 null */
  unmatched: number | null;
  source: string;
  /** P3：本次采用的口径 */
  mode: ScanMode;
  /** P3：本次写入明细，供接口/页面如实展示「新增几条、改了几条、没动几条」 */
  delta: DeltaStats;
}

const radarRow = (r: {
  id: string; kind: string; title: string; detail: string; evidence: string;
}): RadarRow => ({
  id: r.id, kind: r.kind, title: r.title, detail: r.detail,
  evidence: JSON.parse(r.evidence || "{}") as Record<string, unknown>,
});

const eventRow = (r: {
  id: string; title: string; time: string; level: string; category: string;
  mappedSectors: string; relatedStocks: string; fundCheck: string; stage: string; source: string;
}): EventRow => ({
  id: r.id, title: r.title, time: r.time, level: r.level, category: r.category,
  mappedSectors: JSON.parse(r.mappedSectors || "[]") as string[],
  relatedStocks: JSON.parse(r.relatedStocks || "[]") as string[],
  fundCheck: JSON.parse(r.fundCheck || "{}") as Record<string, unknown>,
  stage: r.stage, source: r.source,
});

const zeroDelta = (scanned: number): DeltaStats => ({
  scanned, inserted: 0, updated: 0, unchanged: 0, skippedByCursor: 0, superseded: 0, kept: 0, collapsed: 0,
});

/** EventScanItem → 落库字段 + 自然键与指纹（指纹由 eventKeyOf 统一算，与老行回填同一实现） */
function eventCandidate(it: EventScanItem) {
  const fields = {
    time: it.time,
    title: it.title,
    level: it.level,
    category: it.category,
    mappedSectors: it.mappedSectors ?? [],
    relatedStocks: it.relatedLeaders ?? [],
    fundCheck: (it.fund ?? {}) as Record<string, unknown>,
    stage: it.fund?.stage ?? "",
    source: it.source,
  };
  return { ...fields, ...eventKeyOf(fields) };
}

/** 本次扫描里「没有映射上」的快讯指纹 → 游标键（带映射表指纹，改表后自动失效重判） */
function unmatchedOf(news: NewsLite[], matched: { time: string; title: string }[], rulesFp: string): string[] {
  const fps = new Set(matched.map((m) => newsFingerprint(m.time, m.title)));
  return news.filter((n) => !fps.has(newsFingerprint(n.time, n.title)))
    .map((n) => unmatchedKeyWithBasis(newsFingerprint(n.time, n.title), rulesFp));
}

const newsWatermark = (news: NewsLite[]): string => setFingerprint(news, (n) => newsFingerprint(n.time, n.title));

export async function archiveRadarScan(opts: ArchiveOpts = {}): Promise<ArchiveResult<RadarRow>> {
  const scan = await buildRadarFindings();
  const tradeDate = scan.trade_date;
  const kind: ScanKind = "radar";
  const { cursor, cursorTradeDate } = await loadCursor(kind, tradeDate);
  // 先补键再规划：P2 时期写入的老行没有自然键，不补就会被当成「库里没有的键」再插一遍（正是要禁止的重复）
  const backfilled = await backfillRadarKeys(tradeDate);
  const mode = decideMode({ force: opts.force, mode: opts.mode, cursor, tradeDate, cursorTradeDate });
  const keyed = scan.items.map((it) => ({ it, key: radarKeyOf(it) }));
  const watermark = setFingerprint(keyed, (x) => `${x.key.dedupeKey}:${x.key.contentHash}`);
  let delta: DeltaStats;
  let fastPath = false; // 增量：游标指纹一致时整批跳过（不逐行比对库），需要在游标备注里写明
  if (mode === "full") {
    // 当日先删后插（P2 定稿口径）；同批撞键合并为一行、保留后到内容，与「读回即为当日全集」一致
    const byKey = new Map<string, (typeof keyed)[number]>();
    for (const x of keyed) byKey.set(x.key.dedupeKey, x);
    await db.radarFinding.deleteMany({ where: { asOf: tradeDate } });
    const data = [...byKey.values()].map(({ it, key }) => ({
      asOf: tradeDate, kind: it.kind, title: it.title, detail: it.detail,
      evidence: JSON.stringify(it.evidence ?? {}), state: "live", ...key,
    }));
    if (data.length) await db.radarFinding.createMany({ data });
    delta = {
      ...zeroDelta(scan.items.length),
      inserted: data.length,
      collapsed: scan.items.length - data.length,
    };
  } else {
    const snap = await radarSnapshot(tradeDate);
    if (cursorCommitsNothing(cursor, { watermark, liveCount: snap.liveCount })) {
      // 快速路径：候选指纹一致 + 库内 live 行数与游标键数一致 ⇒ 本次没有任何要写的东西。
      // 计数只记一次：这 N 条既「未变」也是「被游标跳过」，两个字段都填会让页面算出 2N 条候选。
      fastPath = true;
      delta = { ...zeroDelta(scan.items.length), unchanged: snap.liveCount };
    } else {
      const d = planRadarDelta(scan.items, snap.rows);
      const st = await applyRadarDelta(tradeDate, d);
      delta = {
        ...zeroDelta(scan.items.length),
        inserted: st.inserted, updated: st.updated, superseded: st.superseded,
        unchanged: d.unchanged, collapsed: d.candidates - (d.insert.length + d.update.length + d.unchanged),
      };
    }
  }
  const rows = await db.radarFinding.findMany({ where: { asOf: tradeDate, state: "live" }, orderBy: { createdAt: "asc" } });
  const doneKeys = Object.fromEntries(rows.filter((r) => r.dedupeKey).map((r) => [r.dedupeKey, r.contentHash]));
  const next = advanceCursor(cursor, { watermark, doneKeys });
  const basis = `${modeBasisLabel(mode)}：候选 ${scan.items.length} 条 → 新增 ${delta.inserted}、更新 ${delta.updated}、未变 ${delta.unchanged}、标记消失 ${delta.superseded}`;
  await commitCursor(kind, tradeDate, next, {
    scanned: scan.items.length,
    results: rows.length,
    basis,
    note: [
      fastPath ? "游标水位线与库内 live 行数一致 → 整批按未变处理，本次未产生任何写入" : "",
      delta.collapsed ? `同批撞键合并 ${delta.collapsed} 条` : "",
      backfilled ? `为 ${backfilled} 条历史行补齐自然键` : "",
    ].filter(Boolean).join("；"),
  });
  return {
    as_of: scan.as_of,
    trade_date: tradeDate,
    missing: mode === "incremental"
      ? [...scan.missing, "增量口径：候选信号仍按原公式全量计算，只跳过「库里已有且内容未变」的行；已存在行的首次发现时刻不被覆盖"]
      : scan.missing,
    scanned: scan.items.length,
    results: rows.length,
    items: rows.map(radarRow),
    unmatched: null,
    source: "computeSentiment + discoverThemes + scanGlobalEvents → radar_finding",
    mode,
    delta,
  };
}

export async function archiveEventScan(opts: ArchiveOpts = {}): Promise<ArchiveResult<EventRow>> {
  const tradeDate = shanghaiDate();
  const kind: ScanKind = "events";
  const { cursor, cursorTradeDate } = await loadCursor(kind, tradeDate);
  const backfilled = await backfillEventKeys(tradeDate);
  const mode = decideMode({ force: opts.force, mode: opts.mode, cursor, tradeDate, cursorTradeDate });
  const rulesFp = themeMapFingerprint();
  const news = await collectNews(); // 两种口径都要先取窗口：取不到就抛错，不静默当成「今天没有事件」
  const watermark = newsWatermark(news);
  let delta: DeltaStats;
  let unmatched: number;
  let missing: string[];
  let source: string;
  let unmatchedKeys: string[];

  if (mode === "full") {
    const scan = await scanGlobalEvents({ news });
    const candidates = scan.items.map(eventCandidate);
    const byKey = new Map(candidates.map((c) => [c.dedupeKey, c] as const));
    await db.globalEvent.deleteMany({ where: { asOf: tradeDate } });
    const data = [...byKey.values()].map((c) => ({
      asOf: tradeDate,
      title: c.title,
      time: c.time,
      level: c.level,
      category: c.category,
      mappedSectors: JSON.stringify(c.mappedSectors),
      relatedStocks: JSON.stringify(c.relatedStocks),
      fundCheck: JSON.stringify(c.fundCheck),
      stage: c.stage,
      source: c.source,
      dedupeKey: c.dedupeKey,
      contentHash: c.contentHash,
    }));
    if (data.length) await db.globalEvent.createMany({ data });
    delta = { ...zeroDelta(news.length), inserted: data.length, collapsed: candidates.length - data.length };
    unmatched = scan.unmatched;
    missing = scan.missing;
    source = scan.source;
    unmatchedKeys = unmatchedOf(news, scan.items, rulesFp);
  } else {
    const snap = await eventSnapshot(tradeDate);
    const known = new Set(Object.keys(snap.liveKeys));
    const skipUnmatched = freshUnmatched(cursor, rulesFp);
    // 增量入口：只处理「库里还没有、且游标里也没记为未命中」的快讯
    const fresh = news.filter((n) => !known.has(eventNaturalKey(n)) && !skipUnmatched.has(newsFingerprint(n.time, n.title)));
    unmatchedKeys = [];
    if (fresh.length) {
      // 复用同一个 scanGlobalEvents（只传本次新增的快讯 + 一起取到的板块榜）：映射与资金验证只有一份实现
      const boards = await fetchBoardContext();
      const scan = await scanGlobalEvents({ news: fresh, boards });
      const d = planEventDelta(scan.items.map(eventCandidate), snap.rows);
      const st = await applyEventDelta(tradeDate, d);
      unmatchedKeys = unmatchedOf(fresh, scan.items, rulesFp);
      delta = {
        ...zeroDelta(news.length),
        inserted: st.inserted, updated: st.updated,
        unchanged: d.unchanged, kept: d.kept,
        collapsed: d.candidates - (d.insert.length + d.update.length + d.unchanged),
      };
      unmatched = fresh.length - scan.items.length;
      missing = [
        ...scan.missing,
        `增量口径：本次上游窗口 ${news.length} 条，其中 ${fresh.length} 条为新增（其余已入库或此前已判定未命中，未重复跑映射与资金验证）`,
        "增量口径：已入库事件的资金验证结果保持其首次入库时的值，不随本次板块榜刷新（点「立即扫描」按全量口径会刷新）",
      ];
      source = `${scan.source}；增量：只判定新增快讯`;
    } else {
      // 没有任何新增快讯：连板块资金榜的 4 次上游请求都不发，也不写库
      delta = { ...zeroDelta(news.length), unchanged: snap.liveCount, skippedByCursor: news.length - fresh.length, kept: snap.liveCount };
      unmatched = 0;
      missing = [
        `增量口径：本次上游窗口 ${news.length} 条快讯全部已处理过（已入库 ${snap.liveCount} 条、此前判定未命中 ${skipUnmatched.size} 条），未重复取板块资金榜，也未产生任何写入`,
        "未命中记录带映射表指纹；改动 data/theme-chain-map.json 后旧结论自动失效、下次重新判定",
      ];
      source = "增量：上游窗口无新增快讯（沿用上次成功入库结果）";
    }
  }

  const rows = await db.globalEvent.findMany({ where: { asOf: tradeDate }, orderBy: { createdAt: "desc" } });
  const doneKeys = Object.fromEntries(rows.filter((r) => r.dedupeKey).map((r) => [r.dedupeKey, r.contentHash]));
  const next = advanceCursor(cursor, { watermark, doneKeys, unmatchedKeys });
  const basis = `${modeBasisLabel(mode)}：快讯窗口 ${news.length} 条 → 新增 ${delta.inserted}、更新 ${delta.updated}、未变 ${delta.unchanged}、保留 ${delta.kept}`;
  await commitCursor(kind, tradeDate, next, {
    scanned: news.length,
    results: rows.length,
    basis,
    note: [
      delta.collapsed ? `同批撞键合并 ${delta.collapsed} 条` : "",
      backfilled ? `为 ${backfilled} 条历史行补齐自然键` : "",
    ].filter(Boolean).join("；"),
  });
  return {
    as_of: shanghaiStamp(),
    trade_date: tradeDate,
    missing,
    scanned: news.length,
    results: rows.length,
    items: rows.map(eventRow),
    unmatched,
    source,
    mode,
    delta,
  };
}
