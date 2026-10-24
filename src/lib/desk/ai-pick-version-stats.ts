// AI 优选分版胜率 · 卖出日三个触发点各算一次（晚报 + 接口共用同一份计算，两处呈现同一份结果）。
//
// 口径（2026-10-17 修正两次）：
//   · 决策日 D 的每个版本（第1版、第2版……按 runAt 排序），在卖出日 D+2 的三个时刻
//     （10:30 / 11:30 休盘 / 15:00 收盘）各算一次：
//       每版平均涨跌 = 该版各票净收益的等权平均（有价的票才计入）；
//       胜率 = 该版里净收益跑赢上证的票数 / 有价的票数（跑赢上证算赢）。
//   · 涨跌幅 = 卖价 vs 买入价（D+1 开盘买入价，扣 0.41% 成本后为净收益）。
//     买入日 = 决策日之后第 1 个交易日（交易日历，日历覆盖不到时用库里卖出日之前
//     最近一个交易日兜底）；个股买入价 = DB 日K open；上证买入价 = TDX 日K open
//     （指数不在 stock_daily_bar）。买入日没有该票的日K（停牌等）→ 该票不计入，不编。
//   · 上证涨跌同样按净收益算（卖出日时刻价 vs D+1 开盘，扣 0.41%），胜率对比口径一致；
//     上证没价 → 该时刻整行“没取到”。
//   · 某票某时刻没价 → 该票不计入该时刻的平均与胜率（不拿别的时间的价顶替）。
//   · 买入日（D+1）/ 选股日（D）的快照不能当卖点用：compute 会拒绝非卖出日的 evalDate。
//     已有的 10-16 快照是买入日的，文件保留，但排除在版本评估之外。
//   · 缺数据就说“没取到”，不编。

import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { tradingDaysAfter } from "@/lib/desk/trade-calendar";
import { isSellDayEval, sellDayOfDecision as sellDayOfDecisionCore, versionsSellingOnDate, VERSION_SELL_OFFSET } from "@/lib/desk/price-snapshots-core";
import { listAiPickVersions, listAllAiPickVersions, type AiPickVersion } from "@/lib/quant/strategy/ai-pick-versions";
import type { PriceSnapshot } from "@/lib/desk/price-snapshots-core";

const SNAPSHOTS_DIR = path.join(process.cwd(), "data", "price-snapshots");
const SSE = "000001.SH";
const SLOTS = ["1030", "1130", "close"] as const;
export type VersionSlot = (typeof SLOTS)[number];
export const VERSION_SLOT_LABELS: Record<VersionSlot, string> = {
  "1030": "10:30",
  "1130": "11:30 休盘",
  close: "15:00 收盘",
};

export interface VersionSlotStat {
  slot: VersionSlot;
  label: string;
  /** 该版该时刻的平均涨跌幅 %（等权）；没算出为 null */
  avgChangePct: number | null;
  /** 该版该时刻的胜率 %（跑赢上证的票占比）；没算出为 null */
  winRatePct: number | null;
  /** 计入统计的票数（有价） */
  counted: number;
  /** 该版总票数 */
  total: number;
  /** 同一时刻上证涨跌幅 %；没取到为 null */
  sseChangePct: number | null;
  /** 该时刻的缺失说明（为空 = 正常算出） */
  missing: string | null;
}

export interface VersionStat {
  versionIndex: number; // 第几版（1 起）
  version: AiPickVersion;
  slots: VersionSlotStat[];
}

async function readSnapshotFile(date: string, slot: VersionSlot, dir: string = SNAPSHOTS_DIR): Promise<PriceSnapshot | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${date}-${slot}.json`), "utf-8");
    const parsed = JSON.parse(raw) as PriceSnapshot;
    if (parsed?.date === date && parsed?.slot === slot) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 买入日 = 决策日之后第 1 个交易日（D+1，交易日历）；日历覆盖不到时用库里
 * 卖出日之前最近一个交易日（任一票的日K日期）兜底。算不出 → null */
async function buyDayOf(decisionDate: string, evalDate: string): Promise<string | null> {
  const fromCal = tradingDaysAfter(decisionDate, 1)[0] ?? null;
  if (fromCal) return fromCal;
  try {
    const row = await db.stockDailyBar.findFirst({
      where: { tradeDate: { lt: evalDate } },
      orderBy: { tradeDate: "desc" },
      select: { tradeDate: true },
    });
    return row?.tradeDate ?? null;
  } catch {
    return null;
  }
}

/** 买入价 = 该票在买入日（D+1）的开盘价（DB 日K open）；该日无日K（停牌等）→ null */
async function buyOpenOf(symbol: string, buyDay: string): Promise<number | null> {
  try {
    const bar = await db.stockDailyBar.findFirst({
      where: { symbol, tradeDate: buyDay },
      select: { open: true },
    });
    if (bar && Number.isFinite(bar.open)) return bar.open;
  } catch {
    // DB 读失败 → null，不编
  }
  return null;
}

/** 上证买入价 = 上证在买入日（D+1）的开盘价（指数不在 stock_daily_bar，走 TDX 日K）。
 * TDX 取不到 → null（该时刻上证对比算不出，整行“没取到”，不拿收盘价顶替）。 */
async function sseBuyOpen(buyDay: string): Promise<number | null> {
  try {
    const { tdxDayBars } = await import("@/lib/desk/tdx");
    const bars = await tdxDayBars("000001.SH", 30);
    const bar = bars?.find((b) => b.date === buyDay);
    if (bar && Number.isFinite(bar.o)) return bar.o;
  } catch {
    // TDX 取失败 → null，不编
  }
  return null;
}

/** 某决策日 D 的卖出日 = D 之后第 2 个交易日（D+2，跳周末/休市）；交易日历覆盖不到时 null */
export function sellDayOfDecision(decisionDate: string): string | null {
  return sellDayOfDecisionCore(decisionDate, tradingDaysAfter(decisionDate, VERSION_SELL_OFFSET));
}

/** 卖出日是某天的决策日（D+2 映射是单射，最多一个）；没有版本在该天卖出时 null */
export async function decisionDateSellingOn(date: string): Promise<string | null> {
  const all = await listAllAiPickVersions();
  const decisions = [...new Set(all.map((v) => v.tradeDate))].sort();
  const sellDayByDecision = new Map<string, string | null>(
    decisions.map((d) => [d, sellDayOfDecision(d)]),
  );
  return versionsSellingOnDate(all, date, sellDayByDecision).decisionDate;
}

/** 净收益 % = 卖价 vs D+1 开盘买入价，扣 0.41% 成本。卖价/买入价缺失或买入价为 0 → null */
export function netReturnPct(
  sellPrice: number | null | undefined,
  buyOpen: number | null | undefined,
): number | null {
  if (sellPrice == null || buyOpen == null || buyOpen === 0) return null;
  return ((sellPrice - buyOpen) / Math.abs(buyOpen)) * 100 - 0.41;
}

const fmt = (v: number | null, digits = 2): string =>
  typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%` : "没取到";

/**
 * 算某决策日各版本在某验证日的分版胜率（三个时刻各一次）。
 * 版本文件缺 → versions=[]；快照缺 → 对应时刻 missing="没取到"。
 */
export async function computeAiPickVersionStats(
  decisionDate: string,
  evalDate: string,
  opts?: { snapshotsDir?: string },
): Promise<{ decisionDate: string; evalDate: string; versions: VersionStat[]; missing: string[] }> {
  const missing: string[] = [];
  // 卖出日门禁：evalDate 必须是决策日的卖出日（D+2）。买入日（D+1）/ 选股日（D）
  // 的快照不能当卖点用——直接拒绝，不拿错日的价算。交易日历覆盖不到、卖出日算不出时
  // 放行显式 evalDate（算不出 ≠ 拒绝理由），由调用方负责。
  const sellDay = sellDayOfDecision(decisionDate);
  if (!isSellDayEval(evalDate, sellDay)) {
    missing.push(
      `${evalDate} 不是 ${decisionDate} 的卖出日（卖出日是 ${sellDay}，D+2），` +
        `买入日/选股日的快照不能当卖点用，拒绝评估。`,
    );
    return { decisionDate, evalDate, versions: [], missing };
  }
  const versions = await listAiPickVersions(decisionDate);
  if (!versions.length) {
    missing.push(`${decisionDate} 没有 AI 优选版本，算不出分版胜率。`);
    return { decisionDate, evalDate, versions: [], missing };
  }
  // 买入日 = 决策日之后第 1 个交易日（D+1）；买入价 = 各票买入日开盘价
  const buyDay = await buyDayOf(decisionDate, evalDate);
  if (!buyDay) {
    missing.push(`买入日（${decisionDate} 之后第 1 个交易日）算不出，算不出分版胜率。`);
    return { decisionDate, evalDate, versions: [], missing };
  }
  // 读三张快照 + 每只票的买入价（买入价只与买入日有关，一次算好）+ 上证买入价（TDX）
  const snapshotsDir = opts?.snapshotsDir ?? SNAPSHOTS_DIR;
  const snaps = new Map<VersionSlot, PriceSnapshot | null>();
  for (const slot of SLOTS) snaps.set(slot, await readSnapshotFile(evalDate, slot, snapshotsDir));
  const allSymbols = new Set<string>();
  for (const v of versions) for (const p of v.picks) allSymbols.add(String(p.symbol || "").trim().toUpperCase());
  const buyMap = new Map<string, number | null>();
  for (const sym of allSymbols) buyMap.set(sym, await buyOpenOf(sym, buyDay));
  const sseBuy = await sseBuyOpen(buyDay);

  const out: VersionStat[] = [];
  versions.forEach((version, vi) => {
    const slots: VersionSlotStat[] = SLOTS.map((slot) => {
      const snap = snaps.get(slot);
      const rows = new Map((snap?.rows ?? []).map((r) => [r.symbol, r]));
      const sseRow = rows.get(SSE);
      const sseChange = netReturnPct(sseRow?.price ?? null, sseBuy);
      if (!snap || sseChange == null) {
        return {
          slot, label: VERSION_SLOT_LABELS[slot],
          avgChangePct: null, winRatePct: null,
          counted: 0, total: version.picks.length,
          sseChangePct: null,
          missing: !snap ? `${VERSION_SLOT_LABELS[slot]}快照没取到` : "上证没价，算不出对比",
        };
      }
      const changes: number[] = [];
      let wins = 0;
      for (const p of version.picks) {
        const sym = String(p.symbol || "").trim().toUpperCase();
        const row = rows.get(sym);
        const chg = netReturnPct(row?.price ?? null, buyMap.get(sym) ?? null);
        if (chg == null) continue;
        changes.push(chg);
        if (chg > sseChange) wins++;
      }
      if (!changes.length) {
        return {
          slot, label: VERSION_SLOT_LABELS[slot],
          avgChangePct: null, winRatePct: null,
          counted: 0, total: version.picks.length,
          sseChangePct: sseChange,
          missing: "该版的票在该时刻都没价",
        };
      }
      const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
      return {
        slot, label: VERSION_SLOT_LABELS[slot],
        avgChangePct: avg, winRatePct: (wins / changes.length) * 100,
        counted: changes.length, total: version.picks.length,
        sseChangePct: sseChange,
        missing: null,
      };
    });
    out.push({ versionIndex: vi + 1, version, slots });
  });
  return { decisionDate, evalDate, versions: out, missing };
}

/** 分版胜率 → 晚报一节的文案（小白语言，每句带当时时间）。晚报与接口用同一份 compute 结果。 */
export function buildAiPickVersionWinRateSection(
  decisionDate: string,
  evalDate: string,
  stats: VersionStat[],
  missing: string[],
): string {
  const head = `AI 优选分版胜率（决策日 ${decisionDate}，卖出日 ${evalDate}（D+2）验证；涨跌幅 = 卖价 vs D+1 开盘买入价，扣 0.41% 成本后为净收益；胜率 = 该版里跑赢上证的票占比）：`;
  if (!stats.length) {
    return `${head}${missing.length ? missing.join(" ") : "没有 AI 优选版本，算不出。"}`;
  }
  const parts = stats.map((vs) => {
    const names = vs.version.picks.map((p) => p.name || p.symbol).join("、");
    const slotText = vs.slots.map((s) => {
      if (s.missing) return `${s.label} ${s.missing}`;
      const beat = s.avgChangePct != null && s.sseChangePct != null
        ? (s.avgChangePct > s.sseChangePct ? "跑赢上证" : "跑输上证")
        : "";
      return `${s.label} 平均 ${fmt(s.avgChangePct)}（上证 ${fmt(s.sseChangePct)}，${beat}，胜率 ${s.winRatePct != null ? `${s.winRatePct.toFixed(0)}%` : "没取到"}，${s.counted}/${s.total} 只计入）`;
    }).join("；");
    return `第${vs.versionIndex}版（运行于 ${vs.version.runAt}，${vs.version.picks.length} 只：${names}）：${slotText}。`;
  });
  return `${head}${parts.join(" ")}`;
}
