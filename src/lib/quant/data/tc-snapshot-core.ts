// 腾讯批量快照兜底 — 纯解析核（零 IO、零时钟，node --test 可直跑）
// 背景：东财 push2 集群（clist/fflow/kline）可能对出口 IP 断连（2026-09-22 实测全局性 RemoteDisconnected），
// 而腾讯 qt.gtimg.cn 批量行情与 proxy.finance.qq.com 板块榜仍可用。本模块只做「文本 → 结构」的纯解析，
// 抓取与编排在 tc-universe.ts / desk/em.ts。字段口径以 2026-09-22 真机实测为准（88 字段，北交所 87）。

import type { AssetMeta } from "../types.ts";

// ---------- 符号 ↔ 腾讯代码 ----------

export function symbolToTcCode(symbol: string): string | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbol.trim().toUpperCase());
  return m ? `${m[2].toLowerCase()}${m[1]}` : null;
}

export function tcCodeToSymbol(tc: string): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(tc.trim().toLowerCase());
  if (!m) return null;
  return `${m[2]}.${m[1].toUpperCase()}`;
}

// ---------- 批量报价文本 ----------

/** 把一段 GBK 解码后的 qt.gtimg.cn 响应切成 v_xx="..." 映射（键为 sh688256 这类腾讯代码） */
export function splitTcQuoteText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(";")) {
    const m = /v_((?:sh|sz|bj)\d{6})="([^"]*)"/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

function numOr(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

/**
 * 单行报价（引号内的 ~ 分隔串）→ AssetMeta。
 * 实测字段：f1名称 f3现价 f4昨收 f32涨跌% f33最高 f34最低 f36量(手) f37额(万)
 *           f38换手% f39PE f43振幅 f44流通市值(亿) f45总市值(亿) f46PB f49量比
 * 现价 ≤0（停牌/未开盘回 0.00）→ 保留字段但标 suspended，价格记 undefined（与东财快照口径一致：
 * rowToMeta 里「无价 = 当日停牌/无成交」，sentiment 的统计循环按 price===undefined 跳过）。
 */
export function parseTcQuoteBody(tcCode: string, body: string): AssetMeta | null {
  const symbol = tcCodeToSymbol(tcCode);
  if (!symbol) return null;
  const f = body.split("~");
  if (f.length < 50) return null;
  const name = (f[1] ?? "").trim() || symbol;
  const price = numOr(f[3]);
  const changePct = numOr(f[32]);
  const amountWan = numOr(f[37]);
  const floatYi = numOr(f[44]);
  const totalYi = numOr(f[45]);
  const volumeHand = numOr(f[36]);
  // f[30] 是行情数据时间戳（形如 20260924161430）——用它标出「这份快照属于哪个交易日」。
  // 休市日（周末/节假日）上游仍返回上一交易日的快照，若不记录该日期，上层会把数据标成「今天」。
  const stamp = (f[30] ?? "").trim();
  const quoteDate = /^\d{8}/.test(stamp) ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : undefined;
  const meta: AssetMeta = {
    symbol,
    name,
    st: /ST/i.test(name),
    price: price !== null && price > 0 ? price : undefined,
    changePct: price !== null && price > 0 ? (changePct ?? undefined) : undefined,
    prevClose: numOr(f[4]) ?? undefined,
    high: numOr(f[33]) ?? undefined,
    volume: volumeHand !== null ? volumeHand * 100 : undefined, // 手 → 股（与东财口径换算一致）
    amount: amountWan !== null ? amountWan * 1e4 : undefined, // 万元 → 元
    turnover: numOr(f[38]) ?? undefined,
    pe: numOr(f[39]) ?? undefined,
    amplitude: numOr(f[43]) ?? undefined,
    floatCap: floatYi !== null ? floatYi * 1e8 : undefined, // 亿 → 元
    marketCap: totalYi !== null ? totalYi * 1e8 : undefined,
    pb: numOr(f[46]) ?? undefined,
    volumeRatio: numOr(f[49]) ?? undefined,
    suspended: price === null || price <= 0,
    quoteDate,
    // mainNet / listDate / industry：腾讯批量快照不提供 → 留空，由上层「家数登记」口径显式露缺
  };
  return meta;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size 必须 ≥1");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- 板块榜（proxy.finance.qq.com mktHs/rank）----------

export interface TcBoardLite {
  code: string;
  name: string;
  changePct: number;
  leader: string;
  /** 兜底榜只有涨幅口径，没有主力净额/净占比/超大单/大单 —— 必须带着这个标记往下走，页面据此显示「—」 */
  fundsMissing: true;
}

/** 单条板块 JSON → 精简行；缺名或缺涨幅返回 null（宁缺勿造） */
export function parseTcBoardRow(r: Record<string, unknown>): TcBoardLite | null {
  const name = String(r.bd_name ?? "").trim();
  const code = String(r.bd_code ?? "").trim();
  const pct = numOr(typeof r.bd_zdf === "number" ? String(r.bd_zdf) : (r.bd_zdf as string | undefined));
  if (!name || !code || pct === null) return null;
  return { code, name, changePct: pct, leader: String(r.nzg_name ?? "").trim(), fundsMissing: true };
}

/** 榜单整体解析 + 按方向排序（in=涨幅榜 / out=跌幅榜），并去重 */
export function parseTcBoardRankList(rows: Record<string, unknown>[], dir: "in" | "out"): TcBoardLite[] {
  const out: TcBoardLite[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const b = parseTcBoardRow(r);
    if (!b || seen.has(b.code)) continue;
    seen.add(b.code);
    out.push(b);
  }
  out.sort((a, b) => (dir === "in" ? b.changePct - a.changePct : a.changePct - b.changePct));
  return out;
}
