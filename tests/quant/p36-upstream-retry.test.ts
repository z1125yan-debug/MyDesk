// P36 上游失败有界重试（对齐 P13/P35 先例：纯核直跑 + 生产方源码形状钉）。
//
// 背景（用户实测截图「请求出错：AI 服务异常，请稍后重试」）：
//   一轮工具取数已经把数据取回来了，收口轮被 AMD 网关的并发墙打回（403/429/5xx），
//   整轮直接抛错——用户白等一场，只拿到一句没有信息量的兜底文案。
//
// 本测试分两类：
//   - 纯核直跑：upstream-retry-core 的判定（不碰网络，node --test 能直接 import）
//   - 源码形状钉：route.ts 真的接上了这个纯核（带 @/ 别名与 IO，直跑解析不了）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_UPSTREAM_ATTEMPTS,
  isRetryableUpstreamStatus,
  isTransientNetworkError,
  shouldRetryUpstream,
  upstreamRetryDelayMs,
} from "../../src/lib/desk/upstream-retry-core.ts";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const route = read("src/app/api/ai/chat/route.ts");

// ---------- 纯核：状态码分类 ----------

test("重试只认上游忙/抖动（403/408/409/425/429/5xx），不认请求本身错误", () => {
  for (const s of [403, 408, 409, 425, 429, 500, 502, 503, 504, 520]) {
    assert.equal(isRetryableUpstreamStatus(s), true, `${s} 应当可重试`);
  }
  for (const s of [400, 401, 402, 404, 405, 422, 451]) {
    assert.equal(isRetryableUpstreamStatus(s), false, `${s} 不该重试（是我们请求的问题）`);
  }
  for (const s of [null, undefined, 0, NaN, -1]) {
    assert.equal(isRetryableUpstreamStatus(s as number | null), false, `${String(s)} 不是有效状态码`);
  }
});

test("连接层失败只在像网络抖动时才算可重试", () => {
  assert.equal(isTransientNetworkError("The operation was aborted due to timeout"), true);
  assert.equal(isTransientNetworkError("fetch failed"), true);
  assert.equal(isTransientNetworkError("socket hang up"), true);
  assert.equal(isTransientNetworkError("ECONNRESET"), true);
  assert.equal(isTransientNetworkError("invalid api key"), false);
  assert.equal(isTransientNetworkError(""), false);
});

// ---------- 纯核：该不该重试 ----------

test("本轮已经吐过正文 → 绝不重试（否则同一段过渡语会被打两遍）", () => {
  assert.equal(shouldRetryUpstream({ status: 502, attempt: 1, streamed: true }), false);
  assert.equal(shouldRetryUpstream({ status: null, message: "timeout", attempt: 1, streamed: true }), false);
});

test("次数用尽就不许再试（有界，不拖死 maxDuration）", () => {
  assert.equal(shouldRetryUpstream({ status: 502, attempt: 1, streamed: false }), true);
  assert.equal(shouldRetryUpstream({ status: 502, attempt: 2, streamed: false }), true);
  assert.equal(shouldRetryUpstream({ status: 502, attempt: MAX_UPSTREAM_ATTEMPTS, streamed: false }), false);
  assert.equal(shouldRetryUpstream({ status: 502, attempt: 9, streamed: false }), false);
});

test("没有状态码时按消息判抖动；请求侧错误（鉴权/参数）不重试", () => {
  assert.equal(shouldRetryUpstream({ status: null, message: "The operation was aborted due to timeout", attempt: 1, streamed: false }), true);
  assert.equal(shouldRetryUpstream({ status: null, message: "fetch failed", attempt: 1, streamed: false }), true);
  assert.equal(shouldRetryUpstream({ status: null, message: "401 Unauthorized: bad key", attempt: 1, streamed: false }), false);
});

test("退避递增且封顶 2s（预算不许烧在等待上）", () => {
  const d1 = upstreamRetryDelayMs(1);
  const d2 = upstreamRetryDelayMs(2);
  assert.ok(d1 > 0 && d1 <= 2000, `首次退避应在 (0,2000]，实际 ${d1}`);
  assert.ok(d2 > d1, `退避应递增：${d1} → ${d2}`);
  assert.equal(upstreamRetryDelayMs(10), 2000, "退避必须封顶");
});

// ---------- 源码形状钉：生产方真的接上了 ----------

test("route.ts 从纯核取重试判定（单一出处，不在路由里另写一套阈值）", () => {
  assert.match(route, /from "@\/lib\/desk\/upstream-retry-core"/, "必须从纯核 import");
  assert.match(route, /MAX_UPSTREAM_ATTEMPTS/, "总尝试次数读纯核常量");
  assert.match(route, /shouldRetryUpstream\(\{/, "重试判定必须走纯核函数");
  assert.match(route, /upstreamRetryDelayMs\(/, "退避时长必须走纯核函数");
});

test("整轮重放是「单次尝试函数 + 有界 for 循环」，不是在原 fetch 上加 continue", () => {
  assert.match(route, /async function attemptUpstreamRound\(/, "单次上游调用要抽成可重放的函数");
  assert.match(route, /for \(let n = 1; n <= MAX_UPSTREAM_ATTEMPTS; n\+\+\)/, "重试必须是有界循环");
  // 重放前提：被重放的函数不许改外层 content/trace/steps
  const body = route.slice(route.indexOf("async function attemptUpstreamRound("), route.indexOf("for (let round = 0; round <= MAX_TOOL_ROUNDS; round++)"));
  assert.ok(!/content\s*=|trace\.push|steps\.push/.test(body), "单次尝试函数不许改外层 content/trace/steps");
});

test("重试期间如实告知用户（不静默重发，也不静默等待）", () => {
  assert.match(route, /正在自动重试第 \$\{n\} 次/, "重试要发一条 warning，让用户知道在等什么");
});

test("最终失败把上游状态码带进 message（否则调试视图只有一句「AI 服务异常」）", () => {
  assert.match(route, /throw new Error\(attempt\.status \? `\$\{attempt\.message\}（HTTP \$\{attempt\.status\}）`/, "错误里要带 HTTP 状态码");
});

test("403 与 429 归到同一档用户文案（AMD 网关并发墙，不是鉴权失败）", () => {
  assert.match(route, /lower\.includes\("403"\)/, "403 要参与错误码分类");
  assert.match(route, /errorCode = "rate_limit_exceeded"/, "403/429 都映射到「请求过于频繁」");
});
