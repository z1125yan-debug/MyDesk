import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "MyDesk · 个人行情工作台",
  description: "运行在本机的个人行情分析与智能助手工具。A股行情由本机直连公开接口获取，输出仅供参考，不构成投资建议。",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230ea5e9'/%3E%3Crect x='8' y='13' width='5' height='10' rx='1.2' fill='white'/%3E%3Cline x1='10.5' y1='9' x2='10.5' y2='25' stroke='white' stroke-width='1.8'/%3E%3Crect x='19' y='9' width='5' height='8' rx='1.2' fill='white' opacity='.75'/%3E%3Cline x1='21.5' y1='6' x2='21.5' y2='20' stroke='white' stroke-width='1.8'/%3E%3C/svg%3E",
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
