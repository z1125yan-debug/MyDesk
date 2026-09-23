// P8 子轮 C⑤ Debug 步骤时间线回归测试（debug-core 纯层 + 流契约扩展 + 接线钉）。
//
// 每条断言都对应用户口径里一句会被问到的话：
//  - 「不产生新事实」：没有徽章就写「本轮未做场景判定」、没有留底整节写「未留底」，测试直钉这两句原文；
//  - 「五类帧零改动、只加可选键」：STREAM_EVENT_TYPES 仍 5 项 + args/summary/debug 只按形状宽松收；
//  - 「面板默认关、线上字节与 A/B 一致」：debug 键只认 body.debug === true，请求体不带时帧不带富化；
//  - 「P7-⑫ 的 16 处锚点不丢」：时间线标题与 foot 长文案逐字不动，用源码文本钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEBUG_ARG_MAX_CHARS, TRANSPORT_TEXT, buildDebugView, debugArgsOf, debugFramesFromSteps,
  stepRoundOf, stepStatusText,
} from "../../src/lib/desk/debug-core.ts";
import { STREAM_EVENT_TYPES, asStreamEvent, encodeStreamEvent } from "../../src/lib/desk/chat-stream-core.ts";

/** 源码文本断言统一走相对本文件的 URL：不依赖 node --test 的启动目录 */
const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

// ---------- 流契约：五类不变 + 可选键 ----------

test("五类帧白名单一字未扩；seq 只在顶层出现，data 形状不掺 seq（网关/旧客户端按 type 分发零感知）", () => {
  assert.deepEqual([...STREAM_EVENT_TYPES], ["step", "delta", "warning", "done", "error"]);
  const ev = { type: "delta", data: { content: "x" } } as const;
  const bare = JSON.parse(encodeStreamEvent(ev).replace(/^data: /, "").trim());
  assert.deepEqual(Object.keys(bare).sort(), ["data", "type"], "不传 seq 时帧与改造前逐字节同形");
  const withSeq = JSON.parse(encodeStreamEvent(ev, 7).replace(/^data: /, "").trim());
  assert.deepEqual(Object.keys(withSeq).sort(), ["data", "seq", "type"]);
  assert.equal(withSeq.seq, 7);
  assert.deepEqual(withSeq.data, { content: "x" });
});

test("step 帧的 args/summary 是纯可选键：坏形状只丢这两个键，不连坐整帧（五类白名单没扩，A/B 钉帧断言不破）", () => {
  const good = asStreamEvent({ type: "step", data: { step: 1, label: "取快照", status: "ok", ms: 5, args: { symbol: "600519.SH" }, summary: "{\"price\":1}" } });
  const gd = good && good.type === "step" ? good.data : null;
  assert.deepEqual(gd?.args, { symbol: "600519.SH" });
  assert.equal(gd?.summary, '{"price":1}');
  const bad = asStreamEvent({ type: "step", data: { step: 2, label: "x", status: "ok", args: ["坏"], summary: 42 } });
  const bd = bad && bad.type === "step" ? bad.data : null;
  assert.equal(!!bd && "args" in bd, false, "数组不是入参对象");
  assert.equal(!!bd && "summary" in bd, false, "数字不是摘要串");
  assert.equal(bd?.step, 2, "帧本体照旧可用");
});

test("done.debug 只收认识的键值：transport 三档之外不猜第四种，全坏时整个 debug 键不留", () => {
  const ok = asStreamEvent({ type: "done", data: { fullText: "答", debug: { modelMs: 1200, transport: "stream" } } });
  const okD = ok && ok.type === "done" ? ok.data : null;
  assert.deepEqual(okD?.debug, { modelMs: 1200, transport: "stream" });
  const partial = asStreamEvent({ type: "done", data: { fullText: "", debug: { modelMs: 3, transport: "ftp" } } });
  assert.deepEqual(partial && partial.type === "done" ? partial.data.debug : null, { modelMs: 3 }, "认不出的 transport 丢掉，认识的耗时留下");
  const empty = asStreamEvent({ type: "done", data: { fullText: "", debug: { transport: "?" } } });
  const emptyD = empty && empty.type === "done" ? empty.data : null;
  assert.equal(!!emptyD && "debug" in emptyD, false, "一个键都不认识时不留空对象占位");
});

test("顶层 seq 宽松解码：number 才收（截断取整），坏值只当这帧没序号、帧照旧能展示", () => {
  assert.equal(asStreamEvent({ type: "delta", data: { content: "a" }, seq: 3 })?.seq, 3);
  assert.equal(asStreamEvent({ type: "delta", data: { content: "a" }, seq: 3.7 })?.seq, 3);
  for (const bad of ["3", null, NaN, {}, undefined]) {
    const ev = asStreamEvent({ type: "delta", data: { content: "a" }, seq: bad });
    assert.ok(ev, "坏 seq 不连坐整帧");
    assert.equal("seq" in ev!, false);
  }
});

// ---------- debug-core：小工具 ----------

test("入参展示上限 80 字：字符串超长截断带省略号；嵌套对象按序列化长度判", () => {
  assert.equal(DEBUG_ARG_MAX_CHARS, 80);
  const clipped = debugArgsOf({ q: "字".repeat(100) })!;
  assert.equal((clipped.q as string).length, 80, "截到 79 字 + 1 个省略号，长度恰为上限");
  assert.match(String(clipped.q), /…$/);
  const obj = debugArgsOf({ list: Array.from({ length: 60 }, (_, i) => i * 10) })!;
  assert.equal(typeof obj.list, "string", "超长的对象值被截成串");
  assert.match(String(obj.list), /…$/, "序列化后超长的对象值整体截断");
  assert.equal(String(obj.list).length, 80);
  const small = debugArgsOf({ n: 5, s: "短" })!;
  assert.deepEqual(small, { n: 5, s: "短" }, "没超长的值原样");
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.equal(debugArgsOf(circular)!.self, "（无法序列化的入参值）", "循环引用如实说出来，不是显示 undefined");
  assert.equal(debugArgsOf(null), undefined);
  assert.equal(debugArgsOf(["数组不是入参对象"]), undefined);
});

test("轮次识别只认 B 轮 ④ 的 reason 原文前缀，认不出按首轮——不猜", () => {
  assert.equal(stepRoundOf("补充调用（第 2 轮）：对账发现缺 stock_fund_flow，追加取数"), 2);
  assert.equal(stepRoundOf("补充调用（第 3 轮）：仍缺"), 3);
  assert.equal(stepRoundOf("模型判断需要该数据，自行调用"), 1);
  assert.equal(stepRoundOf("补充调用（第 x 轮）：坏写法"), 1, "认不出的数字不硬解析");
  assert.equal(stepRoundOf(null), 1);
});

test("五态文案单一出处：stepStatusText 就是原 STATUS_META.text 的五句原话，未知态兜底「已取到」与解码/渲染两处同一句", () => {
  assert.equal(stepStatusText("running"), "进行中");
  assert.equal(stepStatusText("ok"), "已取到");
  assert.equal(stepStatusText("missing"), "缺数据");
  assert.equal(stepStatusText("error"), "调用失败");
  assert.equal(stepStatusText("stale"), "数据滞后");
  assert.equal(stepStatusText("第六态"), "已取到", "未知态兜底口径与 asStreamEvent 解码兜底同一条");
  assert.equal(stepStatusText(undefined), "已取到");
});

test("富化配对按「工具名 + 出现次序」FIFO：校验步骤没有 trace 项不硬配、同工具两轮各配各的", () => {
  const steps = [
    { step: 1, label: "预取快照", status: "ok", tool: "stock_snapshot", source: "prefetch" as const },
    { step: 2, label: "模型补取快照", status: "ok", tool: "stock_snapshot", source: "model" as const },
    { step: 3, label: "完整性校验", status: "ok" },
    { step: 4, label: "未知来源", status: "ok", tool: "not_in_trace" },
  ];
  const trace = [
    { name: "stock_snapshot", args: { symbol: "A" }, ms: 10, status: "ok", summary: "s1" },
    { name: "stock_snapshot", args: { symbol: "B" }, ms: 20, status: "ok", summary: "s2" },
  ];
  const out = debugFramesFromSteps(steps, trace);
  assert.deepEqual(out[0].args, { symbol: "A" });
  assert.equal(out[0].summary, "s1");
  assert.deepEqual(out[1].args, { symbol: "B" }, "同工具两次调用按次序配对，不串轮");
  assert.equal(out[2].args, undefined, "校验步骤没有 trace 项：宁缺勿猜");
  assert.equal(out[3].args, undefined);
  assert.equal(debugFramesFromSteps(steps, undefined)[0].args, undefined, "没带 trace 原样返回");
});

// ---------- buildDebugView：三段视图「不产生新事实」 ----------

test("意图小节：徽章字段拼一行话；没徽章/没注入各自如实说，绝不拼半成品", () => {
  const v = buildDebugView({
    intent: { scene: "analysis", label: "个股分析", hits: ["分析", "结构"], symbol: "600519.SH", symbolSource: "提问内代码", inherited: false, followUp: false, skipped: [], prefetchChars: 321 },
    steps: [], done: null,
  });
  assert.equal(v.intentSection.present, true);
  assert.equal(v.intentSection.summary, "判定为「个股分析」（命中词：分析、结构） · 股票 600519.SH（来源：提问内代码） · 随附背景数据 321 字");
  assert.equal(buildDebugView({ steps: [] }).intentSection.summary, "本轮未做场景判定");
  const noData = buildDebugView({ intent: { scene: "quote", label: "行情", hits: [], symbol: null, symbolSource: "", inherited: false, followUp: false, skipped: [] }, steps: [] });
  assert.match(noData.intentSection.summary, /股票 无/);
  assert.match(noData.intentSection.summary, /本轮没有随附数据/);
  const inherit = buildDebugView({ intent: { scene: "quote", label: "行情", hits: [], symbol: null, symbolSource: "", inherited: true, followUp: true, skipped: [] }, steps: [] });
  assert.match(inherit.intentSection.summary, /沿用上一轮场景/);
});

test("计数七个维度各归各账：running 单列不收口、补充轮按 reason 前缀计，失败行不折叠进任何计数", () => {
  const v = buildDebugView({ steps: [
    { step: 1, label: "a", status: "ok" },
    { step: 2, label: "b", status: "error" },
    { step: 3, label: "c", status: "missing" },
    { step: 4, label: "d", status: "stale" },
    { step: 5, label: "e", status: "running" },
    { step: 6, label: "f", status: "ok", reason: "补充调用（第 2 轮）：对账后补取" },
  ] });
  assert.deepEqual(v.counts, { total: 6, ok: 2, error: 1, missing: 1, stale: 1, running: 1, supplemented: 1 });
  assert.equal(v.stepsSection[5].round, 2);
  assert.equal(v.stepsSection[1].statusText, "调用失败");
});

test("结论小节：有什么留底说什么话；一个都没有整节「未留底」，transport 认不出时原样带出不猜翻译", () => {
  const none = buildDebugView({ steps: [] });
  assert.equal(none.conclusionSection.noted, false);
  const v = buildDebugView({ steps: [], done: { modelMs: 4200, transport: "stream" } });
  assert.equal(v.conclusionSection.noted, true);
  assert.equal(v.conclusionSection.transportText, TRANSPORT_TEXT.stream);
  assert.equal(v.conclusionSection.modelMs, 4200);
  const weird = buildDebugView({ steps: [], done: { transport: "carrier-pigeon" } });
  assert.equal(weird.conclusionSection.transportText, "carrier-pigeon", "认不出的档位原样展示：翻译表不吞事实");
});

// ---------- 接线钉（路由/store/组件），全部走源码文本 ----------

test("debug 只认布尔 true（与网关 enable_kairo_engine 同一严格度）：false/缺省连一个富化帧都不发", () => {
  for (const rel of ["src/app/api/ai/proxy/route.ts", "src/app/api/ai/chat/route.ts"]) {
    const src = readSrc(rel);
    assert.match(src, /const debugOn = body\?\.debug === true;/, `${rel}：只认布尔 true`);
    assert.match(src, /if \(!debugOn[^\n]*\) return;/, `${rel}：开关关着富化直接不执行`);
    assert.match(src, /debug: \{ modelMs: Date\.now\(\)[^\n]*transport: "stream"/, `${rel}：done 留底只在开关开着时出现`);
  }
});

test("P7-⑫ 锚点不丢：时间线标题与 foot 长文案逐字未动；状态文案改由单一出处供给；调试三段只在 debugOn 下组装", () => {
  const tl = readSrc("src/components/desk/StepTimeline.tsx");
  // P15 口径迁移：标题从「工作过程 · N 步」改为稳智式收口措辞（跑完=「AI 已完成分析 · 共 N 步」，
  // 流中=「正在分析 · 已走完 N 步」）。钉的是「标题必须带步数、不许含糊」这个不变量，不是旧文案本身。
  assert.match(tl, /AI 已完成分析 · 共 \$\{steps\?\.length \?\? 0\} 步/, "收口标题原文");
  assert.match(tl, /正在分析 · 已走完 \$\{steps\?\.length \?\? 0\} 步/, "进行时标题原文");
  assert.match(tl, /以上是本次真实调用过的步骤；标「缺数据」表示接口这次没给值，不是数值为 0/, "foot 长文案原文在位");
  assert.match(tl, /const STATUS_META: Record<StepInfo\["status"\], \{ icon: typeof Loader2; tone: string \}>/, "STATUS_META 只留图标与色");
  assert.equal(/text: "/.test(tl.split("const STATUS_META")[1].split("};")[0]), false, "组件内不再自带状态文案（否则就是第二个出处）");
  assert.match(tl, /stepStatusText\(s\.status\)/);
  assert.match(tl, /const view = debugOn \? buildDebugView\(/, "开关关着连视图都不组装");
});

test("store 开关默认关、只存本机；请求体带不带 debug 键由这一个开关决定（关着时与 A/B 逐字节一致）", () => {
  const store = readSrc("src/lib/desk/store.ts");
  assert.match(store, /debugPanel: false/);
  assert.match(store, /setDebugPanel: \(v\) => set\(\{ debugPanel: v === true \}\)/);
  assert.match(store, /debugPanel: s\.debugPanel === true/, "落盘前收敛成布尔：存档被手改也不影响默认关");
  const uc = readSrc("src/lib/desk/use-chat.ts");
  assert.match(uc, /\.\.\.\(debugPanel \? \{ debug: true \} : \{\}\)/, "关着时一个 debug 键都不带");
  // done 回放分支（fullText 与已攒内容相同时不进 applyEvent）必须自己把 done.debug 捡起来：
  // 浏览器走查实测「富化帧到了、结论行却报未留底」就是这么发现的——这条钉住修复，防回退。
  assert.match(uc, /if \(ev\.data\?\.debug\) \{\s*\n\s*cur = \{ \.\.\.cur, debug: ev\.data\.debug \};/, "回放分支不丢结论留底");
  // 刷盘白名单必须点名 debug：onEvent 攒进 cur 后，patch 名单漏一格，界面上就永远「未留底」（同一实测的第二处）
  assert.match(uc, /patchChatMessage\(sessionId, draftId, \{[^}]*debug: cur\.debug[^}]*\}\)/, "flush 白名单带 debug");
  const page = readSrc("src/components/desk/pages/AssistantPage.tsx");
  assert.equal((page.match(/setDebugPanel/g) ?? []).length >= 2, true, "顶栏一处开关（读 + 写同一状态）");
  assert.match(page, /debugOn=\{debugPanel\}/);
});
