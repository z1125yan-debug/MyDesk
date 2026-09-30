// P36-E6 档位切换条（强势 / 震荡 / 弱势）
//
// 钉的四件事：
//  1) 判档口径与 regime-core 同源（同一套序列算出来的档位必须一致，不许页面另开一套）；
//  2) ?regime= 只接受 auto / 强势 / 震荡 / 弱势，其余一律 400（口径边界模糊 = 分享出去的链接会指向不同东西）；
//  3) 手动切到非当天档 = 研究模式，必须出提示条；auto 与「切到当天档」都不许乱弹；
//  4) 弹层文案说人话：不许出现 MA20 / 截面 / 样本外 / 超额 / 置信区间 / 牛市 / 熊市，
//     且每档那句话必须带「看了多少天」。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  regimeSnapshotOf, parseRegimeParam, isResearchMode, researchBannerOf,
  regimeLineOf, regimeExplainLinesOf, regimeCaveatLinesOf, regimeBadgeTextOf,
  REGIME_METHOD_LINE, type RegimeReversalFact, type RegimeReversalFile,
} from "../../src/lib/quant/strategy/regime-switch-core.ts";
import { regimeSeriesOf, REGIMES, type Regime } from "../../src/lib/quant/strategy/regime-core.ts";

const read = (p: string): string => readFileSync(path.join(process.cwd(), p), "utf8");
const BLACKLIST = ["MA20", "样本外", "样本内", "置信区间", "截面", "超额", "净值曲线", "反向因子", "IC", "RankIC", "牛市", "熊市"];

/** 造一段收盘价：先跌后涨，用来验证档位跟着序列走 */
const bars = (closes: number[], from = "2026-01-01"): { date: string; close: number }[] =>
  closes.map((c, i) => {
    const d = new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10);
    return { date: d, close: c };
  });

const file = (byRegime: Partial<Record<Regime, RegimeReversalFact>>): RegimeReversalFile => ({
  builtAt: "2026-10-01", source: "test",
  window: { from: "2023-06-15", to: "2026-09-30", bars: 800, universe: 600, horizon: 5, lookback: 20, days: 775 },
  byRegime, note: "",
});

test("判档与 regime-core 同源：同一段收盘价，快照的档位 = regimeSeriesOf 的最后一天", () => {
  // 一路向上：收盘逐日抬高 → 站上月均价且月均价向上 = 强势
  const up = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
  const sUp = regimeSnapshotOf(bars(up));
  assert.equal(sUp.regime, regimeSeriesOf(up)[up.length - 1]);
  assert.equal(sUp.regime, "强势");
  // 一路向下 → 弱势
  const down = Array.from({ length: 40 }, (_, i) => 200 - i * 2);
  assert.equal(regimeSnapshotOf(bars(down)).regime, "弱势");
  assert.equal(regimeSnapshotOf(bars(down)).regime, regimeSeriesOf(down)[down.length - 1]);
  // 读数必须带出来（界面要说「比最近一个月的平均价高/低」）
  assert.ok(sUp.ma20 != null && sUp.close != null);
  assert.equal(sUp.asOf, bars(up)[up.length - 1].date);
});

test("持续天数：往回数连续同档，中间断了就停（不跨过「算不出来」那天继续数）", () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
  const s = regimeSnapshotOf(bars(up));
  // MA20 从第 20 根才有（下标 19），但下标 19 那天没有前值可比方向 → 归入震荡，
  // 所以「强势」只能从下标 20 数起：40 根 − 20 = 20 天
  assert.equal(s.daysInRegime, 20);
  assert.equal(s.sinceDate, bars(up)[20].date);
});

test("日K不足 20 根 → 档位 null + 人话原因，不猜不补 0", () => {
  const s = regimeSnapshotOf(bars([100, 101, 102]));
  assert.equal(s.regime, null);
  assert.equal(s.daysInRegime, null);
  assert.match(s.error, /不足 20 根/);
  assert.match(regimeBadgeTextOf(s), /算不出/);
});

test("?regime= 只认 auto / 强势 / 震荡 / 弱势，其余返回 null（调用方回 400）", () => {
  assert.equal(parseRegimeParam(null), "auto");
  assert.equal(parseRegimeParam(""), "auto");
  assert.equal(parseRegimeParam("auto"), "auto");
  for (const r of REGIMES) assert.equal(parseRegimeParam(r), r);
  // URL 里是转义过的中文，要能认
  assert.equal(parseRegimeParam(encodeURIComponent("弱势")), "弱势");
  for (const bad of ["牛", "牛熊", "strong", "强势档", "1", "SH"]) {
    assert.equal(parseRegimeParam(bad), null, `「${bad}」不该被当成合法档位`);
  }
});

test("研究模式：切到非当天档才出提示条，auto 与切到当天档都不许弹", () => {
  assert.equal(isResearchMode("auto", "强势"), false);
  assert.equal(isResearchMode("强势", "强势"), false);
  assert.equal(isResearchMode("弱势", "强势"), true);
  assert.equal(researchBannerOf("auto", "强势"), null, "auto 是默认态，不该弹提示");
  assert.equal(researchBannerOf("强势", "强势"), null, "切到的正是今天那档，不该弹");
  const b = researchBannerOf("弱势", "强势") as string;
  assert.match(b, /【弱势档】/);
  assert.match(b, /今天大盘实判【强势档】/);
  assert.match(b, /回看/);
  // 今天档位算不出来时也要如实说，不能假装是今天的建议
  const b2 = researchBannerOf("弱势", null, "上证日K不足 20 根") as string;
  assert.match(b2, /没算出来/);
  assert.match(b2, /不是今天的建议/);
});

test("弹层五条：判法 + 三档各一句 + 样本警示，且每档都带「看了多少天」", () => {
  const facts: Partial<Record<Regime, RegimeReversalFact>> = {
    强势: { days: 344, hot: 1.48, cold: 0.56, spread: -0.92, excess: -0.19, mkt: 0.75 },
    震荡: { days: 138, hot: 0.09, cold: 0.37, spread: 0.28, excess: 0.36, mkt: 0.01 },
    弱势: { days: 293, hot: 0.6, cold: 1.05, spread: 0.45, excess: 0.22, mkt: 0.83 },
  };
  const lines = regimeExplainLinesOf(file(facts));
  assert.equal(lines[0], REGIME_METHOD_LINE);
  assert.ok(lines.length >= 5, `弹层至少五条，实测 ${lines.length}`);
  for (const r of REGIMES) {
    const line = lines.find((l) => l.startsWith(r)) as string;
    assert.ok(line, `弹层缺少「${r}」那一句`);
    assert.match(line, /看了 \d+ 天/, `${r} 那句没写「看了多少天」`);
  }
  // 警示必须说到「换一段时间顺序可能变」和「不能预测明天」
  const caveat = regimeCaveatLinesOf(file(facts)).join("");
  assert.match(caveat, /换另一段时间/);
  assert.match(caveat, /不能预测明天/);
});

test("结论跟着数字走：强势档实测是追涨更强，不许把「抄跌一定赚」写死", () => {
  // spread 为负（涨最猛那批之后更强）→ 文案必须说抄跌吃亏
  const strong = regimeLineOf("强势", { days: 344, hot: 1.48, cold: 0.56, spread: -0.92, excess: -0.19, mkt: 0.75 });
  assert.match(strong, /抄跌反而吃亏/);
  assert.doesNotMatch(strong, /抄跌略微占优/);
  // spread 很小 → 不许装作有规律
  const flat = regimeLineOf("震荡", { days: 138, hot: 0.1, cold: 0.2, spread: 0.1, excess: 0.05, mkt: 0.15 });
  assert.match(flat, /基本没区别/);
  // 没攒够天数的档 → 如实说看不出规律
  assert.match(regimeLineOf("弱势", null), /还没攒够天数/);
});

test("文案里不出现「少 +0.19%」这种两个符号叠一起的读不通写法", () => {
  const neg = regimeLineOf("强势", { days: 344, hot: 1.48, cold: 0.56, spread: -0.92, excess: -0.19, mkt: 0.75 });
  assert.match(neg, /比市场平均少 0\.19%/);
  assert.doesNotMatch(neg, /少 \+/);
  const pos = regimeLineOf("弱势", { days: 293, hot: 0.6, cold: 1.05, spread: 0.45, excess: 0.22, mkt: 0.83 });
  assert.match(pos, /比市场平均多赚 \+0\.22%/);
});

test("弹层文案全是人话：黑名单一个词都不许出现", () => {
  const facts: Partial<Record<Regime, RegimeReversalFact>> = {
    强势: { days: 344, hot: 1.48, cold: 0.56, spread: -0.92, excess: -0.19, mkt: 0.75 },
    弱势: { days: 293, hot: 0.6, cold: 1.05, spread: 0.45, excess: 0.22, mkt: 0.83 },
  };
  const all = [
    REGIME_METHOD_LINE,
    ...regimeExplainLinesOf(file(facts)),
    ...regimeExplainLinesOf(null),
    regimeBadgeTextOf(regimeSnapshotOf(bars(Array.from({ length: 40 }, (_, i) => 100 + i * 2)))),
    ...REGIMES.map((r) => researchBannerOf(r, "强势") ?? ""),
  ];
  for (const s of all) {
    for (const bad of BLACKLIST) {
      assert.ok(!s.includes(bad), `文案「${s}」含黑话「${bad}」`);
    }
  }
});

// ---- 钉测：组件文案里不许出现「牛市/熊市」 ----
// 只扫代码行：注释里提到这两个字是在交代「为什么不用它」，不是给用户看的文案。
const userFacing = (src: string): string =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("E6 钉测：档位切换条与选股工作台里不许出现「牛市」「熊市」", () => {
  for (const f of ["src/components/desk/pages/RegimeSwitchBar.tsx", "src/components/desk/pages/ScreenerWorkbench.tsx"]) {
    const src = userFacing(read(f));
    assert.doesNotMatch(src, /牛市|熊市/, `${f} 里出现了「牛市/熊市」：用户会理解成大行情，是系统性误导`);
  }
  // 顺带钉：切换条组件必须接的是那个轻量接口，不许自己算档位
  const bar = read("src/components/desk/pages/RegimeSwitchBar.tsx");
  assert.match(bar, /\/api\/market\/regime/, "档位只能来自 /api/market/regime（口径同源），不许页面另算一套");
  assert.doesNotMatch(bar, /ma20Of|regimeSeriesOf/, "页面不许自己算均线/档位");
});

// ---- 数据文件自洽 ----
test("data/regime-reversal.json 计数自洽：三档天数之和 = window.days，且数字不是空跑出来的", () => {
  const j = JSON.parse(read("data/regime-reversal.json")) as RegimeReversalFile;
  const sum = REGIMES.reduce((s, r) => s + (j.byRegime[r]?.days ?? 0), 0);
  assert.equal(sum, j.window.days, "三档天数之和与 window.days 不一致（文件被手改过？）");
  assert.ok(j.window.days > 200, `样本应来自扩样本后的粮仓（>200 天），实测 ${j.window.days}`);
  for (const r of REGIMES) {
    const f = j.byRegime[r];
    assert.ok(f && f.days > 0, `${r} 档没攒出截面`);
    assert.ok(Number.isFinite(f.hot) && Number.isFinite(f.cold));
  }
});
