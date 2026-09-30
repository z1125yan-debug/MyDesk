// P36-B 分档回测（2026-09-30 重写）：本地粮仓 → 扣费后 + 样本外的分档榜
//
// 为什么要重写而不是改口径：原来那份 data/strategy-regime.json 来自
// data/_probe-strategy-regime.json——一次性产物、脚本不在仓库、数据源是网关现拉（会漂），
// 而且它的收益是「T 日收盘发信号、T 日收盘成交」的裸算值（A 闸已实证：三档全负，口径错）。
//
// 这一版的四条硬口径：
//  1) 数据只从本地 stock_daily_bar 粮仓读（B0 落库，427.7 万行前复权），不发任何外部请求；
//  2) 成交价：T+1 开盘买、T+1+H 开盘卖（H=1/5）；次日一字涨停买不进的样本直接剔除；
//  3) 收益扣费：复用 engine.ts 的 DEFAULT_COST，往返 0.41%；
//  4) 时间切分：按命中日下标切 train 60% / validation 20% / test 20%，
//     页面主展示 test（样本外），全期数字只作参考并标注。
//
// 还有一条容易被忽略的：含「当日快照」条件（换手率/市盈率/板块RPS…）的策略
// 没有历史时点数据，历史回测根本复算不了 → 标为不可回测，不进榜。
// （旧榜能给出这类策略的 n=797，是因为把今天的快照值填满了历史每一天 = 未来函数。）
//
// 用法：
//   node --experimental-strip-types scripts/backtest-strategy-regime.ts --only 924 --limit 300   # 单策略试点
//   node --experimental-strip-types scripts/backtest-strategy-regime.ts                          # 全量
// 参数：
//   --limit N     只取前 N 只股票（默认全A）
//   --only a,b    只跑指定策略 id
//   --bars N      用最近 N 根日K（默认 800 = 粮仓全部）
//   --warmup N    前 N 根只预热指标、不记样本（默认 200，覆盖 MA144）
//   --chunk N     每批股票数（默认 100）
//   --out PATH    输出文件（默认 data/strategy-regime.json）
//   --dry         不写盘

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { buildFieldPanel, FACTOR_FIELD_MAP, limitRatio, type BarsLike, type MetaLike } from "../src/lib/quant/factors/fields.ts";
import { hitMatrixOf, condKeyOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { eventOutcomeOf, emptyAcc, accPush, accStatOf, roundTripDragOf, EVENT_COST } from "../src/lib/quant/backtest/event-core.ts";
import { regimeSeriesOf, regimeRankOf, REGIMES, type Regime, type RegimeRow, type RegimeStat } from "../src/lib/quant/strategy/regime-core.ts";

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
  return path.join(ROOT, i < 0 ? "data/strategy-regime.json" : String(argv[i + 1]));
})();
const DRY = argv.includes("--dry");

const INDEX_SYMBOL = "000001.SH";
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);
const SPLIT_RATIO = { train: 0.6, validation: 0.2, test: 0.2 };

interface Strategy {
  id: number;
  name: string;
  conds: MatCond[];
  condsText: string;
}

function condsTextOf(conds: MatCond[]): string {
  return conds
    .map((c) => {
      const zh = FACTOR_FIELD_MAP.get(c.field)?.zh ?? c.field;
      const v = Array.isArray(c.value) ? c.value.join("/") : String(c.value);
      const w = c.type && c.type !== "single" ? `近${c.window ?? 0}日` : "";
      return `${w}${zh}${c.op}${v}`;
    })
    .join(" 且 ");
}

// ---- 1) 策略：只留「历史能复算」的 ----
const libRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategies.json"), "utf8"));
const allStrategies: Strategy[] = (libRaw?.data ?? []).map((s: any) => ({
  id: Number(s.id),
  name: String(s.name ?? ""),
  conds: (Array.isArray(s.conds) ? s.conds : []).map((c: any) => ({
    field: String(c.field ?? ""),
    op: String(c.op ?? "="),
    value: c.value as MatCond["value"],
    type: c.type ?? "single",
    window: c.window,
    min_match_days: c.min_match_days,
  })),
  condsText: "",
}));
for (const s of allStrategies) s.condsText = condsTextOf(s.conds);

interface RejectedStrategy {
  id: number;
  name: string;
  reason: string;
  fields: string[];
}

const usable: Strategy[] = [];
const rejected: RejectedStrategy[] = [];
for (const s of allStrategies) {
  if (ONLY && !ONLY.has(s.id)) continue;
  if (!s.conds.length) {
    rejected.push({ id: s.id, name: s.name, reason: "没有可判定的条件", fields: [] });
    continue;
  }
  const snapshotFields: string[] = [];
  const badFields: string[] = [];
  for (const c of s.conds) {
    const def = FACTOR_FIELD_MAP.get(c.field);
    if (!def) { badFields.push(`${c.field}（未登记字段）`); continue; }
    if (def.implemented === false) { badFields.push(`${def.zh}（已登记未实现）`); continue; }
    if (def.source === "snapshot") snapshotFields.push(def.zh);
  }
  if (badFields.length) {
    rejected.push({ id: s.id, name: s.name, reason: `条件含无法计算的字段：${badFields.join("、")}`, fields: badFields });
    continue;
  }
  if (snapshotFields.length) {
    rejected.push({
      id: s.id,
      name: s.name,
      reason: `条件含当日快照字段（${snapshotFields.join("、")}），只有今天的读数、没有历史每一天的数，历史回测复算不了`,
      fields: snapshotFields,
    });
    continue;
  }
  usable.push(s);
}

// 条件去重：所有策略的同一条条件只算一次位图
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

// ---- 2) 大盘档位（上证 MA20）----
const db = new PrismaClient();

const idxRows = (await db.$queryRawUnsafe(
  `SELECT tradeDate, close FROM stock_daily_bar WHERE symbol = ? ORDER BY tradeDate ASC`,
  INDEX_SYMBOL,
)) as { tradeDate: string; close: number }[];
if (idxRows.length < 60) {
  console.error(`粮仓缺少 ${INDEX_SYMBOL} 日K（只有 ${idxRows.length} 根），无法判档`);
  process.exit(1);
}
const allDates = idxRows.map((r) => r.tradeDate).slice(-BARS);
const idxCloses = idxRows.map((r) => r.close).slice(-BARS);
const T = allDates.length;
const dateToIdx = new Map(allDates.map((d, i) => [d, i]));
const regimeSeries = regimeSeriesOf(idxCloses);
console.log(`日期轴：${allDates[0]} → ${allDates[T - 1]}（${T} 根，取最近 ${BARS}）`);
console.log(`策略：${allStrategies.length} 条 → 可回测 ${usable.length} 条 / 剔除 ${rejected.length} 条；去重条件 ${condList.length} 条`);

// ---- 3) 股票池 ----
const symRows = (await db.$queryRawUnsafe(
  `SELECT symbol, COUNT(*) c FROM stock_daily_bar GROUP BY symbol HAVING c >= 200 ORDER BY symbol ASC`,
)) as { symbol: string; c: bigint | number }[];
let universe = symRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));
if (LIMIT) universe = universe.slice(0, LIMIT);
console.log(`股票池：${universe.length} 只`);

// ---- 4) 累加器：strategy × regime × split ----
type Acc = ReturnType<typeof emptyAcc>;
const accAll = usable.map(() => emptyAcc());
const accRegime = usable.map(() => ({ 强势: emptyAcc(), 震荡: emptyAcc(), 弱势: emptyAcc() }) as Record<Regime, Acc>);
const accSplit = usable.map(() => ({ train: emptyAcc(), validation: emptyAcc(), test: emptyAcc() }));
const accOos = usable.map(() => ({ 强势: emptyAcc(), 震荡: emptyAcc(), 弱势: emptyAcc() }) as Record<Regime, Acc>);
const accRecent = usable.map(() => emptyAcc()); // 近 110 根窗口（n110/win110，沿用老字段名）
const RECENT_FROM = Math.max(0, T - 110);
let hitsTotal = 0;
let blockedTotal = 0;
let symbolsDone = 0;

const t0 = Date.now();
for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
  const chunk = universe.slice(c0, c0 + CHUNK);
  const ph = chunk.map(() => "?").join(",");
  const rows = (await db.$queryRawUnsafe(
    `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar
     WHERE symbol IN (${ph}) AND tradeDate >= ? ORDER BY symbol ASC, tradeDate ASC`,
    ...chunk,
    allDates[0],
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
  // panel 的日期轴是这批股票的并集 ⊆ 全局日期轴；建立 局部下标 → 全局下标
  const localToGlobal = panel.dates.map((d) => dateToIdx.get(d) ?? -1);
  const pT = panel.dates.length;
  const oMat = panel.fields.get("o")!;
  const cMat = panel.fields.get("c")!;
  const ratios = syms.map((s) => limitRatio(s, "")); // 无股票简称 → ST 股按非 ST 判涨停，略偏乐观（已在输出里注明）
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
      for (let t = WARMUP; t < pT - 6; t++) {
        let hit = true;
        for (let k = 0; k < nk; k++) if (!refs[k][t]) { hit = false; break; }
        if (!hit) continue;
        hitsTotal++;
        const g = localToGlobal[t];
        const regime = g >= 0 ? regimeSeries[g] : null;
        const outcome = eventOutcomeOf({
          entryOpen: o[t + 1],
          signalClose: c[t],
          limitRatio: ratio,
          exitOpen1: o[t + 2],
          exitOpen5: o[t + 6],
        });
        if (!outcome.tradable) { blockedTotal++; continue; }
        accPush(accAll[pi], outcome);
        accPush(accSplit[pi][g >= 0 ? splitNameOf(g, T) : "train"], outcome);
        if (g >= RECENT_FROM) accPush(accRecent[pi], outcome);
        if (regime) {
          accPush(accRegime[pi][regime], outcome);
          if (g >= Math.floor(T * (SPLIT_RATIO.train + SPLIT_RATIO.validation))) accPush(accOos[pi][regime], outcome);
        }
      }
    }
  }
  symbolsDone += syms.length;
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(`\r  已跑 ${symbolsDone}/${universe.length} 只（${el}s，命中 ${hitsTotal}，买不进 ${blockedTotal}）   `);
}

function splitNameOf(g: number, total: number): "train" | "validation" | "test" {
  const a = Math.floor(total * SPLIT_RATIO.train);
  const b = Math.floor(total * (SPLIT_RATIO.train + SPLIT_RATIO.validation));
  if (g < a) return "train";
  if (g < b) return "validation";
  return "test";
}

console.log(`\n完成：${symbolsDone} 只 / ${((Date.now() - t0) / 1000).toFixed(0)}s；命中 ${hitsTotal} 次，其中次日买不进剔除 ${blockedTotal} 次`);

// ---- 5) 组装输出 ----
const rows: RegimeRow[] = usable.map((s, i) => {
  const all = accStatOf(accAll[i]);
  const recent = accStatOf(accRecent[i]);
  const seg = {
    train: accStatOf(accSplit[i].train),
    validation: accStatOf(accSplit[i].validation),
    test: accStatOf(accSplit[i].test),
  };
  const rg = {} as Record<Regime, RegimeStat | null>;
  for (const g of REGIMES) {
    const st = accStatOf(accRegime[i][g]);
    const oos = accStatOf(accOos[i][g]);
    rg[g] = st
      ? {
          n: st.n,
          win: st.win,
          avg: st.net1,
          avg5: st.net5 ?? 0,
          winCi: st.winCi,
          oos: oos ? { n: oos.n, win: oos.win, net1: oos.net1, net5: oos.net5, winCi: oos.winCi } : null,
        }
      : null;
  }
  return {
    id: s.id,
    name: s.name,
    condsText: s.condsText,
    n1: all?.n ?? 0,
    win1: all?.win ?? 0,
    avg1: all?.net1 ?? 0,
    avg5: all?.net5 ?? 0,
    n110: recent?.n ?? 0,
    win110: recent?.win ?? 0,
    gross1: all?.gross1 ?? null,
    winCi: all?.winCi ?? null,
    costAdjusted: true,
    split: {
      train: seg.train ? { n: seg.train.n, win: seg.train.win, net1: seg.train.net1, winCi: seg.train.winCi } : null,
      validation: seg.validation ? { n: seg.validation.n, win: seg.validation.win, net1: seg.validation.net1, winCi: seg.validation.winCi } : null,
      test: seg.test ? { n: seg.test.n, win: seg.test.win, net1: seg.test.net1, winCi: seg.test.winCi } : null,
    },
    强势: rg.强势,
    震荡: rg.震荡,
    弱势: rg.弱势,
  } as RegimeRow;
}).filter((r) => r.n1 > 0);

const rank: Record<string, unknown> = {};
const rankCounts: Record<string, number> = {};
let rankBasis = "";
for (const g of REGIMES) {
  const r = regimeRankOf(rows, g, { limit: 15 });
  rank[g] = r.items;
  rankCounts[g] = r.items.length;
  rankBasis = r.basis;
}
console.log(`三档榜单：强势 ${rankCounts.强势} / 震荡 ${rankCounts.震荡} / 弱势 ${rankCounts.弱势} 条（排序依据：${rankBasis || "—"}）`);

const out = {
  generatedAt: new Date().toISOString(),
  builtAt: new Date().toISOString(),
  source: "scripts/backtest-strategy-regime.ts（本地粮仓 stock_daily_bar 前复权日K）",
  window: {
    universe: symbolsDone,
    bars: T,
    from: allDates[0],
    to: allDates[T - 1],
    note: `全A前复权日K，最近 ${T} 根；前 ${WARMUP} 根只作指标预热不记样本`,
  },
  basis: {
    entry: "T+1 开盘（T 日收盘发信号，T 日收盘价成交是买不进的，已废）",
    exit: "T+2 开盘（持 1 日）/ T+6 开盘（持 5 日）",
    cost: `扣费后：佣金 ${(EVENT_COST.commissionRate * 100).toFixed(2)}% + 印花税(卖) ${(EVENT_COST.stampDuty * 100).toFixed(2)}% + 滑点 ${(EVENT_COST.slippageRate * 100).toFixed(2)}% + 点差 ${(EVENT_COST.spreadRate * 100).toFixed(2)}%，往返 ${(roundTripDragOf() * 100).toFixed(2)}%`,
    costAdjusted: true,
    untradeable: "次日一字涨停/停牌的样本直接剔除，不计入 n（不是记 0 收益）",
    split: "按命中日切三段：前 60%、中间 20%、最后 20%；页面主看最后那 20%（这段没参与挑选）",
    caveat: "股票简称缺失 → ST 股按非 ST 的 10% 判涨停，个别样本偏乐观",
  },
  regimeMethod: "上证指数 MA20 趋势法：收盘在 MA20 上且 MA20 向上=强势；之下且向下=弱势；其余=震荡",
  thresholds: {
    minHits: 100,
    minTotal: 150,
    minOosHits: 50,
    note: "每个档位要够 100 次、总共够 150 次，且在没参与挑选的那段行情里也要够 50 次，才上榜（门槛在 regime-core，此处只作留痕）",
  },
  counts: {
    strategies: allStrategies.length,
    backtestable: usable.length,
    rejected: rejected.length,
    rows: rows.length,
    hits: hitsTotal,
    blocked: blockedTotal,
    强势: rankCounts.强势,
    震荡: rankCounts.震荡,
    弱势: rankCounts.弱势,
  },
  rankBasis: rankBasis || "全期（无样本外成绩，旧口径）",
  rejected,
  rank,
  rows,
};

if (DRY) {
  console.log("--dry：不写盘。全期（扣费后）vs 样本外（test 段）预览：");
  for (const r of rows.slice(0, 10)) {
    const t = r.split?.test ?? null;
    console.log(
      `${r.id}/${r.name}　全期 n=${r.n1} 胜${r.win1.toFixed(1)}% 净${r.avg1.toFixed(2)}%（毛 ${(r.gross1 ?? 0).toFixed(2)}%）` +
      `　样本外 ${t ? `n=${t.n} 胜${t.win.toFixed(1)}% 净${t.net1.toFixed(2)}%` : "样本不足"}`,
    );
  }
  for (const g of REGIMES) {
    const top = (rank[g] as { id: number; name: string; stat: { oos: { n: number; win: number; net1: number } | null }; basis: string }[]).slice(0, 5);
    console.log(`\n${g}期 Top${top.length}（${rankBasis}）：`);
    for (const it of top) {
      const o = it.stat.oos;
      console.log(`  ${it.id}/${it.name} ${it.basis}${o ? ` 胜${o.win.toFixed(1)}% 净${o.net1.toFixed(2)}%` : " 无样本外成绩"}`);
    }
  }
} else {
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`已写出 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)}KB）：rows=${rows.length}`);
}

await db.$disconnect();
