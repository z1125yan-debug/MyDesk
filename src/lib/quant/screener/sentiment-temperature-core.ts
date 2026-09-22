// P11 情绪温度纯内核：把大盘情绪的一堆读数收敛成一个 0-100 的「情绪温度」，权重随行情类型（牛/熊/震荡）切换。
// 零 IO、无时钟、node --test 可直跑；服务端与 MarketPage 前端消费同一份（缺分量缩权的口径只在这里定一次）。
//
// 权重模型出处：稳智AI（aiwuchuan.com）前端 Home-DmQhpRbI.js 逆向（文档《大盘情绪页对齐稳智-修改意见》）：
//   牛市 = 宽度35 / 动量40 / 投机15 / 资金流10；熊市 = 25 / 20 / 40 / 15；震荡 = 30 / 30 / 25 / 15。
// 逆向文档写的「高于5日线占比」我们没有全 A 逐票 MA5 现成读数（要 5000+ 票逐只取 K，冷跑分钟级），
// 市场宽度用涨跌家数占比代替——同为 0-100 的宽度口径，注释与读数文案都写明实际用了什么，不冒充 5 日线口径。
//
// 三条硬口径（与本仓库 P7 打分表纪律同源）：
//  1) **缺读数 = 分量 null，不是 0 分**。某分量算不出就把它的权重从分母里拿掉（缩权），
//     绝不把「没读到」当成「今天这项是 0 分」。全部缺 ⇒ temperature=null + missing 说明，不硬造。
//  2) main_net_known===0 时资金流分量必为 null：SentimentResult 的 main_net_sum_yi 是 `?? 0` 累加，
//     字段全缺时同样是 0——拿它算分会把「断源」粉饰成「中性 50 分」。
//  3) 各分量的归一化常数（饱和线、斜率）是本层补的口径，不是稳智原文；全部以导出常量出现，测试与文案可指认。
// 带 .ts 后缀是 node --test 直跑的前提（与 pick-pool-core / market-score-core 同一套写法）。

export type MarketRegime = "bull" | "bear" | "range";

export const REGIMES: { key: MarketRegime; label: string }[] = [
  { key: "range", label: "震荡行情" },
  { key: "bull", label: "牛市行情" },
  { key: "bear", label: "熊市行情" },
];

/** 稳智逆向的四分量权重（百分数，同一行情类型内和为 100；缩权时分母用可算项之和） */
export const TEMPERATURE_WEIGHTS: Record<MarketRegime, { breadth: number; momentum: number; speculation: number; flow: number }> = {
  bull: { breadth: 35, momentum: 40, speculation: 15, flow: 10 },
  bear: { breadth: 25, momentum: 20, speculation: 40, flow: 15 },
  range: { breadth: 30, momentum: 30, speculation: 25, flow: 15 },
};

/* ---------- 分量归一化常数（本层补的口径，钉测与文案指认这里） ---------- */

/** 动量：中位涨跌幅 ±MOMENTUM_SAT_PCT% 饱和到 0/100（斜率 = 50/SAT） */
export const MOMENTUM_SAT_PCT = 5;
/** 投机-涨跌停净差：±LIMITNET_SAT 家饱和（60 家净差即视为极端） */
export const LIMITNET_SAT = 60;
/** 投机-炸板率：0% → 100，100% → 0（线性） */
/** 资金流：全 A 主力净额 ±FLOW_SAT_YI 亿饱和到 0/100 */
export const FLOW_SAT_YI = 500;

export interface TempComponent {
  key: "breadth" | "momentum" | "speculation" | "flow";
  label: string;
  /** 0-100；null = 本分量算不出（缺读数，不是 0 分） */
  score: number | null;
  /** 该行情类型下的名义权重（百分数） */
  weight: number;
  /** 实际参与加权时的缩权后权重（score 为 null 时恒 0） */
  effective_weight: number;
  /** 用了哪些读数的原始值说明（页面/对话都摆这个，保证「分数怎么来的」可追问） */
  raw: string;
  /** score 为 null 时为什么（缺什么，绝不说成 0） */
  missing_note: string;
}

export interface TemperatureInput {
  advancers: number | null;
  decliners: number | null;
  /** 全 A 中位涨跌幅（百分数） */
  median_pct: number | null;
  limit_up: number | null;
  limit_down: number | null;
  /** 炸板率百分数；触板 0 家时上游给 null（无定义），必须原样传 null */
  break_rate: number | null;
  /** 全 A 主力净额（亿） */
  main_net_sum_yi: number | null;
  /** 全 A 快照里 mainNet 真实有值的家数；0 ⇒ 上面的合计是 ?? 0 累加，按缺读数处理 */
  main_net_known: number;
}

export interface TemperatureResult {
  regime: MarketRegime;
  regime_label: string;
  /** 0-100 一位小数；全部分量算不出时 null（页面显式「—」，不显示假温度） */
  temperature: number | null;
  label: string; // 冰点/偏冷/中性/偏热/过热；null 时「无读数」
  components: TempComponent[];
  /** 缩权说明（哪些分量没进来、为什么）；全都能算时为空 */
  missing: string[];
}

const clamp01_100 = (x: number): number => Math.min(100, Math.max(0, x));
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** 行情类型入参收口：认不出的（存档被改坏/外部乱传）按震荡默认 */
export function asRegime(value: unknown): MarketRegime {
  return value === "bull" || value === "bear" ? value : "range";
}

/**
 * 计算情绪温度。分量归一化各自独立（见各 case），加权时对可算分量缩权归一：
 * temperature = Σ(score_i × weight_i) / Σ(weight_i)，i 只取 score 非 null 的分量。
 */
export function computeTemperature(input: TemperatureInput, regime: MarketRegime): TemperatureResult {
  const w = TEMPERATURE_WEIGHTS[regime];

  // 宽度：涨跌家数占比（上涨/(涨+跌)×100）。涨跌都 0 ⇒ 无定义，不判中性。
  let breadth: { score: number; raw: string } | null = null;
  {
    const a = input.advancers, d = input.decliners;
    if (typeof a === "number" && typeof d === "number" && a + d > 0) {
      breadth = { score: (a / (a + d)) * 100, raw: `上涨 ${a} 家 / 下跌 ${d} 家 → 上涨占比 ${r1((a / (a + d)) * 100)}%` };
    }
  }

  // 动量：全 A 中位涨跌幅线性映射（0% → 50 分，±MOMENTUM_SAT_PCT% 饱和）。
  let momentum: { score: number; raw: string } | null = null;
  if (typeof input.median_pct === "number") {
    momentum = {
      score: clamp01_100(50 + (input.median_pct / MOMENTUM_SAT_PCT) * 50),
      raw: `全 A 中位涨跌幅 ${input.median_pct > 0 ? "+" : ""}${r1(input.median_pct)}%（±${MOMENTUM_SAT_PCT}% 饱和）`,
    };
  }

  // 投机：涨跌停净差与炸板率两个子读数可算项均值（一个是「有没有赚钱效应」，一个是「封不封得住」）。
  // limit_up/limit_down 是家数计数，0 是真实读数（今天就是没有）；两者都缺才 null。
  let spec: { score: number; raw: string } | null = null;
  {
    const subs: number[] = [];
    const parts: string[] = [];
    if (typeof input.limit_up === "number" && typeof input.limit_down === "number") {
      const net = input.limit_up - input.limit_down;
      subs.push(clamp01_100(50 + (net / LIMITNET_SAT) * 50));
      parts.push(`涨停${input.limit_up}/跌停${input.limit_down}（净差${net > 0 ? "+" : ""}${net}家）`);
    }
    if (typeof input.break_rate === "number") {
      subs.push(clamp01_100(100 - input.break_rate));
      parts.push(`炸板率${r1(input.break_rate)}%`);
    }
    if (subs.length) spec = { score: subs.reduce((a, b) => a + b, 0) / subs.length, raw: `${parts.join("，")} → 子项均值 ${r1(subs.reduce((a, b) => a + b, 0) / subs.length)}` };
  }

  // 资金流：主力净额线性映射；known=0 时合计是 ?? 0 累加的假 0，必按缺读数处理。
  let flow: { score: number; raw: string } | null = null;
  if (typeof input.main_net_sum_yi === "number" && input.main_net_known > 0) {
    flow = {
      score: clamp01_100(50 + (input.main_net_sum_yi / FLOW_SAT_YI) * 50),
      raw: `全 A 主力净额 ${input.main_net_sum_yi > 0 ? "+" : ""}${r1(input.main_net_sum_yi)} 亿（±${FLOW_SAT_YI}亿饱和，${input.main_net_known} 家有真实读数）`,
    };
  }

  const defs: { key: TempComponent["key"]; label: string; weight: number; val: { score: number; raw: string } | null; miss: string }[] = [
    { key: "breadth", label: "市场宽度", weight: w.breadth, val: breadth, miss: "涨跌家数无有效读数（涨跌两家数都缺或同为 0——同为 0 是「0/0 无定义」，不是中性）" },
    { key: "momentum", label: "动量", weight: w.momentum, val: momentum, miss: "全 A 中位涨跌幅缺读数" },
    { key: "speculation", label: "投机", weight: w.speculation, val: spec, miss: "涨跌停家数与炸板率均无读数（炸板率在触板 0 家时无定义，不拿 0% 凑）" },
    { key: "flow", label: "资金流", weight: w.flow, val: flow, miss: input.main_net_known === 0
      ? "全 A 快照没有一家真实带主力净额字段（断源/字段缺失）——合计 0 亿是累加器假象，不按中性计入"
      : "主力净额读数缺失"},
  ];

  const components: TempComponent[] = defs.map((d) => ({
    key: d.key, label: d.label,
    score: d.val ? r1(d.val.score) : null,
    weight: d.weight,
    effective_weight: d.val ? d.weight : 0,
    raw: d.val ? d.val.raw : "",
    missing_note: d.val ? "" : d.miss,
  }));

  const ok = components.filter((c) => c.score !== null);
  const totalW = ok.reduce((a, c) => a + c.weight, 0);
  const missing = ok.length === components.length ? [] : [
    `${components.length - ok.length} 个分量无真实读数未计入（${ok.length ? `权重按可算项缩权归一：${ok.map((c) => `${c.label}${c.weight}/${totalW}`).join("、")}` : "没有任何分量可算"}）`,
    ...components.filter((c) => c.score === null).map((c) => `${c.label}：${c.missing_note}`),
  ];

  const temperature = totalW > 0 ? r1(ok.reduce((a, c) => a + (c.score as number) * c.weight, 0) / totalW) : null;
  return {
    regime, regime_label: REGIMES.find((x) => x.key === regime)!.label,
    temperature, label: temperature === null ? "无读数" : temperatureLabel(temperature),
    components, missing,
  };
}

/** 温度档位（本层补的表达线，只用于文案/配色，不参与计算） */
export function temperatureLabel(t: number): string {
  if (t < 25) return "冰点";
  if (t < 45) return "偏冷";
  if (t < 60) return "中性";
  if (t < 80) return "偏热";
  return "过热";
}

/** 一行摘要（工具上下文/页面副行共用；null 时明说缺什么，不报假数） */
export function temperatureSummary(r: TemperatureResult): string {
  if (r.temperature === null) return `情绪温度：无读数（${r.missing.filter((m) => !m.includes("未计入")).join("；") || "全部分量缺失"}）`;
  const shrunk = r.missing.length ? `（${r.components.filter((c) => c.score === null).map((c) => c.label).join("/")} 缺读未计权，按可算项缩权）` : "";
  return `情绪温度 ${r.temperature}/100 · ${r.label} · ${r.regime_label}${shrunk}`;
}
