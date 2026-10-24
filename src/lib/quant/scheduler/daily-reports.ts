// 三份日报 · 定时器（服务端进程内，与 P2 调度器同一模式，未引入新依赖）
//
// 时段（北京时间，Asia/Shanghai）：早报 08:30 / 午报 12:00 / 晚报 16:00。
//   · 晚报 16:00 在收盘 15:00 之后 1 小时：15:30 拉数据，16:00 发，留给数据 + AI 分析。
//     （AI 优选本身由收盘后 15:20 自动任务生成，晚报 16:00 读它已落库的结果，不重跑模型。）
// 门禁：交易日发完整版；非交易日只发早报瘦身版（美股 + 重大新闻 + 财联社新闻，
//   不重复推昨天 A 股内容），午/晚报不发——用真实日历（trade-calendar，含法定节假日）判定；
//   日历读不到时也不发（不猜）。
// 幂等：同一 (kind, issueDate) 已有 success 不再跑；failure 最多 3 次；
//   执行都写 task_run（kind = daily-report-morning / -noon / -evening），
//   与收盘后扫描任务同一张表，/api/tasks/status 能看到。
// 边界（必须如实）：任务随 Next 服务进程运行——服务进程没启动就不会跑。

import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { isTradingDay } from "@/lib/desk/trade-calendar";
import { decideRun, type TaskRunRowLite } from "./rules";
import { fetchThreeDailyReport } from "@/lib/desk/three-daily-reports";
import {
  REPORT_SLOT_DEFS,
  isSlotDue,
  tradingDayGate,
  type ReportSlot,
} from "@/lib/desk/three-daily-reports-core";

const TICK_MS = 60_000;

export const DAILY_REPORT_TASK_KIND: Record<ReportSlot, string> = {
  morning: "daily-report-morning",
  noon: "daily-report-noon",
  evening: "daily-report-evening",
};

const G = globalThis as typeof globalThis & { __mydeskDailyReports?: { timer: ReturnType<typeof setInterval> | null; lastOutcome: string } };

function state() {
  if (!G.__mydeskDailyReports) {
    G.__mydeskDailyReports = { timer: null, lastOutcome: "" };
  }
  return G.__mydeskDailyReports;
}

async function rowsOf(kind: string, issueDate: string): Promise<TaskRunRowLite[]> {
  const rows = await db.taskRun.findMany({
    where: { kind, tradeDate: issueDate },
    select: { status: true, startedAt: true, finishedAt: true, error: true },
  });
  return rows.map((r) => ({
    status: r.status,
    startedAt: r.startedAt.getTime(),
    finishedAt: r.finishedAt?.getTime() ?? null,
    reason: r.error,
  }));
}

/** 每日每 kind 只留一条 skipped 记录，避免 tick 反复写库制造噪音 */
async function recordSkippedOnce(kind: string, issueDate: string, reason: string, basis: string): Promise<void> {
  const existing = await db.taskRun.findFirst({
    where: { kind, tradeDate: issueDate, status: "skipped" },
    select: { id: true, error: true },
  });
  if (!existing) {
    await db.taskRun.create({
      data: {
        kind, tradeDate: issueDate, status: "skipped", trigger: "schedule", error: reason,
        startedAt: new Date(), finishedAt: new Date(),
        missing: JSON.stringify([basis]), basis, note: "未生成日报，未产生任何数据",
      },
    });
  } else if (existing.error !== reason) {
    await db.taskRun.update({
      where: { id: existing.id },
      data: { error: reason, basis, missing: JSON.stringify([basis]) },
    });
  }
}

async function runSlot(slot: ReportSlot, now: Date, issueDate: string): Promise<string> {
  const kind = DAILY_REPORT_TASK_KIND[slot];
  // 幂等拦截：当日已成功 / 失败达上限 / 正在跑 → 跳过
  const decision = decideRun(await rowsOf(kind, issueDate));
  if (decision.action === "skip") return `${kind}:skip(${decision.reason})`;
  const row = await db.taskRun.create({
    data: {
      kind, tradeDate: issueDate, status: "running", trigger: "schedule",
      startedAt: new Date(), basis: `三份日报定时：${issueDate} ${slot}（${isTradingDay(issueDate) === false && slot === "morning" ? "非交易日瘦身版" : "交易日已确证"}）`,
    },
  });
  try {
    const report = await fetchThreeDailyReport(slot, now);
    // 日报生成后同时落一个 PDF 到 ~/workspace/your_files/（交付只贴附件，不贴正文）。
    // best-effort：PDF 失败不影响日报本身，只记进 note。
    let pdfNote = "";
    try {
      const { writeDailyPdfFile } = await import("@/lib/desk/daily-pdf-file");
      const pdfFile = await writeDailyPdfFile(slot, issueDate);
      pdfNote = `；PDF 已落 ${pdfFile}`;
    } catch (e) {
      pdfNote = `；PDF 生成失败（日报本身已落档）：${(e as Error).message}`;
    }
    await db.taskRun.update({
      where: { id: row.id },
      data: {
        status: "success", finishedAt: new Date(),
        results: report.sections.length,
        scanned: report.sections.length,
        missing: JSON.stringify(report.missing),
        basis: `三份日报定时：${issueDate} ${slot}；数据归属 ${report.dataDate}；来源 日报拉取层（板块资金/美股/减持/涨停/AI优选已落库结果）`,
        note: `生成 ${report.sections.length} 节${report.preliminary ? "（盘中快照）" : ""}；落档 data/daily-reports/${issueDate}-${slot}.json${pdfNote}`,
      },
    });
    return `${kind}:success(${report.sections.length} 节)`;
  } catch (e) {
    const msg = (e as Error).message;
    await db.taskRun.update({
      where: { id: row.id },
      data: { status: "failure", finishedAt: new Date(), error: msg, note: "日报生成失败，下一次 tick 会重试（最多 3 次）" },
    });
    return `${kind}:failure(${msg})`;
  }
}

/** 一次 tick：到点的份 + 当日是交易日 + 当日未成功 → 生成并落档 */
export async function dailyReportsTick(now = new Date()): Promise<string> {
  const s = state();
  if (process.env.DESK_SCHEDULER === "0") {
    s.lastOutcome = "三份日报调度器已禁用（DESK_SCHEDULER=0）";
    return s.lastOutcome;
  }
  const issueDate = shanghaiDate(now);
  const outcomes: string[] = [];
  const trading = isTradingDay(issueDate);
  for (const def of REPORT_SLOT_DEFS) {
    if (!isSlotDue(now, def.slot)) continue;
    // 非交易日（用户 2026-10-17 定）：只跑早报瘦身版（美股 + 重大新闻 + 财联社新闻），
    // 午/晚报不发（记 skipped）；交易日走完整版；日历读不到（null）时不发、不猜。
    if (trading === false) {
      if (def.slot === "morning") {
        outcomes.push(await runSlot(def.slot, now, issueDate));
        continue;
      }
      await recordSkippedOnce(DAILY_REPORT_TASK_KIND[def.slot], issueDate, "non_trading_day", `${issueDate} 不是 A 股交易日，非交易日只发早报瘦身版，午/晚报不发。`);
      outcomes.push(`${DAILY_REPORT_TASK_KIND[def.slot]}:skip(非交易日，午/晚报不发)`);
      continue;
    }
    const gate = tradingDayGate(trading, issueDate);
    if (!gate.send) {
      await recordSkippedOnce(DAILY_REPORT_TASK_KIND[def.slot], issueDate, "non_trading_day", gate.reason);
      outcomes.push(`${DAILY_REPORT_TASK_KIND[def.slot]}:skip(${gate.reason})`);
      continue;
    }
    outcomes.push(await runSlot(def.slot, now, issueDate));
  }
  s.lastOutcome = outcomes.length ? outcomes.join(" / ") : `未到三份日报窗口（${issueDate}，下一份见 /api/daily-report/three）`;
  return s.lastOutcome;
}

export function startDailyReportScheduler(): void {
  const s = state();
  if (process.env.DESK_SCHEDULER === "0") {
    console.log("[daily-reports] 已禁用：DESK_SCHEDULER=0");
    return;
  }
  if (s.timer) return; // 幂等：重复注册不再加定时器
  s.timer = setInterval(() => {
    void dailyReportsTick().catch((e) => {
      s.lastOutcome = `tick 异常：${(e as Error).message}`;
      console.error("[daily-reports] tick failed:", (e as Error).message);
    });
  }, TICK_MS);
  s.timer.unref?.();
  setTimeout(() => {
    void dailyReportsTick().catch((e) => console.error("[daily-reports] startup tick failed:", (e as Error).message));
  }, 5_000).unref?.();
  console.log("[daily-reports] 已启动：每 60s 检查；早报 08:30 / 午报 12:00 / 晚报 16:00（北京时间，仅交易日）；禁用用 DESK_SCHEDULER=0");
}

export function stopDailyReportScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/** /api/tasks/status 用：当日三份日报各是否已生成（只看当日成功行） */
export async function dailyReportStatus(): Promise<{ kind: string; slot: ReportSlot; label: string; settled: boolean; last_status: string }[]> {
  const today = shanghaiDate(new Date());
  return Promise.all(REPORT_SLOT_DEFS.map(async (def) => {
    const kind = DAILY_REPORT_TASK_KIND[def.slot];
    const rows = await db.taskRun.findMany({
      where: { kind, tradeDate: today },
      orderBy: { startedAt: "desc" },
      select: { status: true },
    });
    return {
      kind,
      slot: def.slot,
      label: def.title,
      settled: rows.some((r) => r.status === "success"),
      last_status: rows[0]?.status ?? "",
    };
  }));
}
