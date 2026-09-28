// 持仓上下文（标的 / 成本价 / 仓位 / 建仓日期）——纯核，零 IO、零 React，可被 node --test 直跑。
//
// 为什么单独成文件：这四个值同时被三处消费——
//   · composer 上的「持仓」小窗（用户填一次，后面每轮都带）
//   · 八张场景卡里那两张持仓卡的弹窗（按成本制定持仓计划 / 持仓先拿还是减）
//   · 服务端 /api/ai/chat 与 /api/ai/proxy 两条链路的 system 提示词
// 三处各拼一句「我持有 X，成本 C，仓位 P，建仓日期 D」迟早漂成三句不一样的话，
// 模型拿到的口径就会随入口变。这里收成唯一拼装处，两端 import 同一个 renderHoldLine。
//
// 纪律（与全仓一致）：
//   · 空值不写、不猜、不补 0。没填建仓日期就一个字都不提「持有天数」。
//   · 跨日期的「持有多少个交易日」必须由真实交易日历算（见 tdx.ts 的 tdxTradingDaysBetween），
//     不许用「自然日 × 5/7」估——估出来的天数会被模型当事实写进答案。
//   · 成本价只当**位置描述**，不当判断依据（稳智口径：不要以回本作为判断依据）。

export interface HoldCtx {
  /** 股票名称或 6 位代码（可空：用户只填了成本没填票） */
  symbol?: string;
  /** 成本价（字符串进、字符串出：用户输入可能是「23.80」也可能是「23.8 元」） */
  cost?: string;
  /** 仓位占比（选填，例「2 成」「总仓位的 20%」） */
  position?: string;
  /** 建仓日期，YYYY-MM-DD */
  openDate?: string;
}

export const EMPTY_HOLD: HoldCtx = {};

const clean = (v: unknown) => String(v ?? "").trim();
/** 数字类输入压掉所有空白：「2 3.80」→「23.80」；股票名走 clean 不粘字 */
const tight = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, "");

/**
 * 只认 YYYY-MM-DD，且必须是**真实存在的日期**：其余（含「2026/9/1」「昨天」「2026-13-01」「2026-02-30」）
 * 一律判空——不猜用户写的是哪天，也不替他把「2026-02-30」修成「2026-03-02」。
 */
export function normalizeOpenDate(v: unknown): string {
  const s = tight(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  // 回读校验：Date 会把 2026-02-30 折成 03-02，拼回去对不上就说明这一天不存在
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10) === s ? s : "";
}

/**
 * 外部输入 → HoldCtx。四个字段全空返回 null（调用方据此整段不注入，而不是注入一个空壳）。
 * 认不出的值直接丢，不做修复：把「2026/9/1」自作主张改成「2026-09-01」等于替用户填表。
 */
export function sanitizeHold(raw: unknown): HoldCtx | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: HoldCtx = {};
  const symbol = clean(r.symbol);
  if (symbol) out.symbol = symbol;
  const cost = tight(r.cost);
  if (cost) out.cost = cost;
  const position = clean(r.position);
  if (position) out.position = position;
  const openDate = normalizeOpenDate(r.openDate);
  if (openDate) out.openDate = openDate;
  return Object.keys(out).length ? out : null;
}

/** 有没有值得注入的持仓信息（只有票没有成本也算：至少模型知道在说哪只） */
export function hasHold(h: HoldCtx | null | undefined): boolean {
  return !!h && Object.keys(h).length > 0;
}

/**
 * 持有交易日数。
 * days 由真实交易日历给出（见 tdx.ts）；**左闭右开**——建仓当天不算「已持有」，
 * 例：09-01 建仓、09-24 为最新交易日 → 日历里 09-01 之后到 09-24 共 17 个交易日。
 * 返回 null 表示算不出来（没建仓日期 / 日历没取到 / 建仓晚于最新交易日），调用方不许拿 0 代替。
 */
export function heldTradeDays(days: string[] | null, openDate: string, tradeDate: string): number | null {
  if (!Array.isArray(days) || !days.length) return null;
  if (!openDate || !tradeDate) return null;
  if (openDate >= tradeDate) return null;
  const n = days.filter((d) => d > openDate && d <= tradeDate).length;
  return n > 0 ? n : null;
}

/**
 * 拼进 system 提示词的那一句。
 *
 * 顺序固定：标的 → 成本 → 仓位 → 建仓日期（+持有交易日数）。
 * 建仓日期后面必跟一句「怎么用」：不许只把日期丢给模型，否则它会写成装饰性的一句话。
 */
export function renderHoldLine(
  hold: HoldCtx,
  opts?: { tradeDate?: string | null; heldDays?: number | null },
): string {
  const parts: string[] = [];
  if (hold.symbol) parts.push(`标的 ${hold.symbol}`);
  if (hold.cost) parts.push(`成本价 ${hold.cost}`);
  if (hold.position) parts.push(`仓位 ${hold.position}`);
  if (hold.openDate) {
    const tradeDate = opts?.tradeDate ?? "";
    const held = opts?.heldDays ?? null;
    // 有日历就报「已持有 N 个交易日」；算不出来只报日期，宁可少说也不许编天数
    parts.push(
      held != null
        ? `建仓日期 ${hold.openDate}（到最近交易日 ${tradeDate} 已持有 ${held} 个交易日）`
        : `建仓日期 ${hold.openDate}`,
    );
  }
  if (!parts.length) return "";
  return `用户持仓：${parts.join("，")}。`;
}

/** 提示词里那条「怎么用持仓信息」的规则（与 renderHoldLine 同址，改一处两边一起变） */
export const HOLD_USAGE_NOTE =
  "已给出持仓信息时：先按「当前价相对成本的位置」说清是浮盈还是浮亏、幅度多少，" +
  "再按持有交易日数判断该按哪个周期口径给建议（持有 1~3 个交易日按超短看、5~20 个按短中看）；" +
  "**不要以回本作为判断依据**——成本价只用来描述位置，不用来当卖点；" +
  "没给仓位就明说「仓位未知，按半仓以内给节奏」，不许默认满仓；" +
  "建仓日期缺失时只说「建仓日期未提供，持有天数按未知处理」，不要倒推。";
