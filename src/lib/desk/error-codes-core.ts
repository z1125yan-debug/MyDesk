// P23 错误码 → 用户文案映射纯核（稳智对齐 P1 #6）。
//
// 稳智逆向扒出的错误码是**下划线蛇形** + **人话映射表**（reverse-01 §11），前端拿到错误码后查表
// 显示用户文案，而不是直接把后端 message 原文暴露。本仓库原来只有 `{ message: string }`，没有
// error_code 字段——用户看到的是"AI 调用失败：upstream 502"这种后端原始话术。
//
// 本文件只做两件事：
//   1. 定义错误码枚举 + 用户文案映射表（对齐稳智 8 条里本仓库用得上的 5 条 + 4 条兜底）
//   2. 提供 `friendlyErrorMessage` 纯函数：拿 error_code + 原始 message，返回用户可读文案
//
// 为什么单独成文件：错误码映射会被 SSE 收口端（applyEvent）、HTTP 非流式兜底端、前端兜底 catch
// 三处消费；写进 tsx 就测不到行为。抽出来才有单测兜底（同 agent-phases-core 的口径）。
//
// 稳智对齐的 8 条错误码里，本仓库**不适用**的：
//   - login_failed / ai_matrix_points_insufficient / ai_matrix_wallet_unavailable / billing_freeze_failed
//     → 本仓库没做登录态和点数钱包系统，这些码不会出现
//   - task_in_progress
//     → 本仓库没做"任务并发锁"，同一 session 连续发消息是允许的
//
// 本仓库实际会遇到的错误场景 + 稳智对应码：
//   - ai_not_configured：上游没配 key、Bifrost 未启动、provider 全部不可用
//   - model_timeout：上游超时（AMD 网关并发墙、Groq 冷启动）
//   - rate_limit_exceeded：上游限流（Groq 免费档 RPM 打满）
//   - upstream_error：上游 502/503/504（AMD 网关并发超墙的典型形态）
//   - task_id_missing：服务端没回 task_id（本仓库没做任务型异步接口，暂时保留兜底文案）
//
// 兜底文案（稳智 L9 原样搬过来，去掉登录/点数/钱包专属的三条）：
//   - "AI 服务暂不可用，请稍后重试"         → ai_not_configured 兜底
//   - "上一条消息仍在分析中，请稍候再发送"   → task_in_progress 兜底（本仓库不主动发这个码）
//   - "发送前校验失败，请稍后重试"           → billing_freeze_failed 兜底（本仓库不主动发）
//   - "未收到任务 ID，无法建立 AI 分析会话"  → task_id_missing 兜底
//   - "AI 服务繁忙，请稍后重试"              → model_timeout / rate_limit_exceeded 兜底
//   - "AI 服务异常，请稍后重试"              → upstream_error 兜底

/** 后端可发的错误码枚举（下划线蛇形，对齐稳智命名口径） */
export type ErrorCode =
  | "ai_not_configured"
  | "model_timeout"
  | "rate_limit_exceeded"
  | "upstream_error"
  | "task_in_progress"
  | "task_id_missing"
  | "ai_matrix_points_insufficient"
  | "ai_matrix_wallet_unavailable"
  | "billing_freeze_failed"
  | "login_failed"
  | "unknown";

/** 错误码 → 用户文案映射表（对齐稳智 reverse-01 §11 的 8 条 + 兜底） */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  ai_not_configured:              "AI 服务暂不可用，请稍后重试",
  model_timeout:                  "AI 服务繁忙，请稍后重试",
  rate_limit_exceeded:            "请求过于频繁，请稍后重试",
  upstream_error:                 "AI 服务异常，请稍后重试",
  task_in_progress:               "上一条消息仍在分析中，请稍候再发送",
  task_id_missing:                "未收到任务 ID，无法建立 AI 分析会话",
  ai_matrix_points_insufficient:  "点数不足，请先充值",
  ai_matrix_wallet_unavailable:   "钱包当前不可用，请稍后重试或联系管理员",
  billing_freeze_failed:          "发送前校验失败，请稍后重试",
  login_failed:                   "请先登录",
  unknown:                        "请求出错，请稍后重试",
};

/**
 * 把错误码 + 原始 message 转成用户可读文案。
 *
 * 规则：
 *   - error_code 有值且在 ERROR_MESSAGES 表里 → 用映射文案
 *   - error_code 有值但不在表里（后端发了未知码）→ 用 unknown 兜底 + 保留原始 message 作调试线索
 *   - error_code 缺失（旧服务端/客户端 fetch 失败）→ 用 unknown 兜底
 *
 * 原始 message 不直接暴露给用户（稳智逆向扒出的口径），但保留在返回值里给调试视图用。
 */
export function friendlyErrorMessage(input: {
  code?: ErrorCode | string | null;
  message?: string | null;
  debug?: boolean;
}): { text: string; code: ErrorCode } {
  const code = normalizeCode(input.code);
  const text = ERROR_MESSAGES[code];
  // debug=true 时把原始 message 附在文案后面（调试视图用），正常用户看不到
  if (input.debug && input.message) {
    return { text: `${text}（${input.message}）`, code };
  }
  return { text, code };
}

/**
 * 把任意字符串 code 归一化到 ErrorCode 枚举。
 * - 空/null/undefined → unknown
 * - 在枚举里的 → 原样返回
 * - 不在枚举里的（后端发了新码或拼写错）→ unknown（不 crash，保留兜底文案）
 */
export function normalizeCode(code: string | null | undefined): ErrorCode {
  if (!code || typeof code !== "string") return "unknown";
  const all: ErrorCode[] = [
    "ai_not_configured", "model_timeout", "rate_limit_exceeded", "upstream_error",
    "task_in_progress", "task_id_missing",
    "ai_matrix_points_insufficient", "ai_matrix_wallet_unavailable", "billing_freeze_failed",
    "login_failed", "unknown",
  ];
  return (all as string[]).includes(code) ? (code as ErrorCode) : "unknown";
}
