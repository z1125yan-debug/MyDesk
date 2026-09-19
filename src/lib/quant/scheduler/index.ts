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
import { cursorSummary } from "@/lib/quant/screener/incremental";
import { archiveRadarScan, archiveEventScan, type ArchiveResult, type DeltaStats, type EventRow, type RadarRow, type ScanMode } from "@/lib/quant/screener/persist";
import { shanghaiDate } from "@/lib/desk/session";
import {
  DEFAULT_SCHEDULER_CONFIG, SKIP_REASON_TEXT, decideRun, isDueWindow, judgeTradingDay, nextSlot, slotAtForDate,
  type SchedulerConfig, type TaskKind,
} from "./rules";

export { SKIP_REASON_TEXT, type TaskKind } from "./rules";

const TICK_MS = 60_000;
const INDEX_SYMBOL = "000001.SH"; // 交易日判据：上证指数日线（与选股器交易日历同源）
const KINDS: TaskKind[] = ["radar", "events"];
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
    const out = kind === "radar" ? await archiveRadarScan(archiveOpts) : await archiveEventScan(archiveOpts);
    const writeLine = `写入：新增 ${out.delta.inserted}、更新 ${out.delta.updated}、未变 ${out.delta.unchanged}`
      + (out.delta.skippedByCursor ? `、游标跳过 ${out.delta.skippedByCursor}` : "")
      + (kind === "radar" ? `、标记消失 ${out.delta.superseded}` : `、保留 ${out.delta.kept}`);
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
export async function tick(now = new Date()): Promise<string> {
  const s = state();
  s.lastTickAt = now.getTime();
  if (!s.enabled) { s.lastOutcome = "调度器已禁用（DESK_SCHEDULER=0）"; return s.lastOutcome; }
  const win = isDueWindow(now, s.cfg);
  if (!win.due || !win.slotAt) {
    // 未到窗口也要留痕：状态接口能据此回答「定时器确实在跑，只是没到执行时刻」
    s.lastOutcome = `未到执行窗口（${win.tradeDate}${win.slotAt ? `，窗口 ${win.slotAt.toISOString()}` : "，当日不排班"}）`;
    return s.lastOutcome;
  }
  const outcomes: string[] = [];
  for (const kind of KINDS) {
    const r = await runTask(kind, "schedule");
    outcomes.push(`${kind}:${r.status}${r.reason ? `(${r.reason})` : ""}${r.results !== undefined ? `×${r.results}` : ""}${r.mode ? `[${r.mode}]` : ""}`);
  }
  s.lastOutcome = outcomes.join(" / ");
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
  console.log(`[scheduler] 已启动：每 ${TICK_MS / 1000}s 检查；执行窗口=交易日北京 ${hhmm}；下次 ${next.date} ${hhmm}（${next.at.toISOString()}）；任务 ${KINDS.join("、")}；禁用用 DESK_SCHEDULER=0`);
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
  const todaySummary = await Promise.all(KINDS.map(async (kind) => {
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
      cursor: await cursorSummary(kind, today),
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
    boundary: "任务随服务端进程运行：网页可关闭，但服务未启动时不会执行；每条执行结果都落 task_run",
  };
}
