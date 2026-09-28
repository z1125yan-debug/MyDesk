// P35 稳智对齐：产业链研报写作规范（prompt 升级 + `>` 引用块渲染）钉测
//
// 背景：本仓库产业链研报原本只有 5 段式「骨架」，缺写作规范，产出与稳智真实研报差距明显
//（实测：加粗密度 1/265 字 vs 稳智 1/30 字；关联新闻 0 处 vs 3 处；`>` 引用块 0 行 vs 4.8 行；
// `---` 分隔线 0 条 vs 3.9 条；markdown 表格 72 个竖线 vs 稳智 2.1 个）。
//
// 覆盖：
//   1. prompt 固定 H1 模板（含日期）
//   2. prompt 五节强制 `## + emoji` 且节间 `---`
//   3. prompt 禁用 markdown 表格
//   4. prompt 加粗密度硬指标
//   5. prompt 每条主线带 `> **关联新闻**`
//   6. prompt 热度四档 / 主线五件套 / 机会点两件套 / 综合判断 / 固定免责声明
//   7. max_tokens 抬到 6000
//   8. 快讯按主线预分组
//   9. 渲染器 quote 分支（类型 + 解析 + 组件）—— 不加则 `> **关联新闻**` 会露出 ">" 字符
//  10. 抽取真实 parseReportLines 跑稳智样式样例（行为验证，非源码钉）
//  11. 缓存纪律：已有研报「打开即读」，不重新生成（用户明确要求，防回归）
//  12. 研报日口径：按最新交易日（复盘种子 range.to），不按系统日历日 —— 休市日（周末/节假日）
//      点生成必须产出「上一个交易日」那份，标题与留档键都按交易日走，不产生非交易日幽灵记录

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_REL = "src/components/desk/LlmAnalysisPage.tsx";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), "utf-8");
}

// ─── prompt：固定 H1 模板 ─────────────────────────────────────────────────

test("prompt 固定 H1 标题模板（📈 + 【】+ 交易日）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /首行是一级标题，固定写成：# 📈 【A股市场深度复盘与机会前瞻】/, "H1 模板写死在 prompt 里");
  assert.match(src, /【A股市场深度复盘与机会前瞻】" \+ genDay/, "标题带交易日（genDay，休市日不写系统日期）");
});

// ─── prompt：五节强制 ## + emoji，节间 --- ────────────────────────────────

test("prompt 五节强制「## + emoji + 标题」", () => {
  const src = readSrc(SRC_REL);
  for (const t of [
    "## 📊 市场情绪与风格判断",
    "## 🚀 核心主线与热点板块",
    "## 🧩 潜伏机会与预期差",
    "## ⚠️ 风险警示",
    "## 🧭 策略总结",
  ]) {
    assert.ok(src.includes(t), `prompt 必须包含固定章节标题：${t}`);
  }
});

test("prompt 要求节间 --- 分隔线（共 4 处）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /每两节之间单独一行写 --- 作为分隔线（共 4 处）/, "节间分隔线要求写死");
});

test("prompt 严禁 markdown 表格", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /严禁使用 markdown 表格/, "禁用表格要求存在");
  assert.match(src, /所有分层信息一律用「加粗小标题 \+ 项目符号 -」的嵌套列表表达/, "替代写法写死");
});

// ─── prompt：加粗密度硬指标 ───────────────────────────────────────────────

test("prompt 有加粗密度硬指标（约每 30 字 1 处，且带上下限）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /经验密度：大约每 30 个字出现 1 处加粗/, "密度指标存在");
  assert.match(src, /4000 字正文约 120 处，最多不超过 160 处/, "下限保留、补出上限");
  // P63 第二轮实测：mercury-2 会为了「满屏重点」把句子切成连续加粗（`**A****B**`），
  // 极端时塌缩成几千个星号的复读墙 —— 光有密度下限不够，必须同时给上限和写法红线。
  assert.match(src, /红线 2：两个加粗之间必须有/, "禁止相邻加粗连写星号");
  assert.match(src, /红线 3：星号只能成对出现/, "禁止连续 3 个以上星号");
});

// ─── prompt：关联新闻 / 热度四档 / 五件套 / 免责声明 ──────────────────────

test("prompt 每条主线必须带 `> **关联新闻**`（至少 3 条）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /> \*\*关联新闻\*\*：“新闻标题1”（09-20 11:28）“新闻标题2”/, "关联新闻格式写死（P65 起标题后面带真实发布日期）");
  assert.match(src, /每条主线至少 3 条/, "条数下限写死");
});

test("prompt 热度评级固定四档", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /### 1\. 主线名称（🔥 热度：极高｜高｜中高｜中）/, "热度四档格式写死");
});

test("prompt 主线五件套字段名写死", () => {
  const src = readSrc(SRC_REL);
  for (const f of ["- **逻辑推演**：", "- **产业链受益**：", "- **操作建议**：", "**综合判断**："]) {
    assert.ok(src.includes(f), `主线结构字段必须存在：${f}`);
  }
  assert.match(src, /- 核心受益：\*\*公司A、公司B\*\*/, "核心受益写法写死");
  assert.match(src, /- 次级受益：\*\*公司D、公司E\*\*/, "次级受益写法写死");
});

test("prompt 机会点固定「逻辑 + 验证点」", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /- \*\*逻辑\*\*：/, "逻辑字段存在");
  assert.match(src, /- \*\*验证点\*\*：/, "验证点字段存在");
});

test("prompt 结尾免责声明固定原文（与稳智 24/24 一致）", () => {
  const src = readSrc(SRC_REL);
  assert.match(
    src,
    /\*\*免责声明\*\*：本分析基于公开信息整理，不构成任何投资建议。A股市场受多重因素影响，历史表现不代表未来。投资者应结合自身风险承受能力独立决策，并对投资结果负责。/,
    "免责声明原文写死",
  );
});

// ─── max_tokens / 快讯分组 ────────────────────────────────────────────────

test("max_tokens 抬到 6000（原 4096 会截断尾部章节）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /max_tokens: opts\.maxTokens \?\? 6000/, "预算抬到 6000");
  assert.ok(src.includes("{ maxTokens: 6000 }"), "调用处显式传 6000");
  assert.ok(!/max_tokens: 4096/.test(src), "旧的 4096 不应残留");
});

test("研报走流式生成：边生成边显示 + 上游超时 45s→120s", () => {
  const src = readSrc(SRC_REL);
  assert.ok(src.includes("stream: true,"), "请求体 stream: true");
  assert.ok(src.includes('Accept: "text/event-stream"'), "声明接受 SSE");
  assert.ok(!src.includes("stream: false"), "不得再走非流式（非流式 45s 超时 + 无逐字）");
  assert.ok(src.includes("await pumpEventStream(res.body,"), "帧切分复用 chat-stream-client.pumpEventStream");
  assert.ok(!src.includes('buf.indexOf("\\n\\n")'), "不得再自带一份帧循环（协议口径只留一份实现）");
  assert.ok(src.includes("decodeStreamEvent(raw)"), "复用项目既有 SSE 解码器");
  assert.ok(src.includes("setDraft(mendBoldSeams(full));"), "逐帧写入草稿（P63 起顺带过加粗修补，流式期间不露裸星号）");
  assert.ok(src.includes("if (now - lastPaint < 120) return;"), "120ms 节流（避免每次全量重解析）");
  assert.ok(src.includes("<ReportMarkdown text={draft} />"), "草稿用同一套排版渲染");
  assert.ok(src.includes("边生成边显示 · 已 {draft.length} 字"), "生成中有进度标识");
});

test("快讯按主线预分组（P65 起走 report-news-core：全名/去尾巴/别名/前缀，不再裸取 4 字）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /const hotThemes = \[/, "取热门主题名");
  assert.match(src, /const newsGroups = groupNewsByTheme\(hotThemes, pool/, "分组交给纯核（口径要能单测）");
  assert.match(src, /const groupedNews = groupedNewsZh\(newsGroups\)/);
  assert.doesNotMatch(src, /const kw = name\.slice\(0, 4\)/, "旧的裸 4 字匹配会把「人工智能」拆成「人工」这类误挂，已废弃");
  assert.match(src, /const newsBlock = groupedNews[\s\S]{0,60}\|\| /, "无命中回退原始标题串");
});

test("快讯数据源是 /api/market/news（review-stats 没有 news 字段）", () => {
  const src = readSrc(SRC_REL);
  assert.ok(src.includes('const newsPoolUrl = (dates: string[]) => `/api/market/news?dates='),
    "研报取快讯走带日期的窗口形态（P65：不带日期＝只有抓取那一刻的 12 条，挂不住主线）");
  assert.ok(
    src.includes('getJson<{ news?: { time?: string; title?: string }[] }>("/api/market/news")'),
    "主题热点面板仍保留无参形态（P15-R21 起它只是兜底：主路走近 3 个交易日的窗口形态）",
  );
  assert.ok(
    !src.includes('getJson<{ themeHeat?: ThemeHeatSeed; news?: { time: string; title: string }[] }>("/api/market/review-stats")'),
    "不得再打 review-stats 取 news —— 该路由只返回 rows/themeHeat/indexChanges/range",
  );
});

// ─── 长研报的超时链路（实测 ~6000 字要 230s+，超过路由默认 120s 上游超时） ────

test("长研报超时链路：客户端抬到 300s、路由可配且默认仍 120s", () => {
  const page = readSrc(SRC_REL);
  const route = readSrc("src/app/api/ai/proxy/route.ts");

  assert.ok(page.includes("timeout_ms: upstreamMs"), "研报请求带 timeout_ms");
  assert.ok(page.includes("opts.timeoutMs ?? 300_000"), "上游超时默认 300s");
  assert.ok(page.includes("AbortSignal.timeout(upstreamMs + 60_000)"), "外层兜底比上游多 60s");

  assert.ok(route.includes("const streamTimeoutMs = clampUpstreamTimeoutMs(rawTimeoutMs, 120_000)"), "路由解析 timeout_ms：流式钳位收进纯函数、默认 120s");
  assert.ok(route.includes("const nonStreamTimeoutMs = clampUpstreamTimeoutMs(rawTimeoutMs, 45_000)"), "非流式同口径（默认 45s），不再写死忽略 timeout_ms");
  assert.ok(route.includes("clampUpstreamTimeoutMs"), "钳位口径从内核引入（10s 下限 / 600s 上限的单测在 p7-llm-config）");
  // P55 起该调用尾部多一个护栏停止闸参数（shouldStop），所以钉放宽到「超时实参还在传位上」
  assert.ok(route.includes("runId ? undefined : req.signal, streamTimeoutMs,"), "超时透传进 callOpenAIStream");
  assert.ok(route.includes("timeoutMs = 120_000,"), "callOpenAIStream 默认值仍是 120s");
});

// ─── 渲染器：quote 分支 ───────────────────────────────────────────────────

test("渲染器 ReportLine 类型含 quote", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /kind: "h2" \| "h3" \| "h4" \| "strong" \| "list" \| "table" \| "quote" \| "hr"/, "quote 进类型联合");
});

test("渲染器 parseReportLines 识别 `>` 行并 strip 掉标记", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /if \(\/\^>\\s\?\/\.test\(line\)\)/, "识别 ^> 开头的行");
  assert.match(src, /out\.push\(\{ kind: "quote", text: line\.replace\(\/\^>\\s\?\/, ""\) \}\)/, "strip 掉 > 标记后入 quote");
});

test("渲染器 ReportMarkdown 有 blockquote 分支", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /case "quote":/, "quote 分支存在");
  assert.match(src, /<blockquote key=\{i\}/, "渲染成 blockquote");
});

// ─── 行为验证：抽取真实 parseReportLines 跑稳智样式样例 ───────────────────

test("parseReportLines 行为：`> **关联新闻**` → quote 且无残留 '>'", () => {
  const src = readSrc(SRC_REL);
  const i = src.indexOf("function parseReportLines");
  const j = src.indexOf("function renderInline");
  assert.ok(i > 0 && j > i, "应能定位 parseReportLines / renderInline");
  // 剥掉函数签名与局部变量的 TS 类型注解（对象字面量的 key 不受影响）
  const fn = src.slice(i, j).trim().replace(/:\s*(?:ReportLine|string)(?:\[\])?/g, "");
  const parse = new Function(fn + "\nreturn parseReportLines;")() as (
    md: string,
  ) => { kind: string; text: string; items?: string[] }[];

  const md = [
    "# 📈 【A股市场深度复盘与机会前瞻】2026-09-07",
    "",
    "## 📊 市场情绪与风格判断",
    "",
    "- **市场阶段**：**主升浪中段**。",
    "",
    "**综合判断**：交织阶段。",
    "",
    "---",
    "",
    "## 🚀 核心主线与热点板块",
    "",
    "### 1. AI算力（🔥 热度：极高）",
    "",
    "> **关联新闻**：“AI芯片电感”“超级电容从选配变标配”",
    "",
    "- **逻辑推演**：**从单卡到系统**。",
    "",
    "  **① 供电链（需求刚性最强）**",
    "  - 核心受益：**超级电容**（江海股份）",
  ].join("\n");

  const out = parse(md);
  const kinds = out.map((l) => l.kind);

  assert.ok(kinds.includes("quote"), "样例必须解析出 quote 行");
  const q = out.find((l) => l.kind === "quote")!;
  assert.ok(!q.text.includes(">"), `quote 文本不应残留 '>'：${q.text}`);
  assert.ok(q.text.startsWith("**关联新闻**："), `quote 文本应保留正文：${q.text}`);

  // 其余分支不被 quote 抢走
  assert.ok(kinds.includes("hr"), "--- 解析为 hr");
  assert.ok(kinds.includes("h2"), "## 解析为 h2（蓝色竖条大标题）");
  assert.ok(kinds.includes("h3"), "### 解析为 h3");
  assert.ok(kinds.includes("strong"), "`**综合判断**` / `**① 供电链**` 解析为 strong");
  assert.ok(kinds.includes("list"), "- 项目符号解析为 list");
});

// ─── 研报日口径：按数据覆盖的交易日，不按系统日历日（休市日防错） ────────────
// P63 改口径：原来页面只有一个 dataEnd（复盘种子 range.to）却管它叫「最新交易日」，
// 种子一落后就是谎报。现在拆成 dataEnd + marketDay 两个源，措辞交给纯核 report-date-core 判。
// 「措辞」那部分的行为钉测搬到了 p63-report-skeleton.test.ts（直接跑函数，不看源码形状）。

test("研报日取复盘数据的覆盖终点（range.to），不是系统日历日", () => {
  const src = readSrc(SRC_REL);
  assert.ok(src.includes('const [dataEnd, setDataEnd] = useState("")'), "有「数据止于哪天」状态");
  assert.ok(src.includes('const [marketDay, setMarketDay] = useState("")'), "另有行情源最近交易日，用来交叉核对");
  assert.ok(src.includes("const reportDay = caliber.day;"), "研报日由口径核给出");
  assert.ok(src.includes("range?.to"), "数据终点从复盘统计 range.to 取");
  assert.ok(src.includes('fetch("/api/market/trade-date"'), "并行取行情源交易日");
});

test("generate 用数据里的交易日做标题与留档键（休市日不写系统日期）", () => {
  const src = readSrc(SRC_REL);
  assert.ok(
    src.includes("const genDay = /^\\d{4}-\\d{2}-\\d{2}$/.test(dataDay) ? dataDay : reportDay;"),
    "genDay 兜底链：数据交易日 → 最新交易日 → 系统日期",
  );
  assert.ok(src.includes('【A股市场深度复盘与机会前瞻】" + genDay'), "标题用 genDay（不能再用 todayStr）");
  assert.ok(!src.includes('【A股市场深度复盘与机会前瞻】" + todayStr'), "标题不得回退到系统日历日");
  assert.ok(src.includes("tradeDate: genDay }"), "rec 显式带 tradeDate");
  assert.ok(src.includes("tradeDate: rec.tradeDate }"), "留档 POST 带上 tradeDate（否则服务端默认系统日期）");
});

test("休市提示走口径核，不在 JSX 里写死「最新交易日」", () => {
  const src = readSrc(SRC_REL);
  assert.ok(src.includes("const isTradingToday = caliber.isTradingToday;"), "交易日判定由口径核给");
  assert.ok(src.includes("const reportLabel = isTradingToday ? \"今日研报\" : `${reportDay} 研报`;"), "文案按交易日");
  assert.ok(src.includes("{caliber.banner &&"), "提示条渲染的是口径核算出的话");
  // 这句是这次对比里抓到的真错：冻结的种子终点没有行情源核对过，就不能自称「最新交易日」
  assert.equal(
    /研报按最新交易日 \{.*\} 归档/.test(src),
    false,
    "组件里不得再出现写死的「按最新交易日归档」（措辞改由 report-date-core 判定）",
  );
});

test("「打开即读」按最新交易日取（休市日也命中，不因按系统日期查不到而失效）", () => {
  const src = readSrc(SRC_REL);
  assert.ok(src.includes("const [r, rv] = await Promise.all(["), "当日全文 + 最新交易日并行取，不串行等待");
  assert.ok(
    src.includes("if (todayReport && todayReport.tradeDate === tradeDay) hit = todayReport;"),
    "交易日当天走首次请求，零额外等待",
  );
  assert.ok(
    src.includes("`/api/industry-report?date=${encodeURIComponent(tradeDay)}`"),
    "休市日按交易日再取一次",
  );
});

test("服务端列表是权威源：为空也要覆盖本地缓存（删掉的旧研报不能一直挂着）", () => {
  const src = readSrc(SRC_REL);
  assert.ok(
    src.includes("if (!cancelled && lj?.ok && Array.isArray(lj.reports)) {"),
    "列表调用成功即覆盖（不再要求非空）",
  );
  assert.ok(
    !src.includes("Array.isArray(lj.reports) && lj.reports.length"),
    "不得再按「非空才覆盖」——否则已删除的旧研报会残留在历史 chip 里",
  );
});

// ─── 缓存纪律（用户明确要求，防回归） ─────────────────────────────────────

test("已有研报「打开即读」，不重新生成（缓存逻辑未被改动）", () => {
  const src = readSrc(SRC_REL);
  assert.match(src, /fetch\("\/api\/industry-report", \{ cache: "no-store" \}\)/, "首屏直取当日全文");
  assert.match(src, /localStorage\.setItem\("mydesk-industry-reports"/, "服务端命中后回写浏览器缓存");
  assert.match(src, /localStorage\.getItem\("mydesk-industry-reports"/, "服务端无记录时回退本地缓存");
  assert.match(src, /const hasTodayReport = useMemo\(/, "按最新交易日是否已有决定按钮文案");
  assert.match(src, /const next = \[rec, \.\.\.prev\.filter\(\(p\) => p\.tradeDate !== rec\.tradeDate\)\]/, "同交易日覆盖（一天一份）");
  assert.ok(
    src.includes("hasTodayReport ? `重新生成${reportLabel}` : `生成${reportLabel}`"),
    "按钮文案按交易日口径",
  );
});
