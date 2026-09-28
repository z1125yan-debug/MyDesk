import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "Kairo 工作室",
  description: "A股行情与 AI 决策助手。输出仅供参考，不构成投资建议。",
  icons: {
    // 2026-09-23 换图标：用户给的是黑色立方体 Z，然后要求"完全占满"——原稿在 32x32 里四周留白太多显得空。
    // 现在把立方体撑满整个圆角方形：正面 + 顶面 + 右侧面的三张四边形正好覆盖 4~28 的范围，圆角半径与外框一致。
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3CclipPath id='r'%3E%3Crect width='32' height='32' rx='7' ry='7'/%3E%3C/clipPath%3E%3C/defs%3E%3Cg clip-path='url(%23r)'%3E%3Crect width='32' height='32' fill='%23111418'/%3E%3Cpolygon points='0,8 16,2 32,8 16,14' fill='%232a2e35'/%3E%3Cpolygon points='32,8 32,24 16,30 16,14' fill='%231a1e24'/%3E%3Cpolygon points='0,8 16,14 16,30 0,24' fill='%2316191e'/%3E%3Cpath d='M8,16 L24,16 L10,24 L24,24' fill='none' stroke='white' stroke-width='2.6' stroke-linejoin='round' stroke-linecap='round'/%3E%3C/g%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <head>
        {/* 首屏前应用保存的主题，避免闪白/闪黑 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem("md-theme")==="light"){document.documentElement.classList.remove("dark")}else{document.documentElement.classList.add("dark")}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
