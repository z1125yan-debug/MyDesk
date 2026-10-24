// 个股基本面 API（P3：接入 china-stock-mcp 补齐项目此前缺失的「公司维度」数据）
// 覆盖：财务三表（利润/现金流/财务指标）、股东、高管持股变动、分红、限售解禁、
//       券商研报、业绩预测、产品构成、估值、筹码分布（若上游可用）。
// 契约：REAL_DATA_ONLY —— 上游故障或字段解析不出来的块返回 null，missing 里如实列出。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { shanghaiDate } from "@/lib/desk/session";
import {
  fetchMcpBalanceSheet, fetchMcpIncomeStatement, fetchMcpCashFlow, fetchMcpFinancialMetrics,
  fetchMcpStockValue, fetchMcpShareholder, fetchMcpCirculateHolder, fetchMcpInnerTrade,
  fetchMcpManagementChange, fetchMcpFhps, fetchMcpRestrictedRelease, fetchMcpProfitForecast,
  fetchMcpResearchReport, fetchMcpProductInfo, fetchMcpFundFlow, fetchMcpCyq,
} from "@/lib/quant/data/mcp-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYM_RE = /^\d{6}\.(SH|SZ|BJ)$/i;

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!SYM_RE.test(symbol)) {
    return NextResponse.json({ ok: false, error: "代码格式应为 688256.SH / 000001.SZ" }, { status: 400 });
  }
  const code6 = symbol.split(".")[0];
  // 取数当天（北京时间）：原来 toISOString().slice(0,10) 是 UTC 日期，北京 21 点以后会差一天
  const asOf = shanghaiDate();

  // 并发拉取所有块；上游故障的块自动 null
  const [balance, income, cashFlow, metrics, value, shareholder, circulate, innerTrade,
        management, fhps, restricted, forecast, research, product, fundFlow, cyq] =
    await Promise.all([
      fetchMcpBalanceSheet(code6),
      fetchMcpIncomeStatement(code6),
      fetchMcpCashFlow(code6),
      fetchMcpFinancialMetrics(code6),
      fetchMcpStockValue(code6),
      fetchMcpShareholder(code6),
      fetchMcpCirculateHolder(code6),
      fetchMcpInnerTrade(code6),
      fetchMcpManagementChange(code6),
      fetchMcpFhps(code6),
      fetchMcpRestrictedRelease(code6),
      fetchMcpProfitForecast(code6),
      fetchMcpResearchReport(code6),
      fetchMcpProductInfo(code6),
      fetchMcpFundFlow(code6),
      fetchMcpCyq(code6),
    ]);

  const missing: string[] = [];
  if (!balance) missing.push("资产负债表（MCP get_balance_sheet 上游未返回；某些行业如金融业字段映射失败）");
  if (!income) missing.push("利润表");
  if (!cashFlow) missing.push("现金流量表");
  if (!metrics) missing.push("财务指标");
  if (!value) missing.push("估值历史");
  if (!shareholder) missing.push("股东户数");
  if (!circulate) missing.push("流通股东");
  if (!innerTrade) missing.push("内部股东交易");
  if (!management) missing.push("高管持股变动");
  if (!fhps) missing.push("分红送配");
  if (!restricted) missing.push("限售解禁");
  if (!forecast) missing.push("业绩预测");
  if (!research) missing.push("券商研报");
  if (!product) missing.push("产品/业务构成");
  if (!fundFlow) missing.push("资金流向（MCP 上游未完成请求）");
  if (!cyq) missing.push("筹码分布（MCP 上游未完成请求）");

  const wrap = <T,>(b: { data: T; source: string } | null) =>
    b ? { data: b.data, source: b.source, status: "HISTORICAL" } : null;

  const blocks = {
    balance_sheet: wrap(balance),
    income_statement: wrap(income),
    cash_flow: wrap(cashFlow),
    financial_metrics: wrap(metrics),
    value_history: wrap(value),
    shareholder_count: wrap(shareholder),
    circulate_holder: wrap(circulate),
    inner_trade: wrap(innerTrade),
    management_change: wrap(management),
    dividend_fhps: wrap(fhps),
    restricted_release: wrap(restricted),
    profit_forecast: wrap(forecast),
    research_report: wrap(research),
    product_info: wrap(product),
    fund_flow_100d: wrap(fundFlow),
    chips_cyq: wrap(cyq),
  };

  // 支持 ?blocks=income,metrics 只取子集（前端按需拉，减少首次加载）
  const want = (url.searchParams.get("blocks") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const finalBlocks = want.length
    ? Object.fromEntries(Object.entries(blocks).filter(([k]) => want.includes(k)))
    : blocks;

  return NextResponse.json({
    market: "A", market_label: "A股",
    ok: true,
    symbol,
    code: code6,
    as_of: asOf,
    blocks: finalBlocks,
    missing,
    source_note: "所有数据来自 china-stock-mcp（ModelScope 云端 MCP），未配置 MCP 时所有块为 null",
  }, { headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=3600" } });
}
