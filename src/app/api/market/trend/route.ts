// 大盘趋势数据（P15-R2a 对齐稳智「市场情绪分析」页的图表区）：
// 两市成交额按日合计 + vs昨日 + 三指数区间累计涨跌。日期范围来自页面控件（闭区间，空=不设边）。
// 缺数如实报：一条指数没取到就是 missing 登记，不拿另两条凑三条的图。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { fetchIndexDayBars, SH_SECID, SZ_SECID, CYB_SECID } from "@/lib/quant/screener/market-trend";
import { mergeTurnover, turnoverDeltaVsPrev, cumReturnSeries, inRange, trendNotes } from "@/lib/quant/screener/market-trend-core";

export const dynamic = "force-dynamic";

function shanghaiDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  quantBootstrap();
  const url = new URL(req.url);
  // 只认 YYYY-MM-DD；认不出的输入一律按「不设边」处理，不把脏串递进上游 URL
  const rawFrom = url.searchParams.get("from") ?? "";
  const rawTo = url.searchParams.get("to") ?? "";
  const from = DATE_RE.test(rawFrom) ? rawFrom : "";
  const to = DATE_RE.test(rawTo) ? rawTo : "";
  // 默认窗口：今天往前 90 个自然日（够画稳智那种月级柱图），结束日不传=至今
  const defFrom = from || shanghaiDateStr(new Date(Date.now() - 90 * 864e5));
  const defTo = to || shanghaiDateStr(new Date());
  try {
    const [shRaw, szRaw, cybRaw] = await Promise.all([
      fetchIndexDayBars(SH_SECID, defFrom, defTo),
      fetchIndexDayBars(SZ_SECID, defFrom, defTo),
      fetchIndexDayBars(CYB_SECID, defFrom, defTo),
    ]);
    const sh = inRange(shRaw, defFrom, defTo);
    const sz = inRange(szRaw, defFrom, defTo);
    const cyb = inRange(cybRaw, defFrom, defTo);
    const pts = mergeTurnover(sh, sz);
    const { deltaYi, prevDate } = turnoverDeltaVsPrev(pts);
    const missing: string[] = [];
    if (!sh.length) missing.push("上证指数：数据源没给读数（push2his/push2delay 双试均空），成交额合计与沪深线缺这条");
    if (!sz.length) missing.push("深证成指：数据源没给读数，成交额合计与深市线缺这条");
    return NextResponse.json({
      ok: true,
      range: { from: defFrom, to: defTo },
      days: pts,
      delta: { yi: deltaYi, prev_date: prevDate },
      cum: { sh: cumReturnSeries(sh), sz: cumReturnSeries(sz), cyb: cumReturnSeries(cyb) },
      notes: trendNotes(sh.length, sz.length, cyb.length),
      missing,
      source: "eastmoney kline（push2his 优先、push2delay 次之）· 成交额=指数日成交额字段合计沪+深，含当天截至刷新时刻的累计",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `趋势数据获取失败：${(e as Error).message}` }, { status: 502 });
  }
}
