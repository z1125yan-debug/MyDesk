// P6-B AI 事件理解的服务层：把「真实事件（global_event 库行）」交给内核校验，再把校验通过的解释落库。
//
// 这一层存在的意义是**不信任客户端与模型**：
// - 提示词由服务端从库里现取的事实组装（GET /api/events/interpret/prompt）：页面拿不到事实就没有可拼的提示词；
// - 落库时同样由服务端重取事实、重新校验模型原文（POST /api/events/interpret）：
//   前端就算篡改 event_id、把概率加回 summary、多塞一条不存在的事件，也会被这里的复校验挡掉；
// - 事件的自然键用 dedupeKey（时间+标题指纹）而不是 cuid：全量扫描是「当日先删后插」，
//   cuid 每次重扫都变，只有自然键能让解释在重扫后仍然挂在同一条事件上。
//
// 口径：这张表里的东西永远是 AI_INTERPRETATION。事件事实只有 global_event 一份，这里不复制、不改写。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { recentEventWindow } from "./event-window.ts";
import {
  INTERPRET_PROMPT_VERSION, INTERPRET_SYSTEM_PROMPT, buildEventInterpretPrompt, fieldCompleteness,
  parseEventInterpretations, summarizeInterpretations, type EventFact, type EventInterpretation,
} from "./event-interpret-core.ts";

/** 事件行里解析不出 JSON 的列（P4 的 broken_columns 同口径：按缺失处理，不当成空值） */
interface RowIssue { key: string; broken: string[] }

function strArray(raw: string, broken: string[], col: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : [];
  } catch {
    broken.push(col);
    return [];
  }
}

function fundNoteOf(raw: string, broken: string[]): string {
  try {
    const v = JSON.parse(raw || "{}") as { note?: unknown };
    return typeof v?.note === "string" ? v.note : "";
  } catch {
    broken.push("fundCheck");
    return "";
  }
}

/** fundCheck 里的结构化板块资金：[{name, changePct, mainYi, rank, leader}]（P7-1 提示词上下文）。 */
function fundBoardsOf(raw: string, broken: string[]): { name: string; change_pct: number | null; main_yi: number | null; leader: string }[] {
  try {
    const v = JSON.parse(raw || "{}") as { boards?: unknown };
    if (!Array.isArray(v.boards)) return [];
    const out: { name: string; change_pct: number | null; main_yi: number | null; leader: string }[] = [];
    for (const b of v.boards) {
      const o = (b ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      if (!name) continue;
      const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);
      out.push({ name, change_pct: num(o.changePct), main_yi: num(o.mainYi), leader: String(o.leader ?? "").trim() });
    }
    return out;
  } catch {
    broken.push("fundCheck.boards");
    return [];
  }
}

/** fundCheck 里的龙头主力净额：[{name, code, mainNetYi, superNetYi, bigNetYi}]（P7-1 重点票出处）。 */
function fundLeadersOf(raw: string, broken: string[]): { name: string; code: string; main_net_yi: number | null }[] {
  try {
    const v = JSON.parse(raw || "{}") as { stockFunds?: unknown };
    if (!Array.isArray(v.stockFunds)) return [];
    const out: { name: string; code: string; main_net_yi: number | null }[] = [];
    for (const s of v.stockFunds) {
      const o = (s ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      if (!name) continue;
      const main = typeof o.mainNetYi === "number" && isFinite(o.mainNetYi) ? o.mainNetYi : null;
      out.push({ name, code: String(o.code ?? "").trim(), main_net_yi: main });
    }
    return out;
  } catch {
    broken.push("fundCheck.stockFunds");
    return [];
  }
}

type EventRow = {
  id: string; dedupeKey: string; contentHash: string; asOf: string; title: string; time: string;
  level: string; category: string; mappedSectors: string; relatedStocks: string; fundCheck: string;
  stage: string; source: string;
};

/**
 * 库行 → 内核的事实结构。
 * event_id 用 dedupeKey；没有自然键的旧行退回该行 id（并记进 issues，让页面能说明这是哪一类行）。
 */
export function factOfRow(row: EventRow): { fact: EventFact; issue: RowIssue } {
  const broken: string[] = [];
  if (!row.dedupeKey) broken.push("dedupeKey（旧行未回填自然键：本次以行 id 作为事件标识）");
  return {
    fact: {
      event_id: row.dedupeKey || row.id,
      published_at: row.time,
      title: row.title,
      source: row.source,
      level: row.level,
      category: row.category,
      mapped_sectors: strArray(row.mappedSectors, broken, "mappedSectors"),
      related_names: strArray(row.relatedStocks, broken, "relatedStocks"),
      fund_note: fundNoteOf(row.fundCheck, broken),
      stage: row.stage,
      trade_date: row.asOf,
      fund_boards: fundBoardsOf(row.fundCheck, broken),
      fund_leaders: fundLeadersOf(row.fundCheck, broken),
    },
    issue: { key: row.dedupeKey || row.id, broken },
  };
}

export interface FactBundle {
  date: string;
  facts: EventFact[];
  /** event_id（自然键）→ 当前库行的 id / contentHash：落库时要写、回看时要比对是否过时 */
  rows: Record<string, { row_id: string; content_hash: string }>;
  issues: RowIssue[];
  /** 当日库里的总行数与本次参与数（limit 生效时要如实说明只取了前 N 条） */
  total_rows: number;
  selected: number;
  limited: boolean;
}

/**
 * 读某一天的真实事件行（只读）。没有行就返回空 facts，由调用方按「无事件」处理，不猜别的日子。
 * ids 可以是自然键（event_id），也可以是页面表格里拿到的行 id —— 两种都认，但都只做「圈定范围」，
 * 不参与构造事实：事实字段一律从库里现取的值来。
 *
 * P7-1：同时给每条事实补市场宽度（market_daily_stats，事件日）与板块近期走势
 * （data/sector-daily-snapshots.json，事件日快照里的 5/20/60 日涨跌幅）。快照文件 7.8MB，
 * 模块级懒加载缓存一次；读不到/对不上板块名时该项留空，不编。
 */
let snapshotsCache: Record<string, { industries?: { name?: string; medianChange?: number; prevChange5?: number; prevChange20?: number; prevChange60?: number }[] }> | null = null;
let snapshotsTried = false;
function loadSectorSnapshots(): Record<string, { industries?: { name?: string; medianChange?: number; prevChange5?: number; prevChange20?: number; prevChange60?: number }[] }> {
  if (snapshotsTried) return snapshotsCache ?? {};
  snapshotsTried = true;
  try {
    const raw = readFileSync(join(process.cwd(), "data", "sector-daily-snapshots.json"), "utf8");
    const parsed = JSON.parse(raw) as { days?: Record<string, unknown> };
    snapshotsCache = (parsed.days ?? {}) as Record<string, { industries?: { name?: string; medianChange?: number; prevChange5?: number; prevChange20?: number; prevChange60?: number }[] }>;
  } catch {
    snapshotsCache = {};
  }
  return snapshotsCache ?? {};
}

function sectorHistoryFor(date: string, sectors: string[]): { as_of: string; sector: string; day_change: number | null; change_5d: number | null; change_20d: number | null; change_60d: number | null }[] {
  const snaps = loadSectorSnapshots();
  // 快照文件可能滞后于事件日（例如文件只到 09-29，事件是 10-16）：取该日前最近一个有快照的交易日，
  // 并把真实快照日期带回去（as_of），提示词里标出，不拿旧快照冒充当日。
  const snapDate = Object.keys(snaps).filter((d) => d <= date).sort().at(-1);
  if (!snapDate) return [];
  const day = snaps[snapDate];
  const industries = Array.isArray(day?.industries) ? day!.industries! : [];
  if (!industries.length) return [];
  const out: { as_of: string; sector: string; day_change: number | null; change_5d: number | null; change_20d: number | null; change_60d: number | null }[] = [];
  for (const s of sectors) {
    const hit = industries.find((x) => x?.name === s)
      ?? industries.find((x) => x?.name && (x.name.includes(s) || s.includes(x.name)));
    if (!hit) continue;
    const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);
    out.push({
      as_of: snapDate,
      sector: s,
      day_change: num(hit.medianChange),
      change_5d: num(hit.prevChange5),
      change_20d: num(hit.prevChange20),
      change_60d: num(hit.prevChange60),
    });
  }
  return out;
}
export async function loadEventFacts(opts: { date?: string; ids?: string[]; limit?: number } = {}): Promise<FactBundle> {
  const explicit = (opts.date ?? "").trim();
  let date: string;
  let all: Awaited<ReturnType<typeof db.globalEvent.findMany>>;
  if (explicit) {
    date = explicit;
    all = await db.globalEvent.findMany({ where: { asOf: date }, orderBy: { time: "desc" } });
  } else {
    // 未指定日期 → 「最近事件窗口」：最近那天不足 20 条时按新→旧自动补更早的日子（见 event-window.ts）。
    // 列表（/api/events）与这里共用同一份窗口，保证「看到什么就理解什么」。
    const win = await recentEventWindow();
    date = win.dates[0] ?? shanghaiDate();
    all = win.rows;
  }
  const mapped = all.map(factOfRow);
  const want = opts.ids?.map((x) => String(x).trim()).filter(Boolean) ?? [];
  let picked = mapped;
  if (want.length) {
    const idSet = new Set(want);
    picked = mapped.filter((m, i) => idSet.has(m.fact.event_id) || idSet.has(all[i].id));
  }
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 0;
  const limited = limit > 0 && picked.length > limit;
  if (limited) picked = picked.slice(0, limit);
  const byKey = new Map(all.map((r) => [r.dedupeKey || r.id, r] as const));
  // P7-1：给每条事实补市场宽度与板块近期走势。宽度来自 market_daily_stats；
  // 事件日当天未收盘（宽度表还没有该日）时取该日前最近一个交易日的宽度，并带真实日期
  // （fund 数据本身也是上一收盘的冻结值，两者口径一致；提示词里 trade_date 就是真实日期，不冒充当日）。
  // 板块走势同理：快照文件滞后时取该日前最近快照，带真实快照日期。
  const dates = [...new Set(picked.map((m) => m.fact.trade_date ?? ""))].filter(Boolean);
  let allStats: { tradeDate: string; limit_up: number | null; limit_down: number | null; decliners: number | null; above_ma5_pct: number | null }[] = [];
  try {
    const stats = await db.marketDailyStats.findMany({ orderBy: { tradeDate: "desc" } });
    allStats = stats.map((s) => ({
      tradeDate: s.tradeDate,
      limit_up: s.limitUp ?? null,
      limit_down: s.limitDown ?? null,
      decliners: s.decliners ?? null,
      above_ma5_pct: s.aboveMa5Pct ?? null,
    }));
  } catch {
    allStats = [];
  }
  for (const m of picked) {
    const td = m.fact.trade_date ?? "";
    const hit = allStats.find((s) => s.tradeDate <= td);
    m.fact.market = hit ? { trade_date: hit.tradeDate, limit_up: hit.limit_up, limit_down: hit.limit_down, decliners: hit.decliners, above_ma5_pct: hit.above_ma5_pct } : null;
    m.fact.sector_history = sectorHistoryFor(td, m.fact.mapped_sectors);
  }
  return {
    date,
    facts: picked.map((m) => m.fact),
    rows: Object.fromEntries(picked.map((m) => {
      const r = byKey.get(m.fact.event_id);
      return [m.fact.event_id, { row_id: r?.id ?? "", content_hash: r?.contentHash ?? "" }];
    })),
    issues: picked.map((m) => m.issue).filter((i) => i.broken.length),
    total_rows: all.length,
    selected: picked.length,
    limited,
  };
}

export interface PromptBundle extends FactBundle {
  ok: boolean;
  system: string;
  prompt: string;
  prompt_version: string;
  basis: string;
  missing: string[];
  error: string | null;
}

/** 组装给模型的提示词（只含服务端从库里取到的真实事件；这一步不写库、不打上游） */
export async function buildInterpretPrompt(opts: { date?: string; ids?: string[]; limit?: number } = {}): Promise<PromptBundle> {
  const bundle = await loadEventFacts(opts);
  const missing: string[] = [];
  if (!bundle.facts.length) {
    missing.push(`${bundle.date} 的 global_event 里没有任何事件行：没有真实事件可理解，本次不产出解释（也不会去猜一条新闻）`);
  }
  if (bundle.limited) missing.push(`当日 ${bundle.total_rows} 条事件，本次只取最新的 ${bundle.selected} 条（受 limit 限制）：其余事件本次没有解释，不是它们不重要`);
  for (const i of bundle.issues) missing.push(`${i.key}：字段无法解析 ${i.broken.join("、")}（按缺失处理，不当作空值喂给模型）`);
  return {
    ...bundle,
    ok: bundle.facts.length > 0,
    system: INTERPRET_SYSTEM_PROMPT,
    prompt: bundle.facts.length ? buildEventInterpretPrompt(bundle.facts) : "",
    prompt_version: INTERPRET_PROMPT_VERSION,
    basis: `事实来自全球事件明细（留档日=${bundle.date}）的 ${bundle.facts.length} 行真实事件；解释口径版本 ${INTERPRET_PROMPT_VERSION}`,
    missing,
    error: null,
  };
}

export interface StoreResult {
  ok: boolean;
  date: string;
  persisted: number;
  updated: number;
  inserted: number;
  items: EventInterpretation[];
  missing: { event_id: string; title: string; reason: string }[];
  unknown_ids: string[];
  parse_failed: boolean;
  error: string | null;
  counts: ReturnType<typeof summarizeInterpretations>["counts"];
  layering: string;
  basis: string;
}

/**
 * 模型原文 → 服务端复校验 → 落库。
 * 事实字段以这里重新读到的库行为准：客户端传来的 ids 只用于圈定范围，不参与构造事实。
 */
export async function storeInterpretations(input: {
  raw: string; model?: string; date?: string; ids?: string[]; limit?: number;
}): Promise<StoreResult> {
  const bundle = await loadEventFacts({ date: input.date, ids: input.ids, limit: input.limit });
  const stamp = shanghaiStamp();
  const parsed = parseEventInterpretations(String(input.raw ?? ""), bundle.facts, {
    model: (input.model ?? "").trim() || "未记录",
    generated_at: stamp,
  });
  let updated = 0;
  let inserted = 0;
  // 一次查出本批已有的自然键，避免逐条 findUnique；写入统一用 upsert（同一事件重做解释是覆盖，不是堆历史行）
  const known = new Set(await (await db.eventInterpretation.findMany({
    where: { eventKey: { in: parsed.items.map((i) => i.event_id) } },
    select: { eventKey: true },
  })).map((r) => r.eventKey));
  for (const itp of parsed.items) {
    const row = bundle.rows[itp.event_id] ?? { row_id: "", content_hash: "" };
    const data = {
      eventId: row.row_id,
      asOf: itp.trade_date || bundle.date,
      title: itp.title,
      source: itp.source,
      publishedAt: itp.published_at,
      eventHash: row.content_hash,
      status: itp.interpretation_status,
      model: itp.model,
      promptVersion: itp.prompt_version,
      violations: JSON.stringify(itp.violations),
      payload: JSON.stringify(itp),
    };
    await db.eventInterpretation.upsert({
      where: { eventKey: itp.event_id },
      update: data,
      create: { eventKey: itp.event_id, ...data },
    });
    if (known.has(itp.event_id)) updated++; else inserted++;
  }
  const sum = summarizeInterpretations(parsed.items, parsed.missing.length, parsed.unknown_ids.length);
  return {
    ok: parsed.ok,
    date: bundle.date,
    persisted: parsed.items.length,
    updated,
    inserted,
    items: parsed.items,
    missing: parsed.missing,
    unknown_ids: parsed.unknown_ids,
    parse_failed: parsed.parse_failed,
    error: parsed.error,
    counts: sum.counts,
    layering: sum.layering,
    basis: `服务端按全球事件明细（留档日=${bundle.date}）的 ${bundle.facts.length} 行真实事件复校验后落库 ${parsed.items.length} 条；事件按自然键对应，重扫后仍可逐条对上`,
  };
}

/** 一条已落库的解释 + 与当前事件行的对应关系（回看时必须能看出它还站不站得住） */
export interface InterpretationView extends EventInterpretation {
  row_id: string;
  /** true = 事件行的 contentHash 与解释生成时不一致：映射/资金验证变了，解释需要重做 */
  stale: boolean;
  /** true = 当日库里已找不到这条事件行（如 P5 生命周期清理掉了那天）：只剩快照，无法再核对原文 */
  orphan: boolean;
  payload_broken: boolean;
}

export interface LoadResult {
  ok: true;
  as_of: string;
  today: string;
  items: InterpretationView[];
  available_dates: { date: string; rows: number }[];
  counts: { rows: number; interpreted: number; partial: number; rejected: number; stale: number; orphan: number; violations: number; hypothesis_symbols: number };
  layering: string;
  missing: string[];
  self_check: { broken_payload: string[]; missing_fields: string[] };
  basis: string;
  probed_at: string;
}

/** 只读回看：按 asOf 取已落库的解释，并与当天事件行对一遍（不改写任何数据） */
export async function loadInterpretations(opts: { date?: string } = {}): Promise<LoadResult> {
  const today = shanghaiDate();
  const explicit = (opts.date ?? "").trim();
  // 未指定日期 → 与列表同一份「最近事件窗口」：过午夜后也能把昨天那批解释读回来，并按自然键逐条对照
  const dates = explicit ? [explicit] : (await recentEventWindow()).dates;
  const scope = dates.length ? dates : [today];
  const date = scope[0];
  const [rows, buckets] = await Promise.all([
    db.eventInterpretation.findMany({ where: { asOf: { in: scope } }, orderBy: { updatedAt: "desc" } }),
    db.eventInterpretation.groupBy({ by: ["asOf"], _count: { _all: true } }),
  ]);
  const events = rows.length ? await db.globalEvent.findMany({ where: { asOf: { in: scope } } }) : [];
  const cur = new Map<string, { id: string; contentHash: string; title: string }>();
  for (const e of events) cur.set(e.dedupeKey || e.id, { id: e.id, contentHash: e.contentHash, title: e.title });

  const items: InterpretationView[] = [];
  const broken_payload: string[] = [];
  const missing_fields: string[] = [];
  for (const r of rows) {
    let itp: EventInterpretation | null = null;
    try {
      const v = JSON.parse(r.payload || "{}") as EventInterpretation;
      itp = v && typeof v === "object" && Array.isArray(v.entities) ? v : null;
    } catch {
      itp = null;
    }
    if (!itp) {
      broken_payload.push(`${r.eventKey}：payload 不是可解析的解释结构（按缺失处理，不猜内容）`);
      continue;
    }
    const comp = fieldCompleteness(itp);
    if (comp.missing.length) missing_fields.push(`${r.eventKey}：§九 字段缺 ${comp.missing.join("、")}`);
    const now = cur.get(r.eventKey);
    items.push({
      ...itp,
      // 事件事实以库里现值为准：解释快照里的 title/source 只用于事件行已经不在了的情况
      title: now?.title ?? itp.title,
      row_id: now?.id ?? "",
      stale: !!now && !!r.eventHash && now.contentHash !== r.eventHash,
      orphan: !now,
      payload_broken: false,
    });
  }

  const counts = {
    rows: items.length,
    interpreted: items.filter((i) => i.interpretation_status === "INTERPRETED").length,
    partial: items.filter((i) => i.interpretation_status === "PARTIAL").length,
    rejected: items.filter((i) => i.interpretation_status === "REJECTED").length,
    stale: items.filter((i) => i.stale).length,
    orphan: items.filter((i) => i.orphan).length,
    violations: items.reduce((n, i) => n + (i.violations?.length ?? 0), 0),
    hypothesis_symbols: items.reduce((n, i) => n + (i.hypothesized_symbols?.length ?? 0), 0),
  };
  const missing: string[] = [];
  if (!items.length) {
    missing.push(`${date} 还没有任何 AI 事件理解结果：这一层的解释只在有人显式点「AI 理解今日事件」时产生，没做过就是空（不是失败，也不会自动补）`);
  }
  if (counts.stale) missing.push(`${counts.stale} 条解释针对的事件版本已变化（映射或资金验证被重扫刷新过）：需要重新理解才对应得上`);
  if (counts.orphan) missing.push(`${counts.orphan} 条解释的原始事件行已不在当天库里（例如那天的事件被生命周期清理）：只剩解释快照，无法再核对原文`);
  if (broken_payload.length) missing.push(...broken_payload);
  if (missing_fields.length) missing.push(...missing_fields);

  return {
    ok: true,
    as_of: date,
    today,
    items,
    available_dates: buckets
      .map((b) => ({ date: b.asOf, rows: b._count?._all ?? 0 }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
    counts,
    layering:
      `已落库解释 ${counts.rows} 条（完整解释 ${counts.interpreted} / 部分可用 ${counts.partial} / 不可用 ${counts.rejected}）；` +
      `全部属于「AI 解释」层：事件事实只有库里的事件明细一份，解释不构成事实；` +
      `置信度是解释的可信程度，不是上涨概率`,
    missing,
    self_check: { broken_payload, missing_fields },
    basis: `读取留档日=${date} 的解释结果，并与当日事件明细按自然键逐条对照「过期/孤儿」；只读，不重算、不改写`,
    probed_at: shanghaiStamp(),
  };
}

/** 能力探测用的轻读数：这张表有多少条、最新一天是哪天（不返回内容） */
export async function interpretationSignal() {
  const [rows, latest] = await Promise.all([
    db.eventInterpretation.count(),
    db.eventInterpretation.findFirst({ orderBy: { asOf: "desc" }, select: { asOf: true, updatedAt: true } }),
  ]);
  return { rows, date: latest?.asOf ?? null };
}
