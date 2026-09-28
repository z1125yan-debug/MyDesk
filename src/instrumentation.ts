// P2-自动化 服务进程启动钩子（Next 16 instrumentation：服务启动时执行一次，与是否有客户端打开页面无关）
//
// 这里启动的是「服务端进程内调度器」：
// - 网页关闭 → 只要服务进程在跑，收盘后仍会扫描；
// - 服务进程未启动 → 不会有任何自动扫描（这条边界写进 task_run 与页面文案，不宣称无人值守）。
//
// 只想跑一次性脚本/测试时可用 DESK_SCHEDULER=0 关掉；
// DESK_SCHEDULER_DELAY_MIN / DESK_SCHEDULER_MAX_ATTEMPTS 调等待时长与重试上限。
//
// 另外：开机后 best-effort **预热只读接口**（见 warmApiCache）——把算得慢的 GET 先跑一遍填进
// 服务端短缓存（server-cache），配合客户端 SWR（api-cache），第一次点开菜单就能直接命中。
// 关掉预热：DESK_WARM=0。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // Edge runtime 无定时器/无 DB
  const { startScheduler } = await import("@/lib/quant/scheduler/index");
  startScheduler();
  warmApiCache();
}

/** 开机预热的目标：主菜单页首屏会用到的、算得慢的只读接口（与各 route 的缓存 key 一致）。 */
const WARM_TARGETS = [
  "/api/market/themes",
  "/api/market/review-stats",
  "/api/market/sectors?kind=industry&size=200",
  "/api/market/limitup",
  "/api/quant/factor-matrix",
  "/api/events",
  "/api/radar",
  "/api/market/breadth",
  "/api/market/sentiment",
  "/api/market/trend",
  // 研报「受益标的」核对用的全 A 名册：单次要拉全量代码表（东财断源时走腾讯兜底更慢），
  // 不预热的话用户点完生成才第一次算，校验条会长时间停在"核对中"。
  "/api/market/stock-names",
  "/api/pool/list",
];

function warmApiCache(): void {
  if (process.env.DESK_WARM === "0") return;
  const port = process.env.PORT || "3000";
  const base = `http://127.0.0.1:${port}`;
  // 服务可能还没开始监听：等几秒再打；**串行**跑，避免开机就把机器/上游打满。
  setTimeout(() => {
    void (async () => {
      let ok = 0;
      for (const path of WARM_TARGETS) {
        try {
          const res = await fetch(base + path, { cache: "no-store" });
          await res.arrayBuffer().catch(() => {});
          if (res.ok) ok++;
        } catch {
          // 预热失败不影响启动：真正的请求还会再算一次
        }
      }
      console.log(`[warm] 只读接口预热完成 ${ok}/${WARM_TARGETS.length}（base=${base}）`);
    })();
  }, 4000);
}
