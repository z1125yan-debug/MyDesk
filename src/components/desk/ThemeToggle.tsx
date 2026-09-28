"use client";
// 白/黑主题开关：写入 localStorage["md-theme"]，html.dark 控制变量主题
// P33 稳智对齐：改成深黑/白天分段控件（稳智 HTML 里的 .theme-switch 结构），
// 两个明确按钮，比纯图标更直白。
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const apply = (toDark: boolean) => {
    if (dark === toDark) return;
    setDark(toDark);
    document.documentElement.classList.toggle("dark", toDark);
    try {
      localStorage.setItem("md-theme", toDark ? "dark" : "light");
    } catch {
      /* 隐私模式等场景忽略 */
    }
  };

  const itemClass = (active: boolean) =>
    "px-2.5 py-1 rounded-full transition-colors " +
    (active ? "bg-overlay-strong text-foreground font-medium" : "text-muted-foreground hover:text-foreground");

  return (
    <div
      className="inline-flex items-center rounded-full border border-border bg-background p-0.5"
      aria-label="主题切换"
      role="tablist"
    >
      <button
        onClick={() => apply(true)}
        role="tab"
        aria-selected={dark === true}
        className={itemClass(dark === true)}
      >
        深黑
      </button>
      <button
        onClick={() => apply(false)}
        role="tab"
        aria-selected={dark === false}
        className={itemClass(dark === false)}
      >
        白天
      </button>
    </div>
  );
}
