// 新闻解读新口径（用户 2026-10-17 定）：
// 能解释的才跟一句自然解释（无“解读：”标签，方向写进句子里）；
// 分析不出来的返回 null，只留新闻本身，不加填充句；
// 停牌 ≠ 退市：停牌只说临时停牌，绝不映射成“退出市场”。
// Feed 24h 窗口 + 周末公司公告前置交易日（2026-10-17 定）保持不变。

import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretNewsTitle } from "../../src/lib/desk/news-interpret.ts";
import { buildFeedRelatedSection } from "../../src/lib/desk/daily-report-sections-core.ts";
import { prevTradingDayBefore } from "../../src/lib/desk/slim-extra-sections.ts";

test("解释：减持 → 自然句，含方向，无“解读：”标签", () => {
  const s = interpretNewsTitle("某公司股东减持 1% 股份");
  assert.ok(s && s.includes("偏不利") && !s.includes("解读："));
});

test("解释：回购 → 自然句，含方向", () => {
  const s = interpretNewsTitle("公司回购 10 亿至 20 亿元股份");
  assert.ok(s && s.includes("偏利好") && !s.includes("解读："));
});

test("解释：备案 → null（程序性标题，没有实质解释可给）", () => {
  assert.equal(interpretNewsTitle("优艾智合机器人港股 IPO 获中国证监会备案"), null);
});

test("解释：利好与利空混在一起 → null，不硬猜", () => {
  assert.equal(interpretNewsTitle("公司业绩预增，但大股东减持"), null);
});

test("解释：无关键词 → null，不加填充句", () => {
  assert.equal(interpretNewsTitle("巴拿马发生 5.2 级地震"), null);
});

test("解释：业绩预告没说预增还是预减 → null", () => {
  assert.equal(interpretNewsTitle("晶科能源 2026 年前三季度业绩预告的自愿性披露公告"), null);
});

test("解释：业绩预告 + 预增 → 自然句", () => {
  const s = interpretNewsTitle("某公司 2026 年前三季度业绩预告：预增 50%");
  assert.ok(s && s.includes("偏利好"));
});

test("解释：连跌 → 自然句", () => {
  const s = interpretNewsTitle("芯片股走向二十年来最长连跌");
  assert.ok(s && s.includes("偏利空"));
});

test("解释：成本调查不是公司被调查 → 中性事实句，不误判利空", () => {
  const s = interpretNewsTitle("国务院常务会议：健全行业成本调查规则");
  assert.ok(s && s.includes("行业成本摸底") && !s.includes("偏利空"));
});

test("解释：豁免制裁 → 偏利好（组合优先于单关键词）", () => {
  const s = interpretNewsTitle("美国总统豁免适用制裁法案规定的部分制裁");
  assert.ok(s && s.includes("偏利好"));
});

test("解释：停牌 ≠ 退市 → 只说临时停牌，绝无“退出市场”", () => {
  const s = interpretNewsTitle("某公司股票停牌暨重大事项");
  assert.ok(s && s.includes("临时停牌") && !s.includes("退出市场"));
});

test("解释：停牌暨终止上市 → 仍按停牌解释，绝不映射成退出市场", () => {
  const s = interpretNewsTitle("某公司股票停牌暨终止上市");
  assert.ok(s && s.includes("临时停牌") && !s.includes("退出市场"));
});

test("解释：真正的退市 → 才说退出市场", () => {
  const s = interpretNewsTitle("*ST 岭南：收到终止上市事先告知书");
  assert.ok(s && s.includes("退出市场"));
});

test("解释：复牌 → 恢复交易", () => {
  const s = interpretNewsTitle("某公司股票复牌");
  assert.ok(s && s.includes("恢复交易"));
});

test("动态节：windowLabel 生效 + 无“解读：”标签、无填充句", () => {
  const sec = buildFeedRelatedSection(
    [{ title: "芯片股走向二十年来最长连跌", summary: "半导体 ETF 九连跌", sourceUrl: null, published: null, matchedKeywords: ["半导体"], source: "动态" }],
    5,
    "最近 24 小时内",
  );
  assert.ok(sec.plain.includes("最近 24 小时内动态里看了 5 条"));
  assert.ok(!sec.plain.includes("解读："));
  assert.ok(!sec.plain.includes("不明确"));
});

test("上一交易日：周六 10-17 → 周五 10-16；周日 10-18 → 周五 10-16", () => {
  assert.equal(prevTradingDayBefore("2026-10-17"), "2026-10-16");
  assert.equal(prevTradingDayBefore("2026-10-18"), "2026-10-16");
});
