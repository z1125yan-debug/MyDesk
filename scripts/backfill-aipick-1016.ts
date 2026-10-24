// 一次性补算：2026-10-16 AI 优选（10-16 收盘后漏跑，记 16 号的版）。
//
// 候选池按回测方法重算（档位 Top5 策略 → DB 日K 现算命中 → 每策略按成交额取前 10），
// 再调生产 generateAiPickForDate('2026-10-16', { candidates }) 走完整生产链路
// （富化 → 硬过滤 → 模型 → 落库 + 版本化）。THS 主力：tradeDate != 今天 → null，不冒充。
//
// 诚实标注：这版是 10-18 补算的（版本 runAt 为今天），候选池是重算的，
// 不是 10-16 当天现场记的 gate/regime 池。数据本身（行情/估值/新闻/公告）都是 10-16 的。
//
// 用法：
//   node --import ./scripts/ts-alias-register.mjs --experimental-transform-types scripts/backfill-aipick-1016.ts

import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db.ts";
import { regimeSeriesOf, type Regime } from "../src/lib/quant/strategy/regime-core.ts";
import { strategyLibrary } from "../src/lib/quant/data/strategy-library.ts";
import { FACTOR_FIELD_MAP, type BarsLike } from "../src/lib/quant/factors/fields.ts";
import { condKeyOf, type MatCond } from "../src/lib/quant/strategy/cond-matrix-core.ts";
import { scanHitsOnDate, topByAmountOf, type HitRow } from "../src/lib/quant/strategy/hit-scan-core.ts";
import { generateAiPickForDate } from "../src/lib/quant/strategy/ai-pick-generate.ts";
import { AI_PICK_SOURCE, type AiPickCandidate } from "../src/lib/quant/strategy/ai-pick-core.ts";
import { parseSymbols } from "../src/lib/quant/strategy/pick-fill-core.ts";

const ROOT = process.cwd();
const D = "2026-10-16";
const CHUNK = 120;
const NOT_STOCKS = new Set(["000001.SH", "399001.SZ", "399006.SZ"]);

/** 读 .env（只读，不打印值），注入 process.env（不覆盖已有变量）。 */
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

async function fetchSseBars(): Promise<{ date: string; close: number }[]> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch("http://127.0.0.1:8756/rpc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "bars.get", params: { code: "sh000001", period: "day", count: 160 } }),
      });
      const json = (await res.json()) as { result?: { bars?: { time: string; close: number }[] } };
      const bars = (json?.result?.bars ?? []).map((b) => ({ date: String(b.time).slice(0, 10), close: Number(b.close) }));
      if (bars.length) return bars;
    } catch (e) {
      console.log(`TDX 第 ${attempt} 次取上证失败：${String((e as Error).message).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return [];
}

async function main(): Promise<void> {
  loadEnv();

  // --- 档位：TDX 上证 160 根 → 逐日档位 ---
  const sseBars = await fetchSseBars();
  if (!sseBars.length) {
    console.log("TDX 上证取不到，档位算不出，退出（不编候选）");
    process.exit(2);
  }
  const regimes = regimeSeriesOf(sseBars.map((b) => b.close));
  const regimeOf = new Map<string, Regime | null>();
  sseBars.forEach((b, i) => regimeOf.set(b.date, regimes[i] ?? null));
  const regime = regimeOf.get(D) ?? null;
  if (!regime) {
    console.log(`[${D}] 档位 null，退出`);
    process.exit(2);
  }
  console.log(`[${D}] 档位=${regime}`);

  // --- 档位 Top5 策略 ---
  const rankJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "strategy-regime.json"), "utf-8")) as {
    rank: Record<string, { id: number; name: string }[]>;
  };
  const top5 = (rankJson.rank[regime] ?? []).slice(0, 5);
  console.log(`[${D}] Top5=${top5.map((s) => s.id).join(",")}`);
  const lib = strategyLibrary();
  const byId = new Map(lib.map((s) => [s.id, s]));

  // --- layer1：DB 日K 现算命中 ---
  const universeRows = await db.$queryRawUnsafe<{ symbol: string }[]>(
    `SELECT symbol FROM stock_daily_bar WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol ASC`, D,
  );
  const universe = universeRows.map((r) => r.symbol).filter((s) => !NOT_STOCKS.has(s));
  // 只拉最近 200 个交易日（覆盖 MA144/RSV81/MACD 预热），不拉全历史——全量 320 万行会 OOM 被杀。
  const cutoffRows = await db.$queryRawUnsafe<{ tradeDate: string }[]>(
    `SELECT tradeDate FROM stock_daily_bar WHERE tradeDate <= ? GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 1 OFFSET 199`, D,
  );
  const cutoff = cutoffRows[0]?.tradeDate ?? D;
  const barRows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[]>(
    `SELECT symbol, tradeDate, open, high, low, close, volume, amount FROM stock_daily_bar WHERE tradeDate >= ? AND tradeDate <= ? ORDER BY symbol ASC, tradeDate ASC`, cutoff, D,
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
  const candMap = new Map<string, AiPickCandidate>();
  const hitsByStrategy = new Map<number, HitRow[]>();
  for (let c0 = 0; c0 < universe.length; c0 += CHUNK) {
    const chunk = universe.slice(c0, c0 + CHUNK);
    const syms = chunk.filter((s) => (barsBySym.get(s)?.length ?? 0) > 0);
    const barsList = syms.map((s) => barsBySym.get(s) as BarsLike[]);
    for (const si of stratInfo) {
      if (si.blocked) continue;
      const hits = scanHitsOnDate({ syms, barsList, conds: si.conds, targetDate: D });
      if (!hits.length) continue;
      const arr = hitsByStrategy.get(si.id) ?? [];
      arr.push(...hits);
      hitsByStrategy.set(si.id, arr);
    }
  }
  for (const si of stratInfo) {
    if (si.blocked) { console.log(`策略 ${si.id} 跳过：${si.blocked}`); continue; }
    const top = topByAmountOf(hitsByStrategy.get(si.id) ?? [], 10);
    console.log(`策略 ${si.id}（${si.name}）：命中 ${(hitsByStrategy.get(si.id) ?? []).length} 只，取前 ${top.length} 只`);
    for (const h of top) {
      const key = h.symbol.toUpperCase();
      if (!candMap.has(key)) candMap.set(key, { symbol: h.symbol, name: "", close: h.close ?? null, strategy: si.name });
    }
  }
  const rawCands = [...candMap.values()];
  console.log(`[${D}] layer1 重算 = ${rawCands.length} 只`);

  if (!rawCands.length) {
    console.log("layer1 为空，无从优选，退出");
    process.exit(2);
  }

  // --- 生产链路：富化 → 硬过滤 → 模型 → 落库 + 版本化（记 10-16 的版） ---
  const out = await generateAiPickForDate(D, { candidates: rawCands });
  console.log("生成结果：", JSON.stringify({ results: out.results, missing: out.missing, basis: out.source }));

  // --- 回读：确认落库 + 版本 ---
  const row = await db.strategyPick.findFirst({
    where: { tradeDate: D, source: AI_PICK_SOURCE },
    select: { symbols: true, symbolsNote: true },
  });
  if (row) {
    const syms = parseSymbols(row.symbols);
    console.log(`落库确认：${D} 共 ${syms.length} 只：${syms.map((s) => `${s.symbol}(${s.name || ""})`).join("、")}`);
  } else {
    console.log("落库确认：未找到该日 AI 优选行（可能模型未选出或硬过滤全拦）");
  }
  const vdir = path.join(ROOT, "data", "ai-pick-versions");
  const vfiles = fs.readdirSync(vdir).filter((f) => f.startsWith("2026-10-16-")).sort();
  console.log("版本文件：", vfiles.length ? vfiles.join(", ") : "无（未生成）");
}

main().catch((e) => {
  console.error("补算失败：", String((e as Error).message || e).slice(0, 500));
  process.exit(1);
});
