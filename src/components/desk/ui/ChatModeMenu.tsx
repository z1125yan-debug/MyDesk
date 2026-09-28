"use client";
// 回答风格菜单：首页大输入框与对话页 composer 共用的唯一画法。
//
// 为什么抽在这里：清单与文案的唯一定义处是 @/lib/desk/modes（CHAT_MODES 画界面、
// MODE_NOTES 进提示词，同源不漂）；选中值存 store.assistantMode，发送那一刻由 use-chat
// 现读——「首页选的」和「这一轮真正带出去的」必是同一个值（P8 风格轮口径逐字延续）。
// 画法对齐参考站的 composer 内嵌 mode-selector：对话页不再需要顶栏 chip 条，
// 但选择器必须长在输入框边上——从导航直接进对话页的人也要能换风格。
//
// P18 稳智对齐（2026-09-23 用户「上面的都选不到，点到那里选不到直接选下面去了」）：
// 旧版用 absolute + z-20 挂在触发按钮下的 relative 容器里，Dropdown 浮层在父容器
// stacking context 内有效，被 AssistantPage 外层 flex 的兄弟元素（消息流 / 建议卡片 /
// 输入框）拦截点击——「看得到但点不到」。改用 fixed 定位 + createPortal 挂到 body，
// 与父容器解耦，永远在最顶层。同时监听「点外面关闭」与 Escape，交互习惯补齐。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { CHAT_MODES, chatModeLabel } from "@/lib/desk/modes";
import { useDesk } from "@/lib/desk/store";

/** 浮层宽度：右对齐时的左偏移与面板宽度共用同一个值，避免两处各写一个 240 而漂移 */
const PANEL_W = 240;

export default function ChatModeMenu({ disabled = false, align = "left" as "left" | "right" }: { disabled?: boolean; align?: "left" | "right" }) {
  const mode = useDesk((s) => s.assistantMode);
  const setMode = useDesk((s) => s.setAssistantMode);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 打开时取触发按钮位置，浮层用 fixed 定位。
  // R20：面板高度不再硬编码（旧版那个 212 是「4 项 × 48px」的估算常量，
  // 把 desc 从半句补成一整句说明后估算就不准了，按钮贴底时会翻错方向、露出屏幕外）。
  // 现在第一遍先按下沿放，第二遍（下面的 effect）拿真实 offsetHeight 校正。
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    setPos({ top: r.bottom + 8, left: align === "left" ? r.left : r.right - PANEL_W });
  }, [open, align]);

  // 第二遍：面板真实挂上后量一次，下方放不下就翻到按钮上方（并夹在视口内）
  useLayoutEffect(() => {
    if (!open || !anchor || !panelRef.current) return;
    const h = panelRef.current.offsetHeight;
    const below = anchor.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, anchor.top - h - 8) : below;
    setPos((p) => (p && p.top === top ? p : { left: p?.left ?? (align === "left" ? anchor.left : anchor.right - PANEL_W), top }));
  }, [open, anchor, align]);

  // 点外面关闭 + Escape 关闭 + 滚动时关闭（避免 fixed 位置错乱）
  // P18 修正：mousedown 阶段判定"目标是不是面板内"——否则浮层内的按钮会在
  // 同一 mousedown 里被 setOpen(false) 抢先卸载，click 事件根本到不了按钮，
  // 表现为"下拉是透明的、点不到、只能点到下面"。遮罩只用于吃外部点击，
  // 浮层内部点任何位置都不触发关闭。
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full bg-overlay-strong px-3.5 py-2 text-[14px] text-foreground/90 transition-colors hover:bg-overlay-strong disabled:opacity-50"
      >
        {chatModeLabel(mode)}
        {/* 稳智同款：选到「深度思考」时右侧挂一枚 .mode-thinking-chip 小胶囊，一眼看出深度思考已开 */}
        {mode === "deep" && <span className="mode-thinking-chip" title="深度思考已开启">深度</span>}
        <ChevronDown size={13} />
      </button>
      {open && pos && createPortal(
        <>
          {/* 透明全屏遮罩，兜住「点外面」事件——不用 z-index 打架，直接盖住整个视口 */}
          <div className="fixed inset-0 z-[100]" aria-hidden />
          {/* 实际浮层：z-[101] 高于遮罩，永远在视口最顶 */}
          <div
            ref={panelRef}
            className="fixed z-[101] rounded-2xl border border-border bg-popover p-1.5 shadow-2xl"
            style={{ top: pos.top, left: pos.left, width: PANEL_W, maxHeight: "calc(100vh - 24px)", overflowY: "auto" }}
          >
            {CHAT_MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => { setMode(m.key); setOpen(false); }}
                className={"block w-full rounded-xl px-3.5 py-2.5 text-left hover:bg-overlay-strong " + (m.key === mode ? "text-sky-200" : "")}
              >
                <div className="text-[14.5px] font-medium">{m.label}</div>
                <div className="mt-0.5 text-[12.5px] text-muted-foreground">{m.desc}</div>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  );
}
