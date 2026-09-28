// RunReportPanel：稳智风格「最终关注清单」卡
// 上面 3 列显示板块/概念焦点，下面 2 列显示关注股票卡
// 每张股票卡可点击跳个股画像

import { useDesk } from "@/lib/desk/store";
import StreamSection from "./StreamSection";

interface ThemeChip {
  label: string;
  text: string;
}

interface StockCard {
  name: string;
  code?: string;
  tags?: string[];
  cta?: string;
  symbol?: string;
}

export default function RunReportPanel({
  themes,
  stocks,
  title = "关注清单",
}: {
  themes?: ThemeChip[];
  stocks?: StockCard[];
  title?: string;
}) {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);

  if ((!themes || themes.length === 0) && (!stocks || stocks.length === 0)) return null;

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold">📌 {title}</div>

      {themes && themes.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {themes.map((t, i) => (
            <div key={i} className="rounded-xl border border-border bg-foreground/[0.03] p-3">
              <div className="mb-1 text-[12px] text-muted-foreground">{t.label}</div>
              <div className="text-[14px] leading-relaxed">{t.text}</div>
            </div>
          ))}
        </div>
      )}

      {stocks && stocks.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {stocks.map((s, i) => {
            const onClick = () => {
              if (s.symbol) { setFocusSymbol(s.symbol); go("profile"); }
            };
            return (
              <button
                key={i}
                onClick={onClick}
                className="rounded-xl border border-border bg-foreground/[0.03] p-3 text-left transition hover:border-sky-400/50 hover:bg-sky-500/10 hover:-translate-y-px"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">{s.name}</div>
                  {s.code && <div className="font-mono text-[12px] text-muted-foreground">{s.code}</div>}
                </div>
                {s.tags && s.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.tags.map((t, j) => (
                      <span key={j} className="rounded-full border border-border bg-foreground/5 px-1.5 py-0.5 text-[12px] text-muted-foreground">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {s.cta && (
                  <div className="mt-2 text-xs text-sky-400">{s.cta} →</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
