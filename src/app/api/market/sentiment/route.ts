// 大盘情绪仪表盘 API（需求文档 P0：涨跌家数/涨停/成交额/风险等级）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";

export const dynamic = "force-dynamic";

export async function GET() {
  quantBootstrap();
  try {
    const data = await computeSentiment();
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `市场情绪计算失败：${(e as Error).message}` }, { status: 502 });
  }
}
