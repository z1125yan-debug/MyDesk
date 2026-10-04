// 大盘情绪仪表盘 API（需求文档 P0：涨跌家数/涨停/成交额/风险等级）
// P15-R20b：同拍再挂三块——见顶压力分（六分量加权）、外盘背离判定、外盘原样读数。
//   为什么挂在这条路由上而不是新开一条 `/api/market/overseas`：
//   背离判定要吃「全 A 当日中位涨跌幅」，那个数只有这份快照里有；新开一条等于把同一件事算两遍、
//   还得让页面自己拼两份不同时刻的数。挂在这儿，档位牌和顶上四张卡就是同一次计算出来的。
//   代价：压力分本身不挡情绪数据——下面整块 try/catch，任何一路挂了只少这三块，情绪照发。
import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
// R20：全 A 快照不带 mainNet，这里另挂一份通达信逐笔自算的主力净额合计
import { marketMainNetTdx } from "@/lib/desk/fund-flow";
// R20b：见顶压力分（判定与刻度全在 top-pressure-core 那份纯核里）
import { computeTopPressure } from "@/lib/quant/screener/top-pressure";
import type { MainNetTdxClient } from "@/lib/desk/main-net-core";
import { beijingParts, isWeekend } from "@/lib/quant/scheduler/rules";

export const dynamic = "force-dynamic";

/**
 * 服务端 TTL：盘中 55 秒。
 * 为什么单独给这条路由：它算一次要十几~二十五秒（腾讯批量快照兜底 95 个请求 + 通达信主力净额），
 * 而页面轮询是 60 秒一次——用默认 30 秒的话**每次轮询都必然过期重算**，四张卡就一直在转圈等。
 * 55 < 60：轮询基本都能命中热缓存（读数最多滞后约 55 秒，对累计成交额无感），
 * 冷启动只在「第一次/长时间没人看」时发生。
 *
 * 2026-09-30 补丁（用户：当天第二次打开要秒开）：休市时段（工作日 15:30 后 / 次日 09:15 前、
 * 以及周末）行情不会变，TTL 放大到 30 分钟——盘后反复打开页面不再每次重算十几秒。
 */
const SENTIMENT_TTL_MS = 55_000;
const SENTIMENT_TTL_CLOSED_MS = 30 * 60_000;
function sentimentTtlMs(): number {
  try {
    const p = beijingParts(new Date());
    if (isWeekend(p.weekday)) return SENTIMENT_TTL_CLOSED_MS;
    if (p.minuteOfDay >= 15 * 60 + 30 || p.minuteOfDay < 9 * 60 + 15) return SENTIMENT_TTL_CLOSED_MS;
  } catch { /* 时钟异常回退盘中 TTL */ }
  return SENTIMENT_TTL_MS;
}

export async function GET() {
  return ttlCache("market/sentiment", sentimentTtlMs(), () => getHandler());
}
async function getHandler() {
  quantBootstrap();
  try {
    // P67 体检 #7：情绪快照与通达信主力净额两路互不依赖，并行取（旧码串行白等一段）
    const [data, tdx] = await Promise.all([computeSentiment(), marketMainNetTdx()]);
    const extra: Record<string, unknown> = {};
    // 压力分这一整块是「加在情绪数据上的第三只眼」，取不到就只发情绪数据（页面按 undefined 显示「没读到」）
    try {
      const p = await computeTopPressure(data, (tdx as { main_net_tdx?: MainNetTdxClient }).main_net_tdx ?? null);
      extra.pressure = p.pressure;
      extra.divergence = p.divergence;
      extra.overseas = p.overseas;
    } catch (e) {
      extra.pressure_error = `见顶压力分没算出来：${(e as Error).message}`;
    }
    return NextResponse.json({ ok: true, ...data, ...tdx, ...extra });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `市场情绪计算失败：${(e as Error).message}` }, { status: 502 });
  }
}
