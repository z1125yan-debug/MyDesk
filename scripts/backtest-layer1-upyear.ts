// TEST-ONLY: 上涨年（2024-09-01~2025-08-29）layer1 池复算（离线验证，不动线上，不写生产表）。
// 与 scripts/backtest-layer1-expand.ts 同口径（档位Top5→命中→每策略成交额前10→并集），
// 区别：SSE 用 sse-tdx-upyear.json（700 根，2023-11-23~2026-10-16，覆盖上涨年 + MA20 预热），
// 默认窗口改为 2024-09-01~2025-08-29，输出 layer1-upyear.json。
//
// 与 scripts/backtest-aipick-month.ts 的 layer1 口径完全一致：
//   档位 Top5（data/strategy-regime.json rank）→ scanHitsOnDate 语义
//   （buildFieldPanel + hitMatrixOf 按位与）→ 每策略按当日成交额取前 10 → 并集。
// 区别：只算到富化之前（不调 CLS/巨潮/MCP/LLM），且全量面板只建一次。
//   面板一次建与逐日重建等价：fields.ts 全部因子都是因果计算（ trailing 窗口/递归，
//   分型信号落在确认日、中枢用已完成K），D 日的字段值只依赖 ≤D 的 K 线。
// 输出：每决策日的 layer1 池（symbol/命中策略/当日 OHLCV/涨幅/成交额），供 Python 做
//   硬过滤 + 逻辑回归 + 评估。换手所需 floatShares 单独由 MCP 补取步骤提供，不在这里调。
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db.ts";
import { regimeSeriesOf, type Regime } from "../src/lib/quant/strategy/regime-core.ts";
import { strategyLibrary } from "../src/lib/quant/data/strategy-library.ts";
import { FACTOR_FIELD_MAP, buildFieldPanel, chanMerge, type BarsLike } from "../src/lib/quant/factors/fields.ts";
import { condKeyOf, hitMatrixOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";

const ROOT = process.cwd();
const GOAL = "/home/hatch/workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files";
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);
const CHUNK = 60; // VM 总内存仅 7.7G，块小一点防 OOM

function argVal(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function blockReasonOf(conds: readonly { field?: string }[]): string | null {
  const snapshot: string[] = [];
  const pending: string[] = [];
  for (const c of conds) {
    const field = String(c.field ?? "");
    const def = FACTOR_FIELD_MAP.get(field);
    if (!def) { pending.push(field || "空字段"); continue; }
    if ((def as { implemented?: boolean }).implemented === false) pending.push(def.zh);
    else if ((def as { source?: string }).source === "snapshot") snapshot.push(def.zh);
  }
  const parts: string[] = [];
  if (snapshot.length) parts.push(`条件含当日快照字段「${[...new Set(snapshot)].join("、")}」，历史K线算不出`);
  if (pending.length) parts.push(`条件含未实现因子「${[...new Set(pending)].join("、")}」`);
  return parts.length ? parts.join("；") : null;
}

async function main(): Promise<void> {
  const start = argVal("--start") ?? "2024-09-01";
  const end = argVal("--end") ?? "2025-08-29";
  const outPath = argVal("--out") ?? path.join(GOAL, "up-probability", "layer1-upyear.json");

  // --- 上证档位（sse-tdx-upyear.json，700 根 2023-11-23~2026-10-16） ---
  const sseRaw = JSON.parse(fs.readFileSync(path.join(GOAL, "sse-tdx-upyear.json"), "utf-8")) as {
    result: { bars: { time: string; close: number }[] };
  };
  const sseDates = sseRaw.result.bars.map((b) => String(b.time).slice(0, 10));
  const sseCloses = sseRaw.result.bars.map((b) => Number(b.close));
  const sseRegimes = regimeSeriesOf(sseCloses);
  const regimeOf = new Map<string, Regime | null>();
  sseDates.forEach((d, i) => regimeOf.set(d, sseRegimes[i] ?? null));

  // --- 交易日轴（全市场行数 >=1000） ---
  const dayRows = await db.$queryRawUnsafe<{ tradeDate: string; n: number }[]>(
    `SELECT tradeDate, COUNT(*) AS n FROM stock_daily_bar GROUP BY tradeDate HAVING n >= 1000 ORDER BY tradeDate ASC`,
  );
  const axis = dayRows.map((r) => r.tradeDate);
  const axisIdx = new Map(axis.map((d, i) => [d, i]));
  const decisionDays = axis.filter((d) => {
    if (d < start || d > end) return false;
    const i = axisIdx.get(d)!;
    return i + 2 < axis.length; // T+1 评估需 D+2 在轴上
  });
  console.log(`轴 ${axis[0]}..${axis[axis.length - 1]}（${axis.length} 天），决策日 ${decisionDays.length} 天：${decisionDays[0]}..${decisionDays[decisionDays.length - 1]}`);

  // --- 档位 Top5 ---
  const rankJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategy-regime.json"), "utf-8")) as {
    rank: Record<string, { id: number; name: string }[]>;
  };
  const lib = strategyLibrary();
  const byId = new Map(lib.map((s) => [s.id, s]));

  // --- 全量日 K（≤ end） ---
  // 只保留一份 barsBySym（BarsLike 形状），不另存 rawBySym 双份；barRows 出作用域即释放。
  const barsBySym = await (async () => {
    const barRows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[]>(
      `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar WHERE tradeDate <= ? ORDER BY symbol ASC, tradeDate ASC`,
      end,
    );
    console.log(`bars loaded: ${barRows.length}`);
    const m = new Map<string, BarsLike[]>();
    for (const r of barRows) {
      if (NOT_STOCKS.has(r.symbol)) continue;
      const arr = m.get(r.symbol) ?? [];
      arr.push({ date: r.tradeDate, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, amount: r.amount });
      m.set(r.symbol, arr);
    }
    return m;
  })();
  const universe = [...barsBySym.keys()].sort();
  console.log(`universe symbols: ${universe.length}`);

  // --- 每决策日的策略配置 ---
  interface StratCfg { id: number; name: string; conds: MatCond[]; blocked: string | null }
  const stratCfgByDay = new Map<string, StratCfg[]>();
  const allConds = new Map<string, MatCond>();
  for (const D of decisionDays) {
    const regime = regimeOf.get(D) ?? null;
    if (!regime) { console.log(`[${D}] 档位 null，跳过`); continue; }
    const top5 = (rankJson.rank[regime] ?? []).slice(0, 5);
    const cfgs: StratCfg[] = top5.map((s) => {
      const st = byId.get(s.id);
      const conds = ((st?.conds ?? []) as MatCond[]).map((c) => ({ ...c, key: condKeyOf(c as never) }) as unknown as MatCond);
      for (const c of conds) {
        const k = condKeyOf(c);
        if (!allConds.has(k)) allConds.set(k, c);
      }
      return { id: s.id, name: s.name, conds, blocked: conds.length ? blockReasonOf(conds.map((c) => ({ field: c.field }))) : "这条策略没有条件，无从算命中" };
    });
    stratCfgByDay.set(D, cfgs);
  }
  const distinctConds = [...allConds.values()];
  console.log(`distinct conds: ${distinctConds.length}`);

  // --- 按 symbol 分块建面板，算命中位图，累积每策略每决策日的命中 ---
  // hits[day][strategyId] = [{symbol, close, amount}]
  const hits = new Map<string, Map<number, { symbol: string; close: number; amount: number }[]>>();
  for (const D of decisionDays) hits.set(D, new Map());
  let totalSyms = 0;
  for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
    const chunk = universe.slice(c0, c0 + CHUNK);
    const barsList = chunk.map((s) => barsBySym.get(s) as BarsLike[]);
    const metas = chunk.map(() => undefined as never);
    const panel = buildFieldPanel(chunk, barsList, metas);
    // 每条 distinct cond 在本块的位图
    const condMats = new Map<string, Uint8Array[]>();
    for (const c of distinctConds) {
      const field = panel.fields.get(c.field);
      const mats: Uint8Array[] = [];
      for (let si = 0; si < chunk.length; si++) {
        mats.push(field ? hitMatrixOf(c, field[si]) : new Uint8Array(panel.dates.length));
      }
      condMats.set(condKeyOf(c), mats);
    }
    // 另：策略 620 的 chan_bottom_fractal 对截断敏感——chanMerge 用全量序列会把 D 日的分型
    // 信号推到未来（合并K吸收了 D 之后的 bar），而 harness/实盘是按 bars ≤ D 截断算的。
    // 因此 620 单独处理：zsb_accum 位图 AND 截断分型。截断分型用增量算法：
    //   全量 merge 一次得 M_1..M_k（ends 递增）；截断在 D 时，已闭合的 M_1..M_j（end≤D）不变，
    //   只需对 (e_j+1..D) 小段再 merge 得未闭合的尾巴 P（merge 是顺序的，早期的合并K不受后续影响）。
    //   截断分型信号 at D ⟺ 最后三根截断合并K满足底分型条件（与 chanFractalFlags 在 ≤D 序列上等价）。
    const FRACTAL_620_ID = 620;
    const zsbAccumKey = distinctConds.find((c) => c.field === "zsb_accum") ? condKeyOf(distinctConds.find((c) => c.field === "zsb_accum")!) : null;
    const hPanel = panel.fields.get("h")!;
    const lPanel = panel.fields.get("l")!;
    // 每只票全量 merge（一次）+ 每决策日的截断分型（只对 zsb_accum 命中的票算，620 才用）
    const mergedBySym = chunk.map((_, si) => chanMerge(hPanel[si], lPanel[si]));
    const truncFractal = (si: number, t: number): boolean => {
      const merged = mergedBySym[si];
      // j = 最后一个 end ≤ t 的合并K下标
      let j = -1;
      for (let i = 0; i < merged.length; i++) {
        if (merged[i].end <= t) j = i; else break;
      }
      const trunc: { hi: number; lo: number; end: number }[] = j >= 0 ? merged.slice(0, j + 1) : [];
      if (j < 0 || merged[j].end < t) {
        // 未闭合尾巴：对 (e_j+1 .. t) 小段 merge（e_j = j>=0 ? merged[j].end : -1）
        const from = j >= 0 ? merged[j].end + 1 : 0;
        const hSub = hPanel[si].slice(from, t + 1);
        const lSub = lPanel[si].slice(from, t + 1);
        const p = chanMerge(hSub, lSub).map((m) => ({ hi: m.hi, lo: m.lo, end: m.end + from }));
        trunc.push(...p);
      }
      if (trunc.length < 3) return false;
      const a = trunc[trunc.length - 3], b = trunc[trunc.length - 2], c = trunc[trunc.length - 1];
      if (c.end !== t) return false; // 信号必须落在 D 当天
      return b.lo < a.lo && b.lo < c.lo && b.hi < a.hi && b.hi < c.hi;
    };
    for (const D of decisionDays) {
      const t = panel.dates.indexOf(D);
      if (t < 0) continue;
      const cfgs = stratCfgByDay.get(D) ?? [];
      for (const cfg of cfgs) {
        if (cfg.blocked) continue;
        if (cfg.id === FRACTAL_620_ID) {
          const accMat = zsbAccumKey ? condMats.get(zsbAccumKey) : undefined;
          if (!accMat) continue;
          const arr = hits.get(D)!.get(cfg.id) ?? [];
          for (let si = 0; si < chunk.length; si++) {
            if (!accMat[si][t]) continue;
            const bar = barsBySym.get(chunk[si])!.find((b) => b.date === D);
            if (!bar) continue;
            if (truncFractal(si, t)) arr.push({ symbol: chunk[si], close: bar.c, amount: bar.amount });
          }
          hits.get(D)!.set(cfg.id, arr);
          continue;
        }
        const keys = cfg.conds.map((c) => condKeyOf(c));
        const arr = hits.get(D)!.get(cfg.id) ?? [];
        for (let si = 0; si < chunk.length; si++) {
          let ok = true;
          for (const k of keys) {
            if (!condMats.get(k)![si][t]) { ok = false; break; }
          }
          if (!ok) continue;
          const bar = barsBySym.get(chunk[si])!.find((b) => b.date === D);
          if (!bar) continue;
          arr.push({ symbol: chunk[si], close: bar.c, amount: bar.amount });
        }
        hits.get(D)!.set(cfg.id, arr);
      }
    }
    totalSyms += chunk.length;
    if ((c0 / CHUNK) % 10 === 0) console.log(`panel chunk ${c0}..${c0 + chunk.length} / ${universe.length}`);
  }
  console.log(`panel done, syms=${totalSyms}`);

  // --- 每日：每策略取成交额前 10，并集 + 富化-lite ---
  const daysOut: Record<string, unknown>[] = [];
  for (const D of decisionDays) {
    const regime = regimeOf.get(D) ?? null;
    const cfgs = stratCfgByDay.get(D) ?? [];
    const layer1ByStrategy: { id: number; name: string; hits: number; kept: number; blockedReason: string | null }[] = [];
    const candStrategies = new Map<string, number[]>();
    for (const cfg of cfgs) {
      if (cfg.blocked) {
        layer1ByStrategy.push({ id: cfg.id, name: cfg.name, hits: 0, kept: 0, blockedReason: cfg.blocked });
        continue;
      }
      const arr = hits.get(D)!.get(cfg.id) ?? [];
      const top = [...arr].sort((a, b) => b.amount - a.amount).slice(0, 10);
      layer1ByStrategy.push({ id: cfg.id, name: cfg.name, hits: arr.length, kept: top.length, blockedReason: null });
      for (const h of top) {
        const list = candStrategies.get(h.symbol) ?? [];
        list.push(cfg.id);
        candStrategies.set(h.symbol, list);
      }
    }
    const pool = [...candStrategies.entries()].map(([symbol, strategyIds]) => {
      const bars = barsBySym.get(symbol)!;
      const bar = bars.find((b) => b.date === D)!;
      const prev = [...bars].reverse().find((b) => b.date < D);
      const changePct = prev && prev.c !== 0 ? ((bar.c - prev.c) / Math.abs(prev.c)) * 100 : null;
      return {
        symbol, strategyIds, strategy: strategyIds[0],
        open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v, amount: bar.amount,
        prevClose: prev ? prev.c : null, changePct,
      };
    }).sort((a, b) => a.symbol.localeCompare(b.symbol));
    daysOut.push({ decisionDate: D, regime, layer1ByStrategy, pool });
    console.log(`[${D} ${regime}] layer1=${pool.length} (${layer1ByStrategy.map((x) => `${x.id}:${x.kept}${x.blockedReason ? "(blocked)" : ""}`).join(" ")})`);
  }

  const out = {
    generatedBy: "scripts/backtest-layer1-upyear.ts (TEST-ONLY)",
    start, end,
    axis: { first: axis[0], last: axis[axis.length - 1], n: axis.length },
    decisionDays,
    note: "layer1 口径与 backtest-aipick-month.ts 一致（档位Top5→命中→每策略成交额前10→并集）；changePct=当日收盘 vs 上一根K收盘；不含新闻/公告/主力/换手（换手需 floatShares，另步补取）。",
    days: daysOut,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`输出：${outPath}`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("LAYER1 EXPAND FAILED:", e);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
