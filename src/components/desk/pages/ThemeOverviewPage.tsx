"use client";
// P15-R4 主题血缘总览页（对齐稳智「主题热点」单页读全故事）。
//
// 这是 R3d 纠偏后真正要的那一页：不是「一页一卡」，也不是把页面塞进子菜单，
// 而是——左边选一个主题，右边按血缘顺序把它的一整条故事从上读到底：
//   市场环境 → 主题与入口 → 关键数字 → 全字段 → 判定理由 → 新闻证据 → 分层与策略结论。
// 原来这些散在 大盘情绪 / 主线发现 / 事件雷达 / AI选股 / AI研究 五个菜单里，这里按血缘拼成一条。
//
// 纪律（用户拍板「能真算的真算，算不出显暂无数据不造」）：
// - 数据只来自既有真实接口：fetchThemes（主线发现·规则版）、fetchRisk（大盘情绪快照）、fetchEvents（事件雷达）；
// - 稳智图里有、我们数据源里没有的维度（3日资金 / 3日涨跌 / 高于近一月均价占比 / 人气集中度 / 置信度 /
//   rising/avoid/nextday_risk_score 那种分层标签）——一律显式标「暂无数据」，绝不拿相近字段冒充、绝不为凑图造数；
// - 不做行业/概念 Tab、不做日期选择器：fetchThemes 是行业+概念合并榜、且按当下快照重算不吃日期，
//   硬塞这两个控件就是给用户两个点了没反应的假开关（宁缺不假）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Layers, Loader2, RefreshCw, Search } from "lucide-react";
import { LineageCard, LineageSection, StatCard, type SectionTone } from "../ui/LineageCard";
import { DeskCollapse } from "../ui/DeskCollapse";
import { PctText, NumText, SourceBadge } from "../SourceBadge";
import { SnapshotBar } from "../SnapshotBar";
import LiveStamp from "../LiveStamp";
import { useLivePoll } from "@/hooks/use-live-poll";
import { useDesk } from "@/lib/desk/store";
import { enrichThemes, type ThemeMetrics } from "@/lib/quant/screener/theme-rules";
import {
  fetchThemes, fetchRisk, fetchEvents,
  type ThemeDiscoveryClient, type ThemeRowClient, type RiskClient, type EventItemClient,
} from "@/lib/desk/quant-api";
// R20：主力净额该显示哪个数（全A快照 vs 通达信自算子集）的取舍规则在一处
import { mainNetDisplay } from "@/lib/desk/main-net-core";

const ROLE_LABEL: Record<string, string> = { main: "主线", sub: "次主线", rotation: "轮动/跟风", watch: "观察" };
const ROLE_BADGE: Record<string, string> = {
  main: "bg-red-500/10 text-red-400 border-red-500/30",
  sub: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  rotation: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  watch: "bg-zinc-500/10 text-muted-foreground border-border",
};
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r;

function roleBadge(r: string) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${ROLE_BADGE[r] ?? ROLE_BADGE.watch}`}>
      {roleLabel(r)}
    </span>
  );
}

// P15-R5 追/避判定徽章（transparent rule verdict）
const VERDICT_LABEL: Record<ThemeMetrics["verdict"], string> = { rising: "可关注", avoid: "回避", watch: "观察" };
const VERDICT_BADGE: Record<ThemeMetrics["verdict"], string> = {
  rising: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  avoid: "bg-red-500/10 text-red-400 border-red-500/30",
  watch: "bg-zinc-500/10 text-muted-foreground border-border",
};
function verdictBadge(v: ThemeMetrics["verdict"]) {
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_BADGE[v]}`}>{VERDICT_LABEL[v]}</span>;
}

/** 有值就显示，没值/为 null 一律显「暂无数据」——不补 0、不画横杠蒙人 */
function numOr(v: number | null | undefined, render: (n: number) => string) {
  return v === null || v === undefined || !isFinite(v) ? "暂无数据" : render(v);
}

export default function ThemeOverviewPage() {
  const go = useDesk((s) => s.go);
  const setScanBoard = useDesk((s) => s.setScanBoard);

  const [data, setData] = useState<ThemeDiscoveryClient | null>(null);
  const [risk, setRisk] = useState<RiskClient | null>(null);
  const [events, setEvents] = useState<EventItemClient[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState("");
  // R17b：这页的关键数字就是板块当日涨幅与主力净额，接全站轮询钩子跟看板同拍刷新（休市暂停）
  const poll = useLivePoll();

  const load = useCallback(async (force = false) => {
    setBusy(true);
    // 三路并进，任一路挂都不拖累其它两路：主题榜是主角，环境/新闻是配角，配角缺了照样读主线。
    const [t, r, ev] = await Promise.allSettled([fetchThemes(force), fetchRisk(), fetchEvents()]);
    if (t.status === "fulfilled") { setData(t.value); setError(""); }
    else {
      setError(String((t.reason as Error).message || t.reason));
      // 轮询那一拍失败不清空画面：屏上仍是上一批真实读数，as_of 时刻照实挂着；只有手动「立即重算」失败才清空
      if (force) setData(null);
    }
    setRisk(r.status === "fulfilled" ? r.value : null);
    setEvents(ev.status === "fulfilled" ? ev.value.items : []);
    setBusy(false);
  }, []);
  useEffect(() => { void load(false); }, [load, poll.tick]);

  // 合并四组 → 去重 → 按 score 倒序（score 是 theme-rules 规则版分数，不是稳智热度分，页面照实标「规则分」）
  const allThemes = useMemo(() => {
    if (!data) return [];
    const arr = [...data.main, ...data.sub, ...data.rotation, ...data.watch];
    const seen = new Set<string>();
    return arr
      .filter((t) => (seen.has(t.code) ? false : (seen.add(t.code), true)))
      .sort((a, b) => b.score - a.score);
  }, [data]);

  // 东财板块榜断源、走腾讯兜底榜时：mainYi 是兜底占位 0，不是「真·主力净额 0 亿」。
  // 发现接口的缺失登记(missing含"主力净额")或来源串("腾讯板块兜底")任一命中即判定资金读数不可信——
  // 主力类字段一律显「—/暂无数据」，绝不把占位 0 当实数画出来（与板块页 fundsMissing 同一纪律）。
  const fundsMissing = !!data && (
    data.missing.some((m) => m.includes("主力净额")) || /腾讯板块兜底/.test(data.source.provider));

  // P15-R6 徽标出身不写死：断源换榜（同花顺/腾讯）时徽标跟着来源走，不继续谎称「东财板块」。
  const boardSource = data
    ? (/同花顺/.test(data.source.provider) ? "同花顺资金流" : /腾讯板块兜底/.test(data.source.provider) ? "腾讯兜底榜" : "东财板块")
    : "东财板块";

  // P15-R5 四规则读数：吃上面这些真实字段 + 全市场炸板率，缺源项在纯核里自动剔除重归一（不造 0）。
  // 这是「用我们自己的算法模仿稳智、要求真实」的落点——透明规则分，口径每项可回溯，非稳智黑箱/非涨跌概率。
  const enrichedAll = useMemo(
    () => enrichThemes(allThemes, { breakRate: risk?.break_rate ?? null, fundsAvailable: !fundsMissing }),
    [allThemes, risk, fundsMissing],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return enrichedAll;
    return enrichedAll.filter((t) => t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q));
  }, [enrichedAll, query]);

  const selected: (ThemeRowClient & ThemeMetrics) | null =
    filtered.find((t) => t.code === selectedCode) ?? filtered[0] ?? null;

  // P15-R5 可关注方向：全榜（非当前搜索）里判为 rising 的前 3，凑不满不硬塞（对齐稳智「最多 3 方向」）
  const risingDirs = enrichedAll.filter((t) => t.verdict === "rising").sort((a, b) => b.heat - a.heat).slice(0, 3);

  // 新闻证据：既有事件雷达按「板块名 / mappedSectors」反查匹配——这是关键词命中，不是主题级新闻源，页面上照实写。
  const themeNews = useMemo(() => {
    if (!selected) return [];
    const name = selected.name;
    return events
      .filter((e) =>
        (e.mappedSectors ?? []).some((s) => s && (s === name || s.includes(name) || name.includes(s))) ||
        (e.title ?? "").includes(name))
      .slice(0, 6);
  }, [events, selected]);

  // 去选股递棒：板块代码必须是东财 BKxxxx、且带上行业/概念归属，才递得动（与板块页同一「宁缺不假」口径）
  const canScreen = !!selected?.kind && /^BK\d{4}$/i.test(selected.code);
  const screenSelected = () => {
    if (!selected || !canScreen) return;
    setScanBoard({ code: selected.code, name: selected.name, kind: selected.kind! });
    go("aiscan");
  };

  // R20：主力净额显示哪一源的哪个数——派生量，不新造事实
  const themeMainNet = mainNetDisplay(risk);

  const envTone: SectionTone = !risk
    ? "info"
    : /高风险/.test(risk.risk.level) ? "danger"
      : /高|注意/.test(risk.risk.level) ? "warning"
        : "success";

  return (
    <div className="w-full space-y-3 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><Layers size={18} className="text-sky-400" /> 主题血缘总览</div>
          <div className="text-[12px] text-muted-foreground">左边选主题，右边按血缘读完整一条：市场环境 → 主题入口 → 关键数字 → 理由 → 新闻 → 分层结论 · 规则版不接大模型</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <LiveStamp poll={poll} iso={data?.as_of ?? ""} />
          {data && <SourceBadge status="LIVE" source={boardSource} time={data.as_of.slice(11, 19)} />}
          <button onClick={() => load(true)} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 立即重算
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        主线发现本轮没取到：{error}。{data && <span>画面停在上一批真实读数上（截至 {data.as_of.slice(11, 19)}），不是这一轮的。</span>}下方环境/新闻若已取到仍会照实显示。
      </div>}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* 左：真实主题榜（按规则分排序 + 关键词过滤）。不摆行业/概念 Tab、不摆日期选择器——数据口径不支持，摆了就是假控件 */}
        <div className="apple-card flex max-h-[78vh] min-w-0 flex-col p-3">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索主题名/代码"
              className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-xs outline-none focus:border-sky-500/50"
            />
          </div>
          <div className="mt-1 px-0.5 text-[11.5px] text-muted-foreground">
            {busy && !data ? "加载主题榜…" : `共 ${allThemes.length} 个发现主题${query ? ` · 匹配 ${filtered.length}` : ""}`}
          </div>
          <div className="desk-scroll mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {busy && !data && (
              <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" /> 正在拉取板块榜…</div>
            )}
            {!busy && !filtered.length && (
              <div className="px-1 py-6 text-xs text-muted-foreground">
                {data ? "没有匹配的主题（换个关键词试试）" : "暂无主题榜数据"}
              </div>
            )}
            {filtered.map((t) => {
              const active = selected?.code === t.code;
              return (
                <button
                  key={t.code}
                  onClick={() => setSelectedCode(t.code)}
                  className={`block w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${active ? "border-sky-500/50 bg-sky-500/10" : "border-border/70 hover:border-sky-500/30"}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{t.name}</span>
                    <span className="shrink-0 font-mono text-[12px] text-muted-foreground" title="P15-R5 主题热度：RPS/扩散/资金/涨幅/连涨 榜内分位加权，缺项剔除重归一（规则分，非稳智黑箱分）">热度 {t.heat}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    {roleBadge(t.role)}
                    {verdictBadge(t.verdict)}
                    <span className="text-[11px] text-muted-foreground">{t.code}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
                    <span>主力 <NumText value={fundsMissing ? null : t.mainYi} digits={1} suffix="亿" /></span>
                    <span>当日涨幅 <PctText value={t.changePct} /></span>
                    <span>流入 {t.streakInflow ?? "—"}日</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 右：一条血缘故事 */}
        {selected ? (
          <LineageCard
            className="min-w-0"
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span>{selected.name}</span>
                {roleBadge(selected.role)}
                <span className="text-[12px] font-normal text-muted-foreground">{selected.code}{selected.kind ? ` · ${selected.kind === "industry" ? "行业" : "概念"}` : ""}</span>
              </span>
            }
            note={`按血缘顺序读这一条主题。数据出身：${data?.source.provider ?? "—"}；${data?.trade_date ?? ""} 快照。`}
            actions={
              canScreen ? (
                <button onClick={screenSelected} className="flex items-center gap-1 rounded-md border border-sky-500/50 bg-sky-500/15 px-2.5 py-1.5 text-xs text-sky-200 hover:bg-sky-500/25">
                  查看该主题个股 <ArrowRight size={12} />
                </button>
              ) : (
                <span title="板块代码非东财 BKxxxx 或归属未知，递到选股页只会报「板块代码非法」，故不出按钮（宁缺不假）"
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground/70">
                  暂不可去选股
                </span>
              )
            }
          >
            {/* 1 · 市场环境 */}
            <LineageSection title="市场环境" tone={envTone} hint="全A快照 · fetchRisk" divided={false}>
              {risk ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded border px-2 py-0.5 font-medium ${envTone === "danger" ? "border-red-500/30 bg-red-500/10 text-red-300" : envTone === "warning" ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>
                      风险：{risk.risk.level}
                    </span>
                    {risk.risk.triggers.length > 0 && (
                      <span className="text-muted-foreground">触发：{risk.risk.triggers.join("、")}</span>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <StatCard label="涨/跌家数" value={`${risk.advancers}/${risk.decliners}`} title="全A快照上涨/下跌家数" />
                    <StatCard label="涨停" value={String(risk.limit_up)} toneClass="text-red-400" title="涨停家数" />
                    <StatCard label="炸板率" value={risk.break_rate == null ? "—" : `${risk.break_rate.toFixed(0)}%`} title="封板后炸板比例，触板为0时无值" />
                    <StatCard label="成交额" value={risk.amount_known > 0 ? `${risk.amount_total_yi.toFixed(0)}亿` : "暂无数据"} title={risk.amount_known > 0 ? "全A快照成交额合计（当日抓到的家数口径）" : "成交额一家都没抓到，合计0不等于0亿"} />
                  </div>
                  <div className="mt-2 text-[12px] leading-5 text-muted-foreground">
                    个股中位涨跌 <PctText value={risk.median_pct} /> · 主力净额合计 {themeMainNet ? <span title={themeMainNet.hint}><NumText value={themeMainNet.value} digits={0} suffix=" 亿" />{themeMainNet.selfComputed ? "（自算）" : ""} <span className="opacity-70">{themeMainNet.label}</span></span> : "暂无数据"}
                    {risk.missing.length > 0 && <span className="ml-1">（缺失：{risk.missing.join("；")}）</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="text-muted-foreground">AI 综述：暂无（本页不自动触发研究，规则版只拼真实读数）。</span>
                    <button onClick={() => go("research")} className="inline-flex items-center gap-1 text-sky-300 hover:underline">
                      去 AI 市场研究生成 <ArrowRight size={11} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">市场环境快照本次未取到（{busy ? "加载中…" : "fetchRisk 无返回"}），不冒充实数。</div>
              )}
            </LineageSection>

            {/* 3 · 关键数字 */}
            <LineageSection title="关键数字" hint="真实字段 · 规则版发现 + P15-R5 透明规则分">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <StatCard label="主题热度" value={`${selected.heat}`} toneClass={selected.heat >= 65 ? "text-red-400" : selected.heat >= 45 ? "text-amber-400" : "text-muted-foreground"} title="P15-R5 规则合成分：RPS/扩散/资金/涨幅/连涨 各转榜内分位后加权，缺项剔除重归一。是仿稳智「热度」的透明算法，非稳智黑箱分。悬停看计入项。" />
                <StatCard label="证据置信" value={`${selected.confidence}（${selected.confidenceLabel}）`} toneClass={selected.confidence >= 70 ? "text-emerald-400" : selected.confidence >= 40 ? "text-sky-300" : "text-muted-foreground"} title={`P15-R5 置信 = 证据一致度×数据齐全度（${selected.confidenceNote}）。缺源越多、信号越反相，分越低——把断源变成看得见的扣分，不是预测准确率。`} />
                <StatCard label="次日过热/背离" value={`${selected.risk}（${selected.riskLabel}）`} toneClass={selected.risk >= 60 ? "text-red-400" : selected.risk >= 35 ? "text-amber-400" : "text-emerald-400"} title="P15-R5 规则读数：涨幅过陡/连涨高位/涨价但主力流出/全市场炸板率/涨幅高扩散弱 加权。只是「追高风险有多大」的透明读数，不等于明日涨跌概率。" />
                <StatCard label="规则分" value={selected.score.toFixed(1)} title="规则引擎加权分：RPS/扩散/资金连续/价量同向；用于主线/次主线分层判定" />
                <StatCard label="今日主力净额" value={fundsMissing ? "暂无数据" : numOr(selected.mainYi, (n) => `${n.toFixed(1)} 亿`)} toneClass={fundsMissing ? "text-muted-foreground" : selected.mainYi > 0 ? "text-red-400" : selected.mainYi < 0 ? "text-emerald-400" : ""} title={fundsMissing ? "当前这份板块榜不含资金读数：主力是占位 0 不是实数，显暂无" : "板块主力净流入(亿)"} />
                <StatCard label="今日涨幅" value={numOr(selected.changePct, (n) => `${n.toFixed(2)}%`)} toneClass={selected.changePct > 0 ? "text-red-400" : selected.changePct < 0 ? "text-emerald-400" : ""} title="板块当日涨跌幅" />
                <StatCard label="榜内 RPS" value={numOr(selected.rps, (n) => n.toFixed(0))} title="行业+概念合并榜内涨幅百分位（非全市场）" />
                <StatCard label="内部扩散度" value={selected.diffusion == null ? "暂无数据" : `${(selected.diffusion * 100).toFixed(0)}%`} title="板块成分中上涨家数占比；成分快照无返回时为暂无" />
                <StatCard label="连续资金流入" value={numOr(selected.streakInflow, (n) => `${n} 日`)} title="主力连续净流入天数" />
                <StatCard label="连续强势" value={numOr(selected.streakPct, (n) => `${n} 日`)} title="板块指数连续收涨天数（东财板块日K）" />
              </div>
              <div className="mt-2 space-y-1 text-[12px] leading-5 text-muted-foreground">
                <div><span className="text-foreground/80">热度计入项：</span>{selected.heatParts.join(" · ")}</div>
                <div><span className="text-foreground/80">风险主要来源：</span>{selected.riskParts.join(" · ")}</div>
              </div>
              <div className="mt-2 rounded-lg border border-border/70 bg-card/40 px-2.5 py-1.5 text-[12px] leading-5 text-muted-foreground">
                以下参考维度本页无数据源，不臆测、不拿相近字段顶替：
                <span className="text-foreground/80"> 3日资金 · 3日涨跌 · 高于近一月均价占比（主题口径）· 人气集中度</span>
                <span className="ml-1">（热度/置信/次日风险已改为上方 P15-R5 透明规则读数）</span>
              </div>
            </LineageSection>

            {/* 4 · 全字段展开 */}
            <LineageSection title="全字段展开" hint="该主题本次真实读数">
              <DeskCollapse title="展开该主题的全部已知字段与缺失口径" defaultOpen={false} hint="供核对，不新增判定">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-3">
                  {[
                    ["代码", selected.code],
                    ["归属", selected.kind === "industry" ? "行业" : selected.kind === "concept" ? "概念" : "暂无数据"],
                    ["角色", roleLabel(selected.role)],
                    ["规则分", selected.score.toFixed(1)],
                    ["今日涨幅", `${selected.changePct.toFixed(2)}%`],
                    ["今日主力净额", fundsMissing ? "暂无数据（该榜不含资金读数）" : `${selected.mainYi.toFixed(1)} 亿`],
                    ["榜内RPS", selected.rps.toFixed(0)],
                    ["内部扩散度", selected.diffusion == null ? "暂无数据" : `${(selected.diffusion * 100).toFixed(0)}%`],
                    ["连续强势", selected.streakPct == null ? "暂无数据" : `${selected.streakPct} 日`],
                    ["连续资金流入", selected.streakInflow == null ? "暂无数据" : `${selected.streakInflow} 日`],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-0.5">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-mono text-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-2 text-[12px] text-muted-foreground/80">
                  口径：{data?.missing.join("；") || "无额外缺失登记"}
                </div>
              </DeskCollapse>
            </LineageSection>

            {/* 5 · 判定理由 */}
            <LineageSection title="判定理由" tone="info">
              {selected.reasons.length ? (
                <ul className="space-y-1 text-[13.5px] leading-6">
                  {selected.reasons.map((r, i) => (
                    <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-sky-400/70" /><span>{r}</span></li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs text-muted-foreground">该主题未触发任何规则理由项。</div>
              )}
            </LineageSection>

            {/* 6 · 新闻证据 */}
            <LineageSection title="新闻证据" tone={themeNews.length ? "success" : "info"} hint="按板块关键词匹配 · 非主题级新闻源">
              {themeNews.length ? (
                <div className="space-y-1.5">
                  {themeNews.map((e) => (
                    <div key={e.id} className="rounded-lg border border-border/70 bg-card/40 px-2.5 py-1.5">
                      <div className="text-[13.5px] leading-5">{e.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span>{e.time}</span>
                        {e.level && <span className="rounded border border-border px-1">{e.level}</span>}
                        {e.category && <span className="rounded border border-border px-1">{e.category}</span>}
                        <span>{e.source}</span>
                      </div>
                    </div>
                  ))}
                  <div className="text-[11.5px] text-muted-foreground/80">命中方式：事件的板块标签 / 标题 包含「{selected.name}」，属关键词反查，非该主题专属新闻流。</div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">本次事件雷达里没有关键词命中「{selected.name}」的记录（不代表没有消息，只代表当前抓取窗口内无匹配）。</div>
              )}
            </LineageSection>

            {/* 7 · 分层与策略结论 */}
            <LineageSection title="分层与策略结论" tone={selected.verdict === "avoid" ? "danger" : selected.verdict === "rising" ? "success" : selected.role === "main" ? "warning" : "info"}>
              <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
                <span>方向判定：</span>
                {verdictBadge(selected.verdict)}
                {roleBadge(selected.role)}
                <span className="text-muted-foreground">热度 {selected.heat} · 置信 {selected.confidence} · 次日风险 {selected.risk}</span>
              </div>
              <div className="mt-1 text-[12.5px] leading-5 text-muted-foreground">{selected.verdictReason}。</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                <span className="text-muted-foreground">本榜可关注方向（≤3，不凑数）：</span>
                {risingDirs.length ? risingDirs.map((r) => (
                  <button key={r.code} onClick={() => setSelectedCode(r.code)} className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300 hover:bg-emerald-500/20">
                    {r.name} <span className="font-mono text-[11px] opacity-80">热度{r.heat}</span>
                  </button>
                )) : <span className="text-muted-foreground">今日无达标方向（热度/置信/风险未同时过线，不硬凑）</span>}
              </div>
              <div className="mt-2 text-[12px] leading-5 text-muted-foreground">
                口径：这里的「可关注/回避/观察」和热度/置信/次日风险，全是本页
                <span className="text-foreground/80"> 透明规则引擎的读数</span>
                （阈值 + 榜内分位加权，每项可回溯，非投资建议）。它是对稳智「可追/回避/次日风险」那套不公开算法的
                <span className="text-foreground/80"> 自主模仿</span>
                ，算法明码，但
                <span className="text-foreground/80">不等于</span>
                稳智后端/大模型 的原版结果，更不是明日涨跌概率。
              </div>
            </LineageSection>
          </LineageCard>
        ) : (
          <div className="apple-card flex items-center justify-center p-10 text-sm text-muted-foreground">
            {busy ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> 正在拉取主题榜…</span> : "左侧选择一个主题，这里按血缘顺序展开它的完整故事。"}
          </div>
        )}
      </div>

      <SnapshotBar kind="themes" label="主题发现"
        sideEffect="留档这一下会绕过 45 秒内存缓存、在服务端重算一次主线发现（板块榜 + 成分扩散 + 板块资金/日K），存的是那一刻的结果。" />
    </div>
  );
}
