// 主线发现（P2-3）：东财板块榜 + 成分扩散 + 资金连续流入 +（可选）板块日K连续强势。
import { fetchBoardReal, fetchDetailReal, type BoardRow } from "@/lib/desk/em";
import { getProvider } from "@/lib/quant/data/index";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { assignThemeRoles, type ThemeScoreInput, type ThemeScored } from "./theme-rules.ts";

export interface ThemeDiscovery {
  as_of: string;
  trade_date: string;
  main: ThemeScored[];
  sub: ThemeScored[];
  rotation: ThemeScored[];
  watch: ThemeScored[];
  missing: string[];
  source: { provider: string; note: string };
}

const TTL_MS = 45_000;
let cache: { at: number; data: ThemeDiscovery } | null = null;

async function boardDayStreak(secid: string): Promise<number | null> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f59&klt=101&fqt=1&end=20500101&lmt=16`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { Referer: "https://quote.eastmoney.com/" } });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { klines?: string[] } };
    const rows = (j?.data?.klines ?? []).map((s) => {
      const p = s.split(",");
      return { pct: parseFloat(p[3] ?? p[1]) };
    }).filter((r) => isFinite(r.pct));
    if (rows.length < 3) return null;
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].pct > 0) n++;
      else break;
    }
    return n;
  } catch {
    return null;
  }
}

async function inflowStreak(secid: string): Promise<number | null> {
  const d = await fetchDetailReal(secid).catch(() => null);
  if (!d?.days.length) return null;
  let n = 0;
  for (let i = d.days.length - 1; i >= 0; i--) {
    if (d.days[i].value > 0) n++;
    else break;
  }
  return n;
}

async function diffusionOf(code: string, kind: "industry" | "concept"): Promise<number | null> {
  try {
    const provider = await getProvider("em");
    const metas = await provider.listUniverse({ kind, boardCode: code.toUpperCase() }, shanghaiDate());
    const pcts = metas.map((m) => m.changePct).filter((v): v is number => v !== undefined && isFinite(v));
    if (pcts.length < 8) return null;
    return pcts.filter((p) => p > 0).length / pcts.length;
  } catch {
    return null;
  }
}

function mergeBoards(a: BoardRow[] | null, b: BoardRow[] | null): BoardRow[] {
  const m = new Map<string, BoardRow>();
  for (const r of [...(a ?? []), ...(b ?? [])]) {
    if (r.code && !m.has(r.code)) m.set(r.code, r);
  }
  return [...m.values()];
}

export async function discoverThemes(opts?: { force?: boolean }): Promise<ThemeDiscovery> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const missing: string[] = [];
  const [indIn, indOut, cptIn, cptOut] = await Promise.all([
    fetchBoardReal("industry", "in", 80),
    fetchBoardReal("industry", "out", 80),
    fetchBoardReal("concept", "in", 80),
    fetchBoardReal("concept", "out", 80),
  ]);
  const industry = mergeBoards(indIn, indOut);
  const concept = mergeBoards(cptIn, cptOut);
  if (!industry.length && !concept.length) {
    throw new Error("板块数据源暂不可用（东财 clist 与腾讯板块兜底均无返回）");
  }
  // 腾讯板块兜底榜只有涨幅口径（fundsMissing）：资金类读数如实登记缺失，评分自动退到涨幅/扩散度可得的维度
  const boardFundsMissing = [...industry, ...concept].some((r) => r.fundsMissing) && ![...industry, ...concept].some((r) => !r.fundsMissing);
  if (boardFundsMissing) missing.push("板块主力净额/净占比/超大单：东财板块榜断源，腾讯兜底榜不含资金读数（本榜按涨幅排序）");

  const tagged = [
    ...industry.map((r) => ({ ...r, _kind: "industry" as const })),
    ...concept.map((r) => ({ ...r, _kind: "concept" as const })),
  ].sort((a, b) => b.changePct - a.changePct);

  const n = tagged.length;
  const withRps = tagged.map((r, i) => ({
    ...r,
    rps: n > 1 ? ((n - 1 - i) / (n - 1)) * 100 : 100,
  }));

  const probe = [
    ...withRps.filter((r) => r.main > 0).slice(0, 10),
    ...withRps.slice(0, 8),
  ].filter((r, i, arr) => arr.findIndex((x) => x.code === r.code) === i).slice(0, 14);

  const inputs: ThemeScoreInput[] = [];
  let klineFail = 0;
  let memberFail = 0;
  for (const r of probe) {
    const [diff, streakPct, streakIn] = await Promise.all([
      diffusionOf(r.code, r._kind),
      boardDayStreak(r.secid || `90.${r.code}`),
      inflowStreak(r.secid || `90.${r.code}`),
    ]);
    if (diff === null) memberFail++;
    if (streakPct === null) klineFail++;
    inputs.push({
      code: r.code,
      name: r.name,
      changePct: r.changePct,
      mainYi: r.main,
      rps: r.rps,
      diffusion: diff,
      streakPct,
      streakInflow: streakIn,
    });
  }
  if (klineFail === probe.length) missing.push("板块日K连续强势天数（东财 kline 无返回，本批全部缺失）");
  if (memberFail === probe.length) missing.push("内部扩散度（成分股快照无返回）");
  missing.push("RPS=行业+概念合并榜内涨幅百分位（非全市场）");

  const scored = assignThemeRoles(inputs);
  const data: ThemeDiscovery = {
    as_of: shanghaiStamp(),
    trade_date: shanghaiDate(),
    main: scored.filter((s) => s.role === "main"),
    sub: scored.filter((s) => s.role === "sub"),
    rotation: scored.filter((s) => s.role === "rotation"),
    watch: scored.filter((s) => s.role === "watch").slice(0, 8),
    missing,
    source: {
      provider: boardFundsMissing
        ? "腾讯板块兜底榜（涨幅口径；东财板块榜/clist 成分/资金日K断源，各维度按缺失登记）"
        : "em（东财板块榜 + 成分 clist + 板块资金日K/指数K）",
      note: "规则版主线/次主线/轮动，不接 LLM；无数据字段显式缺失",
    },
  };
  cache = { at: Date.now(), data };
  return data;
}
