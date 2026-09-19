import { test } from "node:test";
import assert from "node:assert/strict";
import { assignThemeRoles, scoreTheme } from "../../src/lib/quant/screener/theme-rules.ts";
import { classifyNewsTitle, fundStage } from "../../src/lib/quant/screener/events-rules.ts";
import { similarReturnForward } from "../../src/lib/quant/screener/similar-env.ts";

test("主线：高扩散+流入+涨幅 → main", () => {
  const out = assignThemeRoles([
    { code: "BK1", name: "半导体", changePct: 3.2, mainYi: 20, rps: 100, diffusion: 0.7, streakPct: 4, streakInflow: 3 },
    { code: "BK2", name: "银行", changePct: 0.4, mainYi: 2, rps: 40, diffusion: 0.5, streakPct: 1, streakInflow: 1 },
    { code: "BK3", name: "跟风概念", changePct: 4.1, mainYi: -5, rps: 90, diffusion: 0.2, streakPct: 1, streakInflow: 0 },
  ]);
  assert.equal(out.find((x) => x.code === "BK1")?.role, "main");
  assert.equal(out.find((x) => x.code === "BK2")?.role, "sub");
  assert.equal(out.find((x) => x.code === "BK3")?.role, "rotation");
});

test("scoreTheme 资金不同步扣分", () => {
  const a = scoreTheme({ code: "a", name: "a", changePct: 3, mainYi: -8, rps: 80, diffusion: 0.3, streakPct: 1, streakInflow: 0 });
  const b = scoreTheme({ code: "b", name: "b", changePct: 3, mainYi: 8, rps: 80, diffusion: 0.6, streakPct: 3, streakInflow: 3 });
  assert.ok(b.score > a.score);
});

const THEMES = [{
  id: "fda_pharma", category: "医药", levelHint: "重大产业事件",
  keywords: ["FDA", "减肥药"], sectors: ["医药生物"], concepts: ["减肥药"],
}];

test("新闻命中关键词才映射，未命中不编造", () => {
  const hit = classifyNewsTitle("FDA批准某减肥药上市", "10:00", THEMES);
  assert.equal(hit.themeId, "fda_pharma");
  assert.equal(hit.level, "重大产业事件");
  const miss = classifyNewsTitle("某公司发布日常经营公告", "10:01", THEMES);
  assert.equal(miss.themeId, null);
  assert.equal(miss.level, "普通新闻");
});

test("资金阶段：无匹配板 → 无资金验证", () => {
  assert.equal(fundStage({ boardHits: [] }).stage, "无资金验证");
});

test("相似环境：带宽内样本与前向收益", () => {
  const bars: { date: string; c: number }[] = [];
  let p = 100;
  for (let i = 0; i < 80; i++) {
    p *= i % 5 === 0 ? 1.01 : 0.999;
    bars.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, c: p });
  }
  const s = similarReturnForward(bars, 5, [1, 5]);
  assert.ok(s.today_return !== null);
  assert.ok(s.horizons.length === 2);
});
