// 产业链研报 · 正文取题与排版修补（纯函数，P63）
//
// 为什么要有这一层（2026-09-27 实测翻出来的真错）：
// prompt 第 1 条要求首行写 `# 📈 【A股市场深度复盘与机会前瞻】YYYY-MM-DD`，
// 但换上的 mercury-2 会**直接跳过这行**，正文从 `## 📊 市场情绪与风格判断` 开始。
// 而留档标题是"取正文第一个非空行、剥掉井号"得来的 —— 于是研报的封面大标题变成了
// 一个小节标题（页面上就写成「📊 市场情绪与风格判断」），观察日也从标题里消失了。
// 对方的报告页有一个固定的封面标题区，标题是记录字段、不是正文首行；这里补同样的区分：
// **标题取不到 H1 就用模板兜底，绝不拿小节标题冒充大标题。**
//
// 顺带两处 markdown 修补：模型会写出 `**微盘比例** 39.29% ****中盘比例**` 这种
// 多打一对星号的断口，也会把句子切成连续加粗 `**A****B**`（浏览器解析后露裸星号、
// 两段词还粘在一起）—— 见下面 mendBoldSeams 的两步。再往下是 screenReportShape：
// 模型偶尔会在加粗处塌缩成「几千个星号」的复读墙，这种必须在入库前拦下，
// 否则它会覆盖掉同一天原本能看的那份留档（2026-09-27 真发生过一次）。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 单井号一级标题（`## xxx` 不算，避免把小节标题当大标题） */
const H1_RE = /^\s*#\s+(\S.*?)\s*$/;

export const REPORT_TITLE_PREFIX = "📈 【A股市场深度复盘与机会前瞻】";

/** 模型漏写 H1 时的兜底大标题：用交易日拼，不编内容（形状与 prompt 要求的首行一致） */
export function fallbackReportTitle(day: string): string {
  const d = DATE_RE.test(String(day ?? "").trim().slice(0, 10)) ? String(day).trim().slice(0, 10) : "";
  return REPORT_TITLE_PREFIX + d;
}

/**
 * 取研报大标题：正文里真有 H1 就用它，没有就按交易日兜底。
 * 规则：只看第一个非空行；那一行必须是 `# `（单个井号），`##`/`###` 是小节标题，不算。
 */
export function reportTitleOf(text: string, day: string): string {
  const first = String(text ?? "").split(/\r?\n/).find((l) => l.trim());
  const m = first ? H1_RE.exec(first) : null;
  const t = (m?.[1] ?? "").trim();
  return t || fallbackReportTitle(day);
}

/** 正文里的 H1 行（渲染时由 ReportMarkdown 剥掉，标题只在 hero 出现一次） */
export function hasReportH1(text: string): boolean {
  const first = String(text ?? "").split(/\r?\n/).find((l) => l.trim());
  return !!first && H1_RE.test(first);
}

/**
 * 一行里的 `**` 个数是奇数 → 必有一对是多打的（模型常这么写：`综合** **情绪偏冷**、**技术面**…`）。
 * 顺序配对会把整行加粗**错位一格**：段与段互换、行尾再露一对裸星号。
 * 修法是删掉多余的那一对：优先删「后面紧跟 空格+`**`」的这种（没有对应开头的收尾），
 * 找不到就删行末最后一个 —— 只动星号，不动一个字。
 * 正常写法 `**A** **B**`（上面 ② 刚造出来的那种）个数是偶数，一律不碰。
 */
function balanceBoldMarkers(line: string): string {
  const odd = (s: string) => (s.match(/\*\*/g) ?? []).length % 2 !== 0;
  if (!odd(line)) return line;
  const dropped = line.replace(/(\S)\*\*(?=\s\*\*)/, "$1");
  const s = dropped !== line ? dropped : line;
  if (!odd(s)) return s;
  const at = s.lastIndexOf("**");
  return at < 0 ? s : s.slice(0, at) + s.slice(at + 2);
}

/**
 * 断口加粗修补，三步：
 * ① 断口起头：`…39.29% ****中盘比例**` → `…39.29% **中盘比例**`（空格后紧跟 4 星 = 多打的一对）
 * ② 相邻加粗接缝：`**A****B**` → `**A** **B**`（一整串 4 个以上星号换成「** **」）
 * ③ 单行 `**` 个数为奇数 → 删掉多打的那一对（balanceBoldMarkers）
 *
 * ②是 2026-09-27 第二轮实测补的：模型按「满屏重点」的要求把句子切成十几个连续加粗，
 * 星号数一旦不是 4 的整数倍（例如 `**跌停******13只**` 中间是 6 个），浏览器就会露出
 * 一对裸星号；而且两段加粗之间没有分隔，读起来是「微盘占比39.29%」这种粘连词。
 * ③是同一天第三轮实测补的：策略总结那一行有 27 个 `**`（奇数），整行加粗错位、行尾露星号。
 * 只动星号，不改一个字 —— 这是排版修补，不是改内容。
 */
export function mendBoldSeams(text: string): string {
  return String(text ?? "")
    .replace(/(\s)\*{4}(?=\S)/g, "$1**")
    .replace(/\*{4,}/g, "** **")
    .split(/(\r?\n)/)
    .map((part) => (/^\r?\n$/.test(part) ? part : balanceBoldMarkers(part)))
    .join("");
}

// ── 模型文字口误修补（2026-09-27 实测，两条真实口误）───────────────────────────
// 「采取15仓位」：数字直接顶到「仓位」是漏打了 % —— 同一篇里其它仓位写法都是「5%‑10%」
//   这种带百分号的形状，不带 % 的唯一合理解读就是漏字，补回去。
//   反向钉住：「15%仓位」「5成仓位」「买1000股仓位」「三成仓位」都不能被碰。
// 「受5基站」：股票语境里「5基站」只能是「5G基站」被吞了 G；
//   但「第5基站/共5基站」是序数，「11.5基站」是小数尾巴，序数与小数一律挡掉。
// 只补这两种被证实的形态，宁可漏、不乱改 —— 这里是修补，不是润色。
export function mendTypos(text: string): string {
  return String(text ?? "")
    .replace(/(\d)\s*仓位/g, "$1%仓位")
    .replace(/(?<![0-9A-Za-z.第共])5\s*基站/g, "5G基站");
}

// ── 跑偏检测（模型复读塌缩）──────────────────────────────────────────────
// 2026-09-27 实测：同一套 prompt 再生成一次，mercury-2 在第三节的一个加粗处开始复读星号，
// 最后一行是 7689 个字符、其中 7642 个是 `*`，全文 87% 的字符是星号。
// 旧的流程会把这份东西直接写进留档，**覆盖掉同一天原本能看的那份** —— 这才是最贵的地方。
// 所以下面这三个阈值只在「明显塌缩」时判定，正常研报离得很远（同日那份正常正文星号占比 0.8%）。
const MAX_STAR_RUN = 12;        // 连续星号：markdown 最多 `***粗斜体***` = 3，12 已是复读
const MAX_STAR_RATIO = 0.25;    // 全文星号占比：正常 <3%
const MIN_STARS_FOR_RATIO = 300; // 占比这条只在星号绝对量够大时才判 —— 否则一段几十字的粗斜体会被误杀
const MAX_LINE_LEN = 3000;      // 单行长度：结构正常时不可能出现这种墙

export interface ReportShapeScreen {
  ok: boolean;
  /** 判定不通过时给用户看的一句话（人话，带证据数字）；通过时为空串 */
  reason: string;
  maxStarRun: number;
  starRatio: number;
  longestLine: number;
}

/** 判定这轮生成是不是塌缩了：塌缩就别入库、别覆盖已有留档 */
export function screenReportShape(text: string): ReportShapeScreen {
  const t = String(text ?? "");
  const runs = t.match(/\*+/g) ?? [];
  const maxStarRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const starCount = runs.reduce((n, r) => n + r.length, 0);
  const starRatio = t.length ? starCount / t.length : 0;
  const longestLine = t.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0);
  if (maxStarRun >= MAX_STAR_RUN) {
    return { ok: false, maxStarRun, starRatio, longestLine,
      reason: `这轮生成跑偏了：正文里出现连续 ${maxStarRun} 个星号（模型在复读星号，最长一行 ${longestLine} 字）。已保留原来那份，没有覆盖留档，请再点一次「重新生成」。` };
  }
  if (starCount >= MIN_STARS_FOR_RATIO && starRatio > MAX_STAR_RATIO) {
    return { ok: false, maxStarRun, starRatio, longestLine,
      reason: `这轮生成跑偏了：正文 ${(starRatio * 100).toFixed(0)}% 的字符是星号，排版已塌缩。已保留原来那份，没有覆盖留档，请再点一次「重新生成」。` };
  }
  if (longestLine >= MAX_LINE_LEN) {
    return { ok: false, maxStarRun, starRatio, longestLine,
      reason: `这轮生成跑偏了：正文出现单行 ${longestLine} 字的不断行墙，分段结构丢了。已保留原来那份，没有覆盖留档，请再点一次「重新生成」。` };
  }
  return { ok: true, maxStarRun, starRatio, longestLine, reason: "" };
}

// ── 骨架兜底（P64 实测补）──────────────────────────────────────────────────
// 换了 prompt（喂中文口径 + 真实指数趋势 + 本地判读）之后，2026-09-27 12:05 实测这一轮：
// 内容口径全对了（阶段=退潮反抽、27.56% 读成「站上比例」、光通信写成流出 165.37 亿、
// 正文里再没有 aboveMa5Pct / 编造的 3000 点），但**小节标题掉了三个**：
// 正文里只留了 `## 📊 市场情绪…` 和 `## ⚠️ 风险警示`，`## 🚀 核心主线…`、`## 🧩 潜伏机会…`、
// `## 🧭 策略总结` 没写，结尾那行固定【免责声明】也整段没有 —— 页面看上去就是「缺了两节 + 没落款」。
// 这与 P63 的标题兜底是同一类问题：**模型跳过的结构性零件由代码补齐，不指望 prompt 照做**。
// 补的是骨架不是内容：只在「这一节的内容确实在正文里」时把标题插回它该在的位置，
// 内容找不到就宁可不加标题，绝不造一节空壳、也绝不替模型写一句判断。
const HEAD_EMOTION = "## 📊 市场情绪与风格判断";
const HEAD_MAIN = "## 🚀 核心主线与热点板块";
const HEAD_LATENT = "## 🧩 潜伏机会与预期差";
const HEAD_RISK = "## ⚠️ 风险警示";
const HEAD_STRATEGY = "## 🧭 策略总结";

/** 结尾固定落款：与 prompt【四、结尾】逐字一致，缺了才补，不做改写 */
export const REPORT_DISCLAIMER_LINE =
  "**免责声明**：本分析基于公开信息整理，不构成任何投资建议。A股市场受多重因素影响，历史表现不代表未来。投资者应结合自身风险承受能力独立决策，并对投资结果负责。";

export interface SkeletonMend {
  text: string;
  /** 补回去的零件名（给人看的短名，如「核心主线与热点板块」「免责声明」）；没缺就是空数组 */
  inserted: string[];
}

const isBullet = (l: string) => /^\s*[-*]/.test(l);
const isHead = (l: string) => /^\s*#/.test(l);
const isQuote = (l: string) => /^\s*>/.test(l);
const isRule = (l: string) => /^\s*---\s*$/.test(l);
const blank = (l: string) => !l.trim();
/** 普通成段正文（不是标题/项目符号/引用/分隔线），够长才算一句真话 */
const isParagraph = (l: string) =>
  !blank(l) && !isHead(l) && !isBullet(l) && !isQuote(l) && !isRule(l) && l.trim().length >= 15;

/**
 * 把模型漏写的五节标题和固定落款补回去。锚点全部从正文自身找，不依赖顺序编号：
 * · 情绪 → 缺就放最前（正文有内容才补）
 * · 主线 → 第一条 `### ` 小标题之前
 * · 潜伏 → 「主线」标题之后，第一条 `- **① …**` 机会点之前
 * · 风险 → 第一条加粗里带「风险」二字的子弹之前
 * · 策略 → 「风险」标题之后第一段成文收束之前
 * · 免责声明 → 全文没有「免责声明」四个字时，按 prompt 的原样追加（前面补 --- 分隔）
 * 插入标题时若上一行不是分隔线，顺带补一条 `---`（prompt 要求节间分隔）。
 */
export function mendReportSkeleton(text: string): SkeletonMend {
  const src = String(text ?? "");
  const inserted: string[] = [];
  if (!src.trim()) return { text: src, inserted };
  let lines = src.split(/\r?\n/);

  const headIndex = (head: string) => lines.findIndex((l) => l.trim().startsWith(head));
  const insert = (idx: number, head: string, label: string) => {
    if (idx < 0) return; // 这一节在正文里没有对应内容：宁缺不造
    const add: string[] = [head, ""];
    let p = idx - 1;
    while (p >= 0 && blank(lines[p])) p--;
    if (p >= 0 && !isRule(lines[p])) add.unshift("---", "");
    lines = [...lines.slice(0, idx), ...add, ...lines.slice(idx)];
    inserted.push(label);
  };
  const ensureHead = (head: string, label: string, anchor: () => number) => {
    if (headIndex(head) >= 0) return;
    insert(anchor(), head, label);
  };

  // 从后往前补：先补靠后的节，插入造成的行号偏移就不会打乱前面几节的锚点
  ensureHead(HEAD_STRATEGY, "策略总结", () => {
    const risk = headIndex(HEAD_RISK);
    if (risk < 0) return -1;
    return lines.findIndex((l, i) => i > risk && isParagraph(l));
  });
  ensureHead(HEAD_RISK, "风险警示", () =>
    lines.findIndex((l) => isBullet(l) && /^\s*[-*]\s*\*\*[^*]{0,12}风险[^*]{0,12}\*\*/.test(l)));
  ensureHead(HEAD_LATENT, "潜伏机会与预期差", () => {
    const from = Math.max(headIndex(HEAD_MAIN), 0);
    return lines.findIndex((l, i) => i > from && /^\s*[-*]\s*\*\*[①②③④⑤]/.test(l));
  });
  ensureHead(HEAD_MAIN, "核心主线与热点板块", () => lines.findIndex((l) => /^\s*###\s+\S/.test(l)));
  ensureHead(HEAD_EMOTION, "市场情绪与风格判断", () => lines.findIndex((l) => !blank(l)));

  if (!lines.some((l) => l.includes("免责声明"))) {
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    lines = [...lines, "", "---", "", REPORT_DISCLAIMER_LINE];
    inserted.push("免责声明");
  }
  return { text: lines.join("\n"), inserted };
}

