// P36-E6：把「之前涨得最猛 / 跌得最狠的两批票，接下来 5 天各怎么样」按大盘档位拆开，
// 落成界面能直接读的 data/regime-reversal.json（档位切换条弹层里那几句话的数字出处）。
//
// 为什么要落静态文件：跟 data/strategy-regime.json 一个套路——这是慢变量（跑一轮几十秒），
// 页面只读 JSON，也方便 diff 和复核。
//
// 为什么要重跑而不是沿用 113 天的老数：老数（exports/tmp/reversal-by-regime.ts）跑在
// stock_daily_close 上，那张表只有 113 个交易日、来路存疑（任务书 2.5.1 记过这个矛盾），
// 而且判档要现连行情接口。B0 之后本地有全A 800 根**前复权**日K（含上证指数 000001.SH），
// 同一套算法能在本地、在三倍以上的天数上复算——数字以这份为准，口径写在文件里，
// 任何人照着这条命令都能再跑一遍对上。
//
// 用法：node --experimental-strip-types scripts/build-regime-reversal.ts
//
// 口径（与老脚本一致，只是换了数据源）：
// - 股票池：窗口内日均成交额 Top600（且至少 600 根日K），避免拿僵尸股凑数；
// - 每天（截面）按「过去 20 天涨跌幅」从高到低排，最高十分之一=涨最猛那批，最低十分之一=跌最狠那批；
// - 看它们**往后 5 个交易日**的平均涨跌（前复权价，分红送转不会算成暴跌）；
// - 档位用 regime-core 的 regimeAt（上证最近一个月平均价 + 方向），与线上弹卡同一处纯核。

import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db.ts";
import { regimeAt, REGIMES, type Regime } from "../src/lib/quant/strategy/regime-core.ts";

const OUT = path.join(process.cwd(), "data", "regime-reversal.json");
const INDEX_SYMBOL = "000001.SH";
// 可选：--universe=1500 扩池、--pick=small 改取**成交额最小**的一批（小票里反转是否更明显）。
// 默认 large（日均成交额最高的 600 只）= 真买得进的那批，与「可成交」红线一致。
const argOf = (k: string, dflt: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const UNIVERSE = Number(argOf("universe", "600"));
const PICK = argOf("pick", "large") === "small" ? "ASC" : "DESC";
const HORIZON = 5;   // 往后看几个交易日
const LOOKBACK = 20; // 过去多少天算「涨得猛 / 跌得狠」
const MIN_PAIRS = 60; // 一个截面里有效股票太少就不算这天

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : Number.NaN);
const r2 = (v: number): number => Math.round(v * 100) / 100;

async function main(): Promise<void> {
  // 1) 上证日K：判档用的唯一序列（本地粮仓，不发外部请求）
  const idx = await db.stockDailyBar.findMany({
    where: { symbol: INDEX_SYMBOL, adjust: "qfq" },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, close: true },
  });
  if (idx.length < LOOKBACK + HORIZON + 30) {
    console.error(`本地上证日K只有 ${idx.length} 根，跑不出档位分档（先跑 scripts/backfill-daily-bars.ts）`);
    process.exit(1);
  }
  const idxDates = idx.map((r) => r.tradeDate);
  const idxCloses = idx.map((r) => r.close);
  const idxPos = new Map<string, number>();
  for (let i = 0; i < idxDates.length; i++) idxPos.set(idxDates[i], i);

  // 2) 股票池：日均成交额 Top600（先按根数筛掉次新股/长期停牌）
  const uniRows = await db.$queryRawUnsafe<{ symbol: string }[]>(
    `SELECT symbol, COUNT(*) AS c, AVG(amount) AS amt FROM stock_daily_bar
     WHERE adjust='qfq' GROUP BY symbol HAVING c >= ? ORDER BY amt ${PICK} LIMIT ?`,
    Math.floor(idx.length * 0.75), UNIVERSE,
  );
  const universe = uniRows.map((r) => String(r.symbol));
  if (universe.length < 100) {
    console.error(`股票池只有 ${universe.length} 只，样本不足以分十组`);
    process.exit(1);
  }

  // 3) 拉收盘价面板（600 只 × 800 天 ≈ 48 万行，一次进内存）
  const placeholders = universe.map(() => "?").join(",");
  const pxRows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; close: number }[]>(
    `SELECT symbol, tradeDate, close FROM stock_daily_bar WHERE adjust='qfq' AND symbol IN (${placeholders})`,
    ...universe,
  );
  const panel = new Map<string, (number | null)[]>();
  for (const s of universe) panel.set(s, new Array(idx.length).fill(null));
  for (const r of pxRows) {
    const arr = panel.get(String(r.symbol));
    const i = idxPos.get(String(r.tradeDate));
    if (arr && i != null) arr[i] = Number(r.close);
  }

  // 4) 逐截面：分组收益 + 记当天档位
  const acc = new Map<Regime, { days: number; hot: number[]; cold: number[]; mkt: number[] }>();
  let skipped = 0;
  for (let t = LOOKBACK; t + HORIZON < idx.length; t++) {
    const reg = regimeAt(idxCloses, t);
    const pairs: { fv: number; ret: number }[] = [];
    for (const arr of panel.values()) {
      const cur = arr[t];
      const past = arr[t - LOOKBACK];
      const fwd = arr[t + HORIZON];
      if (!(cur! > 0) || !(past! > 0) || !(fwd! > 0)) continue;
      pairs.push({ fv: (cur as number) / (past as number) - 1, ret: (fwd as number) / (cur as number) - 1 });
    }
    if (pairs.length < MIN_PAIRS) { skipped++; continue; }
    if (!reg) { skipped++; continue; }
    pairs.sort((a, b) => b.fv - a.fv);
    const size = Math.max(1, Math.floor(pairs.length / 10));
    const hot = mean(pairs.slice(0, size).map((p) => p.ret)) * 100;
    const cold = mean(pairs.slice(-size).map((p) => p.ret)) * 100;
    const mkt = mean(pairs.map((p) => p.ret)) * 100;
    const b = acc.get(reg) ?? { days: 0, hot: [], cold: [], mkt: [] };
    b.days++; b.hot.push(hot); b.cold.push(cold); b.mkt.push(mkt);
    acc.set(reg, b);
  }

  const byRegime: Record<string, { days: number; hot: number; cold: number; spread: number; excess: number; mkt: number }> = {};
  for (const reg of REGIMES) {
    const b = acc.get(reg);
    if (!b || !b.days) continue;
    const hot = mean(b.hot);
    const cold = mean(b.cold);
    const mkt = mean(b.mkt);
    byRegime[reg] = {
      days: b.days,
      hot: r2(hot), cold: r2(cold),
      spread: r2(cold - hot),
      excess: r2(cold - mkt),
      mkt: r2(mkt),
    };
  }
  if (!Object.keys(byRegime).length) {
    console.error("三档一档都没攒出截面，不写文件（宁可让页面如实说没有，也不写空数冒充）");
    process.exit(1);
  }

  const out = {
    builtAt: new Date().toISOString(),
    source: "本地日K粮仓 stock_daily_bar（前复权，B0 落库）× regime-core 判档；脚本 scripts/build-regime-reversal.ts",
    window: {
      from: idxDates[0], to: idxDates[idxDates.length - 1], bars: idx.length,
      universe: universe.length, horizon: HORIZON, lookback: LOOKBACK,
      days: Object.values(byRegime).reduce((s, x) => s + x.days, 0),
      skipped,
    },
    byRegime,
    note: `每天把股票池按过去 ${LOOKBACK} 天涨跌分成十档，取「涨最猛」和「跌最狠」两批，看它们往后 ${HORIZON} 个交易日的平均涨跌；档位由上证最近一个月的平均价与方向判（regime-core，与线上同一处）。`,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`已写 ${OUT}`);
  console.log(`窗口 ${out.window.from} → ${out.window.to}（${idx.length} 根）· 股票池 ${universe.length} 只 · 有效截面 ${out.window.days} 天（跳过 ${skipped}）`);
  for (const reg of REGIMES) {
    const b = byRegime[reg];
    if (!b) { console.log(`${reg}：没有攒出截面`); continue; }
    console.log(`${reg}：${b.days} 天 · 涨最猛 ${b.hot}% · 跌最狠 ${b.cold}% · 价差 ${b.spread}% · 比市场平均 ${b.excess}%`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
