// 财经快讯：默认给「上游最新一屏」（首页快讯栏用），带 dates/date 时给**指定交易日的全量窗口**。
//
// 为什么要两条路（P65）：原来这个接口只有 fetchNewsReal(12) —— 只有抓取那一刻的 12 条，
// 且把 showTime 的日期位砍成 HH:MM。研报拿它当「当日快讯」用，于是 09-24 的研报只能挂 09-27 的头条，
// 一条主线都匹配不上，正文里「关联新闻：最新抓取快讯里没有与该主线直接相关的题目」就是这么来的。
// 带 dates 时走 fetchNewsWindowForDates：按 realSort 游标翻到目标区间为止，每条都带完整日期。
import { NextResponse } from "next/server";
import { fetchNewsReal, fetchNewsWindowForDates } from "@/lib/desk/em";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 5;

function readDates(url: URL): string[] {
  const raw = [...(url.searchParams.get("dates") ?? "").split(","), url.searchParams.get("date") ?? ""]
    .map((s) => s.trim().slice(0, 10))
    .filter((s) => DATE_RE.test(s));
  return [...new Set(raw)].sort((a, b) => (a < b ? 1 : -1)).slice(0, MAX_DAYS);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const dates = readDates(url);
  // limit 不给就是「不截断，整段窗口都给你」（研报要在全量池里按主线挑）；给了就按条数截，上限 3000
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(3000, Math.floor(rawLimit)) : 0;

  if (!dates.length) {
    try {
      const news = await fetchNewsReal();
      return NextResponse.json({ news });
    } catch {
      return NextResponse.json({ news: null });
    }
  }

  try {
    const win = await fetchNewsWindowForDates(dates);
    if (!win) {
      return NextResponse.json({
        ok: false,
        news: [],
        dates,
        error: `未取到 ${dates.join("、")} 的快讯窗口（上游两源都没有返回该区间的数据）`,
      }, { status: 502 });
    }
    const perDay = win.tradeDates.map((d) => ({ date: d, items: win.perDay[d] ?? [] }));
    const news = perDay.flatMap((p) => p.items.map((it) => ({ ...it, date: p.date })));
    const cappedList = limit ? news.slice(0, limit) : news;
    return NextResponse.json({
      ok: true,
      news: cappedList,
      perDay: perDay.map((p) => ({ date: p.date, count: p.items.length })),
      dates: win.tradeDates,
      span: { from: win.spanFrom, to: win.spanTo },
      total: news.length,
      fetched_rows: win.fetchedRows,
      off_day: win.offDay,
      duplicated: win.duplicated,
      dropped: win.dropped,
      capped: win.capped,
      source: { provider: win.source === "东财7x24" ? "东财 7x24 全球快讯（按 realSort 游标翻至目标区间）" : "新浪财经直播" },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, news: [], dates, error: `快讯窗口获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
