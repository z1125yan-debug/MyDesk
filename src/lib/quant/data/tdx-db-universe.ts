// 通达信 + 本地库 全A快照（第一优先，仅服务端）
//
// 触发时机：em-provider 的 fetchUniverseAllA 先试本模块；成功（>1000 只）即返回，
// 不再试东财/腾讯。东财 push2（502）与腾讯直连（超时）都挂时，本模块是唯一活路。
//
// 数据：
//   - 宇宙（代码+名称）：本地库 stock_daily_close 最新交易日（<= asOf）的去重符号+名称
//     （DB 里 5567 只：沪深 5215 + 北交所 352，剔除 B 股，9月21-10月15 日K全齐）
//   - 快照（价/涨跌幅/高/低/昨收/量/额）：通达信网关 quotes.get_snapshots 批量（120 只/批，并发 6）
//   - 振幅：(high-low)/prevClose*100（TDX 快照可算）
//   - 市值/流通市值/市净率/换手率：通达信快照无此字段，由 TDX MCP 财务补齐
//     （7709 finance_batch：股本/净资产 → 市值=现价×股本，PB=现价/每股净资产，
//     换手=当日量/流通股本；PE 需 F10 逐只拉 ~11s/只，不在此全量刷，
//     由 enrichMetasWithPe 在候选池里单独补）
//   - 量比：TDX MCP 无此字段，用本地库前 5 交易日均量推导（DB 口径）
//   - 主力净额：仍标缺（同花顺事件雷达另有主力验证，不拿内外盘代理数冒充）
//   - 失败/无数据 → 保持 undefined（缺就是缺，不编 0）
//   - quoteDate：本地库最新交易日；quoteTime：undefined（TDX 快照无逐只时刻，不冒充实时）
//
// 诚实口径：universeSource() = "tdx"，上层文案据此改写，不冒充东财/腾讯。
// 失败语义：TDX 返回 <1000 只即整体抛错，交回调用方试东财/腾讯（备胎），不拿半截数据冒充全A。

import { db } from "@/lib/db";
import { tdxQuotes } from "@/lib/desk/tdx";
import { enrichMetasWithFund } from "@/lib/desk/tdx-mcp-fund";
import type { AssetMeta } from "../types.ts";

const BATCH = 60;
const CONC = 2; // TDX 网关 server-count 1 × connections-per-server 2 = 仅 2 连接，并发超过 2 会排队超时（tdx.ts rpc 超时 4s）
const MIN_OK = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function fetchTdxDbUniverseAllA(asOf: string): Promise<AssetMeta[]> {
  // 1) 宇宙：本地库最新交易日（<= asOf）的符号+名称
  const latest = await db.stockDailyClose.findFirst({
    where: { tradeDate: { lte: asOf } },
    orderBy: { tradeDate: "desc" },
    select: { tradeDate: true },
  });
  const quoteDate = latest?.tradeDate;
  if (!quoteDate) throw new Error("本地库 stock_daily_close 无任何收盘价行（需先跑历史回填）");
  const rows = await db.stockDailyClose.findMany({
    where: { tradeDate: quoteDate },
    select: { symbol: true, name: true },
  });
  if (rows.length < MIN_OK) throw new Error(`本地库最新交易日 ${quoteDate} 仅 ${rows.length} 只，低于 ${MIN_OK} 只阈值`);
  const nameMap = new Map(rows.map((r) => [r.symbol, r.name]));
  const symbols = rows.map((r) => r.symbol);

  // 2) 快照：通达信批量（120 只/批，并发 6）
  const out: AssetMeta[] = [];
  const groups = chunk(symbols, BATCH);
  // 分波，每波 CONC 并发
  for (let i = 0; i < groups.length; i += CONC) {
    const wave = groups.slice(i, i + CONC);
    const results = await Promise.allSettled(wave.map((g) => tdxQuotes(g)));
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      for (const [sym, q] of r.value) {
        const name = nameMap.get(sym) ?? sym;
        const prev = q.prevClose > 0 ? q.prevClose : q.price;
        const amplitude = prev > 0 ? ((q.high - q.low) / prev) * 100 : undefined;
        out.push({
          symbol: sym,
          name,
          industry: undefined,
          listDate: undefined,
          marketCap: undefined,
          floatCap: undefined,
          pe: undefined,
          pb: undefined,
          price: q.price,
          changePct: q.changePct,
          turnover: undefined, // 下方第 3 步由 TDX MCP 财务（流通股本）补齐
          volumeRatio: undefined, // 下方第 4 步由本地库前 5 日均量补齐
          amplitude: amplitude !== undefined && Number.isFinite(amplitude) ? amplitude : undefined,
          high: q.high,
          prevClose: q.prevClose,
          mainNet: undefined, // 通达信快照无东财口径主力净额，标缺（不拿内外盘代理数冒充）
          volume: q.volumeHand !== undefined ? q.volumeHand * 100 : undefined,
          amount: q.amountYi * 1e8,
          st: /ST/i.test(name),
          suspended: false, // TDX 返回了价，即非停牌；无价的已跳过（不在 out 里）
          quoteDate,
          quoteTime: undefined,
        });
      }
    }
  }
  if (out.length < MIN_OK) {
    throw new Error(`通达信快照成功率过低（宇宙 ${symbols.length} / 解析成功 ${out.length}，网关可能不可用）`);
  }

  // 3) TDX MCP 财务富化（7709 finance_batch，批量快）：市值/流通市值/PB/换手率。
  //    最佳努力：失败时保持 undefined，不阻塞快照返回。
  try {
    await enrichMetasWithFund(out);
  } catch {
    // 保持 undefined，不抛错
  }

  // 4) 量比 = 当日量 / 本地库前 5 交易日均量（DB 口径；不足 3 日历史的标缺）。
  try {
    const bars = await db.stockDailyBar.findMany({
      where: { tradeDate: { lt: quoteDate } },
      orderBy: { tradeDate: "desc" },
      take: 5 * out.length,
      select: { symbol: true, tradeDate: true, volume: true },
    });
    const bySym = new Map<string, number[]>();
    for (const b of bars) {
      const arr = bySym.get(b.symbol) ?? [];
      if (arr.length < 5 && b.volume != null && b.volume > 0) arr.push(b.volume);
      bySym.set(b.symbol, arr);
    }
    for (const m of out) {
      const hist = bySym.get(m.symbol) ?? [];
      if (m.volume != null && m.volume > 0 && hist.length >= 3) {
        const avg = hist.reduce((a, v) => a + v, 0) / hist.length;
        if (avg > 0) {
          const vr = m.volume / avg;
          if (Number.isFinite(vr) && vr >= 0) m.volumeRatio = vr;
        }
      }
    }
  } catch {
    // 保持 undefined，不抛错
  }

  return out;
}
