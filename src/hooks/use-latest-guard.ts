"use client";
import { useCallback, useRef } from "react";

/**
 * 参数切换类异步 setState 的统一时序守卫（P67 体检 #3）。
 *
 * 背景：`load` 里 `await fetch(...)` 之后直接 setState，用户快速切换参数（股票/板块/日期/周期）时
 * 慢的旧响应后到，会覆盖新参数的状态——页面标题是 A、数字是 B。P41 给 ScreenerWorkbench 修过同款
 * （单调序号守卫），但 QuotesPage/ProfilePage/SectorsPage/SectorTopPage/EventsPage 五处同病漏网。
 *
 * 用法：
 *   const guard = useLatestGuard();
 *   const load = async () => {
 *     const t = guard.token();
 *     const r = await fetch(...);
 *     if (!guard.alive(t)) return;   // 已有更新的请求发起，本响应作废
 *     setState(...);
 *   };
 *
 * 为什么不是 AbortController：fetch 可中断，但「解析后写状态前」仍有窗口，且有的调用链
 * 不走 fetch（直接函数返回）；序号守卫对一切 async 生效，也是 P41 已验证的方案。
 */
export function useLatestGuard() {
  const seq = useRef(0);
  const token = useCallback((): number => ++seq.current, []);
  const alive = useCallback((t: number): boolean => t === seq.current, []);
  return { token, alive };
}
