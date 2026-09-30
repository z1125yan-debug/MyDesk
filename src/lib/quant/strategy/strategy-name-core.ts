// P36 小白体验：把「1 / 2 / 3 / 我的」这类无意义的策略名，从它的条件反推成看得懂的话。
//
// 为什么需要：社区策略库（data/strategies.json）里大量策略名字就是数字或「我的」，
// 直接显示在「分档回测榜 / 推荐 / 战绩」上，小白完全不知道在推什么。
// 这些策略其实都带着条件（如 近7日涨幅≤10% · 站上20日线），从条件拼一句话比留一个数字强得多。
//
// 纯核、零依赖：不 import fs/path/fields，客户端与服务端都能直接用（前端社区策略库列表也要用）。
// 字段→中文只覆盖常见条件字段；命中不到的回退原始字段名（仍然比「1」强）。
//
// 说人话纪律（任务书第 0 节）：这里反推出来的文案不准出现黑话；
// 字段表里已经用「站上20日线 / 换手率 / 涨停」这种白话，不用「MA20 / 量比 / 涨停板」之类。

/** 常见条件字段 → 中文。覆盖预设条件卡 + 社区库高频字段；命中不到回退原字段名。 */
const FIELD_ZH: Record<string, string> = {
  above_ma_5: "站上5日线",
  above_ma_10: "站上10日线",
  above_ma_20: "站上20日线",
  above_ma_60: "站上60日线",
  above_ma_120: "站上120日线",
  ma_struct: "短中长期价依次抬高",
  close: "收盘价",
  open: "开盘价",
  high: "最高价",
  low: "最低价",
  change_pct: "涨跌幅",
  amplitude: "振幅",
  turnover_rate: "换手率",
  volume_ratio: "量比",
  amount_yi: "成交额",
  vol: "成交量",
  double_volume_signal: "倍量信号",
  volume_signal: "量能信号",
  upper_shadow_ratio: "长上影线",
  lower_shadow_ratio: "长下影线",
  is_limit_up: "涨停",
  is_limit_down: "跌停",
  macd: "MACD柱",
  macd_cross: "MACD金叉",
  kdj_cross: "KDJ金叉",
  kdj_j: "KDJ-J",
  rsi_14: "RSI14",
  rsi_24: "RSI24",
  rsi_12: "RSI12",
  atr_ratio_14: "相对波动%",
  vwap20_filter: "站上VWAP20",
  vwap_pos: "VWAP偏离%",
  vwap_lowpullback: "VWAP低吸回踩",
  vwap_break_expand: "VWAP突破放量",
  vwap_accel: "VWAP加速",
  zsb_dealer: "庄家控盘",
  zsb_accum: "主力吸筹",
  strong_acc_pick: "强势吸筹选股",
  strong_acc_conds_met: "强势吸筹条件",
  zsb_attack: "主力攻击",
  zsb_trigger: "主力触发",
  zsb_rsi_v: "资金RSI",
  zsb_rsi_reduce: "资金RSI减仓",
  break_cost_20: "突破20日成本",
  break_cost_60: "突破60日成本",
  pe_ttm: "市盈率",
  pb: "市净率",
  market_cap_yi: "总市值",
  floatcap_yi: "流通市值",
  sector_rps_50: "行业RPS50",
  sector_rps_120: "行业RPS120",
  rps_50: "RPS50",
  rps_120: "RPS120",
  rps_250: "RPS250",
  industry: "行业",
  kline_pattern: "K线形态",
  trend_pressure_60: "趋势压力线",
  sector_concept: "板块/概念",
  main_net: "主力净额",
  main_net_sum: "主力净额合计",
  money_flow: "资金流向",
  new_high_20: "创20日新高",
  new_low_20: "创20日新低",
  breakthrough: "突破",
  chan_bottom_fractal: "底分型",
  chan_top_fractal: "顶分型",
};

/** 像「1 / 2 / 123 / 我的 / test」这种等于没名字的，需要从条件反推。 */
const JUNK_TOKENS = new Set([
  "test", "测试", "ceshi", "哈哈", "无", "空", "我的", "未命名",
  "n/a", "na", "null", "undefined", "none", "nan", "-", "—", "x", "xx",
]);

export function isJunkName(name: string | null | undefined): boolean {
  const s = (name ?? "").toString().trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return true; // 纯数字：「1」「123」
  if (JUNK_TOKENS.has(s.toLowerCase())) return true;
  // 单字符且不是常见中文词（如「涨」「强」是合理名，但「a」不是）
  if (s.length <= 1 && !/[\u4e00-\u9fa5]/.test(s)) return true;
  return false;
}

function opLabel(op: string | undefined): string {
  switch (op) {
    case "=": return "=";
    case ">=": return "≥";
    case "<=": return "≤";
    case ">": return ">";
    case "<": return "<";
    case "!=": return "≠";
    case "like": return "含";
    default: return op ?? "";
  }
}

export interface NameCond {
  field: string;
  op?: string;
  value?: string | number;
  window?: number;
  type?: string;
}

/** 单条条件 → 人话。布尔型（=1）只说状态不写「=1」；滚动收益类说「涨幅」。 */
export function condToZh(c: NameCond): string {
  const win = c.window ? `近${c.window}日` : "";
  const isBool1 = c.op === "=" && (c.value === 1 || c.value === "1");
  let zh = FIELD_ZH[c.field] ?? c.field;
  if (c.type === "rolling_return") zh = "涨幅"; // close 滚动收益其实是涨幅%，不是收盘价
  const val = c.value != null && c.value !== "" ? String(c.value) : "";
  let mid = "";
  if (c.op === "=") mid = isBool1 ? "" : `=${val}`;
  else if (c.op === ">=") mid = `≥${val}`;
  else if (c.op === "<=") mid = `≤${val}`;
  else if (c.op === ">") mid = `>${val}`;
  else if (c.op === "<") mid = `<${val}`;
  else if (c.op === "!=") mid = `≠${val}`;
  else if (c.op === "like") mid = val ? `含${val}` : "";
  else mid = (c.op ? `${opLabel(c.op)}${val}` : val);
  return `${win}${zh}${mid}`;
}

/**
 * 给一个策略算「给人看的名字」。
 * - 名字本身有意义 → 原样返回（如「趋势向上低吸」）。
 * - 名字是垃圾（1/我的/test）→ 用前 3 条条件拼一句话（如「近7日涨幅≤10% · 站上20日线」）。
 * - 连条件都没有 → 退而求其次「策略 #id」；再不行回退原名。
 */
export function humanName(
  name: string | null | undefined,
  conds: NameCond[] | null | undefined,
  id?: number,
): string {
  if (!isJunkName(name)) return String(name).trim();
  const parts = (conds ?? [])
    .filter((c) => c && c.field)
    .slice(0, 3)
    .map(condToZh)
    .filter(Boolean)
    // 同字段条件（如 3 条不同参数的底分型）会拼出「底分型 · 底分型 · 底分型」的口吃名，去重
    .filter((p, i, arr) => arr.indexOf(p) === i);
  if (parts.length) return parts.join(" · ");
  if (typeof id === "number" && id > 0) return `策略 #${id}`;
  return String(name ?? "未命名策略").trim() || "未命名策略";
}
