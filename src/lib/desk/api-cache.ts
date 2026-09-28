"use client";
// 桌面端「点开即有内容」：给**同源 GET /api/*** 包一层 stale-while-revalidate 缓存。
//
// 背景：每个菜单页都是「挂载时自己 fetch → busy=true → 加载中…」。切换菜单会卸载再挂载，
// 于是每次打开都要重新等一遍接口（大盘情绪/板块/矩阵这些接口本身要算几秒）。
//
// 这一层做三件事，页面代码一行不用改：
//   ① 命中缓存：**当帧**就把上次的响应还回去（界面立刻有内容），同时后台再拉一次更新缓存——
//      下次打开就是新的；后台失败就保留旧缓存，不把界面打回「加载中」。
//   ② 未命中：正常 fetch 并写缓存。
//   ③ 预取：菜单 hover 时 prefetchApi(url) 先把接口拉进缓存，点开就不用等。
//
// 只缓存 **GET + 同源 + /api/**；POST/PUT/DELETE、SSE 流、外部域名一律原样透传，绝不缓存。
// 变更类请求（POST 等）成功后，自动清掉同路径前缀的 GET 缓存，避免「扫完还显示旧的」。
const TTL = 60_000;          // 超过这个时长的缓存仍先显示，但后台一定会重拉
const MAX_ENTRIES = 240;     // 简单上限，防内存无限增长
// 轮询类/实时状态接口：不缓存（缓存会让状态条显示旧值）。
const NO_CACHE_PREFIXES = ["/api/tasks/"];

interface Entry {
  at: number;
  body: string;
  status: number;
  statusText: string;
  headers: [string, string][];
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
let installed = false;

// 自学习预取：记住「每个页面用过哪些 GET 接口」，菜单 hover 时按记录把该页接口预热。
// 这样不用维护一张手工的「页面→接口」映射表——第一次打开某页时自动学会，之后 hover 即预热。
let currentPage = "";
const pageEndpoints = new Map<string, Set<string>>();
export function setPrefetchPage(page: string): void { currentPage = page; }

function remember(key: string): void {
  if (!currentPage) return;
  let set = pageEndpoints.get(currentPage);
  if (!set) { set = new Set(); pageEndpoints.set(currentPage, set); }
  if (set.size < 40) set.add(key);
}

function sameOriginApiKey(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const abs = new URL(raw, window.location.origin);
    if (abs.origin !== window.location.origin) return null;
    if (!abs.pathname.startsWith("/api/")) return null;
    return abs.pathname + abs.search;
  } catch {
    return null;
  }
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && "method" in input && (input as Request).method) return (input as Request).method.toUpperCase();
  return "GET";
}

function put(key: string, res: Response, body: string): void {
  const headers: [string, string][] = [];
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    // body 已经是解码后的文本：不能把 content-encoding/length 带回去，否则重建 Response 会被当成压缩体解析失败
    if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") return;
    headers.push([k, v]);
  });
  cache.set(key, { at: Date.now(), body, status: res.status, statusText: res.statusText, headers });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 后台重拉一个 URL 并更新缓存（同一 URL 并发只跑一次）。 */
function revalidate(key: string, doFetch: typeof fetch): Promise<void> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const res = await doFetch(key);
      if (!res.ok) return; // 上游报错不动旧缓存
      put(key, res, await res.clone().text());
    } catch {
      // 后台刷新失败：保留旧缓存（界面继续用旧的，不退回「加载中」）
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 变更类请求成功后，清掉同路径前缀的 GET 缓存（/api/events → /api/events 及 /api/events/*）。 */
function invalidate(pathname: string): void {
  for (const key of [...cache.keys()]) {
    if (key === pathname || key.startsWith(pathname + "?") || key.startsWith(pathname + "/")) cache.delete(key);
  }
}

export function installApiCache(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const doFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = methodOf(input, init);
    const key = sameOriginApiKey(input);
    if (!key) return doFetch(input as RequestInfo, init); // 非 /api/ 同源：透传
    if (NO_CACHE_PREFIXES.some((p) => key.startsWith(p))) return doFetch(input as RequestInfo, init); // 实时状态：透传
    const pathname = key.split("?")[0];

    if (method !== "GET") {
      const res = await doFetch(input as RequestInfo, init);
      if (res.ok) invalidate(pathname); // 变更成功 → 让相关 GET 缓存失效
      return res;
    }

    remember(key);
    const hit = cache.get(key);
    if (hit) {
      // 先给缓存（当帧有内容），过期就后台刷新
      if (Date.now() - hit.at > TTL) void revalidate(key, doFetch);
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
    }
    const res = await doFetch(input as RequestInfo, init);
    if (res.ok) {
      try { put(key, res, await res.clone().text()); } catch { /* clone 失败就不缓存 */ }
    }
    return res;
  }) as typeof fetch;
}

/** 预取一个同源 /api/ GET（菜单 hover 时调用）。已在缓存里的不重复拉。 */
export function prefetchApi(url: string): void {
  if (typeof window === "undefined") return;
  const key = sameOriginApiKey(url);
  if (!key || cache.has(key) || inflight.has(key)) return;
  void revalidate(key, window.fetch.bind(window));
}

/** 预取某个页面用过的所有接口（菜单 hover 时调用）；只补「缺失或过期」的，不重复拉。 */
export function prefetchPage(page: string): void {
  if (typeof window === "undefined") return;
  const set = pageEndpoints.get(page);
  if (!set) return;
  const doFetch = window.fetch.bind(window);
  for (const key of set) {
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at > TTL) void revalidate(key, doFetch);
  }
}

/** 测试/调试用：清空缓存。 */
export function clearApiCache(): void {
  cache.clear();
  inflight.clear();
}

// 模块导入即安装（AppShell 在渲染前 import 它）：保证页面组件第一次 fetch 之前就已接管。
if (typeof window !== "undefined") installApiCache();
