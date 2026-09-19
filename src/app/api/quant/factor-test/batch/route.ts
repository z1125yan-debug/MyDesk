// P2-1 因子批量有效性验证 — 一次拉数/建面板，逐因子跑同一口径测试并落库
// POST /api/quant/factor-test/batch {fields?, horizon?, maxStocks?, lookback?, persist?}
//   → 汇总报告（严格线 passed=需求文档§五，宽松线 loosePass=指令文档参考线，仅报告不落 verified）
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { runBatchFieldTests, type BatchFieldTestRow } from "@/lib/quant/factors/tester";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // 300只×500根K线 + 全量因子计算

export async function POST(request: Request) {
  quantBootstrap();
  const body = (await request.json().catch(() => null)) as {
    fields?: string[]; horizon?: number; maxStocks?: number; lookback?: number; persist?: boolean;
  } | null;
  const persist = body?.persist !== false;
  try {
    const report = await runBatchFieldTests({
      fields: body?.fields,
      horizon: body?.horizon,
      maxStocks: body?.maxStocks,
      lookback: body?.lookback,
    });

    if (persist) {
      for (const r of report.rows) {
        const res = r.result;
        if (!r.tested || !res) continue;
        try {
          await db.factorTest.create({
            data: {
              factorKey: res.field,
              horizon: res.horizon,
              universe: "all_a_top",
              dataRange: res.metrics.dataRange,
              sampleStocks: res.metrics.sample.stocks,
              sampleDates: res.metrics.sample.dates,
              ic: res.metrics.ic,
              rankIc: res.metrics.rankIc,
              icIr: res.metrics.icIr,
              monotonicity: res.metrics.monotonicity,
              turnover: res.metrics.turnover,
              monthlyWinRate: res.metrics.monthlyWinRate,
              maxDrawdown: res.metrics.maxDrawdown,
              groupReturns: JSON.stringify(res.metrics.groupAnnual),
              monthlyIc: JSON.stringify(res.monthlyIc),
              passed: res.passed,
              note: res.note,
            },
          });
        } catch {
          // 单条落库失败不影响报告返回（结果仍已写入 data/factor-verified.json）
        }
      }
    }

    // 返回瘦身：逐因子的完整 monthlyIc/icSeriesLite 体积过大，只保留结论行
    const rows: Omit<BatchFieldTestRow, "result">[] = report.rows.map((r) => {
      const { result, ...rest } = r;
      void result;
      return rest;
    });
    return NextResponse.json({ ...report, rows, persisted: persist });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
