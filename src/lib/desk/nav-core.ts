// P7-⑪ 任务1（UI 重构）导航纯核：25 个零散菜单 → 3 大工作台 + 系统入口的映射表。
//
// 纪律与仓库其它 core 层一致：这里只有数据与查表函数——不 import React、不碰 window、不读档，
// 所以单测可以直接跑，AppShell/Sidebar/WorkbenchShell 三个消费方永远不会各说各话。
//
// 兼容口径（任务书约束 1.1/1.2）：
// - PageKey 一个不删、不改名：hash 路由 `#/agent` 这类旧链接全部照常能进；
// - 「并入对话」的页面（AI 首页 / AI 分析 / 事件雷达 / AI 市场研究 / Agent 自主研究）
//   不再出现在任何左栏列表里（legacyPages 登记在案），但渲染分支保留，进旧路由时壳层会挂
//   「已并入对话」横幅指回，而不是让读者对着一个消失的页面猜。
import type { PageKey } from "./types";

export type Workbench = "ai" | "quant" | "market" | "system";

export interface NavItem {
  key: PageKey;
  label: string;
}

/** 顶部分组小标签：点它 = 选中对应的列表项（不引入第二套状态，跳的就是 go(key)） */
export interface NavGroupTab {
  title: string;
  target: PageKey;
}

export interface WorkbenchNav {
  title: string;
  /** 左窄栏顶部的分组标签行；AI 决策的左栏由 AssistantPage 自带（模式切换 + 会话历史），这里留空 */
  groups: NavGroupTab[];
  /** 左窄栏列表项，点哪项右栏渲染哪个既有页面组件 */
  items: NavItem[];
  /** 已并入本工作台但不再占列表位的旧页面：仅保留 hash 可达 + 横幅指回 */
  legacyPages: PageKey[];
}

export const WORKBENCH_ORDER: { key: Workbench; label: string }[] = [
  { key: "ai", label: "AI 决策" },
  { key: "quant", label: "量化工具" },
  { key: "market", label: "行情中心" },
];

export const NAV: Record<Workbench, WorkbenchNav> = {
  ai: {
    title: "AI 决策工作台",
    groups: [],
    items: [{ key: "copilot", label: "对话分析 / 奇门解盘" }],
    legacyPages: ["aihome", "analysis", "events", "research", "agent"],
  },
  quant: {
    title: "量化工具工作台",
    groups: [
      { title: "因子库", target: "factorlab" },
      { title: "我的策略", target: "quant" },
      { title: "选股历史", target: "screener" },
      { title: "候选池", target: "pool" },
    ],
    items: [
      { key: "factorlab", label: "因子库 · 测试台" },
      { key: "quant", label: "我的策略 · 量化研究" },
      { key: "screener", label: "选股历史 · 因子选股器" },
      { key: "pool", label: "候选池" },
      { key: "aiscan", label: "AI 实时选股" },
      { key: "problab", label: "历史概率" },
      { key: "radar", label: "主动发现" },
    ],
    legacyPages: [],
  },
  market: {
    title: "行情中心工作台",
    groups: [
      { title: "大盘情绪", target: "market" },
      { title: "行业板块", target: "sectors" },
      { title: "主线热点", target: "themes" },
      { title: "自选股", target: "tracker" },
      { title: "全A列表", target: "allstocks" },
      { title: "风险监控", target: "risk" },
    ],
    items: [
      { key: "market", label: "大盘情绪" },
      { key: "sectors", label: "行业板块" },
      { key: "themes", label: "主线热点" },
      { key: "tracker", label: "自选股" },
      { key: "allstocks", label: "全A列表" },
      { key: "risk", label: "风险监控" },
      { key: "dashboard", label: "总览" },
      { key: "board", label: "数据看板" },
      { key: "profile", label: "个股画像" },
      { key: "history", label: "历史行情" },
    ],
    legacyPages: [],
  },
  system: {
    title: "系统",
    groups: [],
    items: [
      { key: "settings", label: "设置" },
      { key: "extension", label: "扩展" },
    ],
    legacyPages: [],
  },
};

/** 每个 PageKey 恰好落进一个工作台：主项（items）优先，其余按 legacyPages 归位 */
const WORKBENCH_OF_PAGE = (() => {
  const map = new Map<PageKey, Workbench>();
  for (const wb of Object.keys(NAV) as Workbench[]) {
    for (const it of NAV[wb].items) map.set(it.key, wb);
  }
  // legacy 归属单独登记；键冲突直接让它撞出来——两张表都登记同一个键说明口径写错了
  for (const wb of Object.keys(NAV) as Workbench[]) {
    for (const p of NAV[wb].legacyPages) {
      if (map.has(p)) throw new Error(`nav-core 口径冲突：${p} 既是列表项又是 legacy 页`);
      map.set(p, wb);
    }
  }
  return map;
})();

export function workbenchOf(page: PageKey): Workbench | null {
  return WORKBENCH_OF_PAGE.get(page) ?? null;
}

/** 该页面是否只是旧路由兼容（不在左栏列表里）——壳层据此决定挂不挂「已并入」横幅 */
export function isLegacyPage(page: PageKey): boolean {
  const wb = workbenchOf(page);
  return wb !== null && NAV[wb].legacyPages.includes(page);
}

/** 左窄栏是否由工作台壳层渲染（AI 决策的左栏长在 AssistantPage 里，壳层不重复画） */
export function hasShellLeftRail(page: PageKey): boolean {
  const wb = workbenchOf(page);
  return wb !== null && wb !== "ai" && !isLegacyPage(page);
}
