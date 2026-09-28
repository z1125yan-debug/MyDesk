// P15-R19 宽度口径交叉核对的钉测：纯核算法 + 页面接线 + 口径文案改口。
//
// 背景：R19 给 stock_daily_close 回填了 110 个交易日的真实收盘价（新浪日K，不复权），
// 项目里第一次出现「同一个指标、两个独立来源」——稳智同步种子的 aboveMa5Pct 与本地自算的 above_ma5_pct。
// 本轮实测结论（106 个可比交易日，取法见 worklog）：两条线走势一致（相关 0.98），
// 但**水平对不齐**：本地自算（三市全A）平均低 4.68 个百分点、最大低 14.25 个百分点，且差距随日期靠近种子快照日而收敛
// （4 月 −12 左右、9 月 −1 以内）。已排除的解释：日期错位（±1 天只会更差）、票池不同（剔掉北交所后
// 分母 5,156~5,209 与种子反推的 5,174~5,210 基本吻合，但平均差只从 4.68 降到 4.42，只值 0.26 个点）、
// 复权基准不同（同票配对测到最多 +1.9 个百分点）。
// 这套钉守的是「比对算法本身不许算错」+「页面一次只画一条口径、默认画我们自己的三市自算，
// 差多少必须写在口径行里、不许静默替换也不许并排摆五条线」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareBreadthWithSeed } from "../../src/lib/quant/review/breadth-crosscheck-core.ts";
import { BREADTH_CALIBER } from "../../src/lib/quant/screener/breadth-core.ts";

const PAGE = readFileSync(new URL("../../src/components/desk/pages/MarketPage.tsx", import.meta.url), "utf8");

const seedPts = (pts: [string, number | null][]) => pts.map(([date, aboveMa5Pct]) => ({ date, aboveMa5Pct }));
const compPts = (pts: [string, number | null][]) => pts.map(([date, above_ma5_pct]) => ({ date, above_ma5_pct }));

test("R19-X① 两条线完全一样：偏差 0、相关 1，结论是「同口径」", () => {
  const pts: [string, number][] = [["2026-09-22", 78.4], ["2026-09-23", 57.7], ["2026-09-24", 26.2]];
  const r = compareBreadthWithSeed(seedPts(pts), compPts(pts));
  assert.equal(r.comparable_days, 3);
  assert.equal(r.mean_abs_pt, 0);
  assert.equal(r.max_abs_pt, 0);
  assert.equal(r.mean_signed_pt, 0);
  assert.equal(r.corr, 1);
  assert.match(r.verdict, /同口径/);
  assert.deepEqual(r.worst, [], "没差异就别造一个「最差三天」");
});

test("R19-X② 整体抬高 5 个点：带符号偏差 +5、相关仍是 1（平行线不是没关系）", () => {
  const s: [string, number][] = [["2026-09-22", 79.0], ["2026-09-23", 57.8], ["2026-09-24", 27.6]];
  const c: [string, number][] = s.map(([d, v]) => [d, v + 5]);
  const r = compareBreadthWithSeed(seedPts(s), compPts(c));
  assert.equal(r.mean_signed_pt, 5, "自算 − 种子：正数就是本地更高");
  assert.equal(r.mean_abs_pt, 5);
  assert.equal(r.max_abs_pt, 5);
  assert.equal(r.corr, 1);
  assert.match(r.verdict, /对不齐/);
  assert.match(r.verdict, /本地自算整体偏高/);
});

test("R19-X③ 缺读数不进比对：null 不是 0，一侧为 null 的日子直接跳过", () => {
  const r = compareBreadthWithSeed(
    seedPts([["2026-09-22", 79.02], ["2026-09-23", null], ["2026-09-24", 27.56]]),
    compPts([["2026-09-22", 78.78], ["2026-09-23", 57.73], ["2026-09-24", 26.2]]),
  );
  assert.equal(r.comparable_days, 2, "09-23 种子侧没有读数：这一天不参与，不拿 0 顶上");
  assert.equal(r.seed_days, 2);
  assert.equal(r.computed_days, 3);
  // 可比的两边都只差 1 个多点：如果把 09-23 当 0 算，平均绝对偏差会飙到 20 以上
  assert.ok((r.mean_abs_pt as number) < 2, `真实差值不该被算成假差异：${r.mean_abs_pt}`);
});

test("R19-X④ 没有一个同日读数：报「没得比」而不是「一致」", () => {
  const r = compareBreadthWithSeed(seedPts([["2026-09-24", 27.56]]), compPts([["2026-09-25", 30]]));
  assert.equal(r.comparable_days, 0);
  assert.equal(r.mean_abs_pt, null);
  assert.equal(r.max_abs_pt, null);
  assert.equal(r.corr, null);
  assert.match(r.verdict, /没得比/);
});

test("R19-X⑤ 一侧是水平线时相关算不出：留 null，不填 0 冒充「毫无关系」", () => {
  const r = compareBreadthWithSeed(
    seedPts([["2026-09-22", 50], ["2026-09-23", 50], ["2026-09-24", 50]]),
    compPts([["2026-09-22", 55], ["2026-09-23", 45], ["2026-09-24", 60]]),
  );
  assert.equal(r.corr, null, "种子侧方差为 0：相关系数无定义（算不出就是算不出，不是「两条线毫无关系」）");
  assert.equal(r.mean_signed_pt, 3.33, "((55−50)+(45−50)+(60−50))/3 = +10/3：本地自算整体偏高");
  assert.match(r.verdict, /本地自算整体偏高/);
});

test("R19-X⑥ 最差三天按绝对偏差降序、并列按日期升序，且最多三条", () => {
  const r = compareBreadthWithSeed(
    seedPts([["2026-09-20", 40], ["2026-09-21", 40], ["2026-09-22", 40], ["2026-09-23", 40]]),
    compPts([["2026-09-20", 45], ["2026-09-21", 35], ["2026-09-22", 43], ["2026-09-23", 60]]),
  );
  assert.deepEqual(r.worst.map((w) => w.date), ["2026-09-23", "2026-09-20", "2026-09-21"]);
  assert.equal(r.worst[0].diff_pt, 20);
  assert.equal(r.worst.length, 3, "报三条就够看：把 110 天全列出等于没重点");
});

test("R19-X⑦(2026-09-29 反转) 大盘情绪图恢复五线默认：同步四线 + 自算第五条点线，默认口径回「同步·两市」", () => {
  assert.match(PAGE, /compareBreadthWithSeed/, "对照差值走同一份纯核，页面里不许再手写一遍算法");
  // 2026-09-29 用户拍板恢复 R19c 之前的五线视图（原话：原来的这里有大盘小盘微盘什么的 有五根线）——
  // R19c 的「太拥挤砍成单线」被推翻；「本地·三市」单线视图保留为可切换项。
  assert.match(PAGE, /useState<"local" \| "sync">\("sync"\)/, "默认口径回到「同步·两市」（五线齐全的那一档）");
  assert.match(PAGE, /const bMain = bDrawn === "sync" \? bSync : bLocalWin;/, "主线跟着实际选中那条走，不是写死种子");
  assert.match(PAGE, /本地·三市/, "单线视图保留为可切换项");
  assert.match(PAGE, /同步·两市/);
  // 第五条点线恢复：自算·真实收盘（蓝点线）作为对照并排摆，两个口径不静默替换
  assert.match(PAGE, /breadthOption\(bMain, bGroups, /, "自算那条作为第三个参数进图（bLocalWin，本地没攒够时传 null）");
  assert.match(PAGE, /自算·真实收盘/, "第五条点线恢复：本库真实收盘三市全A自算");
  assert.match(PAGE, /CHART\.color\.selfComputed/, "自算线用回专属蓝色 token，不蹭分组色");
  // 分组虚线仍来自同步口径的种子（本地库里没有市值分组，不自编一套冒充）
  assert.match(PAGE, /微盘股/, "微/中/大盘三条虚线恢复（种子分组）");
  // 两口径差多少仍必须写在标题下面，让人不用悬停量
  assert.match(PAGE, /平均差 \$\{bCheck\.mean_abs_pt/, "差多少个点要摆在脸上");
  assert.match(PAGE, /去掉北交所只少 0\.26 点/, "票池只值 0.26 个点这个量化结论要跟着数走，别让人以为去了北交就齐了");
  // 本地没攒够两天时如实退回，并明说画的是别人的数——不许挂着「自算」画同步口径
  assert.match(PAGE, /暂时画的是同步口径/);
});

test("R19-X⑦b(2026-09-29 反转) 配色令牌里 selfComputed 蓝色随第五条线一并恢复", () => {
  const tokens = readFileSync(new URL("../../src/components/desk/charts/chart-tokens.ts", import.meta.url), "utf8");
  assert.match(tokens, /selfComputed:/, "五线视图恢复了，对照线专属蓝色必须在 token 里（页面引用它）");
});

test("R19-X⑦c 同步那条线只画到种子终点：终点之后库里是三市自算，接上去就是挂错名字的口径", () => {
  assert.match(PAGE, /x\.date <= seedEnd/, "bSyncRows 要按 seedEnd 截断");
  assert.match(PAGE, /seedEnd/, "页面得拿到「种子覆盖到哪天」这个事实");
  const ROUTE = readFileSync(new URL("../../src/app/api/market/review-stats/route.ts", import.meta.url), "utf8");
  assert.match(ROUTE, /seedEnd: SEED_END/, "接口把种子终点回给页面，别让前端自己数行数");
  const API = readFileSync(new URL("../../src/lib/desk/quant-api.ts", import.meta.url), "utf8");
  assert.match(API, /seedEnd\?: string/, "客户端类型带上这个字段");
});

test("R19-X⑧ 宽度口径句改口：历史来自真实日K回填，且价格基准只有一种", () => {
  assert.match(BREADTH_CALIBER, /不复权原始价/);
  assert.match(BREADTH_CALIBER, /回填/);
  assert.equal(/无回填/.test(BREADTH_CALIBER), false, "「自部署日起攒、无回填」已经不是事实，留着就是假口径");
  assert.match(BREADTH_CALIBER, /同一套算法、同一种价格基准/);
});
