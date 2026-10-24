// P2-自动化 收盘后自动扫描调度器（服务端进程内定时器实现，未引入任何新依赖）
//
// 能力边界（必须如实）：任务随 Next 服务进程运行 —— 网页关掉仍然会跑，但**服务进程没启动就不会跑**。
// 因此每次执行都写 task_run 记录（成功/失败/跳过都记），用于回答「有没有运行、什么时候运行、为什么失败」。
//
// 触发：交易日 15:00 + 等待 20 分钟（可配）后进入执行窗口，每 60 秒 tick 一次。
// 幂等：同一 (kind, tradeDate) 已有 success 不再跑；failure 最多重试 maxAttempts 次；
//       执行前先插一条 running 行，两个调用方（tick 与手动接口）撞车时后者会看到新鲜 running 而跳过。
// 恢复：进程重启后 tick 会重新判定当日窗口，未成功就继续跑；崩溃遗留的 running 超过 30 分钟视为陈旧，不再阻塞。
// 交易日：只认上证指数真实日线的最后一根日期；判不出来时记 skipped 而不是猜一个。
// P3 增量：调度规则与幂等拦截一行没改；执行时把「全量还是增量」交给落库层判定 ——
//          当日已有成功游标（例如上午手动扫过一次）→ 收盘后那次自动扫描只写新增与内容变化的行；
//          扫描失败不推进游标，下一次仍从上次成功位置重新处理同一批数据。task_run 里如实记录用了哪种口径。
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { modeBasisLabel } from "@/lib/quant/screener/incremental-core";
import { cursorSummary, type ScanKind } from "@/lib/quant/screener/incremental";
import { archiveRadarScan, archiveEventScan, type ArchiveResult, type DeltaStats, type EventRow, type RadarRow, type ScanMode } from "@/lib/quant/screener/persist";
// R21b sectorsnap：见顶引擎/回测读的是 data/sector-daily-snapshots.json（JSON 归档），而自动沉淀此前只写 custom.db，
// 双数据源不一致 → 见顶扫描器/回测吃的是手动刷的那份。这里把它接进收盘后窗口，用子进程跑现成脚本（脚本自带 09:30 开盘守卫）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { archiveBreadthScan } from "@/lib/quant/screener/breadth-collect";
import { archiveReviewScan } from "@/lib/quant/screener/review-daily-collect";
// P0 类型B预测数据底座：每日收盘后沉淀一行 daily_snapshot（宽度/风险/次日涨跌），次日回填次日涨跌。
import { archiveDailySnapshot } from "@/lib/quant/screener/daily-snapshot-collect";
// R20：收盘后涨停名单沉淀（晋级率/梯队断层/昨日涨停表现这三组读数的唯一来源）
import { archiveLimitUpRoster } from "@/lib/quant/screener/limit-up-collect";
// P36-C：收盘后把「推荐过的具体票」按 T+1/T+2 真实行情回填，攒战绩证据链（不许手工补）
import { fillPicks } from "@/lib/quant/strategy/pick-fill-collect";
import { syncPickSymbols } from "@/lib/quant/strategy/pick-symbol-collect";
// P39 / #75：收盘后若已配置服务端模型通道，自动从当日 layer1 候选里收窄出 AI优选战绩层，
// 解决「用户不手动用 AI优选就不会触发」——没配通道 / 没候选时如实记空，不造假。
// aipick 生成逻辑仅服务端执行，动态 import 避免把 undici 拉进浏览器包（见 ai-pick-generate.ts 顶部 server-only）
import { ingestDailyBars } from "@/lib/quant/data/daily-bar-collect";
import { shanghaiDate } from "@/lib/desk/session";
import {
  DEFAULT_SCHEDULER_CONFIG, SKIP_REASON_TEXT, decideRun, isBigEventDue, isDueWindow, isWeeklyDue, judgeTradingDay, nextSlot, slotAtForDate,
  type SchedulerConfig, type TaskKind,
} from "./rules";

export { SKIP_REASON_TEXT, type TaskKind } from "./rules";

const TICK_MS = 60_000;
const INDEX_SYMBOL = "000001.SH"; // 交易日判据：上证指数日线（与选股器交易日历同源）
const KINDS: TaskKind[] = ["radar", "events", "breadth", "review", "roster", "sectorsnap", "dailysnap", "dailybars", "picksym", "pickfill", "aipick"];
/**
 * 没有「增量游标」概念的任务：幂等落在写库层的唯一键上，不是游标上。
 * R20 加 roster 时一并把这段从三元表达式里抽出来——三个 kind 挤一条三元已经读不动了。
 */
const NO_CURSOR_KINDS = new Set<TaskKind>(["breadth", "review", "roster", "sectorsnap", "dailysnap", "dailybars", "picksym", "pickfill", "aipick", "weekly", "bigevent"]);
/** 有游标的那两类：写成守卫而不是在调用点 cast —— 以后再加 kind 会在类型层提醒我们分流没更新 */
const isCursorKind = (k: TaskKind): k is ScanKind => k === "radar" || k === "events";
const NO_CURSOR_BASIS: Partial<Record<TaskKind, string>> = {
  review: "复盘统计不设增量游标：口径是「按交易日唯一键 upsert，同日重跑以最后一次为准」",
  breadth: "宽度管线不设增量游标：口径是「当日已有收盘价行不重写（收盘价不可变），重跑只补新票」",
  roster: "涨停名单不设增量游标：口径是「按（票 × 交易日）唯一键 upsert，同日重跑以最后一次为准」",
  sectorsnap: "行业快照不设增量游标：口径是「按交易日 upsert（盘中多次抓刷新同日），见顶引擎/回测读这份 JSON」",
  dailysnap: "每日留档不设增量游标：口径是「按交易日唯一键 upsert，同日重跑以最后一次为准」",
  weekly: "周报不设增量游标：口径是「按（weekly, 本周日）唯一 success 幂等，同周重跑跳过」",
  bigevent: "大事件不设增量游标：去重在提醒级别（dedupeKey：同日同类同主体只发一次），任务本身可重复跑",
};
const UNCONFIRMED_PROBE_MS = 15 * 60_000; // 确证不了交易日时，最多每 15 分钟再问一次数据源

export interface TaskOutcome {
  kind: TaskKind; tradeDate: string; status: "success" | "failure" | "skipped";
  reason?: string; results?: number; error?: string;
  /** P3：本次实际采用的口径（auto 解析后的结果）；未执行扫描时省略 */
  mode?: ScanMode;
  /** P3：本次写入库的明细（新增/更新/未变/标记消失），供接口与 task_run 如实回报 */
  delta?: DeltaStats;
}

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  enabled: boolean;
  cfg: SchedulerConfig;
  startedAt: number;
  lastTickAt: number;
  lastOutcome: string;
  /** key = `${kind}:${tradeDate}`，值 = 上次因「交易日无法确证」而探测数据源的时刻 */
  lastProbe: Map<string, number>;
  /** 上次大事件检查时刻（ms）：交易时段内每 15 分钟查一次，不是每 tick 都查 */
  lastBigEventCheckAt: number;
}

// 单例挂在 globalThis：dev 热重载与多次 import 都复用同一份，避免重复注册定时器
const G = globalThis as typeof globalThis & { __mydeskScheduler?: SchedulerState };
function state(): SchedulerState {
  if (!G.__mydeskScheduler) {
    G.__mydeskScheduler = {
      timer: null,
      enabled: process.env.DESK_SCHEDULER !== "0",
      cfg: {
        ...DEFAULT_SCHEDULER_CONFIG,
        delayMinutes: Number(process.env.DESK_SCHEDULER_DELAY_MIN ?? DEFAULT_SCHEDULER_CONFIG.delayMinutes),
        maxAttempts: Number(process.env.DESK_SCHEDULER_MAX_ATTEMPTS ?? DEFAULT_SCHEDULER_CONFIG.maxAttempts),
      },
      startedAt: Date.now(),
      lastTickAt: 0,
      lastOutcome: "",
      lastProbe: new Map(),
      lastBigEventCheckAt: 0,
    };
  }
  return G.__mydeskScheduler;
}

/** 上证指数日线的最新交易日；取不到返回 null（不猜测） */
async function latestIndexBarDate(untilDate: string): Promise<string | null> {
  try {
    const map = await fetchBarsHybrid([INDEX_SYMBOL], untilDate, 12);
    const bars = map.get(INDEX_SYMBOL) ?? [];
    return bars.length ? String(bars[bars.length - 1].date) : null;
  } catch {
    return null;
  }
}

async function rowsOf(kind: TaskKind, tradeDate: string) {
  return db.taskRun.findMany({
    where: { kind, tradeDate },
    select: { status: true, startedAt: true, finishedAt: true, error: true },
  });
}

/** 当日窗口（收盘+等待）的 UTC 时刻；周末等无排班日返回 0（不限制成功时刻） */
/**
 * sectorsnap：跑 scripts/quant/build-sector-snapshot.mjs 刷新行业快照归档。
 * 为什么走子进程而不是把逻辑搬进来：脚本已经跑通（4281 只 / 89 行业）且自带交易日守卫，
 * 搬进来等于把同一套抓取逻辑在两处各养一份，口径迟早分叉。子进程失败会如实抛出，进 task_run 的 failure。
 * 落档口径：按交易日 upsert（盘中多次抓刷新同日），所以 delta 只有 1 行 —— 新交易日算 inserted，刷新同日算 updated。
 */
function archiveSectorSnapshot(): Promise<ArchiveResult<never>> {
  const scriptPath = path.resolve(process.cwd(), "scripts", "quant", "build-sector-snapshot.mjs");
  const archivePath = path.resolve(process.cwd(), "data", "sector-daily-snapshots.json");
  const bj = new Date(Date.now() + 8 * 3600_000);
  const tradeDate = bj.toISOString().slice(0, 10);
  const existedBefore = (() => {
    try {
      return Boolean(JSON.parse(fs.readFileSync(archivePath, "utf8")).days?.[tradeDate]);
    } catch {
      return false;
    }
  })();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { cwd: process.cwd(), env: { ...process.env, NO_PROXY: "*", no_proxy: "*" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    // 全量抓 4281 只约 1–2 分钟；给 5 分钟上限，超时按 failure 记录而不是让它挂着占住任务槽
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("sectorsnap 超时（>5 分钟）")); }, 5 * 60_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // 脚本的开盘守卫用 exit 2 表达「拒绝落档」，这不是故障，如实说清原因
        reject(new Error(`sectorsnap 退出码 ${code}：${(err || out).trim().slice(-200)}`));
        return;
      }
      const cov = /覆盖\s+(\d+)\s+只/.exec(out);
      const ind = /\/\s*(\d+)\s*行业/.exec(out);
      const scanned = cov ? Number(cov[1]) : 0;
      const results = ind ? Number(ind[1]) : 0;
      resolve({
        as_of: new Date().toISOString(),
        trade_date: tradeDate,
        missing: [],
        scanned,
        results,
        items: [] as never[],
        unmatched: null,
        source: "qt.gtimg.cn 实时快照(changePct 字段32) · 子进程 build-sector-snapshot.mjs",
        mode: "full" as const,
        delta: {
          scanned,
          inserted: existedBefore ? 0 : 1,
          updated: existedBefore ? 1 : 0,
          unchanged: 0,
          skippedByCursor: 0,
          superseded: 0,
          kept: 0,
          collapsed: 0,
        },
      });
    });
  });
}

function slotMsFor(date: string, cfg: SchedulerConfig): number {
  return slotAtForDate(date, cfg)?.getTime() ?? 0;
}

/** 每日每 kind 只留一条 skipped 记录，避免 tick 反复写库制造噪音数据 */
async function recordSkippedOnce(kind: TaskKind, tradeDate: string, trigger: string, reason: string, basis: string): Promise<TaskOutcome> {
  const existing = await db.taskRun.findFirst({ where: { kind, tradeDate, status: "skipped" }, select: { id: true, error: true } });
  if (!existing) {
    await db.taskRun.create({
      data: {
        kind, tradeDate, status: "skipped", trigger, error: reason,
        startedAt: new Date(), finishedAt: new Date(),
        missing: JSON.stringify([basis]), basis, note: "未执行扫描，未产生任何数据",
      },
    });
  } else if (reason === "non_trading_day" && existing.error !== "non_trading_day") {
    // 早先「数据源没返回、确证不了」→ 后来确证为休市：升级同一条记录，后续 tick 不再重复探测
    await db.taskRun.update({ where: { id: existing.id }, data: { error: reason, basis, missing: JSON.stringify([basis]) } });
  }
  return { kind, tradeDate, status: "skipped", reason: basis };
}

/**
 * 执行一次任务（调度器与手动接口共用），同时返回落库结果供 API 回给前端。
 * force=true 时忽略「当日已成功 / 已达重试上限 / 已确证休市」的幂等拦截（人工点「立即扫描」、补跑与失败重试），
 * 但仍受 running 互斥保护，且拦截被绕过时会在 note 里写明是强制执行。
 *
 * mode（P3）：交给落库层决定/记录，本函数只负责如实写进 task_run。
 * - 缺省 "auto"：当日已有成功游标 → 增量（只写新增与变化的行），否则全量；
 * - "full"：当日先删后插重刷（手动点「立即扫描」即此口径，用户要求真跑一遍）；
 * - "incremental"：显式要求增量补跑（即使同时 force=true 也不退回全量）。
 * 幂等拦截规则（第二阶段定稿）没有因为增量而改变：这里不碰 decideRun。
 */
export async function runTaskTracked(
  kind: TaskKind,
  trigger: "schedule" | "manual",
  opts?: { force?: boolean; tradeDate?: string; mode?: "auto" | "full" | "incremental" },
): Promise<{ outcome: TaskOutcome; result: ArchiveResult<RadarRow | EventRow> | null }> {
  const s = state();
  quantBootstrap(); // 数据源 Provider 注册（幂等）：交易日判据与扫描都要用
  const tradeDate = opts?.tradeDate ?? shanghaiDate();
  const prior = await rowsOf(kind, tradeDate);
  // 自动任务只认「收盘窗口之后完成」的成功；手动扫描的触发方自己决定要不要强制
  const successSince = trigger === "schedule" ? slotMsFor(tradeDate, s.cfg) : 0;
  const decision = decideRun(
    prior.map((r) => ({ status: r.status, startedAt: r.startedAt.getTime(), finishedAt: r.finishedAt?.getTime() ?? null, reason: r.error })),
    s.cfg, Date.now(), successSince,
  );
  if (decision.action === "skip" && !(opts?.force && decision.reason !== "running")) {
    s.lastOutcome = `${kind} skip:${decision.reason} @${tradeDate}`;
    return { outcome: { kind, tradeDate, status: "skipped", reason: decision.reason }, result: null };
  }

  // 交易日确证：非交易日 / 无法确证 → 不打数据源，如实记 skipped
  const unconfirmed = prior.find((r) => r.status === "skipped" && r.error === "trading_day_unconfirmed");
  if (unconfirmed && !opts?.force) {
    const last = s.lastProbe.get(`${kind}:${tradeDate}`) ?? 0;
    if (Date.now() - last < UNCONFIRMED_PROBE_MS) {
      return { outcome: { kind, tradeDate, status: "skipped", reason: "trading_day_unconfirmed（15 分钟内已探测过数据源）" }, result: null };
    }
  }
  s.lastProbe.set(`${kind}:${tradeDate}`, Date.now());
  const barDate = await latestIndexBarDate(tradeDate);
  const verdict = judgeTradingDay(tradeDate, barDate);
  if (verdict.isTradingDay !== true) {
    if (!opts?.force) {
      const reason = verdict.isTradingDay === false ? "non_trading_day" : "trading_day_unconfirmed";
      return { outcome: await recordSkippedOnce(kind, tradeDate, trigger, reason, verdict.basis), result: null };
    }
    // 人工明确要求执行时仍执行，但把「非交易日/未确证」写进记录，不冒充正常收盘后扫描
    s.lastOutcome = `${kind} forced on uncertain day`;
  }

  const row = await db.taskRun.create({
    data: { kind, tradeDate, status: "running", trigger, startedAt: new Date(), basis: verdict.basis },
  });
  // 尝试序号：正常路径由幂等判定给出；强制补跑时按「当日已有失败数 + 1」计，避免写出「第 ? 次」这种读不懂的记录
  const attempt = decision.action === "run"
    ? decision.attempt
    : prior.filter((r) => r.status === "failure").length + 1;
  const label = trigger === "schedule" ? "收盘后自动" : "手动触发";
  const note = opts?.force
    ? `${label}（强制补跑，忽略当日已有结果，不计入自动重试次数）`
    : `${label}：第 ${attempt} 次尝试`;
  // P3：扫描口径交给落库层判定（当日已有成功游标才走增量），这里只负责把结果如实写进 task_run
  const archiveOpts = { force: opts?.force, mode: opts?.mode ?? "auto" as const };
  try {
    // breadth/roster 的 mode/force 不参与落库口径：写库层本就是「唯一键 + upsert」，没有全量重刷这回事
    const out = kind === "radar" ? await archiveRadarScan(archiveOpts)
      : kind === "events" ? await archiveEventScan(archiveOpts)
      : kind === "review" ? await archiveReviewScan()
      : kind === "breadth" ? await archiveBreadthScan()
      : kind === "sectorsnap" ? await archiveSectorSnapshot()
      : kind === "dailysnap" ? await archiveDailySnapshot()
      : kind === "dailybars" ? await archiveDailyBarsIngest()
      : kind === "picksym" ? await syncPickSymbols()
      : kind === "pickfill" ? await fillPicks()
      // 注意：必须 await 到函数结果本身。只 await import() 会拿到 Promise，
      // 下一行 out.delta 就会炸 "Cannot read properties of undefined (reading 'inserted')"
      : kind === "aipick" ? await (await import("@/lib/quant/strategy/ai-pick-generate")).generateAiPickForDate(tradeDate)
      : await archiveLimitUpRoster();
    const writeLine = `写入：新增 ${out.delta.inserted}、更新 ${out.delta.updated}、未变 ${out.delta.unchanged}`
      + (out.delta.skippedByCursor ? `、游标跳过 ${out.delta.skippedByCursor}` : "")
      + (kind === "radar" ? `、标记消失 ${out.delta.superseded}` : kind === "events" ? `、保留 ${out.delta.kept}`
        : kind === "review" ? "（复盘统计按交易日唯一键 upsert：同日重跑以最后一次为准）"
        : kind === "roster" ? "（涨停名单按 票×交易日 唯一键 upsert：同日重跑以最后一次为准）"
        : kind === "sectorsnap" ? "（行业快照按交易日 upsert：盘中多次抓刷新同日，见顶引擎/回测读这份 JSON）"
        : "（收盘价不可变：同日重跑只补新票）");
    await db.taskRun.update({
      where: { id: row.id },
      data: {
        status: "success", finishedAt: new Date(),
        scanned: out.scanned, results: out.results,
        missing: JSON.stringify(out.missing ?? []),
        basis: `${verdict.basis}；${modeBasisLabel(out.mode)}；来源 ${out.source}`,
        note: `${note}；${writeLine}`,
      },
    });
    s.lastOutcome = `${kind} success ${out.results} 条 @${tradeDate}（${out.mode === "full" ? "全量" : "增量"}）`;
    return { outcome: { kind, tradeDate, status: "success", results: out.results, mode: out.mode, delta: out.delta }, result: out };
  } catch (e) {
    const msg = (e as Error).message;
    await db.taskRun.update({
      where: { id: row.id },
      data: {
        status: "failure", finishedAt: new Date(), error: msg,
        missing: JSON.stringify([`执行失败：${msg}`, "失败不推进增量游标：下次运行仍从上次成功位置重新处理这批数据"]),
        basis: `${verdict.basis}；来源 未完成（扫描阶段异常）`,
        note: `${label}：第 ${attempt} 次尝试失败`,
      },
    });
    s.lastOutcome = `${kind} failure @${tradeDate}: ${msg}`;
    return { outcome: { kind, tradeDate, status: "failure", error: msg }, result: null };
  }
}

/** 调度器/tick 用的简洁入口：只关心结果状态 */
export async function runTask(
  kind: TaskKind,
  trigger: "schedule" | "manual",
  opts?: { force?: boolean; tradeDate?: string; mode?: "auto" | "full" | "incremental" },
): Promise<TaskOutcome> {
  const { outcome } = await runTaskTracked(kind, trigger, opts);
  return outcome;
}

/** 任务没跑出结果时给前端的可读原因（失败=异常信息；被幂等拦截=拦截理由） */
export function scanFailMessage(outcome: TaskOutcome): string {
  if (outcome.error) return outcome.error;
  const text = outcome.reason ? (SKIP_REASON_TEXT[outcome.reason as keyof typeof SKIP_REASON_TEXT] ?? outcome.reason) : "";
  return `扫描未执行${text ? `：${text}` : ""}`;
}

/** 一次 tick：进入窗口且当日未成功 → 顺序跑 radar、events（同一时刻只放行一个任务，避免打满数据源） */
/** dailybars 的结果形状跟其他落库任务不一样（它是"每只拉最近几根"而不是"当日快照"），
 *  这里适配成统一 ArchiveResult，好让 task_run 的写入 / 重试 / 状态展示复用同一条路径。
 *  失败直接抛：runTask 的 catch 会把它记成 failure，页面如实显示"今天没更新"。 */
async function archiveDailyBarsIngest(): Promise<ArchiveResult<never>> {
  const r = await ingestDailyBars();
  if (r.status === "failed") throw new Error(r.note ?? r.reason ?? "粮仓增量失败");
  const today = shanghaiDate();
  const delta: DeltaStats = {
    scanned: r.scanned, inserted: r.results, updated: 0, unchanged: 0,
    skippedByCursor: 0, superseded: 0, kept: 0, collapsed: 0,
  };
  return {
    as_of: today, trade_date: today, missing: [], scanned: r.scanned, results: r.results,
    items: [], unmatched: null, source: r.basis, mode: "incremental", delta,
  };
}

export async function tick(now = new Date()): Promise<string> {
  const s = state();
  s.lastTickAt = now.getTime();
  if (!s.enabled) { s.lastOutcome = "调度器已禁用（DESK_SCHEDULER=0）"; return s.lastOutcome; }
  const outcomes: string[] = [];
  // 1) 收盘后窗口：原有 KINDS（交易日 15:20 后顺序跑）
  const win = isDueWindow(now, s.cfg);
  if (win.due && win.slotAt) {
    for (const kind of KINDS) {
      const r = await runTask(kind, "schedule");
      outcomes.push(`${kind}:${r.status}${r.reason ? `(${r.reason})` : ""}${r.results !== undefined ? `×${r.results}` : ""}${r.mode ? `[${r.mode}]` : ""}`);
    }
  }
  // 2) 周报：周日 20:00 后（只在周日发；幂等在 runWeeklyReportTask 里：本周已有 success 即跳过）
  //    不走收盘后窗口（周日本来就不开盘），也不走交易日确证（总结的是过去一周）。
  const weekly = isWeeklyDue(now);
  if (weekly.due) {
    try {
      const { runWeeklyReportTask } = await import("@/lib/desk/weekly-report");
      const r = await runWeeklyReportTask({ sunday: weekly.sunday, trigger: "schedule" });
      outcomes.push(`weekly:${r.status}${r.reason ? `(${r.reason})` : ""}`);
    } catch (e) {
      outcomes.push(`weekly:failure(${(e as Error).message})`);
    }
  }
  // 3) 大事件：交易时段（工作日 9:30–15:30）内每 15 分钟检查一次，命中即提醒，不等日报；
  //    去重在提醒级别（dedupeKey），重复检查不重复发。先记检查时刻，避免一次检查跑超时导致连续 tick 重复查。
  if (isBigEventDue(now, s.lastBigEventCheckAt)) {
    s.lastBigEventCheckAt = now.getTime();
    try {
      const { runBigEventCheck } = await import("@/lib/desk/weekly-report");
      const r = await runBigEventCheck({ trigger: "schedule" });
      outcomes.push(r.newAlerts.length ? `bigevent:success 新增${r.newAlerts.length}条提醒` : "bigevent:checked 无新增");
    } catch (e) {
      outcomes.push(`bigevent:failure(${(e as Error).message})`);
    }
  }
  s.lastOutcome = outcomes.length
    ? outcomes.join(" / ")
    : `未到执行窗口（${win.tradeDate}${win.slotAt ? `，窗口 ${win.slotAt.toISOString()}` : "，当日不排班"}；周报仅周日 20:00；大事件仅工作日 9:30–15:30 每 15 分钟）`;
  return s.lastOutcome;
}

export function startScheduler(): void {
  const s = state();
  if (!s.enabled) {
    console.log("[scheduler] 已禁用：DESK_SCHEDULER=0");
    return;
  }
  if (s.timer) return; // 幂等：重复注册（HMR / 多次 import）不再加定时器
  quantBootstrap();
  // 三份日报定时（早报 08:30 / 午报 12:00 / 晚报 16:00，仅交易日）：独立 tick，与收盘后扫描共用进程
  void import("./daily-reports").then((m) => m.startDailyReportScheduler()).catch((e) => {
    console.error("[scheduler] 三份日报调度器启动失败:", (e as Error).message);
  });
  s.timer = setInterval(() => {
    void tick().catch((e) => {
      s.lastOutcome = `tick 异常：${(e as Error).message}`;
      console.error("[scheduler] tick failed:", (e as Error).message);
    });
  }, TICK_MS);
  // 不阻止进程退出（测试/脚本 import 时不会挂住）
  s.timer.unref?.();
  // 启动后先跑一次：进程若在窗口之后重启（部署/崩溃拉起），不必等满 60s 才补上当日任务
  setTimeout(() => {
    void tick().catch((e) => console.error("[scheduler] startup tick failed:", (e as Error).message));
  }, 5_000).unref?.();
  const next = nextSlot(new Date(), s.cfg);
  const atMinute = s.cfg.closeMinute + s.cfg.delayMinutes;
  const hhmm = `${String(Math.floor(atMinute / 60) % 24).padStart(2, "0")}:${String(atMinute % 60).padStart(2, "0")}`;
  console.log(`[scheduler] 已启动：每 ${TICK_MS / 1000}s 检查；执行窗口=交易日北京 ${hhmm}；下次 ${next.date} ${hhmm}（${next.at.toISOString()}）；任务 ${KINDS.join("、")}；周报=周日 20:00（weekly）；大事件=工作日 9:30–15:30 每 15 分钟（bigevent）；禁用用 DESK_SCHEDULER=0`);
}

export function stopScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/** /api/tasks/status 用：调度器状态 + 当日与最近记录 */
export async function schedulerStatus() {
  const s = state();
  const now = new Date();
  const today = shanghaiDate(now);
  const next = nextSlot(now, s.cfg);
  const win = isDueWindow(now, s.cfg);
  const recent = await db.taskRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  const todays = await db.taskRun.findMany({ where: { tradeDate: today }, orderBy: { startedAt: "desc" } });
  const shape = (r: typeof recent[number]) => ({
    id: r.id, kind: r.kind, trade_date: r.tradeDate, status: r.status, trigger: r.trigger,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
    duration_ms: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    scanned: r.scanned, results: r.results,
    missing: JSON.parse(r.missing || "[]") as string[],
    error: r.error, basis: r.basis, note: r.note,
  });
  const slotMs = slotMsFor(today, s.cfg);
  // today_summary：收盘后 KINDS + 周报 weekly + 大事件 bigevent（后两者不走收盘窗口，单独列出才看得到状态）
  const todaySummary = await Promise.all(([...KINDS, "weekly", "bigevent"] as TaskKind[]).map(async (kind) => {
    const rows = todays.filter((r) => r.kind === kind);
    // settled 必须与调度器的幂等口径同一条规则：只看窗口之后完成的成功行，否则页面会说谎。
    // 它只回答「调度器今天还会不会再跑」，不回答「是谁跑的」——后者看 last_trigger。
    const settled = rows.some((r) => r.status === "success" && (r.finishedAt?.getTime() ?? 0) >= slotMs);
    const last = rows[0] ?? null;
    return {
      kind,
      settled,
      attempts: rows.filter((r) => r.status === "failure").length,
      last_status: last ? last.status : "",
      last_trigger: last ? last.trigger : "",
      last_finished_at: last?.finishedAt ? last.finishedAt.toISOString() : null,
      last_error: last?.error ?? "",
      // P3：当日增量游标（没有游标 = 今天还没成功跑过，下一次会走全量口径）
      // breadth 没有游标概念：它的幂等在写库层——(symbol, tradeDate) 唯一键、已有行不重写。
      // review 同理：按 tradeDate 唯一键 upsert，同日重跑以最后一次为准（统计口径会随数据源落定微调）。
      // roster（R20 涨停名单）同理：按 (symbol, tradeDate) 唯一键 upsert，同日重跑以最后一次为准。
      cursor: NO_CURSOR_KINDS.has(kind)
        ? { kind, trade_date: today, exists: false, watermark: "", done_keys: 0, unmatched_keys: 0, scanned: 0, results: 0, basis: NO_CURSOR_BASIS[kind] ?? "", note: "", updated_at: null }
        : isCursorKind(kind) ? await cursorSummary(kind, today)
          : { kind, trade_date: today, exists: false, watermark: "", done_keys: 0, unmatched_keys: 0, scanned: 0, results: 0, basis: "未知任务类型：既不在无游标清单里，也不是雷达/事件，游标读不了", note: "", updated_at: null },
    };
  }));
  return {
    ok: true,
    as_of: now.toISOString(),
    enabled: s.enabled,
    running: s.timer !== null,
    tick_seconds: TICK_MS / 1000,
    config: s.cfg,
    today,
    due_now: win.due,
    slot_at: win.slotAt ? win.slotAt.toISOString() : null,
    next: { trade_date: next.date, at: next.at.toISOString() },
    last_outcome: s.lastOutcome,
    started_at: new Date(s.startedAt).toISOString(),
    last_tick_at: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null,
    today_summary: todaySummary,
    today_runs: todays.map(shape),
    recent_runs: recent.map(shape),
    // 三份日报（早报 08:30 / 午报 12:00 / 晚报 16:00，仅交易日）：当日各份是否已生成
    daily_reports: await (await import("./daily-reports")).dailyReportStatus(),
    boundary: "任务随服务端进程运行：网页可关闭，但服务未启动时不会执行；每条执行结果都落 task_run",
  };
}
