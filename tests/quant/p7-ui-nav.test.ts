// P7-⑪ 任务1（UI 重构）导航结构与壳层接线测试
//
// 这一轮把 25 个零散菜单收成「3 大工作台 + 系统下拉」，最容易被改坏的是四件事：
// ① nav-core 登记表漏页/重页 ⇒ 有页面从两套入口都消失，或同一页归进两个工作台；
// ② 壳层把旧路由页面画成白屏 ⇒ 任务书约束 1.1「老路由保留」被破坏；
// ③ 有人图省事把 AppShell 分支删了 ⇒ hash 进来渲染不出；
// ④ 为折叠面板偷偷引入新依赖 ⇒ 违反「不新增 npm 依赖」全局约束。
// ①② 用纯核单测钉住（nav-core 不碰 React/window，可直接 import），③④ 钉源码。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  NAV, WORKBENCH_ORDER, workbenchOf, isLegacyPage, hasShellLeftRail,
} from "../../src/lib/desk/nav-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// PageKey 全集从 types.ts 现读：以后有人加页面但没登记 nav-core，这里直接红，而不是运行时白屏。
const PAGE_KEYS = (() => {
  const src = read("src/lib/desk/types.ts");
  const block = src.match(/export type PageKey =([\s\S]*?);/);
  assert.ok(block, "PageKey 结构变了：这条防漏页测试要跟着改成新形状，不能删断言");
  return [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

const WORKBENCHES = Object.keys(NAV) as (keyof typeof NAV)[];

test("nav-core：types.ts 里每个 PageKey 恰好落进一个工作台，不重不漏", () => {
  const listed = new Map<string, string[]>();
  for (const wb of WORKBENCHES) {
    for (const it of NAV[wb].items) listed.set(it.key, [...(listed.get(it.key) ?? []), `${wb}.items`]);
    for (const p of NAV[wb].legacyPages) listed.set(p, [...(listed.get(p) ?? []), `${wb}.legacyPages`]);
  }
  for (const key of PAGE_KEYS) {
    assert.deepEqual(listed.get(key) ?? [], listed.get(key) ? [listed.get(key)![0]] : [],
      `${key} 应恰好登记在一处（当前：${JSON.stringify(listed.get(key))}）：两处=归属打架，零处=从所有入口消失`);
    assert.notEqual(workbenchOf(key as never), null, `${key} 查不到工作台`);
  }
});

test("nav-core：分组小标签点的目标必须在同工作台列表里（点了跳不到不存在的项）", () => {
  for (const wb of WORKBENCHES) {
    const keys = new Set<string>(NAV[wb].items.map((i) => i.key));
    for (const g of NAV[wb].groups) {
      assert.ok(keys.has(g.target), `${wb} 的分组「${g.title}」指向 ${g.target}，但列表里没有这一项`);
    }
  }
});

test("nav-core：主边栏工作台按钮清单唯一，设置/扩展归 system 且不在工作台列表里", () => {
  // 2026-09-22 P9-经验轮口径迁移：对齐参考站（其顶导航把「奇门遁甲」列为一级入口），
  // 奇门从对话页内 tab 升为独立一级模块——按钮数从 3 变 4 是产品决定，
  // 但「清单唯一出处 + 顺序即视觉顺序 + 设置/扩展不散回主导航」的原意图逐字保住。
  assert.deepEqual(WORKBENCH_ORDER.map((w) => w.key), ["ai", "quant", "market", "qimen"],
    "主边栏按钮必须是 AI 决策/量化工具/行情中心/奇门遁甲 四个，顺序即视觉顺序");
  assert.deepEqual(NAV.system.items.map((i) => i.key), ["settings", "extension"]);
  for (const wb of ["ai", "quant", "market", "qimen"] as const) {
    for (const k of ["settings", "extension"]) {
      assert.ok(!NAV[wb].items.some((i) => i.key === k) && !NAV[wb].legacyPages.includes(k as never),
        `${k} 只能从底部系统下拉进，不许散回主导航`);
    }
  }
  // 奇门升一级后，对话页内不得再留「对话分析/奇门解盘」切换 tab（一处入口，不做两套）
  const assistantSrc = read("src/components/desk/pages/AssistantPage.tsx");
  assert.ok(!assistantSrc.includes("奇门解盘"), "对话页不再挂奇门 tab");
  assert.ok(!/deskMode/.test(assistantSrc), "deskMode 死连线已摘除");
});

test("nav-core：并入对话的旧页可 hash 直达但不上列表；copilot 自己不算 legacy", () => {
  for (const p of ["aihome", "analysis", "events", "research", "agent"] as const) {
    assert.ok(isLegacyPage(p), `${p} 应登记为 legacy（横幅指回对话）`);
    assert.equal(hasShellLeftRail(p), false, `${p} 是兼容路由，不画工作台左栏`);
    assert.equal(workbenchOf(p), "ai");
  }
  assert.equal(isLegacyPage("copilot"), false, "copilot 是对话本体，不是兼容路由");
  assert.equal(hasShellLeftRail("copilot"), false, "AI 决策左栏长在 AssistantPage，壳层不重复画");
  assert.equal(hasShellLeftRail("market"), true, "行情中心页面必须由壳层画左窄栏（两栏布局的来源）");
  assert.equal(hasShellLeftRail("quant"), true, "量化工具同上");
});

test("nav-core 是纯核：不 import React/window/存储，保证单测可直跑", () => {
  const src = read("src/lib/desk/nav-core.ts");
  for (const code of src.split("\n").filter((l) => !/^(\/\/|\*|\/\*)/.test(l.trim()))) {
    assert.doesNotMatch(code, /from "react|from "next|window\.|localStorage|zustand/, `nav-core 越界：${code.trim()}`);
  }
});

test("AppShell：每个 PageKey 的渲染分支一个不删（任务书约束：不删页面、老路由照常出内容）", () => {
  // 2026-09-22 P9-观感轮口径迁移：奇门升一级后其分支组件叫 QimenPanel（不叫 *Page），
  // 分支数随 PageKey 全集走（现 26 个）。原意图一字未动：hash 到任何老页面都必须有渲染分支，
  // 且整块包在 WorkbenchShell 里——只放宽组件名的匹配形状，不放宽「一个不删」。
  const src = read("src/components/desk/AppShell.tsx");
  for (const key of PAGE_KEYS) {
    assert.match(src, new RegExp(`page === "${key}" && <\\w+(?:Page|Panel) \\/>`), `旧路由 #/${key} 的渲染分支被删了`);
  }
  assert.match(src, /<WorkbenchShell>[\s\S]*<\/WorkbenchShell>/, "分支没有包进 WorkbenchShell：两栏壳与横幅不会生效");
});

test("Sidebar：只画 WORKBENCH_ORDER 三个按钮 + 底部系统下拉，源码里不再有逐页菜单", () => {
  const src = read("src/components/desk/Sidebar.tsx");
  assert.match(src, /WORKBENCH_ORDER\.map/, "主导航应从 WORKBENCH_ORDER 派生，而不是再抄一张列表");
  for (const key of ["market", "sectors", "agent", "quant", "pool", "settings"]) {
    assert.doesNotMatch(src, new RegExp(`key: "${key}"`), `侧栏源码里还留着逐页菜单项 ${key}：零散菜单没收干净`);
  }
  assert.match(src, /NAV\.system\.items/, "设置/扩展应从 nav-core 的 system 登记表渲染进下拉");
  assert.match(src, /REAL_DATA_ONLY/, "底部状态条口径不能丢");
});

test("WorkbenchShell：legacy 兼容路由挂横幅指回对话，而不是白屏或静默替换", () => {
  const src = read("src/components/desk/WorkbenchShell.tsx");
  assert.match(src, /import \{[^}]*isLegacyPage[^}]*\} from "@\/lib\/desk\/nav-core"/, "壳层应从纯核查归属");
  // 2026-09-22 P9-观感轮口径迁移：横幅文案从工程口径（「此页已并入 AI 决策对话」）改成
  // 对话口径（「这类问题直接在对话里问就行」），这是用户本轮「收声」指示的一部分。
  // 原意图三条一条没丢：说明去向 + 给一键回对话的出口 + 原页面照常渲染。
  assert.match(src, /这类问题直接在对话里问就行/, "旧路由进来要说明去向（否则读者以为页面坏了）");
  assert.match(src, /去对话/, "横幅要给一键回对话的出口");
  assert.match(src, /\{props\.children\}/, "横幅下方仍渲染原页面组件：兼容=照常能看，不是跳转拦截");
});

test("store：新会话默认落在 AI 决策对话（旧默认 aihome 已并入），persist 键不改动", () => {
  const src = read("src/lib/desk/store.ts");
  assert.match(src, /page:\s*"copilot"/, "初始页应是 copilot");
  assert.doesNotMatch(src, /page:\s*"aihome"/, "不应残留 aihome 初始值（两个初始值会打架）");
  assert.match(src, /name:\s*"mydesk-state"/, "persist 存储名改动会让老用户本地状态全丢，本轮不允许");
});

test("折叠面板用既有 radix 壳，任务1 全部新文件零新增依赖", () => {
  const collapse = read("src/components/desk/ui/DeskCollapse.tsx");
  assert.match(collapse, /from "@\/components\/ui\/collapsible"/, "DeskCollapse 应包项目里已有的 radix Collapsible 壳");
  const touched = [
    "src/lib/desk/nav-core.ts",
    "src/components/desk/ui/DeskCollapse.tsx",
    "src/components/desk/WorkbenchShell.tsx",
    "src/components/desk/Sidebar.tsx",
  ];
  for (const f of touched) {
    // lucide-react / radix 都是项目既有依赖；这里只钉「不许为折叠面板引 Element Plus」
    assert.doesNotMatch(read(f), /element-plus/, `${f} 引用了未安装的 element-plus：违反不新增依赖约束`);
  }
  // lucide-react 与 radix 都在 package.json 里原有；element-plus 不许出现（它没装）
  assert.doesNotMatch(read("package.json"), /element-plus/, "package.json 被塞了新依赖：违反全局约束");
});
