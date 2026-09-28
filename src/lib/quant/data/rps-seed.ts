// 个股 → 行业 RPS 快照（服务端）。
//
// 背景：结果表「行业整体RPS_50/120、行业RPS_50/120」四列对应稳智的
// sector_rps_50 / sector_rps_120 / in_sector_rps_50 / in_sector_rps_120。
// 稳智对这四个指标有真实值，但其公式未公开；本地要算需「逐日板块指数历史 + 板块成分映射」，
// 现无该数据。故采用「种子 + 逐日递进」策略：
//   1) 用稳智鉴权接口 screen-stocks（支持 trade_date 历史）拉最近 50 个交易日的真值当种子；
//   2) 之后每个交易日增量追加（scripts/update_rps_seed.py）；
//   3) 本地只消费**最新交易日快照** data/rps-seed-latest.json。
//
// 口径纪律（与 industry-map.ts 一致）：
// 1) 只读本地文件，不发上游请求——筛选是热路径；
// 2) 没有该股票的记录 → 返回 undefined，前端显「—」，不猜、不补 0；
// 3) 快照式数据（生成于某交易日），页面须如实标注 trade_date，绝不冒充当日实时值。
import fs from "fs";
import path from "path";

const SEED_FILE = path.join(process.cwd(), "data", "rps-seed-latest.json");

export interface RpsSeedRow {
  symbol: string;
  name?: string;
  sector?: string;
  concept?: string;
  sector_rps_50?: number | null;
  sector_rps_120?: number | null;
  in_sector_rps_50?: number | null;
  in_sector_rps_120?: number | null;
}

interface SeedFile {
  trade_date: string;
  count?: number;
  rows: RpsSeedRow[];
}

let cache: Map<string, RpsSeedRow> | null = null;
let cacheMeta = { trade_date: "", mtimeMs: -1 };

function codeOf(symbol: string): string {
  return String(symbol ?? "").trim().split(".")[0];
}

function load(): Map<string, RpsSeedRow> {
  try {
    if (!fs.existsSync(SEED_FILE)) return new Map();
    const st = fs.statSync(SEED_FILE);
    if (cache && st.mtimeMs === cacheMeta.mtimeMs) return cache;
    const raw = JSON.parse(fs.readFileSync(SEED_FILE, "utf-8")) as SeedFile;
    const m = new Map<string, RpsSeedRow>();
    for (const r of raw?.rows ?? []) {
      const code = codeOf(r.symbol);
      if (code) m.set(code, r);
    }
    cache = m;
    cacheMeta = { trade_date: raw?.trade_date ?? "", mtimeMs: st.mtimeMs };
    return m;
  } catch {
    return new Map();
  }
}

/** 取股票的行业 RPS 快照；无记录返回 undefined（如实露缺，不编造） */
export function rpsSeedOf(symbol: string): RpsSeedRow | undefined {
  const code = codeOf(symbol);
  if (!code) return undefined;
  return load().get(code);
}

/** 当前种子快照所属交易日与规模（用于接口如实标注） */
export function rpsSeedMeta(): { trade_date: string; count: number } {
  const m = load();
  return { trade_date: cacheMeta.trade_date, count: m.size };
}

/**
 * 个股的「板块/概念」文本（用于稳智同款 `sector|concept like <关键词>` 选股条件）。
 * sector 是申万三级行业串（"银行-股份制银行Ⅱ-股份制银行Ⅲ"），concept 是顿号/逗号分隔的概念串。
 * 无记录返回 null（如实露缺，不编造）。
 */
export function sectorConceptOf(symbol: string): { sector: string; concept: string } | null {
  const r = rpsSeedOf(symbol);
  if (!r) return null;
  return { sector: r.sector ?? "", concept: r.concept ?? "" };
}

/** 该股的板块/概念文本是否命中关键词（大小写不敏感的子串匹配，对齐稳智 like 口径） */
export function sectorConceptMatches(symbol: string, keyword: string): boolean {
  const k = (keyword ?? "").trim();
  if (!k) return true; // 空关键词=不筛（与稳智「规整后为空则不加条件」一致）
  const sc = sectorConceptOf(symbol);
  if (!sc) return false; // 无板块/概念记录 → 不命中（不冒充命中）
  const hay = `${sc.sector} ${sc.concept}`.toLowerCase();
  return hay.includes(k.toLowerCase());
}

/**
 * 对齐稳智选股页对 `?sector=<名>` 参数的规整（源码实证：`StockScreener-D3IX2PmW.js` 的
 * `if(y.query.sector){ … const i=(d=>{ … })(e)||e; … }`）。稳智点板块名跳选股页时，
 * 传的是**原始板块名**，选股页在消费时把它规整成搜索关键词，规则逐字照搬：
 *   1) 去首尾空白；空 → 返回空串（选股页据此不加条件）；
 *   2) 含「·」→ 原样返回（复合名，如 "银行·股份制银行"）；
 *   3) 否则取**最长的字母数字段**，长度 ≥3 → 用它（如 "CPO概念" → "CPO"）；
 *   4) 否则去掉空白/标点，再去掉结尾的 (指数|板块|概念|产业链|主题)；
 *   5) 去掉后长度 ≥4 → 再砍掉**最后一个字**（稳智原样行为，如 "人工智能" → "人工智"）；
 *   6) 规整结果为空 → 回退原始入参（稳智的 `|| e`）。
 * 本地板块榜名多为纯中文（"银行""光伏设备"），走 4)/5) 分支；规整后交给 `sector_concept like`
 * 做子串匹配，与稳智「合并字段 + like」的命中口径保持一致。
 *
 * 实现落在 `screener/sector-keyword-core.ts`（纯核，客户端可安全 import）；此处 re-export，
 * 让既有从 rps-seed 取用的服务端调用点与测试不必改路径。
 */
export { normalizeSectorKeyword } from "../screener/sector-keyword-core.ts";
