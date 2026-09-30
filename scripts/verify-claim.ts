// P36-B 口径复算：拿榜单宣称值去本地粮仓里独立再算一遍，对不上就红。
//
// 为什么必须「独立」：主回测脚本 scripts/backtest-strategy-regime.ts 是
// 命中判定 → 面板取价 → 扣费 一条链走完的，自己验自己等于同义反复。
// 这里换两条路径：
//   1) 取价不走因子面板下标，而是按 (股票, 具体日期) 精确查库拿 open/close；
//   2) 收益用最朴素的「买入实付 / 卖出实收」手算，不调 event-core 的乘性封装。
// 两条链如果对得上，说明面板日期对齐、T+1/T+2 取价、成本口径都没漂。
// 条件判定不另起一套（判定语义全局只允许一份）——这是刻意的，不是漏了。
//
// 用法：
//   node --experimental-strip-types scripts/verify-claim.ts                 # 三档各 Top1（默认全市场复算）
//   node --experimental-strip-types scripts/verify-claim.ts --top 3 --sample 1500 --tol 0.3
// 退出码：全部对上 0；任一档差超过容差 1。

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { buildFieldPanel, FACTOR_FIELD_MAP, limitRatio, type BarsLike, type MetaLike } from "../src/lib/quant/factors/fields.ts";
import { hitMatrixOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { EVENT_COST, EVENT_NOTIONAL } from "../src/lib/quant/backtest/event-core.ts";
import { regimeSeriesOf, REGIMES, type Regime } from "../src/lib/quant/strategy/regime-core.ts";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const argOf = (n: string, d: number) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const TOP = argOf("top", 1);
const SAMPLE = argOf("sample", 0); // 0=全市场（默认：抽样太稀时统计噪声会盖过口径差，对账就没意义了）
const TOL = argOf("tol", 0.3); // 百分点
const WARMUP = argOf("warmup", 200);
const SPLIT = { train: 0.6, validation: 0.2, test: 0.2 };
const INDEX_SYMBOL = "000001.SH";
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);

const board = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategy-regime.json"), "utf8"));
const strats = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategies.json"), "utf8"));
const rows: any[] = board?.rows ?? [];
if (!rows.length) {
  console.error("data/strategy-regime.json 没有 rows，先跑 scripts/backtest-strategy-regime.ts");
  process.exit(1);
}

const db = new PrismaClient();
const idx = (await db.$queryRawUnsafe(
  `SELECT tradeDate, close FROM stock_daily_bar WHERE symbol = ? ORDER BY tradeDate ASC`, INDEX_SYMBOL,
)) as { tradeDate: string; close: number }[];
const dates = idx.map((r) => r.tradeDate);
const T = dates.length;
const regimeSeries = regimeSeriesOf(idx.map((r) => r.close));
const dateToIdx = new Map(dates.map((d, i) => [d, i]));
const testFrom = Math.floor(T * (SPLIT.train + SPLIT.validation));
console.log(`日期轴 ${dates[0]} → ${dates[T - 1]}（${T} 根）；样本外段从第 ${testFrom} 根起（${dates[testFrom]}）`);

// 抽样股票池：等间隔抽，保证可复现（不随机，免得每次跑出的对账值都不一样）
const symRows = (await db.$queryRawUnsafe(
  `SELECT symbol, COUNT(*) c FROM stock_daily_bar GROUP BY symbol HAVING c >= 200 ORDER BY symbol ASC`,
)) as { symbol: string }[];
const pool = symRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));
const step = SAMPLE ? Math.max(1, Math.floor(pool.length / SAMPLE)) : 1;
const sample = SAMPLE ? pool.filter((_, i) => i % step === 0).slice(0, SAMPLE) : pool;
console.log(`复算股票池 ${sample.length} 只${SAMPLE ? `（间隔 ${step} 抽样）` : "（全市场）"}\n`);

// 朴素成本：买入实付 = 价×(1+滑点+半点差)+佣金；卖出实收 = 价×(1-滑点-半点差)-佣金-印花税
const notional = EVENT_NOTIONAL;
const comm = Math.max(EVENT_COST.minCommission / notional, EVENT_COST.commissionRate);
const buyUp = 1 + EVENT_COST.slippageRate + EVENT_COST.spreadRate / 2 + comm;
const sellDn = 1 - EVENT_COST.slippageRate - EVENT_COST.spreadRate / 2 - comm - EVENT_COST.stampDuty;

let fail = 0;
for (const g of REGIMES) {
  const items: any[] = (board?.rank?.[g] ?? []).slice(0, TOP);
  if (!items.length) { console.log(`${g}：榜上无条目，跳过`); continue; }
  for (const it of items) {
    const row = rows.find((r) => r.id === it.id);
    const st = row?.[g];
    const claim = st?.oos ?? null;
    if (!claim) { console.log(`${g}/${it.id}/${it.name}：榜单没给样本外成绩，跳过对账`); continue; }
    const src = (strats?.data ?? []).find((s: any) => Number(s.id) === it.id);
    const conds: MatCond[] = (src?.conds ?? []).map((c: any) => ({
      field: String(c.field ?? ""), op: String(c.op ?? "="), value: c.value,
      type: c.type ?? "single", window: c.window, min_match_days: c.min_match_days,
    }));
    if (!conds.length) { console.log(`${g}/${it.id}：策略条件读不到，跳过`); continue; }
    const bad = conds.filter((c) => {
      const d = FACTOR_FIELD_MAP.get(c.field);
      return !d || d.implemented === false || d.source === "snapshot";
    });
    if (bad.length) { console.log(`${g}/${it.id}：条件含非K线字段，无法独立复算，跳过`); continue; }

    let n = 0, wins = 0, sum = 0;
    for (const sym of sample) {
      const bars = (await db.$queryRawUnsafe(
        `SELECT tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar WHERE symbol = ? AND tradeDate >= ? ORDER BY tradeDate ASC`,
        sym, dates[0],
      )) as { tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[];
      if (bars.length < WARMUP + 10) continue;
      const openByDate = new Map<string, number>();
      const closeByDate = new Map<string, number>();
      for (const b of bars) { openByDate.set(b.tradeDate, b.open); closeByDate.set(b.tradeDate, b.close); }
      const bl: BarsLike[] = bars.map((b) => ({ date: b.tradeDate, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, amount: b.amount }));
      const panel = buildFieldPanel([sym], [bl], [undefined as MetaLike | undefined]);
      const pT = panel.dates.length;
      const ratio = limitRatio(sym, "");
      // 命中位图（判定语义与主脚本同源，这里不重造）
      let hit: Uint8Array | null = null;
      for (const c of conds) {
        const m = hitMatrixOf(c, panel.fields.get(c.field)?.[0]);
        hit = hit ? hit.map((v, t) => (v && m[t] ? 1 : 0) as 0 | 1) : m;
      }
      if (!hit) continue;
      for (let t = WARMUP; t < pT - 2; t++) {
        if (!hit[t]) continue;
        const gIdx = dateToIdx.get(panel.dates[t]);
        if (gIdx === undefined || gIdx < testFrom || gIdx + 2 >= T) continue;
        if (regimeSeries[gIdx] !== (g as Regime)) continue;
        const entry = openByDate.get(dates[gIdx + 1]);
        const exit = openByDate.get(dates[gIdx + 2]);
        const sigClose = closeByDate.get(dates[gIdx]);
        if (entry == null || exit == null || sigClose == null || !(entry > 0)) continue;
        if (entry >= Math.round(sigClose * (1 + ratio) * 100) / 100) continue; // 次日一字涨停买不进
        const net = ((exit * sellDn - entry * buyUp) / (entry * buyUp)) * 100;
        n++; sum += net; if (net > 0) wins++;
      }
    }
    if (!n) { console.log(`${g}/${it.id}/${it.name}：抽样里没有样本，无法对账`); continue; }
    const avg = sum / n;
    const winPct = (wins / n) * 100;
    const dAvg = Math.abs(avg - claim.net1);
    const dWin = Math.abs(winPct - claim.win);
    const ok = dAvg <= TOL;
    if (!ok) fail++;
    console.log(
      `${ok ? "✓" : "✗"} ${g}/${it.id}/${it.name}：榜单 样本外 N=${claim.n} 胜${claim.win.toFixed(1)}% 净${claim.net1.toFixed(2)}%` +
      `　独立复算（${sample.length} 只）N=${n} 胜${winPct.toFixed(1)}% 净${avg.toFixed(2)}%` +
      `　Δ净=${dAvg.toFixed(2)}pp（容差 ${TOL}）Δ胜率=${dWin.toFixed(1)}pp`,
    );
  }
}
console.log(fail ? `\n${fail} 项对不上（差异超过 ${TOL} 个百分点）` : `\n全部对上（差异 ≤ ${TOL} 个百分点）`);
await db.$disconnect();
process.exit(fail ? 1 : 0);
