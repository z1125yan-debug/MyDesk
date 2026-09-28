// 稳智「我的策略」社区策略库（服务端，只读）。
//
// 来源：稳智 aiwuchuan.com 的 GET /api/strategies/?include_content=1（721 条，含筛选条件），
// 由 scripts/pull_strategies.py 抓取、scripts/map_strategies.py 把条件字段映射为 MyDesk 因子 key，
// 落盘 data/strategies.json。字段/单位映射见该脚本注释（宁缺勿假：不确定的不硬猜，记入 unmapped）。
//
// 口径纪律：
// 1) 只读本地文件，不发上游请求；
// 2) 策略条件里的字段都是 MyDesk 因子 key（已映射），未映射的条件如实放在 unmapped 里；
// 3) 数据是「某日快照」，社区策略会随时间变化；更新时重跑抓取+映射脚本覆盖本文件。
import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "strategies.json");

export interface StrategyCond {
  field: string;
  op: string;
  value: number | string | (number | string)[];
  type?: "single" | "rolling_return" | "rolling_sum" | "rolling_any";
  window?: number;
  min_match_days?: number;
}

export interface LibraryStrategy {
  id: number;
  name: string;
  owner?: string;
  like?: number;
  dislike?: number;
  vote?: number;
  conds: StrategyCond[];
  unmapped?: { raw: Record<string, unknown>; reason: string }[];
  approx?: string[];
  n_total: number;
  n_mapped: number;
  backtest_params?: Record<string, unknown> | null;
}

interface FileShape {
  source?: string;
  count?: number;
  data?: LibraryStrategy[];
}

let cache: LibraryStrategy[] | null = null;
let cacheMeta = { source: "", mtimeMs: -1 };

function load(): LibraryStrategy[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const st = fs.statSync(FILE);
    if (cache && st.mtimeMs === cacheMeta.mtimeMs) return cache;
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")) as FileShape;
    cache = Array.isArray(raw?.data) ? raw.data : [];
    cacheMeta = { source: raw?.source ?? "", mtimeMs: st.mtimeMs };
    return cache;
  } catch {
    return [];
  }
}

/** 全部社区策略（按热度降序：投票分 → 点赞数） */
export function strategyLibrary(): LibraryStrategy[] {
  const list = load();
  return [...list].sort((a, b) => (b.vote ?? 0) - (a.vote ?? 0) || (b.like ?? 0) - (a.like ?? 0));
}

export function strategyLibraryMeta(): { count: number; source: string } {
  const list = load();
  return { count: list.length, source: cacheMeta.source };
}
