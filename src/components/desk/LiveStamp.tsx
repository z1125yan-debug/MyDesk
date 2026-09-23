"use client";
// P15-R16c 行情页共用的「活体戳」：一行话说清三件事——现在是开盘还是休市、下一轮还有几秒、
// 屏幕上这批数是几点几分取到的。
//
// 为什么单独一个组件：用户这轮的原话是「这上面也没有时间，都分不清是哪天的」。时间戳散在各页
// 各写一遍，迟早有人漏写；收成一个组件后，接了轮询的页面必须连着把时刻也摆上屏。
import type { ReactNode } from "react";
import { clockZh } from "@/lib/desk/plain-core";
import type { LivePoll } from "@/hooks/use-live-poll";

export default function LiveStamp({ poll, iso, prefix }: { poll: LivePoll; iso: string; prefix?: ReactNode }) {
  const stamp = clockZh(iso);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {prefix}
      {!poll.open && (
        <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[12px] text-amber-300">
          A股{poll.sessionLabel} · 自动刷新已暂停
        </span>
      )}
      <span className="rounded-md border border-border px-2.5 py-1 font-mono text-[12px] text-muted-foreground">
        刷新 #{poll.tick} · 剩余 {poll.left}s
      </span>
      <span className="rounded-md border border-border px-2.5 py-1 font-mono text-[12px] text-muted-foreground">
        {stamp ? `数据截至 ${stamp}` : "本次未取到数据"}
      </span>
    </div>
  );
}
