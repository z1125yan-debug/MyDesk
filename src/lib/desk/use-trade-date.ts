"use client";
// 最近交易日 · 前端单一出处
//
// 为什么需要：服务器时钟不等于交易日。休市日（周末/法定节假日）拿 new Date() 当数据日，
// 页面就会显示一个从没开过盘的日期，读者以为那是当天行情（用户实测：9/27 看到"9/27 的数据"）。
// 真值在 /api/market/trade-date：行情源日K给的最近交易日（节假日自动识别，不会误伤正常开盘日）。
//
// 单例 + 60s 缓存：一个页面可能有 5 处要显示日期，不能每处都打一次接口；
// 多个组件同时挂载时也只发一个请求（inflight 合并）。

import { useEffect, useState } from "react";

export interface TradeDateState {
  /** 服务器当天（上海时区） */
  today: string;
  /** 最近交易日：休市日停在上一个交易日 */
  tradeDate: string;
  isTradingToday: boolean;
  /** 日期来自行情源（true）还是本地日历兜底（false） */
  fromMarketData: boolean;
  loading: boolean;
}

let cache: { at: number; data: TradeDateState } | null = null;
let inflight: Promise<TradeDateState> | null = null;
const TTL = 60_000;

async function load(): Promise<TradeDateState> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  if (inflight) return inflight;
  inflight = fetch("/api/market/trade-date", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { today?: string; tradeDate?: string; isTradingToday?: boolean; fromMarketData?: boolean }) => {
      const today = String(j.today ?? "");
      const data: TradeDateState = {
        today,
        tradeDate: String(j.tradeDate ?? today),
        isTradingToday: !!j.isTradingToday,
        fromMarketData: j.fromMarketData !== false,
        loading: false,
      };
      cache = { at: Date.now(), data };
      return data;
    })
    .catch(() => ({ today: "", tradeDate: "", isTradingToday: false, fromMarketData: false, loading: false }))
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * 最近交易日。loading 期间 tradeDate 为空 —— 调用方在拿到真值前不要显示任何日期，
 * 不能先用 new Date() 顶上（那就是把时钟当交易日，正是要修的那个谎）。
 */
export function useTradeDate(): TradeDateState {
  const [st, setSt] = useState<TradeDateState>(() => ({
    today: "", tradeDate: "", isTradingToday: false, fromMarketData: false, loading: true,
  }));
  useEffect(() => {
    let alive = true;
    void load().then((d) => { if (alive) setSt(d); });
    return () => { alive = false; };
  }, []);
  return st;
}

/** 一次性取最近交易日（非组件场景） */
export async function getTradeDate(): Promise<string> {
  const d = await load();
  return d.tradeDate || d.today;
}

/** "2026-09-24" → "9/24"（给用户看的短格式：截止 9/24） */
export function shortDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? "");
  return m ? `${Number(m[2])}/${m[3]}` : d ?? "";
}
