"use client";
// 港股 / 美股选股：与 A 股选股同款五件套（选股筛选、宽度、分歧、事件、AI 优选），
// 但数据只用港股 / 美股自己的（长桥 MCP；美股长桥未接通时回退 Yahoo）。
// 口径：票池 = 20 只主流票（非全市场）；换手率/主力净额/市值/PB 长桥没有，恒显「—」。
import { useCallback, useEffect, useState } from "react";
import { Search, Loader2, Sparkles, X, Plus } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";

const OPS = ["=", ">=", ">", "<=", "<", "!="] as const;

interface Cond { field: string; op: string; value: number }
interface Row {
  symbol: string; name: string; price: number | null; change_pct: number | null;
  amount_yi: number | null; pe_ttm: number | null; ret_20: number | null; ret_60: number | null;
  rsi_14: number | null; volume_ratio: number | null; rps_20: number | null;
  above_ma5: number | null; above_ma20: number | null; above_ma60: number | null;
  bars_count: number;
}
interface Resp {
  ok: boolean; available: boolean; reason?: string; source: string; trade_date: string;
  funnel: { universe: number; with_data: number; filtered: number };
  list: Row[]; total: number;
  breadth: { pool: string; above_ma5_pct: number | null; above_ma5: number | null; new_low_5: number | null; new_low_3: number | null; latest_date: string | null; advancers: number; decliners: number; flat: number; median_change_pct: number | null; caliber: string } | null;
  divergence: { kind: string; divergent: boolean; plain: string; missing: string | null }[];
  events: { symbol: string; name: string; title: string; time: string | null; source: string | null; url: string | null }[];
  ai_pick: { symbol: string; name: string; score: number; price: number | null; change_pct: number | null; reasons: string[]; divergence: string; warnings: string[] }[];
  warnings: string[]; unavailable_fields: { field: string; zh: string }[]; missing: string[];
  fields: { field: string; zh: string }[];
}

const PRESET: Record<string, { op: string; value: number }> = {
  change_pct: { op: ">=", value: 0 },
  amount_yi: { op: ">=", value: 1 },
  pe_ttm: { op: "<=", value: 30 },
  ret_20: { op: ">=", value: 0 },
  ret_60: { op: ">=", value: 0 },
  rsi_14: { op: "<=", value: 70 },
  volume_ratio: { op: ">=", value: 1 },
  amplitude: { op: ">=", value: 2 },
  rps_20: { op: ">=", value: 60 },
  above_ma5: { op: "=", value: 1 },
  above_ma20: { op: "=", value: 1 },
  above_ma60: { op: "=", value: 1 },
};

export default function HkUsScreener({ market }: { market: "HK" | "US" }) {
  const label = market === "HK" ? "港股" : "美股";
  const [conds, setConds] = useState<Cond[]>([]);
  const [cField, setCField] = useState("change_pct");
  const [cOp, setCOp] = useState<string>(">=");
  const [cVal, setCVal] = useState("0");
  const [sortBy, setSortBy] = useState("amount_yi");
  const [resp, setResp] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<{ field: string; zh: string }[]>([]);

  const run = useCallback(async (cs: Cond[]) => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/market/hk-us/screener", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, conditions: cs, sort_by: sortBy, limit: 50 }),
      });
      const j = (await r.json()) as Resp;
      if (!r.ok || !j.ok) throw new Error((j as unknown as { error?: string }).error || "选股失败");
      setResp(j);
      if (j.fields?.length) setFields(j.fields);
    } catch (e) {
      setError(String((e as Error).message || e));
      setResp(null);
    } finally { setBusy(false); }
  }, [market, sortBy]);

  useEffect(() => { setConds([]); setResp(null); void run([]); }, [market, run]);

  const addCond = () => {
    const v = Number(cVal);
    if (!Number.isFinite(v)) return;
    if (conds.some((c) => c.field === cField)) return;
    const next = [...conds, { field: cField, op: cOp, value: v }];
    setConds(next);
    void run(next);
  };

  const fieldZh = (f: string) => fields.find((x) => x.field === f)?.zh ?? f;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[23px] font-semibold tracking-tight">{label}选股</h1>
        <p className="mt-1 text-[14px] text-muted-foreground">
          与 A 股选股同款：筛选、宽度、分歧、事件、AI 优选都在这一页；数据只用{label}自己的
          （{market === "HK" ? "长桥 MCP 港股" : "长桥 MCP 美股，未接通时回退 Yahoo"}）· 票池 20 只主流票，非全市场 · 美股无涨跌停。
        </p>
      </div>

      {/* 条件区 */}
      <div className="apple-card p-5">
        <div className="mb-2 text-[13px] font-medium text-muted-foreground/80">加条件（点标签即加入默认条件，可改数值）</div>
        <div className="flex flex-wrap gap-1.5">
          {(fields.length ? fields : Object.keys(PRESET).map((f) => ({ field: f, zh: f }))).map((f) => {
            const active = conds.some((c) => c.field === f.field);
            return (
              <button
                key={f.field}
                onClick={() => {
                  if (active) { const next = conds.filter((c) => c.field !== f.field); setConds(next); void run(next); return; }
                  const p = PRESET[f.field] ?? { op: ">=", value: 0 };
                  const next = [...conds, { field: f.field, op: p.op, value: p.value }];
                  setConds(next); void run(next);
                }}
                className={"rounded-full border px-3.5 py-1.5 text-[13.5px] " + (active ? "border-sky-400/50 bg-sky-400/15 text-sky-200" : "border-border/70 bg-overlay text-muted-foreground hover:text-foreground")}
              >
                {f.zh}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13.5px]">
          <select value={cField} onChange={(e) => setCField(e.target.value)} className="rounded-lg border border-border/70 bg-overlay px-2.5 py-1.5 text-[13px]">
            {fields.map((f) => <option key={f.field} value={f.field}>{f.zh}</option>)}
          </select>
          <select value={cOp} onChange={(e) => setCOp(e.target.value)} className="rounded-lg border border-border/70 bg-overlay px-2.5 py-1.5 text-[13px]">
            {OPS.map((o) => <option key={o}>{o}</option>)}
          </select>
          <input value={cVal} onChange={(e) => setCVal(e.target.value)} className="w-20 rounded-lg border border-border/70 bg-overlay px-2.5 py-1.5 text-[13px]" />
          <button onClick={addCond} className="flex items-center gap-1 rounded-full bg-overlay-strong px-3 py-1.5 text-[13px]"><Plus size={13} /> 加入</button>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="rounded-full border border-border/70 bg-overlay px-3 py-2 text-[13.5px] text-muted-foreground">
            {fields.map((f) => <option key={f.field} value={f.field}>按{f.zh}</option>)}
          </select>
          <button onClick={() => void run(conds)} disabled={busy} className="apple-primary-btn flex items-center gap-2 px-5 py-2 text-[14px] font-medium">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} 开始筛选
          </button>
          {resp && <span className="text-[13.5px] text-muted-foreground">共 {resp.total} 只 · 取到报价 {resp.funnel.with_data}/{resp.funnel.universe} · 来源 {resp.source || "—"}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {conds.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-400/10 py-1 pl-3 pr-2 text-[13.5px] text-sky-100">
              {fieldZh(c.field)} {c.op} {c.value}
              <button onClick={() => { const next = conds.filter((_, k) => k !== i); setConds(next); void run(next); }} className="rounded-full p-0.5 opacity-60 hover:opacity-100"><X size={12} /></button>
            </span>
          ))}
        </div>
        {error && <div className="mt-3 rounded-xl border border-red-400/25 bg-red-400/10 px-3.5 py-2.5 text-[14px] text-red-300">{error}</div>}
        {resp && !resp.available && <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3.5 py-2.5 text-[14px] text-amber-300/90">{resp.reason || "暂无数据"}</div>}
      </div>

      {resp?.available && (
        <>
          {resp.unavailable_fields.length > 0 && (
            <div className="apple-card border-amber-500/30 bg-amber-500/[0.06] px-5 py-3.5 text-[14px] leading-relaxed">
              <span className="font-medium text-amber-200">以下条件因长桥 MCP 无此数据被忽略，本次未按它们筛选：</span>
              <span className="text-amber-200/90"> {resp.unavailable_fields.map((x) => x.zh).join("、")}</span>
              <div className="mt-1 text-[13.5px] text-muted-foreground">长桥不给换手率/主力净额/市值/PB/流通市值——这些列显「—」，不是 0，也不用 A 股数据顶包。</div>
            </div>
          )}
          {resp.warnings.map((w, i) => (
            <div key={i} className="rounded-lg border border-border/60 px-4 py-2 text-[13px] text-muted-foreground">{w}</div>
          ))}

          {/* 选股结果 */}
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border text-left text-muted-foreground">
                {["代码", "名称", "最新价", "涨跌幅", "成交额(亿)", "PE", "近20日", "近60日", "RSI", "量比", "RPS", "5日线", "20日线", "60日线"].map((h) => <th key={h} className="px-2.5 py-2">{h}</th>)}
              </tr></thead>
              <tbody>
                {resp.list.map((r) => (
                  <tr key={r.symbol} className="border-b border-border/40">
                    <td className="px-2.5 py-1.5 font-mono">{r.symbol}</td>
                    <td className="px-2.5 py-1.5">{r.name}</td>
                    <td className="px-2.5 py-1.5 text-right"><NumText value={r.price} /></td>
                    <td className="px-2.5 py-1.5 text-right"><PctText value={r.change_pct} /></td>
                    <td className="px-2.5 py-1.5 text-right"><NumText value={r.amount_yi} digits={1} /></td>
                    <td className="px-2.5 py-1.5 text-right"><NumText value={r.pe_ttm} digits={1} /></td>
                    <td className="px-2.5 py-1.5 text-right"><PctText value={r.ret_20} /></td>
                    <td className="px-2.5 py-1.5 text-right"><PctText value={r.ret_60} /></td>
                    <td className="px-2.5 py-1.5 text-right"><NumText value={r.rsi_14} digits={0} /></td>
                    <td className="px-2.5 py-1.5 text-right"><NumText value={r.volume_ratio} digits={2} /></td>
                    <td className="px-2.5 py-1.5 text-right"><NumText value={r.rps_20} digits={0} /></td>
                    <td className="px-2.5 py-1.5 text-center">{r.above_ma5 == null ? "—" : r.above_ma5 === 1 ? "站上" : "跌破"}</td>
                    <td className="px-2.5 py-1.5 text-center">{r.above_ma20 == null ? "—" : r.above_ma20 === 1 ? "站上" : "跌破"}</td>
                    <td className="px-2.5 py-1.5 text-center">{r.above_ma60 == null ? "—" : r.above_ma60 === 1 ? "站上" : "跌破"}</td>
                  </tr>
                ))}
                {resp.list.length === 0 && <tr><td colSpan={14} className="px-3 py-8 text-center text-muted-foreground">没有符合条件的股票，试试放宽条件。</td></tr>}
              </tbody>
            </table>
          </div>

          {/* 宽度 */}
          {resp.breadth && (
            <div className="apple-card p-5">
              <div className="mb-2 text-[15px] font-semibold">宽度 · {resp.breadth.pool}</div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[14px]">
                <span>上涨 {resp.breadth.advancers} · 平盘 {resp.breadth.flat} · 下跌 {resp.breadth.decliners}</span>
                <span>中位涨跌 <PctText value={resp.breadth.median_change_pct} /></span>
                <span>站上5日线 {resp.breadth.above_ma5 ?? "—"} 只{resp.breadth.above_ma5_pct != null ? `（${resp.breadth.above_ma5_pct.toFixed(1)}%）` : ""}</span>
                <span>创5日新低 {resp.breadth.new_low_5 ?? "—"} 只 · 创3日新低 {resp.breadth.new_low_3 ?? "—"} 只</span>
                <span className="text-muted-foreground">最新日 {resp.breadth.latest_date ?? "—"}</span>
              </div>
              <div className="mt-2 text-[12.5px] text-muted-foreground">{resp.breadth.caliber}</div>
            </div>
          )}

          {/* 分歧 */}
          <div className="apple-card p-5">
            <div className="mb-2 text-[15px] font-semibold">分歧</div>
            <div className="space-y-2">
              {resp.divergence.map((d) => (
                <div key={d.kind} className="text-[14px] leading-relaxed">
                  <span className={`mr-2 rounded border px-1.5 py-0.5 text-[12px] ${d.divergent ? "border-red-400/40 text-red-300" : "border-border/60 text-muted-foreground"}`}>{d.kind}{d.divergent ? " · 分歧" : ""}</span>
                  {d.plain}
                  {d.missing && <span className="text-muted-foreground">（缺：{d.missing}）</span>}
                </div>
              ))}
            </div>
          </div>

          {/* AI 优选 */}
          <div className="apple-card p-5">
            <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-sky-200"><Sparkles size={16} /> AI 优选（规则打分，非模型编理由）</div>
            {resp.ai_pick.length === 0 && <div className="text-[14px] text-muted-foreground">暂无可优选的票（报价未取到）。</div>}
            <div className="space-y-2.5">
              {resp.ai_pick.map((p, i) => (
                <div key={p.symbol} className="rounded-xl border border-border/60 px-4 py-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-muted-foreground">{i + 1}</span>
                    <span className="text-[16px] font-medium">{p.name}</span>
                    <span className="font-mono text-[12.5px] text-muted-foreground/60">{p.symbol}</span>
                    <span className="ml-auto text-[15px] font-semibold"><NumText value={p.price} digits={2} /></span>
                    <PctText value={p.change_pct} className="text-[14px] font-medium" />
                    <span className="rounded bg-sky-400/15 px-2 py-0.5 text-[12px] text-sky-200">得分 {p.score}</span>
                  </div>
                  <div className="mt-1 text-[13.5px] text-muted-foreground">理由：{p.reasons.join("；") || "—"}</div>
                  <div className="mt-0.5 text-[13.5px] text-muted-foreground">分歧：{p.divergence}</div>
                  {p.warnings.map((w) => <div key={w} className="mt-0.5 text-[12.5px] text-amber-300/80">{w}</div>)}
                </div>
              ))}
            </div>
            <div className="mt-3 text-[12.5px] text-muted-foreground/70">AI 优选仅供参考，不构成投资建议；得分 = 站上均线 + 池内相对强度 + 动能 + 量 + 估值（字段缺失的项不计分）。</div>
          </div>

          {/* 事件 */}
          <div className="apple-card p-5">
            <div className="mb-2 text-[15px] font-semibold">事件 · 长桥新闻（按票汇总）</div>
            {resp.events.length === 0 && <div className="text-[14px] text-muted-foreground">本次未取到新闻（长桥 news 无返回 / 美股回退 Yahoo 无新闻）。</div>}
            <div className="space-y-2">
              {resp.events.map((e, i) => (
                <div key={i} className="text-[13.5px] leading-relaxed">
                  <span className="mr-2 font-mono text-[12px] text-muted-foreground">{e.symbol}</span>
                  {e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="text-foreground/90 hover:text-sky-300">{e.title}</a> : <span>{e.title}</span>}
                  <span className="ml-2 text-[12px] text-muted-foreground">{e.time ?? ""}{e.source ? ` · ${e.source}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
