// 行业页的两列「排名变化 / 涨停家数」—— 本地真值，不造数
//
// 为什么单独一个文件：这两列的口径各自牵着一份数据源，混进行业榜接口里就没人说得清出处。
//
// ① 涨停家数（板块内涨停家数）
//    源 = 本地涨停池（computeLimitUp，含首板/连板全量）+ 本地行业映射 data/industry-map.json
//    （4281 只股票 → 申万行业名，与同花顺行业榜的 89 个行业名实测 89/89 对得上）。
//    算法：涨停股代码 → 行业名 → 按行业计数。映射里没有的票单独计 unmapped，
//    不摊进任何行业 —— 摊进去就是拿一个猜的行业冒充事实。
//
// ② 排名变化（较上一交易日）
//    源 = 本地板块快照 data/sector-snapshots.json：每次行业榜算完按 tradeDate 留一份
//    （code/name/涨幅/主力净额/排名）。下一交易日再算时取上一份对比出 Δ排名。
//    没有上一份（首次留档当天）就如实返回 null，页面显「—」，不编一个 0。
//    这是稳智 /sectors 那一列的口径：上一交易日排名 − 今日排名，正=名次前进。
//
// 留档纪律（照抄 risk/theme snapshot 那三张表的规矩）：
//   同一天允许多次留档（盘中/收盘各一次都是真实结果），不覆盖；
//   只留真实算出来的行，空榜不留（留了就是拿空榜冒充「当日无板块」）。

import fs from "node:fs";
import path from "node:path";
import { computeLimitUp } from "@/lib/quant/screener/limitup";

const DATA_DIR = path.join(process.cwd(), "data");
const MAP_PATH = path.join(DATA_DIR, "industry-map.json");
const SNAP_PATH = path.join(DATA_DIR, "sector-snapshots.json");

export interface SectorSnapshotRow {
  code: string;
  name: string;
  changePct: number | null;
  main: number | null;
  rank: number;
}
export interface SectorSnapshot {
  tradeDate: string;
  computedAt: string;
  kind: "industry" | "concept";
  rows: SectorSnapshotRow[];
}

type SnapshotFile = { days: Record<string, SectorSnapshot> };

function readMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync(MAP_PATH, "utf8");
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function readSnapshots(): SnapshotFile {
  try {
    const j = JSON.parse(fs.readFileSync(SNAP_PATH, "utf8")) as SnapshotFile;
    return j && typeof j.days === "object" ? j : { days: {} };
  } catch {
    return { days: {} };
  }
}

/** 板块当日排名留档（同一天多次调用按分钟各留一条，不覆盖） */
export function saveSectorSnapshot(tradeDate: string, kind: "industry" | "concept", rows: SectorSnapshotRow[]): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !rows.length) return; // 空榜不留：留了就是拿空榜冒充「当日无板块」
  try {
    const file = readSnapshots();
    const computedAt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date()).replace(", ", " ");
    // 同一天同一 kind 只留最新一份：这一天这份榜单本来就是同一个口径的重复计算，
    // 留多份只会让「取上一交易日」时撞到同一天的盘中旧值。
    file.days[`${tradeDate}|${kind}`] = { tradeDate, computedAt, kind, rows };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAP_PATH, JSON.stringify(file, null, 2), "utf8");
  } catch {
    /* 写盘失败不影响榜单本身：这两列是增强，不是榜单的存活条件 */
  }
}

/** 取不早于某日之前的最近一份快照（休市日/没留档的日子自动往前退） */
export function loadPrevSnapshot(beforeDate: string, kind: "industry" | "concept"): SectorSnapshot | null {
  const file = readSnapshots();
  const key = (d: string) => `${d}|${kind}`;
  const pres = Object.values(file.days)
    .filter((s) => s.kind === kind && s.tradeDate < beforeDate && s.rows.length)
    .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  void key;
  return pres[0] ?? null;
}

/**
 * 排名变化：上一交易日名次 − 今日名次（正 = 名次前进，如 +3 表示从第 8 升到第 5）。
 * 上一交易日没这份板块（新进榜/没留档）→ null，页面显「—」，不编 0。
 */
export function rankChangeMap(
  prev: SectorSnapshot | null,
  byName: boolean = false,
): Map<string, number> {
  const m = new Map<string, number>();
  if (!prev) return m;
  for (const r of prev.rows) m.set(byName ? r.name : r.code, r.rank);
  return m;
}

export interface LimitUpByIndustry {
  counts: Record<string, number>;
  /** 涨停池里没进映射的只数（不摊进行业，页面可查） */
  unmapped: number;
  total: number;
  tradeDate: string | null;
}

/**
 * 按行业统计涨停家数。涨停池取不到 / 映射读不出来 → counts 为空且 total=0，
 * 调用方据此显「—」，绝不用涨跌幅倒推涨停家数。
 */
export async function limitUpCountsByIndustry(): Promise<LimitUpByIndustry> {
  const empty: LimitUpByIndustry = { counts: {}, unmapped: 0, total: 0, tradeDate: null };
  const map = readMap();
  if (!Object.keys(map).length) return empty;
  let pool: { tiers?: { stocks?: { symbol?: string }[] }[]; trade_date?: string };
  try {
    pool = (await computeLimitUp()) as typeof pool;
  } catch {
    return empty;
  }
  const counts: Record<string, number> = {};
  let unmapped = 0;
  let total = 0;
  const seen = new Set<string>();
  for (const tier of pool.tiers ?? []) {
    for (const s of tier.stocks ?? []) {
      const sym = String(s.symbol ?? "");
      if (!sym || seen.has(sym)) continue; // 同一只票可能跨梯队出现，只数一次
      seen.add(sym);
      total += 1;
      const code = sym.split(".")[0];
      const ind = map[code];
      if (!ind) { unmapped += 1; continue; }
      counts[ind] = (counts[ind] ?? 0) + 1;
    }
  }
  return { counts, unmapped, total, tradeDate: pool.trade_date ?? null };
}
