"use client";
import { useEffect, useState } from "react";
import { marketSession, type MarketSession } from "@/lib/desk/session";
import { useTradeDate } from "@/lib/desk/use-trade-date";

// 每 15 秒重估一次交易时段，供各页面暂停/恢复实时轮询
export function useMarketSession(): MarketSession {
  const [session, setSession] = useState<MarketSession>(() => marketSession());
  const td = useTradeDate();
  useEffect(() => {
    const t = setInterval(() => setSession(marketSession()), 15000);
    return () => clearInterval(t);
  }, []);

  // 法定节假日闸（2026-10-01 体检实测：国庆 09:30 全站「开盘自动刷新」空轮询，顶栏却挂着「今天不交易」）。
  // marketSession 只认星期几+钟点，认不出「工作日但休市」；交易日真值来自行情源（/api/market/trade-date）。
  // ① 行情源真值说「今天不是交易日」→ 强制休市；
  // ② 行情源探测失败、只剩日历兜底（fromMarketData=false）时，「开盘」没有行情源背书——
  //    日历认不出法定节假日，此时宁可暂停轮询也不冒充实时（错的方向必须是「漏刷」而不是「假实时」）。
  if (!td.loading && td.fromMarketData && td.isTradingToday === false) {
    return { ...session, open: false, phase: "closed", label: "今日休市" };
  }
  if (!td.loading && !td.fromMarketData && session.open) {
    return { ...session, open: false, phase: "closed", label: "今日休市" };
  }
  return session;
}
