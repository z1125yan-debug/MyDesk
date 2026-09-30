/**
 * 板块均线广度纯核（无 IO，可单测）。
 *
 * 为什么要有它：推荐问题卡模板承诺「均线广度占比」（suggestion-cards-core 的问法模板），
 * 但取数工具链里从来没有这个指标——模型只能写「暂无均线广度统计」（2026-09-30 用户截图事故）。
 * 数据本地全有（行业成分快照 × stock_daily_close 收盘价），缺的只是这一步计算。
 *
 * 口径：
 * - 「站上 MA-N」= 最新收盘价 ≥ N 日简单均线（含等于）；
 * - 样本不足 N 根或窗口内有非有限值 → null（「算不出」≠「没站上」，不许把 0 根K线算成 0%）；
 * - 占比分母 = **有判定的家数**（K线不足的票从分母剔除，并如实报出剔除几只），
 *   不拿「成分股总数」当分母冒充（那会把缺数据的票算成「没站上」）。
 */

export interface SymCloses {
  symbol: string;
  closes: number[];
}

export interface SymVerdict {
  symbol: string;
  aboveMa5: boolean | null;
  aboveMa10: boolean | null;
  aboveMa20: boolean | null;
}

/** N 日简单均线；样本不足或含非有限值 → null */
export function maOf(closes: number[], n: number): number | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  if (closes.length < n) return null;
  const win = closes.slice(-n);
  let sum = 0;
  for (const v of win) {
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / n;
}

/** 最新收盘是否站上 N 日线；算不出 → null */
export function aboveMa(closes: number[], n: number): boolean | null {
  if (closes.length < n) return null;
  const ma = maOf(closes, n);
  const last = closes[closes.length - 1];
  if (ma == null || !Number.isFinite(last)) return null;
  return last >= ma;
}

export function verdictOf(row: SymCloses): SymVerdict {
  return {
    symbol: row.symbol,
    aboveMa5: aboveMa(row.closes, 5),
    aboveMa10: aboveMa(row.closes, 10),
    aboveMa20: aboveMa(row.closes, 20),
  };
}

export interface BreadthSummary {
  /** 有K线参与判定的家数 */
  n: number;
  /** K线不足被剔除的家数（如实报，不冒充 0%） */
  skipped: number;
  aboveMa5Pct: number | null;
  aboveMa10Pct: number | null;
  aboveMa20Pct: number | null;
  /** 分母（有判定的家数），与 n 相同，方便直接引用 */
  denomMa5: number;
  denomMa10: number;
  denomMa20: number;
}

function pct(hits: number, denom: number): number | null {
  if (denom <= 0) return null;
  return Math.round((hits / denom) * 1000) / 10;
}

export function summarizeBreadth(rows: SymCloses[]): BreadthSummary {
  const verdicts = rows.map(verdictOf);
  const judge = (k: keyof Omit<SymVerdict, "symbol">): { hits: number; denom: number } => {
    let hits = 0;
    let denom = 0;
    for (const v of verdicts) {
      const x = v[k];
      if (x == null) continue;
      denom += 1;
      if (x) hits += 1;
    }
    return { hits, denom };
  };
  const m5 = judge("aboveMa5");
  const m10 = judge("aboveMa10");
  const m20 = judge("aboveMa20");
  return {
    n: verdicts.length,
    skipped: verdicts.filter((v) => v.aboveMa5 == null && v.aboveMa10 == null && v.aboveMa20 == null).length,
    aboveMa5Pct: pct(m5.hits, m5.denom),
    aboveMa10Pct: pct(m10.hits, m10.denom),
    aboveMa20Pct: pct(m20.hits, m20.denom),
    denomMa5: m5.denom,
    denomMa10: m10.denom,
    denomMa20: m20.denom,
  };
}
