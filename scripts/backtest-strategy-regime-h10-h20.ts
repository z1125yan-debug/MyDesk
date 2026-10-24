// H=10 / H=20 分档回测（2026-10-16）：复用 P36-B 口径，扩展持有期
//
// 与 scripts/backtest-strategy-regime.ts 完全一致的口径，只改持有期：
//   1) 数据只从本地 stock_daily_bar 粮仓读（最近 800 根，前 200 根预热），不发外部请求；
//   2) 成交价：T+1 开盘买、T+1+H 开盘卖（H=10 → T+11 开盘；H=20 → T+21 开盘）；
//      次日一字涨停买不进的样本直接剔除，不计入 n；
//   3) 收益扣费：复用 event-core 的 netOf（往返 0.41% 乘性扣费）；
//   4) 时间切分：按命中日下标切 train 60% / validation 20% / test 20%，
//      榜单按样本外（test 段）净收益排，与原脚本 regimeRankOf 规则一致
//      （该档 n≥100、全期 n≥150、样本外 n≥50，否则不进榜）；
//   5) 含「当日快照」条件的策略不可回测，剔除（同原脚本）。
//
// 为让 H=10 与 H=20 在同一样本集上可比：循环上界统一用 t < pT-21，
// 即两个持有期共享同一批命中样本（代价：比原 H=1/5 脚本少最后 15 根的命中，
// 因为那 15 根算不出 20 日远期收益——缺就是缺，不拿 H=10 的尾巴凑 H=20）。
// 同时在同一样本集上也算 H=1/H=5，供横向对比（与旧文件数字的微小差异即来自这 15 根）。
//
// 胜率定义（按持有期各自算，不许拿 H=1 的胜率顶替）：
//   win10 = net10 > 0 的占比；win20 = net20 > 0 的占比。
//
// 用法：
//   node --experimental-strip-types scripts/backtest-strategy-regime-h10-h20.ts [--only 924] [--dry]
//   --out PATH  输出文件（默认 data/strategy-regime-h10-h20.json，不覆盖原 strategy-regime.json）
//   --dry       不写盘，只打印榜单预览

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { buildFieldPanel, FACTOR_FIELD_MAP, limitRatio, type BarsLike, type MetaLike } from "../src/lib/quant/factors/fields.ts";
import { hitMatrixOf, condKeyOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { netOf, roundTripDragOf, EVENT_COST } from "../src/lib/quant/backtest/event-core.ts";
import { regimeSeriesOf, REGIMES, type Regime } from "../src/lib/quant/strategy/regime-core.ts";
import { pctWithCI } from "../src/lib/quant/factors/wilson-core.ts";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const argOf = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const LIMIT = argOf("limit", 0);
const BARS = argOf("bars", 800);
const WARMUP = argOf("warmup", 200);
const CHUNK = argOf("chunk", 100);
const ONLY = (() => {
  const i = argv.indexOf("--only");
  if (i < 0) return null;
  return new Set(String(argv[i + 1] ?? "").split(/[,\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)));
})();
const OUT = (() => {
  const i = argv.indexOf("--out");
  return path.join(ROOT, i < 0 ? "data/strategy-regime-h10-h20.json" : String(argv[i + 1]));
})();
const DRY = argv.includes("--dry");

const INDEX_SYMBOL = "000001.SH";
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);
const OOS_FROM_RATIO = 0.8; // test 段起点（前 60% train + 中间 20% validation）

interface Strategy { id: number; name: string; conds: MatCond[]; condsText: string; }
function condsTextOf(conds: MatCond[]): string {
  return conds.map((c) => {
    const zh = FACTOR_FIELD_MAP.get(c.field)?.zh ?? c.field;
    const v = Array.isArray(c.value) ? c.value.join("/") : String(c.value);
    const w = c.type && c.type !== "single" ? `近${c.window ?? 0}日` : "";
    return `${w}${zh}${c.op}${v}`;
  }).join(" 且 ");
}

const libRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategies.json"), "utf8"));
const allStrategies: Strategy[] = (libRaw?.data ?? []).map((s: any) => ({
  id: Number(s.id),
  name: String(s.name ?? ""),
  conds: (Array.isArray(s.conds) ? s.conds : []).map((c: any) => ({
    field: String(c.field ?? ""), op: String(c.op ?? "="), value: c.value as MatCond["value"],
    type: c.type ?? "single", window: c.window, min_match_days: c.min_match_days,
  })),
  condsText: "",
}));
for (const s of allStrategies) s.condsText = condsTextOf(s.conds);

interface RejectedStrategy { id: number; name: string; reason: string; fields: string[]; }
const usable: Strategy[] = [];
const rejected: RejectedStrategy[] = [];
for (const s of allStrategies) {
  if (ONLY && !ONLY.has(s.id)) continue;
  if (!s.conds.length) { rejected.push({ id: s.id, name: s.name, reason: "没有可判定的条件", fields: [] }); continue; }
  const snapshotFields: string[] = [];
  const badFields: string[] = [];
  for (const c of s.conds) {
    const def = FACTOR_FIELD_MAP.get(c.field);
    if (!def) { badFields.push(`${c.field}（未登记字段）`); continue; }
    if (def.implemented === false) { badFields.push(`${def.zh}（已登记未实现）`); continue; }
    if (def.source === "snapshot") snapshotFields.push(def.zh);
  }
  if (badFields.length) { rejected.push({ id: s.id, name: s.name, reason: `条件含无法计算的字段：${badFields.join("、")}`, fields: badFields }); continue; }
  if (snapshotFields.length) {
    rejected.push({ id: s.id, name: s.name, reason: `条件含当日快照字段（${snapshotFields.join("、")}），只有今天的读数、没有历史每一天的数，历史回测复算不了`, fields: snapshotFields });
    continue;
  }
  usable.push(s);
}

const condIndex = new Map<string, number>();
const condList: MatCond[] = [];
const strategyCondIdx: number[][] = usable.map((s) =>
  s.conds.map((c) => {
    const k = condKeyOf(c);
    let i = condIndex.get(k);
    if (i === undefined) { i = condList.length; condIndex.set(k, i); condList.push(c); }
    return i;
  }),
);

// ---- 大盘档位 ----
const db = new PrismaClient();
const idxRows = (await db.$queryRawUnsafe(
  `SELECT tradeDate, close FROM stock_daily_bar WHERE symbol = ? ORDER BY tradeDate ASC`,
  INDEX_SYMBOL,
)) as { tradeDate: string; close: number }[];
if (idxRows.length < 60) { console.error(`粮仓缺少 ${INDEX_SYMBOL} 日K（只有 ${idxRows.length} 根），无法判档`); process.exit(1); }
const allDates = idxRows.map((r) => r.tradeDate).slice(-BARS);
const idxCloses = idxRows.map((r) => r.close).slice(-BARS);
const T = allDates.length;
const dateToIdx = new Map(allDates.map((d, i) => [d, i]));
const regimeSeries = regimeSeriesOf(idxCloses);
console.log(`日期轴：${allDates[0]} → ${allDates[T - 1]}（${T} 根，取最近 ${BARS}）`);
console.log(`策略：${allStrategies.length} 条 → 可回测 ${usable.length} 条 / 剔除 ${rejected.length} 条；去重条件 ${condList.length} 条`);

const symRows = (await db.$queryRawUnsafe(
  `SELECT symbol, COUNT(*) c FROM stock_daily_bar GROUP BY symbol HAVING c >= 200 ORDER BY symbol ASC`,
)) as { symbol: string; c: bigint | number }[];
let universe = symRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));
if (LIMIT) universe = universe.slice(0, LIMIT);
console.log(`股票池：${universe.length} 只`);

// ---- 持有期累加器（每个持有期独立的 n / 胜 / 均益，胜率按该持有期净收益>0 算） ----
interface HAcc { n: number; wins: number; sumNet: number; sumGross: number; }
const emptyH = (): HAcc => ({ n: 0, wins: 0, sumNet: 0, sumGross: 0 });
const pushH = (acc: HAcc, net: number | null, gross: number | null) => {
  if (net == null || !Number.isFinite(net)) return;
  acc.n++;
  if (net > 0) acc.wins++;
  acc.sumNet += net;
  if (gross != null && Number.isFinite(gross)) acc.sumGross += gross;
};
interface HStat { n: number; win: number; net: number; gross: number; winCi: string; }
const statOf = (acc: HAcc): HStat | null => {
  if (!acc.n) return null;
  const win = (acc.wins / acc.n) * 100;
  return { n: acc.n, win, net: acc.sumNet / acc.n, gross: acc.sumGross / acc.n, winCi: pctWithCI(win, acc.n) };
};
type Horizon = "h1" | "h5" | "h10" | "h20";
const HORIZONS: Horizon[] = ["h1", "h5", "h10", "h20"];
const EXIT_OFFSET: Record<Horizon, number> = { h1: 2, h5: 6, h10: 11, h20: 21 }; // 卖出日下标 = t + offset
// acc[策略][持有期]：全期 / 分档全期 / 分档样本外
const accAll = usable.map(() => ({ h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() }) as Record<Horizon, HAcc>);
const accRegime = usable.map(() => ({ 强势: { h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() }, 震荡: { h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() }, 弱势: { h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() } }) as Record<Regime, Record<Horizon, HAcc>>);
const accOos = usable.map(() => ({ 强势: { h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() }, 震荡: { h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() }, 弱势: { h1: emptyH(), h5: emptyH(), h10: emptyH(), h20: emptyH() } }) as Record<Regime, Record<Horizon, HAcc>>);

let hitsTotal = 0;
let blockedTotal = 0;
let symbolsDone = 0;
const t0 = Date.now();
const OOS_FROM = Math.floor(T * OOS_FROM_RATIO);
const MAX_T_OFFSET = 21; // H=20 卖出需 t+21 < pT，故 t < pT-21

for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
  const chunk = universe.slice(c0, c0 + CHUNK);
  const ph = chunk.map(() => "?").join(",");
  const rows = (await db.$queryRawUnsafe(
    `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar
     WHERE symbol IN (${ph}) AND tradeDate >= ? ORDER BY symbol ASC, tradeDate ASC`,
    ...chunk, allDates[0],
  )) as { symbol: string; tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[];
  const bySym = new Map<string, BarsLike[]>();
  for (const r of rows) {
    const i = dateToIdx.get(r.tradeDate);
    if (i === undefined) continue;
    let arr = bySym.get(r.symbol);
    if (!arr) { arr = []; bySym.set(r.symbol, arr); }
    arr.push({ date: r.tradeDate, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, amount: r.amount });
  }
  const syms = chunk.filter((s) => (bySym.get(s)?.length ?? 0) > 0);
  if (!syms.length) continue;
  const barsList = syms.map((s) => bySym.get(s)!);
  const panel = buildFieldPanel(syms, barsList, syms.map(() => undefined as MetaLike | undefined));
  const localToGlobal = panel.dates.map((d) => dateToIdx.get(d) ?? -1);
  const pT = panel.dates.length;
  const oMat = panel.fields.get("o")!;
  const cMat = panel.fields.get("c")!;
  const ratios = syms.map((s) => limitRatio(s, ""));
  const matCache: (Uint8Array[] | null)[] = condList.map(() => null);
  const matrixOf = (ci: number): Uint8Array[] => {
    let m = matCache[ci];
    if (m) return m;
    const cond = condList[ci];
    m = syms.map((_, si) => hitMatrixOf(cond, panel.fields.get(cond.field)?.[si]));
    matCache[ci] = m;
    return m;
  };
  for (let pi = 0; pi < usable.length; pi++) {
    const idxs = strategyCondIdx[pi];
    const mats = idxs.map((ci) => matrixOf(ci));
    for (let si = 0; si < syms.length; si++) {
      const o = oMat[si];
      const c = cMat[si];
      const ratio = ratios[si];
      const refs: Uint8Array[] = mats.map((m) => m[si]);
      const nk = refs.length;
      for (let t = WARMUP; t < pT - MAX_T_OFFSET; t++) {
        let hit = true;
        for (let k = 0; k < nk; k++) if (!refs[k][t]) { hit = false; break; }
        if (!hit) continue;
        hitsTotal++;
        const g = localToGlobal[t];
        const regime = g >= 0 ? regimeSeries[g] : null;
        const entryOpen = o[t + 1];
        const signalClose = c[t];
        // 买不进判定（同 eventOutcomeOf）：无开盘价 / T+1 开盘已封涨停 → 剔除
        let tradable = true;
        if (entryOpen == null || !(entryOpen > 0)) tradable = false;
        else if (signalClose != null && signalClose > 0 && ratio > 0) {
          const limitPrice = Math.round(signalClose * (1 + ratio) * 100) / 100;
          if (entryOpen >= limitPrice) tradable = false;
        }
        if (!tradable) { blockedTotal++; continue; }
        const isOos = g >= OOS_FROM;
        for (const h of HORIZONS) {
          const exitOpen = o[t + EXIT_OFFSET[h]];
          if (exitOpen == null || !(exitOpen > 0)) continue; // 该持有期无卖出价 → 该持有期不计样本（缺就是缺）
          const gross = (exitOpen / entryOpen - 1) * 100;
          const net = netOf(gross);
          pushH(accAll[pi][h], net, gross);
          if (regime) {
            pushH(accRegime[pi][regime][h], net, gross);
            if (isOos) pushH(accOos[pi][regime][h], net, gross);
          }
        }
      }
    }
  }
  symbolsDone += syms.length;
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(`\r  已跑 ${symbolsDone}/${universe.length} 只（${el}s，命中 ${hitsTotal}，买不进 ${blockedTotal}）   `);
}
console.log(`\n完成：${symbolsDone} 只 / ${((Date.now() - t0) / 1000).toFixed(0)}s；命中 ${hitsTotal} 次，其中次日买不进剔除 ${blockedTotal} 次`);

// ---- 组装输出 ----
type HStatMap = Record<Horizon, HStat | null>;
const rows = usable.map((s, i) => {
  const byRegime = {} as Record<Regime, { all: HStatMap; oos: HStatMap }>;
  for (const g of REGIMES) {
    const all = {} as HStatMap; const oos = {} as HStatMap;
    for (const h of HORIZONS) { all[h] = statOf(accRegime[i][g][h]); oos[h] = statOf(accOos[i][g][h]); }
    byRegime[g] = { all, oos };
  }
  const allH = {} as HStatMap;
  for (const h of HORIZONS) allH[h] = statOf(accAll[i][h]);
  return { id: s.id, name: s.name, condsText: s.condsText, all: allH, byRegime };
}).filter((r) => (r.all.h10?.n ?? 0) > 0 || (r.all.h20?.n ?? 0) > 0);

// ---- 榜单：每档 × 每持有期，按样本外净收益排（门槛同 regimeRankOf）；样本外不足则按全期排并注明 ----
interface RankItem { id: number; name: string; basis: string; all: HStat | null; oos: HStat | null; }
const rank: Record<string, Record<Horizon, RankItem[]>> = {};
for (const g of REGIMES) {
  rank[g] = {} as Record<Horizon, RankItem[]>;
  for (const h of HORIZONS) {
    const cands = rows.map((r) => ({ row: r, all: r.byRegime[g].all[h], oos: r.byRegime[g].oos[h] }))
      .filter((x): x is { row: typeof rows[number]; all: HStat; oos: HStat | null } =>
        !!x.all && x.all.n >= 100 && (x.row.all.h10?.n ?? 0) + (x.row.all.h20?.n ?? 0) >= 0 && (x.row.all[h]?.n ?? 0) >= 150);
    // 注：全期门槛用该持有期自身 n≥150（与原脚本 minTotal=150 同口径）
    const withOos = cands.filter((x) => x.oos && x.oos.n >= 50);
    const useOos = withOos.length > 0;
    const pool = useOos ? withOos : cands;
    rank[g][h] = pool
      .sort((a, b) => (useOos ? (b.oos as HStat).net - (a.oos as HStat).net : b.all.net - a.all.net))
      .slice(0, 15)
      .map((x) => ({
        id: x.row.id, name: x.row.name,
        basis: useOos ? `扣掉手续费后 · 用没参与挑选的那段行情验过 ${(x.oos as HStat).n} 次` : `扣掉手续费后 · 用同一段历史算的 ${x.all.n} 次（可能只是运气好）`,
        all: x.all, oos: x.oos,
      }));
  }
}
for (const g of REGIMES) {
  for (const h of HORIZONS) console.log(`榜单 ${g} ${h}：${rank[g][h].length} 条`);
}

const out = {
  generatedAt: new Date().toISOString(),
  builtAt: new Date().toISOString(),
  source: "scripts/backtest-strategy-regime-h10-h20.ts（本地粮仓 stock_daily_bar 前复权日K）",
  window: { universe: symbolsDone, bars: T, from: allDates[0], to: allDates[T - 1], note: `全A前复权日K，最近 ${T} 根；前 ${WARMUP} 根只作指标预热不记样本；H=10/H=20 共享同一样本集（t < pT-21，尾部 15 根无 20 日远期收益不计入）` },
  basis: {
    entry: "T+1 开盘（T 日收盘发信号，T 日收盘价成交是买不进的，已废）",
    exit: "H=1：T+2 开盘；H=5：T+6 开盘；H=10：T+11 开盘（持 10 日）；H=20：T+21 开盘（持 20 日，约 1 个月）",
    cost: `扣费后：佣金 ${(EVENT_COST.commissionRate * 100).toFixed(2)}% + 印花税(卖) ${(EVENT_COST.stampDuty * 100).toFixed(2)}% + 滑点 ${(EVENT_COST.slippageRate * 100).toFixed(2)}% + 点差 ${(EVENT_COST.spreadRate * 100).toFixed(2)}%，往返 ${(roundTripDragOf() * 100).toFixed(2)}%（乘性扣费，与原脚本一致）`,
    costAdjusted: true,
    untradeable: "次日一字涨停/停牌的样本直接剔除，不计入 n（不是记 0 收益）；某持有期无卖出价时该持有期不计样本",
    winDefinition: "win10 = 持有 10 日净收益 > 0 的占比；win20 = 持有 20 日净收益 > 0 的占比（各持有期独立算）",
    split: "按命中日切三段：前 60%、中间 20%、最后 20%；榜单按最后那 20%（样本外）净收益排",
    caveat: "股票简称缺失 → ST 股按非 ST 的 10% 判涨停，个别样本偏乐观",
  },
  regimeMethod: "上证指数 MA20 趋势法：收盘在 MA20 上且 MA20 向上=强势；之下且向下=弱势；其余=震荡",
  thresholds: { minHits: 100, minTotal: 150, minOosHits: 50, note: "每个档位要够 100 次、该持有期全期够 150 次，且样本外段够 50 次，才按样本外排进榜（门槛同 regime-core）" },
  counts: { strategies: allStrategies.length, backtestable: usable.length, rejected: rejected.length, rows: rows.length, hits: hitsTotal, blocked: blockedTotal, 强势: { h10: rank.强势.h10.length, h20: rank.强势.h20.length }, 震荡: { h10: rank.震荡.h10.length, h20: rank.震荡.h20.length }, 弱势: { h10: rank.弱势.h10.length, h20: rank.弱势.h20.length } },
  rankBasis: "样本外（有样本外成绩时）/ 全期（样本外不足时回退，并在 basis 中注明）",
  rejected,
  rank,
  rows,
};

if (DRY) {
  console.log("--dry：不写盘。榜单预览（每档 × H=10/H=20 前 5，按样本外净收益）：");
  for (const g of REGIMES) {
    for (const h of ["h10", "h20"] as Horizon[]) {
      console.log(`\n${g} ${h} Top5：`);
      for (const it of rank[g][h].slice(0, 5)) {
        const o = it.oos; const a = it.all as HStat;
        console.log(`  ${it.id}/${it.name} 全期 n=${a.n} 胜${a.win.toFixed(1)}% 净${a.net.toFixed(2)}%` + (o ? ` ｜ 样本外 n=${o.n} 胜${o.win.toFixed(1)}% 净${o.net.toFixed(2)}%` : " ｜ 无样本外成绩"));
      }
    }
  }
} else {
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`已写出 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)}KB）：rows=${rows.length}`);
}

await db.$disconnect();
