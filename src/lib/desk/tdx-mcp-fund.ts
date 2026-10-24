// TDX MCP 财务数据（仅服务端）
//
// 来源：eltdx（即 TDX MCP 服务端的底层库）经本机 eltdx-http 网关（127.0.0.1:8756）
// 暴露的两个方法，与行情网关同一条链路，不新增服务、不动 .env：
//   - corporate.finance_batch（7709 批量财务，0x0010）：流通股本/总股本/每股净资产/
//     净资产/营收/净利润/更新日，一次 RPC 可拉多只，快（实测 2 只 0.9s）
//   - f10.valuation（7615 F10 估值表，HQServ.hq_nlp_gpsj）：PE(TTM)/PB(MRQ)/
//     总市值/流通市值，逐只拉，慢（实测 ~11s/只，并发可并行），只用于候选池
//
// 口径（诚实标注，不编造）：
//   - 7709 finance_batch 的 EPS 是最新报告期 EPS（如 2026-08-15 更新的半年报 EPS），
//     不是 TTM EPS——故 PE 不从 7709 EPS 推导，PE 只取 F10 PETTM。
//   - PB = 现价 / 每股净资产（7709 mei_gu_jing_zi_chan），实测与 F10 PBMRQ 一致
//     （茅台 1312.97/200.99=6.53；平安 11.41/24.13=0.47）。
//   - 总市值 = 现价 × 总股本；流通市值 = 现价 × 流通股本（股本单位：万股→×1e4）。
//     实测与 F10 AVGMVM/ALIQMV 一致（茅台 1.641 万亿；平安 2214 亿）。
//   - 营收/净利润/ROE：最新报告期数（非年化），ROE = 净利润/净资产（报告期口径）。
//   - 换手率 = 当日成交量(股) / 流通股本(股) ×100，需调用方传入当日成交量。
//   - 量比不在 TDX MCP 里：tdx-db-universe 用本地库 5 日均量推导（DB 口径，注释里标注）。
//   - 失败/无数据 → 返回 null，调用方保持 undefined（缺就是缺，不编 0）。

import type { AssetMeta } from "@/lib/quant/types";

const GW = process.env.TDX_GATEWAY ?? "http://127.0.0.1:8756";

const FUND_BATCH = 200; // finance_batch 分批大小
const FUND_CONC = 2; // 与 tdx.ts 一致：网关仅 2 连接
const PE_BATCH_LIMIT = 30; // F10 估值只用于候选池，上限 30 只
const PE_CONC = 5; // F10 并发实测：3 只并行 11s 完成，可并行
const VALUATION_TTL_MS = 24 * 3600_000; // F10 估值按日更新，缓存 24h

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** MyDesk 符号 → TDX 全码：600519.SH → sh600519；000001.SZ → sz000001；920001.BJ → bj920001 */
export function toTdxCode(symbol: string): string | null {
  const m = /^(\\d{6})\\.(SH|SZ|BJ)$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  return m[2].toLowerCase() + m[1];
}

async function gwRpc<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GW}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, method, params }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const j = (await res.json()) as { ok?: boolean; result?: T };
    if (!res.ok || !j.ok) return null;
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 7709 finance_batch ----------

export interface TdxFundRow {
  symbol: string; // 600519.SH
  totalShares: number; // 总股本（股）
  floatShares: number; // 流通股本（股）
  netAssets: number; // 净资产（元，最新报告期）
  netAssetsPerShare: number; // 每股净资产（元）
  revenue: number; // 主营收入/营业收入（元，最新报告期）
  netProfit: number; // 税后利润/净利润（元，最新报告期）
  epsPeriod: number; // 最新报告期 EPS（元，非 TTM，不用于推导 PE）
  updatedDate: string; // 财务更新日 YYYY-MM-DD
}

interface FinanceBatchResult {
  records?: Array<Record<string, unknown>>;
}

const numOr = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * 批量拉 7709 财务（finance_batch）。chunk 200、并发 2。
 * 失败的只返回 Map 里没有该代码（调用方保持 undefined），不抛错。
 */
export async function fetchTdxFundBatch(symbols: string[]): Promise<Map<string, TdxFundRow>> {
  const out = new Map<string, TdxFundRow>();
  const pairs = symbols
    .map((s) => ({ symbol: s.toUpperCase(), code: toTdxCode(s) }))
    .filter((p): p is { symbol: string; code: string } => p.code !== null);
  if (!pairs.length) return out;
  const groups = chunk(pairs, FUND_BATCH);
  for (let i = 0; i < groups.length; i += FUND_CONC) {
    const wave = groups.slice(i, i + FUND_CONC);
    const results = await Promise.allSettled(
      wave.map((g) =>
        gwRpc<FinanceBatchResult>("corporate.finance_batch", { codes: g.map((p) => p.code) }, 30_000),
      ),
    );
    wave.forEach((g, wi) => {
      const r = results[wi];
      if (r.status !== "fulfilled" || !r.value?.records) return;
      const byCode = new Map(g.map((p) => [p.code, p.symbol]));
      for (const rec of r.value.records) {
        const code = String(rec.code ?? "");
        const symbol = byCode.get(code);
        if (!symbol) continue;
        // 股本：万股 → 股（×1e4）；资产/收入/利润：千元 → 元（×1e3）
        const totalWan = numOr(rec.zong_gu_ben_raw_float);
        const floatWan = numOr(rec.liu_tong_gu_ben_raw_float);
        const netAssetsK = numOr(rec.jing_zi_chan_raw_float);
        const naps = numOr(rec.mei_gu_jing_zi_chan_raw_float);
        const revenueK = numOr(rec.zhu_ying_shou_ru_raw_float);
        const profitK = numOr(rec.shui_hou_li_run_raw_float);
        const eps = numOr(rec.eps_raw);
        if (totalWan == null || floatWan == null || netAssetsK == null || naps == null) continue;
        if (totalWan <= 0 || floatWan <= 0 || naps <= 0) continue;
        out.set(symbol, {
          symbol,
          totalShares: totalWan * 1e4,
          floatShares: floatWan * 1e4,
          netAssets: netAssetsK * 1e3,
          netAssetsPerShare: naps,
          revenue: revenueK != null ? revenueK * 1e3 : 0,
          netProfit: profitK != null ? profitK * 1e3 : 0,
          epsPeriod: eps ?? 0,
          updatedDate: typeof rec.updated_date === "string" ? rec.updated_date : "",
        });
      }
    });
  }
  return out;
}

// ---------- 7615 F10 valuation（PE 用） ----------

export interface TdxValuationRow {
  symbol: string;
  pe: number; // PETTM（TTM 市盈率，负值=亏损，原样返回不钳制）
  pb: number; // PBMRQ（市净率）
  marketCap: number; // AVGMVM 总市值（元）
  floatCap: number; // ALIQMV 流通市值（元）
  date: string; // DATE（YYYYMMDD）
}

interface ValuationResult {
  result_sets?: Array<{ key?: string; rows?: Array<Record<string, unknown>> }>;
}

const valuationCache = new Map<string, { at: number; row: TdxValuationRow | null }>();

export async function fetchTdxValuation(symbol: string): Promise<TdxValuationRow | null> {
  const key = symbol.toUpperCase();
  const hit = valuationCache.get(key);
  if (hit && Date.now() - hit.at < VALUATION_TTL_MS) return hit.row;
  const code = toTdxCode(key);
  if (!code) return null;
  const res = await gwRpc<ValuationResult>("f10.valuation", { code }, 30_000);
  const rows = res?.result_sets?.find((t) => t.key === "table1")?.rows ?? [];
  // 取最新 DATE 的行
  let best: Record<string, unknown> | null = null;
  for (const row of rows) {
    const d = String(row.DATE ?? "");
    if (!/^\\d{8}$/.test(d)) continue;
    if (!best || d > String(best.DATE ?? "")) best = row;
  }
  let out: TdxValuationRow | null = null;
  if (best) {
    const pe = numOr(best.PETTM);
    const pb = numOr(best.PBMRQ);
    const mv = numOr(best.AVGMVM);
    const fmv = numOr(best.ALIQMV);
    if (pe != null && pb != null && mv != null && fmv != null) {
      out = { symbol: key, pe, pb, marketCap: mv, floatCap: fmv, date: String(best.DATE) };
    }
  }
  valuationCache.set(key, { at: Date.now(), row: out });
  return out;
}

/**
 * 批量拉 F10 估值（候选池用，上限 30 只，并发 5）。F10 ~11s/只，并发可并行；
 * 全市场 5567 只不可行（约 17 小时），不要拿它刷全量。
 */
export async function fetchTdxValuations(symbols: string[], limit = PE_BATCH_LIMIT): Promise<Map<string, TdxValuationRow>> {
  const out = new Map<string, TdxValuationRow>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, limit);
  for (let i = 0; i < uniq.length; i += PE_CONC) {
    const wave = uniq.slice(i, i + PE_CONC);
    const rows = await Promise.all(wave.map((s) => fetchTdxValuation(s)));
    wave.forEach((s, j) => {
      if (rows[j]) out.set(s, rows[j]!);
    });
  }
  return out;
}

// ---------- 富化 AssetMeta ----------

/**
 * 用 7709 finance_batch 富化快照 meta：市值/流通市值/PB/换手率。
 * PE 不在此填（需 F10，见 enrichMetasWithPe）。失败的只保持 undefined，不抛错。
 * 返回 { enriched, funds }：funds 供调用方取营收/净利润/ROE（报告期口径）。
 */
export async function enrichMetasWithFund(metas: AssetMeta[]): Promise<{
  enriched: number;
  funds: Map<string, TdxFundRow>;
}> {
  const funds = await fetchTdxFundBatch(metas.map((m) => m.symbol));
  let enriched = 0;
  for (const m of metas) {
    const f = funds.get(m.symbol.toUpperCase());
    if (!f) continue;
    if (m.price == null || !(m.price > 0)) continue;
    const marketCap = m.price * f.totalShares;
    const floatCap = m.price * f.floatShares;
    if (Number.isFinite(marketCap) && marketCap > 0) m.marketCap = marketCap;
    if (Number.isFinite(floatCap) && floatCap > 0) m.floatCap = floatCap;
    const pb = m.price / f.netAssetsPerShare;
    if (Number.isFinite(pb) && pb > 0) m.pb = pb;
    if (m.volume != null && m.volume > 0 && f.floatShares > 0) {
      const turnover = (m.volume / f.floatShares) * 100;
      if (Number.isFinite(turnover) && turnover >= 0) m.turnover = turnover;
    }
    enriched++;
  }
  return { enriched, funds };
}

/**
 * 用 F10 估值富化候选池 meta 的 PE（PETTM）。PB/市值/流通市值仅当 7709 未填时
 * 用 F10 值兜底（F10 AVGMVM/ALIQMV 与 7709 推导值实测一致）。上限 30 只。
 */
export async function enrichMetasWithPe(metas: AssetMeta[], limit = PE_BATCH_LIMIT): Promise<number> {
  const need = metas.filter((m) => m.pe == null);
  if (!need.length) return 0;
  const vals = await fetchTdxValuations(
    need.map((m) => m.symbol),
    limit,
  );
  let n = 0;
  for (const m of need) {
    const v = vals.get(m.symbol.toUpperCase());
    if (!v) continue;
    m.pe = v.pe; // 负 PE=亏损，原样保留
    if (m.pb == null && v.pb > 0) m.pb = v.pb;
    if (m.marketCap == null && v.marketCap > 0) m.marketCap = v.marketCap;
    if (m.floatCap == null && v.floatCap > 0) m.floatCap = v.floatCap;
    n++;
  }
  return n;
}

/** 报告期 ROE = 净利润 / 净资产（报告期口径，非年化）。 */
export function periodRoe(f: TdxFundRow): number | null {
  if (!f.netAssets || f.netAssets <= 0) return null;
  return f.netProfit / f.netAssets;
}
