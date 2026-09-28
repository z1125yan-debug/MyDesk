# P23 错误码 → 用户文案映射（稳智对齐 P1 #6）

## 对齐目标

稳智逆向扒出的错误码是**下划线蛇形** + **人话映射表**（reverse-01 §11），前端拿到错误码后查表显示用户文案，而不是直接把后端 message 原文暴露。本仓库原来只有 `{ message: string }`，没有 error_code 字段——用户看到的是"AI 调用失败：upstream 502"这种后端原始话术。

## 改动分三块

### 1. `src/lib/desk/error-codes-core.ts`（新增）

- 定义 `ErrorCode` 枚举（11 个码，下划线蛇形，对齐稳智命名口径）
- `ERROR_MESSAGES` 映射表：错误码 → 用户文案
- `friendlyErrorMessage` 纯函数：拿 error_code + 原始 message，返回用户可读文案
- `normalizeCode` 归一化函数：任意字符串 code → ErrorCode 枚举（不在白名单的兜底到 unknown）

稳智 8 条错误码里，本仓库**不适用**的（登录/点数/钱包系统未做）：login_failed、ai_matrix_points_insufficient、ai_matrix_wallet_unavailable、billing_freeze_failed、task_in_progress。但映射表里保留了这些码（防未来加系统时直接用），正常用户不会看到。

### 2. SSE 事件契约（chat-core.ts + chat-stream-core.ts）

- `AppliedEvent.error.data` 从 `{ message: string }` 改成 `{ message: string; error_code?: string }`
- `decodeStreamEvent` 透传 error_code 字段（后端未发时不返回该字段，避免 deep-equal 出现多余键）
- `applyEvent` error 分支用 `friendlyErrorMessage` 做映射，不直接显示原始 message

### 3. 服务端 chat/route.ts（5 处 emit error）

- 3 处"AI 服务不可用" → `error_code: "ai_not_configured"`
- 1 处"客户端断开/用户停止" → 保留原逻辑（这是用户主动行为，不算错误）
- 1 处 catch 兜底 → 根据错误内容分类：
  - 超时关键词 → `error_code: "model_timeout"`
  - 429/限流关键词 → `error_code: "rate_limit_exceeded"`
  - 其他 → `error_code: "upstream_error"`

## 钉测（tests/quant/p23-error-codes.test.ts，18 条）

1. ERROR_MESSAGES 表覆盖所有 ErrorCode
2. 关键错误码的文案钉死
3-6. friendlyErrorMessage 对已知码返回映射文案
7. friendlyErrorMessage 对 unknown 码返回兜底文案
8. friendlyErrorMessage 对未知字符串码返回 unknown 兜底
9-10. friendlyErrorMessage 对空/null code 返回 unknown 兜底
11. friendlyErrorMessage 对数字型 code 返回 unknown 兜底
12. friendlyErrorMessage 对空 message 也能返回映射文案
13. friendlyErrorMessage debug=true 时把原始 message 附在文案后面
14. friendlyErrorMessage debug=true 但 message 为空时不追加括号
15. friendlyErrorMessage debug=false 不暴露原始 message
16. normalizeCode 对枚举内字符串返回原样
17. normalizeCode 对空/null/undefined 返回 unknown
18. normalizeCode 对不在枚举里的字符串返回 unknown
19. normalizeCode 对数字型返回 unknown

加上 p7-chat.test.ts 新增 2 条：
- applyEvent error_code 映射生效
- applyEvent 未知 error_code 兜底到 unknown 文案

## 验证

- `npx tsc --noEmit` → 0 错
- `npx tsx --test tests/quant/p23-error-codes.test.ts` → 18/18 pass
- `npx tsx --test tests/quant/p7-chat.test.ts` → 44/44 pass
- `npx tsx --test tests/quant/*.test.ts` → 1189 tests / 1179 pass / 1 fail（p2-archive-db 是 tsx 老问题与本轮无关）/ 9 skipped
- `npx next build` → 通过

## 影响面

- **SSE 契约向后兼容**：error_code 是可选字段，旧服务端不发也不报错（前端兜底到 unknown 文案）
- **前端用户看到的变化**：错误提示从"AI 调用失败：upstream 502"变成"AI 服务异常，请稍后重试"
- **调试视图**：debugOn 打开时，原始 message 仍可见（friendlyErrorMessage debug=true 时追加）
- **不改数据库/不改 API 路由**：只改 SSE 事件数据形状和前端映射逻辑
