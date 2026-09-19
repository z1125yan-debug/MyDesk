"use client";
import { useEffect, useState } from "react";
import { marketSession, type MarketSession } from "@/lib/desk/session";

// 每 15 秒重估一次交易时段，供各页面暂停/恢复实时轮询
export function useMarketSession(): MarketSession {
  const [session, setSession] = useState<MarketSession>(() => marketSession());
  useEffect(() => {
    const t = setInterval(() => setSession(marketSession()), 15000);
    return () => clearInterval(t);
  }, []);
  return session;
}
