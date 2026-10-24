// 周报 + 大事件触发（带 IO 的拉取 / 落档层）。
//
// 数据来源（只用已有来源，不编）：
// - 板块本周涨跌：data/sector-daily-snapshots.json（收盘后归档的真实快照）
// - 大盘本周涨跌：stock_daily_bar 上证指数 000001.SH 首收 → 末收
// - 战绩：strategy_pick（source="ai_pick"，已回填的次日净收益）
// - 涨停龙头：market_limit_up（本周连板 ≥ 3）
// - 美联储：fetchFedPrediction（Kalshi + Polymarket，与日报同源）
// - 下周交易日 / 休市：data/trade-calendar.json（真实年历）
// - 大事件判定输入：同花顺行业榜（盘中实时）+ global_event（已落库快讯）
// - 没有的：财报日历 / 解禁日历 / 周度资金归档 → 如实写“没取到”，不编。
//
// 落档：
// - 周报 → data/weekly-reports/<本周日>.json（与 sector-daily-snapshots.json 同款 JSON 归档）
// - 大事件提醒 → data/big-event-alerts.json（按 dedupeKey 去重，同日同类同主体只发一次）
// - 每次执行都写 task_run（kind=weekly / bigevent），用于回答“有没有跑、什么时候跑”。
// - 推送（发给用户）不在本层：本层只生成 + 归档 + 记账，发送由调用方（日报同款发送通道）负责。

import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { fetchThsBoards } from "@/lib/desk/ths";
import { fetchFedPrediction } from "@/lib/desk/daily-report-sections";
import { upcomingHolidayWindows, upcomingTradingDays } from "@/lib/desk/trade-calendar";
import { buildSectorCards, detectMainLineSectors } from "@/lib/desk/daily-report-by-sector-core";
import {
  addDays,
  buildWeeklyReport,
  evaluateBigEventTriggers,
  parseCnMeetingDate,
  weekRangeOf,
  type BigEventAlert,
  type WeeklyLimitUpRow,
  type WeeklyPickRow,
  type WeeklyReport,
  type WeeklySectorInput,
} from "@/lib/desk/weekly-report-core";

const WEEKLY_DIR = "data/weekly-reports";
const BIG_EVENT_ARCHIVE = "data/big-event-alerts.json";
const INDEX_SYMBOL = "000001.SH";

interface SnapshotDay {
  tradeDate?: string;
  allA?: { medianChange?: number | null };
  industries?: { name?: string; medianChange?: number | null }[];
}

function loadSnapshotDays(): Record<string, SnapshotDay> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data", "sector-daily-snapshots.json"), "utf8")) as {
      days?: Record<string, SnapshotDay>;
    };
    return raw.days ?? {};
  } catch {
    return {}; // 快照文件读不到 → 本周板块全部“没取到”，不猜
  }
}

function weekDates(monday: string, friday: string): string[] {
  const out: string[] = [];
  for (let d = monday; d <= friday; d = addDays(d, 1)) out.push(d);
  return out;
}

function sectorInputs(days: Record<string, SnapshotDay>, tradingDays: string[]): WeeklySectorInput[] {
  const names = new Set<string>();
  for (const d of tradingDays) {
    for (const ind of days[d]?.industries ?? []) {
      if (ind.name) names.add(ind.name);
    }
  }
  return [...names].map((name) => ({
    name,
    dailyMedianChange: tradingDays.map((d) => {
      const row = (days[d]?.industries ?? []).find((i) => i.name === name);
      const v = row?.medianChange;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }),
  }));
}

function compoundAllA(days: Record<string, SnapshotDay>, tradingDays: string[]): number | null {
  let acc = 1;
  let n = 0;
  for (const d of tradingDays) {
    const v = days[d]?.allA?.medianChange;
    if (typeof v === "number" && Number.isFinite(v)) {
      acc *= 1 + v / 100;
      n++;
    }
  }
  return n ? (acc - 1) * 100 : null;
}

/** 组装一周报（不落档；落档走 runWeeklyReportTask） */
export async function fetchWeeklyReport(sundayInput?: string): Promise<WeeklyReport> {
  const today = shanghaiDate();
  const { monday, sunday, nextMonday } = weekRangeOf(sundayInput ?? today);
  const friday = addDays(monday, 4);
  const days = loadSnapshotDays();
  const tradingDays = Object.keys(days).filter((d) => d >= monday && d <= friday).sort();
  const weekEnd = tradingDays.length ? tradingDays[tradingDays.length - 1] : friday;
  const sectors = sectorInputs(days, tradingDays);
  const allAMedianWeeklyPct = compoundAllA(days, tradingDays);

  // 上周（主线变化对比用）
  const prevMonday = addDays(monday, -7);
  const prevFriday = addDays(monday, -3);
  const prevTradingDays = Object.keys(days).filter((d) => d >= prevMonday && d <= prevFriday).sort();
  const prevWeekSectors = sectorInputs(days, prevTradingDays);

  // 上证指数本周：首收 → 末收
  let indexWeeklyPct: number | null = null;
  try {
    const bars = await db.stockDailyBar.findMany({
      where: { symbol: INDEX_SYMBOL, tradeDate: { gte: monday, lte: friday } },
      orderBy: { tradeDate: "asc" },
      select: { close: true },
    });
    if (bars.length >= 2 && bars[0].close > 0) {
      indexWeeklyPct = (bars[bars.length - 1].close / bars[0].close - 1) * 100;
    }
  } catch {
    indexWeeklyPct = null;
  }

  // AI 优选战绩（本周计入战绩的行，只读已回填字段）
  let picks: WeeklyPickRow[] = [];
  try {
    const rows = await db.strategyPick.findMany({
      where: { source: "ai_pick", tradeDate: { gte: monday, lte: friday } },
      select: { tradeDate: true, nextDaySymWin: true, nextDaySymUp: true, nextDaySymCount: true, nextDayBenchNet: true },
    });
    picks = rows.map((r) => ({
      tradeDate: r.tradeDate,
      nextDaySymWin: r.nextDaySymWin,
      nextDaySymUp: r.nextDaySymUp,
      nextDaySymCount: r.nextDaySymCount,
      nextDayBenchNet: r.nextDayBenchNet,
    }));
  } catch {
    picks = [];
  }

  // 涨停龙头：本周连板 ≥ 3
  let limitUpLeaders: WeeklyLimitUpRow[] = [];
  try {
    const rows = await db.marketLimitUp.findMany({
      where: { tradeDate: { gte: monday, lte: friday }, boards: { gte: 3 } },
      orderBy: [{ boards: "desc" }, { tradeDate: "desc" }],
      take: 5,
      select: { name: true, symbol: true, tradeDate: true, boards: true, changePct: true },
    });
    limitUpLeaders = rows.map((r) => ({
      name: r.name, symbol: r.symbol, tradeDate: r.tradeDate, boards: r.boards, changePct: r.changePct,
    }));
  } catch {
    limitUpLeaders = [];
  }

  // 美联储 / 预测市场（与日报同源；失败 → plain 写没取到）
  let fedPlain = "美联储 / 预测市场：没取到。";
  let fedMeetings: { meeting: string; date: string | null }[] = [];
  try {
    const fed = await fetchFedPrediction();
    fedPlain = fed.plain;
    const year = Number(sunday.slice(0, 4));
    fedMeetings = fed.meetings.map((m) => ({ meeting: m.meeting, date: parseCnMeetingDate(m.meeting, year) }));
  } catch {
    // 保持默认“没取到”
  }

  const nextWeekTradingDays = upcomingTradingDays(nextMonday, 5);
  const nextWeekHolidayWindows = upcomingHolidayWindows(nextMonday, 14, 2);

  return buildWeeklyReport({
    sunday,
    weekStart: monday,
    weekEnd,
    tradingDays,
    indexWeeklyPct,
    allAMedianWeeklyPct,
    sectors,
    prevWeekSectors,
    picks,
    limitUpLeaders,
    fedPlain,
    fedMeetings,
    nextWeekTradingDays,
    nextWeekHolidayWindows,
  });
}

export interface WeeklyReportArchive {
  generatedAt: string;
  report: WeeklyReport;
}

/** 归档周报 → data/weekly-reports/<本周日>.json */
export function archiveWeeklyReport(report: WeeklyReport): string {
  const dir = path.resolve(process.cwd(), WEEKLY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.sunday}.json`);
  const payload: WeeklyReportArchive = { generatedAt: new Date().toISOString(), report };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

/** 读归档周报；没有 → null（不现编一份冒充） */
export function loadArchivedWeeklyReport(sunday: string): WeeklyReportArchive | null {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), WEEKLY_DIR, `${sunday}.json`), "utf8");
    return JSON.parse(raw) as WeeklyReportArchive;
  } catch {
    return null;
  }
}

export type WeeklyTaskStatus = "success" | "failure" | "skipped";

/**
 * 周报任务（调度器 + 手动接口共用）：组装 + 归档 + task_run 记账。
 * 幂等：同一 (weekly, sunday) 已有 success → skip（force 才重跑）；
 * 30 分钟内的 running → skip（防周日晚上每分钟 tick 撞车）。
 * 不走收盘后调度器的交易日确证：周报总结的是“过去一周”，周日本来就不开盘。
 */
export async function runWeeklyReportTask(opts?: {
  sunday?: string;
  force?: boolean;
  trigger?: "schedule" | "manual";
}): Promise<{ status: WeeklyTaskStatus; report: WeeklyReport | null; reason?: string; file?: string }> {
  const { sunday } = weekRangeOf(opts?.sunday ?? shanghaiDate());
  const trigger = opts?.trigger ?? "manual";
  const prior = await db.taskRun.findMany({
    where: { kind: "weekly", tradeDate: sunday },
    select: { status: true, startedAt: true, finishedAt: true },
  });
  if (!opts?.force && prior.some((r) => r.status === "success")) {
    return { status: "skipped", report: null, reason: "本周周报已有成功结果（already_success）" };
  }
  if (prior.some((r) => r.status === "running" && Date.now() - r.startedAt.getTime() < 30 * 60_000)) {
    return { status: "skipped", report: null, reason: "周报正在生成中（running）" };
  }
  const row = await db.taskRun.create({
    data: { kind: "weekly", tradeDate: sunday, status: "running", trigger, startedAt: new Date(), basis: "周报：过去一周归档数据汇总" },
  });
  try {
    const report = await fetchWeeklyReport(sunday);
    const file = archiveWeeklyReport(report);
    // 周报归档后同时落一个 PDF 到 ~/workspace/your_files/（交付只贴附件，不贴正文）。
    // best-effort：PDF 失败不影响周报本身，只记进 note。
    let pdfNote = "";
    try {
      const { writeDailyPdfFile } = await import("@/lib/desk/daily-pdf-file");
      const pdfFile = await writeDailyPdfFile("weekly", sunday);
      pdfNote = `；PDF 已落 ${pdfFile}`;
    } catch (e) {
      pdfNote = `；PDF 生成失败（周报本身已归档）：${(e as Error).message}`;
    }
    await db.taskRun.update({
      where: { id: row.id },
      data: {
        status: "success", finishedAt: new Date(), results: 1,
        basis: `周报：本周 ${report.tradingDays.length} 个交易日有板块快照；来源 板块快照归档 + 上证日K + AI优选战绩 + 涨停名单 + 预测市场 + 交易日历`,
        note: `周报已归档：${file}${pdfNote}`,
        missing: JSON.stringify(report.hasData ? [] : ["本周板块快照没取到，周报只有缺数说明"]),
      },
    });
    return { status: "success", report, file };
  } catch (e) {
    const msg = (e as Error).message;
    await db.taskRun.update({
      where: { id: row.id },
      data: { status: "failure", finishedAt: new Date(), error: msg, note: "周报生成失败" },
    });
    return { status: "failure", report: null, reason: msg };
  }
}

// ── 大事件触发 ──

export interface BigEventCheckResult {
  date: string;
  /** 本次判定出的全部提醒（含已发过的） */
  alerts: BigEventAlert[];
  /** 本次新增（去重后真正要发的） */
  newAlerts: BigEventAlert[];
}

/** 实时判定一次大事件（不落档、不记账；落档走 runBigEventCheck） */
export async function checkBigEvents(): Promise<BigEventAlert[]> {
  const date = shanghaiDate();
  const [boards, events, aiPicks, indexBars] = await Promise.all([
    fetchThsBoards("industry").catch(() => []),
    db.globalEvent.findMany({
      where: { asOf: { in: [date, addDays(date, -1)] } },
      orderBy: { asOf: "desc" },
      take: 200,
      select: { title: true, level: true, time: true },
    }).catch(() => []),
    db.strategyPick.findMany({
      where: { tradeDate: date, source: "ai_pick" },
      select: { symbols: true },
    }).catch(() => []),
    db.stockDailyBar.findMany({
      where: { symbol: INDEX_SYMBOL, tradeDate: { lte: date } },
      orderBy: { tradeDate: "desc" },
      take: 2,
      select: { tradeDate: true, close: true },
    }).catch(() => []),
  ]);

  const aiPickNames: string[] = [];
  for (const row of aiPicks) {
    if (!row.symbols) continue;
    try {
      const arr = JSON.parse(row.symbols) as { name?: string }[];
      for (const s of Array.isArray(arr) ? arr : []) {
        if (s?.name) aiPickNames.push(s.name);
      }
    } catch {
      // symbols 解析失败 → 当天 AI 选的票名没取到，个股触发只剩主线口径
    }
  }

  const cards = buildSectorCards(boards);
  const mainLineNames = detectMainLineSectors(cards, () => "").map((m) => m.name);

  let indexChangePct: number | null = null;
  if (indexBars.length >= 2 && indexBars[0].tradeDate === date && indexBars[1].close > 0) {
    indexChangePct = (indexBars[0].close / indexBars[1].close - 1) * 100;
  }

  return evaluateBigEventTriggers({
    date,
    events: events.map((e) => ({ title: e.title, level: e.level, time: e.time })),
    sectors: boards.map((b) => ({
      name: b.name, changePct: b.changePct, netYi: b.netYi, leader: b.leader, leaderPct: b.leaderPct,
    })),
    mainLineNames,
    aiPickNames,
    indexChangePct,
  });
}

function loadAlertArchive(): BigEventAlert[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), BIG_EVENT_ARCHIVE), "utf8")) as { alerts?: BigEventAlert[] };
    return Array.isArray(raw.alerts) ? raw.alerts : [];
  } catch {
    return [];
  }
}

function saveAlertArchive(alerts: BigEventAlert[]): void {
  const file = path.resolve(process.cwd(), BIG_EVENT_ARCHIVE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), alerts: alerts.slice(-500) }, null, 2), "utf8");
}

/**
 * 大事件检查（调度器 + 手动接口共用）：判定 + 按 dedupeKey 去重 + 归档新增 + task_run 记账。
 * 本函数可重复跑（交易时段每 15 分钟一次）：去重在提醒级别，不在任务级别，
 * 同日同类同主体只发一次，重复检查不再产生新提醒。
 * 零新增时不写 task_run（调度器 lastOutcome 里仍有“已检查、无新增”记录，避免每 15 分钟刷一条空行）。
 */
export async function runBigEventCheck(opts?: { trigger?: "schedule" | "manual" }): Promise<BigEventCheckResult> {
  const date = shanghaiDate();
  const alerts = await checkBigEvents();
  const seen = new Set(loadAlertArchive().map((a) => a.dedupeKey));
  const newAlerts = alerts.filter((a) => !seen.has(a.dedupeKey));
  if (newAlerts.length) {
    saveAlertArchive([...loadAlertArchive(), ...newAlerts]);
    await db.taskRun.create({
      data: {
        kind: "bigevent", tradeDate: date, status: "success", trigger: opts?.trigger ?? "manual",
        startedAt: new Date(), finishedAt: new Date(), results: newAlerts.length,
        basis: "大事件触发：同花顺行业榜 + 已落库快讯 + 当日 AI 优选 + 上证日K",
        note: `新增大事件提醒 ${newAlerts.length} 条：${newAlerts.map((a) => a.subject).join("、")}`,
        missing: JSON.stringify([]),
      },
    });
  }
  return { date, alerts, newAlerts };
}
