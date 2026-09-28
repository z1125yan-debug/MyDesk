"use client";
// 产业链研报分析 · 板块深度决策研究（仿稳智「研究结论」头 + 分区分块）。
//
// 稳智契约（.box-agent-scratch/wenzhi-reverse/js/flowVisualRegistry-BCNn6fhT.js）：
//   decisionSignal 头 → 📌 核心结论 / 📌 依据 / 📈 关键信号 / 📊 强弱量价 /
//   🧪 反证状态 / 🗓️ 触发条件 / 🛑 失效条件 / 📦 仓位节奏 / ⚠️ 风险提示 / 🧭 操作参考。
// 关键：稳智**没有**"分数"字段——那只是决策引擎内部用的。展示层是「结论 + 分区分块」，
// 每块展示一句人话，不是 13 格评分网格。倾向 / 置信度是**结论的修饰语**，不是独立卡。
//
// 本页面：
// ① 顶部板块选择器（默认今日主线第一条）
// ② 决策卡：头（板块名 + 结论一句话 + 倾向/置信度标签）+ 分区分块（8 段）
// ③ AI 未生成时，「依据 / 强弱量价」由服务端五维数据直接拼（不依赖 AI，永远可见）
//    AI 段（核心结论 / 关键信号 / 反证 / 触发 / 失效 / 仓位 / 风险 / 操作）用"待生成"占位
//    —— 不用引擎分数假装结论，不派生倾向/置信度数字
// ④ 技术细节（台账 / 采集器 / 核对）折叠，默认收起

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Sparkles, Target } from "lucide-react";
import { SourceBadge } from "../SourceBadge";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { LineageCard, LineageSection, type SectionTone } from "../ui/LineageCard";
import { useDesk } from "@/lib/desk/store";
import { aiReady } from "@/lib/desk/ai";
import { RESEARCH_RUN_STATUS_TEXT, runMarketResearch, type ResearchRunResult } from "@/lib/desk/research-run";
import {
  fetchEvents, fetchRadar, fetchRisk, fetchThemes,
  type EventItemClient, type RadarItemClient, type ResearchLoadClient, type RiskClient, type ThemeDiscoveryClient,
} from "@/lib/desk/quant-api";
// R20：主力净额该显示哪个数（全A快照 vs 通达信自算子集）的取舍规则在一处
import { mainNetDisplay } from "@/lib/desk/main-net-core";
import {
  COLLECTOR_STATUS_TEXT,
  researchLayerSections, renderResearchTrace,
  type EvidenceLine, type ResearchReport, type SourceProbe,
} from "@/lib/quant/screener/research-core";
import { plainify } from "@/lib/desk/plain-core";

// —— 稳智分区（顺序按 flowVisualRegistry 里的 a 对象）——
type SectionKey =
  | "core_judgement" | "data_basis" | "signals" | "capital_flow"
  | "falsification" | "trigger" | "invalidation"
  | "position_plan" | "risk" | "action";

const SECTION_LABEL: Record<SectionKey, string> = {
  core_judgement: "📌 核心结论",
  data_basis: "📌 依据",
  signals: "📈 关键信号",
  capital_flow: "📊 强弱 / 量价",
  falsification: "🧪 反证状态",
  trigger: "🗓️ 触发条件",
  invalidation: "🛑 失效条件",
  position_plan: "📦 仓位节奏",
  risk: "⚠️ 风险提示",
  action: "🧭 操作参考",
};

// 分区内容来源标记：server=服务端真实读数，ai=AI 生成，engine=引擎判定
type SourceTag = "server" | "ai" | "engine" | "empty";

interface SectorFacts {
  name: string;
  code: string;
  role: string;
  changePct: number | null;
  mainYi: number | null;
  rps: number;
  diffusion: number | null;
  streakPct: number | null;
  reasons: string[];
}

// 板块研究问题（会原样进 AI prompt；服务端 scope 仍是 market，但 AI 会聚焦到这个板块）
function questionOf(name: string, role: string): string {
  const roleZh = role === "main" ? "主线" : role === "sub" ? "次主线" : "观察方向";
  return [
    `分析「${name}」这个方向今天能不能做？这是判定为${roleZh}的板块。`,
    `只围绕板块本身回答，不要泛谈大盘；不要写数据工程口径（不要出现"数据缺失""未接入""下一步查询""拆分""补充数据源""成分股快照"这类词）。`,
    `输出必须是**普通人能看懂的一句中文短话**：结论先说能不能做（"可以做"、"不适合做"、"看情况"三选一，然后一句话说明为什么）。`,
    `未知项 (unknowns) 只写市场面 / 交易面**用户能理解的**未知（比如"这个板块的龙头还没表态""周末有政策风险"），不要写内部数据缺失。`,
    `下一步核查 (next_checks) 只写用户能理解的**市场观察动作**（比如"看明天能不能维持量价齐升""等龙头股放量确认"），不要写"去查询某个数据源""补充某个字段"这类工程动作。`,
    `风险提示 (risks) 说风险事件本身，不说数据缺失。`,
    `禁止概率/涨幅预测；禁止输出具体百分比仓位数字。`,
  ].join(" ");
}

// 引擎 role 到板块分类的中文（只用于展示"这是什么板块"）
function roleLabel(role: string): { text: string; tone: string } {
  switch (role) {
    case "main": return { text: "今日主线", tone: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
    case "sub": return { text: "次主线", tone: "text-sky-300 border-sky-500/40 bg-sky-500/10" };
    case "rotation": return { text: "轮动 / 跟风", tone: "text-amber-300 border-amber-500/40 bg-amber-500/10" };
    case "watch": return { text: "观察", tone: "text-muted-foreground border-border bg-background/40" };
    default: return { text: "板块", tone: "text-muted-foreground border-border bg-background/40" };
  }
}

// AI 报告 → 分区内容映射（复用现有 ResearchReport，不新增后端字段）
interface DecisionSections {
  core_judgement: { lines: string[]; source: SourceTag };
  data_basis: { lines: string[]; source: SourceTag };
  signals: { lines: string[]; source: SourceTag };
  capital_flow: { lines: string[]; source: SourceTag };
  falsification: { lines: string[]; source: SourceTag };
  trigger: { lines: string[]; source: SourceTag };
  invalidation: { lines: string[]; source: SourceTag };
  position_plan: { lines: string[]; source: SourceTag };
  risk: { lines: string[]; source: SourceTag };
  action: { lines: string[]; source: SourceTag };
}

// 用户看得懂 = 不是数据工程口径。凡是命中以下词的条目，前端不显示（数据本身还在，只是不上屏）
// 稳智的 falsification / trigger / risk 是市场面语言，不是"某某数据缺失""下一步查询数据源"这种内部口径
const JARGON_PATTERN = /(?:数据缺失|数据未|未接入|未接入|未覆盖|数据源|取数|台账|采集器|能力表|缺失口径|查询|获取|补充|拆分|成分股快照|补充数据源|替代数据源|接入|补录|落库|复校验|口径|分层|派生|口径不覆盖|口径不对应|口径无对应|引擎判|引擎自|内部扩散|快照)/;
// "是主线之一"这种描述现状的话，不是"能不能做"的结论
const DESC_ONLY_PATTERN = /(?:^|\W)(?:是|为|属|属于|位列|之一|板块|板块为|是[^\u4e00-\u9fa5]*主线|为主线|是主线|是次主线)/;

function isJargonLine(line: string): boolean {
  return JARGON_PATTERN.test(line);
}

function filterUserFacing(lines: string[]): string[] {
  return lines.filter((l) => !isJargonLine(l));
}

function CollectorRow({ s }: { s: SourceProbe }) {
  const tone = s.status === "ok" ? "text-emerald-300" : s.status === "failed" ? "text-red-300" : "text-amber-300";
  const head = s.status === "ok" ? "取到" : s.status === "failed" ? "失败" : s.status === "empty" ? "为空" : "无来源";
  return (
    <div className="rounded-lg border border-border/70 bg-card/50 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-semibold">{s.title}</span>
        <span className={`font-mono ${tone}`}>{head}</span>
        <SourceBadge status={s.data_status} source={s.source} time={s.as_of} />
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {COLLECTOR_STATUS_TEXT[s.status]} · 出台账 {s.lines} 行{s.note ? ` · ${s.note}` : ""}
      </div>
    </div>
  );
}

function LedgerLine({ l }: { l: EvidenceLine }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono font-semibold">{l.id}</span>
        <span className="text-muted-foreground">{l.layer}</span>
        <SourceBadge status={l.data_status} source={l.source} time={l.as_of} />
      </div>
      <div className="mt-1 text-[12.5px] leading-snug">{l.text}</div>
    </div>
  );
}

function SourceDot({ tag }: { tag: SourceTag }) {
  if (tag === "empty") return null;
  const map: Record<Exclude<SourceTag, "empty">, { label: string; cls: string }> = {
    server: { label: "今日真实读数", cls: "text-emerald-300/80" },
    engine: { label: "主线判定引擎", cls: "text-sky-300/80" },
    ai: { label: "AI 生成", cls: "text-fuchsia-300/80" },
  };
  const m = map[tag];
  return <span className={`text-[11px] ${m.cls}`}>{m.label}</span>;
}

// 稳智分区块
function DecisionSection({ id, lines, source }: { id: SectionKey; lines: string[]; source: SourceTag }) {
  const has = lines.length > 0;
  const isAi = source === "ai" || source === "empty";
  return (
    <div className={`rounded-lg border px-3 py-2 ${
      has ? "border-border/70 bg-card/50" : "border-dashed border-border/60 bg-background/30"
    }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold tracking-wide text-fuchsia-300/90">{SECTION_LABEL[id]}</div>
        <SourceDot tag={source} />
      </div>
      {has ? (
        <ul className="mt-1.5 space-y-1 text-[13.5px] leading-relaxed">
          {lines.map((l, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/60">·</span>
              <span className="min-w-0 flex-1">{l}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-[12.5px] text-muted-foreground">
          {isAi ? "待生成（点上方「生成板块决策」）" : "—"}
        </div>
      )}
    </div>
  );
}

export default function ResearchPage() {
  const ai = useDesk((s) => s.ai);

  // 板块数据
  const [themes, setThemes] = useState<ThemeDiscoveryClient | null>(null);
  const [topErr, setTopErr] = useState<Record<string, string>>({});
  const [topBusy, setTopBusy] = useState(false);
  // 上下文：大盘 + 事件 + 雷达
  const [risk, setRisk] = useState<RiskClient | null>(null);
  const [radar, setRadar] = useState<{ as_of: string; items: RadarItemClient[] } | null>(null);
  const [events, setEvents] = useState<{ as_of: string; items: EventItemClient[] } | null>(null);

  // 板块选择
  const [selectedCode, setSelectedCode] = useState<string>("");

  // 研究层
  const [customQuestion, setCustomQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ResearchRunResult | null>(null);
  const [view, setView] = useState<ResearchLoadClient | null>(null);
  const [err, setErr] = useState("");
  // 板块决策卡的 AI 结果（本地拼装，不走落库；因为 scope 目前只支持 market）
  const [sectorAi, setSectorAi] = useState<{ name: string; report: ResearchReport | null; at: string } | null>(null);

  // 加载板块与上下文数据（并发）
  const loadTop = useCallback(async () => {
    setTopBusy(true);
    const errs: Record<string, string> = {};
    const [a, b, c, d] = await Promise.allSettled([fetchRisk(), fetchThemes(), fetchRadar(), fetchEvents()]);
    if (a.status === "fulfilled") setRisk(a.value); else { setRisk(null); errs.risk = String(a.reason?.message ?? a.reason); }
    if (b.status === "fulfilled") setThemes(b.value); else { setThemes(null); errs.themes = String(b.reason?.message ?? b.reason); }
    if (c.status === "fulfilled") setRadar(c.value); else { setRadar(null); errs.radar = String(c.reason?.message ?? c.reason); }
    if (d.status === "fulfilled") setEvents(d.value); else { setEvents(null); errs.events = String(d.reason?.message ?? d.reason); }
    setTopErr(errs);
    setTopBusy(false);
  }, []);

  useEffect(() => { void loadTop(); }, [loadTop]);

  // 自动选中今日主线第一条
  useEffect(() => {
    if (!themes || selectedCode) return;
    const first = (themes.main ?? [])[0] ?? (themes.sub ?? [])[0];
    if (first) setSelectedCode(String(first.code ?? first.name));
  }, [themes, selectedCode]);

  // 切板块就清掉旧 AI 结果 + 自动跑一次（用户不用手点）。
  // 稳智同款：切板块 = 一份新结论，不显示上一板块的残留。
  useEffect(() => {
    if (!sectorFacts || running) return;
    setSectorAi(null);
    setView(null);
    // 用 setTimeout 让 setState 先落地，避免和切板块的其它 set 交错
    const t = setTimeout(() => { void runSectorDecision(); }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode]);

  // 当前选中的板块事实
  const sectorFacts: SectorFacts | null = useMemo(() => {
    if (!themes) return null;
    const all = [...(themes.main ?? []), ...(themes.sub ?? []), ...(themes.rotation ?? []), ...(themes.watch ?? [])];
    const row = all.find((t) => String(t.code ?? t.name) === selectedCode);
    if (!row) return null;
    return {
      name: row.name,
      code: String(row.code ?? row.name),
      role: row.role,
      changePct: typeof row.changePct === "number" ? row.changePct : null,
      mainYi: typeof row.mainYi === "number" ? row.mainYi : null,
      rps: typeof row.rps === "number" ? row.rps : 0,
      diffusion: typeof row.diffusion === "number" ? row.diffusion : null,
      streakPct: typeof row.streakPct === "number" ? row.streakPct : null,
      reasons: (row.reasons ?? []).slice(0, 5),
    };
  }, [themes, selectedCode]);

  // 用户点"生成板块决策"→ 调 runMarketResearch（scope=market，question 聚焦到板块）
  const runSectorDecision = async () => {
    if (!sectorFacts) return;
    const question = customQuestion.trim() || questionOf(sectorFacts.name, sectorFacts.role);
    setRunning(true); setErr("");
    try {
      const r = await runMarketResearch(ai, { question });
      setRun(r);
      setSectorAi({ name: sectorFacts.name, report: r.store?.report ?? null, at: new Date().toISOString() });
      // 用 store 返回的 evidence/sources/missing 回填 view，供"技术细节"折叠区展示
      setView({
        ok: !!r.store?.ok,
        as_of: r.store?.date ?? "",
        today: r.store?.date ?? "",
        scope: r.store?.scope ?? "market",
        report: (r.store?.report ?? null) as ResearchLoadClient["report"],
        evidence: r.prompt?.lines ?? [],
        sources: r.prompt?.sources ?? r.store?.sources ?? [],
        missing: r.missing ?? [],
        available_dates: [],
        counts: { rows: 0, interpreted: 0, partial: 0, rejected: 0 },
        layering: "", self_check: { broken_payload: [] }, basis: r.prompt?.basis ?? "", probed_at: "", error: r.store?.error ?? null,
      } as ResearchLoadClient);
    } catch (e) {
      setRun({
        ok: false, status: "AI_FAILED", message: String((e as Error).message || e), model: ai.model || "未配置",
        prompt_version: "", evidence_total: 0, raw_chars: 0, prompt: null, store: null, missing: [],
      });
    } finally {
      setRunning(false);
    }
  };

  const rep = sectorAi?.report ?? null;

  // 分区内容拼装（服务端派生 + AI 结果 + 空占位）
  const sections: DecisionSections = useMemo(() => {
    const d = sectorFacts;
    const ai = rep;

    // 📌 依据 — 服务端真实读数
    const basis: string[] = [];
    if (d?.changePct !== null && d?.changePct !== undefined) basis.push(`今日涨幅 ${d.changePct.toFixed(2)}%`);
    if (d?.mainYi !== null && d?.mainYi !== undefined) basis.push(`板块主力资金净额 ${d.mainYi.toFixed(1)} 亿`);
    if (d?.rps) basis.push(`RPS 相对强度 ${d.rps.toFixed(0)}（相对全市场分位）`);
    const data_basis = basis.length ? { lines: basis, source: "server" as SourceTag } : { lines: [], source: "empty" as SourceTag };

    // 📈 关键信号 — 引擎判定 reasons（服务端）
    const signals = d?.reasons.length
      ? { lines: d.reasons, source: "engine" as SourceTag }
      : { lines: [], source: "empty" as SourceTag };

    // 📊 强弱 / 量价 — 服务端读数
    const flow: string[] = [];
    if (d?.mainYi !== null && d?.mainYi !== undefined) flow.push(`主力净额 ${d.mainYi.toFixed(1)} 亿${d.mainYi > 0 ? "（净流入）" : d.mainYi < 0 ? "（净流出）" : "（持平）"}`);
    if (d?.changePct !== null && d?.changePct !== undefined) flow.push(`当日涨幅 ${d.changePct.toFixed(2)}%`);
    if (d?.diffusion !== null && d?.diffusion !== undefined) flow.push(`内部扩散 ${(d.diffusion * 100).toFixed(0)}%（成分股上涨比例）`);
    if (d?.streakPct !== null && d?.streakPct !== undefined) flow.push(`连续强势 ${d.streakPct} 日`);
    const capital_flow = flow.length ? { lines: flow, source: "server" as SourceTag } : { lines: [], source: "empty" as SourceTag };

    // 📌 核心结论 — AI 输出（headline）
    const core_judgement = ai?.headline
      ? { lines: [ai.headline], source: "ai" as SourceTag }
      : { lines: [], source: "empty" as SourceTag };

    // 📈 关键信号（AI 补充解读，服务端已经填了判定 reasons，AI 的作为附加）
    const aiSignals = filterUserFacing((ai?.interpretation ?? []).map((i) => i.text).filter(Boolean));
    const signalsOut = aiSignals.length
      ? { lines: aiSignals, source: "ai" as SourceTag }
      : signals; // 空时回落为服务端 reasons

    // 🧪 反证状态 — AI 的 unknowns（过滤掉工程口径：数据缺失 / 未接入 / 查询数据源 这类）
    const falsification = (() => {
      const lines = filterUserFacing((ai?.unknowns ?? []).filter(Boolean));
      return lines.length
        ? { lines, source: "ai" as SourceTag }
        : { lines: [] as string[], source: "empty" as SourceTag };
    })();

    // 🗓️ 触发条件 — AI 的 next_checks（过滤工程口径：去查询 / 补充字段 这类）
    const trigger = (() => {
      const lines = filterUserFacing((ai?.next_checks ?? []).filter(Boolean));
      return lines.length
        ? { lines, source: "ai" as SourceTag }
        : { lines: [] as string[], source: "empty" as SourceTag };
    })();

    // 🛑 失效条件 — 目前没有独立字段，先空占位（不编）
    const invalidation = { lines: [] as string[], source: "empty" as SourceTag };

    // 📦 仓位节奏 — 没有独立字段，先空占位（不编）
    const position_plan = { lines: [] as string[], source: "empty" as SourceTag };

    // ⚠️ 风险提示 — AI 的 risks（过滤工程口径）
    const risk = (() => {
      const lines = filterUserFacing((ai?.risks ?? []).map((r) => r.text).filter(Boolean));
      return lines.length
        ? { lines, source: "ai" as SourceTag }
        : { lines: [] as string[], source: "empty" as SourceTag };
    })();

    // 🧭 操作参考 — 稳智同款，我们没有独立字段，用 AI 的 core_judgement + 引擎 role 组合
    // 不给具体百分比仓位数字，只写文字倾向
    const actionLines: string[] = [];
    if (ai?.headline) {
      actionLines.push(`结论：${ai.headline}`);
    }
    if (d) {
      const roleTxt = roleLabel(d.role).text;
      actionLines.push(`板块定位：${roleTxt}（引擎判定，非操作建议）`);
    }
    const action = actionLines.length ? { lines: actionLines, source: "ai" as SourceTag } : { lines: [], source: "empty" as SourceTag };

    return {
      core_judgement, data_basis, signals: signalsOut, capital_flow,
      falsification, trigger, invalidation, position_plan, risk, action,
    };
  }, [sectorFacts, rep]);

  // 决策卡头的结论一句话（用于头部展示）
  const headConclusion = rep?.headline ?? "";
  // 决策卡头的倾向 + 置信度标签（只在 AI 有结论时才显示，否则显示"待生成"）
  const headTag = useMemo(() => {
    if (!rep || !rep.headline) return null;
    // 不派生数字分数，只按 AI 结论里能不能明确读出方向做标签
    // 简单启发：看 headline 里有没有"偏防守/观察/看空/退守"这类词
    const h = rep.headline.toLowerCase();
    if (/偏防守|看空|退守|谨慎|不宜参与|不宜介入|观望/.test(h)) return { text: "偏防守", tone: "text-red-300 border-red-500/40 bg-red-500/10" };
    if (/偏进攻|看多|进攻|可关注|关注|参与/.test(h)) return { text: "偏进攻", tone: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
    if (/均衡|中性|观察/.test(h)) return { text: "均衡", tone: "text-sky-300 border-sky-500/40 bg-sky-500/10" };
    return { text: "已生成", tone: "text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-500/10" };
  }, [rep]);

  // 主线 + 次主线 + 轮动 + 观察（供选择器）
  const pickableThemes = useMemo(() => {
    if (!themes) return [];
    return [
      ...((themes.main ?? []).map((t) => ({ ...t, _grp: "主线" as const }))),
      ...((themes.sub ?? []).map((t) => ({ ...t, _grp: "次主线" as const }))),
      ...((themes.rotation ?? []).map((t) => ({ ...t, _grp: "轮动" as const }))),
      ...((themes.watch ?? []).map((t) => ({ ...t, _grp: "观察" as const }))),
    ];
  }, [themes]);

  const repTone: SectionTone = !rep ? "info"
    : rep.interpretation_status === "REJECTED" ? "danger"
      : rep.interpretation_status === "INTERPRETED" ? "success" : "warning";

  // R20：主力净额显示哪一源的哪个数——派生量，不新造事实
  const riskMainNet = mainNetDisplay(risk);

  // 判断本次 AI 结果是否属于当前选中的板块
  const isStaleResult = !!sectorAi && !!sectorFacts && sectorAi.name !== sectorFacts.name;

  return (
    <div className="w-full px-6 py-4">
      <LineageCard
        title={<span className="flex items-center gap-2"><Target size={17} className="text-fuchsia-400" /> 板块深度决策研究</span>}
        note="挑一个方向，让 AI 围绕它给出一份「今天能不能做」的结论。服务端五维数据是事实底稿，AI 只写结论；不做买卖建议。"
        actions={
          <>
            <button
              onClick={() => { void loadTop(); }}
              className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent">
              {topBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
            </button>
            <button
              onClick={runSectorDecision}
              disabled={running || topBusy || !sectorFacts}
              title="围绕当前板块生成一份决策卡"
              className="flex items-center gap-1 rounded-md bg-fuchsia-500 px-2.5 py-1.5 text-xs text-white hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-40">
              {running ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} 生成板块决策
            </button>
          </>
        }
      >

        {/* ① 板块选择器 */}
        <LineageSection title="选板块" hint="默认取今日第一条主线；点标签切换">
          {pickableThemes.length ? (
            <div className="flex flex-wrap gap-1.5">
              {pickableThemes.map((t) => {
                const key = String(t.code ?? t.name);
                const active = key === selectedCode;
                return (
                  <button
                    key={key}
                    onClick={() => { setSelectedCode(key); setCustomQuestion(""); }}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] transition-colors ${
                      active ? "border-fuchsia-500/60 bg-fuchsia-500/15 text-fuchsia-200" : "border-border bg-card/50 text-muted-foreground hover:bg-accent/60"
                    }`}
                  >
                    <span className={active ? "font-medium" : ""}>{t.name}</span>
                    <span className="text-[11px] opacity-70">{t._grp}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">
              {topErr.themes ? `板块数据读取失败：${topErr.themes}` : "今天没有可用板块。"}
            </div>
          )}
        </LineageSection>

        {/* ② 决策卡 */}
        {sectorFacts && (
          <div>
            {/* 稳智同款：决策卡头 */}
            <div className="rounded-xl border border-fuchsia-500/25 bg-gradient-to-br from-fuchsia-500/5 via-card/40 to-card/40 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold tracking-wider text-fuchsia-300/80">🎯 研究结论</span>
                  {rep && rep.interpretation_status === "REJECTED" && (
                    <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[12px] text-red-300">结论被系统剔除</span>
                  )}
                  {rep && rep.interpretation_status === "PARTIAL" && (
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[12px] text-amber-300">部分结论被剔除</span>
                  )}
                </div>
                {sectorFacts && (
                  <span className={`rounded border px-1.5 py-0.5 text-[11.5px] ${roleLabel(sectorFacts.role).tone}`}>
                    {roleLabel(sectorFacts.role).text}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-2xl font-bold leading-tight">{sectorFacts.name}</span>
                <span className="text-[12px] text-muted-foreground font-mono">{sectorFacts.code}</span>
                {headTag && (
                  <span className={`rounded-full border px-2 py-0.5 text-[12px] font-medium ${headTag.tone}`}>
                    {headTag.text}
                  </span>
                )}
              </div>

              <div className="mt-2 text-[15px] leading-relaxed text-foreground/90">
                {headConclusion ? headConclusion : "结论待生成 —— 点右上角「生成板块决策」让 AI 围绕这个板块出一段结论。"}
              </div>

              {headConclusion && DESC_ONLY_PATTERN.test(headConclusion) && (
                <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[12px] text-amber-300">
                  这段是数据描述，不是"能不能做"的判断结论。可以在下面追问输入里问"这个板块到底能不能做？"让它重新给结论。
                </div>
              )}

              {isStaleResult && (
                <div className="mt-2 text-[12px] text-amber-300">
                  当前结论对应的是「{sectorAi!.name}」，不是现在选的「{sectorFacts.name}」——请重新点一次生成。
                </div>
              )}

              {rep && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                  <SourceBadge status="AI_INTERPRETATION" source={`模型 ${rep.model || "未记录"}`} time={rep.generated_at} />
                  <span>· 用了 {rep.evidence_total} 条真实数据</span>
                  {rep.generated_at && <span>· {rep.generated_at.slice(5, 16)}</span>}
                </div>
              )}
            </div>

            {/* 决策卡主体：10 个分区（按稳智顺序） */}
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              <DecisionSection id="core_judgement" lines={sections.core_judgement.lines} source={sections.core_judgement.source} />
              <DecisionSection id="data_basis" lines={sections.data_basis.lines} source={sections.data_basis.source} />
              <DecisionSection id="signals" lines={sections.signals.lines} source={sections.signals.source} />
              <DecisionSection id="capital_flow" lines={sections.capital_flow.lines} source={sections.capital_flow.source} />
              <DecisionSection id="falsification" lines={sections.falsification.lines} source={sections.falsification.source} />
              <DecisionSection id="trigger" lines={sections.trigger.lines} source={sections.trigger.source} />
              <DecisionSection id="invalidation" lines={sections.invalidation.lines} source={sections.invalidation.source} />
              <DecisionSection id="position_plan" lines={sections.position_plan.lines} source={sections.position_plan.source} />
              <DecisionSection id="risk" lines={sections.risk.lines} source={sections.risk.source} />
              <DecisionSection id="action" lines={sections.action.lines} source={sections.action.source} />
            </div>

            {/* 错误提示 */}
            {(err || run?.message) && !rep && (
              <div className="mt-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-xs">
                {err || plainify(`本次「生成板块决策」：${RESEARCH_RUN_STATUS_TEXT[run!.status]} —— ${run!.message}`)}
              </div>
            )}

            {/* 自定义问题输入 */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={customQuestion}
                onChange={(e) => setCustomQuestion(e.target.value.slice(0, 300))}
                placeholder="想问得更细？比如：这个板块的资金流入能撑几天？"
                className="min-w-[280px] flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-sky-500"
              />
              {!aiReady(ai) && (
                <span className="text-[12px] text-amber-300">AI 通道未开启，只能看服务端读数。</span>
              )}
            </div>
          </div>
        )}

        {/* ③ 今日大盘背景 */}
        {risk && (
          <DeskCollapse
            className="mt-3"
            title="今日大盘背景"
            triggerClassName="text-[12px] text-muted-foreground hover:text-foreground"
            contentClassName="space-y-2"
          >
            <div className="rounded-lg border border-border bg-card/40 px-3 py-2 text-[13px] leading-relaxed">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <span>风险</span>
                <span className="font-medium text-foreground">{risk.risk.level}</span>
                <span className="opacity-60">·</span>
                <span>涨 {risk.advancers} / 跌 {risk.decliners}</span>
                <span className="opacity-60">·</span>
                <span>涨停 {risk.limit_up}</span>
                {risk.break_rate !== null && <><span className="opacity-60">·</span><span>炸板 {risk.break_rate.toFixed(0)}%</span></>}
                {riskMainNet ? <><span className="opacity-60">·</span><span title={riskMainNet.hint}>主力净额 {riskMainNet.value.toFixed(1)} 亿{riskMainNet.selfComputed ? "（自算）" : ""} <span className="opacity-70">{riskMainNet.label}</span></span></> : <><span className="opacity-60">·</span><span>主力净额 —</span></>}
              </div>
              {radar && radar.items.length > 0 && (
                <div className="mt-2">
                  <div className="text-[11.5px] text-muted-foreground">今日强势信号（前 3）</div>
                  <ul className="mt-0.5 space-y-0.5 text-[12px]">
                    {radar.items.slice(0, 3).map((i) => <li key={i.id ?? i.title} className="list-disc pl-4">{i.title}</li>)}
                  </ul>
                </div>
              )}
              {events && events.items.length > 0 && (
                <div className="mt-2">
                  <div className="text-[11.5px] text-muted-foreground">全球要闻（前 3）</div>
                  <ul className="mt-0.5 space-y-0.5 text-[12px]">
                    {events.items.slice(0, 3).map((i) => <li key={i.title} className="list-disc pl-4">{i.title}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </DeskCollapse>
        )}

        {/* ④ 技术细节（台账 / 采集器 / 核对）— 默认收起 */}
        {rep && (
          <DeskCollapse
            className="mt-2"
            title="技术细节（AI 核对、数据来源）"
            triggerClassName="text-[12px] text-muted-foreground hover:text-foreground"
            contentClassName="space-y-2 text-[12px]"
          >
            <LineageSection title="AI 总结状态" tone={repTone} divided={false}>
              <div className="rounded-lg border border-border bg-card/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="font-mono">{rep.interpretation_status}</span>
                  <span className="text-muted-foreground">
                    {rep.interpretation_status === "INTERPRETED"
                      ? "AI 已生成，系统核对引用真实"
                      : rep.interpretation_status === "PARTIAL"
                        ? "AI 有部分内容被系统剔除"
                        : "AI 内容有较多问题被剔除"}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] text-muted-foreground">回答的问题：{rep.question || "未记录"}</div>
                {!!rep.violations.length && (
                  <div className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11.5px] text-amber-200">
                    系统核对：
                    <ul className="mt-0.5 list-disc pl-4">{rep.violations.map((v) => <li key={v}>{v}</li>)}</ul>
                  </div>
                )}
                {(rep.dropped.invalid_cites.length > 0 || rep.dropped.probability_claims.length > 0 || rep.dropped.fields.length > 0) && (
                  <div className="mt-1.5 text-[11px] text-muted-foreground">
                    已剔除：引用不实 {rep.dropped.invalid_cites.join("、") || "无"} · 概率/涨幅预测 {rep.dropped.probability_claims.join("、") || "无"}
                    {!!rep.dropped.fields.length && <> · 空段 {rep.dropped.fields.length} 处</>}
                  </div>
                )}
              </div>
            </LineageSection>

            <LineageSection title="详细内容（七分区明细）">
              <div className="space-y-1.5">
                {(() => {
                  const sList = researchLayerSections(rep, view?.evidence ?? []);
                  return sList.map((s) => (
                    <div key={s.layer} className="rounded-lg border border-border/70 bg-card/40 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                        <span className="font-mono font-semibold">{s.layer}</span>
                        <span className="text-muted-foreground">{s.owner}</span>
                      </div>
                      <div className="mt-1 space-y-1">
                        {s.owner === "服务端" ? (
                          s.lines.length ? s.lines.map((l) => <LedgerLine key={l.id} l={l} />)
                            : <div className="text-[11.5px] text-muted-foreground">本层本次没有台账行。</div>
                        ) : s.items ? (
                          s.items.length ? s.items.map((it, i) => (
                            <div key={`${s.layer}-${i}`} className="rounded border border-border/60 bg-card/50 px-2 py-1 text-[12px] leading-snug">
                              {it.text}
                              {!!it.cited_text?.length && (
                                <DeskCollapse
                                  className="mt-1"
                                  title="引用原文（服务端按 id 回填，前端改不了）"
                                  triggerClassName="text-[11px] text-muted-foreground hover:text-foreground"
                                  contentClassName="text-[11px] text-muted-foreground"
                                >
                                  <ul className="space-y-0.5 pl-3">
                                    {it.cited_text.map((t) => <li key={t} className="list-disc leading-snug">{t}</li>)}
                                  </ul>
                                </DeskCollapse>
                              )}
                            </div>
                          )) : <div className="text-[11.5px] text-muted-foreground">本段为空。</div>
                        ) : (
                          s.strings.length ? s.strings.map((t, i) => (
                            <div key={`${s.layer}-${i}`} className="rounded border border-border/60 bg-card/50 px-2 py-1 text-[12px] leading-snug">{t}</div>
                          )) : <div className="text-[11.5px] text-muted-foreground">本段为空。</div>
                        )}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </LineageSection>

            <DeskCollapse
              className="mt-1"
              title="回溯文本（这份报告「每句话从哪来」的完整核对串）"
              triggerClassName="text-[12px] text-muted-foreground hover:text-foreground"
              contentClassName="text-[11.5px] text-muted-foreground"
            >
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/60 p-2 text-[11px] leading-4">{renderResearchTrace(rep, view?.evidence ?? [])}</pre>
            </DeskCollapse>

            {!!(view?.evidence ?? []).length && (
              <DeskCollapse
                defaultOpen
                title={`台账目录（${(view?.evidence ?? []).length} 行，服务端现取）`}
                triggerClassName="text-[12px] font-semibold text-muted-foreground hover:text-foreground"
                contentClassName="text-[12px] text-muted-foreground"
              >
                <div className="space-y-1.5">{(view?.evidence ?? []).map((l) => <LedgerLine key={l.id} l={l} />)}</div>
              </DeskCollapse>
            )}

            {!!(view?.sources ?? []).length && (
              <LineageSection title="今日取数状态">
                <div className="space-y-1.5">
                  {(view?.sources ?? []).map((s) => <CollectorRow key={s.capability} s={s} />)}
                </div>
              </LineageSection>
            )}

            {!!view?.missing.length && (
              <LineageSection title={`数据缺口（${view.missing.length} 条）`}>
                <ul className="space-y-1 text-[11px] leading-snug text-muted-foreground">
                  {view.missing.map((m) => <li key={m} className="list-disc pl-3">{m}</li>)}
                </ul>
              </LineageSection>
            )}
          </DeskCollapse>
        )}

      </LineageCard>
    </div>
  );
}
