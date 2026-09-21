// P7-⑥② 场景意图识别的回归测试（纯内存：不 fetch、不碰库、不调模型）。
//
// 这层要挡住的不是「功能没做」，而是三类会悄悄伤到用户的漂移：
//  1) 判错场景 = 注入错的提示词 + 预取错的数据。所以每个场景都要有用例钉住，且判不出来必须是 general，
//     不允许「像一个场景就往里塞」；
//  2) 自动调度不能替用户决定选股条件，也不能把「客户端快照已有」的数再取一遍（慢且会出现两个数）；
//  3) 提示词里那些「缺数据要如实说」的句子是 REAL_DATA_ONLY 的唯一防线，被改没了测试就得红。
//
// 用例里的代码（688256 / 600519 等）只是真实存在的代码形状，问题文本全是手写的自然语言，
// 不是任何真实提问，也不涉及任何行情数值。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DISPATCH_ANALYSIS_MAX, DISPATCH_MAX_SYMBOLS, SCENES, SCENE_LABELS,
  asScene, classifyIntent, extractSymbols, planDispatch, renderDispatchBlock, sceneHits, scenePrompt,
  symbolSourceText, toolsForScene, wantsNews,
  type Intent, type Scene,
} from "../../src/lib/desk/intent-core.ts";

function intent(scene: Scene, over: Partial<Intent> = {}): Intent {
  return {
    scene, label: SCENE_LABELS[scene], hits: [], alternates: [], symbol: null, symbolSource: "none",
    inherited: false, followUp: false, symbols: [], question: "", ...over,
  };
}

// ---------- 代码识别 ----------

test("extractSymbols：补后缀、去重、只认 6 位代码形状", () => {
  assert.deepEqual(extractSymbols("看下 688256 和 688256.SH"), ["688256.SH"]);
  assert.deepEqual(extractSymbols("000001 与 600519 谁强"), ["000001.SZ", "600519.SH"]);
  assert.deepEqual(extractSymbols("830799 能买吗"), ["830799.BJ"]);
  assert.deepEqual(extractSymbols("今天大盘怎么样"), []);
  // 8 位日期不能被切成「一个代码」：20260919 的前六位不是股票代码
  assert.deepEqual(extractSymbols("20260919 的行情"), []);
  assert.deepEqual(extractSymbols("看下 300750。"), ["300750.SZ"]);
});

test("extractSymbols：92xxxx 是北交所不是沪市（号段判定必须先判 BJ）", () => {
  // 补后缀的三条号段规则里 SH 含一个单独的 9，早先 SH 先判 → 920819 被算成 920819.SH，
  // 于是「取数取不到 + 跳转跳去一只不存在的标的」。90xxxx（沪市 B 股）仍归 SH。
  assert.deepEqual(extractSymbols("920819 能买吗"), ["920819.BJ"]);
  assert.deepEqual(extractSymbols("900901 与 430139"), ["900901.SH", "430139.BJ"]);
  assert.deepEqual(extractSymbols("500001 是基金代码段"), ["500001.SH"]);
});

test("extractSymbols：不认识的名称不做反查（名称→代码是取数层的事）", () => {
  assert.deepEqual(extractSymbols("寒武纪明天怎么看"), []);
});

// ---------- 八类场景判定 ----------

const CASES: { q: string; scene: Scene }[] = [
  { q: "今天大盘情绪怎么样，风险等级高吗", scene: "sentiment" },
  { q: "哪个行业板块资金流入最多", scene: "sector" },
  { q: "帮我选出换手率大于5且市值小于100亿的股票", scene: "screener" },
  { q: "688256 现在什么价", scene: "quote" },
  { q: "我的自选今天表现如何", scene: "watchlist" },
  { q: "688256 这只票技术面怎么看，能不能买", scene: "stock_analysis" },
  { q: "用奇门遁甲帮我排一盘看看吉凶", scene: "qimen" },
  { q: "帮我把这段英文翻译成中文", scene: "general" },
];

for (const c of CASES) {
  test(`场景判定：「${c.q}」→ ${SCENE_LABELS[c.scene]}`, () => {
    const r = classifyIntent({ question: c.q, focusSymbol: "000001.SH" });
    assert.equal(r.scene, c.scene);
    assert.equal(r.label, SCENE_LABELS[c.scene]);
    // 判得出场景就必须给出命中词：徽章要能解释「为什么这么判」，不能是黑箱
    if (c.scene === "general") assert.deepEqual(r.hits, []);
    else assert.ok(r.hits.length > 0, `${c.q} 命中词为空`);
  });
}

test("判不出来就是 general：不允许凭「像行情」硬塞进某个交易场景", () => {
  const r = classifyIntent({ question: "你好，你能做什么", focusSymbol: "000001.SH" });
  assert.equal(r.scene, "general");
  assert.equal(r.symbol, null);
});

test("一句话命中多个场景：按优先级取主场景，其余记进 alternates", () => {
  const r = classifyIntent({ question: "半导体板块里有哪些股票值得关注" });
  assert.equal(r.scene, "screener");
  assert.ok(r.alternates.includes("sector"), "板块应记为并列场景");
  assert.ok(r.alternates.length <= 2, "并列场景最多两个");
});

test("sceneHits：同一句里命中多个场景时按表内顺序返回", () => {
  const hits = sceneHits("大盘情绪和板块资金一起看看");
  assert.deepEqual(hits.map((h) => h.scene), ["sector", "sentiment"]);
});

// 「自**选股**」这四个字里含着「选股」，纯子串匹配会把问自己清单的话判成全市场选股。
// 这条是生产实测（curl 打 /api/ai/proxy）抓到的第一条误判，所以把两个方向都钉住：
// 既要求「自选股」判成自选股，也要求真选股的说法不被误抢。
test("子串碰撞：「自选股」不能被「选股」抢走主场景", () => {
  const r = classifyIntent({ question: "我的自选股现在整体怎么样？" });
  assert.equal(r.scene, "watchlist");
  assert.ok(r.hits.includes("自选"), "命中词要能解释为什么判成自选股");
  // 选股口径不丢：记进并列场景，提示词点名，由模型自己决定要不要补调筛选工具
  assert.ok(r.alternates.includes("screener"), "量化选股应记为并列场景而不是消失");

  for (const q of [
    "我的自选股现在整体怎么样？",
    "自选股今天谁涨得最多",
    "看看我的自选股资金流向",
  ]) {
    assert.equal(classifyIntent({ question: q }).scene, "watchlist", `${q} 应判成自选股`);
  }
});

test("真选股的说法不被 watchlist 误抢：没有「自选」就还是量化选股", () => {
  for (const q of [
    "帮我选股，放量上涨的",
    "按市值选股：筛出换手率大于5的股票",
    "全A选股，按主力净流入排序",
  ]) {
    const r = classifyIntent({ question: q });
    assert.equal(r.scene, "screener", `${q} 应判成量化选股`);
    assert.ok(!r.hits.includes("自选"), `${q} 没提自选，命中词里不该出现自选`);
  }
});

test("调度计划跟着主场景走：问自选就预取自选总览，不预取选股", () => {
  const wl = planDispatch({ intent: classifyIntent({ question: "我的自选股现在整体怎么样？" }), watchlistCount: 2 });
  assert.deepEqual(wl.calls.map((c) => c.tool), ["watchlist_overview"]);
  assert.deepEqual(wl.skipped, [], "有自选清单时不该出现「未预取」");

  const empty = planDispatch({ intent: classifyIntent({ question: "我的自选股现在整体怎么样？" }), watchlistCount: 0 });
  assert.deepEqual(empty.calls, [], "空清单不是取数失败，不该调工具");
  assert.ok(empty.skipped.length > 0 && /空/.test(empty.skipped[0]), "空清单必须留痕");
});

// ---------- 标的来源与追问 ----------

test("标的来源必须如实标注：提问里的代码 / 会话沿用 / 分析页当前品种", () => {
  const fromQ = classifyIntent({ question: "688256 现价多少", focusSymbol: "000001.SH" });
  assert.equal(fromQ.symbol, "688256.SH");
  assert.equal(fromQ.symbolSource, "question");

  const fromSession = classifyIntent({ question: "这只股现价多少", sessionSymbol: "600519.SH", focusSymbol: "000001.SH" });
  assert.equal(fromSession.symbol, "600519.SH");
  assert.equal(fromSession.symbolSource, "session");

  const fromFocus = classifyIntent({ question: "现价多少", focusSymbol: "000001.SH" });
  assert.equal(fromFocus.symbol, "000001.SH");
  assert.equal(fromFocus.symbolSource, "focus");

  assert.match(symbolSourceText("session"), /沿用/);
});

test("大盘/板块/选股场景不需要标的：不许拿当前品种硬当一个标的", () => {
  for (const q of ["今天大盘情绪", "哪个行业最强", "帮我选股"]) {
    const r = classifyIntent({ question: q, focusSymbol: "688256.SH" });
    assert.equal(r.symbol, null, `${q} 不该带标的`);
    assert.equal(r.symbolSource, "none");
  }
});

test("追问沿用上一轮场景：「那它明天怎么看」不能被判成通用问答", () => {
  const r = classifyIntent({ question: "那它呢", prevScene: "stock_analysis", sessionSymbol: "688256.SH" });
  assert.equal(r.scene, "stock_analysis");
  assert.equal(r.inherited, true);
  assert.equal(r.followUp, true);
  assert.equal(r.symbol, "688256.SH");
  assert.equal(r.symbolSource, "session");
  assert.deepEqual(r.hits, [], "沿用不是本轮命中，hits 必须为空");
});

test("追问里换了代码：场景沿用、标的必须换成新代码", () => {
  const r = classifyIntent({ question: "那 600519 呢", prevScene: "quote", sessionSymbol: "688256.SH" });
  assert.equal(r.scene, "quote");
  assert.equal(r.inherited, true);
  assert.equal(r.symbol, "600519.SH");
  assert.equal(r.symbolSource, "question");
});

test("上一轮是 general 时无处可继承：本轮没场景词就还是 general", () => {
  const r = classifyIntent({ question: "那它呢", prevScene: "general", sessionSymbol: "688256.SH" });
  assert.equal(r.scene, "general");
  assert.equal(r.inherited, false);
});

// ---------- 场景提示词 ----------

test("每个场景的提示词都点名场景，且不夹带行情数字", () => {
  for (const scene of SCENES) {
    const text = scenePrompt(scene, { intent: intent(scene, { question: "测试提问" }), today: "2026-09-20" });
    assert.ok(text.startsWith(`【场景：${SCENE_LABELS[scene]}`), `${scene} 提示词抬头不对`);
    assert.match(text, /今日 2026-09-20/, `${scene} 应带上服务端日期`);
    // 提示词只讲口径，数字一律来自取数块：这里出现价格/百分比就是有人开始往里写事实了
    assert.doesNotMatch(text, /\d+\.\d{2}\s*元/, `${scene} 提示词里出现了价格`);
  }
});

// P7-⑨③ 之后排盘真的接进来了：这段提示词不能再写「尚未接入」（那会变成对模型撒谎），
// 但仍然保留两条硬约束：对话链路自己不起了局（别凭记忆编盘）、禁止虚构盘面要素。
test("奇门遁甲提示词：排盘已接入面板、对话侧不起局，且禁止虚构盘局", () => {
  const text = scenePrompt("qimen", { intent: intent("qimen", { question: "帮我排个奇门盘", symbol: "688256.SH", symbolSource: "question" }) });
  assert.match(text, /奇门解盘/);
  assert.match(text, /本地/);
  assert.match(text, /不得虚构/);
  assert.doesNotMatch(text, /尚未接入/, "排盘已经接入，提示词不能再宣称没做");
});

test("自选清单为空时提示词必须禁止拿别的股票冒充", () => {
  const empty = scenePrompt("watchlist", { intent: intent("watchlist", { question: "我的自选怎么样" }), watchlistCount: 0 });
  assert.match(empty, /自选清单是空的/);
  assert.match(empty, /不要拿热门股/);
  const has = scenePrompt("watchlist", { intent: intent("watchlist", { question: "我的自选怎么样" }), watchlistCount: 3 });
  assert.doesNotMatch(has, /自选清单是空的/, "有自选时不能说清单为空");
});

test("回测未接入对话链路：提到回测就必须禁止声称已回测", () => {
  const text = scenePrompt("stock_analysis", {
    intent: intent("stock_analysis", { question: "帮我回测一下刚才说的策略", symbol: "688256.SH", symbolSource: "question" }),
    backtestReady: false,
  });
  assert.match(text, /不得声称已回测/);
});

test("缺标的时提示词要求先问清，而不是自己挑一只", () => {
  const text = scenePrompt("quote", { intent: intent("quote", { question: "现价多少" }) });
  assert.match(text, /先问清是哪只/);
});

test("并列场景要在提示词里点名，让模型自己补取而不是凭印象", () => {
  const i = intent("screener", { question: "半导体板块里有哪些股票值得关注", alternates: ["sector"] });
  assert.match(scenePrompt("screener", { intent: i }), /还问到「行业板块」/);
});

// ---------- 自动调度计划 ----------

test("大盘情绪：取情绪；同时问「为什么」才顺带取快讯", () => {
  const plain = planDispatch({ intent: intent("sentiment", { question: "今天大盘情绪怎么样" }) });
  assert.deepEqual(plain.calls.map((c) => c.tool), ["market_sentiment"]);
  const withNews = planDispatch({ intent: intent("sentiment", { question: "今天大盘为什么跌" }) });
  assert.deepEqual(withNews.calls.map((c) => c.tool), ["market_sentiment", "market_news"]);
  assert.ok(wantsNews("今天大盘为什么跌") && !wantsNews("今天大盘情绪怎么样"));
});

test("板块：概念与行业分开取，参数按提问里的口径", () => {
  const ind = planDispatch({ intent: intent("sector", { question: "哪个行业资金流入最多" }) });
  assert.equal(ind.calls[0].args.kind, "industry");
  const cpt = planDispatch({ intent: intent("sector", { question: "概念板块里谁领涨" }) });
  assert.equal(cpt.calls[0].args.kind, "concept");
});

test("行情查询：逐个代码取快照，超过上限要说明只取了前几只", () => {
  const six = ["688256", "600519", "000001", "300750", "002594", "601899"].join("、");
  const r = planDispatch({ intent: intent("quote", { question: `${six} 现价多少`, symbols: extractSymbols(six) }) });
  assert.equal(r.calls.length, DISPATCH_MAX_SYMBOLS);
  assert.ok(r.skipped.some((s) => s.includes(`只取前 ${DISPATCH_MAX_SYMBOLS} 个`)), "超限必须留痕");
});

test("个股分析：快照 + 技术状态 + 资金流三件套，且深度上限内不静默截断", () => {
  const r = planDispatch({ intent: intent("stock_analysis", { question: "688256 和 600519 怎么看", symbols: ["688256.SH", "600519.SH"] }) });
  assert.deepEqual(r.calls.map((c) => c.tool), [
    "stock_snapshot", "stock_kline_summary", "stock_fund_flow",
    "stock_snapshot", "stock_kline_summary", "stock_fund_flow",
  ]);
  assert.ok(r.calls.every((c) => typeof c.reason === "string" && c.reason.length > 0), "每个预取都要说清为什么");
  const many = planDispatch({ intent: intent("stock_analysis", { question: "a", symbols: ["1.SH", "2.SH", "3.SH", "4.SH", "5.SH"] }) });
  assert.ok(many.skipped.some((s) => s.includes(`最多看 ${DISPATCH_ANALYSIS_MAX} 只`)), "超过分析上限要说明");
});

test("客户端快照已带该品种时不重复取数，并把原因留在 skipped", () => {
  const r = planDispatch({
    intent: intent("stock_analysis", { question: "688256 怎么看", symbol: "688256.SH", symbols: ["688256.SH"] }),
    snapshotSymbols: ["688256.SH"],
  });
  assert.deepEqual(r.calls.map((c) => c.tool), ["stock_kline_summary", "stock_fund_flow"], "快照已实时，只补 K 线与资金");
  assert.ok(r.skipped.some((s) => s.includes("未重复取数")));

  // 纯行情查询这一轮确实不需要再取：抵完之后没有别的工具要跑，skipped 要把「为什么没步骤」说清楚
  const q = planDispatch({
    intent: intent("quote", { question: "688256 现价", symbol: "688256.SH", symbols: ["688256.SH"] }),
    snapshotSymbols: ["688256.sh"],
  });
  assert.deepEqual(q.calls, []);
  assert.ok(q.skipped.some((s) => s.includes("未重复取数")));
});

test("自选股：清单为空不调工具（空清单不是取数失败）", () => {
  const empty = planDispatch({ intent: intent("watchlist", { question: "我的自选怎么样" }), watchlistCount: 0 });
  assert.deepEqual(empty.calls, []);
  assert.ok(empty.skipped.some((s) => s.includes("空清单不是取数失败")));
  const has = planDispatch({ intent: intent("watchlist", { question: "我的自选怎么样" }), watchlistCount: 3 });
  assert.deepEqual(has.calls.map((c) => c.tool), ["watchlist_overview"]);
});

test("选股场景现跑候选池：抽到的条件带原话，抽不到走默认池（口径迁移见注释）", () => {
  // 口径迁移（P10 择优轮，用户裁定）：本条原钉「选股场景不预取：条件由模型抽，
  // 不能把猜的条件当用户要求」（原断言：calls 为空 + skipped 含「未预取」，
  // 原话术「选股条件需由模型从提问里抽取，未预取（把猜出来的条件当成用户要求是事故）」）。
  // 新口径把「不替用户猜」拆成：抽得到的照抽（确定性正则+原话留痕）、抽不到用默认活跃池
  // 且必须标注「系统默认」——「缩量回调」这类没抽到的说法不再拦停整轮。
  const vague = planDispatch({ intent: intent("screener", { question: "帮我选出缩量回调的股票" }) });
  assert.deepEqual(vague.calls.map((c) => c.tool), ["factor_screener"]);
  assert.deepEqual(vague.calls[0].args.conditions, [], "抽不出的说法不硬凑条件（交给默认池）");
  assert.equal(vague.calls[0].args.pool_origin, "default");
  assert.ok(!vague.skipped.some((s) => s.includes("未预取")), "screener 不再整场景跳过");
  const sharp = planDispatch({ intent: intent("screener", { question: "换手率大于3%且量比超过2的股票有哪些" }) });
  assert.deepEqual(sharp.calls[0].args.pool_origin, "extracted");
  assert.deepEqual(sharp.calls[0].args.conditions, [
    { field: "volume_ratio", op: ">=", value: 2 },
    { field: "turnover_rate", op: ">=", value: 3 },
  ], "条件按纯核的产出顺序（量比在换手率前），不是提问里的字面顺序");
});

test("奇门 / 通用不取数：没有真实盘局可取，也不会画出一个失败的取数步骤", () => {
  for (const scene of ["qimen", "general"] as Scene[]) {
    const r = planDispatch({ intent: intent(scene, { question: "x", symbol: "688256.SH", symbols: ["688256.SH"] }) });
    assert.deepEqual(r.calls, [], `${scene} 不该预取`);
    assert.equal(r.skipped.length, 1);
  }
});

test("每个场景的优先工具都必须在工具层真实存在（防名字漂移）", () => {
  const src = readFileSync(new URL("../../src/lib/desk/chat-tools.ts", import.meta.url), "utf8");
  for (const scene of SCENES) {
    for (const tool of toolsForScene(scene)) {
      assert.ok(new RegExp(`name: "${tool}"`).test(src), `${scene} 指向了工具层不存在的 ${tool}`);
    }
  }
});

// ---------- 预取结果并成注入块 ----------

test("renderDispatchBlock：只并成功块，失败项交给时间线；全失败时不产出注入块", () => {
  const text = renderDispatchBlock([
    { tool: "market_sentiment", ok: true, text: "上涨 3000 家（示例文本）" },
    { tool: "market_news", ok: false, text: "缺失：接口失败" },
  ]);
  assert.match(text, /\[系统按场景自动取数\]/);
  assert.match(text, /### market_sentiment/);
  assert.doesNotMatch(text, /### market_news/);
  assert.match(text, /不是你算出来的/);
  assert.equal(renderDispatchBlock([{ tool: "x", ok: false, text: "缺失" }]), "");
  assert.equal(renderDispatchBlock([]), "");
});

// ---------- 外部传来的场景串（浏览器带的 prevScene 是不可信输入） ----------

test("asScene：只认白名单，认不了就是「上一轮没判过场景」而不是照单全收", () => {
  for (const s of SCENES) assert.equal(asScene(s), s, `${s} 是自己人`);
  for (const bad of [null, undefined, "", "General", "quote ", "'; drop table", 42, true, { scene: "quote" }, ["quote"]]) {
    assert.equal(asScene(bad), null, `${JSON.stringify(bad) ?? "undefined"} 不是合法场景`);
  }
});

test("上一轮场景经过 asScene 以后才进判定：伪造的 prevScene 不会被继承成场景", () => {
  // 「那它呢」本轮没有场景词：能不能沿用完全取决于 prevScene 合不合法
  const r = classifyIntent({ question: "那它呢", prevScene: asScene("stock_analysis\""), sessionSymbol: "688256.SH" });
  assert.equal(r.inherited, false, "认不出来的 prevScene 等于没传，不能凭空沿用一个场景");
  assert.equal(r.scene, "general");
  // 同一个问题配上合法场景才走沿用这条路
  const ok = classifyIntent({ question: "那它呢", prevScene: asScene("stock_analysis"), sessionSymbol: "688256.SH" });
  assert.equal(ok.scene, "stock_analysis");
  assert.equal(ok.inherited, true);
});

// ---------- 界面自带的快捷问 ----------
// 这些是助手页与小窗里画成按钮的问题，用户不需要打字就会点它们。
// 词表每加一次都可能有新的说法掉出场景之外，所以这里不抄一份清单，而是直接从组件源码里抽
// —— 界面临时改一句快捷问，这条测试会立刻说出「这句现在是通用问答、不取数」。

/** 从组件源码里抽出「字符串数组字面量」形式的快捷问（数组元素 ≥2 才算，单元素的多是提示文案）。
 *  P9-观感轮口径迁移：助手页空状态把快捷问改画成建议卡（`{ q: "…", icon: X }` 对象数组），
 *  纯字符串数组正则就漏了它们——而这条测试的意图恰恰是「界面临时摆到用户嘴边的每一句都得判对场景」。
 *  所以现在两种形状都抽：裸字符串数组 + 带 `q:`/`question:` 键的对象字段，一条不落地拿去判。 */
function questionArraysFrom(files: string[]): string[] {
  const re = /\[\s*((?:"[^"\n]{2,40}"\s*,?\s*)+)\]/g;
  const objRe = /\bq:\s*"([^"\n]{2,40})"/g;
  const out: string[] = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const items = (m[1].match(/"([^"\n]{2,40})"/g) ?? []).map((s) => s.slice(1, -1));
      if (items.length >= 2 && items.some((t) => /[一-龥]/.test(t))) out.push(...items);
    }
    while ((m = objRe.exec(src))) out.push(m[1]);
  }
  return [...new Set(out)];
}

const QUICK_QUESTIONS = questionArraysFrom([
  "../../src/components/desk/AssistantWidget.tsx",
  "../../src/components/desk/pages/AssistantPage.tsx",
]);

// 只有「解释一个概念」这类本来就不需要取数的问句允许落到 general。
// 加名字进来必须写清为什么，不允许为了让测试绿把新掉出去的问题塞进这里。
// 前提是新会话的第一问（下面 classifyIntent 不传 prevScene）：一旦会话里已经有了标的和场景，
// 「…该怎么理解」里的「该」会被当成追问，沿用到那只票 —— 浏览器实测（3014）就是这么走的，
// 那种情况下它取的是真实数据，不是不取数的闲聊，所以不在这里判它 general。
const ALLOW_GENERAL = new Set(["均线多头排列该怎么理解？"]);

test("快捷问清单确实从源码里抽到了（正则一失效这条就该红，而不是静悄悄全过）", () => {
  assert.ok(QUICK_QUESTIONS.length >= 7, `只抽到 ${QUICK_QUESTIONS.length} 条：${QUICK_QUESTIONS.join(" / ")}`);
  for (const q of ["关键位在哪", "现在适合进场吗", "给我一个风控清单", "多周期趋势总结"]) {
    assert.ok(QUICK_QUESTIONS.includes(q), `小窗那四条快捷问少了「${q}」`);
  }
});

test("界面上递到用户嘴边的快捷问，点一下不该退化成不取数的通用问答", () => {
  for (const q of QUICK_QUESTIONS) {
    const r = classifyIntent({ question: q, sessionSymbol: "688256.SH", focusSymbol: "600519.SH" });
    if (ALLOW_GENERAL.has(q)) { assert.equal(r.scene, "general", `${q} 是概念解释，按通用问答处理`); continue; }
    assert.notEqual(r.scene, "general", `${q} 判成了通用问答：徽章会显示「通用问答」且一步数据都不取`);
  }
});

test("快捷问没有代码时沿用本会话刚问的那只，而不是分析页当前品种", () => {
  // 「关键位在哪」这种问句里既没有代码也没有场景之外的线索，指的就是上一轮那只
  for (const q of ["关键位在哪", "现在适合进场吗", "给我一个风控清单"]) {
    const r = classifyIntent({ question: q, sessionSymbol: "688256.SH", focusSymbol: "600519.SH" });
    assert.equal(r.symbol, "688256.SH", `${q} 的标的应是会话里那只`);
    assert.equal(r.symbolSource, "session", `${q} 要如实标注「沿用本会话前面问的那只」`);
    // 判成个股分析就要真的会去取数，否则徽章上的场景是空话
    assert.equal(r.scene, "stock_analysis");
    const plan = planDispatch({ intent: r });
    assert.ok(plan.calls.length > 0, `${q} 场景判对了却没预取任何数据`);
  }
});
