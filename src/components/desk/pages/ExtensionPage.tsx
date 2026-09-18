"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, RefreshCw, Puzzle, Inbox, Plus, Send } from "lucide-react";
import { useDesk } from "@/lib/desk/store";

interface PendingItem {
  id: number;
  symbol?: string;
  interval?: string;
  chartUrl?: string;
  note?: string;
  ts?: number;
}

// TradingView 品种格式 → MyDesk 格式：SSE:688825 → 688825.SH，SZSE:000001 → 000001.SZ，BSE:920819 → 920819.BJ
function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  const m = /^([A-Z]+)[:\-](\d{6})$/.exec(s);
  if (m) {
    if (m[1] === "SSE") return `${m[2]}.SH`;
    if (m[1] === "SZSE") return `${m[2]}.SZ`;
    if (m[1] === "BSE") return `${m[2]}.BJ`;
  }
  if (/^\d{6}$/.test(s)) {
    if (s.startsWith("6")) return `${s}.SH`;
    if (/^[0-3]/.test(s)) return `${s}.SZ`;
    if (/^[4892]/.test(s)) return `${s}.BJ`;
  }
  return s;
}

// 免安装书签脚本：在 TradingView 图表页把当前品种 POST 回收件箱
const BOOKMARKLET = `javascript:(function(){var m=location.href.match(/symbol=([A-Za-z0-9_:.]+)/)||location.href.match(/\/symbols\/[A-Za-z0-9\-]*?([A-Z]{2,10}[A-Z0-9:.]+)\/?/);var s=m?m[1].replace(/[:.]$/,''):'';if(!s){s=prompt('未识别到品种，请输入（如 SSE:688256）');}if(!s)return;window.open('http://localhost:3000/#/analysis?symbol='+encodeURIComponent(s));})()`;

export default function ExtensionPage() {
  const extensionKey = useDesk((s) => s.extensionKey);
  const regen = useDesk((s) => s.regenExtensionKey);
  const addWatch = useDesk((s) => s.addWatch);
  const [origin, setOrigin] = useState("");
  const [items, setItems] = useState<PendingItem[]>([]);
  const bmRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (bmRef.current) bmRef.current.setAttribute("href", BOOKMARKLET);
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    const poll = setInterval(async () => {
      try {
        const res = await fetch("/api/extension/pending");
        const json = await res.json();
        setItems(json.items ?? []);
      } catch { /* 本地服务未就绪时忽略 */ }
    }, 5000);
    return () => clearInterval(poll);
  }, []);

  const endpoint = origin ? `${origin}/api/extension/pending` : "/api/extension/pending";
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* 忽略 */ }
    alert(`${label}已复制`);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      <div>
        <h1 className="text-xl font-bold">浏览器扩展</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          配套的本地小扩展（public/mydesk-extension 文件夹）：在 TradingView 图表页一键把当前品种发回工作台
        </p>
      </div>

      {/* 免安装书签方式（推荐） */}
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13.5px] font-semibold text-sky-300">免安装用法：书签一键发送（推荐）</div>
          <a href="https://www.tradingview.com/chart/?symbol=SSE:688256" target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-sky-500/90 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-400">
            打开 TradingView 图表 ↗
          </a>
        </div>
        <p className="mt-2 text-[12.5px] leading-5 text-muted-foreground">
          1. 把下面的蓝色按钮<b>拖到浏览器书签栏</b>（按 Ctrl+Shift+B 显示书签栏）；
          2. 在 TradingView 图表页点书签栏里的它，当前品种就发回本页收件箱。无需安装任何扩展。
        </p>
        <div className="mt-2.5">
          <a ref={bmRef} onClick={(e) => e.preventDefault()} draggable
            className="inline-flex cursor-move items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[12.5px] font-medium text-sky-300">
            <Send size={13} /> → 发送到 MyDesk
          </a>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            <Puzzle size={15} className="text-sky-400" /> 安装（Chrome / Edge）
          </div>
          <ol className="mt-2.5 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-5 text-muted-foreground">
            <li>地址栏打开 <code className="rounded bg-accent px-1 font-mono">chrome://extensions</code></li>
            <li>右上角开启「开发者模式」</li>
            <li>点「加载已解压的扩展程序」</li>
            <li>选择本程序目录下的 <code className="rounded bg-accent px-1 font-mono">public/mydesk-extension</code> 文件夹</li>
          </ol>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-[13.5px] font-semibold">回传配置</div>
          <div className="mt-2.5 space-y-2 text-[12.5px]">
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">地址</span>
              <code className="flex-1 truncate rounded bg-accent/70 px-2 py-1.5 font-mono text-[11.5px]">{endpoint}</code>
              <button onClick={() => copy(endpoint, "地址")} className="rounded p-1.5 text-muted-foreground hover:text-foreground"><Copy size={14} /></button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">配对码</span>
              <code className="flex-1 truncate rounded bg-accent/70 px-2 py-1.5 font-mono text-[11.5px]">{extensionKey}</code>
              <button onClick={() => copy(extensionKey, "配对码")} className="rounded p-1.5 text-muted-foreground hover:text-foreground"><Copy size={14} /></button>
              <button onClick={regen} title="重新生成" className="rounded p-1.5 text-muted-foreground hover:text-foreground"><RefreshCw size={14} /></button>
            </div>
            <p className="text-[11.5px] leading-4 text-muted-foreground">
              在扩展弹窗里填入同样地址与配对码即可配对；数据只在本机之间传输。
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[13.5px] font-semibold">
          <Inbox size={15} className="text-sky-400" /> 收件箱
          <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">{items.length} 条</span>
          {items.length > 0 && (
            <button onClick={async () => { await fetch("/api/extension/pending", { method: "DELETE" }); setItems([]); }}
              className="ml-auto text-[11.5px] font-normal text-muted-foreground hover:text-rose-300">清空</button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12.5px] text-muted-foreground">
            暂无回传。装好扩展后，在 TradingView 图表页点「→ MyDesk」按钮即可发送当前品种。
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((it) => {
              const sym = normalizeSymbol(it.symbol || "");
              return (
              <div key={it.id} className="flex items-center gap-3 px-4 py-3 text-[12.5px]">
                <span className="font-mono font-medium">{it.symbol || "未知"}</span>
                {it.interval && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground">{it.interval}</span>}
                <span className="text-[11.5px] text-muted-foreground">{it.ts ? new Date(it.ts).toLocaleTimeString("zh-CN") : ""}</span>
                <div className="ml-auto flex gap-2">
                  <button
                    onClick={() => { addWatch({ symbol: sym, name: sym, kind: "hot" }); }}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[11.5px] text-sky-300 hover:bg-sky-500/20">
                    <Plus size={12} /> 加入自选
                  </button>
                  <button
                    onClick={() => { useDesk.getState().setFocusSymbol(sym); useDesk.getState().go("analysis"); }}
                    className="rounded-md border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground">
                    去分析
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
