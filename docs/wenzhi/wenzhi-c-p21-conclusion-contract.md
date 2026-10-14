# P21 结论契约（稳智对齐 P1 #8）

## 起因与口径

按 `wenzhi-deep-comparison.md` P1 #8「结论契约：markdown 用固定前缀，前端识别切卡片」推进。稳智的秘密是「结构化模板 + 前端强识别」：LLM 用固定前缀输出，前端 splitBlocks 强识别成卡片。

四条硬口径钉死：

1. **四类固定前缀**：`### 🎯 核心判断` / `### 🧭 执行计划` / `### 🔍 关注清单` / `### 🛑 失效条件`
2. **契约排最前**：新 4 类 kind 排在通用 9 类之前，避免"失效条件"被 risk 抢走、"操作计划"被 action 抢走
3. **提示词侧同步**：`MODE_NOTES.decision` 注入这套前缀规范（LLM 不看不写，前端识别不到）
4. **可选追加**：资金面/技术面/备注 三类继续用原有 emoji 卡（📊/📈/📌）

## 落点

- `src/lib/desk/markdown-sections-core.ts`：
  - `SectionKind` 加 4 个 kind：`conclusion` / `watchlist` / `invalidation` / `plan`
  - `SECTION_DEFS` 加 4 条定义（emoji 🎯/🔍/🛑/🧭 + words 短语 + emoji 前缀双重命中）
  - **重排优先级**：4 类新契约排在 risk/action 前面
  - risk 里移除"失效"（避免抢走 invalidation 命中）
  - action 里移除"操作"和"执行"（避免抢走 plan 命中），emoji 换成 📊
  - fundamental emoji 从 📊 换成 📉（📊 让给 action）
- `src/lib/desk/modes.ts`：`MODE_NOTES.decision` 注入 5 条提示（严格用这套前缀 + 每类的语义 + 没有内容省略）
- `src/components/desk/Markdown.tsx`：**不改**——`SectionCard` 通过 `SECTION_EMOJI[block.section]` 自动匹配，新 kind 天然生效
- `tests/quant/p15-wz-expression.test.ts`：更新测试①（增加 4 类命中）+ 测试⑦（13 类 + 顺序钉）
- `tests/quant/p21-conclusion-contract.test.ts`：10 条新钉

## 关键决定

- **契约排最前**：`SECTION_DEFS` 顺序即优先级，契约前缀短语（"核心判断"/"失效条件"/"执行计划"/"关注清单"）比通用关键词（"风险"/"操作"）更长更精确，放前面抢走命中。
- **risk 去"失效"**：契约里 `invalidation` 已包含"失效条件/失效信号/失效场景"，risk 里的裸词"失效"是冗余且会抢走精确匹配。
- **plan vs action**：`plan` 用"执行计划/操作计划/入场计划/执行清单"（结构化动作），`action` 保留"仓位/买点/卖点/策略"（更具体的数值操作）。
- **judge/deep/search 不注入契约**：契约只在 decision 模式生效，避免污染其他模式的自由表达。
- **前端不硬编码**：Markdown.tsx 走 `SECTION_EMOJI[block.section]` 动态取 emoji，新 kind 加进 SECTION_DEFS/SECTION_EMOJI 就自动渲染成卡。

## 验收

- **tsc**：`tsc --noEmit` 0 错误
- **next build**：通过
- **新增测试**：`p21-conclusion-contract.test.ts` 10/10 全绿
- **回归测试**：`p15-wz-expression.test.ts` 7/7 全绿（原 5 类测试保留 + 2 类更新）
- **全量回归**：1155/1155 pass（0 fail，9 skipped 存量环境问题）

## 未收口边界

- 契约只覆盖 decision 模式；judge/deep/search 模式仍是自由表达（避免污染其他模式）
- LLM 不严格遵守契约时（比如用了不同 emoji 或不同措辞），仍会命中通用关键词分类（降级但不失败）
- 4 类契约没有独立的 UI 组件（复用 SectionCard 通用卡样式），如需专用样式可后续再加
- P19-① 决策 widget 已把 11 字段直接抽取成结构化卡，若 LLM 输出了"【决策】..."前缀会走 widget 而非契约卡（两条链路按优先级互斥）

## 一句话

decision 模式现在走「固定前缀契约 + 前端强识别」的双向对齐：LLM 提示词侧要求 5 类前缀，前端分类器按硬前缀命中，命中就切卡；不严格命中就降级走通用分类。稳智对齐 P1 #8 落地。
