"use client";
// 追问推荐芯片（稳智 follow_up_suggestions 的本地画法）——一处画法，两个入口共用。
//
// 为什么单独成组件：对话页（AssistantPage）与小窗（AssistantWidget）画的是同一条回答的尾巴，
// 各自抄一份就会出现「窗外有推荐、窗内没有」或点一颗芯片在两处行为不同。
// 解析规则在 @/lib/desk/followups-core（纯层），这里只负责「有就画、没有就一个字都不画」。
//
// 稳智口径：推荐是 3 颗短问句，点了直接发问，不进输入框让用户再改。
// 本组件照此办理：onAsk 拿到的就是那句原文（不预填输入框，少一步操作）。
import { splitFollowUps } from "@/lib/desk/followups-core";

export default function FollowUpChips({ content, streaming, onAsk }: {
  content: string;
  streaming?: boolean;
  /** 点一颗 = 直接问这一句（走各入口自己的发送路径） */
  onAsk: (question: string) => void;
}) {
  // 流式途中不画：那一轮正文还在长，模型可能刚吐到「【追问」，芯片先闪出来再消失比不画更差
  if (streaming) return null;
  const { suggestions } = splitFollowUps(content);
  if (suggestions.length < 2) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label="追问推荐">
      {suggestions.map((s) => (
        <button key={s.text} onClick={() => onAsk(s.send)}
          className="rounded-full border border-border/60 px-2.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:border-sky-400/40 hover:text-sky-200">
          {s.text}
        </button>
      ))}
    </div>
  );
}
