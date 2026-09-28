"use client";
// 主题热点（极简版，2026-09-24 用户拍板「太难看，做人能看懂的」）
//
// 原版本把后端 ThemeDiscovery 的字段名（main/sub/rotation/watch/missing/source）和
// missing[] 数组当成正文原样贴出来，满屏调试文本。这版只留「今天市场在讲什么故事」：
//   一句环境判断 + 今天最热闹的三个板块 + 一个风险提醒。
//
// 数据纪律（沿用项目 REAL_DATA_ONLY，不改判定层）：
// - 数字全部来自真实接口（fetchThemes + fetchSentiment），前端只负责「换个说法」，不改值；
// - 板块日K连续强势天数等已知缺失的维度，只在 hover 说明里点一下，不占正文版面；
// - 不接 LLM、不编造主线、不给买卖建议——「今天没有明确主线」也是合法结论。
import { useCallback, useEffect, useState } from "react";
import { Flame, Loader2, RefreshCw, AlertTriangle, Eye } from "lucide-react";
import { PctText } from "../SourceBadge";
// P7-⑫：折叠处统一用 DeskCollapse（⑫-1 全仓组件目录零原生 details/summary）
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import LiveStamp from "../LiveStamp";
import { useLivePoll } from "@/hooks/use-live-poll";
import { fetchThemes, fetchSentiment } from "@/lib/desk/quant-api";
import type { ThemeDiscoveryClient, ThemeRowClient, SentimentClient } from "@/lib/desk/quant-api";

const ROLE_LABEL: Record<string, string> = {
  main: "主线", sub: "支线", rotation: "轮动", watch: "观察",
};
const ROLE_TONE: Record<string, string> = {
  main: "text-red-400",
  sub: "text-sky-300",
  rotation: "text-amber-400",
  watch: "text-muted-foreground",
};
const ROLE_BADGE: Record<string, string> = {
  main: "bg-red-500/15 text-red-300 border-red-500/30",
  sub: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  rotation: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  watch: "bg-border/60 text-muted-foreground border-border",
};

/** 一句话环境判断：只看涨跌家数 + 炸板率 + 风险等级，不引入新口径。 */
function envSentence(s: SentimentClient | null): { tone: string; text: string } {
  if (!s) return { tone: "text-muted-foreground", text: "今天市场环境：本轮没取到情绪读数" };
  const total = s.advancers + s.decliners;
  if (total <= 0) return { tone: "text-muted-foreground", text: "今天市场环境：涨跌家数未取到，无法判断强弱" };
  const upRatio = s.advancers / total;
  const brk = s.break_rate;
  let label: string, tone: string;
  if (upRatio >= 0.6 && (brk == null || brk < 35)) { label = "偏强"; tone = "text-red-400"; }
  else if (upRatio >= 0.45 && upRatio < 0.6) { label = "分化"; tone = "text-amber-400"; }
  else { label = "偏弱"; tone = "text-emerald-400"; }
  const brkText = brk == null ? "炸板率未取到" : `炸板率 ${brk.toFixed(0)}%`;
  return {
    tone,
    text: `今天市场${label}：${s.advancers} 涨 / ${s.decliners} 跌，${brkText}，风险等级「${s.risk.level}」`,
  };
}

/** 板块一句话：涨幅 + 主力净额 + 扩散度 + 一条最强理由。无数据说无数据。 */
function boardLine(t: ThemeRowClient): string {
  const parts: string[] = [];
  parts.push(`涨 ${t.changePct > 0 ? "+" : ""}${t.changePct.toFixed(2)}%`);
  parts.push(t.mainYi > 0 ? `主力净流入 ${t.mainYi.toFixed(1)} 亿` : t.mainYi < 0 ? `主力净流出 ${Math.abs(t.mainYi).toFixed(1)} 亿` : "主力资金无变化");
  parts.push(t.diffusion == null ? "扩散度未取到" : `扩散度 ${(t.diffusion * 100).toFixed(0)}%`);
  const reason = (t.reasons ?? [])[0];
  if (reason) parts.push(reason);
  return parts.join("，");
}

function BoardCard({ rank, t }: { rank: number; t: ThemeRowClient }) {
  const tone = ROLE_TONE[t.role] ?? "text-muted-foreground";
  const badge = ROLE_BADGE[t.role] ?? ROLE_BADGE.watch;
  return (
    <div className="relative rounded-xl border border-border bg-card p-4 pl-6">
      <div className="absolute left-3 top-4 flex h-6 w-6 items-center justify-center rounded-md border border-border text-[12px] font-mono text-muted-foreground">{rank}</div>
      <div className="flex items-baseline gap-2">
        <span className={`text-base font-bold ${tone}`}>{t.name}</span>
        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${badge}`}>{ROLE_LABEL[t.role] ?? t.role}</span>
        <span className="ml-auto font-mono text-xs text-red-500" title="当日涨幅（fetchThemes 真实接口读数）">+{t.changePct.toFixed(2)}%</span>
      </div>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-foreground/85">{boardLine(t)}</div>
      <div className="mt-1 text-[11.5px] text-muted-foreground">
        评分 {t.score.toFixed(1)}{t.kind === "concept" ? " · 概念板块" : " · 行业板块"}
      </div>
    </div>
  );
}

export default function ThemesPage() {
  const [data, setData] = useState<ThemeDiscoveryClient | null>(null);
  const [sentiment, setSentiment] = useState<SentimentClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const poll = useLivePoll();

  const load = useCallback(async (force = false) => {
    setBusy(true); setError("");
    try {
      const [th, sn] = await Promise.allSettled([fetchThemes(force), fetchSentiment()]);
      if (th.status === "fulfilled") setData(th.value);
      else if (force) setData(null);
      if (sn.status === "fulfilled") setSentiment(sn.value);
      if (th.status === "rejected") setError(String((th.reason as Error).message || th.reason));
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(false); }, [load, poll.tick]);

  // 极简版只摆「主线 → 支线 → 轮动」前三档，合并去重取前 3；当日无板块则说无。
  const top = (data?.main ?? []).slice(0, 3);
  const rest = [...(data?.sub ?? []), ...(data?.rotation ?? [])].slice(0, 3 - top.length);
  const show = [...top, ...rest].slice(0, 3);

  const env = envSentence(sentiment);

  return (
    <div className="w-full space-y-4 px-6 py-4">
      {/* 页头：极简一行 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold">
            <Flame size="18" className="text-red-400" /> 主题热点
            <span className="text-[12px] font-normal text-muted-foreground">今天市场在讲什么故事</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LiveStamp poll={poll} iso={data?.as_of ?? ""} />
          <button
            onClick={() => load(true)}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            {busy ? <Loader2 size="12" className="animate-spin" /> : <RefreshCw size="12" />}
            立即重算
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {!data && !busy && <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">主线发现本轮没取到数据</div>}

      {data && (
        <>
          {/* 一句话环境判断 */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-2">
              <Eye size="14" className="mt-0.5 shrink-0 text-muted-foreground" />
              <div className="text-[15px] leading-relaxed">
                <span className={`font-semibold ${env.tone}`}>{env.text}</span>
              </div>
            </div>
          </div>

          {/* 今天最热闹的板块 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">今天最热闹的板块</div>
              <div className="text-[12px] text-muted-foreground">
                {show.length ? `共列出 ${show.length} 个（主线优先）` : "本轮判定不出明确主线"}
              </div>
            </div>
            {show.length === 0 ? (
              <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
                今天的涨幅、资金、扩散都没有一个板块同时满足判定条件——这是判定结果，不是「没有主线=安全」。
              </div>
            ) : (
              <div className="space-y-2">
                {show.map((t, i) => <BoardCard key={t.code} rank={i + 1} t={t} />)}
              </div>
            )}
          </div>

          {/* 风险提醒：只摆炸板率与风险等级，不重复上面的话 */}
          {sentiment && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
              <AlertTriangle size="13" className="mt-0.5 shrink-0 text-amber-400" />
              <div className="text-[12.5px] leading-relaxed text-amber-300/90">
                风险提醒：风险等级「{sentiment.risk.level}」
                {sentiment.risk.triggers.length ? `，触发项 ${sentiment.risk.triggers.join(" / ")}` : "，无明确触发项"}
                {sentiment.break_rate != null && sentiment.limit_up > 0 ? `；今日 ${sentiment.limit_up} 家涨停、${sentiment.limit_up_broken} 家炸板` : ""}
                。以上是规则判定，不构成买卖建议。
              </div>
            </div>
          )}

          {/* 口径折叠：默认收起，点开才看，不占版面（统一折叠面板，不用原生 details） */}
          {data.missing?.length > 0 && (
            <DeskCollapse
              title={`口径与已知缺失（${data.missing.length} 项）`}
              triggerClassName="text-[12px] text-muted-foreground hover:text-foreground"
              contentClassName="text-[12px] leading-relaxed text-muted-foreground"
            >
              <div className="space-y-1">
                {data.missing.map((m, i) => <div key={i}>· {m}</div>)}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground/70">数据来源：{data.source?.provider}</div>
            </DeskCollapse>
          )}
        </>
      )}
    </div>
  );
}
