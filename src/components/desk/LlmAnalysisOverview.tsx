"use client";
// LLM 分析总览（方案 B 阶段 3）
// 结构：左侧主题列表 + 右侧详情（市场环境 → 主题核心数据 → 理由 → 新闻证据 → 分层结论）
// 数据全部来自真实接口：
//   主题榜     → fetchThemes
//   大盘情绪   → fetchSentiment
//   分层结论   → enrichThemes (theme-rules 规则版)
//   新闻证据   → fetchEvents（按板块名/mappedSectors 反查匹配）
// 缺字段一律显「暂无」不造数
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchThemes, fetchSentiment, fetchEvents, fetchEventsHistory } from "@/lib/desk/quant-api";
import { enrichThemes, type ThemeMetrics } from "@/lib/quant/screener/theme-rules";
import { clockZh } from "@/lib/desk/plain-core";
import { aiChat, aiReady } from "@/lib/desk/ai";
import { useDesk } from "@/lib/desk/store";
import type { SentimentClient, ThemeRowClient, EventItemClient } from "@/lib/desk/quant-api";

type Enriched = ThemeRowClient & ThemeMetrics;

/** 数字分级 */
function fmtAmount(n: number | null | undefined, unit = "亿"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "暂无";
  const abs = Math.abs(n);
  if (abs >= 10000 && unit === "亿") return `${(n / 10000).toFixed(2)} 万亿`;
  if (abs >= 100) return `${n.toFixed(0)} ${unit}`;
  if (abs >= 10) return `${n.toFixed(1)} ${unit}`;
  return `${n.toFixed(2)} ${unit}`;
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "暂无";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function pctTone(n: number | null | undefined): string {
  if (n === null || n === undefined) return "text-muted-foreground";
  return n >= 0 ? "text-red-400" : "text-emerald-400";
}

const ROLE_LABEL: Record<string, string> = { main: "主线", sub: "支线", rotation: "轮动", watch: "观察" };
const VERDICT_LABEL: Record<ThemeMetrics["verdict"], string> = { rising: "可关注", avoid: "回避", watch: "观察" };
const VERDICT_TONE: Record<ThemeMetrics["verdict"], string> = {
  rising: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  avoid:  "bg-red-500/15 text-red-300 border-red-500/30",
  watch:  "bg-sky-500/15 text-sky-300 border-sky-500/30",
};

interface State {
  asOf: string;
  sentiment: SentimentClient | null;
  themes: Enriched[];
  events: EventItemClient[];
  loading: boolean;
  error: string;
}
const initial: State = { asOf: "", sentiment: null, themes: [], events: [], loading: true, error: "" };

/** 反查匹配：宽匹配——标题含主题名 或 板块名/主题名互相包含 */
/** 主题→关联关键词映射：细分概念用大类关键词反查事件标题
 *  事件雷达的 mappedSectors 是大类（半导体/电子元件/元器件），而主题榜是细分概念
 *  （PET 铜箔/先进封装/PCB 概念/MLCC 概念），两者不重合。
 *  用这张表把常见主题展开为关键词组，与标题做包含匹配。 */
const THEME_KEYWORDS: Record<string, string[]> = {
  // 半导体链
  "半导体":           ["半导体", "芯片", "晶圆", "台积电", "三星", "SK海力士", "HBM", "存储", "DRAM", "NAND", "英伟达", "NVIDIA", "AMD", "Intel", "台积电"],
  "先进封装":         ["先进封装", "封装", "CoWoS", "HBM", "晶圆级", "TSV", "台积电", "三星", "SK海力士", "存储"],
  "玻璃基板":         ["玻璃基板", "基板", "Glass", "TGV", "封装基板", "ABF", "载板"],
  "非金属材料":       ["非金属", "石英", "陶瓷", "石墨烯", "碳纤维", "特种玻璃"],
  "培育钻石":         ["培育钻石", "人造钻石", "合成钻石", "CVD", "HPHT", "钻石"],
  "PET铜箔":         ["PET铜箔", "PET 铜箔", "铜箔", "复合集流体", "PET 复合", "铜箔负极"],
  "元件":             ["元件", "元器件", "被动元件", "贴片元件"],
  "MLCC概念":         ["MLCC", "片式电容", "钽电容", "陶瓷电容"],
  "PCB概念":         ["PCB", "印制电路板", "覆铜板", "HDI", "服务器PCB"],
  "厨卫电器":         ["厨卫", "厨电", "小家电", "黑电", "白电", "美的", "海尔", "格力"],
  // 事件雷达里常见的大类（备用匹配）
  "券商":             ["券商", "券商", "证券", "东方财富", "中信", "华泰"],
  "银行":             ["银行", "四大行", "国有大行"],
  "煤炭":             ["煤炭", "动力煤", "焦煤", "神华"],
  "有色金属":         ["有色", "铜", "铝", "锂", "钴", "镍", "稀土"],
  "电力设备":         ["电力设备", "光伏", "风电", "储能", "宁德时代", "比亚迪"],
  "国防军工":         ["军工", "国防", "航天", "导弹", "无人机", "卫星"],
  "房地产":           ["房地产", "楼市", "房", "地产"],
  "汽车":             ["汽车", "新能源车", "整车"],
  "汽车零部件":      ["汽车零部件", "Tier", "零部件"],
  "石油石化":         ["石油", "原油", "布伦特", "WTI", "OPEC", "石化"],
  "黄金":             ["黄金", "金价", "Au"],
};

/** 反查匹配：宽匹配——标题含主题名 或 板块名/主题名互相包含 或 关联关键词命中 */
function themeNews(name: string, events: EventItemClient[]): EventItemClient[] {
  const key = name.replace(/概念|主题|产业链/g, "");
  const keywords = new Set<string>(THEME_KEYWORDS[name] ?? []);
  if (key && key !== name) keywords.add(key);
  if (key && key.length >= 2) keywords.add(key);
  keywords.add(name);

  const hit = (title: string, secs: string[]): boolean => {
    // 1) 标题包含关键词（关键词组已按主题语义精选）
    for (const kw of keywords) {
      if (kw && title.includes(kw)) return true;
    }
    // 2) mappedSectors 与主题名做精确相等或大类归属匹配：
    //    "元件" 不应匹配 "元器件"（不同细分），"半导体" 应匹配 "半导体"。
    //    仅当两者完全相同，或主题名以板块名为前缀（"半导体" ⊆ "半导体产业链"）时才算。
    for (const sec of secs) {
      if (!sec) continue;
      if (name === sec || sec === name) return true;
      // 板块名是主题名的完整前缀（主题名更具体）
      if (name.startsWith(sec + "产业链") || name.startsWith(sec + "主题") || name.startsWith(sec + "概念")) return true;
    }
    return false;
  };

  return events.filter((e) => hit(e.title ?? "", e.mappedSectors ?? [])).slice(0, 6);
}


/**
 * 本地兜底理由：不用规则版阈值语句，用「主力净流入 + 事件标题拼接」写人话。
 * 只要主题榜有数据（changePct / mainYi / rps）+ 至少一条命中新闻，就能拼出类似
 * 「当日上涨 2.35%，主力净流入 4.2 亿；板块由以下事件驱动：XXX、YYY」的形式。
 */function localReason(t: Enriched, news: { time?: string; title: string }[]): string {
  const dir = t.changePct > 0 ? "上涨" : t.changePct < 0 ? "下跌" : "横盘";
  const flow = Math.abs(t.mainYi) >= 0.5
    ? `${t.mainYi > 0 ? "主力净流入" : "主力净流出"} ${Math.abs(t.mainYi).toFixed(1)} 亿`
    : `主力净额 ${t.mainYi.toFixed(1)} 亿（未明显）`;
  const parts: string[] = [`${dir} ${fmtPct(t.changePct).replace(/\+/, "")}`, flow];
  const headline = news.slice(0, 3).map((n) => n.title).join("、");
  if (headline) parts.push(`板块由 ${headline} 等事件驱动`);
  return parts.join("；") + "。";
}

/** 本地兜底分层结论：写成人话，不用 "RPS 超过阈值" */
function localVerdict(t: Enriched, news: { time?: string; title: string }[]): string {
  const dir = t.verdict === "rising" ? "可关注" : t.verdict === "avoid" ? "回避" : "观察";
  const newsCount = news.length;
  const drivers = news.slice(0, 2).map((n) => n.title).join("、");
  const flow = t.mainYi > 0 ? `主力净流入 ${t.mainYi.toFixed(1)} 亿，资金在承接` : t.mainYi < 0 ? `主力净流出 ${Math.abs(t.mainYi).toFixed(1)} 亿，资金在退` : "主力净额接近于 0，资金态度不鲜明";
  const rpsHint = t.rps > 0 ? `，RPS 热度 ${t.rps.toFixed(0)}` : "";
  return `${dir}（评分 ${t.score.toFixed(0)}/100）。${flow}${rpsHint}。${drivers ? `驱动因素：${drivers}。` : ""}建议：${t.verdict === "rising" ? "回调低吸，不追高。" : t.verdict === "avoid" ? "暂时回避，等主线明确。" : "先观察，等信号。"}`;
}

export default function LlmAnalysisOverview() {
  const [st, setSt] = useState<State>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"industry" | "concept" | "timeline">("industry");
  /** AI 生成缓存：key = 主题 code，value = 生成文本（理由或分层结论） */
  const [aiText, setAiText] = useState<Record<string, { reason?: string; verdict?: string }>>({});
  const [aiLoading, setAiLoading] = useState<Record<string, boolean>>({});
  const [aiErr, setAiErr] = useState<Record<string, string>>({});

  /** 按当前 Tab 过滤主题列表 */
  const themesByTab = useMemo(() => {
    if (activeTab === "industry") return st.themes.filter((t) => t.kind === "industry");
    if (activeTab === "concept") return st.themes.filter((t) => t.kind === "concept");
    return st.themes; // 时间 Tab 下左侧显示全部主题
  }, [st.themes, activeTab]);

  const load = useCallback(async () => {
    setSt((s) => ({ ...s, loading: true, error: "" }));
    try {
      const [th, sent, evToday, hist] = await Promise.all([
        fetchThemes().catch(() => null),
        fetchSentiment().catch(() => null),
        fetchEvents().catch(() => ({ as_of: "", items: [] as EventItemClient[] })),
        // 拉最近几天的历史事件合并（今天+昨天+前天），今天没开盘时新闻证据不会空
        fetchEventsHistory().catch(() => null),
      ]);

      // 合并历史事件：按 date 去重，取最近 3 天（跳过今天避免重复）
      const availDates = (hist?.available_dates ?? []).filter((d) => !d.is_today && (d.rows ?? 0) > 0);
      // 并行拉最近 3 个交易日的历史
      const dateKeys = availDates.slice(0, 3).map((d) => d.date);
      const histResp = await Promise.all(dateKeys.map((d) => fetchEventsHistory({ date: d }).catch(() => null)));

      // 把历史事件转成 EventItemClient 形态（字段名兼容）
      const histItems: EventItemClient[] = [];
      for (const hr of histResp) {
        for (const it of hr?.items ?? []) {
          histItems.push({
            id: it.id,
            title: it.title,
            time: it.time,
            level: it.level,
            category: it.category,
            mappedSectors: (it as any).mapped_sectors ?? (it as any).mappedSectors ?? [],
            relatedStocks: (it as any).related_stocks ?? (it as any).relatedStocks ?? [],
            fundCheck: (it as any).fund_check ?? (it as any).fundCheck ?? {},
            stage: it.stage,
            source: it.source,
          });
        }
      }

      // 合并：今天 + 历史（按 id 去重，今天的优先）
      const seenIds = new Set<string>();
      const mergedEvents: EventItemClient[] = [];
      for (const e of [...(evToday.items ?? []), ...histItems]) {
        if (seenIds.has(e.id)) continue;
        seenIds.add(e.id);
        mergedEvents.push(e);
      }

      // 合并主题榜（主/支/观察）+ 去重
      const rawMerged: ThemeRowClient[] = [
        ...(th?.main ?? []),
        ...((th?.sub ?? []) as ThemeRowClient[]),
        ...(th?.watch ?? []),
      ];
      const seen = new Set<string>();
      const dedup = rawMerged.filter((t) => {
        if (seen.has(t.code)) return false;
        seen.add(t.code);
        return true;
      });

      // enrichThemes 补齐 heat/verdict/score/reason 等（规则版，不接 LLM）
      const fundsAvailable = dedup.some((t) => t.mainYi !== 0);
      const enriched = enrichThemes(dedup, {
        breakRate: sent?.break_rate ?? null,
        fundsAvailable,
      });
      enriched.sort((a, b) => b.heat - a.heat);

      setSt({
        asOf: th?.as_of ?? sent?.as_of ?? evToday.as_of ?? "",
        sentiment: sent,
        themes: enriched,
        events: mergedEvents,
        loading: false,
        error: "",
      });
      setSelected((prev) => prev ?? enriched[0]?.code ?? null);
    } catch (e) {
      setSt((s) => ({ ...s, loading: false, error: String((e as Error).message || e) }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(() => st.themes.find((t) => t.code === selected), [st.themes, selected]);
  const currentNews = useMemo(() => current ? themeNews(current.name, st.events) : [], [current, st.events]);

  /** 生成 AI 理由 + 分层结论：一次调用出 JSON，落到 aiText 缓存里 */
  const runAi = useCallback(async (t: Enriched) => {
    if (!current) return;
    const code = t.code;
    setAiLoading((s) => ({ ...s, [code]: true }));
    setAiErr((s) => { const n = { ...s }; delete n[code]; return n; });
    try {
      const newsLines = (currentNews ?? []).slice(0, 6).map((n) => `- [${n.time ?? ""}] ${n.title ?? ""}`).join("\n");
      const prompt = `你是 A 股行业分析师。针对下面这个主题，用一段紧凑的中文（不超过 120 字）说明"为什么这个主题今天值得关注/回避"，然后单独一行给一个【分层结论】。

主题：${t.name}（${t.code}）
当日涨跌：${fmtPct(t.changePct)}
主力净额：${fmtAmount(t.mainYi)}
规则引擎评分：${t.score.toFixed(0)}/100（分层 ${t.verdict}）
关联新闻：
${newsLines || "（暂无命中事件）"}

要求：
1. 理由部分要像人写的财经短评，不要罗列数据、不要复读新闻标题，用产业逻辑串起来。
2. 【分层结论】单独一行，格式："【分层结论】可关注/回避/观察。理由一句。"
3. 只用上面给的真实数字，不要编造。
4. 输出纯文本，不要 markdown 代码块，不要 JSON。`;
      const ai = useDesk.getState().ai;
      if (!aiReady(ai)) throw new Error("AI 未配置：请到「设置 → AI 接口」填写自有凭据");
      // 本页主题榜 / 情绪 / 事件全部是 A 股数据：显式声明 market=A，服务端按 A 股注入分流块，
      // 不让这句 A 股主题理由在美股/港股市场下被误读成美股/港股的结论。
      const text = await aiChat(ai, [{ role: "user", content: prompt }], { timeoutMs: 90_000, market: "A" });
      setAiText((s) => ({ ...s, [code]: { reason: text } }));
    } catch (e) {
      setAiErr((s) => ({ ...s, [code]: String((e as Error).message || e) }));
    } finally {
      setAiLoading((s) => ({ ...s, [code]: false }));
    }
  }, [current, currentNews]);


  return (
    <div className="w-full px-6 py-4">
      {/* 极简时间表 */}
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] text-muted-foreground">
        <span className="text-emerald-400">●</span>
        <span className="font-mono tabular-nums">
          {st.asOf ? `数据截至 ${clockZh(st.asOf) || st.asOf}` : "加载中..."}
        </span>
        <button
          onClick={() => void load()}
          disabled={st.loading}
          className="ml-auto rounded-md border border-border px-2 py-0.5 text-[12px] hover:border-sky-400/50 hover:text-sky-300 disabled:opacity-50"
        >
          刷新
        </button>
      </div>

      {st.error && (
        <div className="mb-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          加载失败：{st.error}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
        {/* 左侧：主题列表 + Tab 切换 */}
        <div className="rounded-xl border border-border bg-card p-2">
          {/* Tab 切换条 */}
          <div className="mb-2 flex items-center gap-1 rounded-lg border border-border bg-foreground/[0.02] p-0.5">
            {([["industry", "行业"], ["concept", "概念"], ["timeline", "时间"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setActiveTab(k)}
                className={`flex-1 rounded-md px-2 py-1 text-[12px] transition ${
                  activeTab === k ? "bg-sky-500/20 text-sky-300" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 列表 */}
          {activeTab === "timeline" ? (
            <TimelineList events={st.events} loading={st.loading} onPick={(code) => { setActiveTab("industry"); setSelected(code); }} />
          ) : (
            <>
              <div className="px-2 py-1 text-[12px] text-muted-foreground">
                {activeTab === "industry" ? "行业" : "概念"} · {themesByTab.length}
              </div>
              <div className="max-h-[70vh] space-y-0.5 overflow-y-auto">
                {themesByTab.length === 0 && !st.loading && (
                  <div className="px-2 py-4 text-center text-[13px] text-muted-foreground">
                    {activeTab === "industry" ? "暂无行业主题" : "暂无概念主题"}
                  </div>
                )}
                {themesByTab.map((t) => (
                  <button
                    key={t.code}
                    onClick={() => setSelected(t.code)}
                    className={`w-full rounded-md border px-2 py-1.5 text-left text-[13px] transition ${
                      selected === t.code
                        ? "border-sky-400/50 bg-sky-500/15"
                        : "border-transparent hover:bg-foreground/5"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px]">{t.verdict === "rising" ? "📈" : t.verdict === "avoid" ? "📉" : "👀"}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono tabular-nums">热度 {Math.round(t.heat)}</span>
                      <span className={`font-mono tabular-nums ${t.changePct > 0 ? "text-red-400" : t.changePct < 0 ? "text-emerald-400" : ""}`}>
                        {fmtPct(t.changePct)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 右侧：主题详情 或 时间线事件流 */}
        <div>
          {activeTab === "timeline" ? (
            <TimelinePanel events={st.events} loading={st.loading} asOf={st.asOf} />
          ) : current ? (
            <div className="rounded-xl border border-border bg-card p-4">
              {/* 主题标题行 */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-lg">🔥</span>
                <span className="text-base font-semibold">{current.name}</span>
                <span className="rounded-full border border-border bg-foreground/5 px-2 py-0.5 text-[12px] text-muted-foreground">
                  热度 {Math.round(current.heat)}
                </span>
                {current.role && (
                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[12px] text-sky-300">
                    {ROLE_LABEL[current.role] ?? current.role}
                  </span>
                )}
                <span className={`rounded-full border px-2 py-0.5 text-[12px] ${VERDICT_TONE[current.verdict]}`}>
                  {VERDICT_LABEL[current.verdict]}
                </span>
              </div>

              {/* 核心数据 4 张卡 */}
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <StatCard label="当日涨跌" value={fmtPct(current.changePct)} tone={pctTone(current.changePct)} highlight={current.changePct !== 0} />
                <StatCard label="主力净额" value={fmtAmount(current.mainYi)} tone={current.mainYi >= 0 ? "text-red-400" : "text-emerald-400"} highlight={current.mainYi !== 0} />
                <StatCard label="规则分" value={current.score.toFixed(1)} tone="text-sky-300" />
                <StatCard label="扩散度" value={current.diffusion === null ? "暂无" : `${(current.diffusion * 100).toFixed(0)}%`} tone="text-foreground" />
              </div>

              {/* 3. 理由 */}
              <div className="mt-3 rounded-lg border border-border bg-foreground/[0.02] p-3">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-[12px] font-medium text-muted-foreground">理由</div>
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] text-muted-foreground">
                      {aiText[current.code]?.reason ? "AI 生成" : "本地生成 · 数字与事件均取真实接口"}
                    </div>
                    <button
                      onClick={() => void runAi(current)}
                      disabled={aiLoading[current.code]}
                      className="rounded-md border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                    >
                      {aiLoading[current.code] ? "生成中..." : "AI 分析"}
                    </button>
                  </div>
                </div>
                {aiLoading[current.code] ? (
                  <div className="text-[14px] text-muted-foreground">AI 生成中...</div>
                ) : aiErr[current.code] && !aiText[current.code]?.reason ? (
                  <div className="text-[13px] text-red-300">生成失败：{aiErr[current.code]}</div>
                ) : aiText[current.code]?.reason ? (
                  <div className="text-[14px] leading-relaxed">{aiText[current.code].reason}</div>
                ) : (
                  <div className="text-[14px] leading-relaxed">
                    {localReason(current, currentNews.map((e) => ({ time: e.time, title: e.title ?? "" })))}
                  </div>
                )}
              </div>

              {/* 4. 新闻证据 */}
              <div className="mt-2 rounded-lg border border-border bg-foreground/[0.02] p-3">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-[12px] font-medium text-muted-foreground">新闻证据</div>
                  <div className="text-[11px] text-muted-foreground">
                    {currentNews.length > 0
                      ? "事件雷达按板块名/关键词命中"
                      : "关键词命中 0 条"}
                  </div>
                </div>
                {currentNews.length > 0 ? (
                  <div className="space-y-1">
                    {currentNews.map((e) => (
                      <div key={e.id} className="flex gap-2 text-[13px]">
                        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{e.time}</span>
                        <span className="min-w-0">{e.title}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[13px] text-muted-foreground">
                    今日事件雷达里没有关键词命中的相关新闻
                  </div>
                )}
              </div>

              {/* 5. 分层与策略结论 */}
              <div className={`mt-2 rounded-lg border p-3 ${current.verdict === "avoid" ? "border-red-400/30 bg-red-500/5" : current.verdict === "rising" ? "border-emerald-400/30 bg-emerald-500/5" : "border-sky-400/30 bg-sky-500/5"}`}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-muted-foreground">分层与策略结论</span>
                  <span className="text-[11px] text-muted-foreground">本地模板 + 规则引擎评分</span>
                </div>
                <>
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span>
                        <span className="text-muted-foreground">分层 </span>
                        <span className="font-mono">{current.verdict}</span>
                      </span>
                      <span>
                        <span className="text-muted-foreground">决策 </span>
                        <span className="font-mono">{current.verdict === "rising" ? "buy" : current.verdict === "avoid" ? "avoid" : "watch"}</span>
                      </span>
                      <span>
                        <span className="text-muted-foreground">评分 </span>
                        <span className="font-mono font-semibold">{current.score.toFixed(0)}</span>
                      </span>
                    </div>
                    <div className="mt-1 text-[13px] leading-relaxed">
                      {localVerdict(current, currentNews.map((e) => ({ time: e.time, title: e.title ?? "" })))}
                    </div>
                  </>
              </div>

              {/* 代码 */}
              <div className="mt-2 text-[12px] font-mono text-muted-foreground">{current.code}</div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-[14px] text-muted-foreground">
              {st.loading ? "加载中..." : "选一个主题看详情"}
            </div>
          )}

          {/* 数据源说明 */}
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
            主题 · 大盘情绪 · 事件雷达 · 均来自真实接口（/api/market/themes / sentiment / events），分层结论由规则引擎计算，缺字段显「暂无」不造数
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-border bg-foreground/[0.02] p-2">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function StatCard({ label, value, tone, highlight }: { label: string; value: string; tone: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 ${highlight ? "border-sky-400/40 bg-sky-500/10" : "border-border bg-foreground/[0.02]"}`}>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/** 时间线左栏小卡：紧凑显示事件，点它跳到对应主题（如果有关联） */
function TimelineList({ events, loading, onPick }: {
  events: EventItemClient[];
  loading: boolean;
  onPick: (code: string) => void;
}) {
  const sorted = [...events].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? "")).slice(0, 40);
  if (loading && sorted.length === 0) {
    return <div className="px-2 py-4 text-center text-[13px] text-muted-foreground">加载中...</div>;
  }
  if (sorted.length === 0) {
    return <div className="px-2 py-4 text-center text-[13px] text-muted-foreground">暂无事件</div>;
  }
  return (
    <div className="max-h-[70vh] space-y-1 overflow-y-auto">
      {sorted.map((e) => (
        <button
          key={e.id}
          onClick={() => {
            // 找到关联主题（用 THEME_KEYWORDS 反查）
            const hit = pickThemeFromEvent(e, THEME_KEYWORDS);
            if (hit) onPick(hit);
          }}
          className="w-full rounded-md border border-transparent px-2 py-1.5 text-left text-[12px] transition hover:bg-foreground/5"
        >
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{e.time}</span>
            <span className="text-[11px] text-sky-300">{(e.mappedSectors ?? []).slice(0, 1).join("") || "·"}</span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px]">{e.title}</div>
        </button>
      ))}
    </div>
  );
}

/** 时间线右栏面板：按时间顺序分组显示事件，每条事件带板块标签、标题、时间 */
function TimelinePanel({ events, loading, asOf }: {
  events: EventItemClient[];
  loading: boolean;
  asOf: string;
}) {
  const sorted = [...events].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🕐</span>
          <span className="text-base font-semibold">事件时间线</span>
          <span className="rounded-full border border-border bg-foreground/5 px-2 py-0.5 text-[12px] text-muted-foreground">
            {sorted.length} 条 · 最近 3 交易日
          </span>
        </div>
        <span className="text-[12px] text-muted-foreground">{asOf ? `截至 ${asOf}` : ""}</span>
      </div>

      {loading && sorted.length === 0 && (
        <div className="py-8 text-center text-[14px] text-muted-foreground">加载中...</div>
      )}
      {sorted.length === 0 && !loading && (
        <div className="py-8 text-center text-[14px] text-muted-foreground">今日事件雷达没有事件</div>
      )}

      <div className="space-y-2">
        {sorted.slice(0, 60).map((e) => (
          <div key={e.id} className="rounded-lg border border-border bg-foreground/[0.02] p-2.5">
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="font-mono tabular-nums text-muted-foreground">{e.time}</span>
              {(e.mappedSectors ?? []).slice(0, 3).map((s) => (
                <span key={s} className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">{s}</span>
              ))}
              {e.stage && (
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{e.stage}</span>
              )}
            </div>
            <div className="text-[14px] leading-relaxed">{e.title}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 从事件反查主题代码（用于时间线点跳到主题详情） */
function pickThemeFromEvent(e: EventItemClient, _keywords: Record<string, string[]>): string | null {
  // 简化：先按 mappedSectors 精确匹配主题名，找不到就返回 null
  const secs = e.mappedSectors ?? [];
  // 调用方拿到 code 会跳过去，这里简化为 null（点击不跳）
  void secs;
  return null;
}
