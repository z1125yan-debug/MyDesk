// P15-R15 显示层「人话核」钉测：把工程记号（英文状态枚举、打分表版本号、引擎文件名、
// 上游接口名）在渲染那一刻换成中文读法，且**只换读法**。
//
// 红线（对齐 plain-core.ts 头注）：
//  1. 数据与判定层继续说英文枚举——本层不许改数值、不许改判定、不许吞状态；
//  2. 认不出的记号原样透传，绝不猜、绝不编一个好看的中文（宁可露旧记号，不翻出错名字）；
//  3. 两表中英文读法表键集必须一致，徽章位与行内位不许各自漏项；
//  4. 零依赖纯核：无 import，node --test 可直跑；
//  5. 收口在显示层：消费方渲染走读法，颜色/判定这类血缘正则仍看原始串。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STATUS_ZH, STATUS_SHORT_ZH, statusZh, statusShortZh, verZh, verTail,
  plainify, promptVerZh, mcpStatusZh,
} from "../../src/lib/desk/plain-core.ts";

const SELF = readFileSync(new URL("../../src/lib/desk/plain-core.ts", import.meta.url), "utf8");
const BADGE = readFileSync(new URL("../../src/components/desk/SourceBadge.tsx", import.meta.url), "utf8");
const RESEARCH = readFileSync(new URL("../../src/lib/quant/screener/research.ts", import.meta.url), "utf8");

test("两表键集完全一致：徽章位与行内位不许各自漏项", () => {
  const a = Object.keys(STATUS_ZH).sort();
  const b = Object.keys(STATUS_SHORT_ZH).sort();
  assert.deepEqual(a, b, "STATUS_ZH 与 STATUS_SHORT_ZH 的枚举键必须一模一样");
  assert.ok(a.includes("LIVE") && a.includes("DEGRADED") && a.includes("DERIVED_ON_DEMO"));
});

test("statusZh：光杆英文枚举翻成人话，颜色口径字面量不再露出", () => {
  assert.equal(statusZh("LIVE"), "实时");
  assert.equal(statusZh("DEGRADED"), "已降级");
  assert.equal(statusZh("MISSING"), "未取到");
  assert.equal(statusZh("AI_NOT_CONFIGURED"), "模型未配置");
  assert.equal(statusZh("DERIVED_ON_DEMO"), "演示数据派生");
});

test("statusZh：「英文头 + 中文尾」只留中文尾（尾本来就说明白了）", () => {
  assert.equal(statusZh("REAL 已取到"), "已取到");
  assert.equal(statusZh("DEMO 演示数据"), "演示数据");
});

test("statusZh：认不出的原样透传，不猜也不编中文", () => {
  assert.equal(statusZh("FOO_BAR"), "FOO_BAR", "表里没有的枚举不许翻成任意中文");
  assert.equal(statusZh("已取到"), "已取到", "中文开头原样");
  assert.equal(statusZh("degraded"), "degraded", "小写不是枚举形态");
  assert.equal(statusZh("p7.decision.v3"), "p7.decision.v3", "版本号不归本函数管");
});

test("statusZh：空值给空串，不给 undefined 也不给假读法", () => {
  assert.equal(statusZh(null), "");
  assert.equal(statusZh(undefined), "");
  assert.equal(statusZh("   "), "");
});

test("statusShortZh：长词优先，DERIVED_ON_DEMO 不被拆成「派生_ON_DEMO」", () => {
  assert.equal(statusShortZh("DERIVED_ON_DEMO"), "演示派生");
  assert.equal(statusShortZh("HISTORICAL_EVIDENCE"), "历史证据");
  assert.equal(statusShortZh("状态 DERIVED 已算"), "状态 派生 已算");
});

test("statusShortZh：只换整词，不伤单词内部", () => {
  assert.equal(statusShortZh("PARTIALIZED"), "PARTIALIZED", "PARTIAL 在词内部，不许动");
  assert.equal(statusShortZh("MISSING:1"), "缺读数:1", "带标点的整词照样换");
  assert.equal(statusShortZh(""), "", "空串原样");
});

test("verZh：五类版本串都有人话读法", () => {
  assert.equal(verZh("p7.s7.technical.v1"), "技术面打分表 第1版");
  assert.equal(verZh("p7.s3.probability.v2"), "旧概率面打分表 第2版");
  assert.equal(verZh("p7.taskbook.s6"), "任务书§6 打分表");
  assert.equal(verZh("p7.decision.v3"), "四维决策口径 第3版");
  assert.equal(verZh("p7.s7.wiring.v1"), "接线口径 第1版");
});

test("verZh：认不出的版本串原样返回，绝不编一个错名字", () => {
  assert.equal(verZh("p9.s7.magic.v1"), "p9.s7.magic.v1");
  assert.equal(verZh("v3"), "v3");
  assert.equal(verZh(null), "");
});

test("verTail：窄胶囊只露尾号（v3 ⇒ 第3版，s6 ⇒ §6）", () => {
  assert.equal(verTail("p7.decision.v3"), "第3版");
  assert.equal(verTail("p7.taskbook.s6"), "§6");
  assert.equal(verTail("没有尾号"), "没有尾号");
});

test("plainify：正文里的枚举、引擎文件名、留档表名、版本号一次换净", () => {
  const out = plainify(
    "判定=ACCEPTED，来源 probability.ts（historicalWinProbability），落 event_interpretation 表，口径 p7.decision.v3",
  );
  assert.ok(out.includes("判定=成立"), out);
  assert.ok(out.includes("历史胜率统计引擎"), out);
  assert.ok(out.includes("事件解释留档"), out);
  assert.ok(out.includes("四维决策口径 第3版"), out);
  assert.ok(!/ACCEPTED|probability\.ts|event_interpretation|p7\.decision/.test(out), "四个记号一个都不许留");
});

test("plainify：未列出的字符与数值一字不动（原句可 diff 回去）", () => {
  const s = "半导体 +0.96%、主力净流入 23.02 亿（2026-09-23 11:30）";
  assert.equal(plainify(s), s, "没有工程记号的正常句子必须原样穿过");
  assert.equal(plainify(null), "");
});

test("plainify：雷达类型与新鲜度口径都有读法", () => {
  assert.equal(plainify("kind=theme 3 条"), "类型=主线 3 条");
  assert.equal(plainify("kind=risk/anomaly"), "类型=风险/异动");
  assert.equal(plainify("live 口径"), "实时口径");
  assert.equal(plainify("daily 口径"), "当日口径");
  assert.equal(plainify("NOT IMPLEMENTED"), "尚未实现");
});

test("promptVerZh：提示词/协议编号换读法，认不出原样", () => {
  assert.equal(promptVerZh("p6c-1"), "研究提示词 第1版");
  assert.equal(promptVerZh("p6b-2"), "事件解释提示词 第2版");
  assert.equal(promptVerZh("p6d-3"), "自主分析提示词 第3版");
  assert.equal(promptVerZh("p6d.agent.v2"), "自主分析协议 第2版");
  assert.equal(promptVerZh("p8-mode-anywhere"), "p8-mode-anywhere");
});

test("mcpStatusZh：四种运行态有读法，未知状态原样、空值说未启动", () => {
  assert.equal(mcpStatusZh("ready"), "已就绪");
  assert.equal(mcpStatusZh("starting"), "启动中");
  assert.equal(mcpStatusZh("failed"), "启动失败");
  assert.equal(mcpStatusZh("stopped"), "未启动");
  assert.equal(mcpStatusZh("something_new"), "something_new", "没列出的状态不许猜");
  assert.equal(mcpStatusZh(null), "未启动");
});

test("零依赖纯核：plain-core 不 import 任何东西，node --test 可直跑", () => {
  assert.ok(!/^\s*import\s/m.test(SELF), "出现 import 就破坏了纯核直跑口径");
  assert.ok(!/^\s*export\s+const\s+\w+\s*=\s*await/m.test(SELF), "纯核不许有顶层副作用");
});

test("收口在显示层：徽章渲染走读法，颜色判定仍看原始枚举串", () => {
  assert.ok(BADGE.includes("statusZh(status)"), "胶囊文字必须经 plain-core");
  assert.ok(/\/LIVE\/i\.test\(status\)/.test(BADGE), "颜色判定继续看原始串——血缘正则不许改锚中文");
});

test("判定层不吞状态：台账行的 data_status 仍是英文枚举字面量", () => {
  assert.ok(/data_status:\s*"REAL"/.test(RESEARCH), "换读法不许把 data_status 一起换成中文");
  assert.ok(/data_status:\s*"DERIVED"/.test(RESEARCH));
  assert.ok(!/data_status:\s*"[^"]*[\u4e00-\u9fa5]/.test(RESEARCH), "data_status 出现中文值即为越界");
});
