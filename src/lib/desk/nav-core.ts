// P15-R3a 导航纯核：对齐稳智左侧菜单——单层一级平铺，不再有两层工作台。
//
// 口径来源（《稳智AI-全板块数据与UI逆向》§〇 + 用户 2026-09-22 指示「参考对方的源代码去做」）：
// 对方菜单就是一级列表：大盘情绪 · 量化因子选股 · 行业 · 行情 · 自选 · LLM分析 · 奇门遁甲 · 账号。
// 我们 26 个页面塞不进 7 个裸链接，归组方式按「血缘」：一个一级项 = 一件事，
// 点开直接进主页面；血缘近的次级页面挂在该项下面（唯一的两层例外，见「为什么留子项」）。
//
// 纪律与仓库其它 core 层一致：这里只有数据与查表函数——不 import React、不碰 window、不读档。
//
// 兼容口径（P7-⑪ 原意图逐字保住）：
// - PageKey 一个不删、不改名：`#/agent` 这类旧 hash 全部照常能进（AppShell 分支钉在测试里）；
// - 「并入对话」的 4 个旧页（AI 首页/分析/研究/Agent）继续不占菜单位，走 legacyPages + 横幅指回；
//   「全球事件雷达」P15-R18 按用户指示挖回一级菜单（它每天要读，不是一页归档兼容路由）。
//
// 为什么留子项：对方「量化因子选股」一级页内部也是选股器/因子/池多块并列；
// 我们把它们提成指端子项是为了「点了就到、不玩两栏捉迷藏」，而不是再造一层工作台。
//
// R3c 双入口裁决（用户拍板「合并成一条」）：quant 门户主入口与 aiscan 是两个窗口同一套内容
// （P13 收敛的既成事实）——菜单删「全A 实时选股」子项，aiscan 降级为路由别名：
// 旧 hash、板块页递棒 go("aiscan") 一律收口到 quant 门户主 Tab（那里挂的就是 AiScanPage 本体），
// 内容从此只有一条通路，但 PageKey、渲染分支、P12 递棒钉全部原样活着。
import type { PageKey } from "./types";

export interface MenuLeaf {
  key: PageKey;
  label: string;
}

export interface MenuEntry {
  /** 组的唯一标识：Sidebar 展开态、测试钉顺序都用它 */
  id: string;
  /** 一级菜单文案（稳智文案体系的人话版：「LLM分析」这种行业词不照抄） */
  label: string;
  /** 单项直达（对方「大盘情绪」这种一项一页） */
  key?: PageKey;
  /** 血缘子项：组内第 1 项就是点父项的默认落点 */
  children?: MenuLeaf[];
  /** 已并入本项但不再占菜单位的旧页：仅 hash 可达 + 壳层横幅指回 */
  legacyPages?: PageKey[];
}

/** 顺序即视觉顺序（2026-09-29 起：…自选→事件雷达→LLM分析→板块风险→AI分析；「奇门遁甲」按用户指示撤出一级，位子给「板块风险」） */
export const MENU: MenuEntry[] = [
  { id: "market", label: "大盘情绪", key: "market" },
  {
    // S3 稳智复刻：量化选股收敛为单一工作台（条件卡组+筛选+AI 优选+策略）；旧研究台/因子库等仍可 hash 直达
    id: "quant",
    label: "量化因子选股",
    key: "aiscreener",
    legacyPages: ["quant", "screener", "factorlab", "pool", "radar", "problab"],
  },
  // 2026-09-28：行业组挂「行业板块排行」(默认落点) 与「板块风险」(见顶预警扫描器 + 回撤性质识别器)。
  // 2026-09-29 用户拍板：「板块风险」升一级顶替「奇门遁甲」的菜单位（原话：删了换成见顶），
  // 「行业」还原成单项直达；#qimen 页本体保留（HIDDEN_PAGES 登记，hash 直达 + 智能助手页奇门解盘模式仍在）。
  { id: "sectors", label: "行业", key: "sectors" },
  {
    id: "quotes",
    label: "行情",
    children: [
      // 2026-09-29 用户拍板行情子菜单顺序：全A 列表 → 数据看板 → 风险监控 → 个股行情 → 个股画像 → 历史行情。
      // 默认落点即 children[0] = 全A 列表（点「行情」进此页）。
      { key: "allstocks", label: "全A 列表" },
      { key: "board", label: "数据看板" },
      { key: "risk", label: "风险监控" },
      { key: "quotes", label: "个股行情" },
      { key: "profile", label: "个股画像" },
      { key: "history", label: "历史行情" },
    ],
  },
  // 对方把「自选」单列一级（第 5 位），照做——它不是行情的子集，是每天打开的那一页
  { id: "watch", label: "自选", key: "tracker" },
  // P15-R18 全球事件雷达：本地特色（稳智无对位），保留在自选和 LLM 分析之间——每天要读的一级页。
  { id: "events", label: "事件雷达", key: "events" },
  // P26 稳智对齐：稳智顺序是「自选 → LLM分析 → 奇门遁甲 → 稳智AI」。
  // LLM 分析不是纯 AI 对话，是带顶部 5 Tab 的门户工作台（LlmAnalysisPage）。
  // legacyPages 保留——旧的 #/analysis / #/research / #/agent 三个 hash 依然可达（AppShell 分支不删）。
  { id: "assistant", label: "LLM分析", key: "llmportal", legacyPages: ["analysis", "research", "agent"] },
  // 2026-09-29 用户拍板：奇门遁甲撤出一级菜单，「板块风险」（见顶预警 v1）顶替其位——
  // 这是本地判顶系统的唯一一级入口。
  { id: "sectortop", label: "板块风险", key: "sectortop" },
  // 稳智左栏倒数第 2 位是「稳智AI」——本地改叫「AI分析」（2026-09-25 用户拍板）。
  { id: "ai", label: "AI分析", key: "aihome" },
];

/** 底部系统区（对方「订阅账号与点数」的对应位）：不散回主菜单 */
export const SYSTEM_ITEMS: MenuLeaf[] = [
  { key: "settings", label: "设置" },
  { key: "extension", label: "扩展" },
];

/**
 * 从菜单移除、只留 hash 直达的页（2026-09-25 用户拍板）：
 * 稳智把「主题热点」放在 LLM分析（/settings）的 Tab 里，不是独立菜单项——本地这两页也从菜单拿掉，
 * 页面本体不删，靠 #/themes、#/themeoverview 直达。group 只用于「进来时高亮哪一组」；不画菜单、不挂横幅。
 */
export const HIDDEN_PAGES: { key: PageKey; group: string }[] = [
  { key: "themes", group: "assistant" },
  { key: "themeoverview", group: "assistant" },
  // 2026-09-25：用户要求把「行情」组下的「市场总览」从菜单删掉——页面本体不删，仍可 #/dashboard 直达
  { key: "dashboard", group: "quotes" },
  // 2026-09-29 用户拍板：奇门遁甲撤出一级菜单（位子让给「板块风险」）——页面本体与 API 保留，
  // #/qimen 直达仍进 QimenPanel，智能助手页的「奇门解盘」模式也不受影响；高亮归对话血缘组。
  { key: "qimen", group: "assistant" },
  // 2026-09-26 用户实测修正：对话本体（copilot / AssistantPage）**不占菜单位**（「AI分析」一级项落的是落地页 aihome），
  // 但它是 AI分析 这条血缘线上的页——登记在此只为「在哪一组高亮 + 登记一处不重不漏」，
  // 不是 legacy（进来不挂横幅），也不再被任何重定向劫持（见下面 ROUTE_REDIRECTS 的改动说明）。
  { key: "copilot", group: "ai" },
];

/**
 * 路由重定向：旧 PageKey 仍在（AppShell 分支、types.ts 枚举一个不删），但导航时收口到统一入口。
 * aiscan → quant：门户主 Tab 挂的就是 AiScanPage 本体，两者本是同一份实现，
 * 用户拍板「合并成一条」——菜单不再单列「全A 实时选股」，点它/递棒过来都落门户。
 *
 * ⚠️ 2026-09-26 用户实测修正：**删除** `copilot → llmportal` 这条重定向。
 * 它当初的理由是「LLM 分析门户的第 5 个 Tab 就是 AI 对话」，但门户（LlmAnalysisPage）的 5 个 Tab
 * 是 主题热点/研究池/板块全景看板/个股评估矩阵/产业链研报分析——**根本没有 AI 对话 Tab**。
 * 后果：落地页发送（askInAssistant→copilot）、最近会话、概览卡、小窗「在助手页继续」四条路
 * 全被弹到「LLM分析」，而唯一消费 pendingAsk 的 AssistantPage 永远不挂载 ⇒ **那句话被静默吞掉**。
 * 现在 copilot 就是对话本体，直达；「点哪个菜单就是哪个菜单」。
 */
export const ROUTE_REDIRECTS: Partial<Record<PageKey, PageKey>> = {
  aiscan: "quant",
};

/** 导航前解析：有重定向就换目标，没有原样返回（store.go 统一过一遍，收口在一处） */
export function resolveRoute(p: PageKey): PageKey {
  return ROUTE_REDIRECTS[p] ?? p;
}

/** 一级项的默认落点：单项直达用 key；有子项的落第 1 个子项（点组名 = 进该组的主页） */
export function entryTarget(entry: MenuEntry): PageKey {
  if (entry.key) return entry.key;
  const first = entry.children?.[0];
  if (!first) throw new Error(`nav-core 口径错误：${entry.id} 既无 key 也无 children`);
  return first.key;
}

// 反查表在模块加载时一次性建成：漏页/重页当场 throw，不留到运行时白屏。
const { GROUP_OF, LEGACY_OF, MENU_VISIBLE } = (() => {
  const groupOf = new Map<PageKey, string>();
  const legacyOf = new Map<PageKey, string>();
  // 只收「菜单上真画得出来」的页（一级 key + 子项）。legacy/hidden/重定向源**不进**：
  // 它们只是可达（hash 直达 / 旧链接），菜单里没有入口，不该被当成「上次打开的页」恢复。
  const visible = new Set<PageKey>();
  const take = (k: PageKey, where: string) => {
    if (groupOf.has(k) || legacyOf.has(k) || SYSTEM_ITEMS.some((s) => s.key === k)) {
      throw new Error(`nav-core 口径冲突：${k} 在「${where}」重复登记`);
    }
  };
  for (const e of MENU) {
    if (e.key) {
      take(e.key, `${e.id}.key`);
      groupOf.set(e.key, e.id);
      visible.add(e.key);
    }
    for (const c of e.children ?? []) {
      take(c.key, `${e.id}.children`);
      groupOf.set(c.key, e.id);
      visible.add(c.key);
    }
    for (const p of e.legacyPages ?? []) {
      take(p, `${e.id}.legacyPages`);
      legacyOf.set(p, e.id);
    }
  }
  // 重定向源也算「登记一处」：不给菜单位，但归组可查（刷新到旧 hash 的瞬间高亮不闪丢）、
  // 目标必须是已登记的真实入口——防止有人重定向到一个已经不存在/漏登记的页。
  for (const [from, to] of Object.entries(ROUTE_REDIRECTS) as [PageKey, PageKey][]) {
    take(from, "ROUTE_REDIRECTS");
    const targetGroup = groupOf.get(to) ?? legacyOf.get(to);
    if (!targetGroup) throw new Error(`nav-core 口径错误：${from} 重定向到未登记的 ${to}`);
    groupOf.set(from, targetGroup);
  }
  // 隐藏页：登记一处（防漏页对账），归属给指定组做高亮；不画菜单、不挂横幅。
  for (const h of HIDDEN_PAGES) {
    take(h.key, "HIDDEN_PAGES");
    if (!MENU.some((e) => e.id === h.group)) throw new Error(`nav-core 口径错误：HIDDEN_PAGES 的 ${h.key} 归属组 ${h.group} 不存在`);
    groupOf.set(h.key, h.group);
  }
  return { GROUP_OF: groupOf, LEGACY_OF: legacyOf, MENU_VISIBLE: visible };
})();

/**
 * 该页在菜单上是否可见（画得出来）。
 *
 * 为什么需要它：2026-09-29 事故——奇门遁甲按用户指示从一级菜单撤下后，冷启动**打开的一瞬间
 * 仍会闪出奇门页**。根因：store 把「上次打开的页」落盘，恢复时只按 PAGE_TITLES 校页名合法性，
 * 而 qimen 为了保留 `#/qimen` 直达仍留在 PAGE_TITLES 里 ⇒ 存档值 "qimen" 通过校验 ⇒ 被恢复出来。
 * 菜单上都没有的页，不该被当成「上次停在哪」恢复——那等于给用户看一个他自己删掉的入口。
 * 注意：这只约束**冷启动恢复**；hash 直达（`#/qimen`）走 AppShell 的 hash 同步，不受影响。
 */
export function isMenuVisible(page: PageKey): boolean {
  return MENU_VISIBLE.has(page);
}

/** 页面属于哪个一级菜单组（legacy 页也算组，供高亮）；系统项返回 null */
export function menuGroupOf(page: PageKey): MenuEntry | null {
  const id = GROUP_OF.get(page) ?? LEGACY_OF.get(page);
  return MENU.find((e) => e.id === id) ?? null;
}

/** 该页面是否只是旧路由兼容（不在菜单里，壳层据此挂横幅） */
export function isLegacyPage(page: PageKey): boolean {
  return LEGACY_OF.has(page);
}

/** legacy 页横幅要指回的落点（都在对话组 → copilot） */
export function legacyReturnTarget(page: PageKey): PageKey | null {
  const id = LEGACY_OF.get(page);
  if (!id) return null;
  const entry = MENU.find((e) => e.id === id)!;
  return entry.key ?? entryTarget(entry);
}
