// POST /api/market/limit-up/backfill —— 把东财涨停池的**留存窗口**灌进 market_limit_up（P15-R20）。
//
// 为什么要回填：晋级率要比「昨天那一档有几只、今天晋级了几只」，而本表建成时是空的。
// 实测 push2ex getTopicZTPool 支持 date=YYYYMMDD 按日取数，且窗口内（约回溯到当月月中旬）真的给数
// ——2026-09-28 探针：09-10/09-15/09-18/09-21/09-22/09-23/09-24 各日都有名单，09-01 及更早、09-25 起为 0 条。
// 所以窗口内的历史现在就能拿，不用等名单一天一天攒。
//
// 口径（写死，别绕）：
//   1) 只跑本地收盘价表证明开过盘的日期（`stock_daily_close` 里行数过千的交易日）：
//      不去猜哪天是交易日，也就不可能把休市日写成一个「0 只涨停」的日子。
//   2) 池子返回 0 条 → 该日一行不写，只在 missing 里记一句原因。0 条分不清是休市还是超窗口，
//      所以「更早的历史仍然为空」不等于「那些天没有涨停」。
//   3) 库里已有名单的日期默认跳过；force=1 才重刷（同日重刷以最后一次为准，票×日唯一键 upsert）。
//   4) 只 POST、只写 market_limit_up 一张表：不删行、不碰别的表。dry_run=1 只取数不写库。
//   5) 一次最多 90 天（缺省 30），从最近的交易日往前取：回填是补窗口，不是扫库。
import { NextResponse } from "next/server";
import { backfillLimitUpRoster } from "@/lib/quant/screener/limit-up-collect";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { days?: number; force?: boolean | number | string; dry_run?: boolean | number | string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* 允许空 body：默认补最近 30 个交易日 */
  }
  const days = typeof body.days === "number" && Number.isFinite(body.days) ? Math.trunc(body.days) : 30;
  const force = body.force === true || body.force === 1 || body.force === "1";
  const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === "1";

  if (dryRun) {
    // 试运行不写库，也不发请求：只报告「库里现在有哪些日期的名单、下一次会看哪些候选日」
    const have = await db.marketLimitUp.findMany({ select: { tradeDate: true }, orderBy: { tradeDate: "asc" } });
    const byDate = new Map<string, number>();
    for (const r of have) byDate.set(r.tradeDate, (byDate.get(r.tradeDate) ?? 0) + 1);
    return NextResponse.json({
      ok: true,
      dry_run: true,
      written: 0,
      dates_in_db: [...byDate.entries()].map(([date, rows]) => ({ date, rows })),
      note: "试运行：一个请求都没发、一行都没写。要去掉 dry_run 才会真的按日取池子",
    });
  }

  try {
    const res = await backfillLimitUpRoster({ days, force });
    return NextResponse.json({ ok: true, force, ...res });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function GET() {
  const rows = await db.marketLimitUp.findMany({ select: { tradeDate: true, symbol: true, boards: true }, orderBy: { tradeDate: "asc" } });
  const byDate = new Map<string, { rows: number; unknownBoards: number }>();
  for (const r of rows) {
    const cur = byDate.get(r.tradeDate) ?? { rows: 0, unknownBoards: 0 };
    cur.rows++;
    if (r.boards === null) cur.unknownBoards++;
    byDate.set(r.tradeDate, cur);
  }
  return NextResponse.json({
    ok: true,
    days: [...byDate.entries()].map(([date, v]) => ({ date, rows: v.rows, unknown_boards: v.unknownBoards })),
    total_rows: rows.length,
    note: "GET 只报告库里现有什么；按日取池子请用 POST（dry_run=1 可先看清单不写库）",
  });
}
