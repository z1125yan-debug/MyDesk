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

// 北京时间日期/时间（YYYY-MM-DD / HH:mm:ss）。
// 注意：不能用 toISOString()——它是 UTC，北京凌晨会退回前一天。
export function shanghaiDate(now = new Date()): string {
  return beijingParts(now).date;
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
