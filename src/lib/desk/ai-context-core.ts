// P6-A AI 上下文的数据来源标注（纯内核：不 fetch、不碰库，前端与服务端都能用，node --test 可直跑）。
//
// 为什么必须有这一层（这是修 bug，不是加功能）：
// 原来所有入口的行情上下文都无条件写成「来自本机直连的真实行情接口，视为当前事实」，
// 但同一个上下文里混着三类东西：真实报价、非 A 股品种的演示数据（buildQuote 合成）、
// 以及按真实价锚定出来的假分时序列（syntheticSeries）。模型看到的就是「这些都是事实」，
// priceBandOk 还会拿演示数据里的假价格去判模型幻觉——三重失真叠在一起。
// 这里把「一行上下文属于哪一层」变成显式字段 + 强制文案，页面无从再合并标注。
//
// 口径与 datastatus-core 一致：MISSING ≠ 0，DEMO ≠ 事实，DERIVED 要说是谁算的。

export type Provenance = "REAL" | "DERIVED" | "DEMO" | "MISSING" | "DERIVED_ON_DEMO";

export const PROVENANCE_TEXT: Record<Provenance, string> = {
  REAL: "真实数据：本机直连取到的原始值，可当事实引用",
  DERIVED: "派生数据：本机引擎对真实数据的计算，可引用但要说明是算出来的",
  DEMO: "演示数据：本机合成的展示值，不是行情，禁止当事实或数量级依据",
  MISSING: "缺失：本次没有取到值；不知道就写「缺」，不允许用 0 或估算顶替",
  DERIVED_ON_DEMO: "派生自演示数据：算法本身是真的，但输入是假数据，结论只能当演示",
};

/** 数据纪律原文：随每个上下文块一起注入，模型必须按这个分层作答 */
export const CONTEXT_DISCIPLINE: string[] = [
  "只有标「真实数据」的数值可以直接当事实；标「派生」的要说明是谁算的（本机引擎/历史统计），标「演示数据」「缺失」的一律不得引用为行情。",
  "缺数据就明确写「缺」并说明缺什么，不要用 0、平均值或「通常」填补；历史统计（回测/胜率/IC）不等于今天会怎样。",
  "你自己的判断属于 AI 解释或假设，要用「我认为/可能的解读」这类措辞，不要写成市场事实。",
  "上下文里的时刻是本机取数时刻；休市/收盘时段拿到的是收盘值，不要说成盘中实时。",
];

export interface CtxRow {
  /** 一行标题，例如「寒武纪（688256.SH）」 */
  label: string;
  provenance: Provenance;
  /** 已格式化的数据行（数字必须由调用方从真实来源算好传进来，本层不做计算） */
  lines: string[];
  /** 额外口径说明，例如「分时序列为合成，仅供绘图」 */
  note?: string;
}

/** 报价卡来源判定（missing 优先，其次看是不是演示品种）：泛型只约束用到的字段，调用方可直接传整张 QuoteCard */
export function provenanceOfQuote<C extends { missing?: boolean; data_status?: string; price?: number | null }>(
  card: C | null | undefined,
  isDemoSymbol: boolean,
): Provenance {
  if (!card) return "MISSING";
  if (card.missing || card.data_status === "MISSING") return "MISSING";
  if (card.data_status === "DEMO" || isDemoSymbol) return "DEMO";
  if (card.data_status === "REAL") return "REAL";
  // 没标来源时保守判 MISSING：宁可说没取到，也不把未知来源当事实
  return "MISSING";
}

/** 引擎快照（趋势/RSI/关键位）的来源判定 */
export function provenanceOfTechSnapshot(source: "real" | "demo" | "missing" | null | undefined): Provenance {
  if (source === "demo") return "DERIVED_ON_DEMO";
  if (source === "real") return "DERIVED";
  return "MISSING";
}

/** 只有真实报价才允许当数量级校验的锚点：拿演示价校验 = 用假数据判模型幻觉 */
export function guardPriceOf(provenance: Provenance, price: number | null | undefined): number | null {
  if (provenance !== "REAL") return null;
  return typeof price === "number" && isFinite(price) && price > 0 ? price : null;
}

export function contextHeader(rows: CtxRow[]): string {
  const n = (p: Provenance) => rows.filter((r) => r.provenance === p).length;
  const parts = [
    n("REAL") ? `真实 ${n("REAL")} 条` : "",
    n("DERIVED") ? `派生 ${n("DERIVED")} 条` : "",
    n("DEMO") ? `演示 ${n("DEMO")} 条（不可当事实）` : "",
    n("MISSING") ? `缺失 ${n("MISSING")} 条` : "",
    n("DERIVED_ON_DEMO") ? `派生自演示 ${n("DERIVED_ON_DEMO")} 条` : "",
  ].filter(Boolean);
  return `【行情上下文】（逐条标注来源分层：${parts.join(" / ") || "本次没有取到任何数据"}）`;
}

/** 组装注入模型的上下文文本 */
export function renderMarketContext(rows: CtxRow[], opts: { discipline?: boolean; takenAt?: string } = {}): string {
  const list = rows.filter((r) => r.label);
  if (!list.length) {
    return [
      "【行情上下文】（本次没有取得任何行情数据）",
      "状态：MISSING。请先说明缺什么，不要凭记忆或猜测给出价格、涨跌幅或资金数据。",
    ].join("\n");
  }
  const body = list.map((r) => {
    const head = `- ${r.label}｜${r.provenance}｜${PROVENANCE_TEXT[r.provenance]}`;
    const lines = r.lines.filter(Boolean).map((l) => `    ${l}`);
    const note = r.note ? `    口径：${r.note}` : "";
    return [head, ...lines, note].filter(Boolean).join("\n");
  });
  const out = [contextHeader(list), ...(opts.takenAt ? [`取数时刻（本机）：${opts.takenAt}`] : []), ...body];
  if (opts.discipline !== false) {
    out.push("【数据纪律】");
    CONTEXT_DISCIPLINE.forEach((d, i) => out.push(`${i + 1}. ${d}`));
  }
  return out.join("\n");
}

/** 面板上给人看的一行来源摘要（与注入模型的文案同源，避免两处两种说法） */
export function provenanceBadgeText(p: Provenance): string {
  switch (p) {
    case "REAL": return "真实数据";
    case "DEMO": return "演示数据·非行情";
    case "MISSING": return "本次未取到";
    case "DERIVED_ON_DEMO": return "演示数据上的派生计算";
    default: return "派生计算";
  }
}
