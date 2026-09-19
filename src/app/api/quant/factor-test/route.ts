// P1-4 因子有效性测试台 API
// POST /api/quant/factor-test {field, horizon?, maxStocks?, lookback?} → 同步跑单因子测试并落库
// GET  /api/quant/factor-test[?field=] → 测试记录（最新在前；无 field 返回各因子最新版）
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { runFactorTest } from "@/lib/quant/factors/tester";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // 300只×500根K线拉取+计算，需较长时间

function rowToDto(r: {
  id: string; factorKey: string; horizon: number; dataRange: string; createdAt: Date;
  ic: number; rankIc: number; icIr: number; monotonicity: number; turnover: number;
  monthlyWinRate: number; maxDrawdown: number; groupReturns: string; monthlyIc: string;
  passed: boolean; sampleStocks: number; sampleDates: number; note: string;
  universe: string;
}) {
  const j = <T,>(s: string, fb: T): T => { try { return JSON.parse(s) as T; } catch { return fb; } };
  return {
    id: r.id,
    field: r.factorKey,
    horizon: r.horizon,
    testedAt: r.createdAt.toISOString(),
    passed: r.passed,
    universe: r.universe,
    note: r.note,
    metrics: {
      ic: r.ic, rankIc: r.rankIc, icIr: r.icIr,
      groupAnnual: j<number[]>(r.groupReturns, []),
      monotonicity: r.monotonicity, turnover: r.turnover,
      monthlyWinRate: r.monthlyWinRate, maxDrawdown: r.maxDrawdown,
      sample: { dates: r.sampleDates, stocks: r.sampleStocks, validPairs: 0 },
      dataRange: r.dataRange,
    },
    monthlyIc: j<{ month: string; rankIc: number }[]>(r.monthlyIc, []),
  };
}

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => null)) as {
    field?: string; horizon?: number; maxStocks?: number; lookback?: number;
  } | null;
  if (!body?.field) {
    return NextResponse.json({ ok: false, error: "需要 field（因子字段 key）" }, { status: 400 });
  }
  try {
    const result = await runFactorTest({
      field: body.field,
      horizon: body.horizon,
      maxStocks: body.maxStocks,
      lookback: body.lookback,
    });
    await db.factorTest.create({
      data: {
        factorKey: result.field,
        horizon: result.horizon,
        universe: "all_a_top",
        dataRange: result.metrics.dataRange,
        sampleStocks: result.metrics.sample.stocks,
        sampleDates: result.metrics.sample.dates,
        ic: result.metrics.ic,
        rankIc: result.metrics.rankIc,
        icIr: result.metrics.icIr,
        monotonicity: result.metrics.monotonicity,
        turnover: result.metrics.turnover,
        monthlyWinRate: result.metrics.monthlyWinRate,
        maxDrawdown: result.metrics.maxDrawdown,
        groupReturns: JSON.stringify(result.metrics.groupAnnual),
        monthlyIc: JSON.stringify(result.monthlyIc),
        passed: result.passed,
        note: result.note,
      },
    });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}

export async function GET(request: Request) {
  quantBootstrap();
  const field = new URL(request.url).searchParams.get("field");
  const rows = await db.factorTest.findMany({
    where: field ? { factorKey: field } : undefined,
    orderBy: { createdAt: "desc" },
    take: field ? 20 : 200,
  });
  let tests = rows.map(rowToDto);
  if (!field) {
    // 各因子仅保留最新一次
    const seen = new Set<string>();
    tests = tests.filter((t) => (seen.has(t.field) ? false : (seen.add(t.field), true)));
  }
  return NextResponse.json({ ok: true, tests });
}
