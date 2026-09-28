# P28 交易周期 3→5 档（稳智对齐 P2 #11）

## 对齐目标

稳智逆向扒出的交易周期是 5 档：ultra_short / short_term / short_mid_term / mid_term / long_term。本仓库原来是 3 档（short/mid/long），P28 扩到 5 档（ultrashort/short/shortmid/mid/long）。

稳智还有 `resolveTradingHorizonForInput` 自动检测函数，用正则匹配用户输入（"超短"/"1天"/"短线"/"波段"/"中长期"等关键词），命中直接进 payload，未命中返回 null。P28 也加了同一逻辑。

## 交易周期 5 档定义

| 档位 | 天数范围 | 典型策略 | 英文 key |
|------|----------|----------|----------|
| 超短 | 1 天以内（日内/隔夜） | 打板、T+0、尾盘套利 | ultrashort |
| 短线 | 1-3 天 | 短线突破、事件驱动 | short |
| 短中 | 3-5 天 | 波段操作、技术面突破 | shortmid |
| 中线 | 5-20 天（1-4 周） | 趋势跟踪、基本面共振 | mid |
| 长线 | 20 天以上（1 个月+） | 价值投资、主题布局 | long |

## 改动分两块

### 1. `src/lib/desk/modes.ts`

- `ChatHorizon` 类型从 3 个扩到 5 个（加 ultrashort/shortmid）
- `CHAT_HORIZONS` 数组从 3 项扩到 5 项（加超短/短中）
- `HORIZON_NOTES` 从 3 条扩到 5 条（加超短/短中的服务端口径句）
- 新增 `resolveTradingHorizonForInput` 函数：正则匹配用户输入，命中返回对应 ChatHorizon，未命中返回 null

### 2. 前端 HorizonPicker.tsx

暂不改（UI 组件扩展待后续做，需要渲染 5 个分段控件）。

## 钉测（tests/quant/p28-trading-horizon.test.ts，14 条）

1. CHAT_HORIZONS 有 5 个合法值
2. CHAT_HORIZONS 每个值都有 label 和 desc
3. HORIZON_NOTES 覆盖所有 5 个 ChatHorizon
4. asHorizon 对合法值返回原样
5. asHorizon 对非法值返回 null
6. chatHorizonLabel 对合法值返回 label
7. chatHorizonLabel 对非法值返回"未选"
8. resolveTradingHorizonForInput 匹配"超短"关键词
9. resolveTradingHorizonForInput 匹配"短线"关键词
10. resolveTradingHorizonForInput 匹配"短中"关键词
11. resolveTradingHorizonForInput 匹配"中线"关键词
12. resolveTradingHorizonForInput 匹配"长线"关键词
13. resolveTradingHorizonForInput 对无关键词的输入返回 null
14. resolveTradingHorizonForInput 对大小写不敏感

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p28-trading-horizon.test.ts` → 14/14 pass
- `npx tsx --test tests/quant/p11-temperature.test.ts` → 20/20 pass（更新 HORIZON_NOTES 断言为 5 档）
- `npx tsx --test tests/quant/*.test.ts` → 1245 tests / 1235 pass / 1 fail（p2-archive-db 是 tsx 老问题）/ 9 skipped
- `npx next build` → 通过

## 影响面

- **向后兼容**：旧数据（short/mid/long）仍合法，新增 ultrashort/shortmid 是增量扩展
- **前端用户看到的变化**：暂无（UI 组件待后续做，后端 resolveTradingHorizonForInput 已就绪）
- **不改数据库/不改 API 路由**：只改类型定义和自动检测函数
