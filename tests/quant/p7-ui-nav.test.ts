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
  MENU, SYSTEM_ITEMS, ROUTE_REDIRECTS, resolveRoute, entryTarget, isLegacyPage, legacyReturnTarget, menuGroupOf, HIDDEN_PAGES,
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
  // 2026-09-25：从菜单移除、只留 hash 直达的页（themes/themeoverview）也算「登记一处」
  for (const h of HIDDEN_PAGES) put(h.key, "HIDDEN_PAGES");
  // R3c：合并后 aiscan 从 children 挪进 ROUTE_REDIRECTS——别名源也算「登记一处」（漏页防线不放松）
  for (const from of Object.keys(ROUTE_REDIRECTS)) put(from, "ROUTE_REDIRECTS");
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
      ["quant", "量化因子选股"],
      ["sectors", "行业"],
      ["quotes", "行情"],
      ["watch", "自选"],
      ["events", "事件雷达"],
      // P25 稳智对齐 P1 #3：LLM 分析（深度分析）和 AI 对话（快速问答）拆成两个一级项
      ["assistant", "LLM分析"],
      // 2026-09-29 用户拍板：奇门遁甲撤出一级菜单（页本体保留），「板块风险」（见顶预警）顶替其位
      ["sectortop", "板块风险"],
      ["ai", "AI分析"],
    ],
    "一级项顺序=大盘情绪·量化因子选股·行业·行情·自选·事件雷达·LLM分析·板块风险·AI分析（2026-09-29 起「板块风险」顶替「奇门遁甲」位；事件雷达是本地特色项 P15-R18）",
  );
  // 「自选」在对方菜单里是独立一级，不许再塞回「行情」组里
  assert.equal(MENU.find((e) => e.id === "watch")!.key, "tracker");
  assert.ok(!MENU.find((e) => e.id === "quotes")!.children!.some((c) => c.key === "tracker"), "tracker 不许在行情组重复出现");
  // 设置/扩展只在底部系统区，不散回主菜单
  assert.deepEqual(SYSTEM_ITEMS.map((s) => s.key), ["settings", "extension"]);
  for (const k of ["settings", "extension"]) {
    assert.ok(!listed_has(k), `${k} 只能从底部系统区进，不许散回一级菜单`);
  }
  // P9 原钉原样保住（一处入口，不做两套）：奇门解盘不在对话页挂 tab（菜单位 2026-09-29 已让给「板块风险」，页本体 #/qimen 保留）
  const assistantSrc = read("src/components/desk/pages/AssistantPage.tsx");
  assert.ok(!assistantSrc.includes("奇门解盘"), "对话页不再挂奇门 tab");
  assert.ok(!/deskMode/.test(assistantSrc), "deskMode 死连线已摘除");
  // 2026-09-29：qimen 从菜单撤下后必须登记在 HIDDEN_PAGES（防漏页对账），页本体不许删
  assert.ok(HIDDEN_PAGES.some((h) => h.key === "qimen"), "qimen 撤出菜单后要登记 HIDDEN_PAGES（#/qimen 直达保留）");
  function listed_has(k: string) {
    const listed = allRegistered();
    return (listed.get(k)?.length ?? 0) > 1;
  }
});

test("nav-core：每个一级项要么直达、要么有非空子项；点组必有落点", () => {  for (const e of MENU) {
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
  // P25 稳智对齐：aihome 不再在 legacyPages 里（现在是一级菜单项「AI 对话」）
  // P26：analysis/research/agent 仍在 legacyPages 里（横幅指回 LLM 分析门户）
  for (const p of ["analysis", "research", "agent"] as const) {
    assert.ok(isLegacyPage(p), `${p} 应登记为 legacy（横幅指回 LLM 分析）`);
    assert.equal(legacyReturnTarget(p), "llmportal", `${p} 的横幅出口应回 LLM 分析门户`);
    assert.equal(menuGroupOf(p)?.id, "assistant", `${p} 归属 LLM 分析组`);
  }
  // P25：aihome 不再是被横幅指回的旧页（现在是一级菜单项「AI 对话」）
  assert.equal(isLegacyPage("aihome"), false, "aihome 不再是被横幅指回的旧页（P25 稳智对齐：AI 对话是一级菜单项）");
  assert.equal(isLegacyPage("copilot"), false, "copilot 是对话本体，不是兼容路由");
});

test("2026-09-26 用户实测修正：copilot 直达（不再收口到 llmportal）+ page 落盘（重开停在上次那页）", () => {
  // 事故复盘：`copilot→llmportal` 把四条路全弹到「LLM分析」——落地页发送（askInAssistant→copilot）、
  // 最近会话、概览卡「智能助手」、小窗「在助手页继续」；而门户 5 Tab 里**没有 AI 对话**，
  // 唯一消费 pendingAsk 的 AssistantPage 永不挂载 ⇒ 那句话被静默吞掉。用户原话「我在ai想发送的时候直接给我跳到llm了」。
  assert.equal(resolveRoute("copilot"), "copilot", "copilot 必须直达对话本体（不许再收口到 llmportal）");
  assert.equal(menuGroupOf("copilot")!.id, "ai", "对话本体归属 AI分析 组（进来时那一项要高亮）");
  assert.equal(isLegacyPage("copilot"), false, "对话本体不是兼容路由，不挂横幅");
  // 「门户第 5 个 Tab 就是 AI 对话」这条理由不成立——源码实证门户 Tab 清单里没有它
  const tabs = read("src/components/desk/LlmAnalysisPage.tsx").match(/const TABS = \[([^\]]*)\]/);
  assert.ok(tabs, "LlmAnalysisPage 的 TABS 清单要能被读到（这条钉要跟着页面改）");
  assert.ok(!/对话/.test(tabs![1]), `门户 Tab 里没有「AI 对话」（当前：${tabs![1]}），所以 copilot 不能收口到它`);
  // store：page 落盘（重开停在原页）+ 白名单（坏值收敛回 market，避免 AppShell 一个分支都不匹配的白屏）
  const store = read("src/lib/desk/store.ts");
  assert.match(store, /page: \(PAGE_TITLES as Record<string, string \| undefined>\)\[s\.page\]/,
    "partialize 要落盘 page，并按 PAGE_TITLES 校页名合法性");
  // 2026-09-29 补：光校页名不够——奇门撤下菜单后 qimen 仍留在 PAGE_TITLES（为保留 #/qimen 直达），
  // 旧存档的 "qimen" 照样通过白名单 ⇒ 冷启动闪出用户已删的页面。故再加「菜单可见」校验。
  assert.match(store, /isMenuVisible\(s\.page\)/, "page 恢复还要过「菜单可见」校验：菜单上没有的页不许被恢复");
  assert.match(store, /: "market"/, "页名非法或菜单上已不可见的存档值，一律收敛回 market");
  assert.match(store, /import \{ PAGE_TITLES \} from "\.\/types"/, "白名单来自 types.ts，不另抄一份");
});

test("P15-R18：全球事件雷达从 legacy 挖回一级菜单（用户：找出来塞进去）", () => {
  assert.equal(isLegacyPage("events"), false, "events 不再是被横幅指回的旧页");
  const entry = MENU.find((e) => e.id === "events");
  assert.ok(entry, "菜单里必须有一级项「全球事件雷达」");
  assert.equal(entry!.key, "events", "一级项直达 events 页，不藏子项");
  assert.equal(menuGroupOf("events")?.id, "events", "自己的页归自己的组（高亮不落到对话上）");
  // #/events 这条老 hash 一个不删：从 legacy 提回一级后仍要能进同一页（AppShell 分支未动）
  const shell = read("src/components/desk/AppShell.tsx");
  assert.match(shell, /case "events"|events[^\n]*EventsPage/, "events 的渲染分支必须还在");
});

test("R3c 双入口合并：菜单不再单列「全A 实时选股」，aiscan 收口到 quant 门户主 Tab", () => {
  // 用户拍板「合并成一条」：quant 门户主 Tab 挂的就是 AiScanPage 本体，两个窗口同一份实现——
  // 菜单删重复子项、导航收口到统一入口，但 PageKey/渲染分支/P12 递棒钉一个不删。
  const quantEntry = MENU.find((e) => e.id === "quant")!;
  // 2026-09-25：quant 恢复为单项直达（无子项），children 可能为空——用 ?? [] 兜住，断言意图不变。
  assert.ok(!(quantEntry.children ?? []).some((c) => c.key === "aiscan"),
    "「全A 实时选股」不许再作为独立子项挂在菜单里（否则合并白做）");
  // 旧 key 走重定向到 quant
  assert.equal(resolveRoute("aiscan"), "quant", "aiscan 导航应收口到 quant 门户");
  assert.equal(resolveRoute("screener"), "screener", "未登记重定向的页原样返回");
  assert.equal(menuGroupOf("aiscan")!.id, "quant", "别名页归属仍查得到（刷新到旧 hash 高亮不闪丢）");
  assert.equal(isLegacyPage("aiscan"), false, "aiscan 不是 legacy 横幅页，是被合并的门户主页");
  // store.go 统一过一遍重定向——收口在这一处，页面侧调用方（含 P12 递棒 go("aiscan")）不用改
  const store = read("src/lib/desk/store.ts");
  assert.match(store, /page:\s*resolveRoute\(p\)/, "store.go 必须过 resolveRoute，否则合并只在菜单、导航仍分两条");
  // 2026-09-29：store 还要用 nav-core 的 isMenuVisible（冷启动恢复页时校菜单可见），
  // 故不钉死 import 列表，只钉「resolveRoute 来自 nav-core 纯核」这个意图。
  assert.match(store, /import \{[^}]*resolveRoute[^}]*\} from "\.\/nav-core"/, "重定向表来自 nav-core 纯核，store 只接线");
  // QuantPage 门户主 Tab 仍挂 AiScanPage 本体（合并的落点必须真有其页）
  assert.match(read("src/components/desk/QuantPage.tsx"), /value="portal"[\s\S]*<AiScanPage \/>/);
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
    // 原正则只认以 Page/Panel 结尾的组件名，aiscreener 渲染的是 <ScreenerWorkbench /> 会被误判成「分支被删」。
    // 本钉的意图是「分支一个不删」，认任意大写开头的自闭合组件即可（ScreenerWorkbench 也算）。
    assert.match(src, new RegExp(`page === "${key}" && <[A-Z]\\w*\\s*\\/>`), `旧路由 #/${key} 的渲染分支被删了`);
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
  // P26：默认页从 copilot 迁到 llmportal 门户（对齐稳智顶部 5 Tab 工作台）
  assert.match(src, /page:\s*"(copilot|llmportal)"/, "初始页应是 copilot 或 llmportal");
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

test("AppShell：rehydrate 完成前不渲染、不写 hash（防「先显示大盘情绪、再自动跳到别的菜单」）", () => {
  const src = read("src/components/desk/AppShell.tsx");
  // 2026-09-26 用户实测：刷新时先闪出初始页（market），随后被 persist 恢复出的存档页覆盖 ⇒ 看着像"自动跳菜单"。
  // 钉死修法：读 persist 的 hydrate 状态 → 未完成前两个 effect 直接 return → 内容也不渲染。
  assert.match(src, /const p = useDesk\.persist;/, "要读 persist 的 hydrate 状态");
  assert.match(src, /p\.hasHydrated\(\)/, "已 hydrate 时立即放行");
  assert.match(src, /p\.onFinishHydration\(\(\) => setHydrated\(true\)\)/, "未 hydrate 时监听 rehydrate 完成");
  assert.match(src, /if \(!hydrated\) return null;/, "rehydrate 完成前不渲染内容（首帧不闪出初始页）");
  assert.match(src, /if \(!hydrated\) return;\r?\n    const syncFromHash/, "hash 同步 effect 必须等 hydrate 之后再跑");
  assert.match(src, /\}, \[go, hydrated\]\);/, "hash effect 依赖 hydrated");
  assert.match(src, /\}, \[page, go, hydrated\]\);/, "自愈 effect 依赖 hydrated");
});

