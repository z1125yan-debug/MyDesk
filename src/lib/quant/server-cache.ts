// 服务端「短 TTL 响应缓存」：给算得慢的**只读 GET** 路由加一层进程内内存缓存。
//
// 为什么：大盘情绪/板块/矩阵/事件这些接口本身要算 1~7 秒，一个页面往往同时拉好几个（加起来近十秒）。
// 同一份数据在 TTL 内只该算一次——多个页面、多次刷新、多个标签页共用这一份结果，
// 配合客户端 SWR（api-cache.ts）与开机预热（instrumentation.ts），做到「点开即有内容」。
//
// 口径：
// - 只缓存 **200**；命中直接回缓存 body；并发同 key 只跑一次（in-flight 去重）。
// - 进程内内存缓存（非分布式）：单机自托管够用；**重启即空**，由 instrumentation 的预热再填。
// - key 由调用方给（路径 + query），必须稳定。
import type { NextResponse } from "next/server";

interface Entry { at: number; status: number; body: string; ct: string }

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Response>>();

/**
 * 只读市场数据的默认 TTL：60 秒。
 * 2026-09-29 从 30s 提到 60s——页面轮询/操作节奏是 60s，TTL 比它短等于**每次打开都必然过期重算**
 * （实测菜单页首屏接口冷启动 1.3~9 秒，用户感受就是「点菜单要等」）。
 * 60s 与轮询同档后：盘子上的读数最多滞后 60 秒，而点开菜单基本都命中热缓存（几十毫秒）。
 * 需要更鲜的实时页面（盘口/逐笔/搜索）不走这层，各自直连。
 */
export const DEFAULT_TTL_MS = 60_000;

function rebuild(e: Entry): Response {
  return new Response(e.body, { status: e.status, headers: { "content-type": e.ct } });
}

/**
 * 包一层 TTL 缓存。producer 返回 Response（通常是 `NextResponse.json(...)`）；
 * 非 200（502 等）不写缓存，原样返回，避免把一次失败固化 30 秒。
 */
export async function ttlCache(key: string, ttlMs: number, producer: () => Promise<NextResponse | Response>): Promise<Response> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return rebuild(hit);
  const running = inflight.get(key);
  if (running) {
    try { await running; } catch { /* 别人失败：落到下面自己算 */ }
    const h2 = store.get(key);
    if (h2) return rebuild(h2);
  }
  const task = (async (): Promise<Response> => {
    const res = await producer();
    if (res.status === 200) {
      try {
        const body = await res.clone().text();
        store.set(key, {
          at: Date.now(),
          status: res.status,
          body,
          ct: res.headers.get("content-type") ?? "application/json; charset=utf-8",
        });
      } catch { /* 读不出 body 就不缓存 */ }
    }
    return res;
  })();
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}

/** 变更类路由成功后调用：清掉同前缀的 GET 缓存（"events" → "events" / "events?..." / "events/..."）。 */
export function invalidateServerCache(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key === prefix || key.startsWith(prefix + "?") || key.startsWith(prefix + "/")) store.delete(key);
  }
}

/** 测试/调试用：清空缓存。 */
export function clearServerCache(): void {
  store.clear();
  inflight.clear();
}

/** 测试/调试用：当前缓存条数。 */
export function serverCacheSize(): number {
  return store.size;
}
