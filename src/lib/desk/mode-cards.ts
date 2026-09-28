// P15-R20「八张卡随模式切换」——选卡规则单独成文件。
//
// 为什么不住在 suggestion-cards-core.ts：那是**卡片自身的定义**（条件槽位 + 拼句），
// 这是**按模式挑哪 8 张**——两件事。更实际的理由：这份映射是一串卡面标签字面量，
// 留在 core 里会被「扫源码找快捷问」的那条钉测（p7-intent）当成递到用户嘴边的快捷问
// 抓去分类——标签不是问句（点下去才弹条件窗），被拿去判场景必然判成 general，属于误报。
//
// 稳智那一栏推荐卡本身不随模式变（前端就是 `suggestedPrompts.slice(0,8)`，一份静态数组），
// 它的模式是下拉里单独选的。但本仓把「回答风格」做成了一等公民：选了研判模式还推
// 「判断现在能否买入」这种要动作的卡，用户点了得到的答案跟卡片承诺的不是一回事。
// 所以这里按模式分组——每组仍是 8 张，全部取自那 15 个稳智模板，不新编文案。
//
// 分组依据（照每张卡**问句原文**在问什么分，不按心情分）：
//   decision ⚡ —— 原文要「能不能买/要不要减/怎么操作」的：动作与条件
//   judge    ◈ —— 原文要「什么阶段/强弱排序/是回踩还是转弱」的：状态与结构
//   deep     🧠 —— 原文要「全面分析/多维交叉验证/每一维都列数据」的：七维那类深挖
//   search   🔎 —— 原文写死「本地没有的数据直接实时搜索 / 结合最新消息面公告 / 注明数据时间」的

// 值导入带 .ts 后缀是本仓 *-core 的既有纪律（tests/ 下用 node --test 直跑，扩展名不写全会解析不到）
import type { ChatMode } from "./modes.ts";
import { ALL_SUGGESTION_CARDS, SUGGESTION_CARDS_CORE, type SuggestionCard } from "./suggestion-cards-core.ts";

const CARDS_BY_MODE_LABEL: Record<ChatMode, string[]> = {
  decision: [
    "判断现在能否买入", "按成本制定持仓计划", "持仓先拿还是减", "制定股票交易计划",
    "回踩低吸判断", "回踩均线还能吸吗", "跌破均线怎么办", "超短轻仓试错",
  ],
  judge: [
    "对比多只股票强弱", "分析板块当前阶段", "接飞刀还是回踩", "判断今日仓位策略",
    "七维分析一只股票", "现价还能不能参与", "按成本制定持仓计划", "跌破均线怎么办",
  ],
  deep: [
    "七维分析一只股票", "对比多只股票强弱", "分析板块当前阶段", "按成本制定持仓计划",
    "判断今日仓位策略", "制定股票交易计划", "现价还能不能参与", "回踩低吸判断",
  ],
  search: [
    "筛选持续流入板块", "判断今日仓位策略", "七维分析一只股票", "对比多只股票强弱",
    "现价还能不能参与", "分析板块当前阶段", "超短轻仓试错", "制定股票交易计划",
  ],
};

/**
 * 当前模式下该展示的那 8 张。
 * 取不到（标签写错/改过名）时退回首页那 8 张——宁可展示旧的那份，也不展示一个空栏。
 *
 * 返回值把 `chatMode` 覆写成**当前模式**：稳智那张卡本来就不带模式（模式是下拉的事），
 * 本仓 card.chatMode 只是历史遗留的「点卡换风格」行为；现在卡片已经按模式筛过了，
 * 再让点卡把风格切走，等于用户刚选的研判被一张卡悄悄改成决策。
 */
export function cardsForMode(mode: ChatMode): SuggestionCard[] {
  const wanted = CARDS_BY_MODE_LABEL[mode] ?? CARDS_BY_MODE_LABEL.decision;
  const picked: SuggestionCard[] = [];
  for (const label of wanted) {
    const c = ALL_SUGGESTION_CARDS.find((x) => x.label === label);
    if (c) picked.push({ ...c, chatMode: mode });
  }
  return picked.length ? picked : SUGGESTION_CARDS_CORE.map((c) => ({ ...c, chatMode: mode }));
}
