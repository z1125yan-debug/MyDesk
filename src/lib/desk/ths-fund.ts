// ---------- 同花顺（THS）个股主力净额（P15-R9） ----------
// 东财 push2 断源（502）后，个股主力净额无真数：腾讯 ff_/ifzq 无接口、新浪 403、
// 东财 datacenter-web 无主力表。事件雷达的 fundCheck 因此长期记「无资金验证」。
// 同花顺 d.10jqka.com.cn 的 realhead 接口是与东财真正独立的上游，实测直连 200，
// 返回 JSONP，含个股资金流字段。
//
// 字段映射（已用 2 只票 + 极端涨跌票验证，见下方注释）：
//   moneyflow 末分钟（1500）的 8 个数与 realhead 的 223/224/225/226/237/238/259/260
//   逐位相等（600519 实测完全一致），确认 223~260 即当日资金流累计值。
//   223 = 超大单流入(元), 224 = 超大单流出(元)
//   225 = 大单流入(元),   226 = 大单流出(元)
//   237 = 中单流入(元),   238 = 中单流出(元) —— 实测仅 ~28 万，量级异常小，
//         疑为集合竞价/撤单类口径，不参与主力计算，仅原样返回供排查。
//   259 = 小单流入(元),   260 = 小单流出(元)
//   主力净额(元) = (223 + 225) − (224 + 226)；主力 = 超大单 + 大单。
// 验证（2026-10-15 收盘数）：
//   600519 茅台 +2.07% → 主力净 +6.45 亿（223 12.54 + 225 9.73 − 224 8.01 − 226 7.81）
//   000001 平安银行 −0.78% → 主力净 −1.27 亿
//   000002 万科Ａ −1.91% → 主力净 −0.41 亿
//   极端票 300111 +20.06% → +0.91 亿；301053 −20.01% → −0.26 亿；
//   方向 4/6 符合（301282 +20% 但 −0.03 亿、300497 −14.89% 但 +0.65 亿为
//   涨停派发/跌势吸筹类例外，量级均小，属合理偏离）。
//
// 代码格式：沪深北统一用 hs_ 前缀（同花顺 realhead 约定，深市也用 hs_，不是 sz_）。
// 限流：事件雷达只拉映射板块龙头（每事件 ≤3 只），批量函数逐只拉、间隔 100ms，
// 上限 30 只，绝不一次拉全市场 5567 只。

export interface ThsStockFund {
  /** 同花顺代码，如 hs_600519 */
  thsCode: string;
  /** 6 位代码，如 600519 */
  code: string;
  /** 超大单流入(亿) */
  superInYi: number;
  /** 超大单流出(亿) */
  superOutYi: number;
  /** 大单流入(亿) */
  bigInYi: number;
  /** 大单流出(亿) */
  bigOutYi: number;
  /** 超大单净额(亿) = 223−224 */
  superNetYi: number;
  /** 大单净额(亿) = 225−226 */
  bigNetYi: number;
  /** 主力净额(亿) = (223+225)−(224+226)，主力 = 超大单 + 大单 */
  mainNetYi: number;
  /** 小单净额(亿) = 259−260，仅供参考，不参与主力 */
  smallNetYi: number;
  /** 中单流入(元，原值，量级异常小，不参与计算） */
  midInRaw: number;
  /** 中单流出(元，原值） */
  midOutRaw: number;
  /** 同花顺返回的交易日期，如 20261015 */
  date: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const YI = 1e8;

/** "600519.SH" / "600519" / "hs_600519" → "hs_600519"（沪深北统一 hs_ 前缀） */
export function thsCodeFromSymbol(symbol: string): string {
  const s = symbol.trim();
  if (s.startsWith("hs_")) return s;
  const code = s.split(".")[0].replace(/[^0-9]/g, "");
  return code ? `hs_${code}` : "";
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(n) ? n : 0;
}

/** 单只：拉同花顺 realhead，解析 223/224/225/226/237/238/259/260。失败返回 null，由调用方决定回退，不抛错。 */
export async function fetchThsStockFund(thsCode: string): Promise<ThsStockFund | null> {
  if (!thsCode) return null;
  try {
    const res = await fetch(`https://d.10jqka.com.cn/v2/realhead/${thsCode}/last.js`, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/\((\{[\s\S]*\})\)/);
    if (!m) return null;
    const d = JSON.parse(m[1]) as { items?: Record<string, unknown> };
    const it = d.items ?? {};
    const superIn = toNum(it["223"]);
    const superOut = toNum(it["224"]);
    const bigIn = toNum(it["225"]);
    const bigOut = toNum(it["226"]);
    const midIn = toNum(it["237"]);
    const midOut = toNum(it["238"]);
    const smallIn = toNum(it["259"]);
    const smallOut = toNum(it["260"]);
    // 全 0 视为无数据（停牌/未上市/接口空返回），不报 0 净额误导
    if (!superIn && !superOut && !bigIn && !bigOut && !smallIn && !smallOut) return null;
    return {
      thsCode,
      code: thsCode.replace(/^hs_/, ""),
      superInYi: superIn / YI,
      superOutYi: superOut / YI,
      bigInYi: bigIn / YI,
      bigOutYi: bigOut / YI,
      superNetYi: (superIn - superOut) / YI,
      bigNetYi: (bigIn - bigOut) / YI,
      mainNetYi: (superIn + bigIn - superOut - bigOut) / YI,
      smallNetYi: (smallIn - smallOut) / YI,
      midInRaw: midIn,
      midOutRaw: midOut,
      date: "",
    };
  } catch {
    return null;
  }
}

/** 批量：逐只拉、间隔 100ms、上限 30 只；单只失败跳过不中断。 */
export async function fetchThsStockFunds(thsCodes: string[]): Promise<ThsStockFund[]> {
  const out: ThsStockFund[] = [];
  const uniq = [...new Set(thsCodes.filter(Boolean))].slice(0, 30);
  for (const c of uniq) {
    const r = await fetchThsStockFund(c);
    if (r) out.push(r);
    await new Promise((res) => setTimeout(res, 100));
  }
  return out;
}
