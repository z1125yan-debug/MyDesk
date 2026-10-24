// GET /api/snapshot?kind=risk|themes|probability&date=YYYY-MM-DD — 每日留档的回看（P5 第五阶段）
//
// 只读三张快照表，不重算、不写库（与第四阶段的历史层同一条规矩）。
// 未指定 date ⇒ 返回最近若干条留档 + 全部留档日期；指定 date ⇒ 只返回那天的留档行（同日多条都给出，倒序）。
// 那天没留过 ⇒ 空 items + 明确说明，绝不拿别的日子或现算的结果顶上。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { parseQueryDate } from "@/lib/quant/screener/history-core";
import {
  SNAPSHOT_TABLE, SNAPSHOT_TEXT, emptyDaySnapshotNote, noSnapshotNote, parseSnapshotKind,
  snapshotBasis, snapshotDateBuckets, snapshotItem,
} from "@/lib/quant/screener/snapshot-core";
import { countSnapshots, listSnapshotRows, snapshotDateRows } from "@/lib/quant/screener/snapshot";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const kind = parseSnapshotKind(sp.get("kind"));
    if (!kind) {
      return NextResponse.json({ ok: false, error: `kind 只能是 risk / themes / probability，收到「${String(sp.get("kind")).slice(0, 32)}」` }, { status: 400 });
    }
    const today = shanghaiDate();
    const rawDate = sp.get("date");
    let date = "";
    let dateBasis = "";
    if (rawDate === null || String(rawDate).trim() === "") {
      date = "";
      dateBasis = `未指定 date → 返回「${SNAPSHOT_TEXT[kind]}」最近的留档（按留档时刻倒序，最多 10 条）`;
    } else {
      const parsed = parseQueryDate(rawDate, today);
      if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
      date = parsed.date;
      dateBasis = `按请求参数 date=${date} 查询（只读留档日等于该日的行）`;
    }

    const total = await countSnapshots(db, kind);
    const buckets = snapshotDateBuckets(await snapshotDateRows(db, kind));
    const rows = await listSnapshotRows(db, kind, date);
    const items = rows.map((r) => snapshotItem(kind, r));
    const missing: string[] = [];
    if (!total) missing.push(noSnapshotNote(kind));
    else if (date && !items.length) missing.push(emptyDaySnapshotNote(kind, date, buckets.length));
    if (date && items.some((i) => i.payload_broken)) {
      missing.push("有留档行的 payload 不是合法 JSON（列内容损坏）：摘要只能按可读部分给出，损坏部分不做修补、不重算代替");
    }
    return NextResponse.json({
      market: "A", market_label: "A股",
      ok: true,
      kind,
      table: SNAPSHOT_TABLE[kind],
      label: SNAPSHOT_TEXT[kind],
      today,
      date: date || null,
      date_basis: dateBasis,
      basis: snapshotBasis(kind),
      counts: { total, days: buckets.length, returned: items.length },
      available_dates: buckets,
      items,
      missing,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `留档回看读取失败：${(e as Error).message}` }, { status: 502 });
  }
}
