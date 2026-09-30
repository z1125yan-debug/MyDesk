// A 任务：策略「可成交性」判定纯核（2026-09-30）
//
// 为什么有这张核：分档回测按 **T 日收盘价** 成交，而「今日涨停=1」选出的票
// 其 T 日收盘价恰好就是涨停价——**封板了买不进**。回测算的是全样本平均，
// 用户真正能成交的只有炸板/烂板（分布里最差的那一截），中间的缺口叫不可成交收益。
//
// 实测证据（B0 前复权粮仓 300 个交易日，全A 5404 只，脚本 exports/tmp/check-limitup2.ts）：
//   涨停日【收盘价】买入 → 次日收盘卖： **+1.562%**（但买不进）
//   涨停次日【开盘价】买入 → 当日收盘卖：**−0.173%**（真实可成交，负的）
//   ⇒ 被抢走的溢价 1.736 个百分点；相对基线超额 −0.228%（三档分别为
//     强势 −0.303% / 震荡 +0.027% / 弱势 −0.181%，**没有任何一档能用**）
//
// 判定口径：`is_limit_up` 是**布尔 0/1**（fields.ts:1387 `涨幅>=涨停阈值 ? 1 : 0`），
// 所以 op 与 value 的组合有确定的真假值，可以静态判定，不用跑数据。

export type TradeVerdict =
  | "ok" // 可执行
  | "untradeable" // 要求已涨停/封板 → 买不进，成绩是虚的
  | "dead" // 条件恒假 → 永远 0 命中的死策略
  | "vacuous"; // 条件恒真 → 废条件（等于没写，策略本身可能还有效）

/** 封板类字段（要求它=1 就等于要求"已经涨停"） */
export const SEALED_FIELDS = ["is_limit_up", "limit_up", "is_sealed", "touched_limit"] as const;

/** 跌停/停牌：能买进但卖不出或无法成交，当前只标 vacuous 由人工判断，不自动删 */
export const SOFT_BLOCK_FIELDS = ["is_limit_down", "limit_down", "suspend", "halt"] as const;

export interface CondLike {
  field?: string;
  op?: string;
  value?: unknown;
}

export interface VerdictDetail {
  field: string;
  op: string;
  value: unknown;
  verdict: TradeVerdict;
  reason: string; // 已经是人话，可直接上屏
}

const num = (v: unknown): number | null => {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 判定单条条件。布尔字段 b∈{0,1}，各 op 的真假值：
 *   b=1 / b>=1 / b>0 / b!=0  → 要求涨停 → untradeable
 *   b=0 / b<1 / b<=0 / b!=1  → 排除涨停 → ok
 *   b>1 / b>=2 / b=2 / b<0   → 恒假     → dead
 *   b>=0 / b<=1 / b<2 / b<3  → 恒真     → vacuous
 */
export function verdictOfCond(c: CondLike): VerdictDetail | null {
  const field = String(c?.field ?? "");
  const op = String(c?.op ?? "=").trim();
  const v = num(c?.value);
  if (!SEALED_FIELDS.some((k) => field.includes(k))) return null;
  if (v == null) return null;

  const base = { field, op, value: c?.value };
  const ok = (reason: string): VerdictDetail => ({ ...base, verdict: "ok", reason });
  const unt = (reason: string): VerdictDetail => ({ ...base, verdict: "untradeable", reason });
  const dead = (reason: string): VerdictDetail => ({ ...base, verdict: "dead", reason });
  const vac = (reason: string): VerdictDetail => ({ ...base, verdict: "vacuous", reason });

  switch (op) {
    case "=":
    case "==":
      if (v >= 1 && v < 2) return unt("要求今天已经涨停——这种票收盘价就是涨停价，下单买不进去");
      if (v === 0) return ok("排除涨停股，可以正常买入");
      return dead(`涨停标记只能是 0 或 1，写成 ${op}${c?.value} 永远选不出票`);
    case ">=":
      if (v >= 1 && v < 2) return unt("要求今天已经涨停——这种票收盘价就是涨停价，下单买不进去");
      if (v <= 0) return vac("条件永远成立（等于没写）");
      return dead(`涨停标记只能是 0 或 1，写成 ${op}${c?.value} 永远选不出票`);
    case ">":
      if (v >= 1) return dead(`涨停标记只能是 0 或 1，写成 ${op}${c?.value} 永远选不出票`);
      if (v < 0) return dead(`涨停标记只能是 0 或 1，写成 ${op}${c?.value} 永远选不出票`);
      return unt("要求今天已经涨停——这种票收盘价就是涨停价，下单买不进去");
    case "<=":
      if (v >= 1) return vac("条件永远成立（等于没写）");
      if (v < 0) return dead(`涨停标记只能是 0 或 1，写成 ${op}${c?.value} 永远选不出票`);
      return ok("排除涨停股，可以正常买入");
    case "<":
      if (v > 1) return vac("条件永远成立（等于没写）");
      if (v <= 0) return dead(`涨停标记只能是 0 或 1，写成 ${op}${c?.value} 永远选不出票`);
      return ok("排除涨停股，可以正常买入");
    case "!=":
    case "<>":
      if (v === 1 || v === 0) return v === 1 ? ok("排除涨停股，可以正常买入") : unt("要求今天已经涨停——这种票收盘价就是涨停价，下单买不进去");
      return vac("条件永远成立（等于没写）");
    default:
      return null; // 认不出的运算符不判定，不猜
  }
}

export interface StrategyVerdict {
  verdict: TradeVerdict;
  details: VerdictDetail[];
  /** 人话摘要，可直接上屏 / 写进台账 */
  summary: string;
}

/** 整条策略的判定：取最严重的那一档（untradeable > dead > vacuous > ok） */
export function verdictOfStrategy(conds: readonly CondLike[] | null | undefined): StrategyVerdict {
  const details: VerdictDetail[] = [];
  for (const c of conds ?? []) {
    const d = verdictOfCond(c);
    if (d) details.push(d);
  }
  if (!details.length) return { verdict: "ok", details: [], summary: "" };
  const rank: Record<TradeVerdict, number> = { ok: 0, vacuous: 1, dead: 2, untradeable: 3 };
  let worst: TradeVerdict = "ok";
  for (const d of details) if (rank[d.verdict] > rank[worst]) worst = d.verdict;
  const hit = details.find((d) => d.verdict === worst);
  return { verdict: worst, details, summary: hit?.reason ?? "" };
}

/** 是否该从策略库里删掉（untradeable = 成绩虚的；dead = 永远 0 命中） */
export function shouldDrop(v: StrategyVerdict): boolean {
  return v.verdict === "untradeable" || v.verdict === "dead";
}
