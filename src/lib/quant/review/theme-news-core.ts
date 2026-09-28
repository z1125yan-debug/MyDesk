// 主题「新闻证据」纯核 —— 零 IO、无 fetch、无时钟，node --test 直跑。
//
// 口径（对齐稳智 + 本仓 P65 研报窗口）：新闻不走「抓取那一刻的 12 条」，
// 走「近 3 个交易日」的全量快讯窗口（/api/market/news?dates=...，与主题卡 3 日资金同周期）。
// 本核只做两件事：关键词命中 + 窗口说明文案。取数在页面/路由层。
//
// 命中规则（宁可少报不可错报）：
//   · 主题名先按 / 、 空格 拆成候选词（如「东数西算/算力」→ 东数西算、算力），整名本身也是一个候选；
//   · 候选词长度 < 2 丢弃（单字命中全是噪音，比如「力」）;
//   · 标题包含候选词即命中，命中词记进结果，便于页面上说明「为什么这条算它的新闻」；
//   · 同一标题只留一条（去重按去空白后的标题原文）；
//   · 输入池的顺序就是返回顺序（上游按日期从新到旧给），不重排。

export interface ThemeNewsItem {
  title: string;
  /** HH:MM 或带秒；可能缺 */
  time?: string | null;
  /** YYYY-MM-DD；可能缺（最新一屏快讯不带日期） */
  date?: string | null;
}

export interface ThemeNewsHit {
  title: string;
  time: string;
  date: string;
  /** 命中的关键词（主题名或它拆出来的词） */
  kw: string;
}

/** 主题名 → 候选关键词（去重、去单字、保序） */
export function themeKeywords(theme: string): string[] {
  const raw = String(theme ?? "");
  if (!raw) return [];
  const parts = raw
    .split(/[/、，,+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of [raw, ...parts]) {
    const key = k.replace(/\s+/g, "");
    if (key.length < 2) continue; // 单字命中全是噪音
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 在快讯池里找该主题的新闻（池顺序 = 返回顺序，最新的在前） */
export function themeNewsHits(pool: ThemeNewsItem[], theme: string, limit = 8): ThemeNewsHit[] {
  const kws = themeKeywords(theme);
  if (!kws.length) return [];
  const seenTitle = new Set<string>();
  const hits: ThemeNewsHit[] = [];
  for (const n of pool ?? []) {
    const title = String(n?.title ?? "").trim();
    if (!title) continue;
    const dedupeKey = title.replace(/\s+/g, "");
    if (seenTitle.has(dedupeKey)) continue;
    const kw = kws.find((k) => title.includes(k));
    if (!kw) continue;
    seenTitle.add(dedupeKey);
    hits.push({
      title,
      time: String(n?.time ?? "").trim(),
      date: String(n?.date ?? "").trim(),
      kw,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 窗口说明：「近 3 个交易日（09-22 ~ 09-24）」；空池给空串由页面自己兜 */
export function newsWindowLabel(dates: string[]): string {
  const ds = (dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).sort();
  if (!ds.length) return "";
  if (ds.length === 1) return `${ds[0].slice(5)} 单日`;
  return `近 ${ds.length} 个交易日（${ds[0].slice(5)} ~ ${ds[ds.length - 1].slice(5)}）`;
}

/** 一条都没命中时的页面文案（如实说窗口和池子大小，不装作没有查询过） */
export function themeNewsEmptyNote(theme: string, poolSize: number, windowLabel: string): string {
  const win = windowLabel ? `在${windowLabel}` : "在本轮取到的窗口";
  return `${win}的快讯池（共 ${poolSize} 条）里没有标题带「${theme}」的新闻。要么这几天它确实没上头条，要么它以别的名字被报道——只做标题关键词匹配，不猜。`;
}
