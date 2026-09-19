// 全球事件关键词分级 + 产业链映射（纯逻辑）
export interface ThemeMapItem {
  id: string;
  category: string;
  levelHint: string;
  keywords: string[];
  sectors: string[];
  concepts: string[];
}

export interface EventMatch {
  title: string;
  time: string;
  themeId: string | null;
  category: string;
  level: string;
  mappedSectors: string[];
  mappedConcepts: string[];
  matchedKeywords: string[];
}

export function classifyNewsTitle(title: string, time: string, themes: ThemeMapItem[]): EventMatch {
  const hits: { theme: ThemeMapItem; keys: string[] }[] = [];
  for (const t of themes) {
    const keys = t.keywords.filter((k) => k && title.includes(k));
    if (keys.length) hits.push({ theme: t, keys });
  }
  if (!hits.length) {
    return {
      title, time, themeId: null, category: "未映射",
      level: "普通新闻", mappedSectors: [], mappedConcepts: [], matchedKeywords: [],
    };
  }
  hits.sort((a, b) => b.keys.length - a.keys.length || b.theme.keywords.length - a.theme.keywords.length);
  const best = hits[0];
  let level = best.theme.levelHint;
  if (best.keys.length >= 2 && level === "行业新闻") level = "重要行业事件";
  if (best.keys.length >= 2 && level === "重要行业事件") level = "重大产业事件";
  return {
    title, time,
    themeId: best.theme.id,
    category: best.theme.category,
    level,
    mappedSectors: best.theme.sectors,
    mappedConcepts: best.theme.concepts,
    matchedKeywords: best.keys,
  };
}

export type FundStage = "主题早期" | "扩散阶段" | "已充分反应" | "无资金验证";

export function fundStage(opts: {
  boardHits: { name: string; changePct: number; mainYi: number; rank: number }[];
}): { stage: FundStage; note: string } {
  if (!opts.boardHits.length) return { stage: "无资金验证", note: "板块榜未匹配到映射名称，无法用资金验证" };
  const top = opts.boardHits[0];
  if (top.rank <= 8 && top.changePct >= 2 && top.mainYi > 0) {
    return { stage: "扩散阶段", note: `${top.name} 涨幅前列且主力净流入` };
  }
  if (top.mainYi > 0 && top.changePct < 1.2) {
    return { stage: "主题早期", note: `${top.name} 已有资金流入但涨幅尚未充分扩散` };
  }
  if (top.changePct >= 3 && top.mainYi <= 0) {
    return { stage: "已充分反应", note: `${top.name} 涨幅已高但当日主力净流出/同步性弱` };
  }
  if (top.mainYi > 0) return { stage: "主题早期", note: `${top.name} 主力净流入` };
  return { stage: "无资金验证", note: `匹配到 ${top.name}，但主力净额未显示流入` };
}
