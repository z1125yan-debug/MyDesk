"use client";
// P7-⑧③ 对话页右栏的上下文面板：当前标的 / 实时行情快照 / 数据来源 / 分析依据。
//
// 这一屏的渲染纪律（和内核一样重要，改样式前先读完）：
// 1) **一行都不自己算**：数字全部来自既有取数服务（报价、K 线快照、结论卡读数），
//    格式与「缺数写什么」全交给 context-panel-core。面板自己算一遍 RSI 就会有第二套结论跟引擎对不上。
// 2) **面板现取 ≠ 本轮注入**：行情这几格是面板此刻自己取的一份，取数时刻单独写一行；
//    本轮发给模型的那份在「数据来源」里按步骤列出，两者不混成一个时间。
// 3) **结论读数不自动打**：四路接口（日K / 全A快照 / 板块主线 / 事件解读）一次要几秒到几十秒，
//    面板一挂载就自动打会拖慢每一次换标的；默认写「未取」，点一下才取。
// 4) 徽章不用 SourceBadge：它的着色是按 /LIVE|DEMO|缺失|暂无/ 这些英文关键词正则匹配的，
//    来源分层的中文词（「本次未取到」）进去会被画成信息蓝，等于把缺数画得不显眼（Events 页已经吃过一次），
//    所以这里按 provenance 显式着色，颜色语义与全站一致（绿=真实、蓝=派生、紫=演示、黄=缺/降级）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { fetchQuoteCards, fetchTechSnapshot, isDemoSymbol, type TechSnapshot } from "@/lib/desk/market";
import { fetchDecisionView } from "@/lib/desk/quant-api";
import { shanghaiStamp } from "@/lib/desk/session";
import {
  DECISION_IDLE_TEXT, decisionStateText, decisionSummaryOf, evidenceRowsOf, panelBadgeText, quoteRowsOf,
  sourceCountsOf, sourceRowsOf, techRowsOf, type DecisionSummary, type PanelRow,
} from "@/lib/desk/context-panel-core";
import type { Provenance } from "@/lib/desk/ai-context-core";
import type { IntentBadge, StepInfo } from "@/lib/desk/chat-core";
import type { DecisionView } from "@/lib/quant/screener/decision-wiring-core";

const PROV_TONE: Record<Provenance, string> = {
  REAL: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  DERIVED: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  DERIVED_ON_DEMO: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300",
  DEMO: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300",
  MISSING: "border-amber-500/30 bg-amber-500/10 text-amber-300",
};

/** 红涨绿跌：面板上的值是内核格式化好的字符串，只按开头的符号着色（0.00% 与缺数都不抢眼） */
const valueTone = (v: string) => (v.startsWith("+") ? "text-red-500" : v.startsWith("-") ? "text-emerald-500" : "text-foreground");

function Chip({ row }: { row: PanelRow }) {
  const cls = row.provenance
    ? PROV_TONE[row.provenance]
    : "border-border bg-accent/40 text-muted-foreground";
  return <span className={`shrink-0 rounded border px-1 py-px text-[9.5px] leading-4 ${cls}`}>{panelBadgeText(row)}</span>;
}

function RowList({ rows }: { rows: PanelRow[] }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="rounded-lg border border-border/70 bg-accent/20 px-2 py-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0 text-[10.5px] text-muted-foreground">{r.label}</span>
            <span className={`break-all text-right text-[11.5px] font-medium ${valueTone(r.value)}`}>{r.value}</span>
          </div>
          <div className="mt-0.5">
            <Chip row={r} />
          </div>
          {r.note && <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground/85">{r.note}</div>}
        </div>
      ))}
    </div>
  );
}

interface Props {
  /** 面板要展示哪个标的（空串 = 本轮没有标的，行情那一块整块不画） */
  symbol: string;
  /** 这个标的是怎么来的（内核给的一句话，必须上屏） */
  basis: string;
  intent?: IntentBadge | null;
  steps?: StepInfo[];
  warning?: string;
  onOpenSymbol?: (symbol: string, page: "analysis" | "profile") => void;
  onClose?: () => void;
}

export default function ContextPanel({ symbol, basis, intent, steps, warning, onOpenSymbol, onClose }: Props) {
  // 一次取数的结果连同「它是为哪个标的取的」一起存：换标的时 data.symbol 追不上 props，
  // 面板就自己算出 pending=true。这样不需要在 effect 体内同步 setState 去清 busy（React 的新 lint 规则不让）。
  const [data, setData] = useState<{ symbol: string; card: PanelRow[] | null; snap: TechSnapshot | null; takenAt: string; error: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [decision, setDecision] = useState<{ symbol: string; view: DecisionView | null; busy: boolean; error: string } | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!symbol) return;
    const token = reqRef.current + 1;
    reqRef.current = token;
    try {
      // 行情与技术快照一起取（两个都是既有服务，面板不新增后端）
      const [cards, snap] = await Promise.all([
        fetchQuoteCards([symbol]).catch(() => null),
        fetchTechSnapshot(symbol).catch(() => null),
      ]);
      if (reqRef.current !== token) return; // 换标的了：旧响应不许盖新读
      setData({
        symbol,
        card: cards ? quoteRowsOf(cards.cards[0], isDemoSymbol(symbol), shanghaiStamp()) : null,
        snap,
        takenAt: shanghaiStamp(),
        error: cards ? "" : "本次未取到：报价接口没有响应（缺数不写 0，也不拿上一只的数顶）",
      });
    } finally {
      if (reqRef.current === token) setRefreshing(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (!symbol) return;
    void load();
  }, [symbol, load, nonce]);

  const pending = !!symbol && (!data || data.symbol !== symbol);
  const quoteRows = data?.card ?? null;
  const techRows = data && data.symbol === symbol ? techRowsOf(data.snap) : null;
  const evidence = evidenceRowsOf(intent, steps, warning);
  const srcRows = sourceRowsOf(steps);
  const counts = sourceCountsOf(steps);

  // 结论读数按需取：点了才打四路接口，取到的那份连同「为哪个标的取的」一起存
  const fetchDecision = () => {
    if (!symbol || decision?.busy) return;
    setDecision({ symbol, view: null, busy: true, error: "" });
    fetchDecisionView(symbol)
      .then((view) => setDecision({ symbol, view, busy: false, error: "" }))
      .catch((e) => setDecision({ symbol, view: null, busy: false, error: String((e as Error).message || e) }));
  };
  const dec = decision && decision.symbol === symbol ? decision : null;
  const decState = decisionStateText({ fetched: !!dec, busy: !!dec?.busy, error: dec?.error });
  // 摘要只截条数、不改写：每一句都是内核 decisionSections 的原文
  const decSummary = dec?.view ? decisionSummaryOf(dec.view, 3) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold">上下文面板</div>
          <div className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
            {symbol ? <span className="font-mono text-sky-300">{symbol}</span> : <span>本轮无标的</span>}
          </div>
          <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground/85">{basis}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* 点击这个动作本身就是一次「按现在的标的重取一遍」：先亮转圈再递增 nonce，
              真正的「取完了、把圈放下」在 load 的 finally 里按请求序号判（旧请求不许清新请求的圈）。 */}
          <button onClick={() => { setRefreshing(true); setNonce((n) => n + 1); }} disabled={!symbol || refreshing} title="重新取一次行情与技术快照（本轮注入给模型的那份不会因此改变）"
            className="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-40">
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          </button>
          {onClose && (
            <button onClick={onClose} title="收起面板" className="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground xl:hidden">
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="desk-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        {symbol ? (
          <>
            <section>
              <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">实时行情快照（面板现取）</div>
              <div className="mb-1 text-[9.5px] leading-4 text-muted-foreground/80">
                这两格是面板此刻现取的一份（一次要 5 个请求：报价 1 次 + 四个周期的 K 线各 1 次），刷新一下就更新；
                它不会改动本轮已经发给模型的那份快照——那一份在「数据来源」里按步骤列着。
              </div>
              {pending && <div className="text-[11px] text-muted-foreground">正在取报价与 K 线…</div>}
              {!pending && quoteRows && <RowList rows={quoteRows} />}
              {!pending && !quoteRows && <div className="text-[11px] text-amber-300">{data?.error || "本次未取到"}</div>}
            </section>
            <section>
              <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">技术面读数（本机引擎）</div>
              {pending ? <div className="text-[11px] text-muted-foreground">正在算…</div> : <RowList rows={techRows ?? []} />}
            </section>
          </>
        ) : (
          <div className="rounded-lg border border-border/70 bg-accent/20 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
            这一轮问的不是某一只票，行情快照没有对象可取。下面是本轮的取数记录与判定依据。
          </div>
        )}

        <section>
          <div className="mb-1 flex items-center justify-between text-[10.5px] font-medium text-muted-foreground">
            <span>数据来源（本轮真实调用）</span>
            {counts.total > 0 && (
              <span>
                {counts.ok}/{counts.total} 步取到
                {counts.stale ? ` · ${counts.stale} 步数据滞后` : ""}
              </span>
            )}
          </div>
          {srcRows.length ? (
            <div className="space-y-1">
              {srcRows.map((s) => (
                <div key={`${s.step}-${s.tool}`} className="rounded-lg border border-border/70 px-2 py-1.5">
                  <div className="flex flex-wrap items-baseline gap-1.5 text-[10.5px]">
                    <span className="rounded bg-accent px-1 font-mono text-[9.5px] text-muted-foreground">步 {s.step}</span>
                    {/* P8-①：stale（取到了但不新鲜）与 missing 同用琥珀色系——都是「有话要用户对答案打折」，
                        但落到文案上各说各的（数据滞后 / 缺数据），不混成一个词 */}
                    <span className={s.status === "ok" ? "text-emerald-300" : s.status === "missing" || s.status === "stale" ? "text-amber-300" : s.status === "error" ? "text-red-300" : "text-sky-300"}>
                      {s.statusText}
                    </span>
                    <span className="text-foreground/90">{s.label}</span>
                    <span className="text-muted-foreground/80">· {s.who}</span>
                    {s.ms != null && <span className="font-mono text-[9.5px] text-muted-foreground">{s.ms}ms</span>}
                  </div>
                  {s.reason && <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground/85">{s.reason}</div>}
                  {s.detail && <div className="mt-0.5 break-words font-mono text-[9.5px] leading-4 text-muted-foreground/80">{s.detail}</div>}
                </div>
              ))}
              <div className="pt-0.5 text-[9.5px] leading-4 text-muted-foreground/80">
                标「缺数据」表示接口这次没给值，不是数值为 0；「系统预取」是提问前按场景替你取的，「模型自取」才是模型自己要调的。
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground">
              本轮没有任何工具调用（纯对话端点或本轮未取数）。上面那几格行情是面板自己现取的，模型本轮没有拿到这些数。
            </div>
          )}
        </section>

        <section>
          <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">分析依据（本轮回答站在哪些证据上）</div>
          <RowList rows={evidence} />
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between gap-1.5">
            <span className="text-[10.5px] font-medium text-muted-foreground">决策结论读数（四维）</span>
            <button onClick={fetchDecision} disabled={!symbol || !!dec?.busy}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-40">
              {dec?.busy ? "取数中…" : dec ? "重新取数" : "取一次"}
            </button>
          </div>
          {decState && <div className={dec?.error ? "text-[11px] leading-5 text-amber-300" : "text-[11px] leading-5 text-muted-foreground"}>{decState}</div>}
          {!decState && !dec?.busy && decSummary && <DecisionReadout s={decSummary} />}
          {!symbol && <div className="text-[10.5px] text-muted-foreground">{DECISION_IDLE_TEXT}：这一轮没有标的可算。</div>}
        </section>

        {symbol && onOpenSymbol && (
          <div className="flex flex-wrap gap-1.5 border-t border-border/70 pt-2">
            <button onClick={() => onOpenSymbol(symbol, "analysis")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:border-sky-500/40 hover:text-sky-300">
              <ExternalLink size={11} /> 看 K 线
            </button>
            <button onClick={() => onOpenSymbol(symbol, "profile")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:border-sky-500/40 hover:text-sky-300">
              <ExternalLink size={11} /> 打开完整结论卡
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 结论卡摘要：每一句都能在结论卡上找到原文（共用同一份 decisionSections），超出的条数如实写「另有 N 条未列」 */
function DecisionReadout({ s }: { s: DecisionSummary }) {
  return (
    <div className="space-y-1.5">
      <div className="rounded-lg border border-border/70 bg-accent/20 px-2 py-1.5 text-[11px] leading-5">{s.headline}</div>
      <div className="rounded-lg border border-border/70 px-2 py-1.5">
        <div className="text-[10px] font-medium text-muted-foreground">主要判断依据</div>
        <ul className="mt-0.5 space-y-0.5 text-[10.5px] leading-4">
          {s.basis.map((b, i) => <li key={i}>· {b}</li>)}
        </ul>
      </div>
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-2 py-1.5">
        <div className="text-[10px] font-medium text-amber-300/90">核心风险点</div>
        <ul className="mt-0.5 space-y-0.5 text-[10.5px] leading-4">
          {s.risk.map((r, i) => <li key={i}>· {r}</li>)}
        </ul>
      </div>
      <div className="space-y-1">
        {s.sources.map((src) => (
          <div key={src.id} className="flex flex-wrap items-baseline gap-1.5 text-[10px]">
            <span className={`shrink-0 rounded border px-1 py-px leading-4 ${src.used ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
              {src.used ? "已取到" : "本次未取到"}
            </span>
            <span className="text-foreground/90">{src.label}</span>
            <span className="text-muted-foreground/85">{src.detail}</span>
            {src.as_of && <span className="font-mono text-[9.5px] text-muted-foreground">{src.as_of}</span>}
          </div>
        ))}
      </div>
      <div className="text-[9.5px] leading-4 text-muted-foreground/85">
        结论参考日 {s.tradeDate}（取数时刻 {s.asOf}）{s.subjectName ? `｜标的名称来自当日全A快照：${s.subjectName}` : "｜标的名称本次未取到，不拿代码凑"}
        {s.excludedCount > 0 && `｜有 ${s.excludedCount} 个维度未计入加权（权重已从分母拿掉，不是按 0 平均）`}
      </div>
    </div>
  );
}
