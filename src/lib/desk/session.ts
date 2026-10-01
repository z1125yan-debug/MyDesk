// A股交易时段判断（北京时间）：周一至周五 09:30-11:30 / 13:00-15:00，09:15-09:25 为集合竞价。
// 仅按常规时段判断，不含法定节假日表——节假日数据源本身不会有新数据，
// 客户端会显示休市状态并暂停轮询，服务端缓存也会自动延长。

export type SessionPhase = "trading" | "auction" | "break" | "closed";

export interface MarketSession {
  open: boolean;      // 连续交易中（可拉实时数据）
  phase: SessionPhase;
  label: string;      // 界面显示文案
}

export function marketSession(now = new Date()): MarketSession {
  // 折算到北京时间再取时/分/星期
  const sh = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const day = sh.getDay();
  if (day === 0 || day === 6) return { open: false, phase: "closed", label: "周末休市" };
  const hm = sh.getHours() * 60 + sh.getMinutes();
  if (hm >= 9 * 60 + 15 && hm < 9 * 60 + 30) return { open: false, phase: "auction", label: "集合竞价" };
  if (hm >= 9 * 60 + 30 && hm < 11 * 60 + 30) return { open: true, phase: "trading", label: "交易中" };
  if (hm >= 11 * 60 + 30 && hm < 13 * 60) return { open: false, phase: "break", label: "午间休市" };
  if (hm >= 13 * 60 && hm < 15 * 60) return { open: true, phase: "trading", label: "交易中" };
  return { open: false, phase: "closed", label: hm < 9 * 60 + 15 ? "未开盘" : "已收盘" };
}

// ---------- 节假日闸（服务端）：marketSession 只认工作日 + 时段，不认法定节假日，
// 于是「国庆周三上午」这种会被误判为 open / trading，把上一交易日的旧数据当成实时（冒充实时）。
// 纠正办法：用交易日历判定「今天是不是交易日」（resolveTradeDate 已含通达信法定节假日日历），
// 交易时段内若今天并非交易日，仍判休市。 ----------
let tradingDayFlag: { date: string; isTradingDay: boolean; at: number } | null = null;

async function computeIsTradingDay(now: Date): Promise<boolean> {
  // 今天是不是交易日 ⟺ 行情源认的最近交易日 == 今天（resolveTradeDate 已带法定节假日日历，不靠猜）。
  const { resolveTradeDate } = await import("./trade-date");
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

// 北京时间日期/时间（YYYY-MM-DD / HH:mm:ss）。
// 注意：不能用 toISOString()——它是 UTC，北京凌晨会退回前一天。
export function shanghaiDate(now = new Date()): string {
  return beijingParts(now).date;
}

// 「最近交易日」的日历兜底（纯函数）：周末回退到最近的周五，工作日原样返回。
// ⚠️ 只认周末，**不认法定节假日**（2026-09-25 中秋这种它不知道）——
// 真值由行情源给（`trade-date.ts` 先问通达信上证指数日K），这里只在行情源拿不到时兜底。
export function prevWeekday(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr; // 形状不对就原样透传，不猜
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // 0=周日 6=周六：周日退 2 天、周六退 1 天，落回周五
  const back = d.getUTCDay() === 0 ? 2 : d.getUTCDay() === 6 ? 1 : 0;
  if (!back) return dateStr;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function shanghaiStamp(now = new Date()): string {
  const p = beijingParts(now);
  return `${p.date} ${p.time}`;
}

function beijingParts(now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}:${get("second")}`,
  };
}
