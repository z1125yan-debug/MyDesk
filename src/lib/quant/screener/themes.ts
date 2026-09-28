// 主线发现（P2-3）：东财板块榜 + 成分扩散 + 资金连续流入 +（可选）板块日K连续强势。
// P15-R6：东财+腾讯兜底都拿不到资金读数时，整榜改走同花顺资金流榜（独立上游，见 ths.ts 口径注释）。
import { fetchBoardReal, fetchDetailReal, type BoardRow } from "@/lib/desk/em";
import { fetchThsBoards, type ThsBoardRow } from "@/lib/desk/ths";
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

/** 同花顺行 → BoardRow 形状。资金读数是真数（fundsMissing 不置），但 ratio/superBig/big
 *  同花顺榜没有拆分口径，给 0 并在 missing/来源行如实登记「无超大单/大单明细」；
 *  secid 留空 + code 带 THS 前缀：日K/资金 streak/扩散度会自然落无数据分支，不会错接东财码。 */
function thsToBoardRow(r: ThsBoardRow): BoardRow {
  return {
    code: r.code,
    secid: "",
    name: r.name,
    changePct: r.changePct,
    main: r.netYi, // 同花顺净额 = 流入 − 流出（亿），与东财主力净额口径相近但不等价，来源行已注明
    ratio: 0,
    superBig: 0,
    big: 0,
    leader: r.leader,
  };
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
  const industry0 = mergeBoards(indIn, indOut);
  const concept0 = mergeBoards(cptIn, cptOut);
  // P15-R6 同花顺兜底：只在东财断源、腾讯备胎也拿不到资金读数时整榜换同花顺（独立上游，
  // 不拿同花顺数字去填东财的表——两套行业名不是一一对应的，嫁接才会对错账）；
  // 东财行业资金正常、只有概念线没数时，单补同花顺概念榜，不动东财实数行。
  const hasEmFunds = [...industry0, ...concept0].some((r) => !r.fundsMissing);
  let boardsThs: "full" | "concept" | null = null;
  let ths: { industry: ThsBoardRow[]; concept: ThsBoardRow[] } | null = null;
  if (!hasEmFunds || !concept0.length) {
    const [ti, tc] = await Promise.all([
      !hasEmFunds ? fetchThsBoards("industry") : Promise.resolve([] as ThsBoardRow[]),
      fetchThsBoards("concept"),
    ]);
    if (!hasEmFunds && ti.length && tc.length) {
      ths = { industry: ti, concept: tc };
      boardsThs = "full";
    } else if (hasEmFunds && !concept0.length && tc.length) {
      ths = { industry: [], concept: tc };
      boardsThs = "concept";
    }
  }
  const industry = boardsThs === "full" ? ths!.industry.map(thsToBoardRow) : industry0;
  const concept = ths ? ths.concept.map(thsToBoardRow) : concept0;
  if (!industry.length && !concept.length) {
    throw new Error("板块数据源暂不可用（东财榜单接口与腾讯板块兜底均无返回；同花顺兜底亦无返回）");
  }
  // 腾讯板块兜底榜只有涨幅口径（fundsMissing）：资金类读数如实登记缺失，评分自动退到涨幅/扩散度可得的维度
  const boardFundsMissing = [...industry, ...concept].some((r) => r.fundsMissing) && ![...industry, ...concept].some((r) => !r.fundsMissing);
  if (boardFundsMissing) missing.push("板块主力净额/净占比/超大单：东财板块榜断源，腾讯兜底榜不含资金读数（本榜按涨幅排序）");
  if (boardsThs === "full") {
    missing.push("板块超大单/大单/净占比拆分与资金历史：同花顺榜只有净额（流入−流出）口径，且按涨幅排序取前 90 行业/前 150 概念（缺口如实登记）");
  } else if (boardsThs === "concept") {
    missing.push("同花顺概念榜资金只有净额（流入−流出）汇总，无超大单/大单拆分；榜按涨幅取前 150");
  }

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
  // P15-R12 优化：14 个 probe 并行 await（原来串行 for-await 是慢点）
  const probed = await Promise.all(probe.map(async (r) => {
    const [diff, streakPct, streakIn] = await Promise.all([
      diffusionOf(r.code, r._kind),
      boardDayStreak(r.secid || `90.${r.code}`),
      inflowStreak(r.secid || `90.${r.code}`),
    ]);
    return { r, diff, streakPct, streakIn };
  }));
  for (const { r, diff, streakPct, streakIn } of probed) {
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
      kind: r._kind,
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
      provider:
        boardsThs === "full"
          ? "同花顺板块资金流榜（东财板块榜/资金读数断源时的独立兜底；净额=流入−流出，无超大单/净占比拆分；东财日K/资金明细/成分扩散不跨系错接，按缺失登记）"
          : boardsThs === "concept"
            ? "em（东财板块榜 + 成分 clist + 板块资金日K/指数K）+ 同花顺概念榜兜底（东财概念线无返回）"
            : boardFundsMissing
              ? "腾讯板块兜底榜（涨幅口径；东财板块榜/clist 成分/资金日K断源，各维度按缺失登记）"
              : "em（东财板块榜 + 成分 clist + 板块资金日K/指数K）",
      note: "规则版主线/次主线/轮动，不接 LLM；无数据字段显式缺失",
    },
  };
  cache = { at: Date.now(), data };
  return data;
}
