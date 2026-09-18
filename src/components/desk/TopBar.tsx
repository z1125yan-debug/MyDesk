"use client";
import { useEffect, useRef, useState } from "react";
import { PanelLeftClose, Search, Sparkles, RefreshCw } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { searchSymbols, type SuggestItem } from "@/lib/desk/market";
import { aiConfigured } from "@/lib/desk/ai";
import ThemeToggle from "./ThemeToggle";

export default function TopBar() {
  const toggleSidebar = useDesk((s) => s.toggleSidebar);
  const go = useDesk((s) => s.go);
  const setFocus = useDesk((s) => s.setFocusSymbol);
  const refreshInterval = useDesk((s) => s.refreshInterval);
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

  const configured = aiConfigured(ai);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/70 px-4 backdrop-blur">
      <button
        onClick={toggleSidebar}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="收起/展开侧栏"
      >
        <PanelLeftClose size={18} />
      </button>

      <div className="relative w-full max-w-md">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          onKeyDown={(e) => { if (e.key === "Enter" && results[0]) pick(results[0]); }}
          placeholder="搜索品种、板块，回车直达…"
          className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-sky-500/60"
        />
        {open && results.length > 0 && (
          <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
            {results.map((r, i) => (
              <button
                key={i}
                onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); pick(r); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-accent"
              >
                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10.5px] text-sky-300">{r.type}</span>
                <span>{r.label}</span>
                <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">{r.value}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2.5 text-[12px]">
        <span className="hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-muted-foreground md:inline-flex">
          <RefreshCw size={12.5} />
          自动刷新 {refreshInterval >= 60 ? `${Math.round(refreshInterval / 60)} 分` : `${refreshInterval} 秒`}
        </span>
        <ThemeToggle />
        <button
          onClick={() => go("settings")}
          className={
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition-colors " +
            (configured
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
              : "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20")
          }
          title="AI 接口状态，点击去设置"
        >
          <Sparkles size={12.5} />
          {configured ? "AI 已就绪" : "AI 未配置"}
        </button>
      </div>
    </header>
  );
}
