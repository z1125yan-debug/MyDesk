"use client";
// 回答风格菜单：首页大输入框与对话页 composer 共用的唯一画法。
//
// 为什么抽在这里：清单与文案的唯一定义处是 @/lib/desk/modes（CHAT_MODES 画界面、
// MODE_NOTES 进提示词，同源不漂）；选中值存 store.assistantMode，发送那一刻由 use-chat
// 现读——「首页选的」和「这一轮真正带出去的」必是同一个值（P8 风格轮口径逐字延续）。
// 画法对齐参考站的 composer 内嵌 mode-selector：对话页不再需要顶栏 chip 条，
// 但选择器必须长在输入框边上——从导航直接进对话页的人也要能换风格。
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CHAT_MODES, chatModeLabel } from "@/lib/desk/modes";
import { useDesk } from "@/lib/desk/store";

export default function ChatModeMenu({ disabled = false }: { disabled?: boolean }) {
  const mode = useDesk((s) => s.assistantMode);
  const setMode = useDesk((s) => s.setAssistantMode);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 py-2 text-[13px] text-foreground/90 transition-colors hover:bg-white/[0.1] disabled:opacity-50"
      >
        {chatModeLabel(mode)} <ChevronDown size={13} />
      </button>
      {open && (
        <div className="apple-card absolute left-0 top-12 z-20 w-60 p-1.5 shadow-2xl">
          {CHAT_MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => { setMode(m.key); setOpen(false); }}
              className={"block w-full rounded-xl px-3.5 py-2.5 text-left hover:bg-white/[0.05] " + (m.key === mode ? "text-sky-200" : "")}
            >
              <div className="text-[13.5px] font-medium">{m.label}</div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">{m.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
