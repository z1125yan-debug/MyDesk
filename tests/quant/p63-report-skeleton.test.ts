// P63 产业链研报页：抄稳智的骨架、改我们自己的错，不抄答案（2026-09-27）
//
// 触发点：用户并排两张截图（我们 127.0.0.1:3000/#/llmportal 的「产业链研报分析」vs
// 稳智 aiwuchuan.com 同名页），原话「看看是他们的错了还是我们的错了……**把骨架抄过来 别抄答案**」。
//
// 对比结论（先记账，再钉测）：
// ① 「交易观察日 2026-09-24」两边一致，而且**都是对的** —— 2026-09-25 是中秋节休市、
//    09-26 周六、09-27 周日，最后一个交易日就是 09-24。这一项谁都没错。
// ② 我们真错的地方（本文件钉住）：
//    a) 页面把「复盘统计种子的覆盖终点」（range.to，当前冻结在 09-24，种子不续写就永远停在那天）
//       直接称作「最新交易日」—— 拿会过期的数冒充实时日历。措辞改由 report-date-core 判定。
//    b) 研报正文的度量（字号/行高/竖条）全写在组件里的 text-[17.5px] 这类行内类名上，
//       违反本仓「度量只在 globals.css 一处」的纪律 → 搬进 .rp-* 段。
//    c) 行情源只剩通达信一条腿：网关没起就退到「只认周末」的日历兜底，
//       当场把 09-25（中秋休市）算成最近交易日（/api/market/board 真的吐了 tradeDate=2026-09-25）
//       → 补腾讯日K为第二源，行为钉在 p51-trade-date.test.ts。
// ③ 抄过来的只有骨架：顶栏渐变条 → 英文眉标 → 「研」徽标 + kicker + 大标题 → 分隔线 →
//    元信息三格（生成时间 / 研究视图 / 交易观察日）→ 正文；度量取稳智 .industry-report-* 的实测值。
//    对方正文里把大标题又重复印了一遍（hero 一次、body h1 一次），那是它的瑕疵，不跟 —— 见最后一条钉测。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 本仓源文件是 CRLF，跨行内容先归一成 \n 再钉
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const css = () => read("src/app/globals.css");
const page = () => read("src/components/desk/LlmAnalysisPage.tsx");

/** 取一条 CSS 规则体（从选择器到它自己的收尾 `}`） */
function rule(src: string, sel: string): string {
  const at = src.indexOf(sel + " {");
  assert.ok(at >= 0, `globals.css 里找不到规则 ${sel}`);
  const end = src.indexOf("}", at);
  return src.slice(at, end);
}

// 直接跑纯核，不靠读源码猜行为
const { reportDayCaliber } = await import("../../src/lib/desk/report-date-core.ts");
const { reportTitleOf, fallbackReportTitle, hasReportH1, mendBoldSeams, mendTypos, screenReportShape, REPORT_TITLE_PREFIX } =
  await import("../../src/lib/desk/report-text-core.ts");

// ─── 1. 日期口径：两个人数分开说，没核对过就不许讲「最新交易日」 ──────────────

test("口径①：种子终点与行情源一致 → 这时才有资格说「最新交易日」", () => {
  const c = reportDayCaliber({ dataEnd: "2026-09-24", marketDay: "2026-09-24", marketFromCalendar: false, today: "2026-09-27" });
  assert.equal(c.day, "2026-09-24", "研报日 = 数据覆盖那天");
  assert.equal(c.canClaimLatest, true, "两个源交叉核对过，可以宣称最新交易日");
  assert.equal(c.isTradingToday, false, "09-27 周日不是交易日");
  assert.equal(c.banner, "今日休市（2026-09-27），研报按最新交易日 2026-09-24 归档。", "沿用原来那句话（此刻它是真话）");
  assert.equal(c.note, "即最新交易日");
});

test("口径②：行情源已走到更新的交易日、种子落后 → 研报仍按数据那天，但必须改口", () => {
  const c = reportDayCaliber({ dataEnd: "2026-09-24", marketDay: "2026-09-29", marketFromCalendar: false, today: "2026-09-29" });
  assert.equal(c.day, "2026-09-24", "正文的数只到 09-24，不能拿 09-29 命名（那又是一份错日报）");
  assert.equal(c.canClaimLatest, false, "种子终点已经不是最新交易日，不许再这么写");
  assert.match(c.banner, /数据止于 2026-09-24/, "明说数据止于哪天");
  assert.match(c.banner, /行情源最近交易日已是 2026-09-29/, "同时给出真实交易日，落后多少一目了然");
  assert.match(c.note, /复盘统计数据止于 2026-09-24/, "元信息行也标的是数据终点");
});

test("口径③：行情源只是日历推算（网关和腾讯都没通）→ 一律不当作核实过的交易日", () => {
  // 2026-09-27 实测就是这个形状：日历推算给出 09-25，而 09-25 是中秋休市 —— 拿它核实等于没核实
  const c = reportDayCaliber({ dataEnd: "2026-09-24", marketDay: "2026-09-25", marketFromCalendar: true, today: "2026-09-27" });
  assert.equal(c.canClaimLatest, false, "日历推算值不给「最新交易日」背书");
  assert.equal(c.day, "2026-09-24", "仍按数据终点归档");
  assert.match(c.banner, /行情源未接通/, "把「没核实」这件事写在脸上");
  assert.match(c.banner, /复盘数据止于的 2026-09-24/);
});

test("口径④：两个源都没回来 → 退回系统日期，页面不编一句提示", () => {
  const c = reportDayCaliber({ dataEnd: "", marketDay: "", marketFromCalendar: false, today: "2026-09-27" });
  assert.equal(c.day, "2026-09-27", "取不到数就用系统日期（与 P35 之前的行为一致）");
  assert.equal(c.banner, "", "没有依据就不写提示条");
  assert.equal(c.note, "口径待确认");
});

test("口径⑤：交易日当天 → 按钮与提示都按「今日研报」走，不刷休市提示", () => {
  const c = reportDayCaliber({ dataEnd: "2026-09-29", marketDay: "2026-09-29", marketFromCalendar: false, today: "2026-09-29" });
  assert.equal(c.isTradingToday, true);
  assert.equal(c.banner, "", "开盘当天不该出现「今日休市」");
});

test("脏输入不认：斜杠形状、空串一律回退，不猜日期", () => {
  const c = reportDayCaliber({ dataEnd: "2026/09/24", marketDay: "  ", marketFromCalendar: false, today: "2026-09-27" });
  assert.equal(c.day, "2026-09-27", "形状不对的日期不参与研报日计算");
  assert.equal(c.canClaimLatest, false);
});

// ─── 2. 骨架度量：稳智 .industry-report-* 的实测值钉在 globals.css 一处 ───────

test("globals.css：纸面容器与顶栏（稳智 padding 24/18/28、radius 20px、顶栏 4px 渐隐条）", () => {
  const c = css();
  const paper = rule(c, ".rp-paper");
  assert.match(paper, /border-radius:\s*20px;/);
  assert.match(paper, /padding:\s*24px 18px 28px;/);
  assert.match(paper, /background:\s*linear-gradient\(180deg/);
  const top = rule(c, ".rp-topbar");
  assert.match(top, /height:\s*4px;/);
  assert.match(top, /border-radius:\s*999px;/);
  assert.match(top, /linear-gradient\(90deg/);
});

test("globals.css：眉标 11px/字距 2.64px、kicker 12px/2.4px、徽标 56×56/28px-800、大标题 28px/800", () => {
  const c = css();
  const cov = rule(c, ".rp-coverline");
  assert.match(cov, /font-size:\s*11px;/);
  assert.match(cov, /letter-spacing:\s*2\.64px;/);
  assert.match(cov, /text-transform:\s*uppercase;/);
  const kick = rule(c, ".rp-kicker");
  assert.match(kick, /font-size:\s*12px;/);
  assert.match(kick, /letter-spacing:\s*2\.4px;/);
  const badge = rule(c, ".rp-badge");
  assert.match(badge, /width:\s*56px;/);
  assert.match(badge, /height:\s*56px;/);
  assert.match(badge, /font-size:\s*28px;/);
  const title = rule(c, ".rp-title");
  assert.match(title, /font-size:\s*28px;/);
  assert.match(title, /line-height:\s*1\.16;/);
  assert.match(title, /font-weight:\s*800;/);
});

test("globals.css：分隔线渐隐 + 元信息行 13px/gap 14px/下边框（稳智 subline 同款）", () => {
  const c = css();
  assert.match(rule(c, ".rp-divider"), /height:\s*2px;/);
  assert.match(rule(c, ".rp-divider"), /linear-gradient\(90deg/);
  const sub = rule(c, ".rp-subline");
  assert.match(sub, /font-size:\s*13px;/);
  assert.match(sub, /gap:\s*6px 14px;/);
  assert.match(sub, /border-bottom:\s*1px solid var\(--border\);/);
});

test("globals.css：正文 16px/1.9、h2 23px/800 带蓝竖条、h3 18px/800、li 15px/1.9（稳智实测档位）", () => {
  const c = css();
  const body = rule(c, ".rp-body");
  assert.match(body, /font-size:\s*16px;/);
  assert.match(body, /line-height:\s*1\.9;/);
  assert.match(body, /max-width:\s*1040px;/);
  const h2 = rule(c, ".rp-h2");
  assert.match(h2, /font-size:\s*23px;/);
  assert.match(h2, /border-left:\s*4px solid var\(--primary\);/);
  assert.match(h2, /padding-left:\s*14px;/);
  assert.match(rule(c, ".rp-h"), /font-weight:\s*800;/);
  const h3 = rule(c, ".rp-h3");
  assert.match(h3, /font-size:\s*18px;/);
  assert.match(rule(c, ".rp-body li"), /font-size:\s*15px;/);
  assert.match(rule(c, ".rp-body li"), /line-height:\s*1\.9;/);
  assert.match(rule(c, ".rp-body ul"), /padding-left:\s*26px;/);
  const q = rule(c, ".rp-quote");
  assert.match(q, /border-left:\s*4px solid/);
  assert.match(q, /padding-left:\s*20px;/);
});

// ─── 3. 组件挂载：只挂类名，不再写行内字号 ────────────────────────────────

test("组件：ReportPaper 挂出六段骨架，字段全部来自我们自己的记录", () => {
  const src = page();
  for (const cls of ["rp-paper", "rp-topbar", "rp-coverline", "rp-hero", "rp-badge", "rp-kicker", "rp-title", "rp-divider", "rp-subline", "rp-body"]) {
    assert.ok(src.includes(cls), `骨架缺一层：.${cls}`);
  }
  assert.ok(src.includes('<div className="rp-badge" aria-hidden>研</div>'), "「研」徽标");
  assert.ok(src.includes('<div className="rp-kicker">产业链专题复盘</div>'), "kicker 是结构性文案");
  assert.ok(src.includes("生成时间 <strong>{new Date(generatedAt).toLocaleString"), "生成时间取自我们的记录 ts");
  assert.ok(src.includes("交易观察日 <strong>{observeDate"), "交易观察日取自我们的留档 tradeDate");
  assert.ok(src.includes("title={active.title}"), "大标题用我们自己生成的标题，不抄对方文案");
});

test("组件：成稿与流式草稿共用同一套骨架（生成中就能看到顶栏/徽标/元信息）", () => {
  const src = page();
  assert.ok(src.includes("<ReportMarkdown text={active.text} />"), "成稿正文");
  assert.ok(src.includes("<ReportMarkdown text={draft} />"), "草稿用同一套排版渲染");
  assert.equal((src.match(/<ReportPaper/g) ?? []).length, 2, "成稿 + 流式两处各挂一张纸面");
});

// 2026-09-27 端到端复测点「重新生成」时发现的顺序 bug：草稿分支原本挂在 `active` 之后，
// 而本地留档打开即读 → active 一直有值 → 流式那条腿根本不可达，界面停在旧研报上，
// 全文到齐才整页跳成新稿（用户看到的还是"卡住了"）。所以现在渲染优先级是 draft > active。
test("渲染优先级：流式草稿排在成稿之前 —— 重新生成时看得到字一条条出来", () => {
  const src = page();
  const atDraft = src.indexOf("busy && draft ? (");
  const atFinal = src.indexOf("title={active.title}");
  assert.ok(atDraft >= 0, "流式分支的条件必须是 busy && draft（不再嵌在 active 的 else 里）");
  assert.ok(atFinal >= 0, "成稿分支还在");
  assert.ok(atDraft < atFinal, "草稿分支先判：已有旧研报时也要能走流式纸面");
  assert.ok(src.indexOf("<ReportPaper", atDraft) < atFinal, "第一张纸面就是流式那张");
  // 生成失败要退回旧稿，所以生成期间不许把 active 清掉
  assert.equal(src.includes("setActive(null)"), false, "不清空 active：失败/中断时退回上一份，不白屏");
  assert.ok(src.includes('} finally { setBusy(false); setDraft(""); }'), "收尾只关 busy 与草稿");
  // 旧形状反向钉：`busy ? (draft ? 纸面 : 提示)` 那种把草稿关在 active 之后的写法不许回来
  assert.equal(/\) : busy \? \([\s\S]{0,120}draft \? \(/.test(src), false, "草稿不许再套在 busy 分支里面");
});

test("组件：研报度量回到 CSS 一处 —— 组件里不再留行内字号", () => {
  const src = page();
  for (const dead of ["text-[33px]", "text-[39px]", "text-[17.5px]", "text-[27px]", "text-[31px]", "text-[16.5px]", "leading-[1.9]"]) {
    assert.equal(src.includes(dead), false, `行内度量已清掉：${dead}`);
  }
  assert.equal(src.includes("border-l-4 border-sky-500"), false, "章节竖条改由 .rp-h2 画");
});

test("不跟对方的瑕疵：正文首个 H1 仍被剥掉，大标题只出现在 hero 一处", () => {
  const src = page();
  // 稳智那侧 hero 与 body 各印一遍标题；我们的渲染器一开始就把正文首行 H1 去掉
  assert.ok(src.includes('text.replace(/^\\s*#\\s+.*\\r?\\n/, "")'), "剥掉与 hero 重复的首行 H1");
  assert.ok(src.includes('className="rp-h rp-h2"'), "章节标题走 .rp-h2");
});

// ─── 4. 大标题取值与正文断口修补（实测翻出来的第二个真错） ──────────────────
// 2026-09-27 换 mercury-2 后实测：模型会跳过 prompt 要求的首行 `# 📈 【…】日期`，
// 正文直接从 `## 📊 市场情绪与风格判断` 开始。而旧代码是「取第一个非空行当标题」
// → 封面大标题变成了一个小节标题，观察日也从标题里丢了。

test("取标题：正文有 H1 用 H1；没有 H1 用交易日模板兜底，绝不拿小节标题冒充", () => {
  const withH1 = "# 📈 【A股市场深度复盘与机会前瞻】2026-09-24\n\n## 📊 市场情绪与风格判断\n- 内容";
  assert.equal(reportTitleOf(withH1, "2026-09-24"), "📈 【A股市场深度复盘与机会前瞻】2026-09-24");
  const noH1 = "## 📊 市场情绪与风格判断  \n- **市场阶段**：震荡回调";
  assert.equal(reportTitleOf(noH1, "2026-09-24"), "📈 【A股市场深度复盘与机会前瞻】2026-09-24", "跳过 H1 时按交易日兜底");
  assert.equal(hasReportH1(withH1), true);
  assert.equal(hasReportH1(noH1), false, "## 是小节标题，不算 H1");
  assert.equal(reportTitleOf("", ""), "📈 【A股市场深度复盘与机会前瞻】", "空正文也不出错");
});

test("兜底标题形状与 prompt 要求的首行一致（前缀 + 日期，无多余空格）", () => {
  assert.equal(REPORT_TITLE_PREFIX, "📈 【A股市场深度复盘与机会前瞻】");
  assert.equal(fallbackReportTitle("2026-09-24"), "📈 【A股市场深度复盘与机会前瞻】2026-09-24");
  assert.equal(fallbackReportTitle("脏值"), REPORT_TITLE_PREFIX, "日期形状不对就不拼，不编一个日期");
});

test("断口加粗修补：`% ****中盘比例**` 收回到 `**`，连续加粗之间补出分隔", () => {
  assert.equal(
    mendBoldSeams("- **情绪温度**：**🧊 冰冷**，**微盘比例** 39.29% ****中盘比例** 21.90%"),
    "- **情绪温度**：**🧊 冰冷**，**微盘比例** 39.29% **中盘比例** 21.90%",
  );
  // 2026-09-27 第二轮实测：模型真会写出 `**微盘占比****39.29%**`（中间四个星号）
  // 和 `**跌停******13只**`（六个）—— 后者浏览器会露一对裸星号，前者两段词粘成一句。
  assert.equal(mendBoldSeams("**公司A****公司B**"), "**公司A** **公司B**", "相邻加粗之间补空格分隔");
  assert.equal(mendBoldSeams("**跌停******13只**"), "**跌停** **13只**", "六个星号同样收回一对 + 一对");
  assert.equal(mendBoldSeams("**市场阶段**：进入**低位震荡**"), "**市场阶段**：进入**低位震荡**", "正常成对写法一个字都不动");
  assert.equal(/\*{4,}/.test(mendBoldSeams("A ****B** C **D****E**")), false, "修补后不该再留四个以上连星");
});

// 第三轮实测（11:30 那份）：策略总结那一行的 `**` 是 27 个（奇数）—— 模型在句首多打了一对收尾星号
// （`综合** **情绪偏冷**、**技术面**…`）。顺序配对会把整行加粗错位一格，行尾再露一对裸星号。
test("奇数个加粗标记的行：删掉多打的那一对，整行不错位（只动星号，一个字都不改）", () => {
  const line = "综合** **情绪偏冷**、**技术面压制**以及**资金面收紧**，关注 **监管动态** 与 **技术指标** 调整仓位。";
  const out = mendBoldSeams(line);
  assert.equal((out.match(/\*\*/g) ?? []).length % 2, 0, "行内 `**` 个数变成偶数");
  assert.equal(out.replace(/\*/g, ""), line.replace(/\*/g, ""), "只删星号，正文一字不动");
  assert.equal(out, "综合 **情绪偏冷**、**技术面压制**以及**资金面收紧**，关注 **监管动态** 与 **技术指标** 调整仓位。");
  // 正常写法（偶数个）一律不碰 —— 包括 ② 刚造出来的 `**A** **B**`
  assert.equal(mendBoldSeams("**公司A** **公司B**"), "**公司A** **公司B**", "偶数个标记 = 合法分隔，不裁");
  assert.equal(mendBoldSeams("开头**加粗**结尾**"), "开头**加粗**结尾", "没有该形状时删行末最后一个");
});

// ─── 5. 文字口误修补：数字顶仓位补 %、受5基站补 G（2026-09-27 实测两条真实口误）────

test("口误修补：「15仓位」补 %、「受5基站」补 G", () => {
  assert.equal(mendTypos("采取15仓位滚动操作"), "采取15%仓位滚动操作", "数字顶仓位 = 漏打百分号");
  assert.equal(mendTypos("受益于5基站建设加速"), "受益于5G基站建设加速", "股票语境的 5基站 = 5G基站被吞了 G");
});

test("口误修补不误伤：已有 %、成/股/序数/小数一律不碰", () => {
  const untouched = [
    "仓位控制在5%‑10%之间",
    "建议按3成仓位参与",
    "买1000股仓位已打满",
    "第5基站年内开工",
    "共5基站纳入规划",
    "指数11.5基站这种小数尾巴",
  ];
  for (const s of untouched) assert.equal(mendTypos(s), s, `不该动的被动了：${s}`);
});

test("组件接线：成稿落库前过一遍口误修补（流式草稿不补，半截句子容易误判）", () => {
  const src = page();
  assert.ok(src.includes("mendTypos(mendBoldSeams(skeleton.text))"), "修补排在骨架兜底与加粗修补之后、入库之前");
});

// ─── 6. 跑偏拦门：模型塌缩成星号墙时，不许覆盖当天原本能看的那份 ────────────
// 实测样本：2026-09-27 11:22 那轮生成，最后一行 7689 字符、其中 7642 个是 `*`，
// 全文 87.4% 的字符是星号。旧流程把它直接写进留档，把 11:15 那份正常研报冲掉了。
// 对照样本：同日正常研报（industry-reports.json.p63bak）星号占比 0.8%、没有长连星。

test("拦门：星号复读墙 → 判定跑偏，给出人话理由", () => {
  const wall = "## 📊 市场情绪与风格判断\n- **操作建议**：**光迅科技**" + "*".repeat(7642);
  const s = screenReportShape(wall);
  assert.equal(s.ok, false, "连续 7642 个星号必须拦下");
  assert.match(s.reason, /连续 76\d\d 个星号/);
  assert.match(s.reason, /已保留原来那份/);
  assert.match(s.reason, /没有覆盖留档/);
  assert.ok(s.starRatio > 0.8, "占比证据也要带出来");
});

test("拦门：单行长墙（不带星号）也拦，只有一行不成结构", () => {
  const s = screenReportShape("开头\n" + "板块".repeat(2000));
  assert.equal(s.ok, false);
  assert.match(s.reason, /单行 \d+ 字/);
});

test("拦门：正常研报放行 —— 阈值离实测形状很远，不误伤", () => {
  const normal = [
    "# 📈 【A股市场深度复盘与机会前瞻】2026-09-24",
    "## 📊 市场情绪与风格判断",
    "- **市场阶段**：进入**低位震荡**，上证指数收于 3400 点附近。",
    "> **关联新闻**：“题目一”“题目二”“题目三”",
    "## 🧭 策略总结",
    "建议**聚焦主线、控制仓位**。",
  ].join("\n");
  const s = screenReportShape(normal);
  assert.equal(s.ok, true, "成对加粗 + 正常行长 → 放行");
  assert.equal(s.reason, "");
  // 粗斜体（***text***）是连续 3 个星号，属于合法写法，不能当塌缩
  assert.equal(screenReportShape("- ***重点*** 说明").ok, true);
});

test("组件接线：拦门跑在入库之前，跑偏时不改 active、只报错", () => {
  const src = page();
  assert.ok(src.includes("import { mendBoldSeams, mendReportSkeleton, mendTypos, reportTitleOf, screenReportShape }"), "screenReportShape 已接入");
  assert.ok(src.includes("const shape = screenReportShape(String(content));"));
  assert.ok(src.includes("if (!shape.ok) throw new Error(shape.reason);"), "拦下就抛错，不进留档");
  const atScreen = src.indexOf("const shape = screenReportShape");
  // 注意搜的是**写留档**那一处（POST），不是打开页面时读留档的那处 fetch
  const atStore = src.indexOf('const sr = await fetch("/api/industry-report"');
  assert.ok(atScreen >= 0 && atStore >= 0 && atScreen < atStore, "拦门必须在写留档（POST 覆盖当天那份）之前");
  assert.ok(src.includes("红线 2：两个加粗之间必须有"), "prompt 同时补了加粗红线（源头治理）");
  // P65 改口：快讯池是「研报区间＝最近三个交易日」的（不再是抓取当天那 12 条），空位措辞跟着口径走——见 p65 的口径钉测
  assert.ok(src.includes("本区间快讯池里没有与该主线直接相关的题目"), "关联新闻不许挪用无关标题（口径不许撒谎）");
  assert.ok(src.includes("红线 4：数值只能照抄下方真实数据"), "不许编造数据里没有的点位");
});

test("组件接线：生成与流式草稿都走这套取标题/修补逻辑", () => {
  const src = page();
  // P64：拦门之后多了一步骨架兜底，入库正文 = 补过标题的文本再过加粗修补（顺序见 p64 接线钉测）
  assert.ok(src.includes("const skeleton = mendReportSkeleton(String(content));"), "入库前先补回漏掉的小节标题");
  assert.ok(src.includes("const text = mendTypos(mendBoldSeams(skeleton.text));"), "再补断口加粗与两条已证实的文字口误");
  assert.ok(src.includes("const title = reportTitleOf(text, genDay);"), "标题走兜底逻辑，不再抓第一个非空行");
  assert.ok(src.includes("title={reportTitleOf(draft, reportDay)}"), "流式期间的封面标题同口径");
  assert.ok(src.includes("setDraft(mendBoldSeams(full));"), "流式期间也过加粗修补，不露满屏裸星号");
  assert.equal(src.includes("const firstLine = String(content).split"), false, "旧的「抓第一个非空行当标题」已下线");
});
