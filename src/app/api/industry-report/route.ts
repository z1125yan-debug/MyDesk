// 产业链研报 · 本地留档接口（GET 读 / POST 存）
//
// 解决两件事：
// ① 打开就快 —— GET 默认返回「今天」那份，命中就秒开，不用再等 AI 生成一轮；
// ② 本地有当日记录 —— 落 data/industry-reports.json，换浏览器/清缓存都不丢。
//
// 口径：
// - GET  ?date=YYYY-MM-DD  取指定交易日那一份（不传 = 今天，北京时间）
// - GET  ?list=1           取历史列表（默认最近 30 份，按生成时间倒序）
// - POST { ts, title, text, tradeDate? }  存一份；同一天覆盖（一天一份）
// 读接口永不报错（无记录就如实说没有）；写接口失败如实回 500，不假装成功。
import { NextResponse } from "next/server";
import {
  getIndustryReportByDate,
  listIndustryReports,
  saveIndustryReport,
  shanghaiDateStr,
} from "@/lib/desk/industry-report-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;

  if (sp.get("list") === "1") {
    const reports = listIndustryReports();
    return NextResponse.json({
      ok: true,
      today: shanghaiDateStr(),
      count: reports.length,
      reports: reports.map((r) => ({
        ts: r.ts,
        title: r.title,
        tradeDate: r.tradeDate,
        createdAt: r.createdAt ?? "",
        chars: r.text.length,
      })),
    });
  }

  const date = sp.get("date") ?? undefined;
  const report = getIndustryReportByDate(date);
  if (!report) {
    // 没有记录不是错误：如实告诉前端「今天还没有」，由前端决定是否提示生成
    return NextResponse.json({
      ok: true,
      found: false,
      today: shanghaiDateStr(),
      date: date ?? shanghaiDateStr(),
    });
  }
  return NextResponse.json({
    ok: true,
    found: true,
    today: shanghaiDateStr(),
    report,
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      ts?: number;
      title?: string;
      text?: string;
      tradeDate?: string;
    };
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ ok: false, error: "缺少研报正文（text）" }, { status: 400 });
    }
    const saved = saveIndustryReport({
      ts: typeof body.ts === "number" ? body.ts : Date.now(),
      title: body.title ?? "",
      text: body.text,
      tradeDate: body.tradeDate,
    });
    return NextResponse.json({
      ok: true,
      saved: { ts: saved.ts, title: saved.title, tradeDate: saved.tradeDate, chars: saved.text.length },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
