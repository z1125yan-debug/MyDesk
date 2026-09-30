// B0 日K落库纯核（2026-09-30）
//
// 为什么单独抽一层：落库是一锤子买卖，字段口径错了要重跑 5577 只，
// 所以「网关原始行 → 入库行」的每一步都必须能单测，不能埋在脚本里。
//
// 三条写死的口径：
// 1) 只存行情源真给的字段。open/high/low/close 任一非有限 → 整行丢弃（不补 0、不拿前一日顶替）；
// 2) volume 单位=股（网关 volume_lots 是手，×100）；amount 单位=元。
//    实测校验：sz000001 2026-09-30 amount=12.06 亿 / (1045357.44 手 × 100) = 11.54 元/股 ≈ 收盘 11.57 ✓
// 3) 停牌日 volume/amount 可以是 0，0 是真实值不是缺失——只有价格缺失才丢行。

export type Adjust = "qfq";

export interface RawBar {
  time?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume_lots?: number;
  volume_wire_value?: number;
  amount?: number;
}

export interface DailyBarRow {
  symbol: string;
  tradeDate: string;
  adjust: Adjust;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 股
  amount: number; // 元
  batch: string;
}

/** 网关全码 → MyDesk 符号：sz300308 → 300308.SZ；认不出返回 null（不许猜） */
export function toSymbol(full: string): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(String(full ?? "").trim().toLowerCase());
  if (!m) return null;
  return `${m[2]}.${m[1].toUpperCase()}`;
}

/** MyDesk 符号 → 网关全码：300308.SZ → sz300308 */
export function toTdxCode(symbol: string): string | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(String(symbol ?? "").trim().toUpperCase());
  if (!m) return null;
  return m[2].toLowerCase() + m[1];
}

/** A 股交易日的粗糙校验（只挡明显坏值；真节假日以行情源给的日期为准，本地不另判） */
function isDateLike(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, dd] = d.split("-").map(Number);
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && dd >= 1 && dd <= 31;
}

/**
 * 网关原始 K 线行 → 入库行。任一价格字段非法 → 返回 null（调用方计数丢弃，不落库）。
 * 注意：不在这里做复权、不做涨跌停判断——粮仓只负责如实存，算法层另算。
 */
export function barRowOf(b: RawBar | null | undefined, symbol: string, batch: string): DailyBarRow | null {
  if (!b) return null;
  const tradeDate = String(b.time ?? "").slice(0, 10);
  if (!isDateLike(tradeDate)) return null;
  const { open, high, low, close } = b;
  for (const v of [open, high, low, close]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  if (!(close! > 0)) return null; // 收盘价 ≤ 0 是坏行
  // 量：优先 volume_lots（手），退 volume_wire_value/100（也是手口径），都没有就记 0
  const lots = Number.isFinite(b.volume_lots as number)
    ? (b.volume_lots as number)
    : Number.isFinite(b.volume_wire_value as number)
      ? (b.volume_wire_value as number) / 100
      : NaN;
  const volume = Number.isFinite(lots) && lots > 0 ? Math.round(lots * 100) : 0;
  const amount = Number.isFinite(b.amount as number) && (b.amount as number) > 0 ? (b.amount as number) : 0;
  return {
    symbol,
    tradeDate,
    adjust: "qfq",
    open: open as number,
    high: high as number,
    low: low as number,
    close: close as number,
    volume,
    amount,
    batch,
  };
}

/**
 * 一批原始 K 线 → 入库行数组（升序按日期）。坏行直接丢，返回值里不含 null。
 * 为什么在核里去重：同一天网关偶发重复给两根（实测未见，但复权切换时可能），
 * 不去重会让复合主键插入互相覆盖，最后留下哪根取决于顺序——不可复现。
 */
export function barRowsOf(bars: readonly RawBar[] | null | undefined, symbol: string, batch: string): DailyBarRow[] {
  if (!Array.isArray(bars)) return [];
  const byDate = new Map<string, DailyBarRow>();
  for (const b of bars) {
    const row = barRowOf(b, symbol, batch);
    if (!row) continue;
    byDate.set(row.tradeDate, row); // 同日后者覆盖前者，但去重后只剩一行，顺序无关
  }
  return [...byDate.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

/** 批次号：20260930-1625-qfq800（本地时间；同一批数据出身可追溯） */
export function batchIdOf(now: Date, adjust: Adjust, bars: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${stamp}-${adjust}${bars}`;
}
