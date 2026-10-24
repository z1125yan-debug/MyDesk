// 第 5 种分歧取数层（服务端）：同花顺资金 + 板块中位涨跌。
// 板块中位：用 data/rps-seed-latest.json 的第一级板块分组（“煤炭-煤炭开采-动力煤”→“煤炭”），
// 在 DB stock_daily_bar 里算同板块所有票当日涨跌幅的中位。缺数据 → null，不编。

import "server-only";
import fs from "fs";
import path from "path";
import { db } from "../../db.ts";
import { fetchThsStockFunds, thsCodeFromSymbol } from "../../desk/ths-fund.ts";
import {
  judgeMainVsRetail,
  buildMainVsRetailSection,
  type MainVsRetailInput,
  type MainVsRetailResult,
} from "./main-vs-retail-divergence-core.ts";

export type { MainVsRetailInput, MainVsRetailResult };
export { judgeMainVsRetail, buildMainVsRetailSection };

const ADJUST = "qfq";
const SEED_FILE = path.join(process.cwd(), "data", "rps-seed-latest.json");

function firstSector(sector: string | null | undefined): string | null {
  if (!sector) return null;
  const seg = sector.split(/[-|]/)[0]?.trim();
  return seg || null;
}

/** 读种子文件，建 第一级板块 → 代码列表（code 为 6 位数字）。失败返回空 Map。 */
function sectorPeers(): Map<string, string[]> {
  try {
    if (!fs.existsSync(SEED_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(SEED_FILE, "utf-8")) as { rows?: { symbol?: string; sector?: string }[] };
    const m = new Map<string, string[]>();
    for (const r of raw?.rows ?? []) {
      const code = String(r.symbol ?? "").split(".")[0].replace(/[^0-9]/g, "");
      const seg = firstSector(r.sector);
      if (!code || !seg) continue;
      const arr = m.get(seg) ?? [];
      arr.push(code);
      m.set(seg, arr);
    }
    return m;
  } catch {
    return new Map();
  }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 批量算指定板块的第一级板块中位涨跌幅（tradeDate 当日收盘 vs 前一交易日收盘）。
 * 板块内票数 0 / DB 无行 → null。
 */
export async function fetchSectorMedianChangePct(
  tradeDate: string,
  sectors: readonly (string | null | undefined)[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const wanted = [...new Set(sectors.map((s) => firstSector(s)).filter((s): s is string => !!s))];
  if (!wanted.length) return out;
  const peers = sectorPeers();
  let prevDay: string | null = null;
  try {
    const r = await db.$queryRawUnsafe<{ m: string | null }[]>(
      `SELECT MAX(tradeDate) AS m FROM stock_daily_bar WHERE tradeDate < ?`, tradeDate,
    );
    prevDay = r[0]?.m ?? null;
  } catch {
    prevDay = null;
  }
  if (!prevDay) {
    for (const s of wanted) out.set(s, null);
    return out;
  }
  for (const seg of wanted) {
    try {
      const codes = [...new Set(peers.get(seg) ?? [])];
      if (!codes.length) {
        out.set(seg, null);
        continue;
      }
      // symbol 在 DB 里是 "600519.SH" 形式：用 code 拼后缀匹配三类市场
      const symbols: string[] = [];
      for (const c of codes) {
        if (c.startsWith("92")) symbols.push(`${c}.BJ`);
        else if (c.startsWith("0") || c.startsWith("2") || c.startsWith("3")) symbols.push(`${c}.SZ`);
        else symbols.push(`${c}.SH`);
      }
      const symList = symbols.map(() => "?").join(",");
      const rows = await db.$queryRawUnsafe<{ symbol: string; tradeDate: string; close: number }[]>(
        `SELECT symbol, tradeDate, close FROM stock_daily_bar WHERE adjust = ? AND tradeDate IN (?, ?) AND symbol IN (${symList})`,
        ADJUST, tradeDate, prevDay, ...symbols,
      );
      const bySym = new Map<string, { today?: number; prev?: number }>();
      for (const r of rows) {
        const e = bySym.get(r.symbol) ?? {};
        if (r.tradeDate === tradeDate) e.today = Number(r.close);
        else e.prev = Number(r.close);
        bySym.set(r.symbol, e);
      }
      const chgs: number[] = [];
      for (const e of bySym.values()) {
        if (e.today != null && e.prev != null && e.prev !== 0) chgs.push(((e.today - e.prev) / Math.abs(e.prev)) * 100);
      }
      out.set(seg, median(chgs));
    } catch {
      out.set(seg, null);
    }
  }
  return out;
}

export interface FundTriple {
  symbol: string;
  mainNetYi: number | null;
  superNetYi: number | null;
  midNetYi: number | null;
  smallNetYi: number | null;
}

/**
 * 批量拉同花顺资金三边（主力 / 大户 / 散户）。THS 只给当前值：
 * 调用方只在 tradeDate == DB 最新交易日时用（盘前冻结值即当日值）；历史日不拉，不冒充。
 * 单只失败 → 该只四项全 null，不编 0。
 */
export async function fetchFundTriples(symbols: readonly string[]): Promise<Map<string, FundTriple>> {
  const out = new Map<string, FundTriple>();
  for (const s of symbols) {
    out.set(s.toUpperCase(), { symbol: s, mainNetYi: null, superNetYi: null, midNetYi: null, smallNetYi: null });
  }
  try {
    const codes = symbols.map((s) => thsCodeFromSymbol(s)).filter((x): x is string => !!x);
    const funds = await fetchThsStockFunds(codes);
    const codeToSym = new Map(symbols.map((s) => [(thsCodeFromSymbol(s) ?? "").replace(/^hs_/, ""), s.toUpperCase()]));
    for (const f of funds) {
      const sym = codeToSym.get(String(f.code ?? ""));
      if (!sym) continue;
      out.set(sym, {
        symbol: sym,
        mainNetYi: f.mainNetYi,
        superNetYi: f.superNetYi,
        midNetYi: (f.midInRaw - f.midOutRaw) / 1e8,
        smallNetYi: f.smallNetYi,
      });
    }
  } catch {
    // THS 失败：全 null
  }
  return out;
}
