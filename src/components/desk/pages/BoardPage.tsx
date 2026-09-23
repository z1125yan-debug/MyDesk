"use client";
import { useEffect, useState } from "react";
import { fetchBoardRows, fetchDetailFor, type BoardKind } from "@/lib/desk/market";
import { useLivePoll } from "@/hooks/use-live-poll";
import LiveStamp from "@/components/desk/LiveStamp";
import { MAIN_FLOW_BASIS } from "@/lib/quant/screener/tdx-flow-core";
import { clockZh } from "@/lib/desk/plain-core";
import type { SectorDetail, SectorRow } from "@/lib/desk/types";
import BubbleFlow from "../BubbleFlow";

const TABS: { key: BoardKind; label: string }[] = [
  { key: "stock", label: "实时" },
  { key: "industry", label: "行业" },
  { key: "concept", label: "概念" },
  { key: "region", label: "地域" },
];

// 出身只认服务端给的真 source（P15-R16）：没有「演示数据」这一档了——没取到就说没取到。
const ORIGIN_LABEL: Record<"em" | "ths" | "tdx", string> = {
  em: "东财主力资金读数",
  ths: "同花顺板块资金流兜底榜（东财断源时的独立上游）",
  tdx: "通达信当日逐笔自算（东财断源时的替代口径）",
};

export default function BoardPage() {
  // R16c：轮询与「数据截至」交给全站共用的钩子/组件（休市暂停、开盘自恢复）
  const poll = useLivePoll();
  const [kind, setKind] = useState<BoardKind>("stock");
  const [dir, setDir] = useState<"in" | "out">("in");
  const [selected, setSelected] = useState<SectorRow | null>(null);
  const [rows, setRows] = useState<SectorRow[]>([]);
  const [origin, setOrigin] = useState<"em" | "ths" | "tdx" | null>(null);
  const [asOf, setAsOf] = useState("");
  const [quoteTime, setQuoteTime] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [detail, setDetail] = useState<SectorDetail | null>(null);
  const [detailSource, setDetailSource] = useState<"real" | "missing">("missing");
  const [showBubble, setShowBubble] = useState(true);
  const [flowIn, setFlowIn] = useState<SectorRow[]>([]);
  const [flowOut, setFlowOut] = useState<SectorRow[]>([]);

  useEffect(() => {
    let dead = false;
    setRowsLoading(true);
    fetchBoardRows(kind, dir)
      .then((r) => {
        if (dead) return;
        setRows(r.rows); setOrigin(r.origin); setAsOf(r.asOf); setQuoteTime(r.quoteTime);
      })
      .catch(() => { if (!dead) setRows([]); })
      .finally(() => { if (!dead) setRowsLoading(false); });
    return () => { dead = true; };
  }, [kind, dir, poll.tick]);

  useEffect(() => {
    let dead = false;
    // 资金流向图需要流入/流出双向数据（表格只展示当前方向；服务端有 TTL 缓存，重复请求无额外开销）
    fetchBoardRows(kind, "in").then((r) => { if (!dead) setFlowIn(r.rows); }).catch(() => {});
    fetchBoardRows(kind, "out").then((r) => { if (!dead) setFlowOut(r.rows); }).catch(() => {});
    return () => { dead = true; };
  }, [kind, poll.tick]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    // 腾讯兜底榜行（无资金读数）、同花顺兜底榜行（无东财资金明细）：没有可读的明细——直接空着，绝不落回演示数据。
    // 通达信自算行不一样：净额那一列是自算的，但东财的「近 14 日历史」这条接口还活着（实测 688825 拿得到 14 天真数），
    // 有 secid 就照取——不能因为榜单换源，把本来取到的明细也一并砍掉；两端口径不同源，下面按不同文案分开标注出身。
    if (selected.fundsMissing || selected.breakdownMissing || (selected.mainSelfComputed && !selected.secid)) { setDetail(null); return; }
    let dead = false;
    fetchDetailFor(selected.secid || "", selected.name, selected.code)
      .then((r) => { if (!dead) { setDetail(r.detail); setDetailSource(r.source); } })
      .catch(() => { if (!dead) setDetail(null); });
    return () => { dead = true; };
  }, [selected, poll.tick]);

  const sourceLabel = origin ? ORIGIN_LABEL[origin] : "没取到：当前榜单无可用数据源";
  const truncatedCount = rows.filter((r) => r.flowSampleTruncated).length;
  // 看板 tab 决定图上文案的单位：实时榜摆的是个股，行业/概念/地域榜摆的是板块，写死一个就是口径错。
  const unit = kind === "stock" ? "个股" : "板块";
  const asOfStamp = clockZh(asOf);
  const syncNote = poll.open
    ? `与上方榜单同步：每 ${poll.interval}s 换一批（第 ${poll.tick} 轮）`
    : `A股${poll.sessionLabel}，自动刷新已暂停——画面停在最后一次取到的时刻`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">数据看板</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            板块/个股资金流向榜与流向图 —— {sourceLabel}
            {asOfStamp && <span className="font-mono"> · 涨幅为当日（{asOfStamp.slice(0, 5)}）盘中读数</span>}
            {quoteTime && <span className="font-mono"> · 行情时刻 {quoteTime}</span>}
            {rows.length > 0 && rows.every((r) => r.fundsMissing) && "（当前为腾讯板块兜底榜：涨幅口径，无主力资金读数）"}
            {rows.length > 0 && rows.every((r) => r.breakdownMissing && !r.fundsMissing) && "（当前为同花顺板块资金流榜：东财断源时的独立兜底，净额=流入−流出，无净占比/超大单拆分）"}
            {rows.length > 0 && rows.some((r) => r.mainSelfComputed) && `（主力净额为${MAIN_FLOW_BASIS}；与东财官方口径不会逐分不差）`}
            {truncatedCount > 0 && `（其中 ${truncatedCount} 行逐笔样本未取满，已标样本截断）`}
          </p>
        </div>
        <LiveStamp poll={poll} iso={asOf} />
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
                  <th className="px-2 py-2.5 text-right font-normal">当日涨幅%</th>
                  <th className="px-2 py-2.5 text-right font-normal">
                    主力净额(亿){rows.some((r) => r.mainSelfComputed) && <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-300">自算</span>}
                  </th>
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
                      {r.fundsMissing || !Number.isFinite(r.main)
                        ? <span className="text-muted-foreground">—</span>
                        : <>{r.main >= 0 ? "+" : ""}{r.main.toFixed(2)}{r.flowSampleTruncated && <span className="ml-1 text-[10px] text-amber-300">截断</span>}</>}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                      {r.fundsMissing || r.breakdownMissing || !Number.isFinite(r.ratio) ? "—" : r.ratio.toFixed(1)}
                    </td>
                    <td className="hidden px-4 py-2.5 text-right text-muted-foreground md:table-cell">{r.leader || "—"}</td>
                  </tr>
                ))}
                {!rows.length && !rowsLoading && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">
                    没取到：{TABS.find((t) => t.key === kind)?.label}榜当前无可用数据源（不显示演示数据）
                  </td></tr>
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
                  {selected.code} · {selected.fundsMissing
                    ? "腾讯兜底榜（涨幅口径，无资金明细读数）"
                    : selected.breakdownMissing
                      ? "同花顺兜底榜（净额口径，无东财资金明细）"
                      : selected.mainSelfComputed
                        ? detailSource === "real"
                          ? "当日净额=通达信逐笔自算 · 近 14 日=东财历史（两端不同源，口径不逐分不差）"
                          : "通达信逐笔自算行 · 近 14 日明细没取到（东财断源，不画演示曲线）"
                        : detailSource === "real" ? "真实资金数据" : "近 14 日明细没取到（东财断源，不画演示曲线）"}
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

      {showBubble && (
        <div className="rounded-xl border border-border bg-card p-4">
          {/* 标题右侧常驻一行「同步状态」：这块图跟上面榜单同一个轮次刷新，休市就明说停在最后取到的时刻 */}
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13.5px] font-semibold">资金去向 · 主力净额前 8 名{unit}</div>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
              <span className={"inline-block h-1.5 w-1.5 rounded-full " + (poll.open ? "bg-emerald-400" : "bg-amber-400")} />
              <span>{syncNote}</span>
              {asOfStamp && <span>· 数据截至 {asOfStamp}</span>}
              {quoteTime && <span>· 行情时刻 {quoteTime}</span>}
            </div>
          </div>
          {flowIn.length === 0 && flowOut.length === 0 ? (
            <div className="py-3 text-[12px] text-muted-foreground">
              暂不可用：流入/流出两个方向都没取到榜单读数——不拿演示数据画流向。
            </div>
          ) : flowIn.length > 0 && flowIn.every((r) => r.fundsMissing) && flowOut.every((r) => r.fundsMissing) ? (
            <div className="py-3 text-[12px] text-muted-foreground">
              暂不可用：当前榜单来自腾讯板块兜底榜（涨幅口径），不含主力净额读数——不拿占位 0 画流向、不编造线宽。
            </div>
          ) : (
            <>
              <div className="mb-2 text-[12px] text-muted-foreground">
                粒子流向 = 资金去向：红 = 主力净流入{unit}（钱在进来），绿 = 主力净流出{unit}（钱在离开）；线宽与条长 = 净额大小，百分比 = 当日涨幅。悬停看全名明细，点击联动右侧资金明细。
                {flowIn.some((r) => r.mainSelfComputed) && `本图为${ORIGIN_LABEL.tdx}。`}
              </div>
              <BubbleFlow inRows={flowIn} outRows={flowOut} unitLabel={unit} onSelect={setSelected} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
