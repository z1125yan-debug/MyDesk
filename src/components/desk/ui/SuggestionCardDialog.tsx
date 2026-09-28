"use client";
// P58 稳智「试试这样问」参数窗（对齐 aiwuchuan.com AiMatrixHome 的 $prompt 弹窗）。
//
// 稳智那张窗的三条行为纪律，这里逐条照做：
//   1. 取消 / Esc / 点遮罩 → 返回 null → **什么都不发**（不是"发个默认问句"）；
//   2. 必填项没填 → warning 说清缺哪一项，**窗留着、不关闭、不发送**（稳智 beforeClose 同逻辑）；
//   3. 确认按钮文案由卡自己给（多股卡是「开始分析」，其余是「生成并发送」）。
//
// 唯一定义处是 @/lib/desk/suggestion-cards-core：字段清单、校验语、拼装函数都在那里，
// 本组件只负责把一份 CardFieldKey 表单渲染出来、把值交回 core 校验与拼装。
// AiHomePage 与 AssistantPage 共用这一个组件，避免两处各抄一套又漂开。
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  CARD_ACTIONS, CARD_HORIZONS, CARD_MAS,
  dialogDispatch, fieldsOf, initialFormState, validateCard, toCardInput,
  type CardDispatch, type CardFieldKey, type SuggestionCard,
} from "@/lib/desk/suggestion-cards-core";
import type { ChatHorizon } from "@/lib/desk/modes";

export default function SuggestionCardDialog({
  card, onClose, onSend,
}: {
  card: SuggestionCard;
  onClose: () => void;
  /** 校验通过才调这里；第二个参数是这一轮该写回 store 的周期（null = 不动用户的选择） */
  onSend: (dispatch: CardDispatch, horizon: ChatHorizon | null) => void;
}) {
  const [form, setForm] = useState<Record<CardFieldKey, string>>(() => initialFormState(card));
  const [err, setErr] = useState("");
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 焦点给第一个输入框：稳智那些窗第一个 el-input 都带 autofocus
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  // Esc 关窗（= 取消，不发）。稳智 closeOnPressEscape:true 就是这个行为。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (k: CardFieldKey, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    // 一改就清掉上一次的报错：留着会让人以为没生效
    if (err) setErr("");
  };

  const confirm = () => {
    const input = toCardInput(card, form);
    const message = validateCard(card, input);
    if (message) { setErr(message); return; }   // 窗不关，等用户补
    const dispatch = dialogDispatch(card, input);
    if (!dispatch.prompt) { setErr("条件没填全，补完再生成"); return; }
    onSend(dispatch, input.horizonKey);
  };

  const fields = fieldsOf(card);

  return (
    // 点遮罩关闭 = 取消（稳智 closeOnClickModal:false 是有意的防误触，这里跟它的"取消不发"语义，
    // 但落地页手搓遮罩本来就没实现点遮罩关；保持只有按钮/Esc 两条出口，行为更好预期）
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label={card.dialogTitle}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-popover p-4 shadow-2xl">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex-1 text-[16px] font-semibold">{card.dialogTitle}</span>
          <button onClick={onClose} aria-label="关闭" className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        {card.dialogSubtitle && <div className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">{card.dialogSubtitle}</div>}

        <div className="space-y-2.5">
          {fields.map((f, i) => (
            <div key={f.key}>
              <div className="mb-1 text-[12.5px] text-muted-foreground">
                {f.label}
                {f.required && f.key !== "subject" && <span className="ml-1 text-red-300/80">*</span>}
              </div>

              {f.key === "horizon" ? (
                <RadioRow
                  name="horizon"
                  options={CARD_HORIZONS.map((h) => ({ value: h.key, label: h.label, hint: h.embed }))}
                  value={form.horizon}
                  onChange={(v) => set("horizon", v)}
                />
              ) : f.key === "action" ? (
                <RadioRow
                  name="action"
                  options={CARD_ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
                  value={form.action}
                  onChange={(v) => set("action", v)}
                />
              ) : f.key === "ma" ? (
                <RadioRow
                  name="ma"
                  options={CARD_MAS.map((m) => ({ value: m, label: m }))}
                  value={form.ma}
                  onChange={(v) => set("ma", v)}
                />
              ) : f.key === "subject" && card.subjectKind === "multi_stock" ? (
                <textarea
                  ref={(el) => { if (i === 0) firstRef.current = el; }}
                  value={form.subject}
                  onChange={(e) => set("subject", e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); confirm(); } }}
                  placeholder={f.placeholder}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground/50 hover:border-sky-400/40 focus:border-sky-400/40"
                />
              ) : f.key === "openDate" ? (
                // 建仓日期：用原生 date 控件（用户点日历选，不用手打格式）。
                // 认不出的值由 hold-core.normalizeOpenDate 判空——不替用户把「2026/9/1」修成「2026-09-01」。
                <input
                  ref={(el) => { if (i === 0) firstRef.current = el; }}
                  type="date"
                  value={form.openDate}
                  onChange={(e) => set("openDate", e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); confirm(); } }}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground/50 hover:border-sky-400/40 focus:border-sky-400/40"
                />
              ) : (
                <input
                  ref={(el) => { if (i === 0) firstRef.current = el; }}
                  value={form[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); confirm(); } }}
                  placeholder={f.placeholder}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground/50 hover:border-sky-400/40 focus:border-sky-400/40"
                />
              )}
            </div>
          ))}
        </div>

        {card.subjectKind === "multi_stock" && (
          <div className="mt-2 text-[12px] text-muted-foreground/70">支持逗号、顿号、分号、斜杠或换行分隔，最多 8 只。</div>
        )}
        {err && <div className="mt-2 text-[13px] text-red-300">{err}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3.5 py-2 text-[14px] text-muted-foreground hover:text-foreground">
            取消
          </button>
          <button onClick={confirm} className="apple-primary-btn rounded-lg px-4 py-2 text-[14px]">
            {card.confirmText || "生成并发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 单选行：稳智那三处单选（周期/操作/均线）都是横向 radio group，这里同一画法 */
function RadioRow({ name, options, value, onChange }: {
  name: string;
  options: { value: string; label: string; hint?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={
              "rounded-full border px-3 py-1.5 text-[13px] transition-colors " +
              (active ? "border-sky-400/45 bg-sky-400/15 font-medium text-sky-200" : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
