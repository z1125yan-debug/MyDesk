// P58 稳智「试试这样问」8 卡 —— 按前端产物原文重建后的回归测试。
//
// 这一版把 P57 那份替掉。P57 测的是「卡带 mode/horizon 写进 store」，那只是稳智条件的一半；
// 稳智真正的机制是 { label, mode, text } —— mode 决定弹哪个参数窗、窗里补的条件决定
// 最终问句长什么样。所以这里测三件事：
//   1) 八张卡的提问模板与稳智产物逐字一致（改文案必须同时改这里，防"顺手润色"改掉口径）
//   2) 条件不全 → 拼不出句子 → 校验给出具体缺项（= 不发）
//   3) 页面接线：点卡先开窗、确认才发；取消不发
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SUGGESTION_CARDS_CORE, EXTRA_SUGGESTION_CARDS, CARD_HORIZONS, CARD_ACTIONS, CARD_MAS,
  directDispatch, dialogDispatch, fieldsOf, needsDialog, parseSubjects, splitSubject,
  toCardInput, validateCard, renderCardPrompt,
} from "../../src/lib/desk/suggestion-cards-core.ts";
import { CHAT_MODES, HORIZON_NOTES } from "../../src/lib/desk/modes.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const card = (label: string) => {
  const c = SUGGESTION_CARDS_CORE.find((x) => x.label === label) ?? EXTRA_SUGGESTION_CARDS.find((x) => x.label === label);
  assert.ok(c, `找不到卡：${label}`);
  return c!;
};

describe("P58 场景卡数据", () => {
  test("首页恰好 8 张，label 与顺序对齐稳智 ai-matrix", () => {
    assert.equal(SUGGESTION_CARDS_CORE.length, 8);
    assert.deepEqual(SUGGESTION_CARDS_CORE.map((c) => c.label), [
      "七维分析一只股票", "按成本制定持仓计划", "判断现在能否买入", "对比多只股票强弱",
      "分析板块当前阶段", "判断今日仓位策略", "筛选持续流入板块", "制定股票交易计划",
    ]);
  });

  test("每张卡的 chatMode / wzMode 合法，direct 卡不弹窗", () => {
    const modeKeys = CHAT_MODES.map((m) => m.key);
    for (const c of SUGGESTION_CARDS_CORE) {
      assert.ok(modeKeys.includes(c.chatMode), `${c.label} 的 chatMode 非法：${c.chatMode}`);
      assert.ok(c.wzMode === "direct" || c.wzMode.endsWith("_input"), `${c.label} 的 wzMode 不像稳智的：${c.wzMode}`);
      assert.equal(needsDialog(c), c.wzMode !== "direct", `${c.label} 弹不弹窗跟 wzMode 对不上`);
      if (c.wzMode === "direct") assert.ok(c.dialogTitle === "" && c.fields.length === 0, "direct 卡不该带窗");
    }
  });

  test("8 张卡的 wzMode 各不相同（同模板换词的退化一眼可见）", () => {
    const modes = SUGGESTION_CARDS_CORE.map((c) => c.wzMode);
    // 6 张带窗 + 2 张 direct 共用一档 = 7 种
    assert.equal(new Set(modes).size, 7, `只有 ${new Set(modes).size} 种 mode，八张卡退化了`);
    assert.equal(modes.filter((m) => m === "direct").length, 2);
  });
});

describe("P58 提问模板逐字对齐稳智产物", () => {
  test("卡1 七维（稳智 Qi）", () => {
    assert.equal(
      directish("七维分析一只股票", { subject: "科大讯飞" }),
      "请用七维框架全面分析科大讯飞：市场环境15%、产业逻辑20%、基本面20%、资金行为20%、技术面20%、综合判断5%，并给出可执行的入局计划。每一维都要列出关键数据、证据和结论，进行多源交叉验证；本地没有的数据直接实时搜索，盘中必须加载实时行情。最后明确现在适合参与、等待还是回避，并给入场条件、仓位建议、失效条件和主要风险。",
    );
  });

  test("卡2 按成本（稳智 Zi）：仓位选填，填了才多那半句", () => {
    assert.equal(
      directish("按成本制定持仓计划", { subject: "伟创电气", cost: "23.80" }),
      "我持有伟创电气，当前成本大概23.80。请结合最新行情，先判断当前持仓状态，再给继续持有、分批减仓和重新评估的条件。不要以回本作为判断依据；仓位未知时请说明。",
    );
    assert.match(
      directish("按成本制定持仓计划", { subject: "伟创电气", cost: "23.80", position: "2成仓" }),
      /当前成本大概23\.80，当前仓位约2成仓。/,
    );
  });

  test("卡3 能否买入（稳智 Yi）：周期短语进句子", () => {
    const s = directish("判断现在能否买入", { subject: "宁德时代", horizon: "short" });
    assert.match(s, /^我考虑买入宁德时代，计划持有短线（1-3 天）。/);
    assert.match(s, /先判断现在参与还是等待，再给有依据的入场条件、失效条件和主要风险；没有合适机会就直接说明。$/);
  });

  test("卡4 多股对比（稳智 Gi）：分隔符全认、去重、最多 8 只", () => {
    assert.equal(directish("对比多只股票强弱", { subject: "贵州茅台\n600519\n宁德时代，比亚迪" }),
      "请对比贵州茅台、600519、宁德时代、比亚迪，结合最新行情、产业逻辑、基本面、资金行为和技术面做多维交叉验证，给出强弱排序、各自参与条件、失效条件和主要风险；本地缺少的数据请实时搜索，盘中加载实时行情。");
    assert.equal(parseSubjects("a，a、b;c/d").length, 4, "重复的那只 a 没去掉（稳智 Wi 用 Set 去重）");
    assert.equal(parseSubjects(Array.from({ length: 20 }, (_, i) => `s${i}`).join("、")).length, 8, "没截到 8 只");
  });

  test("卡5 板块阶段（稳智 io）与卡8 灵活策略（稳智 oo）", () => {
    assert.equal(directish("分析板块当前阶段", { subject: "机器人" }),
      "帮我看机器人板块的资金流、均线广度占比和情绪强弱，目前处于什么阶段、是否值得观察？请先给判断，再给参与条件和退潮信号，不预设低吸有效。");
    assert.equal(
      directish("制定股票交易计划", { subject: "伟创电气", action: "trade_t", horizon: "mid" }),
      "结合实时行情，分析伟创电气现在能不能做T，按中线（5-20 天（1-4 周））思路，先判断是否可行，再给有依据的触发条件、失效条件、仓位口径和风险；做T需考虑已有底仓与当日可卖数量。",
    );
  });

  test("卡6 / 卡7 是 direct：整句一字不差，且不依赖任何条件", () => {
    for (const label of ["判断今日仓位策略", "筛选持续流入板块"]) {
      const c = card(label);
      const d = directDispatch(c);
      assert.equal(d.needsDialog, false);
      assert.ok(d.prompt.length > 60, `${label} 直发句太短`);
      // 稳智这两张卡里写死了"注明数据时间"和"不凑数量"——那是输出纪律，不能丢
      if (label === "判断今日仓位策略") assert.match(d.prompt, /注明数据时间/);
      else assert.match(d.prompt, /不凑数量/);
    }
  });

  test("隐藏 7 张（稳智有、首页没排）同一引擎可拼", () => {
    assert.equal(EXTRA_SUGGESTION_CARDS.length, 7);
    assert.equal(directish("跌到一个月均价附近还能买吗", { subject: "宁德时代", ma: "MA20" }),
      "宁德时代回踩MA20附近，现在还能不能吸一口？结合盘中实时行情给我低吸策略和风险提示。");
    assert.equal(directish("跌破一个月均价怎么办", { subject: "中控技术", ma: "MA10" }),
      "如果中控技术盘中跌破MA10怎么办？请区分盘中短暂跌破与收盘确认，结合量能给出持仓纪律、减仓条件和重新评估信号。");
    assert.match(directish("超短轻仓试错", { subject: "伟创电气" }), /^我想做伟创电气的1到2天超短/);
    assert.match(directish("持仓先拿还是减", { subject: "中控技术" }), /^我现在持有中控技术，盘中该继续拿还是先减一点/);
    assert.match(directish("持仓先拿还是减", { subject: "中控技术", cost: "40.2" }), /当前成本大概40\.2/);
  });
});

describe("P58 缺条件不发（稳智 beforeClose 语义）", () => {
  test("标的为空 → 校验给具体提示，拼不出句子", () => {
    const c = card("七维分析一只股票");
    const v = toCardInput(c, { subject: "   " });
    assert.equal(validateCard(c, v), "请先输入股票名称或代码");
    assert.equal(c.build(v), "");
  });

  test("板块卡的提示语说的是板块，不是一句通用「请输入」", () => {
    const c = card("分析板块当前阶段");
    assert.equal(validateCard(c, toCardInput(c, { subject: "" })), "请先输入板块名称");
  });

  test("成本必填：只填标的不放行（稳智 Zi 要 i&&g 双全）", () => {
    const c = card("按成本制定持仓计划");
    const v = toCardInput(c, { subject: "伟创电气" });
    assert.equal(validateCard(c, v), "请先输入持仓成本价");
    // 成本选填的那张（持仓先拿还是减）同样条件要放行
    const c2 = card("持仓先拿还是减");
    assert.equal(validateCard(c2, toCardInput(c2, { subject: "中控技术" })), null);
  });

  test("多股卡一只都没填 → 提示「至少一只」；填了 8 只以上 → 放行且只取 8", () => {
    const c = card("对比多只股票强弱");
    assert.equal(validateCard(c, toCardInput(c, { subject: " , 、; " })), "请至少输入一只股票名称或代码");
    const v = toCardInput(c, { subject: Array.from({ length: 12 }, (_, i) => `股${i}`).join("、") });
    assert.equal(validateCard(c, v), null);
    assert.equal(v.subjects.length, 8);
  });

  test("默认值来自卡自己（周期默认短线、操作默认买入、回踩均线默认 MA20、跌破均线默认 MA10）", () => {
    assert.equal(card("判断现在能否买入").defaults.horizon, "short");
    assert.equal(card("制定股票交易计划").defaults.action, "buy");
    assert.equal(card("跌到一个月均价附近还能买吗").defaults.ma, "MA20");
    assert.equal(card("跌破一个月均价怎么办").defaults.ma, "MA10");
  });

  test("确认按钮文案由卡给：多股卡是「开始分析」，其余「生成并发送」", () => {
    assert.equal(card("对比多只股票强弱").confirmText, "开始分析");
    assert.equal(card("七维分析一只股票").confirmText, "生成并发送");
  });
});

describe("P58 输入清洗", () => {
  test("splitSubject 认「名称 / 6位代码」两种顺序，认不出代码就整串当名称", () => {
    assert.deepEqual(splitSubject("伟创电气 / 688698"), { stockName: "伟创电气", stockSymbol: "688698" });
    assert.deepEqual(splitSubject("688698 伟创电气"), { stockName: "伟创电气", stockSymbol: "688698" });
    assert.deepEqual(splitSubject("688698"), { stockName: "", stockSymbol: "688698" });
    assert.deepEqual(splitSubject("贵州茅台"), { stockName: "贵州茅台", stockSymbol: "" });
    assert.deepEqual(splitSubject(""), { stockName: "", stockSymbol: "" });
  });

  test("成本去空白（「2 3.80」→「23.80」），标的折空白（不粘连）", () => {
    const c = card("按成本制定持仓计划");
    const v = toCardInput(c, { subject: "宁德 时代", cost: "2 3.80", position: "2 成仓" });
    assert.equal(v.subject, "宁德 时代");
    assert.equal(v.cost, "23.80");
    assert.equal(v.position, "2成仓");
  });

  test("周期选项覆盖本仓全部 5 档，embed 带天数口径（问句里说清是多长）", () => {
    assert.deepEqual(CARD_HORIZONS.map((h) => h.key), Object.keys(HORIZON_NOTES));
    for (const h of CARD_HORIZONS) assert.match(h.embed, new RegExp(`^${h.label}（.+）$`));
    assert.equal(CARD_ACTIONS.length, 4);
    assert.deepEqual([...CARD_MAS], ["MA5", "MA10", "MA20"]);
  });
});

describe("P58 页面接线（两张页共用同一个 core 与同一个弹窗）", () => {
  const assistant = read("src/components/desk/pages/AssistantPage.tsx");
  const landing = read("src/components/desk/pages/AiHomePage.tsx");

  for (const [name, src] of [["对话页", assistant], ["落地页", landing]] as const) {
    // P15-R20：两张页改成按模式取卡（cardsForMode 从 core 的全池里挑），
    // 所以这里钉的是「卡数据仍来自 core」而不是「必须直接 import 那 8 张常量」——
    // 直接 import 那 8 张反而意味着换模式不换卡的旧行为回来了。
    test(`${name}：卡数据来自 core，不再本地抄一份`, () => {
      assert.match(src, /cardsForMode\(/, "没接核心取卡函数");
      assert.doesNotMatch(src, /const QUICK_CARDS/, "旧的本地卡数组还在，两份必漂");
      assert.doesNotMatch(src, /SUGGESTION_CARDS_CORE\.map/, "还在直接 map 那 8 张（不随模式换了）");
      assert.match(src, /SuggestionCardDialog/, "没接共享参数窗");
    });
    test(`${name}：确认才发、取消不发`, () => {
      assert.match(src, /onSend=\{onCardSend\}/);
      assert.match(src, /onClose=\{\(\) => set\w+\(null\)\}/, "关窗没清状态");
      assert.doesNotMatch(src, /setFilling\(null\);\s*submit/, "关窗顺手就发了 = 取消语义丢了");
    });
  }

  test("对话页：条件写回 store 在发送之前（chip 要跟着变）", () => {
    const fn = assistant.match(/const onCardSend = [\s\S]*?\n  \};/)?.[0] ?? "";
    assert.ok(fn, "onCardSend 丢了");
    assert.ok(fn.indexOf("setAssistantMode") < fn.indexOf("submit("), "条件没写在发送之前");
    assert.match(fn, /if \(horizon\)/, "没判空就覆盖用户当前周期（未选被冒充成选了）");
  });

  test("core 里 fieldsOf 顺序 = 稳智 message() 顺序（标的永远打头）", () => {
    for (const c of [...SUGGESTION_CARDS_CORE, ...EXTRA_SUGGESTION_CARDS]) {
      if (!needsDialog(c)) continue;
      assert.equal(fieldsOf(c)[0].key, "subject", `${c.label} 的第一栏不是标的`);
    }
  });

  test("renderCardPrompt（无窗退化路径）：拼得出的卡才给句子", () => {
    assert.match(renderCardPrompt(card("七维分析一只股票"), "688256.SH"), /请用七维框架全面分析688256\.SH/);
    assert.equal(renderCardPrompt(card("七维分析一只股票"), ""), "");
    assert.match(renderCardPrompt(card("判断今日仓位策略"), ""), /注明数据时间/);
  });
});

/** 走「填表 → 校验 → 拼装」这条真实链路拿句子，不直接调 build（直接调会绕过 defaults 与校验） */
function directish(label: string, form: Record<string, string>): string {
  const c = card(label);
  const v = toCardInput(c, { ...form });
  const err = validateCard(c, v);
  assert.equal(err, null, `${label} 条件给全了还被拦：${err}`);
  return dialogDispatch(c, v).prompt;
}
