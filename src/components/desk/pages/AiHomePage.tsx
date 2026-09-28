"use client";
// AI 分析落地页（2026-09-26 用户拍板：点「AI分析」先落这里，不再一点击直接进对话）。
//
// 版面 + 文案 + 问句模板全部对齐稳智 /ai-matrix 落地页（源码实证：AiMatrixHome-*.js）。
//   · 居中大标题「向稳智AI提问」→ 本地「向 Kairo 提问」；
//   · 大输入框左嵌「决策模式」下拉 —— 本地复用共享 ChatModeMenu（清单与稳智同为
//     决策模式/研判模式/深度思考/实时搜索，唯一定义处 @/lib/desk/modes）；
//   · 下方两列「快捷提问卡」= 稳智 Ki 数组那 8 张。
//
// P58 收口：本页原来自己抄了一份 QUICK_CARDS（字段名、周期选项、拼装函数都是本地一套），
// 与对话页那八张卡是同一件事的两份实现——改一处另一处不会跟着动，迟早漂。
// 现在 8 卡的条件字段、校验语、拼装函数统一在 @/lib/desk/suggestion-cards-core，
// 参数窗统一在 ../ui/SuggestionCardDialog，本页只留版式与「交问句给对话页」这一根线。
// 问句一律交 askInAssistant（→ store.pendingAsk → copilot 对话页），本页不发请求、不画会话。
//
// 纪律（p7-dispatch「纯入口」pin 钉死）：模式读写只走共享 ChatModeMenu，本页不碰 store 的模式键。
// （P58 例外说明：场景卡自带 chatMode，点卡即换风格是稳智语义的一部分，这一处直接写 store。）
import { useState } from "react";
import { Send } from "lucide-react";
import ChatModeMenu from "../ui/ChatModeMenu";
import HoldPicker from "../ui/HoldPicker";
import SuggestionCardDialog from "../ui/SuggestionCardDialog";
import { useDesk } from "@/lib/desk/store";
import { aiReady } from "@/lib/desk/ai";
import {
  cardTitle, directDispatch, needsDialog,
  type CardDispatch, type SuggestionCard,
} from "@/lib/desk/suggestion-cards-core";
// 「当前模式该展示哪 8 张」不在卡片 core 里，是另一件事（见该文件注释）
import { cardsForMode } from "@/lib/desk/mode-cards";
import type { ChatHorizon } from "@/lib/desk/modes";

/** 卡面图标（页面装饰，不进 core：core 管条件与文案，不管这里画什么）
 *  R20：八张卡现在随模式换（cardsForMode 从 15 张全池里取），所以这里要给满 15 个，
 *  否则换到研判/深度/搜索模式时新露面的卡会掉成 ❓。 */
const CARD_EMOJI: Record<string, string> = {
  七维分析一只股票: "🧭",
  按成本制定持仓计划: "📌",
  判断现在能否买入: "🎯",
  对比多只股票强弱: "⚖️",
  分析板块当前阶段: "🔍",
  判断今日仓位策略: "📊",
  筛选持续流入板块: "🔥",
  制定股票交易计划: "🧩",
  持仓先拿还是减: "🧺",
  回踩低吸判断: "🧲",
  接飞刀还是回踩: "🪂",
  回踩均线还能吸吗: "📉",
  现价还能不能参与: "🚦",
  跌破均线怎么办: "⚠️",
  超短轻仓试错: "⚡",
};

export default function AiHomePage() {
  const ai = useDesk((s) => s.ai);
  const go = useDesk((s) => s.go);
  const askInAssistant = useDesk((s) => s.askInAssistant);
  // 只读不写：卡片栏跟着当前模式换一批（cardsForMode），写仍然只走 ChatModeMenu。
  const assistantMode = useDesk((s) => s.assistantMode);
  const [input, setInput] = useState("");
  /** 正在填参数的卡片（null=没弹表单）；直发卡不经过这里 */
  const [filling, setFilling] = useState<SuggestionCard | null>(null);

  const submit = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setInput("");
    askInAssistant(q);
  };

  /** direct 卡整句直发；带 mode 的卡先开参数窗，取消就一个字都不发（稳智语义） */
  const openCard = (c: SuggestionCard) => {
    if (needsDialog(c)) { setFilling(c); return; }
    const d = directDispatch(c);
    if (!d.prompt) return;
    useDesk.getState().setAssistantMode(c.chatMode);
    submit(d.prompt);
  };

  /** 弹窗确认：条件写进 store（对话页 composer 的 chip 会跟着变，用户看得见换了条件），再交问句 */
  const onCardSend = (d: CardDispatch, horizon: ChatHorizon | null) => {
    setFilling(null);
    useDesk.getState().setAssistantMode(d.chatMode);
    if (horizon) useDesk.getState().setAssistantHorizon(horizon);
    // 持仓卡填出的成本/仓位/建仓日期写回 store：问句交到对话页后，那边的 composer 小窗会显示同一份，
    // 用户追问时还在（不写回的话，跳页之后持仓条件就丢了）。
    if (d.hold && (d.hold.cost || d.hold.position || d.hold.openDate)) useDesk.getState().setHoldCtx(d.hold);
    submit(d.prompt);
  };

  return (
    <div className="flex h-full w-full flex-col px-6">
      <div className="flex flex-1 flex-col justify-center py-8">
        {/* 居中大标题（对齐稳智落地页） */}
        <h1 className="text-center text-[39px] font-semibold leading-tight tracking-tight">向 Kairo 提问</h1>

        {/* 大输入框：左嵌共享「决策模式」下拉 + 占位符 + 发送（对齐稳智 composer） */}
        <div className="apple-card apple-fade-in mt-8 p-2 shadow-2xl">
          <div className="flex items-center gap-2 px-2 pt-1">
            <ChatModeMenu />
            {/* 持仓（标的/成本/仓位/建仓日期）：在落地页填也行，交到对话页后继续生效 */}
            <HoldPicker />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }}
              placeholder="输入股票代码、板块或您的投资疑问…"
              className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-[16px] outline-none placeholder:text-muted-foreground/50"
            />
            <button onClick={() => submit()} disabled={!input.trim()} className="apple-primary-btn flex h-10 w-10 items-center justify-center">
              <Send size={16} />
            </button>
          </div>
        </div>

        {!aiReady(ai) && (
          <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3.5 py-2.5 text-[14px] text-amber-200">
            还没配置 AI 模型。<button onClick={() => go("settings")} className="ml-1 underline">去设置</button>
          </div>
        )}

        {/* 快捷提问卡（两列网格，稳智 Ki 那 8 张）：direct 卡直接发，其余先开参数窗补条件 */}
        <div className="apple-stagger mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {cardsForMode(assistantMode).map((c) => (
            <button key={c.label} onClick={() => openCard(c)}
              title={cardTitle(c)}
              className="flex items-center gap-3 rounded-xl border border-border/70 bg-overlay px-4 py-3 text-left text-[14.5px] text-muted-foreground transition-all hover:border-sky-400/30 hover:text-sky-200">
              <span className="text-[16px]" aria-hidden>{CARD_EMOJI[c.label] ?? "❓"}</span>
              <span className="min-w-0 flex-1">{c.label}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground/50">{needsDialog(c) ? "补条件" : "直发"}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 参数窗与对话页共用同一个组件：取消/关闭一个字都不发，确认才拼问句交出去 */}
      {filling && (
        <SuggestionCardDialog card={filling} onClose={() => setFilling(null)} onSend={onCardSend} />
      )}
    </div>
  );
}
