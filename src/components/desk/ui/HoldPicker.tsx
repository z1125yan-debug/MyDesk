"use client";
// 持仓小窗（标的 / 成本价 / 仓位 / 建仓日期）——与 ChatModeMenu / HorizonPicker 同一套画法。
//
// 为什么要有它：这四件事是**长期条件**，不是某一句的问题。
// 用户在「我持有 X，成本 C」那一句里填过一次成本，下一句「那现在要不要减」就还得重填一遍，
// 不填的话模型又退回「泛泛而谈」——这是上一轮报告里「AI 不考虑持股日期」的根因之一。
// 所以把它做成 composer 上的一个常驻小窗：填一次，之后每一轮都随请求带出去。
//
// 纪律：
//   · 清空按钮 = 真的清空（store 里落 null），之后每轮都不再注入持仓条件，不是"留着上次的值"；
//   · 建仓日期用原生 date 控件，认不出的形状由 hold-core.normalizeOpenDate 判空，不替用户修；
//   · 有值时触发按钮上带一枚绿点，用户一眼看得出「这轮会带上持仓」。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Wallet, ChevronDown } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { normalizeOpenDate, type HoldCtx } from "@/lib/desk/hold-core";

const FIELD_ROWS: { key: keyof HoldCtx; label: string; placeholder: string; type: "text" | "date" }[] = [
  { key: "symbol", label: "标的（名称或 6 位代码）", placeholder: "例如：伟创电气 / 688698", type: "text" },
  { key: "cost", label: "成本价（选填）", placeholder: "例如：23.80", type: "text" },
  { key: "position", label: "仓位占比（选填）", placeholder: "例如：2 成 / 总仓位的 20%", type: "text" },
  { key: "openDate", label: "建仓日期（选填）", placeholder: "", type: "date" },
];

export default function HoldPicker({ disabled = false }: { disabled?: boolean }) {
  const hold = useDesk((s) => s.holdCtx);
  const setHoldCtx = useDesk((s) => s.setHoldCtx);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);

  // 弹窗里的草稿：打开时从 store 兜过来，点「保存」才写回。
  // 不做「边填边写」——那样取消关窗就等于改了全局设置。
  const [draft, setDraft] = useState<HoldCtx>({});

  useLayoutEffect(() => {
    if (!open) return;
    setDraft({ symbol: "", cost: "", position: "", openDate: "", ...(hold ?? {}) });
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const PANEL_H = 300;
    const spaceBelow = window.innerHeight - r.bottom;
    setRect({ top: spaceBelow < PANEL_H + 12 ? r.top - PANEL_H - 8 : r.bottom + 8, left: r.left });
  }, [open, hold]);

  // 与 ChatModeMenu 同一套关闭逻辑：点外面 / Esc / 滚动都关
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

  const filled = !!hold && Object.keys(hold).length > 0;

  const save = () => {
    const out: HoldCtx = {};
    for (const f of FIELD_ROWS) {
      const raw = String(draft[f.key] ?? "").trim();
      if (!raw) continue;
      // 建仓日期只认 YYYY-MM-DD；其余字段原样带（成本可能是「23.8 元」这种，清洗交给服务端）
      out[f.key] = f.key === "openDate" ? normalizeOpenDate(raw) : raw;
    }
    setHoldCtx(Object.keys(out).length ? out : null);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="填一次持仓（标的/成本/仓位/建仓日期），之后每轮都按它回答"
        className="flex items-center gap-1.5 rounded-full bg-overlay-strong px-3.5 py-2 text-[14px] text-foreground/90 transition-colors hover:bg-overlay-strong disabled:opacity-50"
      >
        <Wallet size={14} />
        持仓
        {/* 有值时挂一枚绿点：用户发之前就能确认「这轮会带上我的成本与建仓日期」 */}
        {filled && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
        <ChevronDown size={13} />
      </button>
      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" aria-hidden />
          <div
            ref={panelRef}
            className="fixed z-[101] w-[300px] rounded-2xl border border-border bg-popover p-3 shadow-2xl"
            style={{ top: rect.top, left: rect.left }}
          >
            <div className="mb-2 text-[13.5px] font-medium">我的持仓</div>
            <div className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
              填一次，之后每一轮都带上。成本只用来描述位置，不会当成卖点。
            </div>
            <div className="space-y-2">
              {FIELD_ROWS.map((f) => (
                <div key={f.key}>
                  <div className="mb-1 text-[12px] text-muted-foreground">{f.label}</div>
                  <input
                    type={f.type}
                    value={String(draft[f.key] ?? "")}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[14px] outline-none placeholder:text-muted-foreground/50 hover:border-sky-400/40 focus:border-sky-400/40"
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                onClick={() => { setHoldCtx(null); setOpen(false); }}
                className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              >
                清空
              </button>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">
                  取消
                </button>
                <button onClick={save} className="apple-primary-btn rounded-lg px-3.5 py-1.5 text-[13px]">
                  保存
                </button>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}
