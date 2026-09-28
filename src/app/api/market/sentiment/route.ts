// 大盘情绪仪表盘 API（需求文档 P0：涨跌家数/涨停/成交额/风险等级）
// P15-R20b：同拍再挂三块——见顶压力分（六分量加权）、外盘背离判定、外盘原样读数。
//   为什么挂在这条路由上而不是新开一条 `/api/market/overseas`：
//   背离判定要吃「全 A 当日中位涨跌幅」，那个数只有这份快照里有；新开一条等于把同一件事算两遍、
//   还得让页面自己拼两份不同时刻的数。挂在这儿，档位牌和顶上四张卡就是同一次计算出来的。
//   代价：压力分本身不挡情绪数据——下面整块 try/catch，任何一路挂了只少这三块，情绪照发。
import { NextResponse } from "next/server";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
// R20：全 A 快照不带 mainNet，这里另挂一份通达信逐笔自算的主力净额合计
import { marketMainNetTdx } from "@/lib/desk/fund-flow";
// R20b：见顶压力分（判定与刻度全在 top-pressure-core 那份纯核里）
import { computeTopPressure } from "@/lib/quant/screener/top-pressure";
import type { MainNetTdxClient } from "@/lib/desk/main-net-core";

export const dynamic = "force-dynamic";

export async function GET() {
  return ttlCache("market/sentiment", DEFAULT_TTL_MS, () => getHandler());
}
async function getHandler() {
  quantBootstrap();
  try {
    const data = await computeSentiment();
    const tdx = await marketMainNetTdx();
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
