"use client";
// P6-C AI Market Research 页：把「当前市场环境」的跨源综合做成一份可核对的研究报告（任务书 §二十三/§二十四）。
//
// 页面结构（照任务书那四块）：
//   ① 顶部当前状态：风险 / 主线 / 雷达 / 事件 —— 读的是已有接口，与对应页面同源，本页面不重算任何指标；
//   ② Research Query：研究问题输入（留空则服务端按默认问题组装，并把这一事实写进缺失口径）；
//   ③ Research Result：七分区（FACTS/SIGNALS/HISTORICAL_EVIDENCE 服务端三层 + INTERPRETATION/RISKS/UNKNOWN/NEXT_CHECKS AI 四层），
//      每条 AI 判断都逐条列出它引用了哪几行台账、出处原文、以及被服务端标出来的问题（无出处数字/编造引用/历史当预测）；
//   ④ Tool Calls 侧栏：**服务端采集器本次的取数观测**，不是模型的工具调用（真正的 Agent 自主调用在 P6-D）；
//      这一句必须写在页面上，否则读者会以为模型自己查过数据。
//
// 链路与凭据：AI Key 只在浏览器（localStorage → /api/ai/proxy），所以「调模型」这一步在客户端，
// 台账与复校验都在服务端（见 src/lib/desk/research-run.ts）。页面不解析模型原文、不判断哪条能用。
//
// REAL_DATA_ONLY：
// - 没有报告就写「没跑过」，不显示空壳结论；REJECTED 也照常显示（数据在库里、结论不可用）；
// - 每一块都带 asOf / source / status（§二十四）；
// - AI 未配置 ⇒ AI_NOT_CONFIGURED，本页面不会用本地文案冒充解释。
import { useCallback, useEffect, useState } from "react";
import { Loader2, Microscope, RefreshCw, Sparkles } from "lucide-react";
import { SourceBadge } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";
import { aiReady } from "@/lib/desk/ai";
import { RESEARCH_RUN_STATUS_TEXT, runMarketResearch, type ResearchRunResult } from "@/lib/desk/research-run";
import {
  fetchEvents, fetchRadar, fetchResearchReport, fetchRisk, fetchThemes,
  type EventItemClient, type RadarItemClient, type ResearchLoadClient, type RiskClient, type ThemeDiscoveryClient,
} from "@/lib/desk/quant-api";
import {
  COLLECTOR_STATUS_TEXT, LAYER_TEXT, MAX_LEDGER_LINES, RESEARCH_STATUS_TEXT, renderResearchTrace,
  researchFieldCompleteness, researchLayerSections,
  type EvidenceLine, type ResearchReport, type SourceProbe,
} from "@/lib/quant/screener/research-core";

const STATUS_TONE: Record<string, string> = {
  INTERPRETED: "text-emerald-300",
  PARTIAL: "text-amber-300",
  REJECTED: "text-red-300",
  AI_NOT_CONFIGURED: "text-amber-300",
  AI_FAILED: "text-amber-300",
  NO_EVIDENCE: "text-amber-300",
};

/** 台账行的出处行：逐行给 id / 层 / data_status / 来源 / asOf（§二十四 要求每个结果都能查到这三样） */
function LedgerLine({ l }: { l: EvidenceLine }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono font-semibold">{l.id}</span>
        <span className="text-muted-foreground">{l.layer}</span>
        <SourceBadge status={l.data_status} source={l.source} time={l.as_of} />
      </div>
      <div className="mt-1 text-[11.5px] leading-snug">{l.text}</div>
      <div className="mt-0.5 text-[9.5px] text-muted-foreground/70">能力：{l.capability}</div>
    </div>
  );
}

/** AI 四层里带引用的条目：把「这句话从哪来」和「服务端判它站不站得住」并排显示 */
function SectionItem({ item }: { item: ResearchReport["interpretation"][number] }) {
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${item.fully_grounded ? "border-border/70 bg-card/60" : "border-amber-500/40 bg-amber-500/5"}`}>
      <div className="text-[12px] leading-snug">{item.text}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
        {item.cites.length ? item.cites.map((c) => (
          <span key={c} className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-sky-300">{c}</span>
        )) : <span className="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-300">无台账引用：不可回溯</span>}
      </div>
      {!!item.cited_text.length && (
        <details className="mt-1 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none">引用原文（服务端按 id 回填，前端改不了）</summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {item.cited_text.map((t) => <li key={t} className="list-disc leading-snug">{t}</li>)}
          </ul>
        </details>
      )}
      {!!item.unsourced_numbers.length && (
        <div className="mt-1 text-[10px] text-amber-300">台账里找不到出处的数字（原文未删，逐条标注供核对）：{item.unsourced_numbers.join("、")}</div>
      )}
      {!!item.historical_as_current.length && (
        <div className="mt-1 text-[10px] text-amber-300">把历史统计写成当前预测（§二十二）：{item.historical_as_current.join("、")}</div>
      )}
    </div>
  );
}

function CollectorRow({ s }: { s: SourceProbe }) {
  const tone = s.status === "ok" ? "text-emerald-300" : s.status === "failed" ? "text-red-300" : "text-amber-300";
  return (
    <div className="rounded-lg border border-border/70 bg-card/50 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="font-semibold">{s.title}</span>
        <span className={`font-mono ${tone}`}>{s.status}</span>
        <SourceBadge status={s.data_status} source={s.source} time={s.as_of} />
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {COLLECTOR_STATUS_TEXT[s.status]} · 出台账 {s.lines} 行{s.note ? ` · ${s.note}` : ""}
      </div>
    </div>
  );
}

export default function ResearchPage() {
  const ai = useDesk((s) => s.ai);
  // ① 顶部当前状态：四个已有接口各读各的，任一失败只影响它自己那一块（失败原因原样显示）
  const [risk, setRisk] = useState<RiskClient | null>(null);
  const [themes, setThemes] = useState<ThemeDiscoveryClient | null>(null);
  const [radar, setRadar] = useState<{ as_of: string; items: RadarItemClient[]; superseded_today?: number } | null>(null);
  const [events, setEvents] = useState<{ as_of: string; items: EventItemClient[] } | null>(null);
  const [topErr, setTopErr] = useState<Record<string, string>>({});
  const [topBusy, setTopBusy] = useState(false);
  // ② 研究层
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ResearchRunResult | null>(null);
  const [view, setView] = useState<ResearchLoadClient | null>(null);
  const [date, setDate] = useState(""); // '' = 服务端默认今天
  const [viewBusy, setViewBusy] = useState(false);
  const [err, setErr] = useState("");

  const loadTop = useCallback(async () => {
    setTopBusy(true);
    const errs: Record<string, string> = {};
    // 四个请求并发，与各自页面同一接口同一口径；这里不额外取数、不重算
    const [a, b, c, d] = await Promise.allSettled([fetchRisk(), fetchThemes(), fetchRadar(), fetchEvents()]);
    if (a.status === "fulfilled") setRisk(a.value); else { setRisk(null); errs.risk = String(a.reason?.message ?? a.reason); }
    if (b.status === "fulfilled") setThemes(b.value); else { setThemes(null); errs.themes = String(b.reason?.message ?? b.reason); }
    if (c.status === "fulfilled") setRadar(c.value); else { setRadar(null); errs.radar = String(c.reason?.message ?? c.reason); }
    if (d.status === "fulfilled") setEvents(d.value); else { setEvents(null); errs.events = String(d.reason?.message ?? d.reason); }
    setTopErr(errs);
    setTopBusy(false);
  }, []);

  const loadView = useCallback(async (d?: string) => {
    setViewBusy(true); setDate(d ?? "");
    try { setView(await fetchResearchReport(d ?? "")); setErr(""); }
    catch (e) { setErr(String((e as Error).message || e)); setView(null); }
    finally { setViewBusy(false); }
  }, []);

  useEffect(() => { void loadTop(); void loadView(); }, [loadTop, loadView]);

  const runAi = async () => {
    setRunning(true); setErr("");
    try {
      const r = await runMarketResearch(ai, { question });
      setRun(r);
    } catch (e) {
      setRun({
        ok: false, status: "AI_FAILED", message: String((e as Error).message || e), model: ai.model || "未配置",
        prompt_version: "", evidence_total: 0, raw_chars: 0, prompt: null, store: null, missing: [],
      });
    } finally {
      setRunning(false);
      void loadView(date); // 读回服务端落库后的口径（含台账/采集器观测），页面不自己拼
    }
  };

  const rep = view?.report ?? null;
  const ledger = view?.evidence ?? [];
  const sections = rep ? researchLayerSections(rep, ledger) : [];
  const completeness = rep ? researchFieldCompleteness(rep) : null;
  const statusText = rep ? RESEARCH_STATUS_TEXT[rep.interpretation_status] : "";

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Microscope size={18} className="text-sky-400" /> AI 市场环境研究</div>
          <div className="text-[11px] text-muted-foreground">
            服务端现取真实读数编成台账 → 本机配置的模型跨源解释 → 服务端复校验后才落库<br />
            本层不重算任何指标（MA/MACD/RSI/IC/回测/条件概率都来自已有引擎），不产概率、不给投资建议；解释不是市场事实
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view && (
            <SourceBadge
              status={!aiReady(ai) ? "AI_NOT_CONFIGURED 缺失" : "AI_INTERPRETATION"}
              source={!aiReady(ai) ? "无可用模型通道（浏览器未配置且服务端 .env 通道不可用）：解释层未运行（读数与台账不受影响）" : `research_report · ${view.as_of}`}
              time={view.report?.generated_at?.slice(5, 16) || view.probed_at?.slice(5, 16)}
            />
          )}
          <button onClick={() => { void loadTop(); void loadView(date); }}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {topBusy || viewBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
          <button onClick={runAi} disabled={running || topBusy}
            title="让服务端现取一次台账，交给本机配置的模型解释，再由服务端复校验后落库（这一步会写 research_report 当天那一行）"
            className="flex items-center gap-1 rounded-md bg-fuchsia-500 px-2.5 py-1.5 text-xs text-white hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-40">
            {running ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} 生成研究报告
          </button>
        </div>
      </div>

      {/* ① 当前状态四块：与风险/主线/雷达/事件页面同一批接口，字段口径照抄，不在这里二次加工 */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card/60 px-3 py-2">
          <div className="text-[10.5px] text-muted-foreground">风险等级</div>
          <div className="text-base font-bold">{risk?.risk.level ?? "未取到"}</div>
          {risk ? (
            <>
              <div className="text-[10.5px] text-muted-foreground">
                涨 {risk.advancers} / 跌 {risk.decliners} · 涨停 {risk.limit_up} · 炸板率 {risk.break_rate === null ? "—" : `${risk.break_rate.toFixed(0)}%`} · 主力净额 {risk.main_net_sum_yi.toFixed(0)}亿
              </div>
              <div className="mt-1"><SourceBadge status={risk.live ? "LIVE" : "HISTORICAL"} source={risk.source.provider.split("（")[0]} time={risk.as_of.slice(5, 16)} /></div>
              {!!risk.missing.length && <div className="mt-1 text-[9.5px] text-amber-300/90">缺失：{risk.missing.join("；")}</div>}
            </>
          ) : <div className="text-[10px] text-red-300">{topErr.risk || "正在读取…"}</div>}
        </div>
        <div className="rounded-xl border border-border bg-card/60 px-3 py-2">
          <div className="text-[10.5px] text-muted-foreground">主线（规则版）</div>
          <div className="text-base font-bold">{themes ? `主线 ${themes.main.length} 个` : "未取到"}</div>
          {themes ? (
            <>
              <div className="text-[10.5px] text-muted-foreground">{themes.main.map((t) => `${t.name}(${t.score.toFixed(1)}分)`).join("、") || "当日无主线命中"}</div>
              <div className="mt-1"><SourceBadge status="DERIVED" source={themes.source.provider} time={themes.as_of.slice(5, 16)} /></div>
              {!!themes.missing.length && <div className="mt-1 text-[9.5px] text-amber-300/90">缺失：{themes.missing.join("；")}</div>}
            </>
          ) : <div className="text-[10px] text-red-300">{topErr.themes || "正在读取…"}</div>}
        </div>
        <div className="rounded-xl border border-border bg-card/60 px-3 py-2">
          <div className="text-[10.5px] text-muted-foreground">雷达候选</div>
          <div className="text-base font-bold">{radar ? `${radar.items.length} 条 live` : "未取到"}</div>
          {radar ? (
            <>
              <div className="truncate text-[10.5px] text-muted-foreground" title={radar.items.map((i) => i.title).join(" / ") || "当日没有规则命中"}>
                {radar.items.slice(0, 2).map((i) => i.title).join(" / ") || "当日 0 条：真实为空，不是失败"}
              </div>
              <div className="mt-1"><SourceBadge status="REAL" source="radar_finding 当日库行" time={radar.as_of.slice(5, 16)} /></div>
            </>
          ) : <div className="text-[10px] text-red-300">{topErr.radar || "正在读取…"}</div>}
        </div>
        <div className="rounded-xl border border-border bg-card/60 px-3 py-2">
          <div className="text-[10.5px] text-muted-foreground">今日事件</div>
          <div className="text-base font-bold">{events ? `${events.items.length} 条入库` : "未取到"}</div>
          {events ? (
            <>
              <div className="truncate text-[10.5px] text-muted-foreground" title={events.items.map((i) => i.title).join(" / ") || "当日无事件行"}>
                {events.items.slice(0, 2).map((i) => i.title).join(" / ") || "当日 0 条：真实为空，本层不会去猜新闻"}
              </div>
              <div className="mt-1"><SourceBadge status="HISTORICAL" source="global_event 当日库行" time={events.as_of.slice(0, 10)} /></div>
            </>
          ) : <div className="text-[10px] text-red-300">{topErr.events || "正在读取…"}</div>}
        </div>
      </div>

      {/* ② 研究问题 */}
      <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
            placeholder="Research Query：想问什么？例：今天半导体链条的资金与涨幅是否互相支持？（留空 = 服务端按默认问题「当前市场环境如何」组装，并把这一条写进缺失口径）"
            className="min-w-[280px] flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-sky-500"
          />
          {view?.available_dates.length ? (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              可回看：
              <button onClick={() => void loadView("")} className={`rounded border px-1.5 py-0.5 ${date ? "border-border" : "border-sky-500/40 text-sky-300"}`}>今天</button>
              {view.available_dates.slice(0, 6).map((d) => (
                <button key={d.date} onClick={() => void loadView(d.date)}
                  title={`${d.status}｜${d.question || "未记录问题"}`}
                  className={`rounded border px-1.5 py-0.5 ${date === d.date ? "border-sky-500/40 text-sky-300" : "border-border"}`}>
                  {d.date.slice(5)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {!aiReady(ai) && (
          <div className="mt-1.5 text-[10.5px] text-amber-300">
            无可用模型通道（浏览器未配置，且服务端 .env 通道不可用）：解释层跑不了（AI_NOT_CONFIGURED）。上方四块读数与台账都是真实的，缺的只是解释这一步；配好任一条路再生成。
          </div>
        )}
      </div>

      {(err || run?.message) && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${err ? "border-red-500/30 bg-red-500/10 text-red-300" : `border-border bg-card/60 ${STATUS_TONE[run!.status] ?? "text-muted-foreground"}`}`}>
          {err || `本次「生成研究报告」：${RESEARCH_RUN_STATUS_TEXT[run!.status]} —— ${run!.message}`}
          {run && run.raw_chars > 0 && <span className="text-muted-foreground">（模型原文 {run.raw_chars} 字符，服务端复校验后落库）</span>}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ③ 研究结果：七分区 */}
        <div className="space-y-3">
          {rep ? (
            <div className="rounded-xl border border-fuchsia-500/25 bg-card/50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-sm font-semibold ${STATUS_TONE[rep.interpretation_status]}`}>{rep.interpretation_status}</span>
                <span className="text-[10.5px] text-muted-foreground">{statusText}</span>
              </div>
              <div className="mt-1 text-[13px] font-medium">{rep.headline || "（本份报告没有 headline：AI 未给出，或被服务端整条剔除）"}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                <span>市场姿态：<b className="text-foreground">{rep.market_posture}</b>{rep.posture_cites.length ? `（引用 ${rep.posture_cites.join("、")}）` : "（无引用）"}</span>
                <SourceBadge status="AI_INTERPRETATION" source={`模型 ${rep.model || "未记录"}`} time={rep.generated_at} />
                <span>提示词 {rep.prompt_version}</span>
                <span>台账 {rep.evidence_total} 行（FACTS {rep.evidence_by_layer.FACTS} / SIGNALS {rep.evidence_by_layer.SIGNALS} / HIST {rep.evidence_by_layer.HISTORICAL_EVIDENCE}）</span>
                {rep.data_layer !== "AI_INTERPRETATION" && <span className="text-red-300">分层标记异常</span>}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground/90">研究问题：{rep.question || "未记录"}</div>
              {!!rep.violations.length && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[10.5px] text-amber-200">
                  服务端核对结果（逐条留痕，原文没有被静默删除）：
                  <ul className="mt-0.5 list-disc pl-4">{rep.violations.map((v) => <li key={v}>{v}</li>)}</ul>
                </div>
              )}
              {(rep.dropped.invalid_cites.length > 0 || rep.dropped.probability_claims.length > 0 || rep.dropped.fields.length > 0) && (
                <div className="mt-1.5 text-[10px] text-muted-foreground">
                  剔除留档：编造引用 {rep.dropped.invalid_cites.join("、") || "无"} · 概率/涨幅预测 {rep.dropped.probability_claims.join("、") || "无"}
                  {!!rep.dropped.fields.length && <> · 整项未采纳 {rep.dropped.fields.length} 处</>}
                </div>
              )}
              {completeness?.empty.length ? (
                <div className="mt-1 text-[10px] text-muted-foreground/90">
                  本次为空的段落：{completeness.empty.join("、")}。空是这份报告的真实状态（模型没给或被剔除），不是「没有问题」。
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
              {viewBusy ? "正在读取报告…" : `${view?.as_of || "本日"} 还没有 ${view?.scope || "market"} 范围的 AI 市场研究报告：这一层只在有人点「生成研究报告」时产生，没做过就是空（不是失败，也不会自动补）。`}
              {!!view?.missing.length && <div className="mt-1 text-[10.5px]">{view.missing.join("；")}</div>}
            </div>
          )}

          {rep && (
            <div className="space-y-2">
              {sections.map((s) => (
                <div key={s.layer} className="rounded-xl border border-border bg-card/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10.5px] font-semibold">{s.layer}</span>
                    <SourceBadge status={s.owner === "服务端" ? (s.layer === "FACTS" ? "REAL" : s.layer === "SIGNALS" ? "DERIVED" : "HISTORICAL") : "AI_INTERPRETATION"} source={s.owner === "服务端" ? "服务端台账" : "模型产出，经服务端复校验"} />
                    <span className="text-[10px] text-muted-foreground">{LAYER_TEXT[s.layer]}</span>
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    {s.owner === "服务端" ? (
                      s.lines.length ? s.lines.map((l) => <LedgerLine key={l.id} l={l} />)
                        : <div className="text-[10.5px] text-muted-foreground">本层本次没有台账行（缺失原因见下方「缺失口径」，不会用别的数字顶替）。</div>
                    ) : s.items ? (
                      s.items.length ? s.items.map((it, i) => <SectionItem key={`${s.layer}-${i}`} item={it} />)
                        : <div className="text-[10.5px] text-muted-foreground">本段为空：模型没给这一层的内容（空就是空，页面不会补一段默认解释）。</div>
                    ) : (
                      s.strings.length ? s.strings.map((t, i) => (
                        <div key={`${s.layer}-${i}`} className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-[11.5px] leading-snug">{t}</div>
                      )) : <div className="text-[10.5px] text-muted-foreground">本段为空。</div>
                    )}
                  </div>
                </div>
              ))}
              <details className="rounded-xl border border-border bg-card/40 px-3 py-2 text-[10.5px] text-muted-foreground">
                <summary className="cursor-pointer select-none">回溯文本（这份报告「每句话从哪来」的完整核对串）</summary>
                <pre className="mt-1.5 max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/60 p-2 text-[10px] leading-4">{renderResearchTrace(rep, ledger)}</pre>
              </details>
            </div>
          )}
        </div>

        {/* ④ Tool Calls 侧栏：采集器观测 + 本次台账目录 + 缺失口径 */}
        <div className="space-y-2">
          <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
            <div className="text-[11px] font-semibold">Tool Calls（采集器观测）</div>
            <div className="mt-0.5 text-[9.5px] leading-snug text-amber-300/90">
              这一栏是服务端本次向哪些能力取了数、取到没有，<b>不是模型的工具调用</b>：模型只拿到下面这份台账文本，自己没有取数能力（Agent 自主调用在 P6-D）。
            </div>
            <div className="mt-1.5 space-y-1.5">
              {(view?.sources ?? []).length ? view!.sources.map((s) => <CollectorRow key={s.capability} s={s} />)
                : <div className="text-[10.5px] text-muted-foreground">没有采集器观测：这份报告落库时没有留 sources 快照（或还没有报告）。点「刷新」重读一次。</div>}
            </div>
            <div className="mt-1 text-[9.5px] text-muted-foreground/80">
              台账上限 {MAX_LEDGER_LINES} 行：超出部分不参与本次提示词，截断条数会出现在下方「缺失口径」里（不静默丢行）。
            </div>
          </div>

          {!!ledger.length && (
            <details className="rounded-xl border border-border bg-card/50 px-3 py-2" open>
              <summary className="cursor-pointer select-none text-[11px] font-semibold">台账目录（{ledger.length} 行，服务端现取）</summary>
              <div className="mt-1.5 space-y-1.5">{ledger.map((l) => <LedgerLine key={l.id} l={l} />)}</div>
            </details>
          )}

          <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
            <div className="text-[11px] font-semibold">缺失口径（{view?.missing.length ?? 0} 条）</div>
            {view?.missing.length ? (
              <ul className="mt-1 space-y-1 text-[10px] leading-snug text-muted-foreground">
                {view.missing.map((m) => <li key={m} className="list-disc pl-3">{m}</li>)}
              </ul>
            ) : <div className="mt-1 text-[10px] text-muted-foreground">本批没有登记的缺失项（引擎自报缺失为 0，不代表市场没有风险）。</div>}
          </div>

          {view && (
            <div className="rounded-xl border border-border bg-card/50 px-3 py-2 text-[9.5px] leading-snug text-muted-foreground">
              <div>{view.layering}</div>
              <div className="mt-1">读库依据：{view.basis}</div>
              <div className="mt-1">生成时刻台账：{view.report ? `${view.report.evidence_total} 行（落库时冻结）` : "无"}</div>
              {view.report?.stale_evidence && <div className="mt-1 text-amber-300">读数已刷新：这份报告对应的是更早一版扫描结果，要重做才对得上最新读数</div>}
            </div>
          )}
          {run?.prompt && (
            <div className="rounded-xl border border-border bg-card/50 px-3 py-2 text-[9.5px] leading-snug text-muted-foreground">
              本次提示词：台账 {run.prompt.lines.length} 行 · 采集器 {run.prompt.sources.length} 个 · 截断 {run.prompt.truncated} 行 · as_of {run.prompt.as_of}
              <div className="mt-1">组装依据：{run.prompt.basis}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
