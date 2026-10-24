// GET /api/daily-report/three?slot=morning|noon|evening&date=YYYY-MM-DD
//   有 slot → 返回该份日报（优先读定时生成的落档，没有则现场生成并落档）。
//   无 slot → 返回三份的定时表 + 当日各份是否已有落档。
// POST /api/daily-report/three?slot=...&force=1 → 强制重算该份日报（手动补发）。
//
// 时段（北京时间）：早报 08:30 / 午报 12:00 / 晚报 16:00。
// 交易日发完整版；非交易日只发早报瘦身版（美股 + 重大新闻 + 财联社新闻），午/晚报不发
// （定时器用真实日历门禁；手动触发不设门禁，但正文数据归属日期照实写）。
// 缺数据返回“没取到”，不编数据。

import { NextResponse } from "next/server";
import {
  fetchThreeDailyReport,
  NoonNotDueError,
  readStoredReport,
} from "@/lib/desk/three-daily-reports";
import {
  REPORT_SLOT_DEFS,
  nextReportSlot,
  type ReportSlot,
} from "@/lib/desk/three-daily-reports-core";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const SLOTS = ["morning", "noon", "evening"] as const;
const isSlot = (v: string | null): v is ReportSlot =>
  !!v && (SLOTS as readonly string[]).includes(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function scheduleOverview(date: string) {
  const stored = await Promise.all(
    REPORT_SLOT_DEFS.map(async (def) => ({
      slot: def.slot,
      label: def.label,
      title: def.title,
      minuteOfDay: def.minuteOfDay,
      sections: def.sections,
      dataBelongsTo: def.dataBelongsTo,
      ready: (await readStoredReport(date, def.slot)) != null,
    })),
  );
  const next = nextReportSlot(new Date());
  return {
    ok: true,
    date,
    timezone: "Asia/Shanghai",
    tradingDayOnly: "交易日发完整版；非交易日只发早报瘦身版（美股 + 重大新闻 + 财联社新闻），午/晚报不发",
    schedule: stored,
    next: { date: next.date, slot: next.slot, at: next.at.toISOString() },
  };
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const slot = sp.get("slot");
  const date = sp.get("date") ?? shanghaiDate(new Date());
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ ok: false, error: `date 非法：${date}，格式 YYYY-MM-DD` }, { status: 400 });
  }
  if (!slot) return NextResponse.json(await scheduleOverview(date));
  if (!isSlot(slot)) {
    return NextResponse.json({ ok: false, error: `slot 非法：${slot}，可选：morning、noon、evening` }, { status: 400 });
  }
  try {
    // 读指定日期的落档：date 是签发日；今天的请求走现场生成路径（内部会先读当日落档）
    if (date !== shanghaiDate(new Date())) {
      const stored = await readStoredReport(date, slot);
      if (!stored) {
        return NextResponse.json(
          { ok: false, error: `${date} 的${slot}日报没有落档（当天可能休市、或定时器没跑到）` },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, ...stored });
    }
    const report = await fetchThreeDailyReport(slot, new Date());
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    if (e instanceof NoonNotDueError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 425 });
    }
    return NextResponse.json({ ok: false, error: `三份日报读取失败：${(e as Error).message}` }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const sp = new URL(req.url).searchParams;
  const slot = sp.get("slot");
  if (!isSlot(slot)) {
    return NextResponse.json({ ok: false, error: `slot 非法：${slot}，可选：morning、noon、evening（POST 需带 slot）` }, { status: 400 });
  }
  try {
    const report = await fetchThreeDailyReport(slot, new Date(), { force: true });
    // 生成后同时落一个 PDF 到 ~/workspace/your_files/（交付只贴附件，不贴正文）。
    // best-effort：PDF 失败不影响日报本身。
    let pdfFile: string | null = null;
    try {
      const { writeDailyPdfFile } = await import("@/lib/desk/daily-pdf-file");
      pdfFile = await writeDailyPdfFile(slot, report.issueDate);
    } catch (e) {
      console.error("[daily-report/three] PDF 落盘失败（日报本身已生成）：", (e as Error).message);
    }
    return NextResponse.json({ ok: true, pdfFile, ...report });
  } catch (e) {
    if (e instanceof NoonNotDueError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 425 });
    }
    return NextResponse.json({ ok: false, error: `三份日报重算失败：${(e as Error).message}` }, { status: 502 });
  }
}
