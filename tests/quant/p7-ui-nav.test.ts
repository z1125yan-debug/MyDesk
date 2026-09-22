// P7-⑪ 任务1（UI 重构）导航结构与壳层接线测试（P15-R3a 菜单重排轮按意图迁移）
//
// 这一轮把菜单从「两层工作台」改成稳智同款「一级平铺」（用户 2026-09-22 指示：菜单照对方做，
// 不要散开的一个一个）。改动的是形状，四条原意图一条不丢：
// ① 登记表漏页/重页 ⇒ 页面从入口消失或一处两归——继续从 types.ts 现读 PageKey 全集对账；
// ② 旧 hash 路由保留、legacy 页进来挂横幅不白屏；
// ③ AppShell 渲染分支一个不删；
// ④ 不为导航引入新依赖。
// R3a 口径迁移逐条注明：workbench 四按钮清单 → MENU 一级顺序钉；hasShellLeftRail（壳层画两栏）
// → 反向钉「壳层不再画第二层列表」（入口唯一出处 = Sidebar 一棵树）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MENU, SYSTEM_ITEMS, entryTarget, isLegacyPage, legacyReturnTarget, menuGroupOf,
} from "../../src/lib/desk/nav-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// PageKey 全集从 types.ts 现读：以后有人加页面但没登记 nav-core，这里直接红，而不是运行时白屏。
const PAGE_KEYS = (() => {
  const src = read("src/lib/desk/types.ts");
  const block = src.match(/export type PageKey =([\s\S]*?);/);
  assert.ok(block, "PageKey 结构变了：这条防漏页测试要跟着改成新形状，不能删断言");
  return [...block![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

/** 登记表摊平：每个 PageKey → 它登记的唯一出处 */
function allRegistered() {
  const listed = new Map<string, string[]>();
  const put = (k: string, where: string) => listed.set(k, [...(listed.get(k) ?? []), where]);
  for (const e of MENU) {
    if (e.key) put(e.key, `${e.id}.key`);
    for (const c of e.children ?? []) put(c.key, `${e.id}.children`);
    for (const p of e.legacyPages ?? []) put(p, `${e.id}.legacyPages`);
  }
  for (const s of SYSTEM_ITEMS) put(s.key, "SYSTEM_ITEMS");
  return listed;
}

test("nav-core：types.ts 里每个 PageKey 恰好登记一处，不重不漏（R3a 版对账）", () => {
  const listed = allRegistered();
  for (const key of PAGE_KEYS) {
    assert.deepEqual(listed.get(key) ?? [], listed.get(key) ? [listed.get(key)![0]] : [],
      `${key} 应恰好登记在一处（当前：${JSON.stringify(listed.get(key))}）：两处=归属打架，零处=从所有入口消失`);
    assert.notEqual(menuGroupOf(key as never) ?? (SYSTEM_ITEMS.some((s) => s.key === key) ? "sys" : null), null,
      `${key} 查不到归属`);
  }
});

test("nav-core：一级菜单顺序文案钉死（稳智左栏顺序，用户要的同款）", () => {
  assert.deepEqual(
    MENU.map((e) => [e.id, e.label] as const),
    [
      ["market", "大盘情绪"],
      ["quant", "量化选股"],
      ["sectors", "行业板块"],
      ["quotes", "行情"],
      ["watch", "自选"],
      ["ai", "AI 对话"],
      ["qimen", "奇门遁甲"],
    ],
    "一级项必须是大盘情绪·量化选股·行业板块·行情·自选·AI 对话·奇门遁甲 这个顺序（对方菜单从左到右即此序；「LLM分析」是行业词，人话版叫 AI 对话）",
  );
  // 「自选」在对方菜单里是独立一级，不许再塞回「行情」组里
  assert.equal(MENU.find((e) => e.id === "watch")!.key, "tracker");
  assert.ok(!MENU.find((e) => e.id === "quotes")!.children!.some((c) => c.key === "tracker"), "tracker 不许在行情组重复出现");
  // 设置/扩展只在底部系统区，不散回主菜单
  assert.deepEqual(SYSTEM_ITEMS.map((s) => s.key), ["settings", "extension"]);
  for (const k of ["settings", "extension"]) {
    assert.ok(!listed_has(k), `${k} 只能从底部系统区进，不许散回一级菜单`);
  }
  // P9 原钉原样保住（一处入口，不做两套）：奇门是一级模块，对话页内不再挂奇门 tab
  const assistantSrc = read("src/components/desk/pages/AssistantPage.tsx");
  assert.ok(!assistantSrc.includes("奇门解盘"), "对话页不再挂奇门 tab");
  assert.ok(!/deskMode/.test(assistantSrc), "deskMode 死连线已摘除");
  function listed_has(k: string) {
    const listed = allRegistered();
    return (listed.get(k)?.length ?? 0) > 1;
  }
});

test("nav-core：每个一级项要么直达、要么有非空子项；点组必有落点", () => {
  for (const e of MENU) {
    const hasKey = Boolean(e.key);
    const hasChildren = (e.children?.length ?? 0) > 0;
    assert.ok(hasKey !== hasChildren, `${e.id} 必须「直达 key」和「children」二选一（都有/都无都说明口径写错）`);
    assert.ok(typeof entryTarget(e) === "string", `${e.id} 点不出落点`);
    if (e.children) {
      const keys = new Set(e.children.map((c) => c.key));
      assert.equal(keys.size, e.children.length, `${e.id} 组内子项有重复 key`);
    }
  }
});

test("nav-core：并入对话的旧页可 hash 直达但不上菜单；copilot 自己不算 legacy", () => {
  for (const p of ["aihome", "analysis", "events", "research", "agent"] as const) {
    assert.ok(isLegacyPage(p), `${p} 应登记为 legacy（横幅指回对话）`);
    assert.equal(legacyReturnTarget(p), "copilot", `${p} 的横幅出口应回对话本体`);
    assert.equal(menuGroupOf(p)?.id, "ai", `${p} 归属 AI 对话组`);
  }
  assert.equal(isLegacyPage("copilot"), false, "copilot 是对话本体，不是兼容路由");
});

test("nav-core 是纯核：不 import React/window/存储，保证单测可直跑", () => {
  const src = read("src/lib/desk/nav-core.ts");
  for (const code of src.split("\n").filter((l) => !/^(\/\/|\*|\/\*)/.test(l.trim()))) {
    assert.doesNotMatch(code, /from "react|from "next|window\.|localStorage|zustand/, `nav-core 越界：${code.trim()}`);
  }
});

test("AppShell：每个 PageKey 的渲染分支一个不删（任务书约束：不删页面、老路由照常出内容）", () => {
  const src = read("src/components/desk/AppShell.tsx");
  for (const key of PAGE_KEYS) {
    assert.match(src, new RegExp(`page === "${key}" && <\\w+(?:Page|Panel) \\/>`), `旧路由 #/${key} 的渲染分支被删了`);
  }
  assert.match(src, /<WorkbenchShell>[\s\S]*<\/WorkbenchShell>/, "分支没有包进 WorkbenchShell：legacy 横幅不会生效");
});

test("Sidebar：主导航从 MENU 派生（唯一清单出处），源码里不再有逐页菜单", () => {
  const src = read("src/components/desk/Sidebar.tsx");
  assert.match(src, /MENU\.map/, "主导航应从 MENU 派生，而不是再抄一张列表");
  for (const key of ["agent", "quant", "pool", "settings"]) {
    assert.doesNotMatch(src, new RegExp(`key: "${key}"`), `侧栏源码里还留着逐页菜单项 ${key}：零散菜单没收干净`);
  }
  assert.match(src, /SYSTEM_ITEMS\.map/, "设置/扩展应从 nav-core 的系统登记表渲染进底部下拉");
  // R3a 新增钉：一级平铺 + 组内子项是唯一形态，不许回潮「点工作台再出第二栏」
  assert.match(src, /entryTarget\(entry\)/, "点组名要直达该组主页面（不再先切一个空工作台壳）");
  assert.match(src, /aria-label="主菜单"/, "一级菜单要有语义地标（对方左栏就是可扫读的平铺列表）");
  assert.match(src, /已连接实时行情/, "底部状态条口径不能丢（工程状态词不外露）");
});

test("WorkbenchShell：不再画第二层左栏；legacy 兼容路由挂横幅指回对话，而不是白屏或静默替换", () => {
  const src = read("src/components/desk/WorkbenchShell.tsx");
  assert.match(src, /import \{[^}]*isLegacyPage[^}]*\} from "@\/lib\/desk\/nav-core"/, "壳层应从纯核查归属");
  // R3a 口径迁移（原 hasShellLeftRail(market)===true 的反向钉）：入口唯一在 Sidebar，壳层再画列表就是第二套菜单
  assert.doesNotMatch(src, /NAV\.|LeftRail|items\.map/, "壳层不许再画第二层页面列表：菜单唯一出处是 nav-core→Sidebar");
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

test("折叠/展开用原生 useState，导航改造零新增依赖", () => {
  const touched = [
    "src/lib/desk/nav-core.ts",
    "src/components/desk/Sidebar.tsx",
    "src/components/desk/WorkbenchShell.tsx",
  ];
  for (const f of touched) {
    assert.doesNotMatch(read(f), /element-plus/, `${f} 引用了未安装的 element-plus：违反不新增依赖约束`);
  }
  assert.doesNotMatch(read("package.json"), /element-plus/, "package.json 被塞了新依赖：违反全局约束");
});
