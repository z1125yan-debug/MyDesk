// 服务端专用：节假日感知的交易日/交易时段判定。本文件只应被服务端代码（API 路由、服务端 lib）引用，
// 禁止被 Client Component 直接或间接 import（顶部 server-only 会在客户端打包时直接报错）。
// 原因：下面的逻辑需要 resolveTradeDate（来自 trade-date.ts，依赖 fs 读本地交易日缓存 +
// 拉通达信日K），一旦进客户端包就会 "Can't resolve 'fs'"。客户端只需用 session.ts 里的纯函数
//（marketSession / shanghaiDate / prevWeekday / shanghaiStamp），不要引本文件。
import "server-only";

import { marketSession, shanghaiDate } from "./session";
import { resolveTradeDate } from "./trade-date";

export type SessionPhase = "trading" | "auction" | "break" | "closed";

export interface MarketSession {
  open: boolean;
  phase: SessionPhase;
  label: string;
}

// ---------- 节假日闸（服务端）：marketSession 只认工作日 + 时段，不认法定节假日，
// 于是「国庆周三上午」这种会被误判为 open / trading，把上一交易日的旧数据当成实时（冒充实时）。
// 纠正办法：用交易日历判定「今天是不是交易日」（resolveTradeDate 已含通达信法定节假日日历），
// 交易时段内若今天并非交易日，仍判休市。 ----------
let tradingDayFlag: { date: string; isTradingDay: boolean; at: number } | null = null;

async function computeIsTradingDay(now: Date): Promise<boolean> {
  // 今天是不是交易日 ⟺ 行情源认的最近交易日 == 今天（resolveTradeDate 已带法定节假日日历，不靠猜）。
  const info = await resolveTradeDate(now).catch(() => null);
  const today = shanghaiDate(now);
  return !!info && info.date === today && info.fromMarketData;
}

/** 异步纠正「今天是不是交易日」（含法定节假日）。算不出来时保守按工作日处理，不误关正常交易日。 */
export async function refreshTradingDayFlag(now = new Date()): Promise<boolean> {
  const today = shanghaiDate(now);
  if (tradingDayFlag && tradingDayFlag.date === today && Date.now() - tradingDayFlag.at < 3_600_000) {
    return tradingDayFlag.isTradingDay;
  }
  const v = await computeIsTradingDay(now).catch(() => null);
  const sh = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const weekday = sh.getDay() !== 0 && sh.getDay() !== 6;
  tradingDayFlag = { date: today, isTradingDay: v ?? weekday, at: Date.now() };
  return tradingDayFlag.isTradingDay;
}

/** 同步判断今天是不是交易日：没算过 / 跨天时先用「工作日」乐观判定，并后台补算纠正节假日。 */
export function todayIsTradingDaySync(now = new Date()): boolean {
  const today = shanghaiDate(now);
  if (!tradingDayFlag || tradingDayFlag.date !== today) {
    const sh = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const weekday = sh.getDay() !== 0 && sh.getDay() !== 6;
    tradingDayFlag = { date: today, isTradingDay: weekday, at: Date.now() };
    void refreshTradingDayFlag(now); // 后台纠正：节假日会把 flag 改成 false
  }
  return tradingDayFlag.isTradingDay;
}

/** 服务端用的节假日感知交易时段：交易时段内若今天不是交易日（法定节假日），仍判休市，杜绝冒充实时。 */
export function marketSessionHolidayAware(now = new Date()): MarketSession {
  const s = marketSession(now);
  if (s.open && !todayIsTradingDaySync(now)) {
    return { open: false, phase: "closed", label: "休市（节假日）" };
  }
  return s;
}
