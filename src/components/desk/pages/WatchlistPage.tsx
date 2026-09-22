"use client";
// 自选股增强（P1-3）：自选实时行情列表（真实报价，/api/market/quote 既有封装）
// 交易计划区完整复用旧 TrackerPage（不改动其逻辑），作为本页下半区呈现。
// P14：①分组（对齐稳智 watchlist groups）——组只存在本机 store（自选本来就是浏览器存档，
//   不为此开服务端表）；删组只销组不丢票；组筛选下报价按「可见集合」取，截断如实说。
// ②行内「走势」展开——复用 Sparkline + 报价里已有的关键数，不再跳页才能瞄一眼；
//   完整分析页入口保留。spark 是分时口径就写分时，不冒充日K。
import { Fragment, useState, useEffect, useCallback, useMemo } from "react";
import { Target, Loader2, RefreshCw, Trash2, LineChart, ChevronDown, ChevronRight } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { LineageCard, LineageSection } from "../ui/LineageCard";
import Sparkline from "../Sparkline";
import TrackerPage from "./TrackerPage";
import { useDesk } from "@/lib/desk/store";
// P14：视图过滤与 store 的建/删/移同住纯核，页面不自己抄一份 filter 语义
import { filterWatchlist } from "@/lib/desk/watchlist-group-core";

interface QuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  amountYi?: number | null;
  time?: string;
  spark?: number[] | null;
  missing?: boolean;
}

const BATCH = 30; // /api/market/quote 单次上限（既有路由 slice(0,30)）

const selectCls = "h-7 rounded-md border border-border bg-background px-2 text-[12px]";

export default function WatchlistPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const watchlist = useDesk((s) => s.watchlist);
  const removeWatch = useDesk((s) => s.removeWatch);
  const groups = useDesk((s) => s.watchlistGroups);
  const addWatchGroup = useDesk((s) => s.addWatchGroup);
  const removeWatchGroup = useDesk((s) => s.removeWatchGroup);
  const moveWatch = useDesk((s) => s.moveWatch);

  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  // 分组视图：all=全部 · none=未分组 · 其余为组 id
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [newGroup, setNewGroup] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null); // 行内展开的品种

  const visible = useMemo(
    () => filterWatchlist(watchlist, groupFilter as "all" | "none" | string),
    [watchlist, groupFilter],
  );
  const countOf = (pred: (g: string | null | undefined) => boolean) => watchlist.filter((w) => pred(w.groupId)).length;

  const load = useCallback(async () => {
    if (!visible.length) { setRows([]); return; }
    setBusy(true); setError("");
    try {
      const symbols = visible.slice(0, BATCH).map((w) => w.symbol);
      const res = await fetch(`/api/market/quote?symbols=${encodeURIComponent(symbols.join(","))}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "报价获取失败");
      const quotes: (Partial<QuoteRow> | null)[] = j.quotes ?? [];
      const merged: QuoteRow[] = symbols.map((sym, i) => {
        const q = quotes[i];
        const w = watchlist.find((x) => x.symbol === sym);
        if (!q || q.price === undefined || q.price === null) {
          return { symbol: sym, name: w?.name ?? sym, price: null, changePct: null, missing: true };
        }
        return {
          symbol: sym, name: q.name ?? w?.name ?? sym,
          price: q.price, changePct: q.changePct ?? null,
          high: q.high, low: q.low, prevClose: q.prevClose, amountYi: q.amountYi, time: q.time,
          spark: q.spark && q.spark.length > 1 ? q.spark : null,
        };
      });
      setRows(merged);
      setUpdatedAt(new Date().toTimeString().slice(0, 8));
    } catch (e) {
      setError(String((e as Error).message || e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [visible, watchlist]);

  useEffect(() => { load(); }, [load]);

  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  const openAnalysis = (symbol: string) => { setFocusSymbol(symbol); go("analysis"); };

  const createGroup = () => {
    const id = addWatchGroup(newGroup);
    if (id) { setNewGroup(""); setGroupFilter(id); } // 建完直接切进新组，用户立刻能往里挪票
  };

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
      {/* P15-R3c 血缘收口：标题块/分组工具条/表卡三块散摆收成一张卡——
          工具条是本卡的控制面板，表是它的正文，不该各套各的边框。交易计划区仍是独立一页逻辑，留在卡外。 */}
      <LineageCard
        title={<span className="flex items-center gap-2"><Target size={17} className="text-sky-400" />自选股行情</span>}
        note={
          <>
            真实报价（eltdx/腾讯优先）· 取不到显示暂无数据 · {updatedAt ? `更新 ${updatedAt}` : ""}
            {visible.length > BATCH ? ` · 当前视图 ${visible.length} 只，仅取前 ${BATCH} 只报价（接口单次上限，其余未取）` : ""}
          </>
        }
        actions={
          <button onClick={load} disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        }
      >
        {/* P14 分组工具条：过滤下拉 + 新建组 + （选中某组时）删组。组是本机管理视图，不是数据源 */}
        <LineageSection title="自选列表" hint="分组是本机管理视图 · 删组退回未分组不丢票" divided={false}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
        <select className={selectCls} value={groupFilter} onChange={(e) => { setGroupFilter(e.target.value); setExpanded(null); }}
          title="按分组过滤自选列表（只影响视图，不动任何成员关系）">
          <option value="all">全部（{watchlist.length}）</option>
          <option value="none">未分组（{countOf((g) => !g)}）</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}（{countOf((x) => x === g.id)}）</option>
          ))}
        </select>
        <input className={selectCls + " w-32"} placeholder="新分组名" value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") createGroup(); }} />
        <button onClick={createGroup} disabled={!newGroup.trim()}
          className="rounded-md border border-border px-2 py-1 text-[12px] hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-40">建组</button>
        {groups.some((g) => g.id === groupFilter) && (
          <button
            onClick={() => { const id = groupFilter; setGroupFilter("all"); removeWatchGroup(id); }}
            title="删除该组：组内股票全部退回未分组，不会删掉任何自选"
            className="rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground hover:border-rose-500/40 hover:text-rose-300">
            删组（股票退回未分组）
          </button>
        )}
      </div>

      {error && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {!watchlist.length && (
        <div className="px-6 py-10 text-center text-sm text-muted-foreground">
          还没有自选股 · 在「全A列表」或「个股画像」页点「+自选」添加
        </div>
      )}

      {watchlist.length > 0 && !visible.length && (
        <div className="px-6 py-8 text-center text-sm text-muted-foreground">
          {groupFilter === "none" ? "所有自选都分了组 · 「未分组」现在没有票" : `组「${groupName(groupFilter)}」里还没有票 · 在行右侧「移入」里挑一只进来`}
        </div>
      )}

      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                {["", "代码", "名称", "分组", "现价", "涨跌幅", "昨收", "今高", "今低", "成交额(亿)", "分时", "操作"].map((h) => (
                  <th key={h || "#"} className="px-3 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const w = watchlist.find((x) => x.symbol === r.symbol);
                const isOpen = expanded === r.symbol;
                return (<Fragment key={r.symbol}>
                  <tr className="border-b border-border/40 hover:bg-sky-500/5">
                    <td className="w-7 pl-2">
                      <button title={isOpen ? "收起行内走势" : "展开行内走势（分时口径，复用迷你走势线）"}
                        onClick={() => setExpanded(isOpen ? null : r.symbol)}
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-sky-300">
                        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 font-mono cursor-pointer" onClick={() => openProfile(r.symbol)}>{r.symbol}</td>
                    <td className="px-3 py-1.5 cursor-pointer" onClick={() => openProfile(r.symbol)}>{r.name}</td>
                    <td className="px-3 py-1.5">
                      <select className={selectCls + " max-w-24"} value={w?.groupId ?? ""} title="移入/移出分组（只挪成员关系，不删票）"
                        onChange={(e) => moveWatch(r.symbol, e.target.value || null)}>
                        <option value="">未分组</option>
                        {groups.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-right">{r.missing ? <span className="text-muted-foreground">暂无数据</span> : <NumText value={r.price} />}</td>
                    <td className="px-3 py-1.5 text-right">{r.missing ? <span className="text-muted-foreground">—</span> : <PctText value={r.changePct} />}</td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.prevClose ?? null} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.high ?? null} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.low ?? null} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.amountYi ?? null} digits={1} /></td>
                    <td className="px-3 py-1.5">
                      {r.spark && r.spark.length > 1
                        ? <Sparkline data={r.spark} up={(r.changePct ?? 0) >= 0} width={90} height={22} />
                        : <span className="text-[10px] text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1">
                        <button title="AI 分析" onClick={() => openAnalysis(r.symbol)}
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-sky-300"><LineChart size={13} /></button>
                        <button title="移出自选" onClick={() => removeWatch(r.symbol)}
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-rose-400"><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-border/40 bg-accent/20">
                      <td colSpan={12} className="px-4 py-2.5">
                        {r.spark && r.spark.length > 1 ? (
                          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                            <Sparkline data={r.spark} up={(r.changePct ?? 0) >= 0} width={260} height={44} />
                            <span className="text-muted-foreground">现价 <NumText value={r.price} /></span>
                            <span className="text-muted-foreground">涨跌 <PctText value={r.changePct} /></span>
                            <span className="text-muted-foreground">昨收 <NumText value={r.prevClose ?? null} /></span>
                            <span className="text-muted-foreground">今高 <NumText value={r.high ?? null} /></span>
                            <span className="text-muted-foreground">今低 <NumText value={r.low ?? null} /></span>
                            <span className="text-muted-foreground">成交额 {r.amountYi != null ? `${r.amountYi.toFixed(1)} 亿` : "—"}</span>
                            <span className="text-[10.5px] text-muted-foreground/80">分时口径（报价接口随带分时线 · 日K请看完整分析页）</span>
                            <button onClick={() => openAnalysis(r.symbol)} className="text-sky-400 hover:underline">打开完整分析 →</button>
                          </div>
                        ) : (
                          <span className="text-[12px] text-muted-foreground">
                            分时线暂无数据（报价源未返回该票分时，不以直线冒充）
                            <button onClick={() => openAnalysis(r.symbol)} className="ml-2 text-sky-400 hover:underline">打开完整分析 →</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>);
              })}
              {!rows.length && !busy && !error && (
                <tr><td colSpan={12} className="px-3 py-8 text-center text-muted-foreground">暂无数据（报价源未返回）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
        </LineageSection>
      </LineageCard>

      {/* 交易计划区：完整复用旧追踪页 */}
      <div className="border-t border-border pt-2">
        <TrackerPage />
      </div>
    </div>
  );
}

