"use client";
// P15-R16c 全站行情轮询：凡是页面上摆着股票实时数字的地方，都用这一个钩子定时重取。
//
// 为什么收成一个钩子：交易时段闸（休市时上游不会有新数据，白打接口也没用）+ 倒计时 + 取数时刻
// 这三件事，原来各页各写一遍，写漏一页那一页就变成「昨天下午的数挂着不刷新、还没时间」——
// 用户这一轮提的就是这个病。收成一个钩子后，新页面只要 `const { tick } = useLivePoll()`
// 并把 tick 加进取数 effect 的依赖，就自动带上「开盘才刷、休市暂停、剩余秒数、数据截至」。
import { useEffect, useState } from "react";
import { useDesk } from "@/lib/desk/store";
import { useMarketSession } from "@/hooks/use-market-session";

export interface LivePoll {
  /** 每到一个刷新周期 +1：取数 effect 把它放进依赖里就会跟着重取 */
  tick: number;
  /** 倒计时剩余秒数（休市时恒等于周期值，表示「暂停中」而不是停在一个难看的中间数上） */
  left: number;
  /** 当前是否处于 A 股交易时段（休市时轮询暂停） */
  open: boolean;
  sessionLabel: string;
}

export function useLivePoll(): LivePoll {
  const interval = useDesk((s) => s.refreshInterval);
  const session = useMarketSession();
  const [poll, setPoll] = useState({ tick: 0, left: interval });
  const open = session.open;

  useEffect(() => {
    if (!open) return; // 休市：不建计时器（恢复开盘时本 effect 会重跑）
    const t = setInterval(() => {
      // 一次 setState 同时推进倒计时与轮次：纯 updater，绝不在 setLeft 里套 setTick（那样重复调用会多跳一轮）
      setPoll((p) => (p.left > 1 ? { ...p, left: p.left - 1 } : { tick: p.tick + 1, left: interval }));
    }, 1000);
    return () => clearInterval(t);
  }, [open, interval]);

  return { tick: poll.tick, left: open ? poll.left : interval, open, sessionLabel: session.label };
}
