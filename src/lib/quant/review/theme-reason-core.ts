// 主题「理由」纯核（LLM 分析 · 主题热点 Tab）—— 零 IO、无 fetch、无时钟，node --test 直跑。
//
// 骨架照稳智（theme_heat_all_in_one 的 reason 字段逆向 + 本仓 R5 规则版口径）：
//   ① 当日位置（涨跌幅 + 板内涨跌家数 + 领涨股）
//   ② 资金（当日主力净额 + 近 3 个交易日净额 —— 稳智同款 3 日窗，这也是全站主题卡的周期口径）
//   ③ 相对强度（RPS 分位）
//   ④ 热度与趋势标签
//   ⑤ 市场环境匹配（逆势 / 顺势）
//   ⑥ 反证（价涨钱跑、连续流出、板内普跌、热度冰点）
// 每条 = 「读数 → 说明什么」，不是把数字重念一遍。
// 缺哪个维度就整条不生成（不编、不拿别的主题或大盘的数字顶上），全缺时给一句如实说明。
//
// 说人话纪律（延续 R20 plain-talk）：一句话里最多一个术语；术语后面紧跟白话解释。

export interface ThemeReasonInput {
  name: string;
  /** 热度 0~100；null = 没算出来 */
  heat: number | null;
  /** 趋势标签（种子里的 t，如 new） */
  trend?: string | null;
  /** 近 3 个交易日主力净额（亿） */
  fund3Yi: number | null;
  /** 当日主力净额（亿） */
  mainTodayYi: number | null;
  /** 当日涨跌幅（%） */
  changePct: number | null;
  /** 板内上涨家数 */
  upCount: number | null;
  /** 板内下跌家数 */
  downCount: number | null;
  /** 板内涨停家数 */
  limitUpCount?: number | null;
  /** 领涨股 */
  leader?: string | null;
  /** RPS 相对强度分位 0~100 */
  rps: number | null;
  /** 市场阶段（如 退潮反抽） */
  marketPhase: string | null;
  /** 市场桶（如 退潮） */
  marketBucket?: string | null;
}

export interface ThemeReasonLine {
  /** 稳智骨架里的维度名（也是前端的小徽章） */
  key: "position" | "fund" | "strength" | "heat" | "env" | "counter";
  label: string;
  text: string;
}

/** 周期口径说明：全站主题卡统一「近 3 个交易日」，新闻窗口与它同周期 */
export const THEME_REASON_PERIOD_NOTE = "资金与新闻都用「近 3 个交易日」窗口（稳智同款 3 日口径）";

/** 一条理由都生不出来时的如实说明（页面直接展示这句） */
export const THEME_REASON_EMPTY =
  "这个方向本轮的读数不够（涨跌/资金/热度至少要有一样才说得出口），先不给理由，免得拿大盘的数硬凑。";

const TREND_ZH: Record<string, string> = {
  new: "新进",
  up: "升温",
  down: "降温",
  hold: "持平",
};

function trendZh(t: string | null | undefined): string {
  if (!t) return "";
  return TREND_ZH[t] ?? t;
}

function sign(v: number): string {
  return v > 0 ? `净流入 ${v.toFixed(1)} 亿` : v < 0 ? `净流出 ${Math.abs(v).toFixed(1)} 亿` : "基本持平";
}

/**
 * 生成主题理由。规则全部写死在这里便于复核；输入里是 null 的维度整条跳过。
 */
export function themeReasonLines(i: ThemeReasonInput): ThemeReasonLine[] {
  const out: ThemeReasonLine[] = [];
  const name = String(i.name || "该方向");

  // ① 当日位置
  if (typeof i.changePct === "number" && isFinite(i.changePct)) {
    const up = typeof i.upCount === "number" && isFinite(i.upCount) ? i.upCount : null;
    const down = typeof i.downCount === "number" && isFinite(i.downCount) ? i.downCount : null;
    const broad = up !== null && down !== null && up + down > 0;
    const head = `当日${i.changePct >= 0 ? "涨" : "跌"} ${Math.abs(i.changePct).toFixed(2)}%`;
    const mid = broad
      ? `（板内 ${up} 涨 / ${down} 跌${typeof i.limitUpCount === "number" && i.limitUpCount > 0 ? `、涨停 ${i.limitUpCount} 家` : ""}${i.leader ? `、领涨 ${i.leader}` : ""}）`
      : i.leader
        ? `（领涨 ${i.leader}）`
        : "";
    const tail = broad
      ? (down as number) > (up as number) * 3
        ? `：板内是普跌，不是个别票的事，${name}今天整体在被卖。`
        : (up as number) > (down as number) * 3
          ? `：板内普涨，行情是摊开做的，不是一两只票硬拉。`
          : `：涨跌对半，板内分歧明显，选股比选板块重要。`
      : "。";
    out.push({ key: "position", label: "当日位置", text: `${head}${mid}${tail}` });
  }

  // ② 资金（当日 + 近 3 日，稳智 3 日窗）
  if (typeof i.fund3Yi === "number" && isFinite(i.fund3Yi)) {
    const today = typeof i.mainTodayYi === "number" && isFinite(i.mainTodayYi) ? `，当日${sign(i.mainTodayYi)}` : "";
    let tail: string;
    if (i.fund3Yi > 0 && (i.mainTodayYi ?? i.fund3Yi) >= 0) tail = "：钱在持续往里走，行情有资金托着。";
    else if (i.fund3Yi > 0 && (i.mainTodayYi ?? 0) < 0) tail = "：3 日还在流入、当天已转流出——先当获利了结看，别急着当行情结束。";
    else if (i.fund3Yi < 0 && (i.mainTodayYi ?? 0) > 0) tail = "：3 日净流出、当天转流入——有资金回头试，能不能守住要看后面两天。";
    else tail = "：钱在往外走，反弹先按出货对待。";
    out.push({ key: "fund", label: "资金", text: `近 3 个交易日主力净额${sign(i.fund3Yi)}${today}${tail}` });
  } else if (typeof i.mainTodayYi === "number" && isFinite(i.mainTodayYi)) {
    out.push({ key: "fund", label: "资金", text: `当日主力净额${sign(i.mainTodayYi)}（近 3 日合计没取到，只说当天）。` });
  }

  // ③ 相对强度
  if (typeof i.rps === "number" && isFinite(i.rps) && i.rps > 0) {
    out.push({
      key: "strength",
      label: "相对强度",
      text: `RPS ${i.rps.toFixed(0)}（全市场分位）：放在所有板块里，它的近期强度${i.rps >= 80 ? "排在前两成，是当下最强的一批" : i.rps >= 50 ? "在中游，不算突出" : i.rps >= 20 ? "排在后一半" : "排在最弱的一档"}。`,
    });
  }

  // ④ 热度与趋势
  if (typeof i.heat === "number" && isFinite(i.heat)) {
    const tier = i.heat >= 50 ? "核心" : i.heat >= 30 ? "观察" : "回避";
    const t = trendZh(i.trend);
    out.push({
      key: "heat",
      label: "热度",
      text: `热度 ${i.heat}/100，按本地口径归为「${tier}」${t ? `，趋势标签「${t}」` : ""}${i.heat >= 50 ? "：关注的人多，波动也会放大。" : i.heat >= 30 ? "：还没到主线级别，先看着。" : "：暂时没人接力，别逆着冷清硬做。"}`,
    });
  }

  // ⑤ 市场环境
  if (i.marketPhase) {
    const bucket = i.marketBucket ?? "";
    const up = typeof i.changePct === "number" ? i.changePct > 0 : null;
    const tail =
      bucket === "退潮"
        ? up === true
          ? `：大盘在退潮它还能翻红，属于逆势强，但退潮期逆势强也容易被兑现，追高要打折。`
          : `：退潮期高位题材最先被兑现，${name}今天跟着大盘一起被卖，先看资金什么时候停。`
        : bucket === "主升"
          ? `：大盘在主升段，${name}顺势，这时候弱于大盘反而是它自己的问题。`
          : `：大盘处在「${i.marketPhase}」，板块动作先按震荡里的轮动理解，别按单边行情加码。`;
    out.push({ key: "env", label: "市场环境", text: `大盘当前是「${i.marketPhase}」${tail}` });
  }

  // ⑥ 反证（有多少条写多少条，一条都没有就整段缺）
  const counter: string[] = [];
  if (typeof i.changePct === "number" && i.changePct > 0 && typeof i.mainTodayYi === "number" && i.mainTodayYi < 0) {
    counter.push("价涨钱跑：涨幅是空头回补或散户抬的，主力在撤，明天没人接力就容易回吐。");
  }
  if (typeof i.fund3Yi === "number" && i.fund3Yi < 0 && typeof i.mainTodayYi === "number" && i.mainTodayYi < 0) {
    counter.push("资金连续流出：3 日和当日都是净流出，不是单日波动。");
  }
  if (typeof i.upCount === "number" && typeof i.downCount === "number" && i.downCount > i.upCount * 5) {
    counter.push(`板内 ${i.downCount} 跌对 ${i.upCount} 涨（普跌到只剩零星红盘）：${name}整体在走弱。`);
  }
  if (typeof i.heat === "number" && i.heat < 30) {
    counter.push(`热度 ${i.heat} 低于 30：接力的钱不够，这种位置做多容易买在没人接的地方。`);
  }
  if (counter.length) out.push({ key: "counter", label: "反证", text: counter.join(" ") });

  return out;
}
