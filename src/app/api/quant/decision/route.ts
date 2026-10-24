// GET /api/quant/decision?symbol=600519.SH — P7-④ 四维决策结论（只读）
//
// 这一层只做三件事：校验入参、调决策服务、把错误如实回给页面。
// 计算与口径判断都不在这里：接线内核 decision-wiring-core.ts（有单测）、取数决策服务 decision-service.ts。
// 为什么坚持只读：结论卡每次刷新都会打一遍全A快照 + 板块榜 + 两只标的的日K，
// 它不写库、不触发扫描、不调模型；事件面读的是 P6-B 已落库的解读，没跑过就是空的（页面会写「本次未取到」）。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { buildDecisionForSymbol } from "@/lib/quant/screener/decision-service";
import { shanghaiDate } from "@/lib/desk/session";

export const dynamic = "force-dynamic";
/** 一次结论要串起日K/快照/板块/事件四路取数，留足余量（与 /api/stock/profile 同量级） */
export const maxDuration = 90;

/**
 * 可选整数参数：**没写、写空、写成小数、越界一律返回 null**，交回服务端默认口径。
 * 为什么不直接 `Number(searchParams.get(k))`：`Number(null) === 0` 且 `Number.isInteger(0)` 为真，
 * 「没传」会被读成「传了 0」——事件新鲜度窗口一旦从 3 天变成 0 天，页面上的事件面就只在当天有解读时才有分。
 */
function optInt(raw: string | null, min: number, max: number): number | null {
  const t = (raw ?? "").trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

export async function GET(request: Request) {
  quantBootstrap();
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) {
    return NextResponse.json({ ok: false, error: "需要 symbol 参数，格式 600519.SH / 000001.SZ（本接口不猜交易所后缀）" }, { status: 400 });
  }
  const staleRaw = optInt(url.searchParams.get("stale_after_days"), 0, 90);
  const rsiRaw = optInt(url.searchParams.get("rsi_period"), 2, 60);
  // 可选参数只在「确实写了且是个合理整数」时才覆盖默认口径，否则一律走服务端默认（不静默接受乱填的窗口）
  const opts: { stale_after_days?: number; rsi_period?: number } = {};
  if (staleRaw !== null) opts.stale_after_days = staleRaw;
  if (rsiRaw !== null) opts.rsi_period = rsiRaw;
  try {
    const view = await buildDecisionForSymbol(symbol, opts);
    return NextResponse.json({ ...view, market: "A", market_label: "A股", });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, trade_date: shanghaiDate() }, { status: 502 });
  }
}
