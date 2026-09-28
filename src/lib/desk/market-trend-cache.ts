// 大盘趋势快照缓存（服务端本地留档）
//
// 为什么需要：成交额/指数序列的主源是本机 eltdx 通达信网关（127.0.0.1:8756）。
// 网关是手动启动的进程，一旦没起来，接口就降级到腾讯备源 —— 而腾讯日K**不含成交额**，
// 于是「大盘成交额趋势」图只剩当日一根柱、指数序列也缺读数，用户看到的就是「数据没了」。
//
// 有了这个缓存：只要**当天成功取到过一次完整数据**，之后无论网关是否在跑，
// 打开页面都能直接读缓存看到同样的图，不再依赖网关是否存活。
//
// 口径纪律：
// 1) 按「数据实际所属交易日」存（quoteDate），一天一份 —— 同一天重复写入覆盖，不堆重复；
// 2) 只缓存**完整**结果（成交额序列有效根数 ≥ MIN_USABLE_DAYS），半截数据不覆盖好的缓存；
// 3) 读失败/文件损坏一律当「无缓存」返回，绝不让页面因此报错；
// 4) 返回时带 cached/cachedAt 标记，前端据此如实显示「本页数据来自本地缓存」。
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "market-trend-cache.json");
/** 保留最近多少份（一天一份，30 份 ≈ 一个月） */
const MAX_KEEP = 30;
/** 成交额序列至少要有这么多根有效柱，才算「完整数据」值得缓存 */
export const MIN_USABLE_DAYS = 5;

export interface TrendSnapshot {
  /** 数据实际所属交易日（北京时间 YYYY-MM-DD）—— 一天一份的自然键 */
  tradeDate: string;
  /** 落档时刻（ISO 串） */
  cachedAt: string;
  /** 接口的完整响应体（原样存，回放时直接返回，避免字段漂移） */
  payload: unknown;
}

interface StoreShape {
  snapshots: TrendSnapshot[];
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_FILE)) return { snapshots: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as StoreShape;
    if (!parsed || !Array.isArray(parsed.snapshots)) return { snapshots: [] };
    // 只保留结构完整的记录，脏数据跳过（不因一条坏记录让整页读不出）
    return { snapshots: parsed.snapshots.filter((s) => s && typeof s.tradeDate === "string" && s.payload) };
  } catch {
    return { snapshots: [] };
  }
}

function writeStore(store: StoreShape): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // 先写临时文件再改名：避免写一半被读到（原子替换）
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  fs.renameSync(tmp, STORE_FILE);
}

/** 存一份快照（同一天覆盖） */
export function saveTrendSnapshot(tradeDate: string, payload: unknown): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`tradeDate 格式非法：${tradeDate}`);
  const store = readStore();
  const rec: TrendSnapshot = { tradeDate, cachedAt: new Date().toISOString(), payload };
  const others = store.snapshots.filter((s) => s.tradeDate !== tradeDate);
  const next = [rec, ...others].sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1)).slice(0, MAX_KEEP);
  writeStore({ snapshots: next });
}

/** 取某天的快照；不传则取最新的一份 */
export function getTrendSnapshot(tradeDate?: string): TrendSnapshot | null {
  const { snapshots } = readStore();
  if (!snapshots.length) return null;
  if (tradeDate) return snapshots.find((s) => s.tradeDate === tradeDate) ?? null;
  return [...snapshots].sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1))[0] ?? null;
}

/** 列出已缓存的交易日（倒序），供排查用 */
export function listTrendSnapshotDates(): string[] {
  return readStore().snapshots.map((s) => s.tradeDate).sort((a, b) => (a < b ? 1 : -1));
}

/**
 * 从响应体里数出成交额序列的有效根数 —— 用于判断「这份数据是否完整到值得缓存」。
 * 半截数据（比如网关没起来时的 1 根）不该覆盖掉已有的完整缓存。
 */
export function countTurnoverDays(payload: unknown): number {
  const days = (payload as { days?: { totalYi?: number | null }[] } | null)?.days;
  if (!Array.isArray(days)) return 0;
  return days.filter((d) => typeof d?.totalYi === "number" && Number.isFinite(d.totalYi)).length;
}
