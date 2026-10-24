// TEST-ONLY: per-strategy attribution — which Top5 strategy's candidates actually make/lose money?
// For each decision day: regime (TDX SSE) -> Top5 (strategy-regime.json) -> scanHits per strategy
// (DB bars 09-16..D, same as harness) -> top-10 by amount -> T+1 + 5-day eval, same skip rules.
// No model, no writes. Answers: is 620 alone bad, or is 1221 bad, or both?
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db.ts";
import { regimeSeriesOf, type Regime } from "../src/lib/quant/strategy/regime-core.ts";
import { strategyLibrary } from "../src/lib/quant/data/strategy-library.ts";
import { condKeyOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { scanHitsOnDate, topByAmountOf } from "../src/lib/quant/strategy/hit-scan-core.ts";
import { rpsSeedOf } from "../src/lib/quant/data/rps-seed.ts";
import { limitRatio, type BarsLike } from "../src/lib/quant/factors/fields.ts";

const ROOT = process.cwd();
const COST = 0.41;
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);

async function main() {
  const dayRows = await db.$queryRawUnsafe<{ tradeDate: string; n: number }[]>(
    `SELECT tradeDate, COUNT(*) AS n FROM stock_daily_bar GROUP BY tradeDate HAVING n >= 1000 ORDER BY tradeDate ASC`,
  );
  const tradingDays = dayRows.map((r) => r.tradeDate).filter((d) => d >= "2026-09-16" && d <= "2026-10-16");
  const decisionDays = tradingDays.filter((d, i) => i + 2 < tradingDays.length);

  const tdxRes = await fetch("http://127.0.0.1:8756/rpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "bars.get", params: { code: "sh000001", period: "day", count: 160 } }),
  });
  const tdxJson = (await tdxRes.json()) as { result?: { bars?: { time: string; close: number; open: number }[] } };
  const sseBars = tdxJson?.result?.bars ?? [];
  const sseOpen = new Map(sseBars.map((b) => [String(b.time).slice(0, 10), Number(b.open)]));
  const sseRegimes = regimeSeriesOf(sseBars.map((b) => Number(b.close)));
  const regimeOf = new Map<string, Regime | null>();
  sseBars.forEach((b, i) => regimeOf.set(String(b.time).slice(0, 10), sseRegimes[i] ?? null));

  const rankJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategy-regime.json"), "utf-8")) as {
    rank: Record<string, { id: number; name: string }[]>;
  };
  const lib = strategyLibrary();
  const byId = new Map(lib.map((s) => [s.id, s]));

  // name map for limit-ratio / N,C check
  const nameMap = new Map<string, string>();
  {
    const rows = await db.$queryRawUnsafe<{ symbol: string; name: string }[]>(
      `SELECT symbol, name FROM stock_daily_close WHERE (symbol, tradeDate) IN (SELECT symbol, MAX(tradeDate) FROM stock_daily_close GROUP BY symbol)`,
    );
    for (const r of rows) nameMap.set(r.symbol, r.name ?? "");
  }
  const barOf = async (sym: string, d: string) => {
    const r = await db.$queryRawUnsafe<{ open: number; close: number }[]>(
      `SELECT open, close FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = 'qfq' LIMIT 1`, sym, d,
    );
    return r[0] ?? null;
  };

  type Acc = { n1: number; sum1: number; win1: number; den1: number; n5: number; sum5: number; win5: number; den5: number; hits: number };
  const acc = new Map<number, Acc>();
  const accName = new Map<number, string>();
  for (const D of decisionDays) {
    const regime = regimeOf.get(D) ?? null;
    if (!regime) continue;
    const top5 = (rankJson.rank[regime] ?? []).slice(0, 5);
    const di = tradingDays.indexOf(D);
    const t1 = tradingDays[di + 1], t2 = tradingDays[di + 2];
    const t6 = di + 6 < tradingDays.length ? tradingDays[di + 6] : null;
    const o1 = sseOpen.get(t1), o2 = sseOpen.get(t2), o6 = t6 ? sseOpen.get(t6) : undefined;
    const sse1 = o1 && o2 ? ((o2 - o1) / o1) * 100 : null;
    const sse5 = o1 && o6 ? ((o6 - o1) / o1) * 100 : null;
    const universeRows = await db.$queryRawUnsafe<{ symbol: string }[]>(
      `SELECT symbol FROM stock_daily_bar WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol ASC`, D,
    );
    const universe = universeRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));
    const barRows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[]>(
      `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar WHERE tradeDate <= ? ORDER BY symbol ASC, tradeDate ASC`, D,
    );
    const barsBySym = new Map<string, BarsLike[]>();
    for (const r of barRows) {
      const arr = barsBySym.get(r.symbol) ?? [];
      arr.push({ date: r.tradeDate, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, amount: r.amount });
      barsBySym.set(r.symbol, arr);
    }
    const syms = universe.filter((s) => (barsBySym.get(s)?.length ?? 0) > 0);
    const barsList = syms.map((s) => barsBySym.get(s) as BarsLike[]);
    for (const s of top5) {
      const st = byId.get(s.id);
      const conds = ((st?.conds ?? []) as { field?: string }[]).map((c) => ({ ...c, key: condKeyOf(c as never) }) as unknown as MatCond);
      if (!conds.length) continue;
      accName.set(s.id, s.name);
      const a = acc.get(s.id) ?? { n1: 0, sum1: 0, win1: 0, den1: 0, n5: 0, sum5: 0, win5: 0, den5: 0, hits: 0 };
      const hits = scanHitsOnDate({ syms, barsList, conds, targetDate: D });
      a.hits += hits.length;
      const top = topByAmountOf(hits, 10);
      for (const h of top) {
        const dBar = await barOf(h.symbol, D);
        const t1Bar = await barOf(h.symbol, t1);
        if (!dBar || !t1Bar) continue;
        const nm = h.symbol ? (nameMap.get(h.symbol) ?? "") : "";
        const lim = limitRatio(h.symbol.toUpperCase(), nm);
        if (!/^[NC]/.test(nm) && t1Bar.open >= dBar.close * (1 + lim) - 1e-9) continue;
        const t2Bar = await barOf(h.symbol, t2);
        if (t2Bar) {
          const net = ((t2Bar.open - t1Bar.open) / t1Bar.open) * 100 - COST;
          a.n1++; a.sum1 += net;
          if (sse1 != null) { a.den1++; if (net > sse1) a.win1++; }
        }
        if (t6) {
          const t6Bar = await barOf(h.symbol, t6);
          if (t6Bar) {
            const net = ((t6Bar.open - t1Bar.open) / t1Bar.open) * 100 - COST;
            a.n5++; a.sum5 += net;
            if (sse5 != null) { a.den5++; if (net > sse5) a.win5++; }
          }
        }
      }
      acc.set(s.id, a);
    }
    console.log(`[${D}] ${regime} done`);
  }
  console.log("\n=== per-strategy top-10 candidates (same eval as harness) ===");
  for (const [id, a] of [...acc.entries()].sort((x, y) => y[0] - x[0])) {
    console.log(`ID ${id} (${accName.get(id)}): hits=${a.hits} | T+1 n=${a.n1} avg=${a.n1 ? (a.sum1 / a.n1).toFixed(2) : "—"} win=${a.den1 ? ((a.win1 / a.den1) * 100).toFixed(1) : "—"}% | 5d n=${a.n5} avg=${a.n5 ? (a.sum5 / a.n5).toFixed(2) : "—"} win=${a.den5 ? ((a.win5 / a.den5) * 100).toFixed(1) : "—"}%`);
  }
  await db.$disconnect();
}
main().catch(async (e) => { console.error("FAILED:", e); try { await db.$disconnect(); } catch {} process.exit(1); });
