"use client";
import { useCallback, useMemo, useRef } from "react";

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
  // 返回对象必须跨渲染保持同一引用：五个消费页都把 guard 写进 load 的 useCallback 依赖、
  // 又把 load 写进 useEffect 依赖——若每次渲染都新建对象，load 每次渲染都变新，
  // effect 每次渲染后都重跑，load 里的 setData(null)/setBusy 又触发渲染，形成自激循环
  // （画像页表现：一打开就闪屏、内容区永远落不了地）。token/alive 本身已是稳定回调，
  // 这里只需把外层对象 memo 住。
  return useMemo(() => ({ token, alive }), [token, alive]);
}
