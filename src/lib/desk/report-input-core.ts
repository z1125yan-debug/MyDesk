// 产业链研报 · 喂给模型的数据块（中文口径 + 本地量化判读），纯函数（P64）
//
// 为什么要有这一层（2026-09-27 用户对比截图问「谁错了」时翻出来的根因）：
// 旧 prompt 是 `JSON.stringify(rows)` 把内部英文字段直接塞给模型，模型不懂语义就自己编：
//   · 把 `aboveMa5Pct 27.56`（=只有 27.56% 的个股**站上**5日均线）写成「上5日均线**跌破率** 27.56%」——口径整个反了；
//   · 把 `microPct`（微盘股站上5日均线占比）写成「微观成交占比」；
//   · 我们根本没喂指数点位，它就在正文里写「指数在 3000 点附近震荡」「跌破 2950 加仓」「MA5已跌破MA10」
//     ——真实读数是上证 3888.37、MA5 3927.76 > MA10 3904.37，三条全是编的；
//   · 正文里还直接漏出 `aboveMa5Pct` / `microPct` 这种内部字段名（用户截图里就有）。
// 更讽刺的是：**本地量化引擎早就算过权威判读**（themeHeat.inference：桶=退潮、阶段=退潮反抽、
// 置信度 0.66，理由里带真实点位与成交额），只是没喂给写研报的这个模型。
//
// 所以这一层的规矩：① 指标一律翻成中文并给定义（口径写在数据里，不指望模型猜）；
// ② 指数点位/均线/回撤这类读数由真实 K 线算出来喂进去，模型只能引用不能自造；
// ③ 本地引擎判读原文喂进去，并要求「市场阶段」与它一致或明写分歧。
// 这里只放纯计算与拼串，组件里不再手写数据行（本仓「唯一定义处」纪律）。

export interface CandleLike {
  date: string;
  c: number | string;
}

export interface IndexTrend {
  /** 最后一根 K 线的交易日 */
  date: string;
  close: number;
  /** 当日相对前一收盘的涨跌幅（%）；不足两根为 null */
  chgPct: number | null;
  /** 均线：n=周期，v=值；样本不足的周期直接不出现在数组里 */
  mas: { n: number; v: number }[];
  /** 收盘位于其下方的均线周期 */
  belowMas: number[];
  /** 距最近 60 个交易日收盘高点的百分比（负数=回撤）；无高点为 null */
  offHighPct: number | null;
  /** 参与计算的有效 K 线根数 */
  bars: number;
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** 由真实日 K 线算出指数趋势读数（收盘 / 涨跌 / MA5·10·20·60 / 距 60 日高点） */
export function indexTrendFromCandles(candles: CandleLike[] | null | undefined): IndexTrend | null {
  const closes = (candles ?? []).map((c) => num(c?.c)).filter((v): v is number => v !== null);
  if (closes.length < 2) return null;
  const close = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const chgPct = prev ? round(((close - prev) / prev) * 100) : null;
  const mas: { n: number; v: number }[] = [];
  for (const n of [5, 10, 20, 60]) {
    if (closes.length < n) continue;
    const win = closes.slice(-n);
    mas.push({ n, v: round(win.reduce((a, b) => a + b, 0) / n) });
  }
  const belowMas = mas.filter((m) => close < m.v).map((m) => m.n);
  const win60 = closes.slice(-60);
  const high = Math.max(...win60);
  const offHighPct = high ? round(((close - high) / high) * 100) : null;
  const last = (candles ?? [])[candles!.length - 1] as CandleLike | undefined;
  return { date: String(last?.date ?? "").slice(0, 10), close, chgPct, mas, belowMas, offHighPct, bars: closes.length };
}

/** 指数趋势的中文一行（喂进 prompt 用；没有的读数就写「数据不足」，不让模型补） */
export function indexTrendZh(name: string, t: IndexTrend | null): string {
  if (!t) return `${name}：K线数据不足，本项不要出现在正文里`;
  const mas = t.mas.length ? t.mas.map((m) => `MA${m.n}=${m.v}`).join(" / ") : "均线样本不足";
  const pos = t.mas.length
    ? (t.belowMas.length ? `收盘位于 ${t.belowMas.map((n) => "MA" + n).join("、")} 下方` : "收盘站上全部给出的均线")
    : "";
  const off = t.offHighPct === null ? "" : `；距最近 ${Math.min(60, t.bars)} 个交易日收盘高点 ${t.offHighPct}%`;
  // 涨跌必须带符号 + 方向词：曾因「当日 0.18%」无符号被模型按熊市语境脑补成「跌幅 0.18%」（实际是涨）
  const chg = t.chgPct === null
    ? "数据不足"
    : `${t.chgPct >= 0 ? "+" : ""}${t.chgPct}%（${t.chgPct >= 0 ? "上涨" : "下跌"}）`;
  return `${name} ${t.date} 收 ${t.close}（当日涨跌 ${chg}）；${mas}${pos ? " → " + pos : ""}${off}`;
}

/** 指标定义：把内部字段名的真实语义写死，模型不许自己猜（口径反了就是这么来的） */
export const METRIC_DEFS_ZH = [
  "- 涨停家数 / 跌停家数：当日收盘封板家数（limitUp / limitDown）。",
  "- 站上5日均线占比：**全市场个股里收盘价在 5 日均线上方**的比例（%）。数值越低说明弱势面越大 —— 它是「站上」的比例，不是跌破率，别写反。",
  "- 微盘 / 中盘 / 大盘站上5日均线占比：按市值分层的同一口径（微盘=最小一档），是**个股站线比例**，不是成交额占比。",
  "- 下跌家数 / 跌破MA5家数 / 跌破MA3家数：全市场家数计数。",
  "- 最高连板：当日最高连续涨停板数，衡量题材接力强度。",
  "- 3日资金（亿元）：该主题近三个交易日主力净流入，正数=流入、负数=流出。",
];

interface ReviewRowLike {
  date: string; limitUp?: number | null; limitDown?: number | null; maxBoards?: number | null;
  decliners?: number | null; belowMa5?: number | null; belowMa3?: number | null; aboveMa5Pct?: number | null;
  microPct?: number | null; midPct?: number | null; largePct?: number | null;
}

/** 复盘统计行 → 中文一行一天（字段名一律不出现，避免模型把内部 key 漏进正文） */
export function reviewRowsZh(rows: ReviewRowLike[] | null | undefined): string[] {
  return (rows ?? []).map((r) => {
    const f = (v: unknown) => (num(v) === null ? "数据不足" : String(num(v)));
    return [
      `${String(r.date).slice(0, 10)}：涨停${f(r.limitUp)}家 跌停${f(r.limitDown)}家 最高连板${f(r.maxBoards)}；`,
      `下跌${f(r.decliners)}家；站上5日均线占比 ${f(r.aboveMa5Pct)}%`,
      `（微盘 ${f(r.microPct)}% / 中盘 ${f(r.midPct)}% / 大盘 ${f(r.largePct)}%）；`,
      `跌破MA5 ${f(r.belowMa5)}家、跌破MA3 ${f(r.belowMa3)}家`,
    ].join("");
  });
}

interface VerdictLike {
  market_env?: { as_of_trade_date?: string; label?: string } | null;
  inference?: { as_of_date?: string; confidence?: number; market_bucket?: string; market_phase?: string; reason?: string } | null;
}

/** 本地量化引擎的权威判读（有就原文喂，没有就说没有，别让模型凭空定性） */
export function localVerdictZh(th: VerdictLike | null | undefined): string {
  const inf = th?.inference;
  const env = th?.market_env;
  if (!inf?.market_bucket && !env?.label) return "本地量化引擎判读：本次没有给出（正文里不要编市场阶段结论）";
  const conf = num(inf?.confidence);
  const head = [
    `市场桶=${inf?.market_bucket || "数据不足"}`,
    `阶段=${inf?.market_phase || "数据不足"}`,
    `环境标签=${env?.label || "数据不足"}`,
    conf === null ? "" : `置信度=${conf}`,
    inf?.as_of_date ? `截至 ${inf.as_of_date}` : "",
  ].filter(Boolean).join("，");
  const reason = String(inf?.reason ?? "").replace(/\s+/g, " ").trim();
  return `本地量化引擎判读（写「市场阶段」时必须与之一致，或明写分歧点）：${head}。依据：${reason ? reason.slice(0, 700) : "（未给出）"}`;
}

/** 主题热度 + 3日资金 → 中文行 */
export function themeFlowsZh(
  industries: { n: string; h: number; f: number }[] | null | undefined,
  concepts: { n: string; h: number; f: number }[] | null | undefined,
  conceptLimit = 8,
): string[] {
  const one = (x: { n: string; h: number; f: number }) =>
    `${x.n}(热度${x.h}，3日资金${num(x.f)?.toFixed(2) ?? "数据不足"}亿)`;
  const out: string[] = [];
  const ind = industries ?? [];
  const con = (concepts ?? []).slice(0, conceptLimit);
  if (ind.length) out.push(`行业主线：${ind.map(one).join("；")}`);
  if (con.length) out.push(`概念主线：${con.map(one).join("；")}`);
  return out;
}
