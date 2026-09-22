// P11 情绪温度轮：温度纯核 + 行情类型权重 + 持仓周期（horizon）全链路 — 2026-09-22
// 背景：对齐稳智AI（aiwuchuan.com）大盘情绪页的「情绪温度」综合分与牛/熊/震荡权重切换，
// 并参考其研究指令的持仓周期参数。两份口径都只在本层的纯核里定义一次（sentiment-temperature-core / modes.ts），
// 服务端工具环、纯对话端点、MarketPage 前端各自消费同一份——权重表抄两份必漂，是本项目反复钉死的红线。
// 三条诚实纪律在这里钉死：缺读数=null 缩权不是 0 分；main_net_known=0 时资金流必缺（合计是假 0）；
// 未选周期一个字都不注入（未选 ≠ 中线）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REGIMES, TEMPERATURE_WEIGHTS, asRegime, computeTemperature, temperatureLabel, temperatureSummary,
  MOMENTUM_SAT_PCT, LIMITNET_SAT, FLOW_SAT_YI, type TemperatureInput,
} from "../../src/lib/quant/screener/sentiment-temperature-core.ts";
import { CHAT_HORIZONS, HORIZON_NOTES, asHorizon, chatHorizonLabel, type ChatHorizon } from "../../src/lib/desk/modes.ts";
import { chatRequestBody } from "../../src/lib/desk/chat-stream-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const FULL: TemperatureInput = {
  advancers: 3000, decliners: 2000, median_pct: 0.8,
  limit_up: 50, limit_down: 10, break_rate: 30,
  main_net_sum_yi: 200, main_net_known: 4000,
};
// 手工算例（分量先用一位小数，再加权——与实现同源，防止「测试按未 round 的数算」假绿）：
//   宽度 = 3000/5000×100 = 60；动量 = 50+0.8/5×50 = 58；
//   投机 = 均值(50+40/60×50=83.3, 100−30=70) = 76.7；资金流 = 50+200/500×50 = 70。

test("权重表：三档行情、四分量，每档和为 100，且与稳智逆向原文一致", () => {
  assert.deepEqual(TEMPERATURE_WEIGHTS.bull, { breadth: 35, momentum: 40, speculation: 15, flow: 10 });
  assert.deepEqual(TEMPERATURE_WEIGHTS.bear, { breadth: 25, momentum: 20, speculation: 40, flow: 15 });
  assert.deepEqual(TEMPERATURE_WEIGHTS.range, { breadth: 30, momentum: 30, speculation: 25, flow: 15 });
  for (const rg of ["bull", "bear", "range"] as const) {
    const w = TEMPERATURE_WEIGHTS[rg];
    assert.equal(w.breadth + w.momentum + w.speculation + w.flow, 100, `${rg} 权重和须为 100`);
  }
  assert.deepEqual(REGIMES.map((r) => r.key), ["range", "bull", "bear"], "界面顺序：震荡默认在前");
});

test("三档算例：同一组读数换行情类型分数即变（纯权重切换，分量得分不动）", () => {
  const scores = { breadth: 60, momentum: 58, speculation: 76.7, flow: 70 };
  for (const rg of ["range", "bull", "bear"] as const) {
    const r = computeTemperature(FULL, rg);
    assert.equal(r.missing.length, 0, "全量读数不该有缩权说明");
    for (const c of r.components) {
      assert.equal(c.score, scores[c.key as keyof typeof scores], `${rg}/${c.key} 分量得分`);
      assert.equal(c.effective_weight, TEMPERATURE_WEIGHTS[rg][c.key as "breadth"]);
    }
    const w = TEMPERATURE_WEIGHTS[rg];
    assert.equal(r.temperature, Math.round(
      (scores.breadth * w.breadth + scores.momentum * w.momentum + scores.speculation * w.speculation + scores.flow * w.flow) / 100 * 10,
    ) / 10, `${rg} 加权分`);
  }
  assert.equal(computeTemperature(FULL, "range").temperature, 65.1);
  assert.equal(computeTemperature(FULL, "bull").temperature, 62.7);
  assert.equal(computeTemperature(FULL, "bear").temperature, 67.8, "同一组偏多读数在熊市口径下投机权重大，分数反而更高——这正是权重切换的意义");
});

test("缩权归一：断源的资金流不入选，分母只用可算项，且 missing 说明可指认", () => {
  const r = computeTemperature({ ...FULL, main_net_known: 0 }, "range");
  const flow = r.components.find((c) => c.key === "flow")!;
  assert.equal(flow.score, null, "known=0 时合计是 ?? 0 累加的假 0，必须按缺读数处理");
  assert.equal(flow.effective_weight, 0);
  assert.match(flow.missing_note, /假 0|累加器/, "缺读说明要点破「0 亿不是真读数」");
  // (60×30 + 58×30 + 76.7×25) / 85 = 64.2
  assert.equal(r.temperature, 64.2);
  assert.ok(r.missing.some((m) => m.includes("缩权归一")), "missing 里要有缩权算式");
  assert.match(temperatureSummary(r), /缺读未计权，按可算项缩权/, "摘要行要如实带缩权脚注");
});

test("宽度无定义：涨 0 跌 0 判 null，不冒充中性 50", () => {
  const r = computeTemperature({ ...FULL, advancers: 0, decliners: 0 }, "range");
  const b = r.components.find((c) => c.key === "breadth")!;
  assert.equal(b.score, null);
  assert.match(b.missing_note, /0\/0 无定义|不是中性/);
});

test("投机子项：炸板率无定义（触板 0 家）时只算涨跌停净差，不拿 0% 炸板凑", () => {
  const r = computeTemperature({ ...FULL, break_rate: null }, "range");
  const sp = r.components.find((c) => c.key === "speculation")!;
  assert.equal(sp.score, 83.3, "只剩净差子项 50+40/60×50");
  assert.ok(!sp.raw.includes("炸板率"), "raw 里不许出现没读到的子项");
});

test("全缺 ⇒ 温度 null +「无读数」，绝不硬造一个数或标签", () => {
  const empty: TemperatureInput = {
    advancers: null, decliners: null, median_pct: null, limit_up: null, limit_down: null,
    break_rate: null, main_net_sum_yi: null, main_net_known: 0,
  };
  const r = computeTemperature(empty, "bull");
  assert.equal(r.temperature, null);
  assert.equal(r.label, "无读数");
  assert.ok(r.components.every((c) => c.score === null && c.effective_weight === 0));
  assert.match(temperatureSummary(r), /情绪温度：无读数/);
});

test("饱和钳位：归一化常量是导出值，越界读数钳到 0/100", () => {
  assert.equal(MOMENTUM_SAT_PCT, 5); assert.equal(LIMITNET_SAT, 60); assert.equal(FLOW_SAT_YI, 500);
  const hi = computeTemperature({ ...FULL, median_pct: 10, main_net_sum_yi: 900, main_net_known: 1 }, "range");
  assert.equal(hi.components.find((c) => c.key === "momentum")!.score, 100);
  assert.equal(hi.components.find((c) => c.key === "flow")!.score, 100);
  const lo = computeTemperature({ ...FULL, median_pct: -20, main_net_sum_yi: -900, main_net_known: 1, break_rate: 100, limit_up: 0, limit_down: 100 }, "range");
  assert.equal(lo.components.find((c) => c.key === "momentum")!.score, 0);
  assert.equal(lo.components.find((c) => c.key === "flow")!.score, 0);
  assert.equal(lo.components.find((c) => c.key === "speculation")!.score, 0, "净差 −100 钳 0、炸板 100% 得 0，均值 0");
});

test("档位线边界：25/45/60/80 落在上一档（< 语义），null 不参与", () => {
  assert.equal(temperatureLabel(24.9), "冰点"); assert.equal(temperatureLabel(25), "偏冷");
  assert.equal(temperatureLabel(44.9), "偏冷"); assert.equal(temperatureLabel(45), "中性");
  assert.equal(temperatureLabel(59.9), "中性"); assert.equal(temperatureLabel(60), "偏热");
  assert.equal(temperatureLabel(79.9), "偏热"); assert.equal(temperatureLabel(80), "过热");
});

test("asRegime 兜底：认不出的（存档被改坏/外部乱传）一律震荡，不抛错", () => {
  assert.equal(asRegime("bull"), "bull"); assert.equal(asRegime("bear"), "bear");
  assert.equal(asRegime("range"), "range");
  assert.equal(asRegime("haha"), "range"); assert.equal(asRegime(undefined), "range"); assert.equal(asRegime(42), "range");
});

/* ---------- 持仓周期（horizon）：一处定义、两路由消费、未选零注入 ---------- */

test("HORIZON_NOTES：与 CHAT_HORIZONS 同键、逐句非空以句号收口", () => {
  const keys = CHAT_HORIZONS.map((h) => h.key);
  assert.deepEqual(keys, ["short", "mid", "long"]);
  assert.deepEqual(Object.keys(HORIZON_NOTES), keys);
  for (const k of keys) {
    assert.ok(HORIZON_NOTES[k as ChatHorizon].trim(), `${k} 的周期句不能为空`);
    assert.match(HORIZON_NOTES[k as ChatHorizon], /。$/, "周期句以句号收口（会被拼进提示词）");
  }
});

test("asHorizon 白名单：认不出/未选一律 null（未选 ≠ 任何周期口径）", () => {
  assert.equal(asHorizon("short"), "short"); assert.equal(asHorizon("mid"), "mid"); assert.equal(asHorizon("long"), "long");
  assert.equal(asHorizon("day"), null); assert.equal(asHorizon(undefined), null); assert.equal(asHorizon(null), null);
  assert.equal(chatHorizonLabel("short"), "短线"); assert.equal(chatHorizonLabel(null), "未选");
});

const chatRoute = read("../../src/app/api/ai/chat/route.ts");
const proxyRoute = read("../../src/app/api/ai/proxy/route.ts");

test("工具环消费周期：systemPrompt 收 horizon 参数，null 时空串被 filter(Boolean) 吞掉", () => {
  assert.match(chatRoute, /function systemPrompt\(mode: ChatMode, horizon: ChatHorizon \| null/, "签名收口在编译期");
  assert.match(chatRoute, /horizon \? HORIZON_NOTES\[horizon\] : ""/, "没选就一个字都不注入");
  assert.match(chatRoute, /const horizon = asHorizon\(body\?\.horizon\);/, "外部输入先过白名单");
  assert.match(chatRoute, /horizon\?: string/, "ChatBody 按 string 收（外部输入不直信类型）");
});

test("纯对话端点消费周期：与风格件同门（只认带 scene 的对话轮）、同表、同白名单", () => {
  assert.match(proxyRoute, /const horizon = body\?\.scene \? asHorizon\(body\.horizon\) : null;/,
    "无 scene 的一次一问调用不吃周期——与 P8 风格件同一道门");
  assert.match(proxyRoute, /const styleNote = \[modeNote, horizon \? HORIZON_NOTES\[horizon\] : ""\]\.filter\(Boolean\)\.join\("\\n"\);/,
    "风格句+周期句拼成一份 system 件；都没选就没有这个件");
  assert.match(proxyRoute, /horizon\?: string/, "ProxyBody 声明 horizon");
});

test("请求体形状：horizon 是顶层键，不被归进 scene（两路由按顶层读）", () => {
  const plain = chatRequestBody("plain", [{ role: "user", content: "600519 怎么看" }], {
    mode: "decision", horizon: "short", focusSymbol: "600519.SH", run: "r-1",
  });
  assert.equal(plain.horizon, "short", "plain 端点 horizon 留在顶层");
  assert.deepEqual(plain.scene, { focusSymbol: "600519.SH" }, "scene 只收 SCENE_KEYS 三键");
  const tools = chatRequestBody("tools", [{ role: "user", content: "q" }], { horizon: "long" });
  assert.equal(tools.horizon, "long");
  assert.equal("scene" in tools, false, "tools 端点不写 scene");
});

test("客户端三条传输都带 horizon：流式 extras、aiChatPlain、aiChatTools 兜底同键", () => {
  const useChat = read("../../src/lib/desk/use-chat.ts");
  const aiLib = read("../../src/lib/desk/ai.ts");
  const quantApi = read("../../src/lib/desk/quant-api.ts");
  assert.match(useChat, /horizon\?: ChatHorizon \| null/, "extra() 契约声明 horizon");
  assert.match(useChat, /horizon: extras\.horizon/, "兜底与流式用同一份 extras.horizon");
  assert.match(aiLib, /\.\.\.\(opts\?\.horizon \? \{ horizon: opts\.horizon \} : \{\}\)/, "不带就当没选，不冒充默认周期");
  assert.match(quantApi, /\.\.\.\(opts\?\.horizon \? \{ horizon: opts\.horizon \} : \{\}\)/, "工具环兜底同一份条件键");
});

test("store：周期持久化走白名单（存档被改坏读出 null，不读出野值）", () => {
  const store = read("../../src/lib/desk/store.ts");
  assert.match(store, /assistantHorizon: ChatHorizon \| null;/, "字段类型收口");
  assert.match(store, /assistantHorizon: null,/, "初始未选");
  assert.match(store, /assistantHorizon: s\.assistantHorizon === "short" \|\| s\.assistantHorizon === "mid" \|\| s\.assistantHorizon === "long" \? s\.assistantHorizon : null,/,
    "partialize 逐值白名单——与 asChatMode 同纪律");
});

test("界面接线：两条对话入口都挂周期选择器、extra() 都带 horizon", () => {
  const page = read("../../src/components/desk/pages/AssistantPage.tsx");
  const widget = read("../../src/components/desk/AssistantWidget.tsx");
  assert.equal(page.split("<HorizonPicker disabled={!configured} />").length - 1, 2, "Hello 宽输入与底部 composer 各一处");
  assert.match(page, /extra: \(\) => \(\{ focusSymbol, mode: useDesk\.getState\(\)\.assistantMode, horizon: useDesk\.getState\(\)\.assistantHorizon \}\)/);
  assert.match(widget, /extra: \(\) => \(\{ focusSymbol, mode: useDesk\.getState\(\)\.assistantMode, horizon: useDesk\.getState\(\)\.assistantHorizon \}\)/,
    "小窗与整页同口径，不各写一份");
  const picker = read("../../src/components/desk/ui/HorizonPicker.tsx");
  assert.match(picker, /CHAT_HORIZONS/, "选项来自共享表，不本地抄一份");
  assert.match(picker, /setHorizon\(active \? null : h\.key\)/, "再点一次清回未选（未选是合法状态）");
});

/* ---------- MarketPage / 工具环 / 场景话术的温度消费方 ---------- */

test("MarketPage：温度吃纯核、切行情不重取数、无读数不画假表针", () => {
  const mk = read("../../src/components/desk/pages/MarketPage.tsx");
  assert.match(mk, /import \{ computeTemperature, REGIMES, type MarketRegime \} from "@\/lib\/quant\/screener\/sentiment-temperature-core"/,
    "页面消费同一份纯核");
  assert.ok(!/TEMPERATURE_WEIGHTS\s*=\s*\{/.test(mk), "页面不得本地抄权重表");
  assert.match(mk, /useState<MarketRegime>\("range"\)/, "行情类型是纯前端态：切换只换权重、零重取数");
  assert.match(mk, /main_net_known: sent\.main_net_known/, "资金流缺读判据要一路带到纯核");
  assert.match(mk, /<TempGauge value=\{temp\.temperature\} label=\{temp\.label\} \/>/);
  assert.match(mk, /function TempGauge\(\{ value, label \}: \{ value: number \| null/, "gauge 签名收 null：无读数画「—」不画表针");
  assert.match(mk, /无读数/);
});

test("工具环：market_sentiment 返回温度行 + 分量明细，缺读分量标「未计入」不是 0 分", () => {
  const tools = read("../../src/lib/desk/chat-tools.ts");
  assert.match(tools, /情绪温度: temperatureSummary\(temp\)/, "温度行与页面同一份摘要函数");
  assert.match(tools, /温度分量/, "分量明细随数据块下发，模型转述口径才可追问");
  assert.match(tools, /未计入（\$\{c\.missing_note\}）/, "缺读分量的权重位说明「为什么没算」");
  assert.match(tools, /desc: "大盘情绪：情绪温度\(0-100\)/, "工具清单描述同步——模型得知道这个工具有温度");
  assert.match(tools, /温度未计入原因: temp\.missing/, "全缺时数据块改说「为什么没温度」，不给模型留假数");
});

test("场景话术：允许引用温度开场但必须带分量口径，缩权/缺读照实转述", () => {
  const intent = read("../../src/lib/desk/intent-core.ts");
  assert.match(intent, /数据块里有「情绪温度」时可以引用它开场/, "说人话入口打开");
  assert.match(intent, /宽度\/动量\/投机\/资金流按当前行情类型的加权分/, "引用时必须交代它是什么");
  assert.match(intent, /不许把它当成精确事实/, "综合分不是测量值——诚实纪律");
});
