// POST /api/market/review-stats/import-seed —— 把稳智同步种子照抄进 market_daily_stats（P15-R19）。
//
// 为什么要这一步：两张历史表自建成起一直 0 行。查清的根因是三段叠加，不是采集器写错：
//   ① schema 里加了 model 但库里没建表 → 09-23/09-24 每次收盘扫描都撞「table does not exist」；
//   ② 表补上之后唯一的交易日 09-25 是中秋休市（上证指数日线止于 09-24），调度器如实记 non_trading_day；
//   ③ review 这一路是 09-27 晚才接线的新任务，接完还没有过一个收盘窗口。
// 而 2026-04-20~09-24 这 110 个交易日的真实读数一直躺在种子里没人抄——
// 见顶预警、市场环境分位要的是历史序列，序列不抄进来，R20 一开就是「样本 0 天」。
//
// 口径（写死在这里，别绕）：
//   1) 只抄不造：13 个数字全部来自种子格子，缺格记 null；抄之前先跑纯核自查（auditSeedRows），
//      查出来的毛病原样回给调用方，不藏。
//   2) 出身必须看得见：basis 明写「稳智同步种子照抄（外部来源，非收盘自产）」，
//      绝不冒充收盘后自产——日后谁来核对都知道这行是谁写的。
//   3) 给自产行让路：库里 basis 以「本地自产」开头的日期一律不动（只看开头，不做全文包含——
//      实测踩过：种子 basis 里写了「非本地自产」，全文包含就把种子自己认成自产行，第二次导入一条都不写）。
//   4) 与页面的关系零变化：读侧（/api/market/review-stats）只把 tradeDate > 种子终点 的库行续上图，
//      这批 ≤ 终点的行不进合并，所以图不会跳、数字不会变——这里只是把历史落进可查的表。
//   5) 幂等、只增改不删：tradeDate 唯一键 upsert；同日重跑写同一批值。本接口不碰别的表，
//      不改 schema（不动地基）。
//   6) 必须显式 POST：GET 直接 405，防止页面预取或爬虫顺手写库。带 ?dry_run=1 只自查不写。
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import seed from "@/lib/quant/review/review-stats-seed.json";
import {
  SEED_IMPORT_BASIS, auditSeedRows, isSelfProducedBasis, mapSeedRows, seedColumnWidths,
} from "@/lib/quant/review/review-seed-core";
import { shanghaiStamp } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "这是写库接口，要用 POST 明确触发；只想看历史数据请读 /api/market/review-stats" },
    { status: 405 },
  );
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  let dryFromBody = false;
  try {
    const text = await req.text();
    dryFromBody = text ? Boolean((JSON.parse(text) as { dry_run?: boolean }).dry_run) : false;
  } catch {
    /* 空 body / 非 JSON body 都按「不干跑」处理，只写库不猜意图 */
  }
  const dryRun = dryFromBody || url.searchParams.get("dry_run") === "1";

  const raw = seed as unknown as readonly (readonly unknown[])[];
  const mapped = mapSeedRows(raw);
  const audit = auditSeedRows(mapped);
  const widths = seedColumnWidths(raw);
  const valid = mapped.filter((r) => DATE_RE.test(r.date));
  const dates = valid.map((r) => r.date);

  const existing = dates.length
    ? await db.marketDailyStats.findMany({
        where: { tradeDate: { in: dates } },
        select: { tradeDate: true, basis: true },
      })
    : [];
  const selfProduced = new Set(
    existing.filter((e) => isSelfProducedBasis(e.basis)).map((e) => e.tradeDate),
  );
  const known = new Set(existing.map((e) => e.tradeDate));

  let inserted = 0;
  let rewritten = 0;
  if (!dryRun) {
    for (const r of valid) {
      if (selfProduced.has(r.date)) continue; // 自产说了算的日子：种子让路，不覆盖
      const data = {
        limitUp: r.limitUp, limitDown: r.limitDown,
        t3: r.t3, t4: r.t4, t5: r.t5, maxBoards: r.maxBoards,
        decliners: r.decliners, belowMa5: r.belowMa5, belowMa3: r.belowMa3,
        aboveMa5Pct: r.aboveMa5Pct, microPct: r.microPct, midPct: r.midPct, largePct: r.largePct,
        basis: SEED_IMPORT_BASIS,
      };
      if (known.has(r.date)) {
        await db.marketDailyStats.update({ where: { tradeDate: r.date }, data });
        rewritten++;
      } else {
        await db.marketDailyStats.create({ data: { tradeDate: r.date, ...data } });
        inserted++;
      }
    }
  }

  const missing: string[] = [...audit];
  if (selfProduced.size) {
    missing.push(`${selfProduced.size} 个日期库里已是本地自产行——本次不动它们（种子只补底子，不倒灌自产）`);
  }
  if (valid.length !== mapped.length) {
    missing.push(`${mapped.length - valid.length} 行日期不合格式，未入库`);
  }
  if (dryRun) missing.unshift("dry_run=1：只自查，本次一条都没写");

  const total = await db.marketDailyStats.count();
  return NextResponse.json({
    ok: true,
    as_of: shanghaiStamp(),
    dry_run: dryRun,
    seed: {
      rows: mapped.length,
      column_widths: widths,
      range: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    },
    wrote: { inserted, rewritten, kept_self_produced: selfProduced.size },
    table_rows_after: total,
    basis: SEED_IMPORT_BASIS,
    missing,
    boundary:
      "只写 market_daily_stats 一张表，只增改不删、不动 schema；读侧接口仍按「种子止点之后才用库行」合并，所以页面数字不受本次影响",
  });
}
