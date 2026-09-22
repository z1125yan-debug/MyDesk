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
// - 「并入对话」的 5 个旧页（AI 首页/分析/事件/研究/Agent）继续不占菜单位，走 legacyPages + 横幅指回。
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

/** 顺序即视觉顺序（对齐稳智左栏从左到右/从上到下的排列） */
export const MENU: MenuEntry[] = [
  { id: "market", label: "大盘情绪", key: "market" },
  {
    id: "quant",
    label: "量化选股",
    children: [
      { key: "quant", label: "AI 选股 · 研究台" },
      { key: "screener", label: "因子选股 · 历史" },
      { key: "factorlab", label: "因子库 · 测试台" },
      { key: "pool", label: "候选池" },
      { key: "radar", label: "主动发现" },
      { key: "problab", label: "历史概率" },
    ],
  },
  {
    id: "sectors",
    label: "行业板块",
    children: [
      { key: "sectors", label: "行业 · 概念资金流" },
      { key: "themes", label: "主线热点" },
    ],
  },
  {
    id: "quotes",
    label: "行情",
    children: [
      { key: "allstocks", label: "全A 列表" },
      { key: "history", label: "历史行情" },
      { key: "profile", label: "个股画像" },
      { key: "risk", label: "风险监控" },
      { key: "board", label: "数据看板" },
      { key: "dashboard", label: "市场总览" },
    ],
  },
  // 对方把「自选」单列一级（第 5 位），照做——它不是行情的子集，是每天打开的那一页
  { id: "watch", label: "自选", key: "tracker" },
  { id: "ai", label: "AI 对话", key: "copilot", legacyPages: ["aihome", "analysis", "events", "research", "agent"] },
  { id: "qimen", label: "奇门遁甲", key: "qimen" },
];

/** 底部系统区（对方「订阅账号与点数」的对应位）：不散回主菜单 */
export const SYSTEM_ITEMS: MenuLeaf[] = [
  { key: "settings", label: "设置" },
  { key: "extension", label: "扩展" },
];

/**
 * 路由重定向：旧 PageKey 仍在（AppShell 分支、types.ts 枚举一个不删），但导航时收口到统一入口。
 * aiscan → quant：门户主 Tab 挂的就是 AiScanPage 本体，两者本是同一份实现，
 * 用户拍板「合并成一条」——菜单不再单列「全A 实时选股」，点它/递棒过来都落门户。
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
const { GROUP_OF, LEGACY_OF } = (() => {
  const groupOf = new Map<PageKey, string>();
  const legacyOf = new Map<PageKey, string>();
  const take = (k: PageKey, where: string) => {
    if (groupOf.has(k) || legacyOf.has(k) || SYSTEM_ITEMS.some((s) => s.key === k)) {
      throw new Error(`nav-core 口径冲突：${k} 在「${where}」重复登记`);
    }
  };
  for (const e of MENU) {
    if (e.key) {
      take(e.key, `${e.id}.key`);
      groupOf.set(e.key, e.id);
    }
    for (const c of e.children ?? []) {
      take(c.key, `${e.id}.children`);
      groupOf.set(c.key, e.id);
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
  return { GROUP_OF: groupOf, LEGACY_OF: legacyOf };
})();

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
