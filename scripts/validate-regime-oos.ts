/**
 * 样本外验证（P34 收尾的「关键一刀」，2026-09-30）。
 *
 * 回答的问题：大盘档位（强势/震荡/弱势，上证 MA20 趋势法）对「次日全市场收益」
 * 到底有没有真预测力——而不是靠同一份数据既挑档又评收益得出的自嗨数字。
 *
 * 为什么之前做不到：Zcode 的分档回测只有聚合统计（n/win/avg），没有逐月/逐日时间序列，
 * 重跑 461 条策略 × 全A 需要（未入库的）原脚本与全因子通路，本仓做不了。
 *
 * 本脚本的口径（全部本地、可复跑）：
 *   ① 档位序列：tdxKlines("000001.SH") 日K → regimeSeriesOf（与线上弹卡同一处纯核）；
 *   ② 每日全市场次日收益：stock_daily_close（04-20 起 ~110 交易日全A）逐票算
 *      c_t/c_{t-1}-1，取**中位**（中位对涨跌停极值稳健，比等权均值更难被少数票拉走）；
 *   ③ 配对：档位(t) → 次日收益(t+1)；
 *   ④ 样本外：按时间前 70% 训练（记各档均值 μ_g），后 30% 只做检验——
 *      训练期的档位排序在后段是否保序（强势>震荡>弱势）、强弱差符号是否一致。
 *   ⑤ 全部分组数字照实输出；结论部分明确写「这不是策略级样本外，是档位级」。
 *
 * 用法：node --experimental-strip-types scripts/validate-regime-oos.ts
 * 产物：stdout + data/regime-oos-report.json（入库，下次不必重算）。
 */
import fs from "node:fs";
import path from "node:path";
import { regimeSeriesOf } from "../src/lib/quant/strategy/regime-core.ts";

// eltdx 网关裸调用（不 import src/lib/desk/tdx.ts：它内部有 @/ 别名，node 直跑解析不了）。
// 端点/参数与 tdx.ts 的 tdxKlines 完全一致（bars.get，前复权日线），只是 here 复刻一份。
const GW = process.env.TDX_GATEWAY ?? "http://127.0.0.1:8756";

async function gatewayKlines(symbol: string, count: number): Promise<{ date: string; c: number }[] | null> {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const code = m[2].toLowerCase() + m[1];
  const res = await fetch(`${GW}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, method: "bars.get", params: { code, period: "day", count, adjust: "qfq" } }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json()) as { ok?: boolean; result?: { bars?: { time: string; close: number }[] } };
  const bars = j?.result?.bars;
  if (!Array.isArray(bars) || !bars.length) return null;
  return bars
    .map((b) => ({ date: String(b.time).slice(0, 10), c: Number(b.close) }))
    .filter((k) => Number.isFinite(k.c));
}

const OUT = path.join(process.cwd(), "data", "regime-oos-report.json");
const TRAIN_RATIO = 0.7;

function median(xs: number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : Number.NaN;
}

interface GroupStat {
  n: number;
  meanPct: number;
  medianPct: number;
  winPct: number;
}

function groupStat(xs: number[]): GroupStat {
  return {
    n: xs.length,
    meanPct: Math.round(mean(xs) * 100) / 100,
    medianPct: Math.round(median(xs) * 100) / 100,
    winPct: xs.length ? Math.round((xs.filter((v) => v > 0).length / xs.length) * 1000) / 10 : Number.NaN,
  };
}

async function main(): Promise<void> {
  // ---------- ① 档位序列（与线上同一纯核） ----------
  const bars = await gatewayKlines("000001.SH", 300);
  if (!bars || bars.length < 40) {
    console.error("上证日K取不到或太短（bars=", bars?.length, "），无法判档");
    process.exit(1);
  }
  const closes = bars.map((b) => b.c);
  const dates = bars.map((b) => b.date);
  const regimes = regimeSeriesOf(closes); // 与 closes 同长（null=算不出）
  const regimeOfDate = new Map<string, string>();
  for (let i = 0; i < dates.length; i++) {
    const r = regimes[i];
    if (r) regimeOfDate.set(dates[i], r);
  }
  console.log(`上证日K ${bars.length} 根（${dates[0]} ~ ${dates[dates.length - 1]}），可判档 ${regimeOfDate.size} 天`);

  // ---------- ② 每日全市场中位次日收益（stock_daily_close） ----------
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  const rows = await db.stockDailyClose.findMany({
    select: { symbol: true, tradeDate: true, close: true },
    orderBy: [{ tradeDate: "asc" }, { symbol: "asc" }],
  });
  await db.$disconnect();
  const byDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byDate.get(r.tradeDate);
    if (!m) byDate.set(r.tradeDate, (m = new Map()));
    m.set(r.symbol, r.close);
  }
  const dts = [...byDate.keys()].sort();
  const retOf = new Map<string, number>(); // date t -> 当日全市场中位涨跌幅 %
  const cntOf = new Map<string, number>();
  for (let i = 1; i < dts.length; i++) {
    const prev = byDate.get(dts[i - 1])!;
    const cur = byDate.get(dts[i])!;
    const pcts: number[] = [];
    for (const [sym, c] of cur) {
      const p = prev.get(sym);
      if (p != null && p > 0 && Number.isFinite(c)) pcts.push((c / p - 1) * 100);
    }
    if (pcts.length >= 100) {
      retOf.set(dts[i], median(pcts));
      cntOf.set(dts[i], pcts.length);
    }
  }
  console.log(`stock_daily_close ${dts.length} 个交易日（${dts[0]} ~ ${dts[dts.length - 1]}），全A中位次日收益就绪`);

  // ---------- ③ 配对：档位(t) → 次日收益(t+1) ----------
  // 「次日」= K线序列里 t 的下一根（对齐交易日），收益来自 stock_daily_close 的中位口径
  const pairs: { date: string; nextDate: string; regime: string; ret: number; n: number }[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    const t = dates[i];
    const t1 = dates[i + 1];
    const reg = regimeOfDate.get(t);
    const ret = retOf.get(t1);
    const n = cntOf.get(t1);
    if (reg && ret != null && n != null) pairs.push({ date: t, nextDate: t1, regime: reg, ret, n });
  }
  // 注意：配对只含 stock_daily_close 覆盖到的日子（04-20 起）；更早的档位没有本地收益可配，如实丢弃
  console.log(`可配对样本（档位 t → 次日 t+1 都有数）：${pairs.length} 天`);

  // ---------- ④ 全样本分组 + 样本外切分 ----------
  const REGIMES = ["强势", "震荡", "弱势"] as const;
  const all: Record<string, number[]> = { 强势: [], 震荡: [], 弱势: [] };
  for (const p of pairs) all[p.regime]?.push(p.ret);

  const cut = Math.floor(pairs.length * TRAIN_RATIO);
  const train = pairs.slice(0, cut);
  const test = pairs.slice(cut);
  const trainG: Record<string, number[]> = { 强势: [], 震荡: [], 弱势: [] };
  const testG: Record<string, number[]> = { 强势: [], 震荡: [], 弱势: [] };
  for (const p of train) trainG[p.regime]?.push(p.ret);
  for (const p of test) testG[p.regime]?.push(p.ret);

  const stat = (g: Record<string, number[]>) =>
    Object.fromEntries(REGIMES.map((k) => [k, groupStat(g[k])]));

  const trainStats = stat(trainG);
  const testStats = stat(testG);

  // 保序性：训练期均值排序 vs 检验期均值排序
  const orderOf = (s: Record<string, GroupStat>) =>
    REGIMES.slice().sort((a, b) => (s[b]?.meanPct ?? -99) - (s[a]?.meanPct ?? -99));
  const trainOrder = orderOf(trainStats);
  const testOrder = orderOf(testStats);
  const orderKept = trainOrder.join(">") === testOrder.join(">");
  const trainSpread = trainStats["强势"].meanPct - trainStats["弱势"].meanPct;
  const testSpread = testStats["强势"].meanPct - testStats["弱势"].meanPct;
  const spreadSignKept = Math.sign(trainSpread) === Math.sign(testSpread);

  // ---------- 输出 ----------
  const allStats = stat(all);
  console.log("\n" + "=".repeat(76));
  console.log(`档位级样本外验证 · 训练/检验 = 前 ${cut} 天 / 后 ${pairs.length - cut} 天（TRAIN_RATIO=${TRAIN_RATIO}）`);
  console.log("口径：档位=上证MA20趋势法（线上同一纯核）；次日收益=全A**中位**个股涨跌幅（stock_daily_close）");
  console.log("=".repeat(76));
  const dump = (label: string, s: Record<string, GroupStat>) => {
    console.log(`\n【${label}】`);
    for (const k of REGIMES) {
      const g = s[k];
      console.log(`  ${k}：n=${g.n}  均值 ${g.meanPct >= 0 ? "+" : ""}${g.meanPct}%  中位 ${g.medianPct >= 0 ? "+" : ""}${g.medianPct}%  上涨占比 ${g.winPct}%`);
    }
  };
  dump(`全样本（${pairs.length} 天）`, allStats);
  dump(`训练期（前 ${cut} 天）`, trainStats);
  dump(`检验期（后 ${pairs.length - cut} 天）`, testStats);

  console.log("\n【样本外判定】");
  console.log(`  训练期档位排序：${trainOrder.join(" > ")}`);
  console.log(`  检验期档位排序：${testOrder.join(" > ")}`);
  console.log(`  保序？ ${orderKept ? "是" : "否"}`);
  console.log(`  强弱差（强势-弱势）：训练 ${trainSpread >= 0 ? "+" : ""}${Math.round(trainSpread * 100) / 100}% → 检验 ${testSpread >= 0 ? "+" : ""}${Math.round(testSpread * 100) / 100}%，符号${spreadSignKept ? "一致" : "反转"}`);

  const honest = orderKept && spreadSignKept && testSpread > 0;
  console.log("\n【诚实结论】");
  if (honest) {
    console.log("  保序 + 强弱差符号一致且为正：档位在样本外保留了方向信息，值得继续投入（策略级验证仍待做）。");
  } else if (spreadSignKept) {
    console.log("  强弱差符号一致但排序有变化：档位有部分信息，不宜全信排序，只用「强 vs 弱」两端。");
  } else {
    console.log("  样本外强弱差反转：训练期排序不可信——分档的「策略排名」层要打折看待，先别加码。");
  }
  console.log("  边界：这是**档位级**检验（档位→全市场中位次日收益），不是 461 条策略的样本外；");
  console.log("  策略级需要重跑带日期戳的全量回测（原脚本未入库），挂账。");

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: "档位级样本外：档位=上证MA20趋势法(regime-core)；次日收益=全A中位个股涨跌幅(stock_daily_close)；前70%训练/后30%检验",
    klineRange: { first: dates[0], last: dates[dates.length - 1], bars: bars.length },
    closeRange: { first: dts[0], last: dts[dts.length - 1] },
    pairs: pairs.length,
    trainDays: cut,
    testDays: pairs.length - cut,
    allStats, trainStats, testStats,
    trainOrder, testOrder, orderKept,
    trainSpreadPct: Math.round(trainSpread * 100) / 100,
    testSpreadPct: Math.round(testSpread * 100) / 100,
    spreadSignKept,
    verdict: honest ? "kept" : spreadSignKept ? "partial" : "reversed",
  }, null, 2));
  console.log(`\n已写 ${OUT}`);
}

main().catch((e) => {
  console.error("脚本出错：", e);
  process.exit(1);
});
