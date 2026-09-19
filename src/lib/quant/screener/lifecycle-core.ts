// P5 第五阶段 数据生命周期（旧信号清理）的纯内核：只做「哪天算过期、能不能删、删之前导出什么」的判定与文案，
// 不碰数据库、不碰文件系统、不取当前时间（today 一律由调用方用 shanghaiDate() 传入）。
//
// 为什么单独一个文件、且刻意不 import 任何带 @/ 别名的模块：
//   node --test 只做 type-strip，相对 import 必须带 .ts 后缀 —— 这样清理判定就能被单测真跑一遍，
//   而不必把逻辑复制进测试（复制一份等于没有验收）。第四阶段的历史层用的是同一套分层做法。
//
// 三条不可让步的口径（用户 2026-09-19 决定，接口不提供可改参数）：
// 1) 保留天数 = 180 天，写死在本文件的 RETENTION_DAYS。API 不接受 days 参数：
//    「保留多少天」是数据策略决定，归用户；若允许随手传参，就等于任何一次调用都能自行改写这个决定。
// 2) 清理语义 = 先导出 JSON 快照、再物理删除（导出见 lifecycle.ts，判定与文件结构在这里）。
// 3) 触发方式 = dry-run 预览 + 人工确认后手动执行；不挂调度器，不做任何「到点自动删」的承诺。
//
// 额外的防误删护栏（都锁了单测）：
// - 按「整天」为单位清理：一天要么完整留在库里，要么完整进导出文件，绝不出现半天的归档。
// - 当日（asOf = today）永不进候选：当日行由全量/增量口径自己负责，不由清理负责。
// - 判不出年龄的行（asOf 不是合法 YYYY-MM-DD、或晚于今天）一律列入受保护并说明原因 —— 宁可少删。
// - task_run / scan_cursor 不在清理范围内（用户授权的范围是「Radar/Events 明细行」），
//   预览里如实报告它们有多少条已超过 180 天、以及为什么不动它们。
import { DATE_RE, type StateFilter } from "./history-core.ts";

export const RETENTION_DAYS = 180;
export const RETENTION_DECISION = "保留天数 180 天由用户于 2026-09-19 决定；本阶段不提供可改参数，改天数只能改这个常量并留下 worklog 记录";

/** 执行清理必须逐字带上这个串：把「点了一下按钮」和「确认要删真实数据」区分开 */
export const PURGE_CONFIRM_TEXT = "PURGE_EXPIRED_ROWS";

export type DetailTable = "radar_finding" | "global_event";
export const DETAIL_TABLES: DetailTable[] = ["radar_finding", "global_event"];

export const TABLE_TEXT: Record<DetailTable, string> = {
  radar_finding: "雷达信号明细（radar_finding）",
  global_event: "全球事件明细（global_event）",
};

/** 只报告、不清理的运行记录表 */
export type RunTable = "task_run" | "scan_cursor";
export const RUN_TABLE_TEXT: Record<RunTable, string> = {
  task_run: "扫描运行记录（task_run）",
  scan_cursor: "增量扫描游标（scan_cursor）",
};

export interface DayBucket {
  table: DetailTable;
  date: string;
  rows: number;
  live: number;
  superseded: number;
}

export interface CandidateDay extends DayBucket {
  age_days: number;
}

export interface ProtectedDay {
  table: DetailTable;
  date: string;
  rows: number;
  live: number;
  superseded: number;
  reason: string;
}

export interface LifecyclePlan {
  today: string;
  retention_days: number;
  /** asOf < cutoff ⇒ 过期；cutoff = today − RETENTION_DAYS */
  cutoff: string;
  basis: string;
  candidates: CandidateDay[];
  protected_days: ProtectedDay[];
  totals: { candidate_days: number; candidate_rows: number; protected_days: number; protected_rows: number };
  plan_hash: string;
}

const DAY_MS = 86_400_000;

/** YYYY-MM-DD ± 天数：走 UTC，避免本地时区/夏令时把边界算歪一天 */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** 某 asOf 距今天多少天；判不出年龄返回 null */
export function ageDays(date: string, today: string): number | null {
  if (!isValidDate(date) || !isValidDate(today)) return null;
  const [y1, m1, d1] = date.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

export function cutoffOf(today: string, retentionDays = RETENTION_DAYS): string {
  return addDays(today, -retentionDays);
}

export function planBasis(today: string, cutoff: string, retentionDays: number): string {
  return `清理候选 = ${DETAIL_TABLES.map((t) => TABLE_TEXT[t]).join(" 与 ")} 里 asOf 严格早于 ${cutoff} 的行` +
    `（今天 ${today} 往前推 ${retentionDays} 天；asOf = ${cutoff} 当天还没满 ${retentionDays} 天，不动）` +
    `；按整天处理，不拆某天的部分行；当日（asOf=${today}）与判不出年龄的行一律不列入候选。` +
    `执行方式是人工在预览确认后手动触发：本阶段不挂调度器，没有「到点自动删除」这回事。`;
}

/**
 * 一致性校验指纹：FNV-1a 32 位，十六进制。
 * 用途不是防篡改（不是密码学哈希），而是防「预览的是 A、点确认时库里已经变成 B」——
 * 扫描按全量口径重刷当日、或历史日又被补跑，都会让指纹变化，从而让旧的确认失效。
 */
export function planHash(cutoff: string, retentionDays: number, candidates: CandidateDay[]): string {
  const parts = candidates.map((c) => `${c.table}|${c.date}|${c.rows}|${c.live}|${c.superseded}|${c.age_days}`);
  const s = [`cutoff=${cutoff}`, `days=${retentionDays}`, ...parts].join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, "0")}${parts.length.toString(16).padStart(4, "0")}`;
}

/** 由「按表按日计数」构建清理计划；纯函数，不读库 */
export function buildPlan(today: string, buckets: DayBucket[], retentionDays = RETENTION_DAYS): LifecyclePlan {
  const cutoff = cutoffOf(today, retentionDays);
  const candidates: CandidateDay[] = [];
  const protectedDays: ProtectedDay[] = [];
  for (const b of buckets) {
    if (!b.rows) continue; // 0 行的日期不进清单（历史层已保证不会出现空 bucket）
    const age = ageDays(b.date, today);
    if (age === null) {
      protectedDays.push({ ...b, reason: `asOf「${b.date}」不是合法日历日：判不出年龄就不删（宁可少删）` });
      continue;
    }
    if (age < 0) {
      protectedDays.push({ ...b, reason: `asOf=${b.date} 晚于今天 ${today}：异常日期，不列入清理候选` });
      continue;
    }
    if (age === 0) {
      protectedDays.push({ ...b, reason: `当日归档（asOf=${today}）：由扫描口径负责（全量重刷/增量更新），清理不碰当天` });
      continue;
    }
    if (b.date >= cutoff) {
      protectedDays.push({ ...b, reason: `距今 ${age} 天，未满保留期 ${retentionDays} 天（满期日 ${cutoff} 之后才进候选）` });
      continue;
    }
    candidates.push({ ...b, age_days: age });
  }
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.table < b.table ? -1 : 1));
  protectedDays.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.table < b.table ? -1 : 1));
  const candidateRows = candidates.reduce((s, c) => s + c.rows, 0);
  const protectedRows = protectedDays.reduce((s, c) => s + c.rows, 0);
  return {
    today,
    retention_days: retentionDays,
    cutoff,
    basis: planBasis(today, cutoff, retentionDays),
    candidates,
    protected_days: protectedDays,
    totals: {
      candidate_days: candidates.length,
      candidate_rows: candidateRows,
      protected_days: protectedDays.length,
      protected_rows: protectedRows,
    },
    plan_hash: planHash(cutoff, retentionDays, candidates),
  };
}

/** 没有候选时的如实说明：区分「库里根本没行」和「有行但都还没过期」 */
export function noCandidateNote(plan: LifecyclePlan, totalRows: number): string {
  if (!totalRows) {
    return `库里明细行一共 0 条：没有任何可清理的内容（扫描跑过但当日落库 0 条、或全部行都还在当日口径里，都会是这种状态）。清理不会凭空制造删除。`;
  }
  return `库里共 ${totalRows} 条明细行，但没有一条 asOf 早于 ${plan.cutoff}（今天 ${plan.today} 往前 ${plan.retention_days} 天）：` +
    `本轮可清理 0 行。这是真实数据还没有那么旧，不是清理机制没生效 —— 未执行任何删除。`;
}

export interface PurgeGateOk { ok: true; plan: LifecyclePlan }
export interface PurgeGateErr { ok: false; status: number; error: string }

/**
 * 执行清理前的闸门（route 用它，别在 route 里重复判定）：
 * 顺序刻意是「确认串 → 有无候选 → 指纹是否仍匹配」：前两步的失败根本没碰库，最后一步失败也还没碰库。
 */
export function purgeGate(
  body: { confirm?: unknown; plan_hash?: unknown } | null,
  currentPlan: LifecyclePlan,
  totalDetailRows: number,
): PurgeGateOk | PurgeGateErr {
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";
  if (confirm !== PURGE_CONFIRM_TEXT) {
    return {
      ok: false, status: 400,
      error: `缺少正确确认串：执行清理必须显式带 confirm="${PURGE_CONFIRM_TEXT}"（当前收到「${confirm || "空"}」）。未删除任何行。`,
    };
  }
  if (!currentPlan.candidates.length) {
    return { ok: false, status: 400, error: noCandidateNote(currentPlan, totalDetailRows) };
  }
  const hash = typeof body?.plan_hash === "string" ? body.plan_hash.trim() : "";
  if (!hash) {
    return {
      ok: false, status: 400,
      error: `缺少 plan_hash：必须先调 GET /api/lifecycle/preview 拿到清理计划，再把它返回的 plan_hash 原样带回。` +
        `本接口不接受「没看过预览就直接删」的调用。未删除任何行。`,
    };
  }
  if (hash !== currentPlan.plan_hash) {
    return {
      ok: false, status: 409,
      error: `预览与当前库内容已不一致（预览时指纹 ${hash}，当前 ${currentPlan.plan_hash}）：` +
        `可能是这期间扫描重刷了归档、或有别的清理跑过。为防删错，本次未删除任何行 —— 请重新预览后再确认。`,
    };
  }
  return { ok: true, plan: currentPlan };
}

/** 导出文件的结构：删除前把真实行完整落到磁盘，字段与库列一一对应，可按列名回插 */
export interface ExportRow {
  table: DetailTable;
  id: string;
  asOf: string;
  [k: string]: unknown;
}

export interface ExportEnvelope {
  kind: "mydesk-lifecycle-expired-export";
  exported_at: string;
  today: string;
  retention_days: number;
  cutoff: string;
  plan_hash: string;
  basis: string;
  /** 这些行的来源与恢复口径：不写「可一键回滚」这种做不到的承诺 */
  restore_note: string;
  tables: { table: DetailTable; date: string; rows: number; live: number; superseded: number }[];
  row_count: number;
  rows: ExportRow[];
}

export function exportFileName(stamp: string): string {
  // stamp = shanghaiStamp() 的 'YYYY-MM-DD HH:mm:ss' → 文件名安全化
  const safe = stamp.replace(/[ :]/g, "-").replace(/[^0-9A-Za-z._-]/g, "");
  return `expired-${safe}.json`;
}

export function buildExportEnvelope(plan: LifecyclePlan, exportedAt: string, rows: ExportRow[]): ExportEnvelope {
  return {
    kind: "mydesk-lifecycle-expired-export",
    exported_at: exportedAt,
    today: plan.today,
    retention_days: plan.retention_days,
    cutoff: plan.cutoff,
    plan_hash: plan.plan_hash,
    basis: plan.basis,
    restore_note:
      `本文件是清理执行前从正式库导出的原始行（列名与 prisma schema 一一对应，含 id 与 createdAt）。` +
      `要恢复只能按列名把这些字段重新写回对应表 —— 项目没有提供一键回滚：如实说明，不做承诺。`,
    tables: plan.candidates.map((c) => ({ table: c.table, date: c.date, rows: c.rows, live: c.live, superseded: c.superseded })),
    row_count: rows.length,
    rows,
  };
}

/**
 * 导出的行数必须等于计划行数，否则一个字节都不能删。
 * 差值来源只会是「预览之后库又变了」：按日取数与计划计数之间不是同一时刻。
 */
export function exportCountCheck(plan: LifecyclePlan, exportedRows: number): { ok: true } | { ok: false; error: string } {
  if (exportedRows !== plan.totals.candidate_rows) {
    return {
      ok: false,
      error: `导出行数 ${exportedRows} 与清理计划的候选行数 ${plan.totals.candidate_rows} 不相等：` +
        `说明预览之后库里内容又变了。宁可不删，本次未删除任何行。`,
    };
  }
  return { ok: true };
}

/** 运行记录表只报告、不清理：口径写在这里，前端不自己推断 */
export function runTablesNote(expired: { table: RunTable; rows: number }[]): string {
  const detail = expired.length
    ? expired.map((e) => `${RUN_TABLE_TEXT[e.table]} ${e.rows} 条`).join("、")
    : `两张表当前都没有 asOf/tradeDate 早于清理阈值的记录`;
  return `${RUN_TABLE_TEXT.task_run} 与 ${RUN_TABLE_TEXT.scan_cursor} 不在本阶段清理范围内（用户授权范围是 Radar/Events 明细行的保留天数）。` +
    `现状：${detail}。` +
    `为什么留着：task_run 是「哪天扫过、扫出几条」的唯一留痕，第四阶段的运行记录区块靠它回答；` +
    `游标删掉不会丢数据（P3 口径：库内 live 行的键才是权威），但会丢掉「上次扫到哪」的可解释性。`;
}

/** 供预览/执行响应共用的口径清单：把「谁决定、怎么删、谁来触发」三条写全，避免页面上出现第二种说法 */
export function policyNotes(plan: LifecyclePlan): string[] {
  const notes: string[] = [
    RETENTION_DECISION,
    `清理语义：先把候选行完整导出为 data/lifecycle/ 下的 JSON 文件，写盘成功后才允许删除；导出失败或行数对不上 ⇒ 一行都不删。`,
    `superseded（已标记消失）的当日历史行与 live 行按同一条 asOf 规则处理：它们同样是真实归档，过期前不删、过期时先导出。`,
    `只删明细行：task_run（运行记录）与 scan_cursor（游标）不在本阶段清理范围内，预览里只报告条数、不动它们。`,
  ];
  return notes;
}

/** 状态维度的一句话说明：清理不看 state，看 asOf —— 免得页面把「过期」误写成「消失」 */
export function stateAgnosticNote(_filter: StateFilter = "all"): string {
  return `清理判定只看 asOf（这批行是哪一天写进库的），不看 state：live 与 superseded 都按同一保留天数处理，` +
    `不存在「消失的信号就先删」这种口径。`;
}
