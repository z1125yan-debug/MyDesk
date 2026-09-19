"use client";
import { useState } from "react";
import type { SectorRow } from "@/lib/desk/types";

// 资金流向图（替代旧静态气泡图）：
// 左侧「主力流入/流出」枢纽，右侧 TOP8 流入与 TOP8 流出榜单；
// 曲线上的粒子持续流动表示资金去向——红=主力净流入个股（流向个股），
// 绿=主力净流出个股（离开个股回到主力）；线宽与条长=净额大小。数据随看板周期刷新。
const W = 900;
const H = 456;
const ROW_H = 24;
const TOP = 8;
const IN_Y0 = 40;
const OUT_Y0 = 262;
const HUB_X = 118;
const X_NAME = 320;
const X_BAR = 470;
const BAR_W = 300;
const X_VAL = 888;

function hubRect(y0: number, y1: number, color: string, label: string) {
  return (
    <g>
      <rect x={24} y={y0} width={94} height={y1 - y0} rx={9} fill={color} opacity="0.14" stroke={color} strokeWidth="1.2" />
      <rect x={112} y={(y0 + y1) / 2 - 3} width={8} height={6} rx={2} fill={color} />
      <text x={71} y={(y0 + y1) / 2 + 4.5} fontSize="12.5" fontWeight="700" fill={color} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

function flowPath(y0: number, y1: number, out: boolean) {
  return out
    ? `M ${X_NAME - 8} ${y1} C ${X_NAME - 60} ${y1}, ${HUB_X + 90} ${y0}, ${HUB_X + 4} ${y0}`
    : `M ${HUB_X + 4} ${y0} C ${HUB_X + 90} ${y0}, ${X_NAME - 60} ${y1}, ${X_NAME - 8} ${y1}`;
}

export default function BubbleFlow({
  inRows, outRows, onSelect,
}: {
  inRows: SectorRow[];
  outRows: SectorRow[];
  onSelect?: (r: SectorRow) => void;
}) {
  const [tip, setTip] = useState<SectorRow | null>(null);
  const [hot, setHot] = useState<string | null>(null);

  const ins = inRows.filter((r) => r.main > 0).slice(0, TOP);
  const outs = outRows.filter((r) => r.main < 0).slice(0, TOP);
  if (!ins.length && !outs.length) {
    return <div className="flex h-40 items-center justify-center text-[12.5px] text-muted-foreground">暂无资金流数据</div>;
  }
  const maxIn = Math.max(...ins.map((r) => r.main), 1);
  const maxOut = Math.max(...outs.map((r) => Math.abs(r.main)), 1);
  const totalIn = ins.reduce((a, r) => a + r.main, 0);
  const totalOut = outs.reduce((a, r) => a + r.main, 0);

  const RED = "#fb7185";
  const GREEN = "#34d399";

  const renderSide = (rows: SectorRow[], startY: number, color: string, out: boolean, max: number) => {
    const portY = out ? 347 : 125; // 枢纽端口纵坐标（与 hubRect 中心对齐）
    return rows.map((row, i) => {
      const y = startY + i * ROW_H;
      const key = `${out ? "o" : "i"}-${row.code}-${i}`;
      const isHot = hot === key;
      const bw = Math.max(6, (Math.abs(row.main) / max) * BAR_W);
      const dur = 1.7 + i * 0.22;
      const dots = i < 3 ? 2 : 1;
      const d = flowPath(portY, y, out);
      return (
        <g key={key}
          onMouseEnter={() => { setHot(key); setTip(row); }}
          onMouseLeave={() => { setHot(null); setTip(null); }}
          onClick={() => onSelect?.(row)}
          className="cursor-pointer">
          {/* 流动曲线 */}
          <path d={d} fill="none" stroke={color}
            strokeWidth={1 + 2.2 * (Math.abs(row.main) / max)}
            opacity={isHot ? 0.85 : 0.3} strokeDasharray="1 7" strokeLinecap="round" />
          {/* 虚线流动动画（方向=资金方向） */}
          <path d={d} fill="none" stroke={color} strokeWidth="1" opacity={isHot ? 0.9 : 0.35}>
            <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.1s" repeatCount="indefinite" />
          </path>
          {/* 资金粒子 */}
          {Array.from({ length: dots }).map((_, k) => (
            <circle key={k} r={3.1 - i * 0.12} fill={color} opacity={isHot ? 1 : 0.8}>
              <animateMotion path={d} dur={`${dur}s`} begin={`-${(k * dur) / 2}s`} repeatCount="indefinite" />
            </circle>
          ))}
          {/* 名称 */}
          <text x={X_NAME} y={y + 3.5} fontSize="11.5" className="fill-foreground">{row.name}</text>
          {/* 净额条 */}
          <rect x={X_BAR} y={y - 6.5} width={BAR_W} height={9} rx={3} className="fill-foreground" opacity="0.06" />
          <rect x={X_BAR} y={y - 6.5} width={bw} height={9} rx={3} fill={color} opacity={isHot ? 0.95 : 0.72} />
          {/* 数值 */}
          <text x={X_VAL} y={y + 3.5} fontSize="11.5" fill={color} textAnchor="end" fontFamily="ui-monospace, monospace">
            {row.main >= 0 ? "+" : ""}{row.main.toFixed(1)}亿
          </text>
        </g>
      );
    });
  };

  return (
    <div className="relative">
      {/* 汇总条（对齐「资金流向」面板风格） */}
      <div className="mb-3 grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2.5">
          <div className="text-[11px] text-muted-foreground">主力净流入合计（流入榜）</div>
          <div className="mt-0.5 font-mono text-[19px] font-bold text-rose-400">+{totalIn.toFixed(1)}亿</div>
        </div>
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
          <div className="text-[11px] text-muted-foreground">主力净流出合计（流出榜）</div>
          <div className="mt-0.5 font-mono text-[19px] font-bold text-emerald-400">{totalOut.toFixed(1)}亿</div>
        </div>
        <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <div className="text-[11px] text-muted-foreground">流入 / 流出 家数（榜内）</div>
          <div className="mt-0.5 font-mono text-[19px] font-bold">
            <span className="text-rose-400">{ins.length}</span>
            <span className="mx-1.5 text-[13px] font-normal text-muted-foreground">/</span>
            <span className="text-emerald-400">{outs.length}</span>
          </div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {hubRect(104, 146, RED, "主力流入")}
        {hubRect(326, 368, GREEN, "主力流出")}

        {renderSide(ins, IN_Y0, RED, false, maxIn)}
        {renderSide(outs, OUT_Y0, GREEN, true, maxOut)}

        <text x={X_BAR} y={24} fontSize="10.5" className="fill-muted-foreground">净额条长 = 主力净额大小</text>
        <text x={X_VAL} y={24} fontSize="10.5" className="fill-muted-foreground" textAnchor="end">单位：亿元</text>
        <text x={24} y={H - 10} fontSize="10.5" className="fill-muted-foreground">
          粒子流向 = 资金去向：红·流入个股 / 绿·流出个股。悬停查看明细，点击联动右侧资金明细。
        </text>
      </svg>

      {tip && (
        <div className="pointer-events-none absolute right-3 top-2 rounded-md border border-border bg-popover/95 px-3 py-2 text-[12px] shadow-lg">
          <div className="font-medium">{tip.name} <span className="ml-1 font-mono text-[11px] text-muted-foreground">{tip.code}</span></div>
          <div className="mt-1 font-mono">
            涨跌 <span className={tip.changePct >= 0 ? "text-rose-400" : "text-emerald-400"}>{tip.changePct.toFixed(2)}%</span>
            <span className="ml-3">主力</span>
            <span className={tip.main >= 0 ? "text-rose-400" : "text-emerald-400"}> {tip.main.toFixed(2)}亿</span>
          </div>
          <div className="mt-0.5 text-muted-foreground">{tip.leader ? `所属/领涨：${tip.leader}` : ""}</div>
        </div>
      )}
    </div>
  );
}
