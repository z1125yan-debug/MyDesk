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

// 挂到 globalThis：Next dev 模式下模块会因 HMR 被反复重编译，模块级 const 跟着被重置，
// 导致「暖缓存」瞬间清空——表现为「刚才还快，改两行代码再点就又卡 6 秒」「dev 长跑后偶发 500」。
// 放进 globalThis 后，缓存随进程存活、跨 HMR 保留，warm 调用稳定命中（实测 x-cache: HIT）。
// prod 单例本就稳定，这层只是让 dev 体验对齐，组件卸载/重载不会导致缓存丢失。
const g = globalThis as typeof globalThis & {
  __deskCacheStore?: Map<string, Entry>;
  __deskCacheInflight?: Map<string, Promise<Response>>;
};
const store = g.__deskCacheStore ?? (g.__deskCacheStore = new Map<string, Entry>());
const inflight = g.__deskCacheInflight ?? (g.__deskCacheInflight = new Map<string, Promise<Response>>());

/**
 * 过期后仍可「秒回旧值」的宽限窗口（SWR）。
 *
 * 为什么必须加：TTL 一到，**第一个**请求就得把整个重算扛下来。实测这几个接口冷启动
 * 是 5s（情绪）/ 11s（宽度）/ 41s（预测）/ 45s+（技术信号，19 个 MCP 指标），
 * 用户点开就是白等几十秒——「打开太慢」「点了什么也没出来」的根因就是这个，
 * 不是算错，是**让用户在关键路径上等**。
 *
 * 加了 SWR 后：TTL 过期**不阻塞**，立即回旧值并后台重算。用户永远几十毫秒拿到内容，
 * 数据滞后最多一个后台重算周期（对收盘口径/统计口径完全可接受）。
 */
export const DEFAULT_STALE_MS = 10 * 60_000;

/**
 * 只读市场数据的默认 TTL：60 秒。
 * 2026-09-29 从 30s 提到 60s——页面轮询/操作节奏是 60s，TTL 比它短等于**每次打开都必然过期重算**
 * （实测菜单页首屏接口冷启动 1.3~9 秒，用户感受就是「点菜单要等」）。
 * 60s 与轮询同档后：盘子上的读数最多滞后 60 秒，而点开菜单基本都命中热缓存（几十毫秒）。
 * 需要更鲜的实时页面（盘口/逐笔/搜索）不走这层，各自直连。
 */
export const DEFAULT_TTL_MS = 60_000;

function rebuild(e: Entry, tag: string): Response {
  const ageSec = Math.round((Date.now() - e.at) / 1000);
  return new Response(e.body, {
    status: e.status,
    headers: {
      "content-type": e.ct,
      // 便于验证这层到底有没有生效：HIT=新鲜 / STALE=秒回旧值+后台刷新中
      "x-cache": tag,
      "x-cache-age": String(ageSec),
    },
  });
}

/** 真正跑一次 producer 并写缓存；并发同 key 只跑一次（in-flight 去重）。 */
function compute(key: string, producer: () => Promise<NextResponse | Response>): Promise<Response> {
  const running = inflight.get(key);
  if (running) return running;
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
  // 只登记带清理的那一个：并发进来拿到的是同一个 promise，算完自动出队
  const done = task.finally(() => {
    if (inflight.get(key) === done) inflight.delete(key);
  });
  inflight.set(key, done);
  return done;
}

/**
 * 包一层 TTL 缓存（带 SWR）。producer 返回 Response（通常是 `NextResponse.json(...)`）；
 * 非 200（502 等）不写缓存，原样返回，避免把一次失败固化。
 *
 * 三段式：
 * 1. 新鲜（age < ttl）           → HIT，直接回
 * 2. 过期但在宽限窗口（< ttl+stale）→ STALE，**立即回旧值**，后台重算（不阻塞用户）
 * 3. 无缓存 / 彻底过期            → 只能同步等一次（冷启动，靠预热规避）
 */
export async function ttlCache(
  key: string,
  ttlMs: number,
  producer: () => Promise<NextResponse | Response>,
  opts?: { staleMs?: number },
): Promise<Response> {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const hit = store.get(key);
  const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY;

  if (hit && age < ttlMs) return rebuild(hit, "HIT");

  if (hit && age < ttlMs + staleMs) {
    // 后台刷新：故意不 await——用户不该为重算买单。失败静默，下次请求再试。
    void compute(key, producer).catch(() => { /* 后台刷新失败：旧值继续顶着 */ });
    return rebuild(hit, "STALE");
  }

  return compute(key, producer);
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
