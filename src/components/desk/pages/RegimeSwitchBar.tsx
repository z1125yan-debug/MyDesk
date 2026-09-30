"use client";
// P36-E6 档位切换条：强势 / 震荡 / 弱势（用户 2026-09-30 提议「牛市/震荡/熊市」，改名理由见下）。
//
// 三条硬口径：
// 1. **不写「牛市/熊市」**：判的是最近几周的方向（大盘 vs 最近一个月的平均价 + 方向），
//    不是月线级别的大行情。写「牛市」用户会理解成「大行情来了」，那是系统性误导。
//    （全仓库组件文案禁这两个字，有钉测。）
// 2. **默认 = 自动跟随今天**：三档是「可点的研究入口」，不是平级筛选器。
//    手动切到非当天档 = 研究模式，顶部必须出提示条，防止把回看当建议。
// 3. **成绩数字只读现成的回测榜**（data/strategy-regime.json），接口不现算，页面更不自己算。
//
// 数据源：GET /api/market/regime（轻量，只回档位读数 + 弹层文案 + 该档历史榜）。

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { parseRegimeParam, type RegimeMode } from "@/lib/quant/strategy/regime-switch-core";

export interface RegimeRankItem {
  id: number; name: string; displayName?: string; n: number; win: number; winCi: string | null; net: number; basis: string | null;
}
interface RegimeResp {
  today: { regime: string | null; asOf: string | null; sinceDate: string | null; daysInRegime: number | null; error: string };
  picked: RegimeMode;
  regime: string | null;
  isResearch: boolean;
  banner: string | null;
  explain: string[];
  reversal: { source: string; window: { days: number; horizon: number; universe: number }; note: string } | null;
  rank: RegimeRankItem[];
  rankBasis: string;
  source: string;
  error: string;
}

const TABS = ["强势", "震荡", "弱势"] as const;

export default function RegimeSwitchBar(props: {
  /** 点「选它」：把该档历史上表现最好的这条策略直接填进已选条件并筛一遍 */
  onPick?: (it: RegimeRankItem, regime: string) => void;
}) {
  const [picked, setPicked] = useState<RegimeMode>("auto");
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<RegimeResp | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // 首屏：URL 里带 ?regime= 就以它为准（可分享、可回放）
  useEffect(() => {
    const m = /[?&]regime=([^&#]+)/.exec(window.location.hash || "");
    if (m) {
      const p = parseRegimeParam(m[1]);
      if (p) setPicked(p);
    }
    setReady(true);
  }, []);

  // 切档后回写 URL（replaceState 不触发 hashchange，不会把页面带跑）
  useEffect(() => {
    if (!ready) return;
    const h = window.location.hash || "";
    const [path, qs] = h.split("?");
    const sp = new URLSearchParams(qs || "");
    if (picked === "auto") sp.delete("regime");
    else sp.set("regime", picked);
    const q = sp.toString();
    const next = `${path}${q ? `?${q}` : ""}`;
    if (next && next !== h) window.history.replaceState(null, "", next);
  }, [picked, ready]);

  const load = useCallback(async (mode: RegimeMode) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/market/regime?regime=${encodeURIComponent(mode)}`);
      const j = (await r.json()) as RegimeResp & { error?: string };
      if (!r.ok) { setErr(String(j.error || r.status)); setData(null); return; }
      setErr("");
      setData(j);
    } catch (e) {
      setErr(String((e as Error).message || e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (ready) void load(picked); }, [picked, ready, load]);

  const today = data?.today?.regime ?? null;
  // 高亮：自动时高亮今天实判档；手选时高亮手选档
  const active = picked === "auto" ? today : picked;
  const badge = err
    ? err // 读失败也要在条上说清楚，不能一直停在「正在读…」
    : !data
      ? (loading ? "正在读今天的大盘档位…" : "")
    : !today
      ? (data.error || "今天大盘档位没算出来")
      : `今天大盘：${today}档${data.today.sinceDate ? `（从 ${data.today.sinceDate} 起，已 ${data.today.daysInRegime} 个交易日）` : ""}`;

  return (
    <div className="rounded-xl border border-border/60 bg-overlay p-3">
      {/* 研究模式提示条：手动切到非当天档时必须出，防止把「回看」当「今天的建议」 */}
      {data?.banner && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12.5px] text-amber-200">
          <span className="shrink-0">⚠</span>
          <span className="flex-1">{data.banner}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[13.5px] font-semibold">大盘档位</span>
        <span className="text-[12.5px] text-muted-foreground">{badge}</span>
        <div className="flex items-center gap-1.5">
          {TABS.map((t) => {
            const on = active === t;
            return (
              <button key={t} onClick={() => setPicked(t)}
                className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
                  on ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 bg-card text-muted-foreground hover:border-sky-400/40 hover:text-foreground"
                }`}>
                {t}
              </button>
            );
          })}
          {/* 「自动」是默认态：跟着今天实判走，不让人以为自己必须选一个 */}
          <button onClick={() => setPicked("auto")}
            className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
              picked === "auto" ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-200" : "border-border/50 bg-card text-muted-foreground hover:border-emerald-400/40"
            }`}>
            自动（跟随今天）
          </button>
        </div>
        {loading && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
      </div>

      {/* 弹层：判法 + 三档各一句 + 样本警示。数字由接口给，页面不自己拼。 */}
      <div className="mt-2">
        <DeskCollapse
          title="这三个档位是什么意思？历史规律可信吗？"
          hint={data?.reversal ? `看了 ${data.reversal.window.days} 个交易日` : undefined}
          triggerClassName="text-[12.5px] text-muted-foreground hover:text-foreground"
          contentClassName="text-[12.5px] leading-relaxed text-muted-foreground"
        >
          {err ? (
            <div className="text-[12.5px] text-amber-300">{err}</div>
          ) : !data ? (
            <div className="text-[12.5px]">正在读…</div>
          ) : (
            <ol className="list-decimal space-y-1.5 pl-4">
              {data.explain.map((line, i) => <li key={i}>{line}</li>)}
            </ol>
          )}
        </DeskCollapse>
      </div>

      {/* 该档历史榜：读的是回测榜文件（不是现算），每条带口径标签 */}
      {data && data.rank.length > 0 && (
        <div className="mt-2 border-t border-dashed border-border/50 pt-2">
          <div className="mb-1 text-[12.5px] text-muted-foreground">
            {active ? `【${active}档】历史上表现最好的几条` : "历史上表现最好的几条"}
            {data.isResearch ? "（回看）" : ""}
          </div>
          <div className="space-y-1">
            {data.rank.slice(0, 3).map((it, i) => (
              <div key={it.id} className="flex items-center gap-2 text-[12.5px]">
                <span className="w-4 shrink-0 text-center text-[11.5px] font-bold text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={it.displayName ?? it.name}>{it.displayName ?? it.name}</span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">
                  试了 {it.n} 次 · 第二天涨的比例 {it.winCi || `${it.win.toFixed(0)}%`} · 平均 {it.net >= 0 ? "+" : ""}{it.net.toFixed(2)}%
                </span>
                {props.onPick && (
                  <button
                    onClick={() => props.onPick?.(it, String(active ?? ""))}
                    className="shrink-0 rounded-md bg-sky-600 px-2 py-0.5 text-[11.5px] font-medium text-white hover:bg-sky-500"
                  >
                    选它
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            口径：{data.rank[0]?.basis || "扣掉手续费后"}；数字来自本地回测榜，是历史统计不是预测。
          </div>
        </div>
      )}
    </div>
  );
}
