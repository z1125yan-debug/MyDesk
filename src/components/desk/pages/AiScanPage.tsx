"use client";
// AI 实时选股（需求文档 十六/十七/二十八）：扫描全A一级入口 + 自然语言→条件 + 漏斗 + 冻结候选池
import { useState } from "react";
import { Radar, Loader2, Snowflake, Bot, ListFilter, Globe2, BookmarkCheck } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { useDesk, type FrozenPool } from "@/lib/desk/store";
import { aiReady } from "@/lib/desk/ai";
import { runScreenerApi, aiChatTools, freezePoolApi, saveScanAsStrategyApi, type ScreenerCond, type ScreenerRespClient } from "@/lib/desk/quant-api";

const RESULTS_FIELDS = ["change_pct", "amount_yi", "turnover_rate", "volume_ratio", "main_net_yi", "rps_50", "above_ma_20", "macd_cross"];

// 无 AI 时的关键词映射（确定性规则，不编造；只映射目录内字段）
function keywordMap(text: string): ScreenerCond[] {
  const conds: ScreenerCond[] = [];
  const numAfter = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  if (/放量|倍量/.test(text)) conds.push({ field: "volume_signal", op: "=", value: 1 });
  if (/上涨|涨/.test(text) && !/涨停/.test(text)) conds.push({ field: "change_pct", op: ">=", value: 2 });
  if (/涨停/.test(text)) conds.push({ field: "is_limit_up", op: "=", value: 1 });
  if (/主力.*(流入|净流入)|资金.*流入/.test(text)) conds.push({ field: "main_net_yi", op: ">", value: 0 });
  const turn = numAfter(/换手率?[大于超过>=]*\s*(\d+(?:\.\d+)?)\s*%?/);
  if (turn !== null) conds.push({ field: "turnover_rate", op: ">=", value: turn });
  const amt = numAfter(/成交额?[大于超过>=]*\s*(\d+(?:\.\d+)?)\s*亿/);
  if (amt !== null) conds.push({ field: "amount_yi", op: ">=", value: amt });
  for (const w of [5, 10, 20, 60, 90, 144]) {
    if (new RegExp(`站上MA${w}|MA${w}上方|突破MA${w}`).test(text)) conds.push({ field: `above_ma_${w}`, op: "=", value: 1 });
  }
  if (/MACD金叉/.test(text)) conds.push({ field: "macd_cross", op: "=", value: 1 });
  if (/KDJ金叉/.test(text)) conds.push({ field: "kdj_cross", op: "=", value: 1 });
  const rps = numAfter(/RPS[大于超过>=]*\s*(\d+)/);
  if (rps !== null) conds.push({ field: "rps_50", op: ">=", value: rps });
  if (/多头排列/.test(text)) conds.push({ field: "ma_struct", op: "=", value: 1 });
  if (/创新高|突破.*高点/.test(text)) conds.push({ field: "breakout_high_60", op: "=", value: 1 });
  if (/VWAP.*上|站上.*成本/.test(text)) conds.push({ field: "vwap20_filter", op: "=", value: 1 });
  return conds;
}

const VALID_FIELDS = new Set([
  "pe_ttm", "pb", "market_cap_yi", "floatcap_yi", "change_pct", "turnover_rate", "volume_ratio", "amplitude", "amount_yi",
  "is_limit_up", "double_volume_signal", "volume_signal", "above_ma_5", "above_ma_10", "above_ma_20", "above_ma_60",
  "above_ma_90", "above_ma_144", "ma_struct", "ema14_gt_ema26", "rps_50", "rps_120", "rps_composite",
  "macd_dif", "macd_dea", "macd", "macd_cross", "kdj_k", "kdj_d", "kdj_j", "kdj_cross",
  "rsi_7", "rsi_14", "rsi_24", "atr_ratio_14", "upper_shadow_ratio", "lower_shadow_ratio",
  "main_net_yi", "above_cost_20", "break_cost_20", "vwap20_filter", "vwap_pos", "vwap20_up3",
  "breakout_high_20", "breakout_high_60",
]);

export default function AiScanPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const ai = useDesk((s) => s.ai);
  const watchlist = useDesk((s) => s.watchlist);
  const frozenPools = useDesk((s) => s.frozenPools);
  const addFrozenPool = useDesk((s) => s.addFrozenPool);

  const [nl, setNl] = useState("");
  const [conds, setConds] = useState<ScreenerCond[]>([]);
  const [condSource, setCondSource] = useState("");
  const [universe, setUniverse] = useState<"all_a" | "hs_a" | { kind: "watchlist"; symbols: string[] }>("all_a");
  const [universeLabel, setUniverseLabel] = useState("全A");
  const [result, setResult] = useState<ScreenerRespClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [frozen, setFrozen] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  const nlToConditions = async () => {
    const text = nl.trim();
    if (!text) return;
    setCondSource("");
    // AI 配置了 → LLM 解析为结构化条件（字段白名单校验，AI 不能创造字段）
    if (aiReady(ai)) {
      try {
        const { content } = await aiChatTools(
          { provider: ai.provider, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, proxy: ai.proxy },
          [{
            role: "user",
            content:
              `把下面的选股描述转换为 JSON 条件数组（不要执行选股）。可用字段只有：${[...VALID_FIELDS].join(",")}。` +
              `输出格式：{"conditions":[{"field":"...","op":"="|">="|">"|"<="|"<"|"!=","value":数字}]}，只输出 JSON。\n描述：${text}`,
          }],
          { mode: "judge" },
        );
        const m = /\{[\s\S]*\}/.exec(content);
        if (m) {
          const parsed = JSON.parse(m[0]) as { conditions?: ScreenerCond[] };
          const list = (parsed.conditions ?? []).filter((c) => VALID_FIELDS.has(c.field));
          if (list.length) {
            setConds(list);
            setCondSource(`AI 解析（${ai.model}）`);
            return;
          }
        }
      } catch { /* 落到关键词映射 */ }
    }
    const mapped = keywordMap(text);
    setConds(mapped);
    setCondSource(mapped.length ? "关键词映射（未配置AI或AI解析失败，确定性规则）" : "未识别出条件（试：放量上涨+主力流入+换手率大于3）");
  };

  const scan = async (u?: "all_a" | "hs_a" | { kind: "watchlist"; symbols: string[] }, label?: string) => {
    const uni = u ?? universe;
    const lab = label ?? universeLabel;
    if (u) { setUniverse(u); setUniverseLabel(label ?? ""); }
    setError(""); setFrozen(""); setStage("拉取股票池与快照…");
    setBusy(true);
    try {
      setStage("漏斗筛选（快照粗筛 → K线精筛）…");
      const resp = await runScreenerApi({
        universe: uni,
        conditions: conds,
        fields: RESULTS_FIELDS,
        sort: { order_by: "amount_yi", order_dir: "desc" },
        pagination: { limit: 20 },
        include_stats: true,
        maxKlineSymbols: 150,
      });
      setResult(resp);
      setStage("");
    } catch (e) {
      setError(String((e as Error).message || e));
      setResult(null);
    } finally {
      setBusy(false);
      setStage("");
    }
  };

  const freeze = async () => {
    if (!result?.list.length) return;
    const rows = result.list.map((r) => ({ symbol: r.symbol, name: r.name, close: r.close, changePct: r.change_pct, reason: condSource }));
    const localPool: FrozenPool = {
      id: `${result.as_of_trade_date}-${universeLabel}-${String(frozenPools.length + 1).padStart(3, "0")}`,
      createdAt: new Date().toTimeString().slice(0, 8),
      asOf: result.as_of_trade_date,
      universe: universeLabel,
      conditions: conds.map((c) => ({ field: c.field, op: c.op, value: c.value as number | string })),
      source: condSource || "手工条件",
      rows,
    };
    try {
      const j = await freezePoolApi({
        universe: universeLabel,
        conditions: conds.map((c) => ({ field: c.field, op: c.op, value: c.value as number | string })),
        source: condSource || "手工条件",
        data_source: result.source?.provider ?? "", // 记录数据来源口径（REAL_DATA_ONLY 审计）
        rows,
      });
      setFrozen(`已冻结候选池 ${j.pool_id}（${j.row_count} 只，原始结果不再被覆盖）`);
    } catch {
      // 服务端不可用时降级为 localStorage
      addFrozenPool(localPool);
      setFrozen(`离线模式：已冻结候选池 ${localPool.id}（${localPool.rows.length} 只，仅存本地）`);
    }
  };

  // P1-5：存为策略 → 写入策略实验室（版本化），后续在量化研究页评估/回测
  const saveAsStrategy = async () => {
    if (!result?.list.length || !conds.length) return;
    setSaving(true);
    setSaved("");
    try {
      const key = `aiscan-${result.as_of_trade_date}-${String(frozenPools.length + 1).padStart(3, "0")}`;
      const r = await saveScanAsStrategyApi({
        strategyKey: key,
        name: `AI选股 ${universeLabel} ${result.as_of_trade_date}`,
        factorRefs: [...new Set(conds.map((c) => c.field))].map((factorKey) => ({ factorKey })),
        selection: {
          universe,
          conditions: conds,
          source: condSource || "手工条件",
          resultCount: result.total,
        },
        note: "AI 实时选股页「存为策略」创建（条件与股票池快照口径）",
      });
      setSaved(`已存为策略 ${r.strategyKey} v${r.version} → 可在「量化研究」策略实验室查看/评估`);
    } catch (e) {
      setSaved(`存为策略失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div>
        <div className="text-lg font-bold">AI 实时选股</div>
        <div className="text-[11px] text-muted-foreground">
          扫描全A → 流动性 → 量价/资金/技术条件 → 历史胜率统计 · 所有数据来自真实接口 · 不构成投资建议
          {result?.factor_verify ? ` · 本次涉及 ${result.factor_verify.enabled} 因子，${result.factor_verify.unverified} 未验证` : " · 因子验证状态见「因子实验室」"}
        </div>
      </div>

      {/* 入口（文档 16.1：扫描全A必须是一级功能） */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => scan("all_a", "全A")} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Globe2 size={14} />} 扫描全A
        </button>
        <button onClick={() => scan("hs_a", "沪深")} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
          <Radar size={14} /> 扫描沪深京
        </button>
        <button onClick={() => scan({ kind: "watchlist", symbols: watchlist.map((w) => w.symbol) }, "自选股")} disabled={busy || !watchlist.length}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
          <ListFilter size={14} /> 扫描自选股（{watchlist.length}）
        </button>
      </div>

      {/* 自然语言选股 */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 text-[12px] font-semibold text-foreground/80">AI 自然语言选股</div>
        <div className="flex items-center gap-2">
          <input
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) nlToConditions(); }}
            placeholder="例：帮我扫描今天全A，找出放量上涨、主力资金持续流入、20日趋势向上的股票"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-sky-500/50"
          />
          <button onClick={nlToConditions} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:border-sky-500/40 hover:text-sky-300">
            <Bot size={14} /> 解析为条件
          </button>
        </div>
        {condSource && <div className="mt-1.5 text-[10.5px] text-muted-foreground">条件来源：{condSource} · 字段白名单校验，AI 不能创造不存在的字段</div>}
        {conds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {conds.map((c, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full border border-sky-500/50 bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-300">
                {c.field} {c.op} {String(c.value)}
                <button onClick={() => setConds((cs) => cs.filter((_, k) => k !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 执行 */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => scan()} disabled={busy || !conds.length}
          className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />} 开始筛选
        </button>
        {result && (
          <button onClick={freeze} className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm text-muted-foreground hover:border-sky-500/40 hover:text-sky-300">
            <Snowflake size={14} /> 冻结候选池
          </button>
        )}
        {result && conds.length > 0 && (
          <button onClick={saveAsStrategy} disabled={saving} className="flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm text-muted-foreground hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <BookmarkCheck size={14} />} 存为策略
          </button>
        )}
        {stage && <span className="text-xs text-sky-400">{stage}</span>}
        {frozen && <span className="text-xs text-emerald-400">{frozen}</span>}
        {saved && (
          <span className="text-xs text-emerald-400">
            {saved}{" "}
            {saved.startsWith("已存为策略") && (
              <button onClick={() => go("quant")} className="underline decoration-dotted hover:text-sky-300">去量化研究</button>
            )}
          </span>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {/* 漏斗 */}
      {result && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[11.5px] text-muted-foreground">
          <span>漏斗：</span>
          <Step n={result.funnel.universe} label={`${universeLabel}股票池`} />
          <Arrow /> <Step n={result.funnel.snapshot_pass} label="快照口径粗筛（剔除ST/停牌）" />
          <Arrow /> <Step n={result.funnel.kline_subset} label="K线子集（流动性Top-K）" />
          <Arrow /> <Step n={result.funnel.kline_pass} label="条件命中" highlight />
          <span className="ml-auto">交易日 {result.as_of_trade_date}</span>
        </div>
      )}
      {/* P9-经验轮：字段缺口要醒目——「没选出来」与「数据缺失选不了」是两个事实，
          以前只有一行小字「无命中结果」，用户永远猜不到是资金数据断源。 */}
      {result && (result.unavailable_fields?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
          <span className="font-semibold">以下条件在当前数据源没有任何真实读数，本次没有按它们筛选：</span>
          {result.unavailable_fields!.map((g) => g.zh).join("、")}
          <div className="mt-0.5 text-amber-200/70">
            这是数据缺口（东财资金数据断源兜底期该字段全市场缺失），不是「没有股票符合条件」。
            可改用涨跌幅/成交额/换手/RPS 等当前可得的口径重新筛选。
          </div>
        </div>
      )}
      {result?.warnings
        .filter((w) => !(result.unavailable_fields ?? []).some((g) => w.includes(`「${g.zh}」`)))
        .map((w, i) => (
        <div key={i} className="rounded bg-amber-500/5 px-2.5 py-1.5 text-[10.5px] text-amber-300/90">⚠ {w}</div>
      ))}

      {/* 结果表（文档 二十八 列） */}
      {result && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                {["代码", "名称", "现价", "涨跌幅", "成交额(亿)", "换手%", "量比", "主力净额(亿)", "RPS50", "站上MA20", "MACD金叉", "1日胜率", "5日胜率", "20日胜率", "入选原因"].map((h) => (
                  <th key={h} className={`px-3 py-2 ${h.includes("胜率") || /净额|额\)|价/.test(h) ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.list.map((r) => {
                const h = (n: number) => r.win_prob?.horizons.find((x) => x.h === n);
                return (
                  <tr key={r.symbol} onClick={() => openProfile(r.symbol)} className="cursor-pointer border-b border-border/40 hover:bg-sky-500/5">
                    <td className="px-3 py-1.5 font-mono">{r.symbol}</td>
                    <td className="px-3 py-1.5">{r.name}{r.industry ? <span className="ml-1 text-[10px] text-muted-foreground">{r.industry}</span> : null}</td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.close} /></td>
                    <td className="px-3 py-1.5 text-right"><PctText value={r.change_pct} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.amount_yi} digits={1} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.turnover_rate} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.volume_ratio} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.main_net_yi} digits={2} /></td>
                    <td className="px-3 py-1.5 text-right"><NumText value={r.values.rps_50} digits={0} /></td>
                    <td className="px-3 py-1.5 text-center">{r.values.above_ma_20 === 1 ? <span className="text-red-500">✓</span> : "—"}</td>
                    <td className="px-3 py-1.5 text-center">{r.values.macd_cross === 1 ? <span className="text-red-500">✓</span> : "—"}</td>
                    <td className="px-3 py-1.5 text-right"><Win v={h(1)?.win_rate} n={h(1)?.sample_size} /></td>
                    <td className="px-3 py-1.5 text-right"><Win v={h(5)?.win_rate} n={h(5)?.sample_size} /></td>
                    <td className="px-3 py-1.5 text-right"><Win v={h(20)?.win_rate} n={h(20)?.sample_size} /></td>
                    <td className="px-3 py-1.5 text-[10px] text-muted-foreground">{conds.map((c) => `${c.field}${c.op}${c.value}`).join(" + ") || "—"}{r.win_prob?.sample_ok === false ? " ·样本不足" : ""}</td>
                  </tr>
                );
              })}
              {result.list.length === 0 && (
                <tr><td colSpan={15} className="px-3 py-8 text-center text-muted-foreground">无命中结果</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 已冻结候选池 */}
      {frozenPools.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold text-foreground/80">已冻结候选池（冻结后原始结果不被覆盖；次日自动验证属 P1）</div>
          <div className="space-y-1.5">
            {frozenPools.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded bg-accent/30 px-3 py-1.5 text-[11.5px]">
                <span className="font-mono text-sky-300">{p.id}</span>
                <span className="text-muted-foreground">{p.createdAt} · {p.universe} · {p.rows.length} 只</span>
                <span className="text-muted-foreground/70">{p.rows.slice(0, 5).map((r) => r.name).join("、")}{p.rows.length > 5 ? "…" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ n, label, highlight }: { n: number; label: string; highlight?: boolean }) {
  return (
    <span className={highlight ? "font-semibold text-sky-400" : ""}>
      <span className={highlight ? "" : "text-foreground"}>{n}</span> {label}
    </span>
  );
}
function Arrow() { return <span className="text-muted-foreground/50">→</span>; }
function Win({ v, n }: { v?: number | null; n?: number }) {
  if (v === null || v === undefined) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={v >= 55 ? "text-red-500" : v >= 50 ? "text-foreground" : "text-emerald-500"}>
      {v.toFixed(0)}%<span className="ml-0.5 text-[9px] text-muted-foreground">({n})</span>
    </span>
  );
}
