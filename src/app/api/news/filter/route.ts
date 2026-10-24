// GET /api/news/filter：新闻筛选（催化分流器规则版 v1）
// 读财联社电报库 cls_telegraph，按 news-outlets-core 的规则分 9 个口子 + 未分类，
// 只做分类展示：不写库、不接选股、不进 AI 优选、不产买卖信号。
// 参数：outlet（默认 all）、days（默认 7， clamp 1..30）、q（标题/正文关键词）、limit（默认 300，clamp 50..1000）。
// 注意：电报库留存目前约一周（最早 2026-10-18），days 再大也只能返回库里有的；
// 计数按整个窗口算，列表只返回最新 limit 条（截断时 truncated=true，如实标出）。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { addBeijingDays } from "@/lib/quant/scheduler/rules";
import {
  NEWS_OUTLETS, classifyNews, type NewsOutletKey,
} from "@/lib/desk/news-outlets-core";

export const dynamic = "force-dynamic";

interface StockChip { name: string; code: string }

function parseSubjects(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object" && "subject_name" in s) return String((s as { subject_name?: unknown }).subject_name ?? "");
      return "";
    }).filter(Boolean).slice(0, 5);
  } catch { return []; }
}

function parseStocks(raw: string): StockChip[] {
  try {
    const v = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((s) => {
      if (!s || typeof s !== "object") return null;
      const o = s as { name?: unknown; StockID?: unknown };
      const name = String(o.name ?? "");
      const sid = String(o.StockID ?? "");
      if (!name || !sid) return null;
      // CLS 的 StockID 形如 sh605358 / sz000636 → 转成本站通用的 605358.SH / 000636.SZ
      const m = sid.match(/^(sh|sz)(\d+)$/);
      const code = m ? `${m[2]}.${m[1] === "sh" ? "SH" : "SZ"}` : sid;
      return { name, code };
    }).filter((x): x is StockChip => x !== null).slice(0, 8);
  } catch { return []; }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const outletParam = u.searchParams.get("outlet") ?? "all";
  const daysRaw = Number.parseInt(u.searchParams.get("days") ?? "7", 10);
  const days = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, daysRaw)) : 7;
  const q = (u.searchParams.get("q") ?? "").trim();
  const limitRaw = Number.parseInt(u.searchParams.get("limit") ?? "300", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(50, limitRaw)) : 300;

  const today = shanghaiDate();
  const from = addBeijingDays(today, -(days - 1));
  try {
    const rows = await db.clsTelegraph.findMany({
      where: { shTime: { gte: `${from} 00:00:00` } },
      orderBy: { shTime: "desc" },
      take: 5000,
      select: { id: true, shTime: true, title: true, content: true, subjects: true, stockList: true },
    });
    const earliest = await db.clsTelegraph.findFirst({
      orderBy: { shTime: "asc" },
      select: { shTime: true },
    });

    const counts = new Map<NewsOutletKey, number>();
    for (const o of NEWS_OUTLETS) counts.set(o.key, 0);
    const items: {
      id: string; time: string; title: string; outlet: NewsOutletKey; rule: string;
      subjects: string[]; stocks: StockChip[];
    }[] = [];

    for (const r of rows) {
      const text = `${r.title} ${r.content}`;
      if (q && !text.includes(q)) continue;
      const stocks = parseStocks(r.stockList);
      const { outlet, rule } = classifyNews(r.title, r.content, stocks.length);
      counts.set(outlet, (counts.get(outlet) ?? 0) + 1);
      if (outletParam !== "all" && outlet !== outletParam) continue;
      if (items.length < limit) {
        items.push({
          id: r.id, time: r.shTime, title: r.title || "(无标题)", outlet, rule,
          subjects: parseSubjects(r.subjects), stocks,
        });
      }
    }
    const totalAfterQ = [...counts.values()].reduce((a, b) => a + b, 0);
    const outletCount = outletParam === "all" ? totalAfterQ : (counts.get(outletParam as NewsOutletKey) ?? 0);

    return NextResponse.json({
      ok: true,
      as_of: today,
      window: { from, days },
      coverage: { earliest_in_db: earliest?.shTime ?? null, scanned: rows.length },
      outlets: NEWS_OUTLETS.map((o) => ({ key: o.key, label: o.label, desc: o.desc, count: counts.get(o.key) ?? 0 })),
      outlet: outletParam,
      q: q || null,
      total_after_q: totalAfterQ,
      returned: items.length,
      truncated: outletCount > items.length,
      items,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
