"use client";
// 全A市场列表（需求文档 P0：真实全A快照 + 搜索/排序/分页）
import { useCallback, useEffect, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { fetchAllStocks, type AllStockRow } from "@/lib/desk/quant-api";
import { useDesk } from "@/lib/desk/store";
// P15-R16c：开盘自动重取 + 取数时刻上屏（这页原来只写「交易日」，没说这份快照是几点取的）
import { useLivePoll } from "@/hooks/use-live-poll";
import { clockZh } from "@/lib/desk/plain-core";
// P15-R16b 延伸：东财断源后「主力净额」整列显「—」——把数据看板那份通达信当日逐笔自算榜叠进来，
// 覆盖得到的显「自算」，覆盖不到的仍显「—」（绝不补 0，也不冒充全市场都有读数）
import { fetchBoardRows } from "@/lib/desk/market";
import { MAIN_FLOW_BASIS } from "@/lib/quant/screener/tdx-flow-core";
import { plainCode, codeTitle } from "@/lib/desk/code-format";

const SORTS: { key: string; label: string }[] = [
  { key: "amount_yi", label: "成交额" },
  { key: "change_pct", label: "涨跌幅" },
  { key: "turnover_rate", label: "换手率" },
  { key: "volume_ratio", label: "量比" },
  { key: "main_net_yi", label: "主力净额" },
  { key: "market_cap_yi", label: "总市值" },
  { key: "pe_ttm", label: "市盈率" },
  { key: "amplitude", label: "振幅" },
];

export default function AllStocksPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const addWatch = useDesk((s) => s.addWatch);
  const [q, setQ] = useState("");
  const [orderBy, setOrderBy] = useState("amount_yi");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AllStockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tradeDate, setTradeDate] = useState("");
  const [asOf, setAsOf] = useState("");
  const poll = useLivePoll();
  const pageSize = 50;
  // 通达信自算榜按 6 位代码建索引（服务端有 TTL 缓存，与数据看板共用同一份取数）
  const [flowByCode, setFlowByCode] = useState<Map<string, { main: number; truncated: boolean }>>(new Map());

  useEffect(() => {
    let dead = false;
    Promise.all([fetchBoardRows("stock", "in"), fetchBoardRows("stock", "out")])
      .then(([a, b]) => {
        if (dead) return;
        const m = new Map<string, { main: number; truncated: boolean }>();
        for (const r of [...a.rows, ...b.rows]) {
          if (r.mainSelfComputed && Number.isFinite(r.main)) m.set(r.code, { main: r.main, truncated: !!r.flowSampleTruncated });
        }
        setFlowByCode(m);
      })
      .catch(() => { if (!dead) setFlowByCode(new Map()); }); // 取不到就是没有：列退回全「—」，不缓存成 0
    return () => { dead = true; };
  }, [poll.tick]);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const r = await fetchAllStocks({ q, order_by: orderBy, dir, page, page_size: pageSize });
      setRows(r.list);
      setTotal(r.total);
      setTradeDate(r.trade_date);
      setAsOf(new Date().toISOString());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }, [q, orderBy, dir, page]);

  useEffect(() => { load(); }, [load, poll.tick]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };

  return (
    <div className="w-full space-y-3 px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-lg font-bold">全A市场列表</div>
          <div className="text-[12px] text-muted-foreground">
            东财榜单接口（全A快照） · 交易日 {tradeDate || "未知"} · {asOf ? `数据截至 ${clockZh(asOf)}` : "本次未取到数据"}
            {poll.open ? ` · 开盘自动刷新，剩余 ${poll.left}s` : ` · A股${poll.sessionLabel}，自动刷新已暂停`}
            {flowByCode.size > 0 && ` · 主力净额这一列东财无读数处叠了通达信自算 ${flowByCode.size} 只（${MAIN_FLOW_BASIS}），没覆盖到的显「—」不是 0`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="relative">
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
              placeholder="代码 / 名称 / 拼音"
              className="w-44 rounded-lg border border-border bg-card px-3 py-1.5 outline-none focus:border-sky-500/50"
            />
            <Search size={12} className="absolute right-2.5 top-2.5 text-muted-foreground" />
          </div>
          <select value={orderBy} onChange={(e) => { setOrderBy(e.target.value); setPage(1); }} className="rounded border border-border bg-background px-2 py-1.5">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))} className="rounded border border-border px-2 py-1.5">
            {dir === "desc" ? "↓ 降序" : "↑ 升序"}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {["代码", "名称", "行业", "最新价", "涨跌幅", "成交额(亿)", "换手%", "量比", "振幅%", "总市值(亿)", "PE", "PB", "主力净额(亿)", ""].map((h) => (
                <th key={h} className="px-2.5 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-b border-border/40 hover:bg-sky-500/5">
                <td className="cursor-pointer px-2.5 py-1.5 font-mono" title={codeTitle(r.symbol)} onClick={() => openProfile(r.symbol)}>{plainCode(r.symbol)}</td>
                <td className="cursor-pointer px-2.5 py-1.5" onClick={() => openProfile(r.symbol)}>
                  {r.name}{r.st && <span className="ml-1 text-[10px] text-red-400">ST</span>}{r.suspended && <span className="ml-1 text-[10px] text-muted-foreground">停</span>}
                </td>
                <td className="px-2.5 py-1.5 text-[11.5px] text-muted-foreground">{r.industry ?? "—"}</td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.price} /></td>
                <td className="px-2.5 py-1.5 text-right"><PctText value={r.change_pct} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.amount_yi} digits={1} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.turnover_rate} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.volume_ratio} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.amplitude} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.market_cap_yi} digits={0} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.pe_ttm} digits={1} /></td>
                <td className="px-2.5 py-1.5 text-right"><NumText value={r.pb} digits={1} /></td>
                <td className="px-2.5 py-1.5 text-right">
                  {r.main_net_yi == null ? (() => {
                    const f = flowByCode.get(String(r.symbol).split(".")[0]);
                    return f
                      ? <span className="font-mono tabular-nums" title={MAIN_FLOW_BASIS}>{`${f.main >= 0 ? "+" : ""}${f.main.toFixed(2)}`}<span className="ml-1 text-[10px] text-amber-300">{f.truncated ? "自算·截断" : "自算"}</span></span>
                      : <span className="text-muted-foreground">—</span>;
                  })() : <NumText value={r.main_net_yi} digits={2} />}
                </td>
                <td className="px-2.5 py-1.5">
                  <button onClick={() => addWatch({ symbol: r.symbol, name: r.name, kind: "watch" })}
                    className="text-[11px] text-muted-foreground hover:text-sky-300" title="加入自选">+自选</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !busy && (
              <tr><td colSpan={14} className="px-3 py-8 text-center text-muted-foreground">无结果</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{busy ? <Loader2 size={12} className="animate-spin" /> : `共 ${total} 只 · 第 ${page}/${pages} 页`}</span>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || busy} className="rounded border border-border p-1 disabled:opacity-40"><ChevronLeft size={13} /></button>
          <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages || busy} className="rounded border border-border p-1 disabled:opacity-40"><ChevronRight size={13} /></button>
        </div>
      </div>
    </div>
  );
}
