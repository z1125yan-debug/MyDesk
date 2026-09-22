"use client";
import { useEffect, useRef, useState } from "react";
import { useDesk } from "@/lib/desk/store";
import { fetchBoardRows, fetchDetailFor, type BoardKind } from "@/lib/desk/market";
import { useMarketSession } from "@/hooks/use-market-session";
import type { SectorDetail, SectorRow } from "@/lib/desk/types";
import BubbleFlow from "../BubbleFlow";

const TABS: { key: BoardKind; label: string }[] = [
  { key: "stock", label: "实时" },
  { key: "industry", label: "行业" },
  { key: "concept", label: "概念" },
  { key: "region", label: "地域" },
];

export default function BoardPage() {
  const refreshInterval = useDesk((s) => s.refreshInterval);
  const session = useMarketSession();
  const openRef = useRef(session.open);
  openRef.current = session.open;
  const [kind, setKind] = useState<BoardKind>("stock");
  const [dir, setDir] = useState<"in" | "out">("in");
  const [tick, setTick] = useState(0);
  const [left, setLeft] = useState(refreshInterval);
  const [selected, setSelected] = useState<SectorRow | null>(null);
  const [rows, setRows] = useState<SectorRow[]>([]);
  const [source, setSource] = useState<"real" | "demo">("demo");
  const [rowsLoading, setRowsLoading] = useState(true);
  const [detail, setDetail] = useState<SectorDetail | null>(null);
  const [detailSource, setDetailSource] = useState<"real" | "demo">("real");
  const [showBubble, setShowBubble] = useState(true);
  const [flowIn, setFlowIn] = useState<SectorRow[]>([]);
  const [flowOut, setFlowOut] = useState<SectorRow[]>([]);

  useEffect(() => {
    const t = setInterval(() => {
      // 非交易时段上游不会有新数据：暂停倒计时与自动刷新
      if (!openRef.current) return;
      setLeft((v) => {
        if (v <= 1) { setTick((n) => n + 1); return refreshInterval; }
        return v - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [refreshInterval]);

  useEffect(() => {
    let dead = false;
    setRowsLoading(true);
    fetchBoardRows(kind, dir)
      .then((r) => { if (!dead) { setRows(r.rows); setSource(r.source); } })
      .catch(() => { if (!dead) setRows([]); })
      .finally(() => { if (!dead) setRowsLoading(false); });
    return () => { dead = true; };
  }, [kind, dir, tick]);

  useEffect(() => {
    let dead = false;
    // 资金流向图需要流入/流出双向数据（表格只展示当前方向；服务端有 TTL 缓存，重复请求无额外开销）
    fetchBoardRows(kind, "in").then((r) => { if (!dead) setFlowIn(r.rows); }).catch(() => {});
    fetchBoardRows(kind, "out").then((r) => { if (!dead) setFlowOut(r.rows); }).catch(() => {});
    return () => { dead = true; };
  }, [kind, tick]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    // 腾讯兜底榜行（无资金读数）与同花顺兜底榜行（无东财 secid）：都没有东财资金明细可读——
    // 直接空着，绝不落回演示数据
    if (selected.fundsMissing || selected.breakdownMissing) { setDetail(null); return; }
    let dead = false;
    fetchDetailFor(selected.secid || "", selected.name, selected.code)
      .then((r) => { if (!dead) { setDetail(r.detail); setDetailSource(r.source); } })
      .catch(() => { if (!dead) setDetail(null); });
    return () => { dead = true; };
  }, [selected, tick]);

  const sourceLabel = source === "real" ? "本机直连公开接口" : "演示数据（数据源暂不可用）";

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold">数据看板</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            板块/个股资金流向榜与流向图 —— {sourceLabel}
            {rows.length > 0 && rows.every((r) => r.fundsMissing) && "（当前为腾讯板块兜底榜：涨幅口径，无主力资金读数）"}
            {rows.length > 0 && rows.every((r) => r.breakdownMissing && !r.fundsMissing) && "（当前为同花顺板块资金流榜：东财断源时的独立兜底，净额=流入−流出，无净占比/超大单拆分）"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!session.open && (
            <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[12px] text-amber-300">
              A股{session.label} · 自动刷新已暂停
            </span>
          )}
          <span className="rounded-md border border-border px-2.5 py-1 font-mono text-[12px] text-muted-foreground">
            刷新 #{tick} · 剩余 {left}s
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex rounded-md border border-border p-0.5">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => { setKind(t.key); setSelected(null); }}
                className={"rounded px-3 py-1.5 text-[12.5px] transition-colors " + (kind === t.key ? "bg-sky-500/15 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-md border border-border p-0.5">
            <button onClick={() => setDir("in")}
              className={"rounded px-3 py-1.5 text-[12.5px] " + (dir === "in" ? "bg-rose-500/15 font-medium text-rose-300" : "text-muted-foreground hover:text-foreground")}>
              流入
            </button>
            <button onClick={() => setDir("out")}
              className={"rounded px-3 py-1.5 text-[12.5px] " + (dir === "out" ? "bg-emerald-500/15 font-medium text-emerald-300" : "text-muted-foreground hover:text-foreground")}>
              流出
            </button>
          </div>
          <button onClick={() => setShowBubble((v) => !v)}
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
            {showBubble ? "隐藏气泡图" : "显示气泡图"}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1fr_320px]">
          <div className="desk-scroll max-h-[520px] overflow-y-auto">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-2.5 font-normal">排名</th>
                  <th className="px-2 py-2.5 font-normal">{kind === "stock" ? "股票" : "板块"}</th>
                  <th className="px-2 py-2.5 text-right font-normal">涨跌%</th>
                  <th className="px-2 py-2.5 text-right font-normal">主力净额(亿)</th>
                  <th className="px-2 py-2.5 text-right font-normal">占比%</th>
                  <th className="hidden px-4 py-2.5 text-right font-normal md:table-cell">{kind === "stock" ? "所属行业" : "领涨股"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.code + r.name}
                    onClick={() => setSelected(r)}
                    className={"cursor-pointer border-b border-border/50 transition-colors hover:bg-accent/60 " + (selected?.code === r.code && selected?.name === r.name ? "bg-sky-500/8" : "")}>
                    <td className="px-4 py-2.5 font-mono text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-2.5">
                      <div className="font-medium">{r.name}</div>
                      <div className="font-mono text-[10.5px] text-muted-foreground">{r.code}</div>
                    </td>
                    <td className={"px-2 py-2.5 text-right font-mono tabular-nums " + (r.changePct >= 0 ? "text-rose-400" : "text-emerald-400")}>
                      {r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}
                    </td>
                    <td className={"px-2 py-2.5 text-right font-mono tabular-nums " + (r.main >= 0 ? "text-rose-400" : "text-emerald-400")}>
                      {r.fundsMissing ? <span className="text-muted-foreground">—</span> : `${r.main >= 0 ? "+" : ""}${r.main.toFixed(2)}`}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r.fundsMissing || r.breakdownMissing ? "—" : r.ratio.toFixed(1)}</td>
                    <td className="hidden px-4 py-2.5 text-right text-muted-foreground md:table-cell">{r.leader}</td>
                  </tr>
                ))}
                {!rows.length && !rowsLoading && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">暂无数据</td></tr>
                )}
                {rowsLoading && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">加载中…</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="border-t border-border p-4 lg:border-l lg:border-t-0">
            {selected && (
              <div>
                <div className="flex items-center justify-between">
                  <div className="text-[14px] font-semibold">{selected.name}</div>
                  <span className={"font-mono text-[12.5px] " + (selected.changePct >= 0 ? "text-rose-400" : "text-emerald-400")}>
                    {selected.changePct >= 0 ? "+" : ""}{selected.changePct.toFixed(2)}%
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {selected.code} · {selected.fundsMissing ? "腾讯兜底榜（涨幅口径，无资金明细读数）" : selected.breakdownMissing ? "同花顺兜底榜（净额口径，无东财资金明细）" : detailSource === "real" ? "真实资金数据" : "演示数据"}
                </div>

                {detail && detail.spark.length > 1 && (
                  <>
                    <div className="mt-3.5 text-[12px] text-muted-foreground">日内走势</div>
                    <svg viewBox="0 0 280 56" className="mt-1 w-full">
                      {(() => {
                        const min = Math.min(...detail.spark), max = Math.max(...detail.spark);
                        const span = max - min || 1;
                        const pts = detail.spark.map((v, i) => `${(i * 280 / (detail.spark.length - 1)).toFixed(1)},${(52 - ((v - min) / span) * 46).toFixed(1)}`).join(" ");
                        const color = detail.spark[detail.spark.length - 1] >= detail.spark[0] ? "#fb7185" : "#34d399";
                        return <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" />;
                      })()}
                    </svg>
                  </>
                )}

                {detail && detail.days.length > 0 && (
                  <>
                    <div className="mt-3.5 text-[12px] text-muted-foreground">近 14 日主力净额(亿)</div>
                    <div className="mt-1.5 space-y-1.5">
                      {detail.days.map((d) => {
                        const w = Math.min(92, Math.abs(d.value) * 9);
                        return (
                          <div key={d.date} className="flex items-center gap-2 text-[11px]">
                            <span className="w-[74px] font-mono text-muted-foreground">{d.date.slice(5)}</span>
                            <div className="h-2.5 flex-1 rounded-sm bg-accent/60">
                              <div className={"h-2.5 rounded-sm " + (d.value >= 0 ? "bg-rose-400/80" : "bg-emerald-400/80")} style={{ width: `${w}%` }} />
                            </div>
                            <span className={"w-12 text-right font-mono " + (d.value >= 0 ? "text-rose-400" : "text-emerald-400")}>
                              {d.value.toFixed(1)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            {!selected && (
              <div className="flex h-full min-h-[220px] items-center justify-center text-center text-[12.5px] text-muted-foreground">
                点击左侧榜单任意一行
                <br />查看资金明细联动
              </div>
            )}
          </div>
        </div>
      </div>

      {showBubble && (flowIn.length > 0 && flowIn.every((r) => r.fundsMissing) && flowOut.every((r) => r.fundsMissing) ? (
        <div className="rounded-xl border border-border bg-card p-4 text-[12px] text-muted-foreground">
          资金流向图暂不可用：当前榜单来自腾讯板块兜底榜（涨幅口径），不含主力净额读数——不拿占位 0 画流向、不编造线宽。
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-1 text-[13.5px] font-semibold">资金流向图 · 主力净额 TOP8</div>
          <div className="mb-2 text-[12px] text-muted-foreground">
            粒子流向 = 资金去向：红 = 主力净流入个股，绿 = 主力净流出个股；线宽与条长 = 净额大小。悬停查看明细，点击联动右侧资金明细。
          </div>
          <BubbleFlow inRows={flowIn} outRows={flowOut} onSelect={setSelected} />
        </div>
      ))}
    </div>
  );
}
