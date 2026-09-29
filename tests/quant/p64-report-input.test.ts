// P64 研报的「输入层」：中文口径 + 真实指数趋势 + 本地量化判读（2026-09-27）
//
// 触发点：用户贴我们研报页截图问
//   「为什么我们的是**震荡回落**，稳智那边是**结构性主升浪中段 —— 增量信息密集指向AI硬件业绩兑现阶段，
//     而非纯主题炒作**，谁错了？」
//
// 裁定（先记账再钉测，全部用真实接口读数，不靠观感）：
// ① 方向上**我们是对的**：上证 09-24 收 3888.37（-1.22%），在 MA5 3927.76 / MA10 3904.37 /
//    MA20 3926.74 / MA60 3913.69 **四条均线全部下方**，距 60 日收盘高点（4043.64）回撤 -3.84%；
//    当日下跌 3952 家、只有 27.56% 的个股站上 5 日均线、全A -1.82%。
//    这种截面叫「主升浪中段」是说不通的 —— 对方那半句错。
// ② 对方「AI硬件业绩兑现」那半句也缺证据：我们没喂任何业绩/调研/订单数据，
//    而资金侧真实读数是**反的**（光通信 3 日 -165.37 亿、CPO/相关 -162.25 亿、算力 -20.83 亿、内存 -22.93 亿，
//    流入的是半导体 +80.30 亿、人工智能 +130.30 亿、AI大模型 +62.26 亿）。
// ③ 但我们自己也有真错，而且错在**输入层**（这才是要修的）：旧 prompt 用 `JSON.stringify(rows)`
//    把英文字段原样塞给模型，模型不懂语义 → 把「站上5日均线占比 27.56%」写成「跌破率 27.56%」、
//    把 microPct 写成「微观成交占比 39.29%」、把 aboveMa5Pct/microPct 这种内部字段名漏进正文，
//    还在没喂点位的情况下编出「指数在 3000 点附近震荡」「跌破 2950 加仓」「MA5已跌破MA10」。
//    更讽刺的是本地量化引擎早就算过权威判读（桶=退潮、阶段=退潮反抽、置信度 0.66），只是没喂给它。
//
// 所以本文件钉的是：读数算得对、口径写得明、判读原文喂进去、字段名不漏、正文不许自造数。
// 抄稳智的部分照旧只抄骨架（结构/度量在 p63 钉），这里一条对方正文结论都没搬。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const page = () => read("src/components/desk/LlmAnalysisPage.tsx");

const core = await import("../../src/lib/desk/report-input-core.ts");
const { indexTrendFromCandles, indexTrendZh, METRIC_DEFS_ZH, reviewRowsZh, localVerdictZh, themeFlowsZh } = core;
const { mendReportSkeleton, REPORT_DISCLAIMER_LINE, mendBoldSeams } = await import("../../src/lib/desk/report-text-core.ts");

// 真实日 K 尾部 20 根（2026-08-28 → 09-24，date/c 直接抄自
// GET /api/market/kline?symbol=000001.SH&tf=日线&fq=none 的 candles）
const REAL_CLOSES_20 = [
  3952.18, 3986.3, 3979.89, 3941.39, 3942.09, 3930.12, 3932.7, 3940.55, 3951.51, 3934.4,
  3888.11, 3885.33, 3864.28, 3891.6, 3875.6, 3911.87, 3949.91, 3952.13, 3936.52, 3888.37,
];
const REAL_DATES_20 = [
  "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07",
  "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16",
  "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24",
];
const REAL_TAIL_20 = REAL_CLOSES_20.map((c, i) => ({ date: REAL_DATES_20[i], c }));
const REAL_0924 = [
  { date: "2026-09-23", c: 3936.52 },
  { date: "2026-09-24", c: 3888.37 },
];

// ─── 1. 指数趋势读数：均线数学必须与真实接口一致 ─────────────────────────

test("indexTrendFromCandles：真实 09-24 尾部 20 根 → 收 3888.37、当日 -1.22%、MA5 3927.76 > MA10 3904.37", () => {
  const t = indexTrendFromCandles(REAL_TAIL_20);
  assert.ok(t);
  assert.equal(t.close, 3888.37);
  assert.equal(t.chgPct, -1.22, "(3888.37-3936.52)/3936.52 = -1.215% → -1.22");
  const byN = Object.fromEntries(t.mas.map((m) => [m.n, m.v]));
  assert.equal(byN[5], 3927.76);
  assert.equal(byN[10], 3904.37);
  assert.equal(byN[20], 3926.74);
  assert.equal(byN[60], undefined, "只有 20 根样本时不许给 MA60 编一个数");
  assert.equal(t.bars, 20);
});

test("indexTrendFromCandles：收盘在 MA5/10/20 全部下方 → belowMas 三个都要列出来（'震荡回落'的实证）", () => {
  const t = indexTrendFromCandles(REAL_TAIL_20)!;
  assert.deepEqual(t.belowMas, [5, 10, 20], "3888.37 低于三条均线；若哪天站上了就该为空，不许写死");
});

test("indexTrendFromCandles：距 60 日收盘高点用窗口内最大值，负数=回撤", () => {
  const bars = Array.from({ length: 59 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, c: i === 20 ? 4000 : 3000 }));
  bars.push({ date: "2026-09-24", c: 3800 }); // 窗口高点 = 4000
  const t = indexTrendFromCandles(bars)!;
  assert.equal(t.offHighPct, -5, "(3800-4000)/4000 = -5%");
  assert.equal(t.bars, 60);
  // MA60 = (3000*58 + 4000 + 3800)/60 = 181800/60
  assert.equal(t.mas.find((m) => m.n === 60)!.v, 3030, "MA60 必须把那根高点也算进去");
  assert.equal(t.date, "2026-09-24");
});

test("indexTrendFromCandles：样本不足 / 脏数据 / 空输入一律返回 null，不返回半截读数", () => {
  assert.equal(indexTrendFromCandles([]), null);
  assert.equal(indexTrendFromCandles(null), null);
  assert.equal(indexTrendFromCandles(undefined), null);
  assert.equal(indexTrendFromCandles([{ date: "2026-09-24", c: 3888.37 }]), null, "一根算不出涨跌，宁可不喂");
  assert.equal(indexTrendFromCandles([{ date: "a", c: "x" }, { date: "b", c: null as never }]), null);
  const mixed = indexTrendFromCandles([{ date: "2026-09-23", c: "3936.52" }, { date: "2026-09-24", c: 3888.37 }]);
  assert.equal(mixed!.bars, 2, "字符串收盘价要能解析");
  assert.equal(mixed!.close, 3888.37, "取最后一根，不是第一条");
  assert.equal(mixed!.chgPct, -1.22);
});

test("indexTrendFromCandles：日期取最后一根 K 线的交易日（正文口径不能拿窗口首日冒充当日）", () => {
  assert.equal(indexTrendFromCandles(REAL_TAIL_20)!.date, REAL_TAIL_20[REAL_TAIL_20.length - 1].date.slice(0, 10));
  assert.equal(indexTrendFromCandles(REAL_0924)!.date, "2026-09-24");
});

// ─── 2. 中文趋势行：喂给模型的措辞本身要把「不许自造」写进去 ───────────────

test("indexTrendZh：给出点位 / 均线 / 站在线下方 / 回撤，全是一条中文行", () => {
  const line = indexTrendZh("上证指数(000001.SH)", indexTrendFromCandles(REAL_TAIL_20));
  assert.match(line, /上证指数\(000001\.SH\)/);
  assert.match(line, /收 3888\.37/);
  // 09-30 同步：涨跌必须带符号+方向词（曾因「当日 0.18%」无符号，被模型按熊市语境脑补成「跌幅 0.18%」）
  assert.match(line, /当日涨跌 -1\.22%（下跌）/);
  assert.match(line, /MA5=3927\.76 \/ MA10=3904\.37 \/ MA20=3926\.74/);
  assert.match(line, /收盘位于 MA5、MA10、MA20 下方/);
  assert.match(line, /距最近 20 个交易日收盘高点 -2\.46%/, "(3888.37-3986.3)/3986.3：样本不足 60 根时按实际窗口算，不谎称 60 日");
  assert.doesNotMatch(line, /aboveMa5Pct|limitUp/, "中文行里不出现内部字段名");
});

test("indexTrendZh：K线取不到时明写「数据不足」并要求该项不得出现在正文（不是静默省略）", () => {
  const line = indexTrendZh("创业板指(399006.SZ)", null);
  assert.match(line, /K线数据不足/);
  assert.match(line, /不要出现在正文里/);
});

test("indexTrendZh：站上全部均线时不许写「位于…下方」（避免把反弹日钉成弱势）", () => {
  const up = Array.from({ length: 6 }, (_, i) => ({ date: `d${i}`, c: 3000 + i * 10 }));
  const t = indexTrendFromCandles(up)!;
  assert.deepEqual(t.belowMas, []);
  assert.match(indexTrendZh("指数X", t), /收盘站上全部给出的均线/);
  assert.doesNotMatch(indexTrendZh("指数X", t), /下方/);
});

// ─── 3. 指标口径：把语义写死，模型不许按字段名猜（口径反了就是这么来的）────

test("METRIC_DEFS_ZH：aboveMa5Pct 是「站上」的比例，不是跌破率 —— 旧正文就是把它写反了", () => {
  const def = METRIC_DEFS_ZH.find((s) => s.includes("站上5日均线占比"))!;
  assert.match(def, /收盘价在 5 日均线上方/);
  assert.match(def, /不是跌破率/, "必须显式反着钉一句：上次实测模型把它读成了「跌破率 27.56%」");
  assert.match(def, /越低说明弱势面越大/);
});

test("METRIC_DEFS_ZH：microPct 是分层「站线比例」，不是成交额占比", () => {
  const def = METRIC_DEFS_ZH.find((s) => s.includes("微盘"))!;
  assert.match(def, /个股站线比例/);
  assert.match(def, /不是成交额占比/, "旧正文写成「微观成交占比 39.29%」");
});

test("METRIC_DEFS_ZH：3日资金给正负号语义（负数=流出，光通信/CPO 那两条 -165/-162 亿别读反）", () => {
  const def = METRIC_DEFS_ZH.find((s) => s.includes("3日资金"))!;
  assert.match(def, /正数=流入/);
  assert.match(def, /负数=流出/);
});

test("reviewRowsZh：真实 09-24 一行，数字照抄、字段名一个都不留", () => {
  const row = {
    date: "2026-09-24", limitUp: 51, limitDown: 13, t3: 1, t4: 3, t5: 1, maxBoards: 5,
    decliners: 3952, belowMa5: 3738, belowMa3: 4159, aboveMa5Pct: 27.56,
    microPct: 39.29, midPct: 21.9, largePct: 16.37,
  };
  const [line] = reviewRowsZh([row]);
  assert.match(line, /2026-09-24：涨停51家 跌停13家 最高连板5/);
  assert.match(line, /下跌3952家；站上5日均线占比 27\.56%/);
  assert.match(line, /微盘 39\.29% \/ 中盘 21\.9% \/ 大盘 16\.37%/);
  assert.match(line, /跌破MA5 3738家、跌破MA3 4159家/);
  for (const key of ["aboveMa5Pct", "microPct", "decliners", "limitUp", "belowMa5", "midPct", "largePct", "maxBoards"]) {
    assert.doesNotMatch(line, new RegExp(key), `内部字段名 ${key} 不许漏给正文（用户截图里就有 aboveMa5Pct/microPct）`);
  }
});

test("reviewRowsZh：缺字段写「数据不足」，不补 0 冒充读数", () => {
  const [line] = reviewRowsZh([{ date: "2026-09-24", aboveMa5Pct: null }]);
  assert.match(line, /涨停数据不足/);
  assert.match(line, /站上5日均线占比 数据不足%/);
});

// ─── 4. 本地量化引擎判读：权威结论原文喂，别让写研报的模型自己定性 ──────────

test("localVerdictZh：真实 inference（桶=退潮、阶段=退潮反抽、置信度 0.66）逐字进 prompt", () => {
  const th = {
    market_env: { as_of_trade_date: "2026-09-24", label: "衰退" },
    inference: {
      as_of_date: "2026-09-24", confidence: 0.66, market_bucket: "退潮", market_phase: "退潮反抽",
      reason: "上证指数(000001)2026-09-24当日-1.22%，收盘3888.37点即为当日最低点…站上均线比例由09-21的89.52%…降至09-24的27.56%",
    },
  };
  const s = localVerdictZh(th);
  assert.match(s, /市场桶=退潮/);
  assert.match(s, /阶段=退潮反抽/);
  assert.match(s, /环境标签=衰退/);
  assert.match(s, /置信度=0\.66/);
  assert.match(s, /截至 2026-09-24/);
  assert.match(s, /必须与之一致/, "定性口径钉在数据里，不是等模型自觉");
  assert.match(s, /或明写分歧点/, "允许 disagree，但必须指出分歧在哪");
  assert.match(s, /依据：[\s\S]*27\.56%/, "reason 原文带上，含真实点位 3888.37");
  assert.doesNotMatch(s, /主升浪|业绩兑现/, "我们自己的判读里没有这种定性，别把它当权威喂进去");
});

test("localVerdictZh：判读缺失时明说「没有给出」，并要求正文不得编阶段结论", () => {
  assert.match(localVerdictZh(null), /本次没有给出/);
  assert.match(localVerdictZh(null), /不要编市场阶段结论/);
  assert.match(localVerdictZh({ inference: null, market_env: null }), /本次没有给出/);
});

test("localVerdictZh：只有环境标签也算有判读，缺的项写「数据不足」而不是编一个阶段名", () => {
  const s = localVerdictZh({ market_env: { label: "震荡" }, inference: null });
  assert.match(s, /市场桶=数据不足/);
  assert.match(s, /阶段=数据不足/);
  assert.match(s, /环境标签=震荡/);
  assert.doesNotMatch(s, /置信度=\d/);
});

test("localVerdictZh：超长 reason 截断，但不截掉定性头（prompt 不能整段是依据）", () => {
  const s = localVerdictZh({ inference: { market_bucket: "退潮", market_phase: "退潮反抽", reason: "啊".repeat(3000) } });
  assert.ok(s.length < 900, `拼好的判读控制在 900 字内（实得 ${s.length}）`);
  assert.match(s, /阶段=退潮反抽/);
});

// ─── 5. 主线热度与资金：中文行、正负号语义 ────────────────────────────────

test("themeFlowsZh：真实 09-24 主线（半导体 +80.30 / 光通信 -165.37）一行行业一行概念", () => {
  const out = themeFlowsZh(
    [{ n: "半导体", h: 94, f: 80.30281 }, { n: "人工智能", h: 92, f: 130.304863 }, { n: "光通信", h: 86, f: -165.372113 }],
    [{ n: "算力/液冷", h: 96, f: -20.826656 }, { n: "AI大模型/多模态", h: 90, f: 62.257817 }],
  );
  assert.equal(out.length, 2);
  assert.match(out[0], /^行业主线：半导体\(热度94，3日资金80\.30亿\)/);
  assert.match(out[0], /光通信\(热度86，3日资金-165\.37亿\)/, "负号必须留着：资金流出是驳'业绩兑现'那半句的证据");
  assert.match(out[1], /^概念主线：/);
  assert.match(out[1], /3日资金-20\.83亿/);
});

test("themeFlowsZh：概念榜单限量（默认 8 条），缺输入时返回空数组而不是 'undefined' 行", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ n: "c" + i, h: 50, f: i }));
  const out = themeFlowsZh([], many);
  assert.equal(out.length, 1);
  assert.equal((out[0].match(/热度50/g) ?? []).length, 8);
  assert.deepEqual(themeFlowsZh(null, undefined), []);
});

// ─── 6. 组件接线：prompt 的数据段真的换成中文口径了（不是只写了个纯核没人用）──

test("研报 prompt 数据段：①–⑥ 六块齐全，且顺序是 指数趋势 → 判读 → 口径 → 复盘 → 资金 → 新闻", () => {
  const src = page();
  for (const tag of ["① 指数趋势", "② \" + verdictZh", "③ 指标口径", "④ 最近三个交易日复盘统计", "⑤ 当日主线热度与 3 日资金", "⑥ ${newsLabel}"]) {
    assert.ok(src.includes(tag), `prompt 数据段缺 ${tag}`);
  }
  assert.ok(src.indexOf("① 指数趋势") < src.indexOf("② \" + verdictZh"), "先给点位再给定性的依据");
  assert.ok(src.indexOf("③ 指标口径") < src.indexOf("④ 最近三个交易日复盘统计"), "口径必须先于读数出现");
});

test("反向钉：prompt 里不许再出现任何 JSON.stringify（英文字段直喂 = 口径反读的根因）", () => {
  const src = page();
  const at = src.indexOf("const prompt = [");
  const block = src.slice(at, src.indexOf('].join("\\n")', at));
  assert.ok(block.length > 1000, "取到的是研报 prompt 那一段");
  assert.doesNotMatch(block, /JSON\.stringify/, "数据段必须全部走 report-input-core 的中文行");
  assert.doesNotMatch(src, /JSON\.stringify\(rowsZh\)|JSON\.stringify\(indexZh\)/);
});

test("反向钉：prompt 不许把英文字段当「键: 值」喂数据（英文 key 只允许出现在口径注记/反例里）", () => {
  const src = page();
  const at = src.indexOf("const prompt = [");
  const block = src.slice(at, src.indexOf('].join("\\n")', at));
  assert.doesNotMatch(block, /"(aboveMa5Pct|microPct|decliners|limitUp|belowMa5|maxBoards)"\s*:/, "又回到 JSON 直喂了");
  assert.doesNotMatch(block, /\b(aboveMa5Pct|microPct|decliners|limitUp)\s*[=:]\s*-?\d/, "英文字段后面直接跟数字 = 模型要自己猜语义");
});

test("组件真的取了三条指数日 K（不喂点位 → 模型就编 3000 点）", () => {
  const src = page();
  for (const sym of ["000001.SH", "399001.SZ", "399006.SZ"]) {
    assert.ok(src.includes(`klineUrl("${sym}")`), `缺 ${sym} 的并取`);
  }
  assert.match(
    src,
    /getJson<\{ candles\?:[^>]*>\(klineUrl\("000001\.SH"\)\)\.catch\(\(\) => \(\{ candles: undefined \}\)\)/,
    "K线取数失败要降级为 undefined：纯核输出「K线数据不足」，而不是崩掉整轮生成",
  );
  assert.ok(src.includes('const klineUrl = (symbol: string) => `/api/market/kline?symbol=${symbol}&tf=${encodeURIComponent("日线")}&fq=none`'),
    "日K URL 口径只写一处");
});

test("「市场阶段」这一条的指令锚定到本地判读，而不是让模型自由定性", () => {
  const line = page().split("\n").find((l) => l.includes('"- **市场阶段**：'));
  assert.ok(line);
  assert.match(line, /本地量化引擎判读/);
  assert.match(line, /引用指数趋势里的真实点位/);
  assert.match(line, /不许自己定性/, "「结构性主升浪中段」这类定性只能来自判读，不能来自模型发挥");
});

test("硬性纪律 4/5：不许漏内部字段名；没喂基本面就不许写「业绩兑现 / 主升浪中段」", () => {
  const src = page();
  assert.match(src, /正文里不许出现内部字段名（aboveMa5Pct、microPct/);
  assert.match(src, /不许写「业绩兑现阶段」「主升浪中段」/);
  assert.match(src, /只能说数据里给到的情绪面 \/ 资金面 \/ 热度读数/);
  assert.match(src, /红线 4：数值只能照抄下方真实数据/);
  assert.match(src, /不准写「3000 点」「跌破 2950 加仓」/, "把这次抓到的两条假读数写进红线，防止回归");
});

test("硬性纪律 6/7：新闻只能逐字照抄、公司只准 A 股上市（12:05 那轮编了新闻标题和星际荣耀）", () => {
  const src = page();
  assert.match(src, /新闻只能从 ⑥ 里逐字照抄原标题/);
  assert.match(src, /把它后面的日期标注一起抄下来/);
  assert.match(src, /受益标的只写 A 股上市公司/);
  for (const bad of ["星际荣耀", "华为海思", "长江存储"]) {
    assert.ok(src.includes(bad), `反面例子 ${bad} 要点名（模型真把它们当过标的）`);
  }
  assert.match(src, /拿不准公司是否上市，就只写产业链环节名/);
});

test("快讯口径（P65）：⑥ 要说清「研报区间是哪几天 / 共多少条 / 抓取于哪天 / 有没有翻完」", () => {
  const src = page();
  assert.match(src, /⑥ \$\{newsLabel\}/);
  assert.match(src, /fetchedOn: todayStr/, "抓取日要单独交代，不许和区间混在一起");
  assert.match(src, /capped: nj\?\.capped/, "翻页预算用尽要如实标「窗口可能不完整」");
  assert.match(src, /本区间快讯池里没有与该主线直接相关的题目/, "关联新闻的空位措辞跟着口径改");
  assert.doesNotMatch(src, /最新抓取快讯里没有与该主线直接相关的题目/, "旧措辞（拿抓取日冒充当日）不许回来");
  assert.doesNotMatch(src, /这是抓取当天的新闻/);
});

// ─── 7. 骨架兜底：模型跳过整节标题时补零件，不替它写内容 ───────────────────

const BROKEN_REPORT = [
  "## 📊 市场情绪与风格判断",
  "- **市场阶段**：退潮反抽（依据本地量化引擎判读）",
  "",
  "---",
  "",
  "### 1. 人工智能（🔥 热度：极高）",
  "- **逻辑推演**：热度92，三日资金净流入130.30亿元。",
  "",
  "- **① AI大模型**",
  "  - **逻辑**：概念热度90，三日资金流入62.26亿元。",
  "",
  "## ⚠️ 风险警示",
  "- **政策不确定**：监管收紧可能让资金流出。",
  "",
  "当前市场处于**退潮**阶段，建议以防御性仓位为主，整体仓位控制在三成左右。",
].join("\n");

test("mendReportSkeleton：补回 12:05 那轮缺的三节标题 + 结尾免责声明（内容与顺序各归其位）", () => {
  const { text, inserted } = mendReportSkeleton(BROKEN_REPORT);
  assert.deepEqual(inserted, ["策略总结", "潜伏机会与预期差", "核心主线与热点板块", "免责声明"]);
  const heads = text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.replace(/^## /, ""));
  assert.deepEqual(heads, [
    "📊 市场情绪与风格判断", "🚀 核心主线与热点板块", "🧩 潜伏机会与预期差", "⚠️ 风险警示", "🧭 策略总结",
  ], "五节标题必须按 prompt 规定的顺序出现");
  assert.ok(text.indexOf("🚀 核心主线") < text.indexOf("### 1. 人工智能"), "主线标题要在第一条 ### 之前");
  assert.ok(text.indexOf("🧩 潜伏机会") < text.indexOf("- **① AI大模型**"), "潜伏标题要在第一个机会点之前");
  assert.ok(text.indexOf("🧭 策略总结") < text.lastIndexOf("当前市场处于**退潮**阶段"), "策略标题在收束段之前");
  assert.ok(text.trimEnd().endsWith(REPORT_DISCLAIMER_LINE), "落款逐字追加在末尾");
});

test("mendReportSkeleton：只搬标题不写内容 —— 原有正文一个字不许改", () => {
  const { text } = mendReportSkeleton(BROKEN_REPORT);
  for (const line of BROKEN_REPORT.split("\n")) {
    if (line.trim()) assert.ok(text.includes(line), `正文行被动过：${line}`);
  }
  const headsOf = (s: string) => s.split("\n").filter((l) => l.startsWith("## ")).length;
  assert.equal(headsOf(text), 5, "只补标题，不补判断句");
});

test("mendReportSkeleton：齐整的研报再过一次不产生任何改动（可重复调用）", () => {
  const once = mendReportSkeleton(BROKEN_REPORT).text;
  const twice = mendReportSkeleton(once);
  assert.deepEqual(twice.inserted, [], "第二次不该再补东西");
  assert.equal(twice.text, once, "幂等");
});

test("mendReportSkeleton：某一节整节都没有内容时宁可不加标题（不造空壳小节）", () => {
  const only = ["## 📊 市场情绪与风格判断", "- **市场阶段**：退潮反抽", "", "- **综合判断**：整体偏冷"].join("\n");
  const { text, inserted } = mendReportSkeleton(only);
  assert.deepEqual(inserted, ["免责声明"], "没有 ### 主线、没有 ① 机会点、没有风险子弹 → 只补落款");
  assert.doesNotMatch(text, /核心主线与热点板块|潜伏机会|风险警示|策略总结/);
});

test("mendReportSkeleton：补标题时顺带补节间分隔线，原来就有的那条不许重复补", () => {
  const lines = mendReportSkeleton(BROKEN_REPORT).text.split("\n");
  const nearestNonBlankBefore = (head: string) => {
    const i = lines.findIndex((l) => l.startsWith(head));
    assert.ok(i > 0, `找不到标题 ${head}`);
    for (let p = i - 1; p >= 0; p--) if (lines[p].trim()) return lines[p].trim();
    return "";
  };
  assert.equal(nearestNonBlankBefore("## 🚀"), "---", "🚀 复用正文里本来就有的那条分隔线");
  assert.equal(nearestNonBlankBefore("## 🧩"), "---", "🧩 上一节正文后面没有分隔线 → 补一条");
  assert.equal(nearestNonBlankBefore("## 🧭"), "---", "🧭 同上");
  const rules = lines.filter((l) => l.trim() === "---");
  assert.equal(rules.length, 4, "原 1 条 + 补 3 条（🚀 不重复补）；实得：" + rules.length);
  const doubled = lines.filter((l, i) => l.trim() === "---" && lines.slice(i + 1).find((x) => x.trim()) === "---");
  assert.equal(doubled.length, 0, "不许出现两条连着的分隔线");
});

test("mendReportSkeleton：脏输入（空串 / 只有空白）原样返回，不追加落款", () => {
  assert.deepEqual(mendReportSkeleton(""), { text: "", inserted: [] });
  assert.deepEqual(mendReportSkeleton("   \n  "), { text: "   \n  ", inserted: [] });
  assert.deepEqual(mendReportSkeleton(null as never), { text: "", inserted: [] });
});

test("mendReportSkeleton + mendBoldSeams 叠加后正文形状仍然合格", () => {
  const messy = ["## 📊 市场情绪与风格判断", "- **市场阶段**：退潮反抽 ****风格研判**", "### 1. 半导体"].join("\n");
  const mended = mendBoldSeams(mendReportSkeleton(messy).text);
  assert.doesNotMatch(mended, /\*{4,}/, "断口星号被补掉了");
  for (const l of mended.split("\n")) {
    assert.equal((l.match(/\*\*/g) ?? []).length % 2, 0, `加粗标记必须成对：${l}`);
  }
  assert.match(mended, /核心主线与热点板块/);
});

test("组件接线：拦门之后、入库之前才补骨架；流式草稿不补（半截正文会闪空壳小节）", () => {
  const src = page();
  const at = src.indexOf("screenReportShape(String(content))");
  assert.ok(at > 0);
  const tail = src.slice(at, at + 1400);
  assert.ok(tail.includes("mendReportSkeleton(String(content))"), "拦门通过后立即补骨架");
  assert.ok(tail.indexOf("mendReportSkeleton(String(content))") < tail.indexOf("mendBoldSeams(skeleton.text)"), "先补结构再补星号");
  // 断言放宽到「入库正文以骨架文本为源」：正文外后来又包了一层 mendTypos（P63 落地后加的
  // 文字口误修补），字面量跟着改会让这条钉每次包一层就断一次；关键是 skeleton.text 仍是源头。
  assert.ok(tail.includes("mendBoldSeams(skeleton.text)") && /const text = .*skeleton\.text/.test(tail), "入库的正文取修补后的骨架文本");
  assert.ok(src.includes("setDraft(mendBoldSeams(full))"), "流式草稿只做星号修补");
  assert.doesNotMatch(src, /setDraft\(mendReportSkeleton/, "草稿路径不许调骨架兜底");
});

test("数据段标题自带「没给的读数一律不许出现」，与拦门一起兜住编数", () => {
  const src = page();
  assert.match(src, /【真实市场数据（全部来自本站真实接口；下面没给的读数一律不许出现在正文里）】/);
  assert.ok(src.includes("screenReportShape(String(content))"), "形状拦门仍在（P63）：编造之外先保证不塌缩");
});
