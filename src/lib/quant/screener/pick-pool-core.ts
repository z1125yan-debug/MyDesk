// P10 择优轮：「帮我选股」的候选池口径纯核（零 IO，node --test 可直跑）。
//
// 为什么要这一层（对应用户所见）：说「帮我选股」而不带条件时，旧口径是
// 「选股条件需由模型从提问里抽取，未预取」（P7 拍板）——工具环里模型要么反问一句、
// 要么干脆凭新闻快讯编几只票；纯对话端（本地网关没有 function call）更是连抽条件的人都没有，
// 于是用户反复看到「说了等于没选」。参考站 aiwuchuan.com 的做法（实测其前端 bundle 取证）：
// 含糊请求不拦停——先按条件跑出一个**量化候选池**（含糊时按默认活跃池），再把池交给模型
// **择优**，并配五条纪律：可少选可不选、池序不是推荐、维度自主、五段式输出、先报条件再报票。
//
// 口径修订留痕（P7→P10）：旧拍板「系统替模型猜条件＝替用户做决定」并未被推翻，而是被拆成两半——
//  1) 抽得到的条件照抽（extractPickConds，确定性正则，抽不出不硬凑）；
//  2) 抽不到时用默认活跃池，但池子与条件必须**如实标注是系统默认**，提示词也要求模型把
//     「这是默认口径」转述给用户——把猜的条件当用户要求仍是事故，把默认的池当「池而已」才是本意。
//
// 本层只出「条件、文案、形状」，跑筛本身仍归 runScreener（服务层），一条都不假。

import type { ScreenerCond } from "../factors/probability.ts";

/** 字段中文名（只收录本核会产出的字段，与因子目录 zh 对齐；不 import fields.ts 是为了零依赖直跑） */
export const PICK_FIELD_ZH: Record<string, string> = {
  amount_yi: "成交额(亿)",
  change_pct: "涨跌幅",
  turnover_rate: "换手率",
  volume_ratio: "量比",
  main_net_yi: "主力净额(东财)",
  market_cap_yi: "总市值(亿)",
  above_ma_5: "站上MA5",
  above_ma_10: "站上MA10",
  above_ma_20: "站上MA20",
  above_ma_60: "站上MA60",
  above_cost_20: "站上20日成本线",
  ma_struct: "均线多头排列",
  macd_cross: "MACD金叉",
  kdj_cross: "KDJ金叉",
  is_limit_up: "今日涨停",
  rps_50: "RPS50",
  rps_120: "RPS120",
};

/** 默认活跃池：含糊选股请求的兜底条件（全快照字段，断源兜底期也取得到；不含 main_net_yi，避免撞上无读数缺口） */
export const DEFAULT_PICK_CONDS: ScreenerCond[] = [
  { field: "amount_yi", op: ">=", value: 2 },
  { field: "change_pct", op: ">", value: 0 },
  { field: "turnover_rate", op: ">=", value: 1 },
];
/** 默认池的诚实标签：注入块与工具返回都要带上，模型不许把它说成「你的条件」 */
export const DEFAULT_PICK_LABEL = "系统默认活跃池：成交额≥2亿 · 当日收涨 · 换手率≥1%（不是你给的条件，是「帮我选股」没给条件时的默认口径）";

/** 择优五条纪律（一份定义两处消费：场景提示词注入 + factor_screener 工具返回转述要求） */
export const PICK_DISCIPLINE: string[] = [
  "从候选池里择优，最多 3 只（用户点名要几只按几只）；没有真正合格的可以少选、可以不选，不许为凑数放宽条件。",
  "池子顺序不是推荐：池只是量化条件的命中清单（按成交额排序），评价维度与权重由你按问题自主决定。",
  "论据只基于池内真实数据；要更深的读数（资金流/技术状态/历史概率）就调工具现取，取不到就写暂无数据，不许凭记忆编。",
  "每只入选票给五段：入选理由、入场条件、仓位节奏、失效条件、主要风险。",
  "先报本轮实际用的条件、命中家数与数据日期（默认池要说明是默认口径），再报入选票；条件字段被数据缺口忽略的照实转述。",
];

/** 条件的中文读法（注入块/工具返回共用；op 符号与页面一致） */
export function pickCondText(c: ScreenerCond): string {
  const zh = PICK_FIELD_ZH[String(c.field)] ?? String(c.field);
  const op = { "=": "=", ">": "＞", ">=": "≥", "<": "＜", "<=": "≤", "!=": "≠" }[String(c.op)] ?? String(c.op);
  return `${zh}${op}${c.value}`;
}

/* ---------------- R11：候选池读出侧人话化（只换读法，不改冻结原数据） ---------------- */

/**
 * 冻结池行键的中文读法（candidate_pool 工具读出侧用）。
 * 口径与 pickCondText 同源：这是「读法」不是「改写」——池子 rows 是冻结时点的原始数据，
 * 落库后永不覆盖（见 /api/pool/freeze），本函数只在读出时换键名显示；
 * 认不出的键原样保留、值一律不动，避免中文化顺手改数。
 */
export const POOL_ROW_KEY_ZH: Record<string, string> = {
  symbol: "代码",
  name: "名称",
  close: "收盘价",
  changePct: "涨跌幅%",
  reason: "入池时条件",
};

export function poolRowZh(row: unknown): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[POOL_ROW_KEY_ZH[k] ?? k] = v;
  }
  return out;
}

/** 条件读出人话化：带 field 形状的条件走 pickCondText，其余（坏形状/旧格式）原样透传 */
export function poolCondZh(c: unknown): unknown {
  if (c !== null && typeof c === "object" && !Array.isArray(c) && "field" in c) {
    const x = c as Record<string, unknown>;
    return pickCondText({
      field: String(x.field),
      op: String(x.op ?? "") as ScreenerCond["op"],
      value: x.value as number | string,
    });
  }
  return c;
}

export interface PickExtract {
  conds: ScreenerCond[];
  /** 每条抽中条件的原话片段（让「抽到了什么」可被用户核对，不是黑箱） */
  matched: string[];
}

const num = String.raw`(\d+(?:\.\d+)?)`;

/**
 * 从自然语言里确定性抽取选股条件。
 * 规则很少、也从不硬凑：认不出的说法（「缩量回调」这类）不产条件——
 * 剩下的交给默认池或模型自取工具，绝不把没抽到的说法翻译成一个猜出来的阈值。
 */
export function extractPickConds(question: string): PickExtract {
  const q = String(question ?? "");
  const conds: ScreenerCond[] = [];
  const matched: string[] = [];
  const push = (c: ScreenerCond, say: string) => {
    if (!conds.some((x) => x.field === c.field)) { conds.push(c); matched.push(say); }
  };
  let m: RegExpExecArray | null;

  // 站上N日线（只认目录里有的均线周期：5/10/20/60；「20日成本线」单独一条口径）
  const maRe = new RegExp(String.raw`站上\s*(\d+)\s*(?:日)?(?:线|均线|ma)`, "gi");
  while ((m = maRe.exec(q))) {
    const n = m[1];
    if (["5", "10", "20", "60"].includes(n)) push({ field: `above_ma_${n}`, op: ">=", value: 1 }, `站上MA${n}`);
  }
  if (/站上\s*20\s*日成本线/.test(q)) push({ field: "above_cost_20", op: ">=", value: 1 }, "站上20日成本线");
  if (/均线多头|多头排列/.test(q)) push({ field: "ma_struct", op: ">=", value: 1 }, "均线多头排列");
  if (/MACD\s*金叉|金叉/.test(q)) push({ field: "macd_cross", op: ">=", value: 1 }, "MACD金叉");
  if (/KDJ\s*金叉/.test(q)) push({ field: "kdj_cross", op: ">=", value: 1 }, "KDJ金叉");
  if (/涨停/.test(q) && !/=?\s*0\s*个?涨停|没有涨停|不涨停/.test(q)) push({ field: "is_limit_up", op: ">=", value: 1 }, "今日涨停");

  // 数值阈值：「大于/超过/高于/不低于/至少/＞」+ 数；「低于/不超过/小于/＜」取反
  const threshold = (field: string, re: RegExp, unit: string, lo = true) => {
    const r = new RegExp(re.source, re.flags);
    const mm = r.exec(q);
    if (mm) push({ field, op: lo ? ">=" : "<=", value: Number(mm[1]) } as ScreenerCond, `${unit}${lo ? "≥" : "≤"}${mm[1]}`);
  };
  threshold("volume_ratio", new RegExp(String.raw`量比[^0-9]{0,6}${num}(?:倍)?`), "量比");
  threshold("turnover_rate", new RegExp(String.raw`换手率?[^0-9]{0,6}${num}\s*(?:%|个点|以上|出)?`), "换手率");
  threshold("amount_yi", new RegExp(String.raw`成交额[^0-9]{0,6}${num}\s*亿`), "成交额(亿)");
  threshold("market_cap_yi", new RegExp(String.raw`(总市值|市值)[^0-9]{0,6}${num}\s*亿`), "总市值(亿)");
  threshold("change_pct", new RegExp(String.raw`(涨幅|涨跌幅|涨)[^0-9]{0,6}${num}\s*(?:%|个点|以上)`), "涨跌幅");
  threshold("rps_50", new RegExp(String.raw`RPS\s*50?\s*[^0-9]{0,4}${num}`, "i"), "RPS50");
  // 资金口径：只认「净流入/流入」为正这一种说法，不猜阈值（「大幅流入」不是数字）
  if (/主力净流入|资金净流入|主力流入|净流入/.test(q)) push({ field: "main_net_yi", op: ">", value: 0 }, "主力净流入>0");
  return { conds, matched };
}

/** 池子出身三元（诚实登记，UI/模型转述都要看它）：抽出来的 / 系统默认 / 模型自给（工具环里模型带 conditions 时） */
export type PoolOrigin = "extracted" | "default" | "model";

export function poolOriginText(origin: PoolOrigin, matched: string[]): string {
  if (origin === "default") return DEFAULT_PICK_LABEL;
  if (origin === "model") return `本轮条件由模型按提问拟定：${matched.join("；")}`;
  return `从你的提问里抽到的条件：${matched.join("；")}`;
}

/* ---------------- P13 门户轮：「存池 + 交给 AI 择优」的研究指令装配 ---------------- */

/**
 * 稳智逆向（StockScreener-DUZZ18EG.js）研究指令原文的本地化口径，四个不可让渡的点：
 * 最多 X 只 / 可少选可不选 / 页面排序不是推荐结果 / 五段式输出（理由·入场·仓位·失效·风险）。
 * 名单随指令inline进对话（截断到 POOL_THESIS_ROW_CAP 只）：纯对话通道（本地网关没有
 * function call）读不到 candidate_pool 工具，指令里没名单就只剩一句空话——工具是深口径的
 * 补充，不是这条链路的必要条件。
 */
export const POOL_PICK_MAX_DEFAULT = 3;
/** 指令里带多少只票的名单：再多就不是「交给 AI 看的素材」而是刷屏了 */
export const POOL_THESIS_ROW_CAP = 30;

export interface ThesisRow {
  symbol: string;
  name?: string | null;
  close?: number | null;
  changePct?: number | null;
}

export function poolPickThesis(
  poolId: string,
  rows: ThesisRow[],
  maxPicks: number = POOL_PICK_MAX_DEFAULT,
): string {
  const shown = rows.slice(0, POOL_THESIS_ROW_CAP);
  const list = shown
    .map((r) => `${r.name || "?"}(${r.symbol}${r.close != null && isFinite(r.close) ? ` ${r.close}` : ""}${r.changePct != null && isFinite(r.changePct) ? ` ${r.changePct > 0 ? "+" : ""}${r.changePct}%` : ""})`)
    .join("、");
  const truncated = rows.length > shown.length ? `；已按保存时排序截取前 ${shown.length} 只（池内共 ${rows.length} 只）` : "";
  return (
    `请从量化候选池（池号 ${poolId}）中自主研究并优选，最多选出 ${maxPicks} 只；` +
    `没有真正合格的标的可以少选或不选。` +
    `池内名单是冻结时点的真实行情快照、按保存时的页面排序（那是排序不是推荐）：` +
    `${list || "（空池）"}${truncated}。` +
    `请自主决定评价维度与权重、需要补充的数据与工具调用（可用 candidate_pool 工具读池号 ${poolId} 的完整口径，` +
    `再用个股工具现取更深读数；取不到就写暂无数据，不许凭记忆编），不要把页面原始排序当作推荐结果。` +
    `最终每只给出：入选理由、入场条件、仓位节奏、失效条件、主要风险。`
  );
}
