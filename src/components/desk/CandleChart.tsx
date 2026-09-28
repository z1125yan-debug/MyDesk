"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MousePointer2, TrendingUp, Minus, Ruler, Eraser } from "lucide-react";
import type { Candle } from "@/lib/desk/types";

const W = 940;
const H = 380;
const PAD_L = 8;
const PAD_R = 64;
const PAD_T = 14;
const PAD_B = 22;
const FUTURE = 10;      // 趋势线向右（未来）投射的空槽位数
const DEFAULT_BARS = 120; // 默认可见根数
const MIN_BARS = 20;      // 缩放下限

// 画图工具（稳智同款手绘）：趋势线 / 水平线 / 斐波那契回撤。
export type DrawTool = "none" | "trend" | "hlevel" | "fib";
/** 画线点：用「日期 + 价格」存（不是索引）——切日期区间/复权后索引会变，日期是稳的 */
export interface DrawPoint { date: string; price: number }
export interface Drawing { id: string; tool: Exclude<DrawTool, "none">; pts: DrawPoint[] }

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function linReg(vals: number[]): { a: number; b: number } {
  const n = vals.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  vals.forEach((yv, i) => { sx += i; sy += yv; sxy += i * yv; sxx += i * i; });
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const b = (sy - a * sx) / n;
  return { a, b };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// 自绘 K 线图：双指捏合缩放 / 拖动平移 / 滚轮缩放 / 双击复位
// 元素：蜡烛 + 涨跌停线 + 现价线 + 趋势通道（近 60 根高低点双回归并向前投射）+ 十字光标
// enableDrawing 打开后额外挂一层手绘（趋势线/水平线/斐波那契），按 symbol 存 localStorage。
export default function CandleChart({
  candles, prevClose, symbol, showChannel, enableDrawing,
}: {
  candles: Candle[];
  prevClose?: number;
  symbol?: string;
  showChannel: boolean;
  /** 打开手绘工具层（默认关，不影响既有用法） */
  enableDrawing?: boolean;
}) {
  const n = candles.length;
  const [hover, setHover] = useState<number | null>(null);   // 全量索引
  const [range, setRange] = useState<{ s: number; c: number } | null>(null); // null=显示最近 120 根

  // 手绘状态
  const [tool, setTool] = useState<DrawTool>("none");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pending, setPending] = useState<DrawPoint | null>(null);
  const storeKey = enableDrawing && symbol ? `mydesk-drawings:${symbol}` : "";

  const svgRef = useRef<SVGSVGElement | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch0 = useRef<{ dist: number; c: number; mid: number; s: number } | null>(null);
  const drag0 = useRef<{ x: number; s: number } | null>(null);

  // 载入手绘（按 symbol）：换股即读该股的线，切工具不清
  useEffect(() => {
    if (!storeKey) { setDrawings([]); setPending(null); return; }
    try {
      const raw = localStorage.getItem(storeKey);
      const arr = raw ? JSON.parse(raw) : [];
      setDrawings(Array.isArray(arr) ? arr : []);
    } catch { setDrawings([]); }
    setPending(null);
  }, [storeKey]);

  const persist = (next: Drawing[]) => {
    setDrawings(next);
    if (storeKey) { try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* 存档满/隐私模式：静默 */ } }
  };
  const clearDrawings = () => { persist([]); setPending(null); };

  // 数据根数变化时夹取窗口，防止越界
  useEffect(() => {
    setRange((r) => {
      if (!r) return r;
      const c = clamp(r.c, MIN_BARS, Math.max(n, MIN_BARS));
      const s = clamp(r.s, 0, Math.max(0, n - c));
      return { s, c };
    });
  }, [n]);

  const eff = useMemo(() => {
    const c = Math.min(range?.c ?? DEFAULT_BARS, Math.max(n, MIN_BARS));
    const s = range ? clamp(range.s, 0, Math.max(0, n - c)) : Math.max(0, n - c);
    return { s, c };
  }, [range, n]);

  const limits = useMemo(() => {
    if (!prevClose || prevClose <= 0) return null;
    const code6 = symbol?.match(/^(\d{6})\./)?.[1] ?? "";
    const pct = /^(300|301|302|688|689)/.test(code6) ? 0.2 : 0.1;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return { up: r2(prevClose * (1 + pct)), dn: r2(prevClose * (1 - pct)) };
  }, [prevClose, symbol]);

  const view = useMemo(() => {
    if (!n) return null;
    const vis = candles.slice(eff.s, eff.s + eff.c);
    if (!vis.length) return null;
    const lo = Math.min(...vis.map((x) => x.l));
    const hi = Math.max(...vis.map((x) => x.h));
    const span = hi - lo || 1;
    const y = (v: number) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B);
    const atEnd = eff.s + eff.c >= n;
    const slots = eff.c + (atEnd ? FUTURE : 0);
    const step = (W - PAD_L - PAD_R) / slots;
    const x = (fullIdx: number) => PAD_L + (fullIdx - eff.s) * step + step / 2;
    const bodyW = Math.max(1.5, step * 0.62);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + span * (1 - f));
    return { vis, lo, hi, span, y, x, step, bodyW, ticks, atEnd };
  }, [candles, eff, n]);

  // 客户端坐标 → viewBox 坐标（viewBox 默认 preserveAspectRatio=meet，会有留白，要按缩放算）
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const offX = (rect.width - W * scale) / 2;
    const offY = (rect.height - H * scale) / 2;
    return { px: (e.clientX - rect.left - offX) / scale, py: (e.clientY - rect.top - offY) / scale };
  };
  const dateAtX = (px: number): string | null => {
    if (!view) return null;
    const idx = eff.s + Math.floor((px - PAD_L) / view.step);
    if (idx < eff.s || idx >= Math.min(eff.s + eff.c, n)) return null;
    return candles[idx]?.date ?? null;
  };
  const priceAtY = (py: number): number | null => {
    if (!view) return null;
    return view.lo + (1 - (py - PAD_T) / (H - PAD_T - PAD_B)) * view.span;
  };

  // 手绘点击：趋势线/斐波那契点两下，水平线点一下
  const onDrawClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!enableDrawing || tool === "none" || !view) return;
    const loc = toLocal(e);
    if (!loc) return;
    const date = dateAtX(loc.px);
    const price = priceAtY(loc.py);
    if (!date || price == null || !isFinite(price)) return;
    if (tool === "hlevel") {
      persist([...drawings, { id: `${Date.now()}`, tool, pts: [{ date, price }] }]);
      return;
    }
    if (!pending) { setPending({ date, price }); return; }
    persist([...drawings, { id: `${Date.now()}`, tool, pts: [pending, { date, price }] }]);
    setPending(null);
  };

  // 以 fullIdx 为锚点缩放
  const zoomAt = (idx: number, factor: number) => {
    setRange(() => {
      const c1 = clamp(Math.round(eff.c * factor), MIN_BARS, Math.max(n, MIN_BARS));
      const s1 = clamp(Math.round(idx - (idx - eff.s) * (c1 / eff.c)), 0, Math.max(0, n - c1));
      return { s: s1, c: c1 };
    });
  };

  // P15-R15 滚轮修复：不按住 Ctrl 时滚轮交还给页面滚动（之前无条件 preventDefault，
  // 鼠标只要掠过 K 线就"吞"掉滚动，页面往上滑很费劲）；Ctrl+滚轮 = 缩放，图上有提示。
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!view) return;
      const rect = el.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const idx = eff.s + (px - PAD_L) / view.step;
      zoomAt(idx, e.deltaY > 0 ? 1.18 : 1 / 1.18);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  if (!n || !view) return <div className="h-[380px] rounded-lg bg-background/40" />;

  const { y, x, step, bodyW, ticks, vis, atEnd } = view;
  const last = candles[n - 1];
  const hc = hover != null && hover >= 0 && hover < n ? candles[hover] : null;

  // 日期 → 当前窗口内的 fullIdx（手绘按日期存，切窗口也能落到对的位置）
  const idxOfDate = (d: string): number => {
    const i = candles.findIndex((c) => c.date === d);
    return i;
  };

  const gridLine = (v: number) => (
    <g key={v}>
      <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-border" strokeWidth="0.6" strokeDasharray="3 5" />
      <text x={W - PAD_R + 8} y={y(v) + 3.5} fontSize="10.5" className="fill-muted-foreground" fontFamily="ui-monospace, monospace">
        {v.toFixed(2)}
      </text>
    </g>
  );

  const limitTag = (v: number, label: string) => (
    <g key={label}>
      <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#facc15" strokeWidth="0.9" strokeDasharray="2 3" opacity="0.8" />
      <rect x={W - PAD_R + 2} y={y(v) - 8} width={82} height={16} rx={3} fill="#facc15" />
      <text x={W - PAD_R + 6} y={y(v) + 4} fontSize="10" fill="#0b1220" fontWeight="700" fontFamily="ui-monospace, monospace">
        {label} {v.toFixed(2)}
      </text>
    </g>
  );

  // 手绘渲染（趋势线 / 水平线 / 斐波那契）
  const renderDrawing = (d: Drawing) => {
    const i0 = idxOfDate(d.pts[0]?.date ?? "");
    if (i0 < 0) return null;
    if (d.tool === "hlevel") {
      const yv = y(d.pts[0].price);
      return (
        <g key={d.id}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yv} y2={yv} stroke="#38bdf8" strokeWidth="1.1" strokeDasharray="5 3" />
          <text x={PAD_L + 3} y={yv - 3} fontSize="10" fill="#38bdf8" fontFamily="ui-monospace, monospace">{d.pts[0].price.toFixed(2)}</text>
        </g>
      );
    }
    if (d.pts.length < 2) return null;
    const i1 = idxOfDate(d.pts[1].date);
    if (i1 < 0) return null;
    const x0 = x(i0), y0 = y(d.pts[0].price), x1 = x(i1), y1 = y(d.pts[1].price);
    if (d.tool === "trend") {
      return <line key={d.id} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#f0b90b" strokeWidth="1.5" />;
    }
    // 斐波那契：两点间按比例画水平回撤位
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const pa = d.pts[0].price, pb = d.pts[1].price;
    return (
      <g key={d.id}>
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#a78bfa" strokeWidth="1" opacity="0.55" />
        {FIB_LEVELS.map((lv) => {
          const p = pa + (pb - pa) * lv;
          const yv = y(p);
          return (
            <g key={lv}>
              <line x1={xa} x2={xb} y1={yv} y2={yv} stroke="#a78bfa" strokeWidth="0.9" strokeDasharray="3 3" opacity="0.9" />
              <text x={W - PAD_R + 2} y={yv + 3} fontSize="9" fill="#a78bfa" fontFamily="ui-monospace, monospace">
                {(lv * 100).toFixed(1)}% {p.toFixed(2)}
              </text>
            </g>
          );
        })}
      </g>
    );
  };

  const drawing = enableDrawing && tool !== "none";

  return (
    <div className="relative">
      {/* 手绘工具条（稳智同款） */}
      {enableDrawing && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
          {([
            ["none", "十字", MousePointer2],
            ["trend", "趋势线", TrendingUp],
            ["hlevel", "水平线", Minus],
            ["fib", "斐波那契", Ruler],
          ] as const).map(([t, label, Icon]) => (
            <button key={t} onClick={() => { setTool(t); setPending(null); }}
              className={"flex items-center gap-1 rounded-md border px-2 py-1 transition-colors " + (tool === t ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 bg-card text-muted-foreground hover:border-sky-400/40")}>
              <Icon size={12} /> {label}
            </button>
          ))}
          <button onClick={clearDrawings} disabled={!drawings.length}
            className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-1 text-muted-foreground transition-colors hover:border-rose-400/40 hover:text-rose-300 disabled:opacity-40">
            <Eraser size={12} /> 清除
          </button>
          {drawing && (
            <span className="ml-1 text-[11.5px] text-sky-300/90">
              {tool === "hlevel" ? "点一下画水平线" : pending ? "再点一下落第二点" : "点两下画线"}（画线时禁用拖动/缩放）
            </span>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute right-16 top-1 z-10 text-[11.5px] text-muted-foreground/70">
        Ctrl+滚轮缩放 · 拖动平移 · 双击复位（不按 Ctrl 时滚轮照常滚页面）
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        style={{ height: 380, touchAction: "none", cursor: drawing ? "crosshair" : undefined }}
        onClick={onDrawClick}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const fullIdx = eff.s + Math.floor((px - PAD_L) / step);
          setHover(fullIdx >= eff.s && fullIdx < Math.min(eff.s + eff.c, n) ? fullIdx : null);
        }}
        onDoubleClick={() => setRange(null)}
        onPointerDown={(e) => {
          if (drawing) return; // 画线模式：不拖动/不缩放，把指针交给点击
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch0.current = {
              dist: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)),
              c: eff.c, mid: eff.s + eff.c / 2, s: eff.s,
            };
            drag0.current = null;
          } else if (pointers.current.size === 1) {
            drag0.current = { x: e.clientX, s: eff.s };
          }
        }}
        onPointerMove={(e) => {
          if (drawing) return;
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size >= 2 && pinch0.current) {
            // 双指捏合：以两指中点为锚缩放
            const [a, b] = [...pointers.current.values()];
            const dist = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
            const p = pinch0.current;
            const factor = p.dist / dist; // 张开→factor<1→根数变少（放大）
            setRange(() => {
              const c1 = clamp(Math.round(p.c * factor), MIN_BARS, Math.max(n, MIN_BARS));
              const s1 = clamp(Math.round(p.mid - (p.mid - p.s) * (c1 / p.c)), 0, Math.max(0, n - c1));
              return { s: s1, c: c1 };
            });
          } else if (pointers.current.size === 1) {
            // 单指/鼠标拖动：左右平移
            // setRange 的更新函数是延迟执行的，这里必须在同步代码里把 drag0 捕获到局部变量，
            // 否则指针抬起后 drag0.current 被清空，更新函数里读 .s 会抛 TypeError
            const d0 = drag0.current;
            const rect = svgRef.current?.getBoundingClientRect();
            if (!d0 || !rect) return;
            const dxSlots = Math.round(((e.clientX - d0.x) / rect.width) * W / step);
            setRange(() => ({ s: clamp(d0.s - dxSlots, 0, Math.max(0, n - eff.c)), c: eff.c }));
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch0.current = null;
          if (pointers.current.size === 0) drag0.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch0.current = null;
          drag0.current = null;
        }}
      >
        {ticks.map(gridLine)}

        {/* 趋势通道：最近 60 根的高点/低点双回归，向右前方投射；与可视窗口相交才绘制 */}
        {showChannel && n >= 20 && (() => {
          const win = Math.min(60, n);
          const seg = candles.slice(n - win);
          const hi = linReg(seg.map((c) => c.h));
          const lo = linReg(seg.map((c) => c.l));
          const fullStart = n - win;
          const fullEnd = n - 1 + FUTURE;
          const from = Math.max(fullStart, eff.s);
          const to = Math.min(fullEnd, eff.s + eff.c - 1 + (atEnd ? FUTURE : 0));
          if (to <= from) return null;
          const k = (fullIdx: number) => fullIdx - (n - win);
          return (
            <g opacity="0.95">
              <line x1={x(from)} y1={y(hi.a * k(from) + hi.b)} x2={x(to)} y2={y(hi.a * k(to) + hi.b)} stroke="#facc15" strokeWidth="1.6" opacity="0.9" />
              <line x1={x(from)} y1={y(lo.a * k(from) + lo.b)} x2={x(to)} y2={y(lo.a * k(to) + lo.b)} stroke="#a78bfa" strokeWidth="1.2" strokeDasharray="5 4" opacity="0.85" />
            </g>
          );
        })()}

        {/* 涨停 / 跌停 */}
        {limits && limitTag(limits.up, "涨停")}
        {limits && limitTag(limits.dn, "跌停")}

        {/* 蜡烛（只画可视窗口内） */}
        {vis.map((c, i) => {
          const fullIdx = eff.s + i;
          const up = c.c >= c.o;
          const color = up ? "#fb7185" : "#34d399";
          const top = y(Math.max(c.o, c.c));
          const h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
          return (
            <g key={fullIdx} opacity={hover == null || hover === fullIdx ? 1 : 0.82}>
              <line x1={x(fullIdx)} x2={x(fullIdx)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth="1" />
              <rect x={x(fullIdx) - bodyW / 2} y={top} width={bodyW} height={h} fill={up ? color : "transparent"} stroke={color} strokeWidth="1" />
            </g>
          );
        })}

        {/* 手绘图层 */}
        {enableDrawing && drawings.map(renderDrawing)}
        {enableDrawing && pending && hc && (
          <line x1={x(idxOfDate(pending.date))} y1={y(pending.price)} x2={x(hover!)} y2={y(hc.c)} stroke="#f0b90b" strokeWidth="1" strokeDasharray="4 3" opacity="0.85" />
        )}

        {/* 现价线（最后一根在可视范围内时绘制） */}
        {n - 1 >= eff.s && n - 1 < eff.s + eff.c && (() => {
          const xi = x(n - 1);
          return (
            <g>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(last.c)} y2={y(last.c)} stroke="#38bdf8" strokeWidth="0.9" strokeDasharray="2 3" opacity="0.9" />
              <rect x={W - PAD_R + 2} y={y(last.c) - 8} width={58} height={16} rx={3} fill="#38bdf8" />
              <text x={W - PAD_R + 6} y={y(last.c) + 4} fontSize="10.5" fill="#0b1220" fontWeight="700" fontFamily="ui-monospace, monospace">
                {last.c.toFixed(2)}
              </text>
              <circle cx={xi} cy={y(last.c)} r={Math.min(3, bodyW / 2)} fill="#38bdf8" />
            </g>
          );
        })()}

        {/* 十字光标 */}
        {hc && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} stroke="currentColor" className="text-muted-foreground" strokeWidth="0.7" strokeDasharray="4 3" />
            <line x1={PAD_L} x2={W - PAD_R} y1={y(hc.c)} y2={y(hc.c)} stroke="currentColor" className="text-muted-foreground" strokeWidth="0.7" strokeDasharray="4 3" />
          </g>
        )}
      </svg>

      {hc && (
        <div className="pointer-events-none absolute left-3 top-2 rounded-md border border-border bg-popover/95 px-2.5 py-1.5 font-mono text-[12px] leading-4 text-foreground shadow-lg">
          <span className="text-muted-foreground">开</span> {hc.o.toFixed(2)}
          <span className="ml-2 text-muted-foreground">高</span> {hc.h.toFixed(2)}
          <span className="ml-2 text-muted-foreground">低</span> {hc.l.toFixed(2)}
          <span className="ml-2 text-muted-foreground">收</span>
          <span className={hc.c >= hc.o ? "text-rose-400" : "text-emerald-400"}> {hc.c.toFixed(2)}</span>
          {hc.date && <span className="ml-2 text-muted-foreground">{hc.date}</span>}
        </div>
      )}
    </div>
  );
}
