"use client";
// 持仓周期选择器（P11，对齐参考站 composer 的 horizon radio）：短线/中线/长线三态小分段控件。
//
// 与 ChatModeMenu 同一套纪律：清单与口径句的唯一定义处是 @/lib/desk/modes
// （CHAT_HORIZONS 画界面、HORIZON_NOTES 进提示词），选中值存 store.assistantHorizon，
// 发送那一刻由 use-chat 现读——界面显示的和这轮真正带出去的是同一个值。
// 默认「未选」而不是任何周期：没选过的人不该被冒充成短线客；再点一次已选项即清回未选。
import { CHAT_HORIZONS } from "@/lib/desk/modes";
import { useDesk } from "@/lib/desk/store";

export default function HorizonPicker({ disabled = false }: { disabled?: boolean }) {
  const horizon = useDesk((s) => s.assistantHorizon);
  const setHorizon = useDesk((s) => s.setAssistantHorizon);
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-overlay px-1.5 py-1">
      <span className="px-1.5 text-[12px] text-muted-foreground">周期</span>
      {CHAT_HORIZONS.map((h) => {
        const active = horizon === h.key;
        return (
          <button
            key={h.key}
            type="button"
            disabled={disabled}
            title={h.desc + "（再点一次清回未选）"}
            onClick={() => setHorizon(active ? null : h.key)}
            className={
              "rounded-full px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50 " +
              (active ? "bg-sky-400/15 font-medium text-sky-200" : "text-muted-foreground hover:text-foreground")
            }
          >
            {h.label}
          </button>
        );
      })}
    </div>
  );
}
