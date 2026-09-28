// 研报「受益标的」A 股合规校验（纯核，无 IO / 无 fetch）
//
// 为什么要有这一层（2026-09-27 取证）：prompt 里早就写了红线
//   「7. 受益标的只写 A 股上市公司。反面例子：星际荣耀、华为海思、长江存储……」
// 但 09-24 那份真实产出里仍然出现了三个不合规写法（在册简称/代码已拿真实名册核实）：
//   华虹半导体（那是港股叫法，A 股在册的是「华虹宏力」688347）
//   华润微电子（A 股在册简称是「华润微」688396，代码也不是 688398）
//   金山云（美股/港股，A 股名册里只有「金山办公」，压根不是同一主体）
// 光靠禁令治不住模型，所以生成完再拿**真实全 A 名册**逐条对一遍，把不合规的点名叫出来。
// 名册从 /api/market/stock-names 取（与 /api/market/allstocks 同一个 provider 口径），
// 本文件只负责「抽名字 + 对名字 + 说人话」，不碰网络。
//
// 诚实边界（重要）：
// - 名册取不到时一律回「无法校验」，绝不因为"没查到问题"就说"全部合规"；
// - 简称/异名只标成「疑似」并给在册候选，不自动改名、不替读者判定；
// - 只有在全 A 名册里彻底找不到（且没有任何可归的在册主体）才标「非 A 股」。

/** 名册一行：全 A 在册公司 */
export interface RosterRow {
  symbol: string; // 688347.SH
  name: string;   // 华虹宏力（名册原样，可能带 XD/全角角标这类源噪声）
}

/** 正文里抽出的一条标的 */
export interface TickerItem {
  name: string;  // 正文写法（已剥掉 markdown 加粗与括号注释）
  tier: string;  // 核心受益 / 次级受益 / 受益标的
  theme: string; // 就近归属的主线（上面最近的标题行）
  line: number;  // 出现在第几行（1 起），便于人工回查
}

export type TickerVerdictKind = "ok" | "alias" | "not_a_share";

export interface TickerVerdict extends TickerItem {
  kind: TickerVerdictKind;
  /** ok / alias 时对应的在册公司（alias 取最像的一条） */
  match: RosterRow | null;
  /** alias 时的在册候选（最多 3 条，按相似度排序）；ok 时为空 */
  candidates: RosterRow[];
  /** 在册名带的风险警示标记（ST / *ST / SST / S*ST）；没有则 null */
  risk: string | null;
}

// 常见公司后缀：用来把「华虹半导体」和「华虹宏力」归到同一个主体「华虹」。
// 判定只用于"疑似简称"提示，宁可多给一条候选，也不把疑似说成确定。
const COMPANY_SUFFIXES = [
  "半导体", "集成电路", "电子科技", "科技集团", "电子", "科技", "信息", "技术", "股份", "集团",
  "公司", "通信", "网络", "数字", "智能", "医疗", "医药", "新能源", "环保", "材料",
  "装备", "重工", "器件", "国际", "中国", "实业", "控股", "电子厂", "电机", "能源",
];

// 行情源的证券简称前面会挂当日状态标记（实测腾讯代码表：600584 在除息日回的是「XD长电科」），
// 也会挂风险警示标记（实测 300044 在册叫「*ST赛为」，模型写研报时仍用老名「赛为智能」）。
// 这些标记都不是公司名的一部分，比对前一律剥掉；剥完可能只剩截断名（源本身按 8 字节截断，
// 「XD长电科技」被截成「XD长电科」），这种情况靠"互为前缀"的疑似规则兜住，仍把在册代码给读者。
// 顺序很要紧：\*ST 必须在剥掉星号之前认。反过来（先删星号再匹配 S\*ST）永远匹配不上，
// 真实后果是把「赛为智能 → ST赛为 300044」这种"在册但已被风险警示"的标的误判成非 A 股。
const STATUS_PREFIX_RE = /^(S\*ST|\*ST|SST|ST|SS|XD|DR|XR|N|C)(?=[\u4e00-\u9fa5])/;
// 风险警示类标记（区别于 XD/DR 这种当日除权标记）：影响读者判断，核对条要单独说。
const RISK_MARK_RE = /^(S\*ST|\*ST|SST|ST)(?=[\u4e00-\u9fa5])/;

/** 在册名里的风险警示标记（ST / *ST / SST / S*ST），没有则 null */
export function riskMarkOf(raw: string): string | null {
  const s = String(raw ?? "")
    .replace(/\*\*/g, "")
    .replace(/[\s\u3000（）()]/g, "")
    .normalize("NFKC")
    .toUpperCase();
  const m = RISK_MARK_RE.exec(s);
  return m ? m[1] : null;
}

/** 归一化：NFKC 折全角（名册里是「京东方Ａ」「万  科Ａ」）、剥状态标记、去空白、ASCII 统一大写 */
export function normalizeCompanyName(raw: string): string {
  let s = String(raw ?? "")
    .replace(/\*\*/g, "")
    .replace(/[（(][^（）()]*[)）]/g, "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[「」《》"'’·、，,；;。.]/g, "");
  s = s.normalize("NFKC").toUpperCase();
  // 反复剥（偶尔有「NXDxx」这类叠加）
  for (let g = 0; g < 3; g++) {
    const m = STATUS_PREFIX_RE.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.replace(/\*/g, "");
}

// 主体链：原名 + 逐层剥后缀得到的干（"华润微电子" → 华润微电子 / 华润微；"华虹半导体" → 华虹半导体 / 华虹）。
// 两个名字只要主体链有交集就算"像同一家"。至少留 2 个字，避免剥成单字后到处乱配。
function stemsOf(name: string): Set<string> {
  const out = new Set<string>([name]);
  let cur = name;
  for (let guard = 0; guard < 6 && cur.length > 2; guard++) {
    let next = "";
    for (const s of COMPANY_SUFFIXES) {
      if (cur.endsWith(s) && cur.length - s.length >= 2) { next = cur.slice(0, -s.length); break; }
    }
    if (!next || next === cur) break;
    out.add(next);
    cur = next;
  }
  return out;
}

// 主线标题（### / ##）就近归属用；研报骨架里每个主线一段
const HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*$/;
// 受益栏：允许没有 bullet、允许标签本身被加粗、允许半角冒号（模型两种都写）
const TIER_RE = /^\s*[-*+·•\s]*\s*(核心受益|次级受益|受益标的)\s*[：:]/;
const BOLD_RE = /\*\*([^*]+?)\*\*/g;

// 主线名清洗：标题长这样「## 1. 半导体（🔥 热度：极高）」，核对条要点名的是"半导体"三个字——
// 序号和热度括号是排版用的，跟着上屏只会让那行字读起来像乱码。
function cleanTheme(raw: string): string {
  return String(raw ?? "")
    .replace(/[（(][^（）()]*[)）]/g, "")
    .replace(/^\s*[\d一二三四五六七八九十]+\s*[\.、：:]?\s*/, "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9/、]+/g, "")
    .trim();
}

// 一条受益栏里塞两家公司的写法（实测 09-24 重新生成的那份：`**兆易创新、华虹宏力**`）。
// 必须先拆再归一化：normalizeCompanyName 会把顿号当标点吃掉，两家会粘成「兆易创新华虹宏力」，
// 名册对不上就被误点名成"非 A 股"——A 股证券简称里不会出现顿号/逗号/分号，拆是安全的。
function splitNameTokens(raw: string): string[] {
  const cleaned = String(raw ?? "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (!cleaned) return [];
  return cleaned.split(/[、，,；;]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 从研报 markdown 正文里抽「核心受益 / 次级受益 / 受益标的」的公司名。
 * 只认这三类行，正文别处的加粗公司名（如风险提示、结论段）不算标的，避免误伤。
 * 优先取 `**公司名**`；一行里没有任何加粗时（模型偶尔漏写星号）退化为按分隔符切冒号后面的内容。
 */
export function extractBeneficiaryNames(md: string): TickerItem[] {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: TickerItem[] = [];
  const seen = new Set<string>();
  let theme = "";
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const h = HEADING_RE.exec(raw);
    if (h) { theme = cleanTheme(h[1]); continue; }
    const plain = raw.replace(/\*/g, "");
    const t = TIER_RE.exec(plain);
    if (!t) continue;
    const tier = t[1];
    const after = plain.slice(plain.indexOf(t[1]) + t[1].length).replace(/^\s*[：:]\s*/, "");
    const names: string[] = [];
    const bold = [...raw.matchAll(BOLD_RE)].map((m) => m[1]);
    for (const b of bold) {
      // 标签自己也被加粗时（**核心受益**：），第一个加粗不是公司名
      if (/^(核心受益|次级受益|受益标的)$/.test(b.trim())) continue;
      names.push(...splitNameTokens(b));
    }
    if (!names.length) {
      for (const piece of splitNameTokens(after)) {
        if (!/^(核心受益|次级受益|受益标的)$/.test(piece)) names.push(piece);
      }
    }
    for (const n of names) {
      const name = normalizeCompanyName(n);
      if (name.length < 2) continue; // 单字/空壳不算公司名
      const key = `${tier}|${theme}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, tier, theme, line: i + 1 });
    }
  }
  return out;
}

/** 名册索引：归一化名 → 在册行（同名多市场时保留全部，取第一条为默认） */
export interface RosterIndex {
  byName: Map<string, RosterRow[]>;
  byStem: Map<string, RosterRow[]>;
  size: number;
}

export function buildRosterIndex(rows: RosterRow[]): RosterIndex {
  const byName = new Map<string, RosterRow[]>();
  const byStem = new Map<string, RosterRow[]>();
  const push = (map: Map<string, RosterRow[]>, k: string, r: RosterRow) => {
    if (!k) return;
    const cur = map.get(k);
    if (cur) { if (!cur.some((x) => x.symbol === r.symbol)) cur.push(r); return; }
    map.set(k, [r]);
  };
  for (const r of rows ?? []) {
    const nm = normalizeCompanyName(r.name);
    if (!nm || !r.symbol) continue;
    push(byName, nm, r);
    for (const st of stemsOf(nm)) push(byStem, st, r);
  }
  return { byName, byStem, size: byName.size };
}

// 相似度排序用：两个名字从头相同的字数
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * 逐条判定正文里的标的名。
 * - ok：全 A 名册里有同名在册公司；
 * - alias：名册里没有同名，但有同主体（后缀差异/互为前缀/同头异尾）的在册公司 → 疑似简称/异名，给候选；
 * - not_a_share：名册里对不上任何在册主体 → 点名（港股/美股/未上市/编造）。
 * 名册为空时**不判定**（返回空数组）：由上层显式说明"无法校验"，绝不默认合规。
 */
export function checkBeneficiaryNames(items: TickerItem[], roster: RosterRow[]): TickerVerdict[] {
  if (!items?.length) return [];
  const idx = buildRosterIndex(roster ?? []);
  if (!idx.size) return [];
  const riskOf = (r: RosterRow | null) => (r ? riskMarkOf(r.name) : null);
  return items.map((it) => {
    const exact = idx.byName.get(it.name);
    if (exact?.length) return { ...it, kind: "ok", match: exact[0], candidates: [], risk: riskOf(exact[0]) };
    const cands = new Map<string, RosterRow>();
    for (const st of stemsOf(it.name)) {
      for (const r of idx.byStem.get(st) ?? []) cands.set(r.symbol, r);
    }
    // 前缀兜底：名册里以正文名开头（或反之）且公共前缀 ≥2 字
    // —— 也是「在册简称被源截断」的救命绳：600584 在除息日回的是「XD长电科」，
    //    归一化剥掉 XD 只剩「长电科」，靠这条仍能认出正文写的「长电科技」是同一只。
    if (!cands.size) {
      for (const [nm, rows] of idx.byName) {
        if (Math.min(nm.length, it.name.length) < 2) continue;
        if (nm.startsWith(it.name) || it.name.startsWith(nm)) for (const r of rows) cands.set(r.symbol, r);
      }
    }
    // 同头异尾兜底：前缀 ≥2 字、且正文多出来的那段正好是个行业后缀
    // —— 「华虹半导体」（港股叫法）对在册「华虹宏力」：公共头「华虹」+ 多出来的是「半导体」；
    //    反过来「金山云」对「金山办公」多出来的是「云」，不在后缀表里 → 仍按非 A 股点名，不误放。
    if (!cands.size) {
      for (const [nm, rows] of idx.byName) {
        const cp = commonPrefix(nm, it.name);
        if (cp < 2 || cp === it.name.length) continue;
        if (COMPANY_SUFFIXES.includes(it.name.slice(cp))) for (const r of rows) cands.set(r.symbol, r);
      }
    }
    const list = [...cands.values()]
      .sort((a, b) => {
        const pa = commonPrefix(normalizeCompanyName(a.name), it.name);
        const pb = commonPrefix(normalizeCompanyName(b.name), it.name);
        if (pb !== pa) return pb - pa;
        return normalizeCompanyName(a.name).length - normalizeCompanyName(b.name).length;
      })
      .slice(0, 3);
    if (list.length) return { ...it, kind: "alias", match: list[0], candidates: list, risk: riskOf(list[0]) };
    return { ...it, kind: "not_a_share", match: null, candidates: [], risk: null };
  });
}

export interface TickerCheckResult {
  checked: boolean;      // 名册可用且正文有标的
  total: number;
  okCount: number;
  alias: TickerVerdict[];
  bad: TickerVerdict[];
  risk: TickerVerdict[]; // 对上了在册、但在册名带 ST/*ST 风险警示标记的标的
  reason: string;        // checked=false 时的如实说明
}

/** 汇总判定结果（UI 文案的原料；名册不可用时如实回"无法校验"） */
export function summarizeTickerCheck(verdicts: TickerVerdict[], rosterRows: RosterRow[] | null): TickerCheckResult {
  const alias = verdicts.filter((v) => v.kind === "alias");
  const bad = verdicts.filter((v) => v.kind === "not_a_share");
  const okCount = verdicts.filter((v) => v.kind === "ok").length;
  const risk = verdicts.filter((v) => v.risk);
  if (!rosterRows || !rosterRows.length) {
    return { checked: false, total: verdicts.length, okCount: 0, alias: [], bad: [], risk: [], reason: "全 A 名册没取到：本次无法校验受益标的（不代表合规）" };
  }
  if (!verdicts.length) {
    return { checked: false, total: 0, okCount: 0, alias: [], bad: [], risk: [], reason: "这份研报正文里没有「核心受益/次级受益」栏，没有需要核对的标的" };
  }
  return { checked: true, total: verdicts.length, okCount, alias, bad, risk, reason: "" };
}

/**
 * 在册简称的上屏写法：剥掉 XD/DR 这类当日除权标记；
 * 若剥完还是正文名的前缀（说明行情源按 8 字节把简称截断了，如 600584 回的是「XD长电科」），
 * 补一个省略号，让读者一眼看出"这是源截了字，不是公司叫这个"。
 * 风险警示标记（ST/*ST）反过来要**留着**写出来：那是读者必须知道的标的属性，不是排版噪声。
 */
export function displayRosterName(raw: string, forName = ""): string {
  const s = normalizeCompanyName(raw);
  const risk = riskMarkOf(raw);
  if (risk) return `${risk}${s}`;
  // 只有"带当日状态标记"的那种前缀才可能是截断（XD长电科技→XD长电科）；
  // 「华润微 ⊂ 华润微电子」是正常的简称差异，不该补省略号。
  const marked = STATUS_PREFIX_RE.test(String(raw ?? "").trim().toUpperCase());
  if (marked && forName && s.length >= 3 && forName !== s && forName.startsWith(s)) return `${s}…`;
  return s || String(raw ?? "").trim();
}

function rosterLabel(r: RosterRow, forName = ""): string {
  return `${displayRosterName(r.name, forName)} ${r.symbol.split(".")[0]}`;
}

/** 说人话的核对结论（一行一条，界面直接铺开；不堆黑话） */
export function tickerCheckLinesZh(r: TickerCheckResult): string[] {
  if (!r.checked) return [r.reason];
  const lines: string[] = [];
  lines.push(
    `受益标的共 ${r.total} 处已按全 A 在册名册逐条核对：合规 ${r.okCount} 处`
    + (r.alias.length ? `、疑似简称/异名 ${r.alias.length} 处` : "")
    + (r.bad.length ? `、**非 A 股 ${r.bad.length} 处**` : "")
    + (r.risk.length ? `、**在册已被风险警示 ${r.risk.length} 处**` : "")
    + "。",
  );
  for (const v of r.bad) {
    lines.push(`非 A 股：「${v.name}」${v.theme ? `（${v.theme}）` : ""}不在沪深北在册名册里，不能作为标的出现（第 ${v.line} 行）。`);
  }
  for (const v of r.alias) {
    const cand = v.candidates.map((c) => rosterLabel(c, v.name)).filter(Boolean).join(" / ");
    lines.push(`疑似简称：「${v.name}」${v.theme ? `（${v.theme}）` : ""}名册里没有这个全称，最接近的在册公司是 ${cand || "未匹配"}（第 ${v.line} 行）。`);
  }
  for (const v of r.risk) {
    if (!v.match) continue;
    lines.push(
      `风险警示：「${v.name}」${v.theme ? `（${v.theme}）` : ""}对上的在册标的是 ${rosterLabel(v.match, v.name)}`
      + ` —— 这只已被风险警示，别当普通受益标的看（第 ${v.line} 行）。`,
    );
  }
  return lines;
}
