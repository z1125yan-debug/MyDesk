// P15-R20b 见顶压力分 —— 纯核（零 IO、零时钟：所有读数与日期标签由调用方喂进来）
//
// 这一份要解决的问题：仓里原有五条风险阈值（`sentiment.ts`）是「或」的逻辑——任何一条读数差就能把
// 档位抬到「偏高」，但**没有任何一条规则能到「高风险」**，R20a 才用「同拍 ≥2 条偏高级读数」补活。
// 阈值档位回答的是「此刻哪几条读数难看」，见顶要回答的是另一件事：
// **高位、缩量、接力撤退、外盘压着，这几件事叠在一起有多厚**。所以这里不改那五条阈值，
// 而是把六组已有读数各自折成 0–100 的「压力」，再按权重合成分档——分档仍然只用
// 正常/注意/偏高/高风险 这四个既有词，不另立一套档位、不新增一级菜单。
//
// 权重与分量的映射照 `market-top-warning-plan.md` §L4（蓝本 tradermonty/claude-trading-skills
// @market-top-detector 的六分量骨架，数据源全换成我们自产的）：
//   炸板率+涨跌停 25 / 接力(晋级率+梯队断层) 20 / 龙头滞涨 15 / 宽度骤降 15 / 主力资金 15 / 外盘催化 10
//
// 四条写死的规矩（跟项目一贯的「缺读数 ≠ 0」同源）：
// 1) **分量内取最差的一条子读数，不加起来**。炸板率和跌停家数经常是同一件事的两面，
//    相加会把一次坏消息记成两次。分量之间才按权合。
// 2) **读不到的分量整块退出，权重摊给其余分量**（renormalize），并在 `dropped` 里逐条说原因。
//    缺读数当 0 分会把「今天没数据」洗成「今天很安全」，这是这套分最不能犯的错。
// 3) **可用分量少于 3 条不出档**（`MIN_COMPONENTS_FOR_TIER`）：两条读数拼出来的 0–100 是噪声。
// 4) 每个分量都带 `as_of` 标签：名单是 09-24 的、宽度是收盘位、美股行情时刻是美东的隔夜——
//    不把不同时间的数混成一个「今天」。
//
// 刻度（哪档值多少分）是**本机定的**，不是交易所规则；每条锚点都写在 anchor 表里，
// 要改只改这一处，页面与接口都拿不到第二份刻度。

import type { Divergence } from "../data/overseas-core.ts";
import type { Ladder, LeaderStall, PromotionResult } from "./limit-up-roster-core.ts";

/** 六分量权重（合计 100）。顺序即页面呈现顺序：先看情绪、再看接力、最后看外盘 */
export const PRESSURE_WEIGHTS = {
  breaker: 25,
  relay: 20,
  leader: 15,
  breadth: 15,
  flow: 15,
  overseas: 10,
} as const;

export type PressureKey = keyof typeof PRESSURE_WEIGHTS;

export const PRESSURE_NAMES: Record<PressureKey, string> = {
  breaker: "炸板与涨跌停",
  relay: "接力（晋级率/梯队）",
  leader: "龙头滞涨",
  breadth: "宽度骤降",
  flow: "主力资金净额",
  overseas: "外盘与 A50",
};

/** 档位带：沿用原有四个词，不另立档位。边界含下不含上（30 分即「注意」） */
export const PRESSURE_BANDS: { min: number; tier: "正常" | "注意" | "偏高" | "高风险" }[] = [
  { min: 70, tier: "高风险" },
  { min: 50, tier: "偏高" },
  { min: 30, tier: "注意" },
  { min: 0, tier: "正常" },
];

export function tierOfPressureScore(score: number): "正常" | "注意" | "偏高" | "高风险" {
  for (const b of PRESSURE_BANDS) if (score >= b.min) return b.tier;
  return "正常";
}

/** 可用分量少于这个条数就不出档（详见文件头规矩 3） */
export const MIN_COMPONENTS_FOR_TIER = 3;

/**
 * 锚点插值：端点外夹紧、中间线性内插。
 * 为什么不直接用阈值开关：0–100 的刻度要能表达「差一点到阈值」和「差很远」的差别，
 * 阈值开关只能回答是/否，一条读数就跳 25 分。
 *
 * `points` 内部先按 x 升序排一次：表是**按「压力从小到大」的语义写的**（比如 1进2 那条写的是
 * 30%→0 分、0%→90 分，读起来是「越松到越紧」），x 轴因此可能是降序。不排序时端点夹紧会把
 * 降序表的最松端当成下界，21% 这种正常读数直接落到 0 分上——刻度错得很安静，必须在这儿挡住。
 */
export function ramp(points: readonly (readonly [number, number])[], v: number): number {
  if (!points.length) return 0;
  if (!Number.isFinite(v)) return points[0][1];
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const first = pts[0];
  if (v <= first[0]) return first[1];
  const last = pts[pts.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (v <= x1) return y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

// ---------- 各分量的锚点表（改刻度只改这里） ----------

/** 炸板率 %：>40% 是原有阈值里的「偏高」级，所以 40 折 60 分，与档位带对齐 */
const ANCHOR_BREAK_RATE: (readonly [number, number])[] = [[15, 0], [25, 25], [40, 60], [55, 85], [70, 100]];
/** 涨跌停对比：跌停家数 ÷ 涨停家数，比值 ≥1（跌停反超）就是原有阈值里的「偏高」级 → 60 分 */
const ANCHOR_LD_RATIO: (readonly [number, number])[] = [[0, 0], [0.3, 20], [0.6, 45], [1, 60], [2, 100]];
/** 1 进 2 晋级率 %：A 股常态在 10~25%，跌破 5% 就是接力资金撤退 */
const ANCHOR_PROMO_RATE: (readonly [number, number])[] = [[30, 0], [20, 25], [10, 55], [5, 75], [0, 90]];
/** 梯队断层个数：高标与低位之间空了几档 */
const ANCHOR_GAPS: (readonly [number, number])[] = [[0, 0], [1, 30], [2, 55], [3, 75], [4, 90]];
/** 龙头组中位 − 全A中位（百分点）：−1.5 是判「滞涨」的阈值 → 60 分 */
const ANCHOR_LEADER_GAP: (readonly [number, number])[] = [[-5, 100], [-3, 85], [-1.5, 60], [0, 30], [1.5, 10], [3, 0]];
/** 宽度 4 日斜率（百分点）：09-21 89.52 → 09-24 27.56 这类塌方是 −60 量级 */
const ANCHOR_BREADTH_SLOPE: (readonly [number, number])[] = [[0, 0], [-10, 20], [-25, 45], [-40, 70], [-60, 90], [-75, 100]];
/** 全 A 主力净额（亿）：−300 是原有「注意」档、−500 是「偏高」档，两个数分别折 40 / 60 分 */
const ANCHOR_MAIN_NET: (readonly [number, number])[] = [[0, 0], [-150, 20], [-300, 40], [-500, 60], [-800, 85], [-1200, 100]];
/** A50 期货涨跌幅 %：−0.5 是判「外盘弱」的阈值 → 25 分起步 */
const ANCHOR_A50: (readonly [number, number])[] = [[-0.3, 0], [-0.5, 25], [-1, 55], [-2, 85], [-3, 100]];
/** 隔夜纳指/半导体跌幅 %：A50 读不到时才用它，且要求不是陈到一周前的读数 */
const ANCHOR_US_TECH: (readonly [number, number])[] = [[-1, 0], [-1.5, 30], [-2.5, 60], [-4, 90]];
/** 隔夜读数超过这个天数就不用了：正常周末 + 一天假期是 3~4 天，再多就不是「隔夜」而是「上周」 */
export const US_STALE_DAYS = 4;

// ---------- 输入形状（都由取数层/上游纯核产好喂进来） ----------

export interface PressureBreakerIn {
  break_rate: number | null;
  touched: number | null;
  limit_up: number | null;
  limit_down: number | null;
  /** 全 A 快照是盘中的还是收盘的，取数层给一句人话标签 */
  as_of: string;
}

export interface PressureRelayIn {
  promotion: PromotionResult | null;
  ladder: Ladder | null;
  /** 名单所属日期（库里最新一天，不等于「今天」） */
  roster_date: string | null;
}

export interface PressureBreadthIn {
  /** 4 个交易日里的变化（百分点，负=往下掉）；拿不到就是 null，不补 0 */
  slope_pt: number | null;
  from_pct: number | null;
  to_pct: number | null;
  from_date: string | null;
  to_date: string | null;
  reason: string;
}

export interface PressureFlowIn {
  main_net_yi: number | null;
  /** 全 A 快照里真实带 mainNet 字段的家数：0 家 = 这个数根本没读到，不是「净额为 0」 */
  known: number;
  universe: number;
  as_of: string;
  /**
   * 另一路「口径不同」的净额读数——通达信逐笔自算只能覆盖成交额前 N 只（本机实测 N=60），
   * 不是全 A 合计。它**不参与打分**（同一把锚点不能量两种票池），只在退出时把数亮出来，
   * 免得读的人以为「主力净额这格什么都没有」。
   */
  alt?: { sum_yi: number; universe: number; known: number; note: string } | null;
}

export interface PressureInputs {
  /** 北京时间戳，由调用方给（纯核不看钟） */
  as_of: string;
  breaker: PressureBreakerIn;
  relay: PressureRelayIn;
  leader: LeaderStall | null;
  breadth: PressureBreadthIn;
  flow: PressureFlowIn;
  overseas: { divergence: Divergence | null; us_age_days: number | null; a50_as_of: string };
  /** 原有五阈值的档位，用来做对照（不参与打分） */
  threshold_level: string | null;
}

// ---------- 输出形状（服务端与客户端共用这一份定义） ----------

export interface PressureComponent {
  key: PressureKey;
  name: string;
  weight: number;
  /** 0–100 的压力；available=false 时为 null */
  score: number | null;
  available: boolean;
  /** 一行读数（人话，页面原样显示） */
  reading: string;
  /** 这个读数属于哪个时间：收盘位 / 名单日期 / 上游原样时刻 */
  as_of: string;
  /** 不可用的原因，或可用但要交代的边界（覆盖率、隔夜、缺几只） */
  reason: string;
  /** 这一分取自哪条子读数（分量内取最差，见文件头规矩 1） */
  from: string;
}

export interface TopPressure {
  as_of: string;
  /** 加权后的 0–100；可用分量不足 3 条时是 null（不猜一个分） */
  score: number | null;
  tier: "正常" | "注意" | "偏高" | "高风险" | "";
  line: string;
  components: PressureComponent[];
  /** 退出的分量及其原因（页面按条显示） */
  dropped: string[];
  /** 可用分量的权重合计（100 = 六分量全在） */
  available_weight: number;
  /** 有没有把权重摊给其余分量 */
  renormalized: boolean;
  /** 与原有五阈值档位的关系（只对照、不改档） */
  crosscheck: string;
  basis: string;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const signed = (v: number, digits = 2): string => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

function comp(
  key: PressureKey, score: number | null, args: { available: boolean; reading: string; as_of: string; reason?: string; from?: string },
): PressureComponent {
  return {
    key,
    name: PRESSURE_NAMES[key],
    weight: PRESSURE_WEIGHTS[key],
    score: score === null ? null : round1(Math.max(0, Math.min(100, score))),
    available: args.available,
    reading: args.reading,
    as_of: args.as_of,
    reason: args.reason ?? "",
    from: args.from ?? "",
  };
}

function breakerScore(i: PressureBreakerIn): PressureComponent {
  if (i.break_rate === null || i.touched === 0) {
    return comp("breaker", null, {
      available: false,
      reading: `触板 ${i.touched ?? "无读数"} 家、涨停 ${i.limit_up ?? "无读数"} 家、跌停 ${i.limit_down ?? "无读数"} 家`,
      as_of: i.as_of,
      reason: i.touched === 0
        ? "今日触板数为 0：炸板率没有分母，涨跌停比也读不到 → 这一格整块退出"
        : "全 A 快照里没读到触板/封板判定（缺 high 或 prevClose）→ 这一格整块退出",
    });
  }
  const br = ramp(ANCHOR_BREAK_RATE, i.break_rate);
  const from = [`炸板率 ${i.break_rate.toFixed(1)}% → ${round1(br)} 分`];
  let score = br;
  if (i.limit_up !== null && i.limit_down !== null && i.limit_up > 0) {
    const lr = ramp(ANCHOR_LD_RATIO, i.limit_down / i.limit_up);
    from.push(`跌停/涨停 ${(i.limit_down / i.limit_up).toFixed(2)} → ${round1(lr)} 分`);
    if (lr > score) score = lr;
  } else if (i.limit_down !== null && i.limit_down > 0) {
    // 涨停 0 家而跌停有票：分母为 0 不折成「比值无穷大」，按跌停反超这一最坏档记 60 分，并说明为什么
    score = Math.max(score, 60);
    from.push("涨停 0 家、跌停有票：比值算不出来，按「跌停反超」这一档记 60 分");
  }
  return comp("breaker", score, {
    available: true,
    reading: `触板 ${i.touched ?? "—"} 家、炸板 ${((i.break_rate / 100) * (i.touched ?? 0)).toFixed(0)} 家（${i.break_rate.toFixed(1)}%）、涨停 ${i.limit_up ?? "—"} / 跌停 ${i.limit_down ?? "—"}`,
    as_of: i.as_of,
    from: from.join(" ｜ ") + " → 分量内取更差的一档",
  });
}

function relayScore(i: PressureRelayIn): PressureComponent {
  const p = i.promotion;
  if (!p || !p.computed) {
    return comp("relay", null, {
      available: false,
      reading: `名单最新一天 ${i.roster_date ?? "无"}`,
      as_of: i.roster_date ?? "—",
      reason: `接力读不出来：${p?.reason || "库里没有两份可比的涨停名单"}（收盘后 15:20 的沉淀跑过之后才有）`,
    });
  }
  const subs: { s: number; why: string }[] = [];
  const unread: string[] = [];
  const one = p.oneToTwo.rate;
  // 分母为 0 的那一档**不给分也不给 0 分**：昨日 0 只首板和昨日首板全灭是两件事，
  // 后者才是坏消息，前者只是没有可读的接力样本（见本文件规矩 2）。
  if (one !== null) subs.push({ s: ramp(ANCHOR_PROMO_RATE, one), why: `1进2 ${one.toFixed(0)}%（${p.oneToTwo.promoted}/${p.oneToTwo.base} 家）` });
  else unread.push("1进2 昨日 0 家（无分母）");
  const three = p.threePlus.rate;
  if (three !== null) subs.push({ s: ramp(ANCHOR_PROMO_RATE, three), why: `3板以上续住 ${three.toFixed(0)}%（${p.threePlus.promoted}/${p.threePlus.base} 家）` });
  else unread.push("3板以上昨日 0 家（无分母）");
  const gaps = i.ladder?.gaps.length ?? 0;
  if (i.ladder) subs.push({ s: ramp(ANCHOR_GAPS, gaps), why: gaps ? `梯队断 ${i.ladder.gaps.join("/")} 板` : "梯队连续" });
  if (!subs.length) {
    return comp("relay", null, {
      available: false,
      reading: `名单最新一天 ${i.roster_date ?? "无"}`,
      as_of: i.roster_date ?? "—",
      reason: `接力各档都没有分母：${unread.join("、") || "昨日名单为空"} → 这一格整块退出（不是「接力全断」）`,
    });
  }
  const worst = subs.reduce((a, b) => (b.s > a.s ? b : a), subs[0]);
  return comp("relay", worst.s, {
    available: true,
    reading: subs.map((s) => s.why).join(" · ") + ` · 最高 ${i.ladder?.highest ?? "—"} 板`,
    as_of: `${i.roster_date ?? "—"} 名单（收盘位）`,
    reason: unread.length ? `${unread.join("、")}：这些档位不进打分，只说明样本从哪来` : "",
    from: `最差的一条：${worst.why}`,
  });
}

function leaderScore(l: LeaderStall | null): PressureComponent {
  if (!l || !l.available || l.gap === null) {
    return comp("leader", null, {
      available: false,
      reading: l ? `龙头组 ${l.sample} 只、读到 ${l.read} 只` : "没有龙头组读数",
      as_of: l?.date ?? "—",
      reason: l?.reason || "库里没有昨日涨停名单，龙头梯队取不出来 → 这一格整块退出",
    });
  }
  return comp("leader", ramp(ANCHOR_LEADER_GAP, l.gap), {
    available: true,
    reading: l.line,
    as_of: `${l.date ?? "—"} 梯队 × 今日盘中涨幅`,
    reason: l.reason,
    from: `龙头中位 − 全A中位 = ${signed(l.gap)} 个百分点`,
  });
}

function breadthScore(i: PressureBreadthIn): PressureComponent {
  if (i.slope_pt === null) {
    return comp("breadth", null, {
      available: false,
      reading: `站上5日线占比 ${i.to_pct === null ? "无读数" : `${i.to_pct.toFixed(1)}%`}`,
      as_of: i.to_date ?? "—",
      reason: i.reason || "宽度至少要两个可比的交易日才谈得上「骤降」，攒够之前这一格退出",
    });
  }
  return comp("breadth", ramp(ANCHOR_BREADTH_SLOPE, i.slope_pt), {
    available: true,
    reading: `站上5日线占比 ${i.from_pct?.toFixed(1) ?? "—"}%（${i.from_date ?? "—"}）→ ${i.to_pct?.toFixed(1) ?? "—"}%（${i.to_date ?? "—"}），${signed(i.slope_pt, 1)} 个百分点`,
    as_of: `${i.to_date ?? "—"} 收盘位`,
    reason: i.reason,
    from: `${i.from_date ?? "—"} → ${i.to_date ?? "—"} 的落差（只看收盘价位，不含今日盘中）`,
  });
}

function flowScore(i: PressureFlowIn): PressureComponent {
  const alt = i.alt && Number.isFinite(i.alt.sum_yi)
    ? `另一路能读到的只有通达信口径：成交额前 ${i.alt.universe} 只自算合计 ${signed(i.alt.sum_yi, 0)} 亿（${i.alt.known} 只取到逐笔）`
    : "";
  if (i.main_net_yi === null || i.known === 0) {
    return comp("flow", null, {
      available: false,
      reading: `全 A ${i.universe} 家里真实带主力净额字段的 ${i.known} 家${alt ? `。${alt}——票池不同，不并进这把锚点` : ""}`,
      as_of: i.as_of,
      reason: i.known === 0
        ? "全 A 快照一家都没读到 mainNet（东财榜单接口断源、腾讯兜底不带该字段）："
          + "那个「0 亿」是 ?? 0 累出来的，不是「今日主力净额为 0」→ 这一格整块退出"
        : "没读到主力净额 → 这一格整块退出",
    });
  }
  return comp("flow", ramp(ANCHOR_MAIN_NET, i.main_net_yi), {
    available: true,
    reading: `全 A 主力净额 ${signed(i.main_net_yi, 0)} 亿（${i.known}/${i.universe} 家有读数）`,
    as_of: i.as_of,
    reason: i.known < i.universe ? `缺 ${i.universe - i.known} 家的净额字段，合计只算了有读数的这些家` : "",
    from: `${signed(i.main_net_yi, 0)} 亿在锚点表上的位置`,
  });
}

function overseasScore(i: PressureInputs["overseas"]): PressureComponent {
  const d = i.divergence;
  if (!d || (d.a50_pct === null && d.us_tech_pct === null)) {
    return comp("overseas", null, {
      available: false,
      reading: `A50 ${d?.a50_pct === null || !d ? "无读数" : signed(d.a50_pct) + "%"}、隔夜科技 ${d?.us_tech_pct == null ? "无读数" : signed(d.us_tech_pct) + "%"}`,
      as_of: i.a50_as_of,
      reason: "外盘与期货都没有读数：背离判不了，这一格整块退出（不是「外盘没有压力」）",
    });
  }
  const parts: string[] = [];
  let raw = 0;
  let used = 0; // 真正进了这把锚点的子读数条数
  if (d.a50_pct !== null) {
    raw = Math.max(raw, ramp(ANCHOR_A50, d.a50_pct));
    parts.push(`A50 ${signed(d.a50_pct)}%`);
    used++;
  }
  const usUsable = d.us_tech_pct !== null && (i.us_age_days === null || i.us_age_days <= US_STALE_DAYS);
  if (d.us_tech_pct !== null) {
    if (usUsable) {
      raw = Math.max(raw, ramp(ANCHOR_US_TECH, d.us_tech_pct));
      parts.push(`纳指/半导体 ${signed(d.us_tech_pct)}%`);
      used++;
    } else {
      parts.push(`纳指/半导体 ${signed(d.us_tech_pct as number)}% 距今 ${i.us_age_days} 天，超出隔夜窗口，不用这条`);
    }
  }
  // A50 没读到、唯一的外盘读数又是几天前的：这条分量手里**什么都没用上**。
  // 让它带着 0 分留在合成分里，等于用 10 的权重把总分往「正常」拽——正是文件头规矩 2 禁的那种洗白
  // （缺读数当 0 分）。所以这里整块退出，读数原样摆在 reading 里给人看。
  if (!used) {
    return comp("overseas", null, {
      available: false,
      reading: parts.join(" · "),
      as_of: i.a50_as_of,
      reason: "能读到的外盘只有几天前的隔夜美股，A50 当天没数：它不是「隔夜催化」，不进打分 → 这一格整块退出（不是「外盘没有压力」）",
    });
  }
  // 同一件外盘压力不能既算「外盘跌」又算「A 股跟着跌」：同向时减半，前瞻时才按满额记（方案 §L1 的原话）
  const factor = d.not_priced_in ? 1 : d.kind === "外盘与A股同向下跌" ? 0.5 : 0;
  const score = raw * factor;
  return comp("overseas", score, {
    available: true,
    reading: parts.join(" · ") + ` → ${d.kind}`,
    as_of: i.a50_as_of,
    reason: factor === 0.5 ? "A 股当天已跟着跌：这格按半额记，同一件事不扣两次"
      : factor === 0 ? "外盘不差而 A 股自己弱（或两者同向不弱）：外盘这格不加分" : "",
    from: d.line,
  });
}

/** 与原有五阈值档位的关系：只对照，不改任何一边的档 */
function crosscheckLine(tier: string, thresholdLevel: string | null): string {
  if (!thresholdLevel) return "五阈值那边没有读数可对照，本档只看压力分";
  const order = ["正常", "注意", "偏高", "高风险"];
  if (!tier) return "压力分这边读数不足，不出档；档位以五阈值那边为准";
  const diff = order.indexOf(tier) - order.indexOf(thresholdLevel);
  if (diff === 0) return `与五阈值档位一致（都是「${tier}」）`;
  const dir = diff > 0 ? "高" : "低";
  return `比五阈值档位${dir}一档（五阈值：${thresholdLevel}）。两边看的不是同一件事：阈值问「此刻哪几条读数难看」，`
    + "压力分问「这几件事叠得厚不厚」。取更保守的那一档看，也就是档位词里较高的那个。";
}

/** 六分量合成：这是整个 R20b 唯一出「分」的地方 */
export function topPressure(inputs: PressureInputs): TopPressure {
  const components: PressureComponent[] = [
    breakerScore(inputs.breaker),
    relayScore(inputs.relay),
    leaderScore(inputs.leader),
    breadthScore(inputs.breadth),
    flowScore(inputs.flow),
    overseasScore(inputs.overseas),
  ];
  const live = components.filter((c) => c.available && c.score !== null);
  const dropped = components.filter((c) => !c.available).map((c) => `${c.name}：${c.reason || "读数不足"}`);
  const available_weight = live.reduce((s, c) => s + c.weight, 0);
  const renormalized = live.length !== components.length;

  if (live.length < MIN_COMPONENTS_FOR_TIER) {
    return {
      as_of: inputs.as_of,
      score: null,
      tier: "",
      line: `见顶压力：算不出——六分量里只有 ${live.length} 条读得出数（少于 ${MIN_COMPONENTS_FOR_TIER} 条不出档）。`
        + `可用权重 ${available_weight}/100。缺的是：${dropped.join("；") || "无"}`,
      components,
      dropped,
      available_weight,
      renormalized,
      crosscheck: crosscheckLine("", inputs.threshold_level),
      basis: "六分量加权 0–100：炸板涨跌停 25 / 接力 20 / 龙头滞涨 15 / 宽度骤降 15 / 主力净额 15 / 外盘 10；"
        + "读不到的分量整块退出、权重摊给其余分量，缺读数不当中性",
    };
  }

  const total = live.reduce((s, c) => s + c.weight * (c.score as number), 0) / available_weight;
  const score = round1(total);
  const tier = tierOfPressureScore(score);
  const worst = [...live].sort((a, b) => (b.score as number) - (a.score as number)).slice(0, 2);
  return {
    as_of: inputs.as_of,
    score,
    tier,
    line: `见顶压力 ${score.toFixed(1)}/100 → ${tier}。主要压力来自：`
      + worst.map((c) => `${c.name} ${c.score?.toFixed(0)} 分`).join("、")
      + (renormalized ? `（${components.length - live.length} 条读数缺失，权重已摊给其余 ${live.length} 条）` : "（六分量全在）"),
    components,
    dropped,
    available_weight,
    renormalized,
    crosscheck: crosscheckLine(tier, inputs.threshold_level),
    basis: "六分量加权 0–100：炸板涨跌停 25 / 接力 20 / 龙头滞涨 15 / 宽度骤降 15 / 主力净额 15 / 外盘 10；"
      + "分量内取最差子读数、分量间加权；档位词沿用原有那四个，不另立一套",
  };
}
