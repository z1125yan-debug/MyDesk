import { computeSentiment } from "./sentiment.ts";
import { discoverThemes } from "./themes.ts";
import { scanGlobalEvents } from "./events.ts";

export interface RadarItem {
  kind: "risk" | "theme" | "fund" | "news" | "anomaly";
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

export async function buildRadarFindings(): Promise<{
  as_of: string;
  trade_date: string;
  items: RadarItem[];
  missing: string[];
}> {
  const missing: string[] = [];
  const sent = await computeSentiment();
  let themes = null as Awaited<ReturnType<typeof discoverThemes>> | null;
  try { themes = await discoverThemes(); }
  catch (e) { missing.push(`主线扫描失败：${(e as Error).message}`); }
  let events = null as Awaited<ReturnType<typeof scanGlobalEvents>> | null;
  try { events = await scanGlobalEvents(); }
  catch (e) { missing.push(`事件扫描失败：${(e as Error).message}`); }

  const items: RadarItem[] = [];
  items.push({
    kind: "risk",
    title: `市场风险等级：${sent.risk.level}`,
    detail: sent.risk.triggers.join("；"),
    evidence: {
      level: sent.risk.level,
      break_rate: sent.break_rate,
      advancers: sent.advancers,
      decliners: sent.decliners,
      main_net_sum_yi: sent.main_net_sum_yi,
    },
  });

  if (sent.break_rate !== null && sent.break_rate > 40) {
    items.push({
      kind: "anomaly",
      title: `风险提示：炸板率 ${sent.break_rate.toFixed(0)}%`,
      detail: `触板 ${sent.touched_limit} / 炸板 ${sent.limit_up_broken}，阈值 40%`,
      evidence: { break_rate: sent.break_rate },
    });
  }
  const advRatio = sent.decliners > 0 ? sent.advancers / sent.decliners : 99;
  if (advRatio < 0.5) {
    items.push({
      kind: "anomaly",
      title: `异常信号：涨跌家数比 ${advRatio.toFixed(2)}`,
      detail: `上涨 ${sent.advancers} / 下跌 ${sent.decliners}`,
      evidence: { advRatio },
    });
  }

  if (themes) {
    for (const t of themes.main) {
      items.push({
        kind: "theme",
        title: `主线：${t.name}`,
        detail: t.reasons.join("；"),
        evidence: { code: t.code, changePct: t.changePct, mainYi: t.mainYi, diffusion: t.diffusion, score: t.score },
      });
    }
    for (const t of themes.sub.slice(0, 2)) {
      items.push({
        kind: "theme",
        title: `次主线：${t.name}`,
        detail: t.reasons.join("；"),
        evidence: { code: t.code, changePct: t.changePct, mainYi: t.mainYi, score: t.score },
      });
    }
    const inflows = [...themes.main, ...themes.sub, ...themes.watch]
      .filter((t) => t.mainYi >= 8)
      .sort((a, b) => b.mainYi - a.mainYi)
      .slice(0, 3);
    for (const t of inflows) {
      items.push({
        kind: "fund",
        title: `资金：${t.name} 主力净流入 ${t.mainYi.toFixed(1)} 亿`,
        detail: `涨幅 ${t.changePct.toFixed(2)}%，连续流入 ${t.streakInflow ?? "暂无"} 日`,
        evidence: { code: t.code, mainYi: t.mainYi },
      });
    }
    missing.push(...themes.missing);
  }

  if (events) {
    for (const ev of events.items.slice(0, 5)) {
      items.push({
        kind: "news",
        title: `全球事件：${ev.title.slice(0, 48)}`,
        detail: `${ev.level} · ${ev.category} · ${ev.fund.stage} · ${ev.fund.note}`,
        evidence: { keywords: ev.matchedKeywords, boards: ev.fund.boards, level: ev.level },
      });
    }
    missing.push(...events.missing);
  }

  missing.push(...sent.missing);
  return { as_of: sent.as_of, trade_date: sent.trade_date, items, missing: [...new Set(missing)] };
}
