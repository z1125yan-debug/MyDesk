// 个股 → 所属行业 本地映射（服务端）。
//
// 为什么需要它：行业列的数据源本来是东财 push2 的 f100 字段，但东财榜单接口断源后，
// 兜底源（腾讯批量快照）**不提供行业字段**，于是结果表「行业」列整列为空。
// 这里用本地落档的映射表补上，避免该列长期空着。
//
// 数据来源：china-stock-mcp 的 get_stock_technical_rank（其返回含「所属行业」），
// 由 scripts 汇总 10 个形态榜落成 data/industry-map.json（当前覆盖 4281/5569 ≈ 77%）。
//
// 口径纪律：
// 1) 只读本地文件，不发上游请求——筛选是热路径，不能因为补一列而变慢；
// 2) 映射里没有的股票返回 null，前端显示「—」，**不猜、不按板块名硬编**；
// 3) 该映射是「快照式」的（生成于某一天），行业分类变动不频繁，可接受；
//    需要更新时重跑汇总脚本覆盖 data/industry-map.json 即可。
import fs from "fs";
import path from "path";

const MAP_FILE = path.join(process.cwd(), "data", "industry-map.json");

type IndustryMap = Record<string, string>;

let cache: IndustryMap | null = null;
let cacheMtime = 0;

function loadMap(): IndustryMap {
  try {
    if (!fs.existsSync(MAP_FILE)) return {};
    const st = fs.statSync(MAP_FILE);
    // 文件被重新生成时自动重载（按 mtime 判断，不用重启服务）
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const raw = JSON.parse(fs.readFileSync(MAP_FILE, "utf-8")) as IndustryMap;
    cache = raw && typeof raw === "object" ? raw : {};
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return {};
  }
}

/** 取股票所属行业；无映射返回 undefined（如实露缺，不编造） */
export function industryOf(symbol: string): string | undefined {
  const map = loadMap();
  // 映射表的键是 6 位代码（不带 .SH/.SZ/.BJ 后缀）
  const code = String(symbol ?? "").trim().split(".")[0];
  if (!code) return undefined;
  return map[code] ?? undefined;
}

/** 当前映射表规模（用于接口如实标注覆盖率） */
export function industryMapSize(): number {
  return Object.keys(loadMap()).length;
}
