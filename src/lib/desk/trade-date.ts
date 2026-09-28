// 最近交易日 · 单一出处（仅服务端使用）
//
// 为什么需要它：页面上「行情时刻 15:32:49」这种**只有时分秒**的戳，碰上休市日会被读成
// 「今天下午还在交易」（用户实测：周六 22:34 看到 15:33 的行情时刻，以为数据是假的）。
// 补一个交易日，读者才知道这份数属于哪一天。
//
// 口径（数据驱动，不硬编码节假日表）：
//   ① 先问通达信网关 —— 上证指数日K的最后一根日期就是「最近交易日」；
//   ② 网关没启动时改问腾讯日K（同一条 K 线的第二个源，不猜日历）；
//   ③ 两个行情源都拿不到才退到「周末感知」的日历兜底（周末回退到上一个周五）。
//      法定节假日**不在**兜底里猜 —— 认不出就退到最近的工作日，等行情源恢复后自动纠正。
// 实测：2026-09-25（中秋）+ 09-26（周六）连着休市，行情源给的是 2026-09-24。
//
// 为什么必须有 ②：2026-09-27 实测网关没起 → ① 返回 null → 只走 ③ 日历兜底，
// 09-27（周日）算出 09-25，而 09-25 是中秋休市日 —— 日历只认周末、不认节假日，
// 于是把休市日说成"最近交易日"（/api/market/board 当场就吐了 tradeDate=2026-09-25）。
// 腾讯日K不受网关影响，最后一根就是 09-24，把这类错挡在源头。

import { marketSession, prevWeekday, shanghaiDate } from "./session";
import { tdxCalendarTradeDate, tdxLatestTradeDate } from "./tdx";

export type TradeDateSource = "tdx" | "tencent-kline" | "tdx-calendar" | "calendar";
export interface TradeDateInfo {
  date: string;
  source: TradeDateSource;
  /** 日期是行情源给的，还是本地日历算出来的 —— 前端据此决定能不能说"最新交易日" */
  fromMarketData: boolean;
}

// 上证指数（000001.SH → 腾讯 sh000001）日K最后一根的日期 = 行情源认的最近交易日。
// em.ts 里 fetchKlinesReal 的内部顺序是「通达信网关优先 → 腾讯兜底」，这里传 fq=none
// 直接走腾讯那条（日期与复权口径无关，且网关此刻可能没起，不白等一次超时）。
async function klineLatestTradeDate(): Promise<string | null> {
  try {
    const { fetchKlinesReal } = await import("./em");
    const rows = await fetchKlinesReal("000001.SH", "日线", 8, "none");
    const last = String(rows?.[rows.length - 1]?.date ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

export async function latestTradeDate(now = new Date()): Promise<string> {
  return (await resolveTradeDate(now)).date;
}

// 带来源的解析：调用方需要知道日期从哪来（P63 研报页的口径诚实化）。
// 两条行情源都不认"晚于本机今天"的返回值：源异常或时钟漂移时宁退回日历兜底。
export async function resolveTradeDate(now = new Date()): Promise<TradeDateInfo> {
  const today = shanghaiDate(now);
  // 「最新已完成交易日」的上界 cutoff：
  //   · 盘前（未开盘，含集合竞价前）：行情源会返回一根「今天」的 K，但那根是**未成交占位**
  //     （价格=昨收 / 0 成交），它不是「最近一个已收盘的交易日」——必须把上界退到昨天。
  //     2026-09-29 06:11 事故：sentiment 把 09-28 收盘数据标成 trade_date=2026-09-29
  //     （与 build-sector-snapshot 假交易日同源：数据源在盘中/盘前会吐一根"当日"未完成的 K）。
  //   · 已开盘（竞价/盘中/午休）与已收盘：今日 K 有意义（实时 / 当日已定稿），上界=今天。
  // 为什么是「退一天」而不是「退到上一交易日」：不退日历、不猜节假日——上界退一天后，
  // 行情源自己会给「≤ 上界」的真正上一根；两步都拿不到还有带节假日的通达信日历兜底。
  const openedToday = marketSession(now).label !== "未开盘";
  const cutoff = openedToday ? today : shanghaiDate(new Date(now.getTime() - 86_400_000));
  const read = async (p: Promise<string | null>) => {
    const d = await p.catch(() => null);
    return d && d <= cutoff ? d : null;
  };
  const fromTdx = await read(tdxLatestTradeDate());
  if (fromTdx) return { date: fromTdx, source: "tdx", fromMarketData: true };
  const fromKline = await read(klineLatestTradeDate());
  if (fromKline) return { date: fromKline, source: "tencent-kline", fromMarketData: true };
  // ③' 两条 K 线都拿不到时，先问通达信自带的交易日历（含法定节假日，见 tdx.ts 的实测注释）。
  // 它比 ③ 的「只认周末」强一档：2026-09-25 中秋那种日子，③ 会停在 09-25 并把休市日说成交易日。
  const fromCalendar = await read(tdxCalendarTradeDate(cutoff));
  if (fromCalendar) return { date: fromCalendar, source: "tdx-calendar", fromMarketData: true };
  return { date: prevWeekday(cutoff), source: "calendar", fromMarketData: false };
}
