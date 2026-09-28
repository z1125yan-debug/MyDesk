// P23 错误码 → 用户文案映射的钉测（稳智对齐 P1 #6）。
//
// 稳智逆向扒出的错误码是**下划线蛇形** + **人话映射表**（reverse-01 §11），前端拿到错误码
// 后查表显示用户文案，而不是直接把后端 message 原文暴露。本仓库原来只有 `{ message: string }`，
// 用户看到的是"AI 调用失败：upstream 502"这种后端原始话术。
//
// 测试钉四件事：
//   1. ERROR_MESSAGES 表覆盖所有 ErrorCode（钉死文案与码的对应关系）
//   2. friendlyErrorMessage 对已知码返回映射文案
//   3. friendlyErrorMessage 对未知码 / 空码返回 unknown 兜底
//   4. normalizeCode 对任意字符串做白名单校验
import test from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_MESSAGES,
  friendlyErrorMessage,
  normalizeCode,
  type ErrorCode,
} from "../../src/lib/desk/error-codes-core.ts";

// 稳智对齐的 8 条错误码 + 兜底 unknown
const ALL_CODES: ErrorCode[] = [
  "ai_not_configured",
  "model_timeout",
  "rate_limit_exceeded",
  "upstream_error",
  "task_in_progress",
  "task_id_missing",
  "ai_matrix_points_insufficient",
  "ai_matrix_wallet_unavailable",
  "billing_freeze_failed",
  "login_failed",
  "unknown",
];

test("ERROR_MESSAGES 表覆盖所有 ErrorCode（钉死文案与码的对应关系）", () => {
  assert.equal(Object.keys(ERROR_MESSAGES).length, ALL_CODES.length);
  for (const code of ALL_CODES) {
    assert.ok(code in ERROR_MESSAGES, `ERROR_MESSAGES 缺 ${code}`);
    // 每条文案都非空
    assert.ok(ERROR_MESSAGES[code].length > 0, `${code} 文案为空`);
  }
});

test("关键错误码的文案钉死（防未来改文案时忘了改测试）", () => {
  assert.equal(ERROR_MESSAGES.ai_not_configured, "AI 服务暂不可用，请稍后重试");
  assert.equal(ERROR_MESSAGES.model_timeout, "AI 服务繁忙，请稍后重试");
  assert.equal(ERROR_MESSAGES.rate_limit_exceeded, "请求过于频繁，请稍后重试");
  assert.equal(ERROR_MESSAGES.upstream_error, "AI 服务异常，请稍后重试");
  assert.equal(ERROR_MESSAGES.task_in_progress, "上一条消息仍在分析中，请稍候再发送");
  assert.equal(ERROR_MESSAGES.task_id_missing, "未收到任务 ID，无法建立 AI 分析会话");
  assert.equal(ERROR_MESSAGES.ai_matrix_points_insufficient, "点数不足，请先充值");
  assert.equal(ERROR_MESSAGES.ai_matrix_wallet_unavailable, "钱包当前不可用，请稍后重试或联系管理员");
  assert.equal(ERROR_MESSAGES.billing_freeze_failed, "发送前校验失败，请稍后重试");
  assert.equal(ERROR_MESSAGES.login_failed, "请先登录");
  assert.equal(ERROR_MESSAGES.unknown, "请求出错，请稍后重试");
});

test("friendlyErrorMessage 对已知码返回映射文案（不暴露原始 message）", () => {
  const r = friendlyErrorMessage({
    code: "ai_not_configured",
    message: "upstream 502 gateway refused",
  });
  assert.equal(r.text, "AI 服务暂不可用，请稍后重试");
  assert.equal(r.code, "ai_not_configured");
  // 原始 message 不直接出现在文案里（正常用户看不到）
  assert.ok(!r.text.includes("upstream"));
  assert.ok(!r.text.includes("502"));
});

test("friendlyErrorMessage 对 model_timeout 返回映射文案", () => {
  const r = friendlyErrorMessage({
    code: "model_timeout",
    message: "request timed out after 30s",
  });
  assert.equal(r.text, "AI 服务繁忙，请稍后重试");
  assert.equal(r.code, "model_timeout");
});

test("friendlyErrorMessage 对 rate_limit_exceeded 返回映射文案", () => {
  const r = friendlyErrorMessage({
    code: "rate_limit_exceeded",
    message: "429 too many requests",
  });
  assert.equal(r.text, "请求过于频繁，请稍后重试");
  assert.equal(r.code, "rate_limit_exceeded");
});

test("friendlyErrorMessage 对 unknown 码返回兜底文案", () => {
  const r = friendlyErrorMessage({
    code: "unknown",
    message: "something happened",
  });
  assert.equal(r.text, "请求出错，请稍后重试");
  assert.equal(r.code, "unknown");
});

test("friendlyErrorMessage 对未知字符串码（后端发了新码）返回 unknown 兜底", () => {
  const r = friendlyErrorMessage({
    code: "some_new_code_not_in_enum",
    message: "new error type",
  });
  assert.equal(r.text, "请求出错，请稍后重试");
  assert.equal(r.code, "unknown");
});

test("friendlyErrorMessage 对空 code 返回 unknown 兜底", () => {
  const r = friendlyErrorMessage({ code: undefined, message: "no code" });
  assert.equal(r.text, "请求出错，请稍后重试");
  assert.equal(r.code, "unknown");
});

test("friendlyErrorMessage 对 null code 返回 unknown 兜底", () => {
  const r = friendlyErrorMessage({ code: null, message: "null code" });
  assert.equal(r.text, "请求出错，请稍后重试");
  assert.equal(r.code, "unknown");
});

test("friendlyErrorMessage 对数字型 code（后端发错类型）返回 unknown 兜底", () => {
  const r = friendlyErrorMessage({ code: 123 as unknown as string, message: "wrong type" });
  assert.equal(r.text, "请求出错，请稍后重试");
  assert.equal(r.code, "unknown");
});

test("friendlyErrorMessage 对空 message 也能返回映射文案（code 有值即可）", () => {
  const r = friendlyErrorMessage({ code: "model_timeout", message: "" });
  assert.equal(r.text, "AI 服务繁忙，请稍后重试");
});

test("friendlyErrorMessage debug=true 时把原始 message 附在文案后面", () => {
  const r = friendlyErrorMessage({
    code: "upstream_error",
    message: "upstream 502",
    debug: true,
  });
  assert.equal(r.code, "upstream_error");
  // 映射文案在前，原始 message 在后（调试视图用）
  assert.ok(r.text.startsWith("AI 服务异常，请稍后重试"));
  assert.ok(r.text.includes("upstream 502"));
});

test("friendlyErrorMessage debug=true 但 message 为空时不追加括号", () => {
  const r = friendlyErrorMessage({
    code: "upstream_error",
    message: "",
    debug: true,
  });
  assert.equal(r.text, "AI 服务异常，请稍后重试");
});

test("friendlyErrorMessage debug=false（默认）不暴露原始 message", () => {
  const r = friendlyErrorMessage({
    code: "upstream_error",
    message: "upstream 502 gateway refused",
  });
  assert.equal(r.text, "AI 服务异常，请稍后重试");
  assert.ok(!r.text.includes("502"));
  assert.ok(!r.text.includes("gateway"));
});

test("normalizeCode 对枚举内字符串返回原样", () => {
  for (const code of ALL_CODES) {
    assert.equal(normalizeCode(code), code);
  }
});

test("normalizeCode 对空/null/undefined 返回 unknown", () => {
  assert.equal(normalizeCode(""), "unknown");
  assert.equal(normalizeCode(null), "unknown");
  assert.equal(normalizeCode(undefined), "unknown");
});

test("normalizeCode 对不在枚举里的字符串返回 unknown", () => {
  assert.equal(normalizeCode("some_new_code"), "unknown");
  assert.equal(normalizeCode("AI_NOT_CONFIGURED"), "unknown"); // 大小写敏感
  assert.equal(normalizeCode("ai_not_configured "), "unknown"); // 含空格
});

test("normalizeCode 对数字型（后端发错类型）返回 unknown", () => {
  assert.equal(normalizeCode(404 as unknown as string), "unknown");
  assert.equal(normalizeCode(false as unknown as string), "unknown");
});
