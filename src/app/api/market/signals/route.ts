// 技术指标选股 API（P3：接入 china-stock-mcp get_stock_technical_rank）
// MCP 一次一个 indicator，30 种指标；本接口默认拿 19 种项目最常用的，每个指标前 30 只。
// 契约：REAL_DATA_ONLY —— MCP 未配置或某指标上游故障时 failed 里如实列出，不冒充。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { fetchMcpTechnicalSignals } from "@/lib/quant/data/mcp-provider";
import { latestTradeDate } from "@/lib/desk/trade-date";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const SYMS = [
  "创新高-创月新高", "创新高-半年新高", "创新高-一年新高", "创新高-历史新高",
  "创新低-创月新低", "创新低-半年新低", "创新低-一年新低", "创新低-历史新低",
  "连续上涨", "连续下跌",
  "持续放量", "持续缩量",
  "向上突破-20日均线", "向上突破-60日均线",
  "向下突破-20日均线", "向下突破-60日均线",
  "量价齐升", "量价齐跌", "险资举牌",
] as const;

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const perParam = url.searchParams.get("per");
  const perLimit = perParam ? Math.min(100, Math.max(10, parseInt(perParam, 10) || 30)) : 30;

  const result = await fetchMcpTechnicalSignals(SYMS, perLimit);
  if (!result) {
    return NextResponse.json({
      ok: false,
      error: "MCP 未配置或所有指标均失败",
      missing: ["china-stock-mcp · get_stock_technical_rank 全部失败"],
    }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json({
    ok: true,
    // 技术指标是收盘口径：数据日=最近交易日（行情源真值，节假日自动识别）；
    // 原来用 new Date().toISOString().slice(0,10) 是 UTC 日期，北京晚上会差一天，休市日更是直接拿电脑当天冒充
    as_of: await latestTradeDate().catch(() => ""),
    source: result.source,
    per: perLimit,
    total_indicators: SYMS.length,
    succeeded: result.data.length,
    failed: result.failed,
    signals: result.data,
  }, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=1800" } });
}
