// P36 上游失败有界重试纯核（对齐 P13/P35 先例：判定逻辑抽成可直跑纯函数，路由只负责调度）。
//
// 背景（用户实测截图「请求出错：AI 服务异常，请稍后重试」）：
//   AMD Radeon Cloud 网关（developer.amd.com.cn）在并发墙下会**偶发**回 403/429/502/503——
//   一轮工具取数已经把数据取回来了，收口轮被网关打回，整轮就抛错。用户白等一场，
//   拿到的是一句无信息量的「AI 服务异常」。这不是用户的问题，也不该由用户重试。
//
// 本文件只回答两个问题，不碰网络、不碰事件流：
//   1. 这一次失败**值不值得重试**（`shouldRetryUpstream`）
//   2. 重试之间退避多久（`upstreamRetryDelayMs`）
//
// 三条硬规则（写在这里，调用方不许绕过）：
//   - **本轮已经吐出正文就不重试**：模型的过渡语已经流到前端了，重发会把同一段字打两遍；
//     宁可如实报错，也不制造「重复正文」这种看起来像模型坏了的假象。
//   - **只重试上游侧的忙/抖动**（403/408/409/425/429/5xx + 连接层失败），
//     400/401/403 之外的 4xx 是我们的请求本身有问题，重试只是浪费用户时间。
//     （403 单列可重试：AMD 网关并发墙实测就是这个码，不是鉴权失败——鉴权失败是 401。）
//   - **次数有界**：总尝试次数封顶 `MAX_UPSTREAM_ATTEMPTS`，不允许无限重试拖死 maxDuration。

/** 单轮上游调用的总尝试次数（首次 + 重试）。 */
export const MAX_UPSTREAM_ATTEMPTS = 3;

/**
 * 上游 HTTP 状态码是否属于「重试有意义」的一类。
 *
 * - 403：AMD 网关并发墙实测码（同刻并发的请求被打回，退避后就好了；真实鉴权失败是 401）
 * - 408 / 409 / 425 / 429：显式「稍后再来」语义
 * - >= 500：上游自己出错，客户端能做的只有重试
 */
export function isRetryableUpstreamStatus(status: number | null | undefined): boolean {
  if (typeof status !== "number" || !Number.isFinite(status) || status <= 0) return false;
  if (status === 403 || status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** 连接层失败（没有 HTTP 状态码）里，哪些是「网络抖动」而不是「请求本身有问题」。 */
const TRANSIENT_NETWORK_SIGNALS = [
  "timeout", "timed out", "超时",
  "abort", "aborted",
  "econnreset", "econnrefused", "econnaborted", "epipe",
  "etimedout", "esockettimedout",
  "eai_again", "enotfound", "ehostunreach", "enetunreach",
  "socket hang up", "undici", "fetch failed", "network", "terminated",
];

/** 一条连接层错误消息是否像网络抖动（无状态码可判时用）。 */
export function isTransientNetworkError(message: string | null | undefined): boolean {
  const m = String(message ?? "").toLowerCase();
  if (!m) return false;
  return TRANSIENT_NETWORK_SIGNALS.some((s) => m.includes(s));
}

/**
 * 这一次失败该不该重发同一轮请求。
 *
 * @param input.status   上游 HTTP 状态码；连接层失败（fetch 直接抛）传 null
 * @param input.message  原始错误消息（无状态码时用来判是不是网络抖动）
 * @param input.attempt  这是第几次尝试（从 1 开始；首次调用传 1）
 * @param input.streamed 本轮**是否已经向前端吐过正文**（吐过就不重试，见文件头硬规则）
 */
export function shouldRetryUpstream(input: {
  status?: number | null;
  message?: string | null;
  attempt: number;
  streamed: boolean;
  maxAttempts?: number;
}): boolean {
  const max = Math.max(1, Math.trunc(input.maxAttempts ?? MAX_UPSTREAM_ATTEMPTS) || MAX_UPSTREAM_ATTEMPTS);
  if (input.streamed) return false;               // 已经流出去的内容不能重打
  if (input.attempt >= max) return false;          // 次数用尽
  if (input.status != null) return isRetryableUpstreamStatus(input.status);
  return isTransientNetworkError(input.message);   // 无状态码：只认网络抖动
}

/**
 * 第 n 次失败之后等多久再试（n 从 1 开始）。
 * 400ms → 1200ms，封顶 2000ms：抖动的网关通常几百毫秒就缓过来，
 * 退避太久会把 300s 的 maxDuration 预算烧在等待上。
 */
export function upstreamRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.trunc(attempt) || 1);
  return Math.min(2000, 400 * Math.pow(3, n - 1));
}
