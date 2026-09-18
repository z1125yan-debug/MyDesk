"use client";
// 白/黑主题开关：写入 localStorage["md-theme"]，html.dark 控制变量主题
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("md-theme", next ? "dark" : "light");
    } catch {
      /* 隐私模式等场景忽略 */
    }
  };

  return (
    <button
      onClick={toggle}
      title={dark ? "切换到白色主题" : "切换到黑色主题"}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
    >
      {dark === null ? (
        <span className="h-[15px] w-[15px]" />
      ) : dark ? (
        <Sun size={15} />
      ) : (
        <Moon size={15} />
      )}
    </button>
  );
}
