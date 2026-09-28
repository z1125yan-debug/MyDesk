"use client";
import { useEffect, useRef, useState } from "react";
import { PanelLeftClose, Search, Sparkles } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { searchSymbols, type SuggestItem } from "@/lib/desk/market";
import { aiReady } from "@/lib/desk/ai";
import ThemeToggle from "./ThemeToggle";

export default function TopBar() {
  const toggleSidebar = useDesk((s) => s.toggleSidebar);
  const go = useDesk((s) => s.go);
  const setFocus = useDesk((s) => s.setFocusSymbol);
  const ai = useDesk((s) => s.ai);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ type: string; label: string; value: string; target: "analysis" }[]>([]);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const kw = q.trim();
    if (!kw) { setResults([]); return; }
    const t = setTimeout(() => {
      searchSymbols(kw)
        .then((items: SuggestItem[]) =>
          setResults(items.slice(0, 8).map((it) => ({
            type: it.type || "品种", label: it.name, value: it.symbol, target: "analysis" as const,
          }))))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (r: (typeof results)[number]) => {
    if (r.target === "analysis") setFocus(r.value);
    go(r.target);
    setQ("");
    setOpen(false);
  };

  const configured = aiReady(ai);

  return (
    <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border/60 bg-background/70 px-5 backdrop-blur-xl">
      <button
        onClick={toggleSidebar}
        className="rounded-xl p-2 text-muted-foreground transition-colors hover:bg-overlay-strong hover:text-foreground"
        title="收起/展开侧栏"
      >
        <PanelLeftClose size={18} />
      </button>

      {/* 居中胶囊搜索 */}
      <div className="relative mx-auto w-full max-w-xl">
        <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) pick(results[0]); }}
          placeholder="搜索股票、板块，回车直达…"
          className="h-10 w-full rounded-full border border-border/70 bg-overlay pl-11 pr-4 text-[14.5px] outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-sky-400/50 focus:bg-overlay-strong"
        />
        {open && results.length > 0 && (
          <div className="apple-card absolute left-0 right-0 top-12 z-50 p-1.5 shadow-2xl">
            {results.map((r, i) => (
              <button
                key={i}
                onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); pick(r); }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] transition-colors hover:bg-overlay-strong"
              >
                <span className="rounded-md bg-sky-400/15 px-2 py-0.5 text-[12px] text-sky-300">{r.type}</span>
                <span className="font-medium">{r.label}</span>
                <span className="ml-auto font-mono text-[13px] text-muted-foreground">{r.value}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        <ThemeToggle />
        <button
          onClick={() => go("settings")}
          className={
            "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13.5px] transition-all " +
            (configured
              ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20"
              : "border-amber-400/25 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20")
          }
        >
          <Sparkles size={13} />
          {configured ? "AI 就绪" : "配置 AI"}
        </button>
      </div>
    </header>
  );
}
