// P13 门户轮：因子 pill 中文化的展示纯核（零 IO，node --test 可直跑）。
//
// 为什么要这一层：选股引擎/回测 Tab 的因子 pill 原来直接印 `factorKey@version`
// （如 zsb_dealer@1）——那是存储协议不是用户语言。QuantFactor 落库时本来就带中文 name
// 与英文 category，这里只做两件事：①给英文类目一份中文读法（DB 类目集与
// quant/types.FACTOR_CATEGORIES 同源九个，测试钉覆盖对账）；②按类目分组出渲染形状。
// **选择串（value）仍是 key@version**——pill 只是换脸，API 协议一个字都不动；
// name 缺失/等于 key 的旧条目回退显示 key（不硬翻译出一个假中文名）。

export const FACTOR_CATEGORY_ZH: Record<string, string> = {
  Price: "价格形态",
  Volume: "量能",
  Momentum: "动量",
  Trend: "趋势",
  Reversal: "反转",
  Volatility: "波动",
  Fundamental: "基本面",
  Microstructure: "微观结构",
  AI_Discovered: "AI 发现",
};

export interface PillFactor {
  factorKey: string;
  version: number;
  name?: string;
  category?: string;
}

export interface PillGroup {
  category: string;
  label: string;
  factors: PillFactor[];
}

/** pill 主文案：中文名优先；没有中文名（旧条目/挖掘器没给 name）就如实回退 key */
export function pillLabel(f: PillFactor): string {
  const name = (f.name ?? "").trim();
  return name && name !== f.factorKey ? name : f.factorKey;
}

/** pill 悬停详情：存储协议照旧可见——中文化不是藏身份，换个说法而已 */
export function pillTitle(f: PillFactor): string {
  return `${f.factorKey}@${f.version}${f.category ? ` · ${FACTOR_CATEGORY_ZH[f.category] ?? f.category}` : ""}`;
}

/** 按类目分组（组内保持传入顺序=latestOnly 的库序；未知类目原样成组、不丢条目） */
export function groupFactorsByCategory(factors: PillFactor[]): PillGroup[] {
  const groups = new Map<string, PillFactor[]>();
  for (const f of factors) {
    const cat = f.category ?? "";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(f);
  }
  // 已知类目按 FACTOR_CATEGORY_ZH 声明序排，未知类目（含空）垫底、彼此按首次出现序
  const known = Object.keys(FACTOR_CATEGORY_ZH);
  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return 0;
  });
  return ordered.map((category) => ({
    category,
    label: FACTOR_CATEGORY_ZH[category] ?? (category || "未分类"),
    factors: groups.get(category)!,
  }));
}
