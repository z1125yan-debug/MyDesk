// P0补齐（任务B）— 涨停梯队 / 连板池（服务端）
// 流程：全A快照（任务A口径，精确涨停价）筛出收盘涨停名单 → 只对名单内股票逐只取近 20 根日K
//   （fetchBarsHybrid：eltdx 优先~30ms/只、腾讯兜底、连续失败熔断——禁止全A逐只拉K线）
//   → 逐日判「收盘涨停」回溯连板数。
// 历史日涨停判定口径（注释即文档）：
//  - 最后一根K线（当日）直接复用快照精确判定（昨收×比例四舍五入到分）；
//  - 更早各日用「收盘涨幅 ≥ 限制比例 − 0.5pct」近似：
//      · eltdx 为原始价，四舍五入使低价股实际涨停幅度可低至 ~9.5%（故留 0.5pct 容差）；
//      · 腾讯兜底为 qfq 前复权价，窗口内除权会扰动单日涨幅（连板股近期除权罕见，接受并披露）。
//  - 连板数上限=窗口 20 根；跨窗口更长的连板标 boards=20+（capped 标记）。
import { getProvider } from "@/lib/quant/data/index";
import { universeSource } from "@/lib/quant/data/tc-universe";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { latestTradeDate } from "@/lib/desk/trade-date";
import type { AssetMeta } from "../types.ts";
import { evalLimitSnapshot, limitRatio } from "./sentiment.ts";

export interface LimitUpStock {
  symbol: string;
  name: string;
  industry: string | null;
  price: number | null;
  changePct: number | null;
  boards: number; // 连板数（1=首板）
  capped: boolean; // 20 根窗口内仍全涨停（真实连板数 ≥20）
}

export interface LimitUpTier {
  label: string; // 首板 / 2连板 / 3连板+ / 最高板
  stocks: LimitUpStock[];
}

export interface LimitUpResult {
  as_of: string;
  trade_date: string;
  limit_up_count: number; // 收盘涨停家数（快照口径）
  touched_count: number;
  broken_count: number;
  break_rate: number | null;
  max_boards: number;
  tiers: LimitUpTier[];
  note: string;
  source: { provider: string; kline: string };
}

const WINDOW = 20; // 连板回溯窗口（日K根数）

/** 用日K序列从最后一根向前回溯连板数 */
function countBoards(symbol: string, name: string, bars: { date: string; c: number }[]): { boards: number; capped: boolean } {
  const ratioPct = limitRatio(symbol, name) * 100;
  const th = ratioPct - 0.5; // 容差（低价股四舍五入 + 复权扰动）
  let boards = 0;
  for (let t = bars.length - 1; t >= 1; t--) {
    const prev = bars[t - 1].c, now = bars[t].c;
    if (prev <= 0) break;
    const pct = (now / prev - 1) * 100;
    if (pct >= th) boards++;
    else break;
  }
  return { boards, capped: boards >= WINDOW - 1 };
}

export async function computeLimitUp(): Promise<LimitUpResult> {
  const provider = await getProvider("em");
  // 数据日 = 行情源认的最近交易日，不是系统当天：
  // 休市日（周末/节假日）拿今天当 trade_date，会把上一交易日的涨停名单说成「今天的涨停」，
  // 页面上「涨停 55 家」就会挂在一个从没开过盘的日期底下。
  const tradeDate = await latestTradeDate().catch(() => shanghaiDate(new Date()));
  const metas: AssetMeta[] = await provider.listUniverse({ kind: "all" }, tradeDate);
  if (!metas.length) throw new Error("全A快照为空（数据源无返回）");

  // 1) 快照口径：收盘涨停名单 + 触板/炸板计数（与任务A同口径）
  const sealed: AssetMeta[] = [];
  let touched = 0, broken = 0;
  for (const m of metas) {
    const ev = evalLimitSnapshot(m);
    if (!ev) continue;
    if (ev.touched) touched++;
    if (ev.sealed) sealed.push(m);
    else if (ev.touched) broken++;
  }
  const breakRate = touched > 0 ? (broken / touched) * 100 : null;

  // 2) 只对涨停名单逐只拉近 20 根日K（fetchBarsHybrid 自带节流/熔断；名单几十~百只量级）
  const symbols = sealed.map((m) => m.symbol);
  const barsMap = symbols.length
    ? await fetchBarsHybrid(symbols, tradeDate, WINDOW)
    : new Map<string, { date: string; c: number }[]>();

  const stocks: LimitUpStock[] = sealed.map((m) => {
    const bars = (barsMap.get(m.symbol) ?? []) as { date: string; c: number }[];
    const valid = bars.filter((b) => b.date <= tradeDate && isFinite(b.c) && b.c > 0);
    const { boards, capped } = valid.length >= 2 ? countBoards(m.symbol, m.name, valid) : { boards: 1, capped: false };
    return {
      symbol: m.symbol,
      name: m.name,
      industry: m.industry ?? null,
      price: m.price ?? null,
      changePct: m.changePct ?? null,
      boards: Math.max(1, boards), // 快照已判收盘涨停 → 至少首板
      capped,
    };
  });
  stocks.sort((a, b) => b.boards - a.boards || (b.price ?? 0) * (b.changePct ?? 0) - (a.price ?? 0) * (a.changePct ?? 0));

  // 3) 梯队分组
  const maxBoards = stocks.length ? stocks[0].boards : 0;
  const first = stocks.filter((s) => s.boards === 1);
  const second = stocks.filter((s) => s.boards === 2);
  const thirdPlus = stocks.filter((s) => s.boards >= 3);
  const top = stocks.filter((s) => s.boards === maxBoards && maxBoards >= 2);
  const tiers: LimitUpTier[] = [
    { label: "最高板", stocks: top },
    { label: "3连板+", stocks: thirdPlus },
    { label: "2连板", stocks: second },
    { label: "首板", stocks: first },
  ];

  return {
    as_of: shanghaiStamp(),
    trade_date: tradeDate,
    limit_up_count: sealed.length,
    touched_count: touched,
    broken_count: broken,
    break_rate: breakRate,
    max_boards: maxBoards,
    tiers,
    note: "当日涨停=快照精确口径（昨收×比例四舍五入到分）；历史连板回溯用涨幅阈值(比例−0.5pct)近似，腾讯兜底为前复权价；窗口20根，超出标 20+",
    source: {
      provider: universeSource() === "tdx" ? "通达信网关 + 本地库（TDX实时快照 + DB收盘价；市盈率/市值/主力净额标缺）"
        : universeSource() === "tc" ? "腾讯批量快照兜底（东财榜单接口 断源；昨收/最高仍为真实读数）" : "em（东财榜单接口 全A快照）",
      kline: "日K取数（通达信优先/腾讯兜底，仅涨停名单）",
    },
  };
}
