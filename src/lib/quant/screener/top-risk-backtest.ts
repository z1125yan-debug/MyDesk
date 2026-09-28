// Phase5 回测校准（轻量，纯用已有 sector-daily-snapshots.json，不接外部数据）
//
// 标签定义（v5 §413 简化版）：在某交易日 T，板块「未来 20 交易日相对全A 超额收益 < -10pp」
// = 一次真实趋势破坏事件（集 A）。引擎在 T 日判为「趋势反转 / 顶部形成中」= 发出预警（flagged）。
// 统计查准率(precision) / 查全率(recall) / F1，并给出「假阳性集 B」比例（flagged 但非真实顶部）。
//
// 用途：把引擎阈值从「首版默认」变成「有历史证据」；不做自动扫参（避免过拟合），只报告当前阈值表现，
// 供用户醒来后决定是否调 TH 常量。
import fs from "node:fs";
import path from "node:path";
import { scanAll } from "./top-risk-engine";

interface ArchiveJson {
  days: Record<string, { tradeDate: string; allA: { medianChange: number | null }; industries: any[] }>;
}

export interface BacktestReport {
  ok: true;
  testDays: number;
  sectorDays: number;
  realTopEvents: number;
  flagged: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null; // flagged 中实际非顶部的比例（集 B）
  rankPrecision: number | null; // 每日风险 Top-N 中真顶部占比（扫描器排序可用性）
  stageDist: Record<string, number>;
  note: string;
}

export function runBacktest(): BacktestReport {
  const p = path.resolve(process.cwd(), "data", "sector-daily-snapshots.json");
  const a: ArchiveJson = JSON.parse(fs.readFileSync(p, "utf8"));
  const dates = Object.keys(a.days).sort();

  // 板块与全A的逐日中位涨跌幅
  const sectorDaily: Record<string, { date: string; mc: number }[]> = {};
  const marketDaily: Record<string, number> = {};
  for (const d of dates) {
    const day = a.days[d];
    marketDaily[d] = day.allA?.medianChange ?? 0;
    for (const ind of day.industries as any[]) {
      (sectorDaily[ind.name] ||= []).push({ date: d, mc: ind.medianChange ?? 0 });
    }
  }

  // 未来 20 日相对全A 超额（用日收益求和近似累计超额）
  const excess20 = (sector: string, atIdx: number): number | null => {
    if (atIdx + 20 >= dates.length) return null;
    const arr = sectorDaily[sector];
    if (!arr) return null;
    const map = new Map(arr.map((x) => [x.date, x.mc]));
    let sSec = 0;
    let sMkt = 0;
    for (let k = atIdx + 1; k <= atIdx + 20; k++) {
      const dd = dates[k];
      const m = map.get(dd);
      if (m == null) return null;
      sSec += m;
      sMkt += marketDaily[dd] ?? 0;
    }
    return sSec - sMkt;
  };

  // 测试窗口：需 >=20 日历史(前期涨幅) 且 留 20 日前瞻(标签)
  const lo = 20;
  const hi = dates.length - 21;
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0,
    realTop = 0,
    flagged = 0,
    sectorDays = 0;
  const stageDist: Record<string, number> = {};
  // 排名可用性：每交易日取风险最高的 Top-N，统计其中真顶部占比（扫描器实际价值）
  const TOPN = 15;
  let rankRealTop = 0;
  const rankTotal = (hi - lo + 1) * TOPN;

  for (let k = lo; k <= hi; k++) {
    const asOf = dates[k];
    const scan = scanAll(asOf);
    const riskOf = (r: { stage: string; midTop: number; trendDamage: number }) =>
      Math.max(r.midTop, r.trendDamage) + (r.stage === "趋势反转" ? 10 : 0);
    const ranked = [...scan.rows].sort((a, b) => riskOf(b) - riskOf(a));
    const topSet = new Set(ranked.slice(0, TOPN).map((r) => r.sector));
    for (const row of scan.rows) {
      sectorDays++;
      const ex = excess20(row.sector, k);
      if (ex == null) continue;
      const isRealTop = ex < -10; // 未来20日跑输全A >10pp
      const isFlag = row.stage === "趋势反转" || row.stage === "顶部形成中";
      stageDist[row.stage] = (stageDist[row.stage] ?? 0) + 1;
      if (isRealTop) realTop++;
      if (isFlag) flagged++;
      if (isFlag && isRealTop) tp++;
      else if (isFlag && !isRealTop) fp++;
      else if (!isFlag && isRealTop) fn++;
      else tn++;
    }
    // Top-N 真顶部命中
    for (const row of scan.rows) {
      if (!topSet.has(row.sector)) continue;
      const ex = excess20(row.sector, k);
      if (ex == null) continue;
      if (ex < -10) rankRealTop++;
    }
  }

  const precision = flagged ? tp / flagged : null;
  const recall = realTop ? tp / realTop : null;
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const falsePositiveRate = flagged ? fp / flagged : null;
  const rankPrecision = rankRealTop / rankTotal; // 每日 Top-15 中真顶部占比

  return {
    ok: true,
    testDays: hi - lo + 1,
    sectorDays,
    realTopEvents: realTop,
    flagged,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1,
    falsePositiveRate,
    rankPrecision,
    stageDist,
    note: `标签=未来20日相对全A超额<-10pp；测试窗口 ${lo}..${hi}（${hi - lo + 1} 交易日）。当前阈值为首版默认，precision/recall 供校准参考，非自动扫参。rankPrecision=每日风险Top-${TOPN}中真顶部占比（扫描器排序可用性）。`,
  };
}
