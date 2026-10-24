// GET /api/daily-report/pdf?slot=morning|noon|evening|weekly&date=YYYY-MM-DD
//   → 直接返回 PDF 文件（Content-Type: application/pdf，附件下载）。
//   slot=weekly 时 date 是该周内任意一天（按所在周取周日归档/现算）。
//   历史日期的日报：只有落档正文，PDF 只画落档正文，不拿今天的数据冒充当天。
//   缺数据时 PDF 里写“没取到”，不编数据。

import { NextResponse } from "next/server";
import {
  DailyPdfFontError,
  DailyPdfNotFoundError,
  fetchDailyPdfBuffer,
  fetchWeeklyPdfBuffer,
} from "@/lib/desk/daily-report-pdf";
import { shanghaiDate } from "@/lib/desk/session";
import type { ReportSlot } from "@/lib/desk/three-daily-reports-core";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const SLOTS = ["morning", "noon", "evening", "weekly"] as const;
type PdfSlot = (typeof SLOTS)[number];
const isSlot = (v: string | null): v is PdfSlot => !!v && (SLOTS as readonly string[]).includes(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD 形状 + 真实日历日期（2026-13-99、2026-02-30 这类都拒绝） */
function isRealDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const slot = sp.get("slot");
  // weekly 也接受 week= 别名（与 /api/weekly-report 一致）
  const date = sp.get("date") ?? sp.get("week") ?? shanghaiDate(new Date());
  if (!isSlot(slot)) {
    return NextResponse.json(
      { ok: false, error: `slot 非法：${slot}，可选：morning、noon、evening、weekly` },
      { status: 400 },
    );
  }
  if (!isRealDate(date)) {
    return NextResponse.json({ ok: false, error: `date 非法：${date}，格式 YYYY-MM-DD 且须为真实日期` }, { status: 400 });
  }
  try {
    const pdf = slot === "weekly"
      ? await fetchWeeklyPdfBuffer(date)
      : await fetchDailyPdfBuffer(slot as ReportSlot, date);
    const filename = `daily-report-${slot}-${date}.pdf`;
    return new Response(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`MyDesk日报-${slot}-${date}.pdf`)}`,
        "Content-Length": String(pdf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof DailyPdfNotFoundError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 404 });
    }
    if (e instanceof DailyPdfFontError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: `日报 PDF 生成失败：${(e as Error).message}` }, { status: 502 });
  }
}
