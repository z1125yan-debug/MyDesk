"use client";
import { useState } from "react";
import type { SectorRow } from "@/lib/desk/types";

// 资金气泡面板：X=涨跌%，Y=主力净额，半径∝主力净额；流入红/流出绿（A股习惯）
export default function BubbleFlow({ rows }: { rows: SectorRow[] }) {
  const [tip, setTip] = useState<SectorRow | null>(null);
  const W = 860, H = 400, PAD = 46;
  if (!rows.length) return null;

  const xs = rows.map((r) => r.changePct);
  const ys = rows.map((r) => r.main);
  const x0 = Math.min(...xs, 0) - 0.6, x1 = Math.max(...xs, 0) + 0.6;
  const y0 = Math.min(...ys, 0) * 1.1 - 2, y1 = Math.max(...ys, 0) * 1.1 + 2;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.main)), 1);
  const px = (v: number) => PAD + ((v - x0) / (x1 - x0)) * (W - PAD * 2);
  const py = (v: number) => H - PAD - ((v - y0) / (y1 - y0)) * (H - PAD * 2);
  const r = (v: number) => 6 + Math.sqrt(Math.abs(v) / maxAbs) * 26;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 400 }}>
        {/* 轴 */}
        <line x1={PAD} x2={W - PAD} y1={py(0)} y2={py(0)} stroke="currentColor" className="text-border" strokeWidth="1" />
        <line x1={px(0)} x2={px(0)} y1={PAD - 10} y2={H - PAD + 10} stroke="currentColor" className="text-border" strokeWidth="1" strokeDasharray="4 4" />
        <text x={W - PAD} y={py(0) - 8} fontSize="10.5" className="fill-muted-foreground" textAnchor="end">涨跌% →</text>
        <text x={px(0) + 8} y={PAD - 4} fontSize="10.5" className="fill-muted-foreground">主力净额(亿) ↑</text>

        {rows.map((row) => {
          const inflow = row.main >= 0;
          const color = inflow ? "#fb7185" : "#34d399";
          return (
            <g key={row.code} className="cursor-pointer"
              onMouseEnter={() => setTip(row)} onMouseLeave={() => setTip(null)}>
              <circle cx={px(row.changePct)} cy={py(row.main)} r={r(row.main)} fill={color} opacity="0.22" stroke={color} strokeWidth="1.2" />
              {Math.abs(row.main) > maxAbs * 0.28 && (
                <text x={px(row.changePct)} y={py(row.main) + 3.5} fontSize="10.5" fill={color} textAnchor="middle">
                  {row.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {tip && (
        <div className="pointer-events-none absolute right-3 top-2 rounded-md border border-border bg-popover/95 px-3 py-2 text-[12px] shadow-lg">
          <div className="font-medium">{tip.name} <span className="ml-1 font-mono text-[11px] text-muted-foreground">{tip.code}</span></div>
          <div className="mt-1 font-mono">
            涨跌 <span className={tip.changePct >= 0 ? "text-rose-400" : "text-emerald-400"}>{tip.changePct.toFixed(2)}%</span>
            <span className="ml-3">主力</span>
            <span className={tip.main >= 0 ? "text-rose-400" : "text-emerald-400"}> {tip.main.toFixed(2)}亿</span>
          </div>
          <div className="mt-0.5 text-muted-foreground">领涨：{tip.leader}</div>
        </div>
      )}
    </div>
  );
}
