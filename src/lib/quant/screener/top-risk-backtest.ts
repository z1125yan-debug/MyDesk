// Phase2 回测扩展（轻量，纯用已有 sector-daily-snapshots.json，不接外部数据）。
// 不改引擎、不改 TH、不改 v1 状态机、不做自动扫参。
//
// 标签定义（v5 §413 简化版，沿用）：在某交易日 T，板块「未来 H 交易日相对全A 超额收益 < -10pp」
// = 一次真实趋势破坏事件。引擎在 T 日判为「趋势反转 / 顶部形成中」= 发出预警（flagged）。
// 本文件在原 T+20 单档基础上扩展为 T+5 / T+10 / T+20 三档，并增加「09-28 半导体链真实事件专项」。
//
// 诚实边界：09-28 是归档末日，其 T+5/T+10/T+20 后续交易日尚未产生（国庆休市，10-09 开市后
// 15:20 自动填才有数据），专项如实标注 dataReady=false 与待补算日期，不猜测、不回填历史值。
import fs from "node:fs";
import path from "node:path";
import { scanAll } from "./top-risk-engine";

interface ArchiveJson {
  days: Record<string, { tradeDate: string; allA: { medianChange: number | null }; industries: any[] }>;
}

interface HorizonStat {
  H: number;
  threshold: number; // 未来 H 日超额 < threshold(pp) 判真实顶部
  testDays: number;
  realTopEvents: number;
  flagged: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null; // flagged 中实际非顶部的比例
  rankPrecision: number | null; // 每日风险 Top-N 中真顶部占比
}

interface SectorEventRow {
  sector: string;
  stage: string;
  excess5: number | null;
  excess10: number | null;
  excess20: number | null;
}

interface Event0928 {
  asOf: string;
  dataReady: boolean;
  pendingNote: string | null;
  sectors: SectorEventRow[];
}

export interface BacktestReport {
  ok: true;
  testDays: number;
  sectorDays: number;
  topN: number;
  byHorizon: HorizonStat[];
  event0928: Event0928;
  note: string;
}

const HORIZONS = [
  { H: 5, thr: -10 },
  { H: 10, thr: -10 },
  { H: 20, thr: -10 },
];
const MAXH = 20; // 统一前瞻窗口，保证三档都能算出标签
const TOPN = 15;
// 半导体链板块（按产业链与行情联动归类）
const SEMI_CHAIN = ["半导体", "通信设备", "元件", "电子化学品", "其他电子", "光学光电子", "消费电子"];

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

  // 未来 H 日相对全A 超额（用日收益求和近似累计超额）
  const excessN = (sector: string, atIdx: number, H: number): number | null => {
    if (atIdx + H >= dates.length) return null;
    const arr = sectorDaily[sector];
    if (!arr) return null;
    const map = new Map(arr.map((x) => [x.date, x.mc]));
    let sSec = 0;
    let sMkt = 0;
    for (let k = atIdx + 1; k <= atIdx + H; k++) {
      const dd = dates[k];
      const m = map.get(dd);
      if (m == null) return null;
      sSec += m;
      sMkt += marketDaily[dd] ?? 0;
    }
    return sSec - sMkt;
  };

  // 测试窗口：需 >=20 日历史(前期涨幅) 且 留 20 日前瞻(标签)；三档共用同一窗口
  const lo = 20;
  const hi = dates.length - 1 - MAXH;
  const thrByH: Record<number, number> = {};
  HORIZONS.forEach((h) => (thrByH[h.H] = h.thr));
  const acc: Record<number, { tp: number; fp: number; fn: number; tn: number; realTop: number; flagged: number; rankRealTop: number }> = {};
  HORIZONS.forEach((h) => (acc[h.H] = { tp: 0, fp: 0, fn: 0, tn: 0, realTop: 0, flagged: 0, rankRealTop: 0 }));
  let sectorDays = 0;

  for (let k = lo; k <= hi; k++) {
    const scan = scanAll(dates[k]);
    const riskOf = (r: { stage: string; midTop: number; trendDamage: number }) =>
      Math.max(r.midTop, r.trendDamage) + (r.stage === "趋势反转" ? 10 : 0);
    const ranked = [...scan.rows].sort((a, b) => riskOf(b) - riskOf(a));
    const topSet = new Set(ranked.slice(0, TOPN).map((r) => r.sector));
    for (const row of scan.rows) {
      sectorDays++;
      const isFlag = row.stage === "趋势反转" || row.stage === "顶部形成中";
      if (isFlag) HORIZONS.forEach((h) => acc[h.H].flagged++);
      for (const { H, thr } of HORIZONS) {
        const ex = excessN(row.sector, k, H);
        if (ex == null) continue;
        const isRealTop = ex < thr;
        if (isRealTop) acc[H].realTop++;
        if (isFlag && isRealTop) acc[H].tp++;
        else if (isFlag && !isRealTop) acc[H].fp++;
        else if (!isFlag && isRealTop) acc[H].fn++;
        else acc[H].tn++;
      }
    }
    // 排名可用性：每日 Top-N 中真顶部占比
    for (const { H } of HORIZONS) {
      const thr = thrByH[H];
      for (const row of scan.rows) {
        if (!topSet.has(row.sector)) continue;
        const ex = excessN(row.sector, k, H);
        if (ex == null) continue;
        if (ex < thr) acc[H].rankRealTop++;
      }
    }
  }

  const byHorizon: HorizonStat[] = HORIZONS.map(({ H, thr }) => {
    const c = acc[H];
    const rankTotal = (hi - lo + 1) * TOPN;
    const precision = c.flagged ? c.tp / c.flagged : null;
    const recall = c.realTop ? c.tp / c.realTop : null;
    const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    return {
      H,
      threshold: thr,
      testDays: hi - lo + 1,
      realTopEvents: c.realTop,
      flagged: c.flagged,
      tp: c.tp,
      fp: c.fp,
      fn: c.fn,
      tn: c.tn,
      precision,
      recall,
      f1,
      falsePositiveRate: c.flagged ? c.fp / c.flagged : null,
      rankPrecision: c.rankRealTop / rankTotal,
    };
  });

  // —— 09-28 半导体链真实事件专项 ——
  const asOf28 = dates.includes("2026-09-28") ? "2026-09-28" : null;
  let event0928: Event0928 = { asOf: "2026-09-28", dataReady: false, pendingNote: null, sectors: [] };
  if (asOf28) {
    const k28 = dates.indexOf(asOf28);
    const dataReady = k28 + MAXH < dates.length; // 有完整 20 日前瞻才算得出
    const scan = scanAll(asOf28);
    const sectors: SectorEventRow[] = SEMI_CHAIN.map((name) => {
      const row = scan.rows.find((r) => r.sector === name);
      return {
        sector: name,
        stage: row ? row.stage : "未覆盖",
        excess5: excessN(name, k28, 5),
        excess10: excessN(name, k28, 10),
        excess20: excessN(name, k28, 20),
      };
    }).filter((s) => s.stage !== "未覆盖");
    event0928 = {
      asOf: asOf28,
      dataReady,
      pendingNote: dataReady
        ? null
        : `后续交易日数据未就绪（归档末日 ${dates[dates.length - 1]}）。国庆 10-01~10-08 休市，10-09 开市后 15:20 自动填，T+5≈10-13 / T+10≈10-20 / T+20≈10-27 收盘后重跑本接口即得真实值。`,
      sectors,
    };
  }

  return {
    ok: true,
    testDays: hi - lo + 1,
    sectorDays,
    topN: TOPN,
    byHorizon,
    event0928,
    note: `标签=未来 H 日相对全A超额<-10pp；测试窗口 ${lo}..${hi}（${hi - lo + 1} 交易日，统一留 20 日前瞻保证三档可比）。当前阈值为 v1 封版默认，precision/recall/rankPrecision 供校准参考，非自动扫参。rankPrecision=每日风险Top-${TOPN}中真顶部占比（扫描器排序可用性）。`,
  };
}
