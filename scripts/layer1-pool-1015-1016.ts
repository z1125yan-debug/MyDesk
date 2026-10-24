// layer1-pool-1015-1016.ts — 只为 2026-10-15 / 2026-10-16 两个决策日算 layer1 池（取 symbols）。
// 新文件；与 scripts/backtest-aipick-month.ts 的 layer1 口径完全一致（同 regime、同 Top5、同 scanHitsOnDate、同 topByAmountOf 10）。
// 不调模型、不做评估、不写生产表、不动 ai-pick-*.ts。输出写 goal hidden_files/up-probability/pool-*.json。
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db.ts";
import { regimeSeriesOf, type Regime } from "../src/lib/quant/strategy/regime-core.ts";
import { strategyLibrary } from "../src/lib/quant/data/strategy-library.ts";
import { FACTOR_FIELD_MAP, type BarsLike } from "../src/lib/quant/factors/fields.ts";
import { condKeyOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { scanHitsOnDate, topByAmountOf, type HitRow } from "../src/lib/quant/strategy/hit-scan-core.ts";

const ROOT = process.cwd();
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);
const CHUNK = 120;
const OUT_DIR = "/home/hatch/workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/up-probability";
const DAYS = ["2026-10-15", "2026-10-16"];

function loadEnv(): void {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1];
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* 无 .env 则靠现成 env */ }
}

function blockReasonOf(conds: readonly { field?: string }[]): string | null {
  const snapshot: string[] = [];
  const pending: string[] = [];
  for (const c of conds) {
    const field = String(c.field ?? "");
    const def = FACTOR_FIELD_MAP.get(field);
    if (!def) { pending.push(field || "空字段"); continue; }
    if (def.implemented === false) pending.push(def.zh);
    else if ((def as { source?: string }).source === "snapshot") snapshot.push(def.zh);
  }
  const parts: string[] = [];
  if (snapshot.length) parts.push(`条件含当日快照字段「${[...new Set(snapshot)].join("、")}」，历史K线算不出`);
  if (pending.length) parts.push(`条件含未实现因子「${[...new Set(pending)].join("、")}」`);
  return parts.length ? parts.join("；") : null;
}

async function main(): Promise<void> {
  loadEnv();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tdxRes = await fetch("http://127.0.0.1:8756/rpc", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "bars.get", params: { code: "sh000001", period: "day", count: 160 } }),
  });
  const tdxJson = (await tdxRes.json()) as { ok?: boolean; result?: { bars?: { time: string; close: number; open: number }[] } };
  const sseBars = tdxJson?.result?.bars ?? [];
  const sseDates = sseBars.map((b) => String(b.time).slice(0, 10));
  const sseCloses = sseBars.map((b) => Number(b.close));
  const sseRegimes = regimeSeriesOf(sseCloses);
  const regimeOf = new Map<string, Regime | null>();
  sseDates.forEach((d, i) => regimeOf.set(d, sseRegimes[i] ?? null));
  console.log(`上证 TDX ${sseBars.length} 根，档位可算到 ${sseDates[sseDates.length - 1]}`);

  const rankJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategy-regime.json"), "utf-8")) as {
    rank: Record<string, { id: number; name: string }[]>;
  };
  const lib = strategyLibrary();
  const byId = new Map(lib.map((s) => [s.id, s]));

  for (const D of DAYS) {
    const regime = regimeOf.get(D) ?? null;
    if (!regime) { console.log(`[${D}] 档位 null，跳过`); continue; }
    const top5 = (rankJson.rank[regime] ?? []).slice(0, 5);
    console.log(`[${D}] 档位=${regime} Top5=${top5.map((s) => s.id).join(",")}`);

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
    const stratInfo = top5.map((s) => {
      const st = byId.get(s.id);
      const conds = (st?.conds ?? []) as { field?: string }[];
      return { id: s.id, name: s.name, conds: conds.map((c) => ({ ...c, key: condKeyOf(c as never) }) as unknown as MatCond), blocked: conds.length ? blockReasonOf(conds) : "这条策略没有条件，无从算命中" };
    });
    const layer1ByStrategy: { id: number; name: string; hits: number; kept: number; blockedReason: string | null }[] = [];
    const candSet = new Set<string>();
    const hitsByStrategy = new Map<number, HitRow[]>();
    for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
      const chunk = universe.slice(c0, c0 + CHUNK);
      const syms = chunk.filter((s) => (barsBySym.get(s)?.length ?? 0) > 0);
      const barsList = syms.map((s) => barsBySym.get(s) as BarsLike[]);
      for (const si of stratInfo) {
        if (si.blocked) continue;
        const hits = scanHitsOnDate({ syms, barsList, conds: si.conds, targetDate: D });
        const rec = layer1ByStrategy.find((x) => x.id === si.id) ?? { id: si.id, name: si.name, hits: 0, kept: 0, blockedReason: null };
        rec.hits += hits.length;
        if (!layer1ByStrategy.find((x) => x.id === si.id)) layer1ByStrategy.push(rec);
        if (!hits.length) continue;
        const arr = hitsByStrategy.get(si.id) ?? [];
        arr.push(...hits);
        hitsByStrategy.set(si.id, arr);
      }
    }
    for (const si of stratInfo) {
      if (si.blocked) continue;
      const top = topByAmountOf(hitsByStrategy.get(si.id) ?? [], 10);
      const rec = layer1ByStrategy.find((x) => x.id === si.id);
      if (rec) rec.kept = top.length;
      for (const h of top) candSet.add(h.symbol.toUpperCase());
    }
    for (const si of stratInfo) {
      if (si.blocked && !layer1ByStrategy.find((x) => x.id === si.id)) {
        layer1ByStrategy.push({ id: si.id, name: si.name, hits: 0, kept: 0, blockedReason: si.blocked });
      }
    }
    const pool = [...candSet].sort();
    console.log(`[${D}] layer1=${pool.length} 只（${layer1ByStrategy.map((x) => `${x.id}:${x.kept}${x.blockedReason ? "(blocked)" : ""}`).join(" ")}）`);
    fs.writeFileSync(path.join(OUT_DIR, `pool-${D}.json`), JSON.stringify({ decisionDate: D, regime, layer1ByStrategy, pool }, null, 2));
  }
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
