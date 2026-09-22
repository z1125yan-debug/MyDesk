// P15-R5 主题四规则读数（热度/置信/次日风险/追避）钉测。
//
// 用户拍板：稳智那几个分爬不到公式，那就「用自己的算法模仿，要求真实」。
// 这一轮的红线全在纯核里，可 node:test 直跑：
//  1. 每一分都吃 ThemeScoreInput 里已实测拿到的真实字段，无 IO、不造后端；
//  2. 缺项剔除 + 按可得权重重新归一（不是拿 0 顶替）——断源/无日K时热度仍能算，且如实记「剔除：…」；
//  3. 置信度 = 证据一致度 × 数据齐全度：维度缺得越多、越反相，分越低（把断源变成看得见的扣分）；
//  4. 次日风险只是「过热/背离读数」，涨价但主力净流出必须把风险顶上去；
//  5. rising 清单封顶 3 条，凑不满不硬塞（对齐稳智「最多 3 个方向、不凑数量」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichThemes, type ThemeScoreInput, type ThemeEnv,
} from "../../src/lib/quant/screener/theme-rules.ts";

const row = (over: Partial<ThemeScoreInput>): ThemeScoreInput => ({
  code: "BK0001", name: "测试", changePct: 3, mainYi: 5, rps: 90,
  diffusion: 0.7, streakPct: 3, streakInflow: 2, ...over,
});
const fullEnv: ThemeEnv = { breakRate: 20, fundsAvailable: true };

test("热度：全字段可用时按 RPS/扩散/资金/涨幅/连涨 合成，且明列每个计入分项", () => {
  const [r] = enrichThemes([row({})], fullEnv);
  assert.ok(r.heat >= 0 && r.heat <= 100, "热度落在 0-100");
  assert.ok(r.heatParts.some((p) => p.includes("榜内RPS")), "热度分项要有 RPS");
  assert.ok(r.heatParts.some((p) => p.includes("内部扩散")), "全字段可用时应计入内部扩散");
  assert.ok(!r.heatParts.some((p) => p.startsWith("剔除：内部扩散")), "扩散有值时不该被剔除");
});

test("热度去缺失重归一：无日K/成分断源时剔除这些项、不拿 0 充数，仍出分", () => {
  const [r] = enrichThemes([row({ diffusion: null, streakPct: null })], fullEnv);
  assert.ok(r.heatParts.some((p) => p === "剔除：内部扩散（成分快照无返回）"), "应如实记扩散被剔除");
  assert.ok(r.heatParts.some((p) => p === "剔除：连涨天数（板块日K无返回）"), "应如实记连涨被剔除");
  assert.ok(r.heat > 0, "剔除后靠 RPS/资金/涨幅仍能算出热度，不是 0");
});

test("热度资金断源（腾讯兜底）：mainYi 占位 0 被整项剔除，不参与分母", () => {
  const env: ThemeEnv = { breakRate: 20, fundsAvailable: false };
  const [r] = enrichThemes([row({ mainYi: 0 })], env);
  assert.ok(r.heatParts.some((p) => p.includes("剔除：主力净额") && p.includes("腾讯兜底")), "资金断源要写清出身并剔除");
  assert.ok(!r.heatParts.some((p) => p.includes("主力强度分位")), "资金断源时不得出现资金分位项");
});

test("置信度随缺源下降：全维有数据 > 只余 RPS/涨幅两维；反相进一步压低", () => {
  const rich = enrichThemes([row({})], fullEnv)[0];
  const thin = enrichThemes([row({ diffusion: null, streakPct: null })], { breakRate: 20, fundsAvailable: false })[0];
  assert.ok(rich.confidence > thin.confidence, "维度越全置信越高");
  assert.match(rich.confidenceNote, /\/5 维有数据/, "置信要报几维有数据");
  assert.match(rich.confidenceNote, /项同向/, "置信要报几项同向");
  // 同向但数据很薄：一致度满分也拉不开齐全度的账
  const contradict = enrichThemes([row({ mainYi: -9, changePct: 3, diffusion: 0.2, streakPct: 0 })], fullEnv)[0];
  assert.ok(contradict.confidence < rich.confidence, "涨价但资金流出/扩散弱应拉低置信");
});

test("置信分档不被薄证据吹高：只剩 2/5 维时数值再高也不标「高」", () => {
  const thin = enrichThemes([row({ diffusion: null, streakPct: null })], { breakRate: 20, fundsAvailable: false })[0];
  assert.match(thin.confidenceNote, /2\/5 维有数据/, "只剩 RPS+涨幅两维");
  assert.notEqual(thin.confidenceLabel, "高", "断源只剩 2 维不许冒称高置信（封顶中/低）");
});

test("次日风险：涨价但主力净流出（背离）把风险顶高，且不叫涨跌概率", () => {
  const diverge = enrichThemes([row({ changePct: 5, mainYi: -8, diffusion: 0.3 })], fullEnv)[0];
  const aligned = enrichThemes([row({ changePct: 5, mainYi: 8, diffusion: 0.8 })], fullEnv)[0];
  assert.ok(diverge.risk > aligned.risk, "价量背离的风险应高于同向");
  assert.ok(diverge.riskParts.some((p) => p.includes("背离")), "风险来源要点名背离");
  assert.ok(["低", "中", "高"].includes(diverge.riskLabel), "风险给的是分级读数不是概率");
});

test("次日风险去缺失：炸板率断源(null)时剔除该分项，仍按其余项归一", () => {
  const [r] = enrichThemes([row({})], { breakRate: null, fundsAvailable: true });
  assert.ok(!r.riskParts.some((p) => p.includes("全市场炸板率")), "炸板率缺失不应计入风险来源");
});

test("追/避判定：热+信双高且未过热才 rising；风险≥65 直接 avoid", () => {
  const hot = enrichThemes([row({ rps: 98, changePct: 3, mainYi: 20, diffusion: 0.9, streakPct: 2 })], { breakRate: 5, fundsAvailable: true })[0];
  assert.ok(hot.heat >= 65 && hot.confidence >= 55 && hot.risk <= 45, "构造的强势样本应满足可关注线");
  assert.equal(hot.verdict, "rising");
  const risky = enrichThemes([row({ rps: 95, changePct: 7, mainYi: -20, diffusion: 0.3, streakPct: 6 })], { breakRate: 90, fundsAvailable: true })[0];
  assert.ok(risky.risk >= 65, "构造样本风险应偏高");
  assert.equal(risky.verdict, "avoid");
});

test("rising 封顶 3：5 个都达标也只留热度前 3，其余降 watch 不凑数", () => {
  const rows = [1, 2, 3, 4, 5].map((i) => row({ code: `BK000${i}`, rps: 99 - i, changePct: 3, mainYi: 30, diffusion: 0.95, streakPct: 2 }));
  const envs: ThemeEnv = { breakRate: 3, fundsAvailable: true };
  const out = enrichThemes(rows, envs);
  const rising = out.filter((r) => r.verdict === "rising");
  assert.ok(rising.length <= 3, `rising 最多 3 条，实得 ${rising.length}`);
  for (const r of out.filter((x) => x.verdict === "watch")) {
    if (r.heat >= 65 && r.confidence >= 55 && r.risk <= 45) {
      assert.match(r.verdictReason, /封顶 3 条不凑数/, "被降级的达标项要说明是封顶所致");
    }
  }
});

test("纯核无 IO：enrichThemes 只吃入参、返回等长对齐、不改传入数组", () => {
  const rows = [row({ code: "A" }), row({ code: "B" })];
  const snapshot = JSON.stringify(rows);
  const out = enrichThemes(rows, fullEnv);
  assert.equal(out.length, rows.length, "一一对应");
  assert.equal(JSON.stringify(rows), snapshot, "不得原地改入参");
  assert.ok(out.every((r, i) => r.code === rows[i].code), "顺序对齐");
});
