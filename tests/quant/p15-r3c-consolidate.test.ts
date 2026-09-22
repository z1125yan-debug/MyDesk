// P15-R3c 收口轮·回归钉：双入口合并 + FactorLab 血缘卡制。
//
// 两件：
//  ① quant 门户与 aiscan「两个窗口同一套内容」——用户拍板「合并成一条」：菜单不再单列
//    「全A 实时选股」，旧 hash/递棒 go("aiscan") 一律收口到 quant 门户主 Tab（那里挂的就是
//    AiScanPage 本体）。PageKey、AppShell 分支、P12 递棒钉一个不删（p7 已钉合并本体）。
//  ② FactorLabPage 从「4 块手搓散卡 + local Metric 小卡」收成一张 LineageCard，
//    参数条升格为卡头控制面板，数字小卡走全仓库唯一源 StatCard——取数/判定逻辑一字未动。
//  ③ 3014 实机走查抓到：别名 hash 直达时 URL 卡在 #/aiscan——AppShell 监听器补回写自愈。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const LAB = "src/components/desk/pages/FactorLabPage.tsx";

/* ---------------- ① 双入口合并（结构面，行为面钉在 p7） ---------------- */

test("合并落地：菜单 children 不再单列 aiscan，只留 quant 门户一条", () => {
  const nav = readSrc("src/lib/desk/nav-core.ts");
  // aiscan 从 children 摘掉，改由 ROUTE_REDIRECTS 收口
  assert.ok(!nav.includes(`{ key: "aiscan", label: "全A 实时选股" }`), "aiscan 不该再作为菜单子项单列");
  assert.match(nav, /ROUTE_REDIRECTS[^]*aiscan:\s*"quant"/, "aiscan→quant 收口登记在 nav-core 纯核");
  assert.match(nav, /export function resolveRoute\(p: PageKey\): PageKey/);
  // 门户主 Tab 仍挂 AiScanPage 本体（合并的落点真有其页，不是把 aiscan 删没了）
  assert.match(readSrc("src/components/desk/QuantPage.tsx"), /value="portal"[\s\S]*<AiScanPage \/>/);
  // P12 递棒钉原样活着（板块页仍 go("aiscan")，由 store.resolveRoute 统一收口——调用方零改动）
  assert.match(readSrc("src/components/desk/pages/SectorsPage.tsx"), /go\("aiscan"\)/);
});

/* ---------------- ② FactorLab 血缘卡制 ---------------- */

test("FactorLab：一张 LineageCard + 三节（因子选择/验证结果/测试记录），local Metric 小卡退役", () => {
  const src = readSrc(LAB);
  assert.match(src, /from "\.\.\/ui\/LineageCard"/);
  assert.equal(src.match(/<LineageCard/g)?.length, 1, "只有一张详情大卡");
  assert.match(src, /<LineageSection title="因子选择"/);
  assert.match(src, /<LineageSection title="验证结果"/);
  assert.match(src, /<LineageSection title="测试记录"/);
  // local Metric 卡函数必须消失（数字全走唯一源 StatCard），但图元 GroupBars/MonthlyBars 保留
  assert.ok(!/function Metric\s*\(/.test(src), "local Metric 小卡未退役=卡片实现开始漂移");
  assert.match(src, /function GroupBars\s*\(/, "条形图元不是卡，留在本页是对的");
  assert.match(src, /function MonthlyBars\s*\(/);
  assert.ok((src.match(/<StatCard/g)?.length ?? 0) >= 7, "IC/RankIC/ICIR/单调/月胜率/换手/回撤 七指标各一 StatCard");
});

test("FactorLab：参数条升格为卡头控制面板，跑测试按钮/防泄漏口径行原样在", () => {
  const src = readSrc(LAB);
  assert.match(src, /actions=\{[\s\S]*跑测试/, "跑测试升格进标题行 actions（对齐板块页形态）");
  assert.match(src, /t\+?\{horizon\} 日前向收益（防泄漏）/);
  assert.match(src, /通过标准 \|ICIR\|&gt;0\.5/);
  // 验证结果 tone 承载真实判定（通过绿/未过橙），不是恒色
  assert.match(src, /title="验证结果" tone=\{result\.passed \? "success" : "warning"\}/);
  // 通过/未过文案与快照置灰判定一字没改
  assert.match(src, /✓ 通过（已写入验证状态）/);
  assert.match(src, /✗ 未通过（保持未验证标记）/);
  assert.match(src, /快照口径字段：无历史时点数据，不可测/);
});

/* ---------------- ③ 别名 hash 的 URL 自愈（实机走查抓到的口径分裂） ---------------- */

test("AppShell：#/aiscan 直达时地址栏必须回写成 #/quant——go 收口后 page 未变，自愈 effect 不会重跑", () => {
  const shell = readSrc("src/components/desk/AppShell.tsx");
  // 监听器里：别名 hash 先回写成收口目标（3014 实机抓到「内容已是门户、URL 还挂别名」的分支）
  assert.match(shell, /const target = resolveRoute\(fromHash\);\s*\n\s*if \(target !== fromHash\) \{ window\.location\.hash/,
    "hashchange 未回写别名——URL 与页面口径分裂回归");
  // 自愈 effect 仍在（persist 恢复出旧页 aiscan 的路径靠它）
  assert.match(shell, /const target = resolveRoute\(page\);\s*\n\s*if \(target !== page\) \{ go\(target\); return; \}/);
});
