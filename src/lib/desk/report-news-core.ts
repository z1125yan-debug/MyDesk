// 研报「关联新闻」的匹配与措辞纯核（P65）。零依赖、不发请求、不读时钟。
//
// 口径是怎么定下来的（实测取证，不是拍脑袋）：
// 拿稳智那篇「涨价链与周期出清反内卷」的关联新闻去东财 7x24 归档里逐条对（最近 14 天、去重 8000 条）：
//   · 它写的「快递单票价格同比+4%」→ 归档里 0 命中，而 09-20 11:28 有原帖
//     「快递“反内卷”引发新一轮涨价 多家公司今起安徽区域单票最低上调0.15元」；
//   · 「制冷剂淡季不跌反涨」「钽精矿100→250美元」「钢铁三重底部」「粮食库销比历史低位」→ 全部 0 命中；
//   · 「玻纤电子布连续5个月提价」→ 电子布涨价的原帖在 09-15 / 09-17（比研报日早 7~9 天）。
// 结论：那一栏不是「当日快讯」，是**跨多日、按主线聚合、再被模型改写成证据短句**的东西。
//
// 我们只借「多日窗口」这一层口径（当日快讯确实挂不住主线：单日约 760 条里与某主线相关的常常只有个位数），
// 不借它改写数字的写法 —— 本核交出去的一律是**带完整日期的原标题**，模型只许逐字照抄。
// 这样「关联新闻」是真引用：读者拿标题去搜，能搜到那天那条。

export interface NewsPoolRow {
  /** YYYY-MM-DD：快讯属于哪一天，不许像以前那样只留 HH:MM 冒充「当日」 */
  date: string;
  /** HH:MM（上游原样给，北京时区，不做二次换算） */
  time: string;
  title: string;
}

export interface ThemeNewsHit extends NewsPoolRow {
  /** 命中的关键词（用于说明「为什么算相关」，也方便回查误挂） */
  kw: string;
}

export interface ThemeNewsGroup {
  name: string;
  hits: ThemeNewsHit[];
}

/** 板块/主题名里那些「不是行业词本身」的尾巴：带着它去匹配新闻，命中率会掉一截 */
const NAME_SUFFIXES = ["概念", "板块", "指数", "行业", "产业", "板块指数", "概念股"];

/**
 * 主题名 → 新闻里真会用的说法。只收「A股语境下同一件事的两种写法」这种确定的同义关系，
 * 不收"看着可能相关"的联想（那是模型的活，不是匹配层的活）。
 */
const ALIASES: Record<string, string[]> = {
  内存: ["存储", "DRAM", "内存"],
  存储: ["内存", "存储"],
  光通信: ["光模块", "光通信", "CPO"],
  光模块: ["光通信", "光模块", "CPO"],
  玻璃基: ["玻璃基板", "玻璃基"],
  算力: ["算力", "智算", "数据中心"],
  半导体: ["半导体", "芯片", "晶圆"],
  芯片: ["半导体", "芯片"],
  人工智能: ["人工智能", "AI"],
  AI: ["人工智能", "AI"],
  机器人: ["机器人", "人形机器人"],
  创新药: ["创新药", "医药"],
  固态电池: ["固态电池", "电池"],
};

function norm(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * 一个主题的关键词集合，按「从具体到宽泛」排序（越靠前的越可信）。
 * 规则：全名 → 斜杠复合名拆段（「东数西算/算力」这种要两段都算）→ 去掉概念/板块这类尾巴
 *      → 内置别名 → 前 4 字 → 前 3 字 → 名字里的英文缩写（CPO/PCB 这种）。
 * 长度门槛是防误挂的：4 字以上主题才允许截前缀，且截出来不足 3 字就不要
 * （「人工智能」截 2 字变「人工」会挂上「人工关节」，这种假命中比空着更糟）。
 */
export function themeNewsKeywords(name: string): string[] {
  const n = String(name ?? "").trim();
  if (!n) return [];
  const out: string[] = [];
  const push = (k: string) => {
    const t = k.trim();
    if (t && !out.some((x) => norm(x) === norm(t))) out.push(t);
  };
  // 复合主题名（「东数西算/算力」「光模块(CPO)」这类）：整串在新闻里几乎不会出现，必须拆段
  const variants = [n, ...n.split(/[/、]/).map((s) => s.replace(/[()（）]/g, "").trim()).filter((s) => s && s !== n)];
  for (const v of variants) {
    push(v);
    for (const sfx of NAME_SUFFIXES) {
      if (v.endsWith(sfx) && v.length > sfx.length) push(v.slice(0, v.length - sfx.length));
    }
    for (const a of ALIASES[v] ?? []) push(a);
    if (v.length >= 4) {
      push(v.slice(0, 4));
      push(v.slice(0, 3));
    }
  }
  // 英文缩写：新闻正文写「CPO」而主题名叫「光电共封装CPO」，不抽出来就一条也挂不上
  for (const v of variants) for (const m of v.match(/[A-Za-z][A-Za-z0-9]+/g) ?? []) push(m);
  return out;
}

/**
 * 这条标题命中了该主题的哪个关键词（返回按「最具体优先」排序后的第一个命中词）。
 * 两字母缩写（AI、5G 这类）区分大小写按原文比：不区分的话「AI」会挂上 "detail"、"email" 里的 "ai"。
 */
export function matchedKeyword(title: string, keywords: string[]): string {
  const t = String(title ?? "");
  const tl = norm(t);
  for (const k of keywords) {
    const kk = String(k).trim();
    if (!kk) continue;
    if (/^[A-Za-z0-9]{2}$/.test(kk)) {
      if (t.includes(kk)) return kk;
      continue;
    }
    if (tl.includes(norm(kk))) return kk;
  }
  return "";
}

export interface GroupNewsOptions {
  /** 每条主线最多留几条（默认 8，够研报挑 3 条） */
  perTheme?: number;
}

/**
 * 把多日快讯池按主线分好组，交给模型「这条主线名下有哪些真标题可挑」。
 * 排序：先按命中关键词的可信度（越具体的关键词越前），再按池子原序（新→旧）。
 * 没有命中的主线照样出现在结果里（hits 为空数组）——「这条主线确实没新闻」是要如实写进研报的，
 * 不能因为没匹配上就从清单里抹掉，那样模型看不出哪些主线是无据可依的。
 */
export function groupNewsByTheme(
  themes: string[],
  pool: NewsPoolRow[],
  opts: GroupNewsOptions = {},
): ThemeNewsGroup[] {
  const perTheme = Math.max(1, opts.perTheme ?? 8);
  return themes.map((name) => {
    const kws = themeNewsKeywords(name);
    const scored: { hit: ThemeNewsHit; rank: number; idx: number }[] = [];
    pool.forEach((row, idx) => {
      const kw = matchedKeyword(row.title, kws);
      if (!kw) return;
      scored.push({ hit: { date: row.date, time: row.time, title: row.title, kw }, rank: kws.indexOf(kw), idx });
    });
    scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    return { name, hits: scored.slice(0, perTheme).map((s) => s.hit) };
  });
}

/** 一条新闻的引用写法：带日期，「（09-20）标题」——读者一眼知道不是当天的 */
export function newsQuoteZh(h: NewsPoolRow): string {
  return `“${h.title}”（${String(h.date).slice(5)} ${h.time}）`;
}

/** 分组结果 → 喂给 prompt 的正文（`主线名：…“标题”（日期 时间）…`）；没命中的主线不进这段，由 unmatchedZh 单独交代 */
export function groupedNewsZh(groups: ThemeNewsGroup[]): string {
  return groups
    .filter((g) => g.hits.length)
    .map((g) => `${g.name}：${g.hits.map((h) => newsQuoteZh(h)).join("")}`)
    .join("\n");
}

/** 一条都没挂上的主线：如实列出来，让模型知道这些主线该写「没有直接相关的快讯」 */
export function unmatchedThemesZh(groups: ThemeNewsGroup[]): string {
  const names = groups.filter((g) => !g.hits.length).map((g) => g.name);
  return names.length ? `以下主线在本快讯池里没有直接相关题目：${names.join("、")}` : "";
}

/**
 * 快讯池的口径说明（放在 ⑥ 那行标题上）。
 * 关键是把「池子是哪几天、共多少条、抓取于哪天、有没有翻完」一次说清 ——
 * 以前这里只写「最新抓取快讯（抓取于今天）」，模型就把 09-27 的头条当成 09-24 的当日新闻引用了。
 */
export function newsPoolLabelZh(opts: {
  dates: string[];
  total: number;
  fetchedOn: string;
  source?: string;
  capped?: boolean;
}): string {
  const { dates, total, fetchedOn, source, capped } = opts;
  const span = dates.length ? `${dates[dates.length - 1]}~${dates[0]}` : fetchedOn; // dates 新→旧
  const parts = [`研报区间 ${span} 的${dates.length > 1 ? `${dates.length} 个交易日` : "当日"}快讯池（共 ${total} 条，抓取于 ${fetchedOn}${source ? `，源：${source}` : ""}）`];
  if (capped) parts.push("注意：翻页页数预算用尽，窗口可能不完整（没翻到区间最早一天）");
  return parts.join(" ");
}
